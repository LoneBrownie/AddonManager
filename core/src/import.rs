//! Applying one line of an addon list to a server.
//!
//! The situation this exists for: someone has a game folder full of addons and
//! a list of where those addons came from. Nothing needs downloading — the
//! files are already there, and the list says which repository each one belongs
//! to. All that is missing is the record joining the two, which is precisely
//! what the list supplies.
//!
//! So an import reaches the network only when it has to:
//!
//! 1. **The list names the folders** — a list this app wrote. The folders are
//!    taken over exactly as they are, at the channel and version the list
//!    states. No request is made.
//! 2. **The list names the addon** — a V1 list, which wrote the `.toc` title
//!    next to each URL. A folder on disk reports that same title, so an exact
//!    match on it identifies the folder without guessing: the two strings come
//!    from the same field. Taken over at an unknown version, since V1 never
//!    recorded one.
//! 3. **Neither matches** — the addon is not here yet. Install it.
//!
//! Step 2 is an exact comparison and nothing more. V1 also scored partial name
//! overlaps, which produced confident wrong answers; a folder that fails to
//! match simply falls through to step 3, where the archive settles it.

use std::path::Path;

use crate::adopt;
use crate::error::Result;
use crate::http::HttpClient;
use crate::install::{self, InstallOptions};
use crate::list::ListEntry;
use crate::model::{Addon, Channel, InstalledAddon, Store};
use crate::sources;
use crate::version::Ref;

/// What an import did with one entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Fetched and written.
    Installed,
    /// Already on disk; the record now points at it. Nothing was downloaded.
    Adopted,
}

/// Install or adopt one entry of a list.
pub async fn apply(
    client: &dyn HttpClient,
    store: &mut Store,
    server_id: &str,
    entry: &ListEntry,
    token: Option<String>,
    work_dir: &Path,
) -> Result<(InstalledAddon, Outcome)> {
    let source = sources::parse_repo_url(&entry.url)?;
    let addon_id = source.id();

    if let Some(folders) = folders_on_disk(store, server_id, entry, &addon_id)? {
        let installation = InstalledAddon {
            server_id: server_id.to_string(),
            addon_id: addon_id.clone(),
            channel: entry.channel.unwrap_or(Channel::Release),
            pinned: false,
            // What the list says, which is the user's own record of what they
            // are running. Where it says nothing — a V1 list — the version is
            // unknown, and saying so is the honest answer.
            installed_ref: entry.version.clone().unwrap_or(Ref::Unknown),
            folders,
            archive_sha256: None,
            installed_at: now_rfc3339(),
            // Nothing was read from these files, so nothing is claimed of them.
            version_matches: true,
        };

        if store.addon(&addon_id).is_none() {
            let name = entry
                .name
                .clone()
                .or_else(|| source.repo_name().map(str::to_string))
                .unwrap_or_else(|| addon_id.clone());
            store.addons.push(Addon::new(source, name));
        }
        store.upsert_installation(installation.clone());
        return Ok((installation, Outcome::Adopted));
    }

    let options = InstallOptions {
        channel: entry.channel.unwrap_or_default(),
        token,
        // An imported list is a list of addons the user already runs, so a
        // repository that only ever ships from its branch is expected rather
        // than an error. The backstop for an addon whose folder name matched
        // nothing above: the archive names the folders, and if they turn out to
        // be there already they are taken over rather than written over.
        fallback_to_source: true,
        adopt_existing: true,
        ..InstallOptions::default()
    };
    let installed =
        install::install(client, store, server_id, &source, &options, work_dir).await?;

    // The install may have found the folders already there and adopted them.
    let outcome = if installed.installed_ref.is_unknown() {
        Outcome::Adopted
    } else {
        Outcome::Installed
    };
    Ok((installed, outcome))
}

