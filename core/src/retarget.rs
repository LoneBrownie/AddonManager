//! Moving an installed addon onto a different repository.
//!
//! Private-server addons fork constantly: the project someone installed in
//! January is abandoned by March and the server's community has moved to
//! somebody else's build of it. Before this, following that move meant removing
//! the addon and adding it again from the new URL — two actions, with a window
//! in between where the folder is gone from the game directory.
//!
//! The work here is almost entirely bookkeeping, because an addon's identity
//! *is* its source: [`Source::id`] is what [`crate::model::Addon::id`] holds, so
//! "change the source" means the installation row has to move to a different
//! addon id. Doing that by hand — remove the row, install the new one — would
//! walk straight into the collision rule, because the folders on disk would then
//! belong to nobody and [`crate::plan::plan_folders`] would classify them as
//! unmanaged and refuse (V2-PLAN.md B2).
//!
//! So the row is **re-keyed in place** and the install runs against it. Three
//! things fall out of that for free:
//!
//! * the folders it already owns classify as `ReplaceOwn`, so no consent prompt
//!   is needed for files this addon put there itself;
//! * a fork that ships different folder names is handled by the superseded
//!   -folder pass in [`crate::install`], which deletes what the addon used to
//!   own and no longer does;
//! * a failure leaves nothing behind, because the caller commits the store only
//!   when the install returns `Ok` — the re-keyed snapshot is simply dropped.
//!
//! **The pin does not survive.** A pin holds one version, and this replaces the
//! version with one from a repository that has never been checked. Carried
//! forward it would hide the row's Update button (the interface treats a pinned
//! addon as having no available action) against files nobody has ever compared
//! to an upstream. Clearing it is not discarding a preference; the thing the
//! preference referred to no longer exists.
//!
//! **The channel is not inferred either.** A fork may number its releases
//! differently, or cut none at all — and the resolver refuses a release-less
//! repository rather than quietly taking its branch. So the caller passes the
//! channel explicitly, and a wrong guess surfaces as that refusal, which already
//! names its own remedy.
//!
//! Changing the source on one server never touches another. The same addon can
//! sit in two game folders tracking two different forks, which is the whole
//! point of the row-per-pair model (V2-PLAN.md 5.3).

use std::path::Path;

use crate::error::{Error, Result};
use crate::http::HttpClient;
use crate::install::{self, InstallOptions};
use crate::model::{InstalledAddon, Source, Store};

