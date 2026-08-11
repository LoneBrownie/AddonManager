//! Install, update and remove.
//!
//! The orchestration V1 spread across a 1,662-line renderer module. Three
//! behaviours here are deliberate departures from V1:
//!
//! * **Nothing is deleted that we did not create.** V1 computed a destination
//!   from a `.toc` filename and removed it unconditionally, so an addon whose
//!   name collided with a hand-installed folder silently destroyed it
//!   (V2-PLAN.md B2). Backups are out of scope (D11), so the collision is
//!   *prevented* instead.
//! * **Every folder written is recorded**, which makes removal exact and
//!   retires V1's folder-relatedness guessing (V2-PLAN.md D-b).
//! * **An unreachable server path is never mistaken for a deletion**
//!   (V2-PLAN.md B8).

use std::path::{Path, PathBuf};

use crate::archive::{self, Limits};
use crate::error::{Error, Result};
use crate::http::HttpClient;
use crate::model::{Addon, Channel, InstalledAddon, Server, Source, Store};
use crate::paths;
use crate::sources;
use crate::toc;
use crate::version::{self, Ref, UpdateStatus};

/// Knobs for a single install.
#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    pub channel: Channel,
    pub token: Option<String>,
    /// Proceed even though a destination folder exists and we do not own it.
    /// Set only after the user has been shown the folder name and agreed.
    pub overwrite_unmanaged: bool,
    pub limits: Limits,
}

/// What an install would do to one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderPlan {
    /// Nothing there; safe to write.
    Create(String),
    /// We installed it for this same addon; safe to replace.
    ReplaceOwn(String),
    /// A different managed addon owns it. Refuse.
    ConflictsWithAddon { folder: String, owner: String },
    /// It exists but we did not create it. Refuse unless told otherwise.
    ConflictsWithUnmanaged(String),
}

impl FolderPlan {
    pub fn folder(&self) -> &str {
        match self {
            FolderPlan::Create(f)
            | FolderPlan::ReplaceOwn(f)
            | FolderPlan::ConflictsWithUnmanaged(f) => f,
            FolderPlan::ConflictsWithAddon { folder, .. } => folder,
        }
    }

    pub fn is_blocking(&self) -> bool {
        matches!(
            self,
            FolderPlan::ConflictsWithAddon { .. } | FolderPlan::ConflictsWithUnmanaged(_)
        )
    }
}

/// Classify what would happen to each destination folder.
///
/// Pure apart from the existence check, so it is straightforward to test and
/// can be shown to the user before anything is written.
pub fn plan_folders(
    store: &Store,
    server: &Server,
    addon_id: &str,
    folders: &[String],
    addons_dir: &Path,
) -> Vec<FolderPlan> {
    folders
        .iter()
        .map(|folder| match store.folder_owner(&server.id, folder) {
            Some(existing) if existing.addon_id == addon_id => {
                FolderPlan::ReplaceOwn(folder.clone())
            }
            Some(existing) => FolderPlan::ConflictsWithAddon {
                folder: folder.clone(),
                owner: existing.addon_id.clone(),
            },
            None => {
                if addons_dir.join(folder).exists() {
                    FolderPlan::ConflictsWithUnmanaged(folder.clone())
                } else {
                    FolderPlan::Create(folder.clone())
                }
            }
        })
        .collect()
}

