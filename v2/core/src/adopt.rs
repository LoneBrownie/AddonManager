//! Adopting addon folders that are already on disk.
//!
//! Someone switching to this app has a full `Interface/AddOns` directory they
//! did not install through it. V1 called this "Import Existing Addons" and it
//! is the main reason dropping V1 migration (D10) costs users so little: point
//! V2 at the same folder and adopt what is there.
//!
//! Unlike V1, this does **not** guess which folders belong together. V1 ran
//! ~200 lines of name heuristics for that (V2-PLAN.md D-b); here, grouping is
//! offered as a suggestion the user confirms, and once adopted the folder list
//! is recorded so the guessing never has to happen again.

use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{Addon, Channel, InstalledAddon, Server, Source, Store};
use crate::sources;
use crate::toc::{self, TocData};
use crate::version::Ref;

/// An addon folder found on disk that this app does not manage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundAddon {
    pub folder: String,
    /// Parsed from the folder's `.toc`.
    pub toc: TocData,
    /// A repository URL found in the `.toc` metadata, if the author left one.
    pub suggested_url: Option<String>,
    /// Sibling folders that look like components of the same addon
    /// (`WeakAuras` and `WeakAuras_Options`). A suggestion, never applied
    /// automatically.
    pub related: Vec<String>,
    /// False when the addon declares an interface version this server is not.
    pub version_matches: bool,
}

/// Scan a server's AddOns directory for folders this app does not manage.
///
/// Blizzard's own addons are skipped — they ship with the client and are not
/// something anyone manages here.
pub fn scan(store: &Store, server: &Server) -> Result<Vec<FoundAddon>> {
    if !server.is_available() {
        return Err(Error::ServerUnavailable {
            name: server.name.clone(),
            path: server.path.clone(),
        });
    }

    let addons_dir = server.addons_dir();
    let Ok(entries) = std::fs::read_dir(&addons_dir) else {
        return Ok(Vec::new());
    };

    // Every folder with a .toc, minus the ones we already own.
    let mut candidates: Vec<(String, TocData)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().into_owned();

        if folder.starts_with("Blizzard_") || crate::paths::is_junk_component(&folder) {
            continue;
        }
        if store.folder_owner(&server.id, &folder).is_some() {
            continue;
        }

        let Some(toc) = read_toc(&addons_dir.join(&folder), &folder) else {
            continue;
        };
        candidates.push((folder, toc));
    }

    let all_names: Vec<String> = candidates.iter().map(|(name, _)| name.clone()).collect();

    let mut found: Vec<FoundAddon> = candidates
        .into_iter()
        .map(|(folder, toc)| FoundAddon {
            suggested_url: suggest_url(&toc),
            related: siblings_of(&folder, &all_names),
            version_matches: toc.supports(server.version),
            folder,
            toc,
        })
        .collect();

    found.sort_by_key(|item| item.folder.to_lowercase());
    Ok(found)
}

/// Read the best `.toc` in a folder.
fn read_toc(dir: &Path, folder: &str) -> Option<TocData> {
    let names = crate::archive::toc_file_names(dir);
    if names.is_empty() {
        return None;
    }
    // Prefer the one matching the folder name, as WoW itself does.
    let chosen = names
        .iter()
        .find(|name| {
            toc::parse_toc_filename(name)
                .map(|(base, _)| base.eq_ignore_ascii_case(folder))
                .unwrap_or(false)
        })
        .or_else(|| names.first())?;

    let contents = std::fs::read_to_string(dir.join(chosen)).ok()?;
    Some(toc::parse(&contents))
}

/// Pull a repository URL out of `.toc` metadata.
///
/// Many addon authors record one in `X-Repository` or `X-Website`, which turns
/// adoption into one click instead of a search.
fn suggest_url(toc: &TocData) -> Option<String> {
    [&toc.repository, &toc.website]
        .into_iter()
        .flatten()
        .flat_map(|value| value.split_whitespace())
        .find_map(|token| sources::parse_repo_url(token).ok())
        .map(|source| source.web_url())
}