/// Point an installed addon at `new_source` and install from it.
///
/// `addon_id` is the addon as it is recorded now; the row comes back keyed to
/// the new source. Only the installation on `server_id` moves.
///
/// Takes the same [`InstallOptions`] as [`install::install`] rather than a
/// channel of its own, so there is one place where the knobs for a write live.
/// `options.channel` is the channel the row is moved onto.
pub async fn change_source(
    client: &dyn HttpClient,
    store: &mut Store,
    server_id: &str,
    addon_id: &str,
    new_source: &Source,
    options: &InstallOptions,
    work_dir: &Path,
) -> Result<InstalledAddon> {
    let new_id = new_source.id();

    if store.installation(server_id, addon_id).is_none() {
        return Err(Error::NotInstalled {
            addon_id: addon_id.to_string(),
            server_id: server_id.to_string(),
        });
    }

    // Switching onto a repository this server already has would collapse two
    // rows into one. Whichever lost would vanish from the list while its folders
    // stayed on disk, owned by a record that no longer mentions them.
    if new_id != addon_id && store.installation(server_id, &new_id).is_some() {
        return Err(Error::AlreadyInstalled { addon_id: new_id });
    }

    // Re-key in place. See the module docs: this is what makes the folders this
    // addon already owns replaceable rather than a collision with a stranger.
    if let Some(row) = store
        .installed
        .iter_mut()
        .find(|i| i.server_id == server_id && i.addon_id == addon_id)
    {
        row.addon_id = new_id;
        row.channel = options.channel;
        row.pinned = false;
    }

    // The old addon record, if this was the last server holding it. An addon
    // still installed elsewhere is kept — the switch is per server.
    store.prune_orphan_addons();

    install::install(client, store, server_id, new_source, options, work_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Channel, GameVersion, Server};
    use crate::testing::{addon_zip, fake_wow_dir, FakeHttp};
    use crate::version::Ref;

    fn old_source() -> Source {
        Source::Github {
            owner: "old".into(),
            repo: "MyAddon".into(),
        }
    }

    fn new_source() -> Source {
        Source::Github {
            owner: "fork".into(),
            repo: "MyAddon".into(),
        }
    }

    /// A forge serving one release of `owner/repo`, whose asset is `zip`.
    fn forge(owner: &str, repo: &str, tag: &str, zip: Vec<u8>) -> FakeHttp {
        let releases = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
        let asset = format!("https://github.com/{owner}/{repo}/releases/download/{tag}/a.zip");
        FakeHttp::new()
            .json(
                &releases,
                &format!(
                    r#"{{"tag_name":"{tag}","published_at":"2026-01-01T00:00:00Z",
                         "assets":[{{"name":"a.zip","browser_download_url":"{asset}"}}]}}"#
                ),
            )
            .file(&asset, zip)
    }

    /// The default install, tracking tagged releases.
    fn releases() -> InstallOptions {
        InstallOptions {
            channel: Channel::Release,
            ..InstallOptions::default()
        }
    }

    fn server_in(root: &Path) -> Server {
        fake_wow_dir(root).unwrap_or_else(|e| panic!("{e}"));
        Server::new("Epoch", root, GameVersion::Wotlk)
    }

    /// A store with `MyAddon` installed to one server from [`old_source`].
    fn installed_from_old(root: &Path, pinned: bool) -> (Store, String) {
        let mut store = Store::default();
        let server = server_in(root);
        let server_id = server.id.clone();
        store.servers.push(server);
        store
            .addons
            .push(crate::model::Addon::new(old_source(), "MyAddon"));
        store.upsert_installation(InstalledAddon {
            server_id: server_id.clone(),
            addon_id: old_source().id(),
            channel: Channel::Release,
            pinned,
            installed_ref: Ref::release("v1.0.0"),
            folders: vec!["MyAddon".into()],
            archive_sha256: None,
            installed_at: "0".into(),
            version_matches: true,
        });
        std::fs::create_dir_all(root.join("Interface/AddOns/MyAddon"))
            .unwrap_or_else(|e| panic!("{e}"));
        (store, server_id)
    }

    #[tokio::test]
    async fn the_row_moves_to_the_new_source() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);
        let client = forge(
            "fork",
            "MyAddon",
            "v2.0.0",
            addon_zip("MyAddon", 30300, "2.0.0"),
        );

        let installed = change_source(
            &client,
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await
        .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(installed.addon_id, "github:fork/MyAddon");
        assert_eq!(
            installed.installed_ref.display(),
            "v2.0.0",
            "the version comes from the new repository"
        );
        assert_eq!(store.installed.len(), 1, "moved, not duplicated");
        assert!(
            store.installation(&server_id, &old_source().id()).is_none(),
            "nothing is left under the old id"
        );
        assert!(
            store.addon("github:old/MyAddon").is_none(),
            "the orphaned addon record is pruned"
        );
        assert!(store.addon("github:fork/MyAddon").is_some());
    }

    /// The reason this exists: a pin holds a version that the switch replaces.
    #[tokio::test]
    async fn a_pin_does_not_survive_the_switch() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), true);
        let client = forge(
            "fork",
            "MyAddon",
            "v2.0.0",
            addon_zip("MyAddon", 30300, "2.0.0"),
        );

        let installed = change_source(
            &client,
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await
        .unwrap_or_else(|e| panic!("{e}"));

        assert!(!installed.pinned, "the pin held a version that is now gone");
    }

    /// The folders on disk belong to the addon being moved, so replacing them
    /// needs no consent prompt — the collision rule protects other people's
    /// folders, not this addon's own.
    #[tokio::test]
    async fn the_addons_own_folders_are_replaced_without_a_collision() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);
        let client = forge(
            "fork",
            "MyAddon",
            "v2.0.0",
            addon_zip("MyAddon", 30300, "2.0.0"),
        );

        let result = change_source(
            &client,
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await;

        assert!(result.is_ok(), "own folders must not read as a collision");
        assert!(tmp.path().join("Interface/AddOns/MyAddon").is_dir());
    }

    /// A fork that installs under a different name must not leave the old folder
    /// behind: the game would find two manifests and load the addon twice.
    #[tokio::test]
    async fn a_folder_the_new_source_does_not_ship_is_removed() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);
        let client = forge(
            "fork",
            "MyAddon",
            "v2.0.0",
            addon_zip("MyAddon-Epoch", 30300, "2.0.0"),
        );

        let installed = change_source(
            &client,
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await
        .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(installed.folders, vec!["MyAddon-Epoch".to_string()]);
        assert!(tmp.path().join("Interface/AddOns/MyAddon-Epoch").is_dir());
        assert!(
            !tmp.path().join("Interface/AddOns/MyAddon").exists(),
            "the folder the old source owned is gone"
        );
    }

    /// V2-PLAN.md 5.3: the same addon in two servers is two independent rows.
    #[tokio::test]
    async fn switching_one_server_leaves_the_other_alone() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let other = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);

        let second = server_in(other.path());
        let second_id = second.id.clone();
        store.servers.push(second);
        store.upsert_installation(InstalledAddon {
            server_id: second_id.clone(),
            addon_id: old_source().id(),
            channel: Channel::Release,
            pinned: true,
            installed_ref: Ref::release("v1.0.0"),
            folders: vec!["MyAddon".into()],
            archive_sha256: None,
            installed_at: "0".into(),
            version_matches: true,
        });

        let client = forge(
            "fork",
            "MyAddon",
            "v2.0.0",
            addon_zip("MyAddon", 30300, "2.0.0"),
        );
        change_source(
            &client,
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await
        .unwrap_or_else(|e| panic!("{e}"));

        let untouched = store.installation(&second_id, &old_source().id());
        assert!(untouched.is_some(), "the other server keeps the old source");
        assert_eq!(untouched.map(|i| i.pinned), Some(true), "and its pin");
        assert!(
            store.addon("github:old/MyAddon").is_some(),
            "the addon record is still in use elsewhere"
        );
    }

    #[tokio::test]
    async fn switching_onto_something_already_installed_here_is_refused() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);
        store.upsert_installation(InstalledAddon {
            server_id: server_id.clone(),
            addon_id: new_source().id(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v9.9.9"),
            folders: vec!["Other".into()],
            archive_sha256: None,
            installed_at: "0".into(),
            version_matches: true,
        });

        let result = change_source(
            &FakeHttp::new(),
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await;

        assert!(matches!(result, Err(Error::AlreadyInstalled { .. })));
        assert_eq!(store.installed.len(), 2, "neither row was disturbed");
    }

    #[tokio::test]
    async fn switching_something_that_is_not_installed_is_an_error() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (mut store, server_id) = installed_from_old(tmp.path(), false);

        let result = change_source(
            &FakeHttp::new(),
            &mut store,
            &server_id,
            "github:nobody/nothing",
            &new_source(),
            &releases(),
            work.path(),
        )
        .await;

        assert!(matches!(result, Err(Error::NotInstalled { .. })));
    }

    /// A failed switch must leave the store exactly as it was: the caller
    /// discards the snapshot, so the re-key never reaches disk.
    #[tokio::test]
    async fn a_failed_switch_does_not_half_move_the_row() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (original, server_id) = installed_from_old(tmp.path(), true);
        let mut store = original.clone();

        // No routes registered, so resolution fails.
        let result = change_source(
            &FakeHttp::new(),
            &mut store,
            &server_id,
            &old_source().id(),
            &new_source(),
            &releases(),
            work.path(),
        )
        .await;

        assert!(result.is_err());
        assert!(
            tmp.path().join("Interface/AddOns/MyAddon").is_dir(),
            "the addon is still on disk"
        );
        // The snapshot handed to a failed switch is thrown away by the caller,
        // so `original` is what would actually be persisted. It still holds the
        // addon at its old source, still pinned.
        let kept = original.installation(&server_id, &old_source().id());
        assert_eq!(kept.map(|i| i.pinned), Some(true));
        assert_eq!(
            kept.map(|i| i.installed_ref.clone()),
            Some(Ref::release("v1.0.0"))
        );
    }
}