/// Install (or reinstall) `source` into `server`.
pub async fn install(
    client: &dyn HttpClient,
    store: &mut Store,
    server_id: &str,
    source: &Source,
    options: &InstallOptions,
    work_dir: &Path,
) -> Result<InstalledAddon> {
    let server = store
        .server(server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?
        .clone();
    ensure_available(&server)?;

    let addons_dir = server.addons_dir();
    std::fs::create_dir_all(&addons_dir).map_err(|e| Error::io(&addons_dir, e))?;
    ensure_writable(&addons_dir)?;

    let resolved =
        sources::resolve(client, source, options.channel, options.token.as_deref()).await?;

    // --- fetch and unpack into a staging area, never the game directory ---
    let staging = work_dir.join(format!("staging-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&staging).map_err(|e| Error::io(&staging, e))?;
    let cleanup = StagingGuard(staging.clone());

    let archive_path = staging.join("download.zip");
    client
        .download(&resolved.download_url, &archive_path)
        .await?;
    let sha256 = archive::sha256_file(&archive_path).ok();

    let unpacked = staging.join("unpacked");
    std::fs::create_dir_all(&unpacked).map_err(|e| Error::io(&unpacked, e))?;
    let file = std::fs::File::open(&archive_path).map_err(|e| Error::io(&archive_path, e))?;
    let extracted = archive::extract(file, &unpacked, options.limits)?;

    // --- decide the destination folder names ---
    let addon_id = source.id();
    let mut sources_and_targets: Vec<(PathBuf, String)> = Vec::new();
    for relative in &extracted.addon_dirs {
        let source_dir = unpacked.join(relative);
        let extracted_name = relative
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        let toc_names = archive::toc_file_names(&source_dir);

        // The folder name WoW requires is the base name of the .toc — a lookup,
        // not the heuristic pile V1 used.
        let target = toc::canonical_addon_name(&toc_names, extracted_name, source.repo_name())
            .unwrap_or_else(|| extracted_name.to_string());

        paths::validate_component(&target)?;
        sources_and_targets.push((source_dir, target));
    }

    if sources_and_targets.is_empty() {
        return Err(Error::NoAddonFolders);
    }

    let target_names: Vec<String> = sources_and_targets
        .iter()
        .map(|(_, name)| name.clone())
        .collect();

    // --- refuse to clobber anything we did not create ---
    for plan in plan_folders(store, &server, &addon_id, &target_names, &addons_dir) {
        match plan {
            FolderPlan::ConflictsWithAddon { folder, owner } => {
                return Err(Error::ManagedCollision { folder, owner })
            }
            FolderPlan::ConflictsWithUnmanaged(folder) if !options.overwrite_unmanaged => {
                return Err(Error::UnmanagedCollision { folder })
            }
            _ => {}
        }
    }

    // --- write ---
    for (source_dir, target_name) in &sources_and_targets {
        let destination = addons_dir.join(target_name);
        paths::confine(&addons_dir, &destination)?;

        if destination.exists() {
            std::fs::remove_dir_all(&destination).map_err(|e| Error::io(&destination, e))?;
        }
        copy_dir_all(source_dir, &destination)?;
    }

    drop(cleanup);

    let installation = InstalledAddon {
        server_id: server.id.clone(),
        addon_id: addon_id.clone(),
        channel: options.channel,
        pinned: false,
        installed_ref: resolved.r#ref,
        folders: target_names,
        archive_sha256: sha256,
        installed_at: now_rfc3339(),
    };

    if store.addon(&addon_id).is_none() {
        let display = source
            .repo_name()
            .map(str::to_string)
            .unwrap_or_else(|| addon_id.clone());
        store.addons.push(Addon::new(source.clone(), display));
    }
    if let Some(addon) = store.addons.iter_mut().find(|a| a.id == addon_id) {
        addon.cached_etag = resolved.etag.clone();
    }
    store.upsert_installation(installation.clone());

    Ok(installation)
}

/// Remove an addon from one server, deleting exactly the folders we recorded.
///
/// Removing from one server never touches another.
pub fn remove(store: &mut Store, server_id: &str, addon_id: &str) -> Result<Vec<String>> {
    let server = store
        .server(server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?
        .clone();
    let installation = store
        .installation(server_id, addon_id)
        .ok_or_else(|| Error::UnknownServer(format!("{addon_id} is not installed to {server_id}")))?
        .clone();

    ensure_available(&server)?;
    let addons_dir = server.addons_dir();

    let mut removed = Vec::new();
    for folder in &installation.folders {
        let path = addons_dir.join(folder);
        if paths::confine(&addons_dir, &path).is_err() {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path).map_err(|e| Error::io(&path, e))?;
            removed.push(folder.clone());
        }
    }

    store
        .installed
        .retain(|i| !(i.server_id == server_id && i.addon_id == addon_id));
    store.prune_orphan_addons();

    Ok(removed)
}

/// What an update check found for one installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReport {
    pub addon_id: String,
    pub status: UpdateStatus,
    pub installed: Ref,
    pub latest: Ref,
}

/// Check one installation for an update.
pub async fn check_update(
    client: &dyn HttpClient,
    store: &Store,
    server_id: &str,
    addon_id: &str,
    token: Option<&str>,
) -> Result<UpdateReport> {
    let installation = store.installation(server_id, addon_id).ok_or_else(|| {
        Error::UnknownServer(format!("{addon_id} is not installed to {server_id}"))
    })?;
    let addon = store
        .addon(addon_id)
        .ok_or_else(|| Error::UnknownServer(addon_id.to_string()))?;

    let resolved = sources::resolve(client, &addon.source, installation.channel, token).await?;

    Ok(UpdateReport {
        addon_id: addon_id.to_string(),
        status: version::check(&installation.installed_ref, &resolved.r#ref),
        installed: installation.installed_ref.clone(),
        latest: resolved.r#ref,
    })
}

/// A server's path being unreachable means "cannot check right now".
///
/// It must never be read as "the user deleted their addons" — that is exactly
/// the mistake that made V1's B8 destroy records when a drive was unplugged.
fn ensure_available(server: &Server) -> Result<()> {
    if server.is_available() {
        Ok(())
    } else {
        Err(Error::ServerUnavailable {
            name: server.name.clone(),
            path: server.path.clone(),
        })
    }
}

/// Probe writability by creating and removing a file.
///
/// Checked up front so the user gets an actionable message rather than a
/// half-finished install — and so we never need to relaunch as Administrator
/// the way V1 did (V2-PLAN.md S4).
fn ensure_writable(dir: &Path) -> Result<()> {
    let probe = dir.join(format!(".bam-write-test-{}", uuid::Uuid::new_v4().simple()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(source) => Err(Error::NotWritable {
            path: dir.to_path_buf(),
            hint: format!(
                "{source}. Move the game out of a protected location such as Program Files, \
                 or grant your user account write access to this folder."
            ),
        }),
    }
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

/// Removes the staging directory when it goes out of scope, including on the
/// error paths, so a failed install leaves no debris.
struct StagingGuard(PathBuf);

impl Drop for StagingGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    // Enough for an audit trail; the UI formats from this.
    format!("{seconds}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{GameVersion, Server};

    fn store_with_server(path: &Path) -> (Store, String) {
        let mut store = Store::default();
        let server = Server::new("Epoch", path, GameVersion::Wotlk);
        let id = server.id.clone();
        store.servers.push(server);
        (store, id)
    }

    #[test]
    fn plans_a_fresh_folder_as_create() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (store, id) = store_with_server(tmp.path());
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let plans = plan_folders(
            &store,
            &server,
            "github:o/r",
            &["MyAddon".to_string()],
            tmp.path(),
        );
        assert_eq!(plans, vec![FolderPlan::Create("MyAddon".into())]);
        assert!(!plans.iter().any(FolderPlan::is_blocking));
    }

    #[test]
    fn planning_our_own_folder_allows_replacement() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, id) = store_with_server(tmp.path());
        store.upsert_installation(InstalledAddon {
            server_id: id.clone(),
            addon_id: "github:o/r".into(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            folders: vec!["MyAddon".into()],
            archive_sha256: None,
            installed_at: "0".into(),
        });
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let plans = plan_folders(
            &store,
            &server,
            "github:o/r",
            &["MyAddon".to_string()],
            tmp.path(),
        );
        assert_eq!(plans, vec![FolderPlan::ReplaceOwn("MyAddon".into())]);
    }

    /// V2-PLAN.md B2: another managed addon's folder must never be clobbered.
    #[test]
    fn planning_another_addons_folder_is_blocking() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, id) = store_with_server(tmp.path());
        store.upsert_installation(InstalledAddon {
            server_id: id.clone(),
            addon_id: "github:someone/else".into(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            folders: vec!["MyAddon".into()],
            archive_sha256: None,
            installed_at: "0".into(),
        });
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let plans = plan_folders(
            &store,
            &server,
            "github:o/r",
            &["MyAddon".to_string()],
            tmp.path(),
        );
        assert!(plans.iter().any(FolderPlan::is_blocking));
        assert!(matches!(
            plans.first(),
            Some(FolderPlan::ConflictsWithAddon { .. })
        ));
    }

    /// The V1 data-loss case: a hand-installed folder with a colliding name.
    #[test]
    fn planning_over_a_hand_installed_folder_is_blocking() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(tmp.path().join("MyAddon")).unwrap_or_else(|e| panic!("{e}"));
        let (store, id) = store_with_server(tmp.path());
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let plans = plan_folders(
            &store,
            &server,
            "github:o/r",
            &["MyAddon".to_string()],
            tmp.path(),
        );
        assert_eq!(
            plans,
            vec![FolderPlan::ConflictsWithUnmanaged("MyAddon".into())]
        );
    }

    #[test]
    fn folder_ownership_does_not_leak_between_servers() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, first) = store_with_server(tmp.path());
        let second = Server::new("Warmane", tmp.path(), GameVersion::Wotlk);
        let second_id = second.id.clone();
        store.servers.push(second);

        store.upsert_installation(InstalledAddon {
            server_id: first,
            addon_id: "github:someone/else".into(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            folders: vec!["MyAddon".into()],
            archive_sha256: None,
            installed_at: "0".into(),
        });

        let server = store
            .server(&second_id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));
        let plans = plan_folders(
            &store,
            &server,
            "github:o/r",
            &["MyAddon".to_string()],
            &tmp.path().join("nonexistent"),
        );
        assert_eq!(
            plans,
            vec![FolderPlan::Create("MyAddon".into())],
            "the other server's ownership must not block this one"
        );
    }

    #[test]
    fn an_unavailable_server_reports_unavailable_not_deleted() {
        let server = Server::new("Offline", "/definitely/not/mounted", GameVersion::Wotlk);
        assert!(!server.is_available());
        assert!(matches!(
            ensure_available(&server),
            Err(Error::ServerUnavailable { .. })
        ));
    }

    #[test]
    fn writability_is_probed_before_anything_is_written() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        assert!(ensure_writable(tmp.path()).is_ok());
        assert!(
            ensure_writable(Path::new("/definitely/not/a/real/dir")).is_err(),
            "a missing directory is not writable"
        );
    }

    #[test]
    fn copy_dir_all_copies_nested_trees() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let from = tmp.path().join("from/deep/deeper");
        std::fs::create_dir_all(&from).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(from.join("file.txt"), b"hi").unwrap_or_else(|e| panic!("{e}"));

        let to = tmp.path().join("to");
        copy_dir_all(&tmp.path().join("from"), &to).unwrap_or_else(|e| panic!("{e}"));

        assert!(to.join("deep/deeper/file.txt").is_file());
    }
}
