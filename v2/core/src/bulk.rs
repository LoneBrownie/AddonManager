//! Operations that span several servers.
//!
//! These are the two things people actually want once they run more than one
//! game folder: put an addon in several at once, and stand up a new server
//! from an existing one (V2-PLAN.md 5.3).
//!
//! Both are **explicit opt-in actions**. The default remains that installing an
//! addon touches only the selected server.

use std::path::Path;

use crate::error::{Error, Result};
use crate::http::HttpClient;
use crate::install::{self, InstallOptions};
use crate::model::{InstalledAddon, Source, Store};
use crate::servers;

/// Outcome of one server in a multi-server operation.
#[derive(Debug)]
pub struct ServerOutcome {
    pub server_id: String,
    pub server_name: String,
    pub result: Result<InstalledAddon>,
}

impl ServerOutcome {
    pub fn succeeded(&self) -> bool {
        self.result.is_ok()
    }
}

/// Install one addon into several servers.
///
/// Deliberately **not** atomic. One server being on an unplugged drive, or
/// holding a colliding folder, must not stop the others from succeeding — so
/// every target reports its own outcome and the caller renders a summary.
///
/// Each target is fetched independently. Addon archives are small, and sharing
/// one download across targets would mean splitting `install` into fetch and
/// place halves; worth doing if it ever shows up as slow, but not before.
pub async fn install_to_many(
    client: &dyn HttpClient,
    store: &mut Store,
    server_ids: &[String],
    source: &Source,
    options: &InstallOptions,
    work_dir: &Path,
) -> Vec<ServerOutcome> {
    let mut outcomes = Vec::new();

    for server_id in server_ids {
        let server_name = store
            .server(server_id)
            .map(|s| s.name.clone())
            .unwrap_or_else(|| server_id.clone());

        let result = install::install(client, store, server_id, source, options, work_dir).await;

        outcomes.push(ServerOutcome {
            server_id: server_id.clone(),
            server_name,
            result,
        });
    }

    outcomes
}

/// What happened to one addon during a copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyOutcome {
    Copied {
        addon_id: String,
        folders: Vec<String>,
    },
    /// Already present on the target; left alone.
    AlreadyPresent {
        addon_id: String,
    },
    Failed {
        addon_id: String,
        reason: String,
    },
}

impl CopyOutcome {
    pub fn addon_id(&self) -> &str {
        match self {
            CopyOutcome::Copied { addon_id, .. }
            | CopyOutcome::AlreadyPresent { addon_id }
            | CopyOutcome::Failed { addon_id, .. } => addon_id,
        }
    }
}

/// Copy every addon installed on one server to another.
///
/// Files are copied **directly between the two AddOns directories** rather than
/// re-downloaded. The artifact is byte-identical to what is already installed,
/// so re-fetching would be slower, would need a network, and could pick up a
/// newer upstream version than the one being copied — which is not what "copy
/// this set" means.
///
/// Collision rules are unchanged: nothing on the target that we did not create
/// is overwritten without explicit consent.
pub fn copy_set(
    store: &mut Store,
    from_server_id: &str,
    to_server_id: &str,
    overwrite_unmanaged: bool,
) -> Result<Vec<CopyOutcome>> {
    if from_server_id == to_server_id {
        return Err(Error::UnknownServer(
            "source and destination servers are the same".to_string(),
        ));
    }

    let from = store
        .server(from_server_id)
        .ok_or_else(|| Error::UnknownServer(from_server_id.to_string()))?
        .clone();
    let to = store
        .server(to_server_id)
        .ok_or_else(|| Error::UnknownServer(to_server_id.to_string()))?
        .clone();

    let from_dir = servers::ensure_addons_dir(&from)?;
    let to_dir = servers::ensure_addons_dir(&to)?;

    let to_copy: Vec<InstalledAddon> = store
        .installed_for(from_server_id)
        .into_iter()
        .cloned()
        .collect();

    let mut outcomes = Vec::new();

    for installation in to_copy {
        let addon_id = installation.addon_id.clone();

        if store.installation(to_server_id, &addon_id).is_some() {
            outcomes.push(CopyOutcome::AlreadyPresent { addon_id });
            continue;
        }

        match copy_one(
            store,
            &to,
            &from_dir,
            &to_dir,
            &installation,
            overwrite_unmanaged,
        ) {
            Ok(folders) => {
                let mut copied = installation.clone();
                copied.server_id = to_server_id.to_string();
                copied.folders = folders.clone();
                store.upsert_installation(copied);
                outcomes.push(CopyOutcome::Copied { addon_id, folders });
            }
            Err(error) => outcomes.push(CopyOutcome::Failed {
                addon_id,
                reason: error.to_string(),
            }),
        }
    }

    Ok(outcomes)
}

/// Copy one addon's folders, honouring the collision rules.
fn copy_one(
    store: &Store,
    to: &crate::model::Server,
    from_dir: &Path,
    to_dir: &Path,
    installation: &InstalledAddon,
    overwrite_unmanaged: bool,
) -> Result<Vec<String>> {
    let plans = install::plan_folders(
        store,
        to,
        &installation.addon_id,
        &installation.folders,
        to_dir,
    );

    for plan in &plans {
        match plan {
            install::FolderPlan::ConflictsWithAddon { folder, owner } => {
                return Err(Error::ManagedCollision {
                    folder: folder.clone(),
                    owner: owner.clone(),
                })
            }
            install::FolderPlan::ConflictsWithUnmanaged(folder) if !overwrite_unmanaged => {
                return Err(Error::UnmanagedCollision {
                    folder: folder.clone(),
                })
            }
            _ => {}
        }
    }

    let mut copied = Vec::new();
    for folder in &installation.folders {
        crate::paths::validate_component(folder)?;
        let source = from_dir.join(folder);
        if !source.is_dir() {
            // Recorded but no longer on disk — the user deleted it by hand.
            // Skip rather than fail the whole copy.
            continue;
        }
        let destination = to_dir.join(folder);
        crate::paths::confine(to_dir, &destination)?;

        if destination.exists() {
            std::fs::remove_dir_all(&destination).map_err(|e| Error::io(&destination, e))?;
        }
        copy_dir_all(&source, &destination)?;
        copied.push(folder.clone());
    }

    if copied.is_empty() {
        return Err(Error::NoAddonFolders);
    }
    Ok(copied)
}

fn copy_dir_all(from: &Path, to: &Path) -> Result<()> {
    std::fs::create_dir_all(to).map_err(|e| Error::io(to, e))?;
    let entries = std::fs::read_dir(from).map_err(|e| Error::io(from, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| Error::io(from, e))?;
        let source = entry.path();
        let destination = to.join(entry.file_name());
        if source.is_dir() {
            copy_dir_all(&source, &destination)?;
        } else {
            std::fs::copy(&source, &destination).map_err(|e| Error::io(&destination, e))?;
        }
    }
    Ok(())
}