/// The folders this entry's addon already occupies, if they can be identified
/// without asking the network.
///
/// `None` means "not here" — install it. `Some` is never empty.
fn folders_on_disk(
    store: &Store,
    server_id: &str,
    entry: &ListEntry,
    addon_id: &str,
) -> Result<Option<Vec<String>>> {
    let Some(server) = store.server(server_id).cloned() else {
        return Ok(None);
    };
    if !server.is_available() {
        return Ok(None);
    }
    let addons_dir = server.addons_dir();

    // 1. The list named them.
    if !entry.folders.is_empty() {
        let present: Vec<String> = entry
            .folders
            .iter()
            .filter(|folder| addons_dir.join(folder).is_dir())
            // Never take a folder away from an addon that already owns it.
            .filter(|folder| {
                store
                    .folder_owner(server_id, folder)
                    .is_none_or(|owner| owner.addon_id == addon_id)
            })
            .cloned()
            .collect();
        return Ok((!present.is_empty()).then_some(present));
    }

    // 2. The list named the addon, and a folder on disk answers to that name.
    let Some(name) = entry.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let found = adopt::scan(store, &server)?;
    let matches: Vec<&adopt::FoundAddon> = found
        .iter()
        .filter(|candidate| {
            candidate.folder.eq_ignore_ascii_case(name)
                || candidate
                    .toc
                    .title
                    .as_deref()
                    .is_some_and(|title| title.eq_ignore_ascii_case(name))
        })
        .collect();

    // Two folders answering to one name is not an identification.
    let [single] = matches.as_slice() else {
        return Ok(None);
    };

    // Its component folders come too. Left behind they would sit in the list as
    // unmanaged, and the first update would refuse to write over them.
    let mut folders = vec![single.folder.clone()];
    folders.extend(single.related.iter().cloned());
    Ok(Some(folders))
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    format!("{seconds}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{GameVersion, Server};
    use crate::testing::{fake_wow_dir, FakeHttp};

    fn server_with(folders: &[(&str, &str)]) -> (tempfile::TempDir, Store, String) {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        fake_wow_dir(tmp.path()).unwrap_or_else(|e| panic!("{e}"));
        let addons = tmp.path().join("Interface").join("AddOns");
        for (folder, toc) in folders {
            let dir = addons.join(folder);
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{e}"));
            std::fs::write(dir.join(format!("{folder}.toc")), toc)
                .unwrap_or_else(|e| panic!("{e}"));
        }

        let mut store = Store::default();
        let server = Server::new("Epoch", tmp.path(), GameVersion::Wotlk);
        let id = server.id.clone();
        store.servers.push(server);
        (tmp, store, id)
    }

    /// A network client that fails any request. Every test here that expects an
    /// adoption uses it, which is how "no download" is actually proven rather
    /// than asserted.
    fn offline() -> FakeHttp {
        FakeHttp::new()
    }

    #[tokio::test]
    async fn a_list_that_names_the_folders_adopts_them_without_asking_the_network() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[
            ("WeakAuras", "## Interface: 30300\n"),
            ("WeakAuras_Options", "## Interface: 30300\n"),
        ]);

        let entry = ListEntry {
            name: Some("WeakAuras".into()),
            url: "https://github.com/WeakAuras/WeakAuras2".into(),
            channel: Some(Channel::Release),
            version: Some(Ref::release("v2.4.8")),
            folders: vec!["WeakAuras".into(), "WeakAuras_Options".into()],
        };

        let (installed, outcome) = apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(outcome, Outcome::Adopted);
        assert_eq!(
            installed.installed_ref,
            Ref::release("v2.4.8"),
            "the list said which version, so that is what is recorded"
        );
        assert_eq!(installed.folders.len(), 2);
    }

    /// The V1 migration, which is the whole point: a name and a URL, and the
    /// folder identified by the title it reports about itself.
    #[tokio::test]
    async fn a_v1_line_finds_its_folder_by_the_name_v1_wrote() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[(
            "Skada",
            "## Interface: 30300\n## Title: Skada\n## Version: 1.7.3\n",
        )]);

        let entry = ListEntry {
            name: Some("Skada".into()),
            url: "https://github.com/bkader/Skada-WoTLK".into(),
            ..ListEntry::default()
        };

        let (installed, outcome) = apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(outcome, Outcome::Adopted);
        assert_eq!(installed.folders, vec!["Skada".to_string()]);
        assert_eq!(
            installed.installed_ref,
            Ref::Unknown,
            "V1 never recorded a version, so none is invented"
        );
        assert_eq!(
            store.addon("github:bkader/Skada-WoTLK").map(|a| a.id.clone()),
            Some("github:bkader/Skada-WoTLK".to_string()),
            "the folder is now managed against the repository the user named"
        );
    }

    /// The folder's name and its title differ often enough to matter — the
    /// title is what V1 exported.
    #[tokio::test]
    async fn a_folder_is_matched_on_the_title_it_reports_not_only_its_name() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[(
            "NotPlater-3.3.5",
            "## Interface: 30300\n## Title: NotPlater\n",
        )]);

        let entry = ListEntry {
            name: Some("NotPlater".into()),
            url: "https://github.com/o/NotPlater".into(),
            ..ListEntry::default()
        };

        let (installed, outcome) = apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(outcome, Outcome::Adopted);
        assert_eq!(installed.folders, vec!["NotPlater-3.3.5".to_string()]);
    }

    /// Component folders come with it, or the first update refuses to write
    /// over the ones left behind.
    #[tokio::test]
    async fn component_folders_are_taken_over_alongside_the_addon() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[
            ("AtlasLoot", "## Interface: 30300\n## Title: AtlasLoot\n"),
            ("AtlasLoot_Loader", "## Interface: 30300\n"),
        ]);

        let entry = ListEntry {
            name: Some("AtlasLoot".into()),
            url: "https://github.com/Hegarol/AtlasLootClassic".into(),
            ..ListEntry::default()
        };

        let (installed, _) = apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            installed.folders,
            vec!["AtlasLoot".to_string(), "AtlasLoot_Loader".to_string()]
        );
    }

    /// An identification that is not unique is not an identification.
    #[tokio::test]
    async fn two_folders_answering_to_one_name_are_not_matched() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[
            ("Recount", "## Interface: 30300\n## Title: Damage\n"),
            ("Skada", "## Interface: 30300\n## Title: Damage\n"),
        ]);

        let entry = ListEntry {
            name: Some("Damage".into()),
            url: "https://github.com/o/r".into(),
            ..ListEntry::default()
        };

        // Nothing is adopted, so it falls through to installing — which fails,
        // because this client serves nothing. Failing is the right outcome:
        // picking one of the two would be a guess.
        assert!(apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .is_err());
        assert!(store.installed.is_empty());
    }

    /// A folder another addon already owns is never taken from it.
    #[tokio::test]
    async fn a_folder_owned_by_another_addon_is_left_alone() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (_tmp, mut store, id) = server_with(&[("Questie", "## Interface: 30300\n")]);
        store.upsert_installation(InstalledAddon {
            server_id: id.clone(),
            addon_id: "github:someone/else".into(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            folders: vec!["Questie".into()],
            archive_sha256: None,
            installed_at: "0".into(),
            version_matches: true,
        });

        let entry = ListEntry {
            name: Some("Questie".into()),
            url: "https://github.com/o/questie".into(),
            folders: vec!["Questie".into()],
            ..ListEntry::default()
        };

        assert!(apply(&offline(), &mut store, &id, &entry, None, work.path())
            .await
            .is_err());
        assert_eq!(
            store.folder_owner(&id, "Questie").map(|i| i.addon_id.clone()),
            Some("github:someone/else".to_string())
        );
    }

    /// Nothing on disk to match: this one really does have to be fetched.
    #[tokio::test]
    async fn an_addon_that_is_not_here_yet_is_installed() {
        let work = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let (tmp, mut store, id) = server_with(&[]);

        let asset = "https://github.com/o/r/releases/download/v1.0.0/MyAddon.zip";
        let client = FakeHttp::new()
            .json(
                "https://api.github.com/repos/o/r/releases/latest",
                &format!(
                    r#"{{"tag_name":"v1.0.0","assets":[{{"name":"MyAddon.zip","browser_download_url":"{asset}"}}]}}"#
                ),
            )
            .file(asset, crate::testing::addon_zip("MyAddon", 30300, "1.0.0"));

        let entry = ListEntry {
            name: Some("MyAddon".into()),
            url: "https://github.com/o/r".into(),
            ..ListEntry::default()
        };

        let (installed, outcome) = apply(&client, &mut store, &id, &entry, None, work.path())
            .await
            .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(outcome, Outcome::Installed);
        assert_eq!(installed.installed_ref, Ref::release("v1.0.0"));
        assert!(tmp.path().join("Interface/AddOns/MyAddon").is_dir());
    }
}