/// Folders that look like components of the same addon.
///
/// Only the unambiguous case: `Name` plus `Name_Something` or `Name-Something`.
/// V1 also tried common-prefix and word-overlap scoring, which produced false
/// groupings; a suggestion that is wrong is worse than one that is absent,
/// because the user is the one who has to notice.
fn siblings_of(folder: &str, all: &[String]) -> Vec<String> {
    let lower = folder.to_lowercase();
    let mut related: Vec<String> = all
        .iter()
        .filter(|other| {
            let other_lower = other.to_lowercase();
            other_lower != lower
                && (other_lower.starts_with(&format!("{lower}_"))
                    || other_lower.starts_with(&format!("{lower}-")))
        })
        .cloned()
        .collect();
    related.sort();
    related
}

/// Adopt folders already on disk as a managed addon.
///
/// The recorded ref is deliberately the branch-style placeholder `adopted`:
/// we genuinely do not know which upstream version these files came from, and
/// inventing a tag would make the first update check compare a fiction against
/// a real release. The next update installs a known version and replaces it.
pub fn adopt(
    store: &mut Store,
    server_id: &str,
    folders: Vec<String>,
    repo_url: &str,
    display_name: Option<String>,
    channel: Channel,
) -> Result<InstalledAddon> {
    if folders.is_empty() {
        return Err(Error::NoAddonFolders);
    }

    let server = store
        .server(server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?
        .clone();
    let source: Source = sources::parse_repo_url(repo_url)?;
    let addon_id = source.id();

    // Adoption must not steal a folder from another managed addon.
    for folder in &folders {
        crate::paths::validate_component(folder)?;
        if let Some(owner) = store.folder_owner(server_id, folder) {
            if owner.addon_id != addon_id {
                return Err(Error::ManagedCollision {
                    folder: folder.clone(),
                    owner: owner.addon_id.clone(),
                });
            }
        }
        if !server.addons_dir().join(folder).is_dir() {
            return Err(Error::NoAddonFolders);
        }
    }

    let name = display_name
        .or_else(|| source.repo_name().map(str::to_string))
        .unwrap_or_else(|| addon_id.clone());

    if store.addon(&addon_id).is_none() {
        store.addons.push(Addon::new(source, name));
    }

    let installation = InstalledAddon {
        server_id: server_id.to_string(),
        addon_id,
        channel,
        pinned: false,
        installed_ref: Ref::branch("adopted", "adopted"),
        folders,
        archive_sha256: None,
        installed_at: String::new(),
    };
    store.upsert_installation(installation.clone());
    Ok(installation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::GameVersion;
    use crate::testing::fake_wow_dir;

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

    #[test]
    fn finds_unmanaged_folders() {
        let (_tmp, store, id) = server_with(&[("Questie", "## Interface: 30300\n")]);
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let found = scan(&store, &server).unwrap_or_default();
        assert_eq!(found.len(), 1);
        assert_eq!(found.first().map(|f| f.folder.as_str()), Some("Questie"));
    }

    #[test]
    fn skips_blizzard_addons() {
        let (_tmp, store, id) = server_with(&[
            ("Blizzard_AuctionUI", "## Interface: 30300\n"),
            ("Questie", "## Interface: 30300\n"),
        ]);
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let found = scan(&store, &server).unwrap_or_default();
        assert_eq!(
            found.len(),
            1,
            "Blizzard's own addons are not ours to manage"
        );
    }

    #[test]
    fn skips_folders_without_a_toc() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        fake_wow_dir(tmp.path()).unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(tmp.path().join("Interface/AddOns/NotAnAddon"))
            .unwrap_or_else(|e| panic!("{e}"));

        let mut store = Store::default();
        let server = Server::new("Epoch", tmp.path(), GameVersion::Wotlk);
        store.servers.push(server.clone());

        assert!(scan(&store, &server).unwrap_or_default().is_empty());
    }

    #[test]
    fn skips_folders_this_app_already_manages() {
        let (_tmp, mut store, id) = server_with(&[("Questie", "## Interface: 30300\n")]);
        store.upsert_installation(InstalledAddon {
            server_id: id.clone(),
            addon_id: "github:o/questie".into(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            folders: vec!["Questie".into()],
            archive_sha256: None,
            installed_at: "0".into(),
        });
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        assert!(scan(&store, &server).unwrap_or_default().is_empty());
    }

    #[test]
    fn suggests_a_repository_url_from_toc_metadata() {
        let (_tmp, store, id) = server_with(&[(
            "Questie",
            "## Interface: 30300\n## X-Repository: https://github.com/Questie/Questie\n",
        )]);
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let found = scan(&store, &server).unwrap_or_default();
        assert_eq!(
            found.first().and_then(|f| f.suggested_url.as_deref()),
            Some("https://github.com/Questie/Questie")
        );
    }

    #[test]
    fn suggests_unambiguous_sibling_folders_only() {
        let (_tmp, store, id) = server_with(&[
            ("WeakAuras", "## Interface: 30300\n"),
            ("WeakAuras_Options", "## Interface: 30300\n"),
            ("WeakAurasUnrelated", "## Interface: 30300\n"),
            ("Questie", "## Interface: 30300\n"),
        ]);
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let found = scan(&store, &server).unwrap_or_default();
        let weakauras = found
            .iter()
            .find(|f| f.folder == "WeakAuras")
            .unwrap_or_else(|| panic!("WeakAuras"));

        assert_eq!(
            weakauras.related,
            vec!["WeakAuras_Options".to_string()],
            "only the separator-delimited sibling, not every name-alike"
        );
    }

    #[test]
    fn flags_an_addon_built_for_a_different_game_version() {
        let (_tmp, store, id) = server_with(&[
            ("ForWrath", "## Interface: 30300\n"),
            ("ForVanilla", "## Interface: 11200\n"),
            ("Unstated", "## Title: No interface line\n"),
        ]);
        let server = store
            .server(&id)
            .cloned()
            .unwrap_or_else(|| panic!("server"));

        let found = scan(&store, &server).unwrap_or_default();
        let matches = |name: &str| {
            found
                .iter()
                .find(|f| f.folder == name)
                .map(|f| f.version_matches)
        };

        assert_eq!(matches("ForWrath"), Some(true));
        assert_eq!(matches("ForVanilla"), Some(false));
        assert_eq!(
            matches("Unstated"),
            Some(true),
            "an addon making no claim must not be flagged"
        );
    }

    #[test]
    fn adopting_records_the_folders_so_removal_is_exact() {
        let (_tmp, mut store, id) = server_with(&[
            ("WeakAuras", "## Interface: 30300\n"),
            ("WeakAuras_Options", "## Interface: 30300\n"),
        ]);

        let adopted = adopt(
            &mut store,
            &id,
            vec!["WeakAuras".into(), "WeakAuras_Options".into()],
            "https://github.com/WeakAuras/WeakAuras2",
            None,
            Channel::Release,
        )
        .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(adopted.folders.len(), 2);
        assert_eq!(store.installed_for(&id).len(), 1);
        assert_eq!(store.addons.len(), 1);
        assert!(store.folder_owner(&id, "WeakAuras_Options").is_some());
    }

    #[test]
    fn adopting_refuses_a_folder_owned_by_another_addon() {
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
        });

        let result = adopt(
            &mut store,
            &id,
            vec!["Questie".into()],
            "https://github.com/Questie/Questie",
            None,
            Channel::Release,
        );
        assert!(matches!(result, Err(Error::ManagedCollision { .. })));
    }

    #[test]
    fn adopting_a_folder_that_is_not_there_is_an_error() {
        let (_tmp, mut store, id) = server_with(&[]);
        let result = adopt(
            &mut store,
            &id,
            vec!["Ghost".into()],
            "https://github.com/o/r",
            None,
            Channel::Release,
        );
        assert!(result.is_err());
    }

    #[test]
    fn adopting_rejects_a_bad_repository_url() {
        let (_tmp, mut store, id) = server_with(&[("Questie", "## Interface: 30300\n")]);
        let result = adopt(
            &mut store,
            &id,
            vec!["Questie".into()],
            "not a url",
            None,
            Channel::Release,
        );
        assert!(matches!(result, Err(Error::UnsupportedRepoUrl(_))));
    }

    /// The adopted ref must not pretend to be a release. Comparing a made-up
    /// tag against a real one is exactly the phantom-update class the Ref model
    /// exists to prevent (V2-PLAN.md D-a).
    #[test]
    fn an_adopted_addon_reports_a_channel_change_rather_than_a_fake_update() {
        let (_tmp, mut store, id) = server_with(&[("Questie", "## Interface: 30300\n")]);
        let adopted = adopt(
            &mut store,
            &id,
            vec!["Questie".into()],
            "https://github.com/Questie/Questie",
            None,
            Channel::Release,
        )
        .unwrap_or_else(|e| panic!("{e}"));

        let status = crate::version::check(&adopted.installed_ref, &Ref::release("v11.3.0"));
        assert_eq!(status, crate::version::UpdateStatus::ChannelChanged);
    }
}
