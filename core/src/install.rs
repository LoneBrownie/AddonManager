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
use crate::model::{Addon, Channel, InstalledAddon, Source, Store};
use crate::paths;
use crate::plan::{self, FolderPlan};
use crate::sources;
use crate::toc;

/// Knobs for a single install.
#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    pub channel: Channel,
    pub token: Option<String>,
    /// Proceed even though a destination folder exists and we do not own it.
    /// Set only after the user has been shown the folder name and agreed.
    pub overwrite_unmanaged: bool,
    /// Install from the default branch when the repository has no releases at
    /// all, rather than failing.
    ///
    /// Off by default, and deliberately so: silently switching channel would
    /// hide a mistyped URL and install a different kind of artifact than the
    /// user asked for. Importing a list is the case where it is right — those
    /// URLs are ones the user already ran, and half of 3.3.5a addons never cut
    /// a release, so refusing turns a migration into a wall of errors.
    pub fallback_to_source: bool,
    /// Take over folders that are already on disk instead of refusing to
    /// overwrite them.
    ///
    /// For importing a list into a game folder that already has the addons in
    /// it — the V1-to-V2 case. Nothing on disk is touched: the existing files
    /// stay exactly as they are and become managed at an unknown version, which
    /// the next update replaces with a version this app can name.
    pub adopt_existing: bool,
    pub limits: Limits,
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
    plan::ensure_available(&server)?;

    let addons_dir = server.addons_dir();
    std::fs::create_dir_all(&addons_dir).map_err(|e| Error::io(&addons_dir, e))?;
    plan::ensure_writable(&addons_dir)?;

    // The channel actually used, which is not always the one asked for: a
    // repository with no releases can only be installed from its branch, and an
    // import says up front that it would rather have that than an error. The
    // resolver itself still refuses — the decision is made here, once, and
    // recorded, so the row shows `source` and updates track the branch.
    let mut channel = options.channel;
    let resolved = match sources::resolve(client, source, channel, options.token.as_deref()).await {
        Err(Error::NoResolvableRef(reason))
            if options.fallback_to_source && channel == Channel::Release =>
        {
            tracing::info!(%reason, "no release; falling back to the source channel");
            channel = Channel::Source;
            sources::resolve(client, source, channel, options.token.as_deref()).await?
        }
        other => other?,
    };

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
    // The manifest each folder will actually load, kept so the version warning
    // is judged on that file rather than on every file present. An addon
    // shipping a 2.4.3 manifest beside its 3.3.5 one is not "for the wrong
    // version" — the client never opens the other one.
    let mut chosen_tocs: Vec<toc::TocData> = Vec::new();

    for relative in &extracted.addon_dirs {
        let source_dir = unpacked.join(relative);
        let extracted_name = relative
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();

        // Read from the staged copy, before anything reaches the game folder.
        let tocs: Vec<toc::TocFile> = archive::toc_file_names(&source_dir)
            .into_iter()
            .map(|file_name| {
                let data = std::fs::read_to_string(source_dir.join(&file_name))
                    .map(|contents| toc::parse(&contents))
                    .unwrap_or_default();
                toc::TocFile { file_name, data }
            })
            .collect();

        // The folder name WoW requires is the name of the .toc it will open,
        // and which one that is depends on the server's version — a lookup, not
        // the heuristic pile V1 used.
        let chosen = toc::choose_toc(&tocs, server.version, extracted_name, source.repo_name());
        let target = chosen
            .and_then(|toc| toc.stem())
            .map(str::to_string)
            .unwrap_or_else(|| extracted_name.to_string());

        chosen_tocs.push(chosen.map(|toc| toc.data.clone()).unwrap_or_default());
        paths::validate_component(&target)?;
        sources_and_targets.push((source_dir, target));
    }

    let version_matches = chosen_tocs.iter().all(|data| data.supports(server.version));

    if sources_and_targets.is_empty() {
        return Err(Error::NoAddonFolders);
    }

    let target_names: Vec<String> = sources_and_targets
        .iter()
        .map(|(_, name)| name.clone())
        .collect();

    // --- refuse to clobber anything we did not create ---
    let plans = plan::plan_folders(store, &server, &addon_id, &target_names, &addons_dir);
    let collides_with_unmanaged = plans
        .iter()
        .any(|plan| matches!(plan, FolderPlan::ConflictsWithUnmanaged(_)));

    for plan in &plans {
        match plan {
            FolderPlan::ConflictsWithAddon { folder, owner } => {
                return Err(Error::ManagedCollision {
                    folder: folder.clone(),
                    owner: owner.clone(),
                })
            }
            FolderPlan::ConflictsWithUnmanaged(folder)
                if !options.overwrite_unmanaged && !options.adopt_existing =>
            {
                return Err(Error::UnmanagedCollision {
                    folder: folder.clone(),
                })
            }
            _ => {}
        }
    }

    // --- already there: take it over rather than reinstall it ---
    //
    // Someone moving a whole collection across already has these addons in
    // their game folder. Downloading over the top would replace working files
    // with whatever upstream happens to be at today, which is a change they did
    // not ask for and might not want mid-raid-tier. So the files are left
    // exactly as they are and recorded at an unknown version, which the Update
    // button on the row replaces the moment they want it.
    //
    // The archive is still fetched, and has to be: the folder names an addon
    // installs into are in the archive, and nothing about a folder on disk
    // reveals which repository it came from. That is the same reason adoption
    // asks for the URL rather than guessing it.
    if collides_with_unmanaged && !options.overwrite_unmanaged {
        drop(cleanup);

        // Only the folders genuinely on disk. Recording one that is not there
        // would flag the addon `missing` the moment it is adopted.
        let present: Vec<String> = target_names
            .iter()
            .filter(|folder| addons_dir.join(folder).is_dir())
            .cloned()
            .collect();

        let installation = InstalledAddon {
            server_id: server.id.clone(),
            addon_id: addon_id.clone(),
            channel,
            pinned: false,
            installed_ref: crate::version::Ref::Unknown,
            folders: present,
            archive_sha256: None,
            installed_at: now_rfc3339(),
            // The archive's manifest describes what upstream ships, not what is
            // sitting in the folder, so it is not evidence about these files.
            version_matches: true,
        };

        record(store, source, &addon_id, &resolved, installation.clone());
        return Ok(installation);
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

    // Folders this addon used to own and no longer does. An addon can drop a
    // module between versions, and a rename can move the whole thing — the
    // folder name depends on the server's version, so correcting how that name
    // is chosen moves existing installs. Left behind, the old folder still
    // contains a manifest matching its own name, so the game would load the
    // addon twice.
    //
    // Only ever folders recorded against this addon on this server: those are
    // exactly the ones we created.
    let superseded: Vec<String> = store
        .installation(&server.id, &addon_id)
        .map(|previous| {
            previous
                .folders
                .iter()
                .filter(|folder| !target_names.contains(folder))
                .cloned()
                .collect()
        })
        .unwrap_or_default();

    for folder in superseded {
        let path = addons_dir.join(&folder);
        if paths::confine(&addons_dir, &path).is_err() {
            continue;
        }
        if path.is_dir() {
            tracing::info!(%folder, "removing a folder this addon no longer installs");
            std::fs::remove_dir_all(&path).map_err(|e| Error::io(&path, e))?;
        }
    }

    drop(cleanup);

    let installation = InstalledAddon {
        server_id: server.id.clone(),
        addon_id: addon_id.clone(),
        channel,
        pinned: false,
        installed_ref: resolved.r#ref.clone(),
        folders: target_names,
        archive_sha256: sha256,
        installed_at: now_rfc3339(),
        version_matches,
    };

    record(store, source, &addon_id, &resolved, installation.clone());

    Ok(installation)
}

/// Write the outcome of an install into the store.
///
/// Shared by installing and by adopting what was already there, so the two
/// cannot drift on what a recorded addon looks like.
fn record(
    store: &mut Store,
    source: &Source,
    addon_id: &str,
    resolved: &sources::Resolved,
    installation: InstalledAddon,
) {
    if store.addon(addon_id).is_none() {
        let display = source
            .repo_name()
            .map(str::to_string)
            .unwrap_or_else(|| addon_id.to_string());
        store.addons.push(Addon::new(source.clone(), display));
    }
    if let Some(addon) = store.addons.iter_mut().find(|a| a.id == addon_id) {
        addon.cached_etag = resolved.etag.clone();
    }
    store.upsert_installation(installation);
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

    plan::ensure_available(&server)?;
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
