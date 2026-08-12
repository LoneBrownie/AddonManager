//! Registering and managing servers.
//!
//! Adding a server is **always manual** — browse to a folder, pick the game
//! version from a dropdown, name it (V2-PLAN.md 5.3, D8). There is no drive
//! scanning and no version detection, because private-server clients are
//! extracted from a zip to arbitrary paths and defeat every heuristic worth
//! writing.
//!
//! Several servers on the same game version is the normal case here, not the
//! exception, so identity is the id plus the user's name — never the version.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::{GameVersion, Server, Store};
use crate::paths;

/// Executable names a WoW client might use, across retail-era, private-server
/// and Wine-repacked installs.
const WOW_EXECUTABLES: &[&str] = &[
    "wow.exe",
    "world of warcraft.exe",
    "wowclassic.exe",
    "run-wow.sh",
];

/// Whether a server's files are reachable right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Path resolves and the AddOns directory can be written.
    Ready,
    /// Path resolves but the AddOns directory is not writable.
    ReadOnly,
    /// Path does not resolve — an unplugged drive, typically.
    ///
    /// This is "cannot check right now", never "the user deleted their
    /// addons" (V2-PLAN.md B8).
    Unavailable,
}

impl Availability {
    pub fn can_install(self) -> bool {
        matches!(self, Availability::Ready)
    }
}

/// How confident we are that a folder is a WoW installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathVerdict {
    /// A client executable was found.
    Confident,
    /// No executable, but the directory shape looks right.
    Plausible { reason: String },
    /// Nothing suggests this is a game folder.
    Rejected { reason: String },
}

/// Inspect a candidate folder without registering it.
///
/// Drives the "Browse…" step: the user picks a folder and sees immediately
/// whether it looks right, before naming it.
pub fn inspect_path(path: &Path) -> PathVerdict {
    if !path.is_dir() {
        return PathVerdict::Rejected {
            reason: format!("{} is not a folder", path.display()),
        };
    }

    if has_client_executable(path) {
        return PathVerdict::Confident;
    }

    let has_data = child_exists_ignoring_case(path, "Data");
    let has_interface = child_exists_ignoring_case(path, "Interface");
    let has_wtf = child_exists_ignoring_case(path, "WTF");

    if has_data || has_interface || has_wtf {
        return PathVerdict::Plausible {
            reason: "no client executable found, but the folder layout matches a WoW install"
                .to_string(),
        };
    }

    PathVerdict::Rejected {
        reason: "no WoW executable, and no Data, Interface or WTF folder — \
                 pick the folder that contains the game executable"
            .to_string(),
    }
}

fn has_client_executable(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        WOW_EXECUTABLES.contains(&name.as_str())
    })
}

fn child_exists_ignoring_case(parent: &Path, wanted: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_string_lossy()
            .eq_ignore_ascii_case(wanted)
    })
}

/// Options for [`add`].
#[derive(Debug, Clone, Default)]
pub struct AddOptions {
    /// Register even though [`inspect_path`] rejected the folder.
    ///
    /// Private-server repacks are unpredictable, so the user always gets the
    /// last word — but they have to say so explicitly.
    pub force: bool,
}

/// Register a server.
///
/// Rejects a folder that is already registered, since two entries pointing at
/// one AddOns directory would let the same addon be "installed twice" and
/// fight over the same folders.
/// Point an existing server at a different folder.
///
/// For a game that moved or a drive that changed letter. The server keeps its
/// id, name, colour and — the point of the exercise — every addon recorded
/// against it, so this is not "forget and re-add".
///
/// Validated exactly as adding is: a folder that does not look like a game
/// directory is refused unless forced, and a folder already registered to
/// another server is refused outright, since two servers sharing one
/// `Interface/AddOns` would each claim the other's addons.
pub fn repoint(
    store: &mut Store,
    server_id: &str,
    path: &Path,
    options: &AddOptions,
) -> Result<Server> {
    if !store.servers.iter().any(|s| s.id == server_id) {
        return Err(Error::UnknownServer(server_id.to_string()));
    }

    if !options.force {
        if let PathVerdict::Rejected { .. } = inspect_path(path) {
            return Err(Error::NotAWowDirectory {
                path: path.to_path_buf(),
                reason: "no WoW executable or recognisable game folders found",
            });
        }
    }

    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let taken = store.servers.iter().any(|existing| {
        existing.id != server_id
            && existing
                .path
                .canonicalize()
                .unwrap_or_else(|_| existing.path.clone())
                == canonical
    });
    if taken {
        return Err(Error::NotAWowDirectory {
            path: path.to_path_buf(),
            reason: "another server already points at this folder",
        });
    }

    let server = store
        .servers
        .iter_mut()
        .find(|s| s.id == server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?;
    server.path = canonical;
    Ok(server.clone())
}

pub fn add(
    store: &mut Store,
    name: &str,
    path: &Path,
    version: GameVersion,
    options: &AddOptions,
) -> Result<Server> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Error::NotAWowDirectory {
            path: path.to_path_buf(),
            reason: "a server needs a name",
        });
    }

    if !options.force {
        if let PathVerdict::Rejected { .. } = inspect_path(path) {
            return Err(Error::NotAWowDirectory {
                path: path.to_path_buf(),
                reason: "no WoW executable or recognisable game folders found",
            });
        }
    }

    // Compare canonically so `D:\Games\WoW` and `D:\Games\..\Games\WoW` are
    // recognised as the same folder.
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let duplicate = store.servers.iter().any(|existing| {
        existing
            .path
            .canonicalize()
            .unwrap_or_else(|_| existing.path.clone())
            == canonical
    });
    if duplicate {
        return Err(Error::NotAWowDirectory {
            path: path.to_path_buf(),
            reason: "this folder is already registered as a server",
        });
    }

    let server = Server::new(name, canonical, version);
    store.servers.push(server.clone());
    Ok(server)
}

/// Report a server's current availability.
pub fn availability(server: &Server) -> Availability {
    if !server.is_available() {
        return Availability::Unavailable;
    }
    let addons = server.addons_dir();
    if std::fs::create_dir_all(&addons).is_err() {
        return Availability::ReadOnly;
    }
    if probe_writable(&addons) {
        Availability::Ready
    } else {
        Availability::ReadOnly
    }
}

fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".bam-write-test-{}", uuid::Uuid::new_v4().simple()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// A server plus everything the switcher needs to render one row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerSummary {
    pub server: Server,
    pub availability: Availability,
    pub addon_count: usize,
    /// Shown beneath the name, because two folders both called "WoW" are
    /// otherwise indistinguishable.
    pub path_display: String,
}

/// Everything the switcher needs, in display order.
///
/// Sorted by name so the list is stable between launches.
pub fn summaries(store: &Store) -> Vec<ServerSummary> {
    let mut rows: Vec<ServerSummary> = store
        .servers
        .iter()
        .map(|server| ServerSummary {
            availability: availability(server),
            addon_count: store.installed_for(&server.id).len(),
            path_display: server.path.display().to_string(),
            server: server.clone(),
        })
        .collect();
    rows.sort_by(|a, b| {
        a.server
            .name
            .to_lowercase()
            .cmp(&b.server.name.to_lowercase())
    });
    rows
}

/// Rename a server.
pub fn rename(store: &mut Store, server_id: &str, new_name: &str) -> Result<()> {
    let new_name = new_name.trim();
    if new_name.is_empty() {
        return Err(Error::UnknownServer("a server needs a name".to_string()));
    }
    let server = store
        .servers
        .iter_mut()
        .find(|s| s.id == server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?;
    server.name = new_name.to_string();
    Ok(())
}

/// Set the accent colour used in the switcher.
pub fn set_accent(store: &mut Store, server_id: &str, accent: Option<String>) -> Result<()> {
    let server = store
        .servers
        .iter_mut()
        .find(|s| s.id == server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?;
    server.accent = accent;
    Ok(())
}

/// Change a server's game version.
pub fn set_version(store: &mut Store, server_id: &str, version: GameVersion) -> Result<()> {
    let server = store
        .servers
        .iter_mut()
        .find(|s| s.id == server_id)
        .ok_or_else(|| Error::UnknownServer(server_id.to_string()))?;
    server.version = version;
    Ok(())
}

/// Forget a server. Files on disk are left alone.
///
/// Deregistering is not uninstalling: the user may simply want the app to stop
/// tracking a folder. Removing the addons too would be a surprise.
pub fn forget(store: &mut Store, server_id: &str) -> Result<()> {
    if store.server(server_id).is_none() {
        return Err(Error::UnknownServer(server_id.to_string()));
    }
    store.remove_server(server_id);
    Ok(())
}

/// Resolve the AddOns directory for a server, creating it if needed.
pub fn ensure_addons_dir(server: &Server) -> Result<PathBuf> {
    if !server.is_available() {
        return Err(Error::ServerUnavailable {
            name: server.name.clone(),
            path: server.path.clone(),
        });
    }
    let dir = paths::resolve_addons_dir(&server.path);
    std::fs::create_dir_all(&dir).map_err(|e| Error::io(&dir, e))?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::fake_wow_dir;

    fn temp_wow() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        fake_wow_dir(tmp.path()).unwrap_or_else(|e| panic!("{e}"));
        tmp
    }

    #[test]
    fn recognises_a_folder_with_a_client_executable() {
        let tmp = temp_wow();
        assert_eq!(inspect_path(tmp.path()), PathVerdict::Confident);
    }

    #[test]
    fn accepts_a_folder_that_merely_looks_right() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(tmp.path().join("Interface")).unwrap_or_else(|e| panic!("{e}"));
        assert!(matches!(
            inspect_path(tmp.path()),
            PathVerdict::Plausible { .. }
        ));
    }

    #[test]
    fn rejects_an_unrelated_folder() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(tmp.path().join("holiday.jpg"), b"x").unwrap_or_else(|e| panic!("{e}"));
        assert!(matches!(
            inspect_path(tmp.path()),
            PathVerdict::Rejected { .. }
        ));
    }

    #[test]
    fn rejects_a_path_that_is_not_a_folder() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = tmp.path().join("file.txt");
        std::fs::write(&file, b"x").unwrap_or_else(|e| panic!("{e}"));
        assert!(matches!(inspect_path(&file), PathVerdict::Rejected { .. }));
    }

    #[test]
    fn adds_a_server() {
        let tmp = temp_wow();
        let mut store = Store::default();
        let server = add(
            &mut store,
            "Epoch",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(server.name, "Epoch");
        assert_eq!(server.version, GameVersion::Wotlk);
        assert_eq!(store.servers.len(), 1);
    }

    #[test]
    fn trims_the_name_and_rejects_an_empty_one() {
        let tmp = temp_wow();
        let mut store = Store::default();

        let server = add(
            &mut store,
            "  Epoch  ",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(server.name, "Epoch");

        let empty = add(
            &mut store,
            "   ",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        );
        assert!(empty.is_err());
    }

    #[test]
    fn refuses_an_unrecognisable_folder_unless_forced() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let mut store = Store::default();

        assert!(add(
            &mut store,
            "Weird",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default()
        )
        .is_err());

        // Private-server repacks are unpredictable, so the user gets the last
        // word — explicitly.
        assert!(add(
            &mut store,
            "Weird",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions { force: true }
        )
        .is_ok());
    }

    #[test]
    fn refuses_to_register_the_same_folder_twice() {
        let tmp = temp_wow();
        let mut store = Store::default();
        add(
            &mut store,
            "Epoch",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        let again = add(
            &mut store,
            "Epoch again",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        );
        assert!(again.is_err(), "one folder must not become two servers");
    }

    /// Several servers on one game version is the normal case for this
    /// audience — three 3.3.5a folders for three different private servers.
    #[test]
    fn allows_many_servers_on_the_same_game_version() {
        let first = temp_wow();
        let second = temp_wow();
        let mut store = Store::default();

        add(
            &mut store,
            "Epoch",
            first.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        add(
            &mut store,
            "Warmane",
            second.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(store.servers.len(), 2);
        assert_ne!(
            store.servers.first().map(|s| &s.id),
            store.servers.get(1).map(|s| &s.id)
        );
    }

    #[test]
    fn reports_ready_for_a_writable_server() {
        let tmp = temp_wow();
        let server = Server::new("Epoch", tmp.path(), GameVersion::Wotlk);
        assert_eq!(availability(&server), Availability::Ready);
        assert!(availability(&server).can_install());
    }

    /// V2-PLAN.md B8: unreachable means unreachable, not deleted.
    #[test]
    fn reports_unavailable_for_a_missing_path() {
        let server = Server::new("Offline", "/definitely/not/mounted", GameVersion::Wotlk);
        assert_eq!(availability(&server), Availability::Unavailable);
        assert!(!availability(&server).can_install());
    }

    #[test]
    fn summaries_are_sorted_and_carry_counts() {
        let first = temp_wow();
        let second = temp_wow();
        let mut store = Store::default();
        add(
            &mut store,
            "Zeta",
            first.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        add(
            &mut store,
            "Alpha",
            second.path(),
            GameVersion::Tbc,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        let rows = summaries(&store);
        assert_eq!(
            rows.iter()
                .map(|r| r.server.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Alpha", "Zeta"]
        );
        assert!(rows.iter().all(|r| r.addon_count == 0));
        assert!(rows.iter().all(|r| !r.path_display.is_empty()));
    }

    #[test]
    fn renames_and_recolours() {
        let tmp = temp_wow();
        let mut store = Store::default();
        let server = add(
            &mut store,
            "Old",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        rename(&mut store, &server.id, "New").unwrap_or_else(|e| panic!("{e}"));
        set_accent(&mut store, &server.id, Some("#c8a15a".into()))
            .unwrap_or_else(|e| panic!("{e}"));
        set_version(&mut store, &server.id, GameVersion::Tbc).unwrap_or_else(|e| panic!("{e}"));

        let updated = store.server(&server.id).cloned().unwrap_or_else(|| {
            panic!("server should still exist");
        });
        assert_eq!(updated.name, "New");
        assert_eq!(updated.accent.as_deref(), Some("#c8a15a"));
        assert_eq!(updated.version, GameVersion::Tbc);
    }

    #[test]
    fn rejects_an_empty_rename() {
        let tmp = temp_wow();
        let mut store = Store::default();
        let server = add(
            &mut store,
            "Epoch",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert!(rename(&mut store, &server.id, "  ").is_err());
    }

    #[test]
    fn operations_on_an_unknown_server_error() {
        let mut store = Store::default();
        assert!(rename(&mut store, "nope", "x").is_err());
        assert!(set_accent(&mut store, "nope", None).is_err());
        assert!(forget(&mut store, "nope").is_err());
    }

    /// Deregistering is not uninstalling.
    #[test]
    fn forgetting_a_server_leaves_the_files_alone() {
        let tmp = temp_wow();
        let addon_dir = tmp.path().join("Interface").join("AddOns").join("MyAddon");
        std::fs::create_dir_all(&addon_dir).unwrap_or_else(|e| panic!("{e}"));

        let mut store = Store::default();
        let server = add(
            &mut store,
            "Epoch",
            tmp.path(),
            GameVersion::Wotlk,
            &AddOptions::default(),
        )
        .unwrap_or_else(|e| panic!("{e}"));

        forget(&mut store, &server.id).unwrap_or_else(|e| panic!("{e}"));

        assert!(store.servers.is_empty());
        assert!(addon_dir.is_dir(), "files on disk must survive");
    }
}

#[cfg(test)]
mod repoint_tests {
    use super::*;
    use crate::model::{Addon, InstalledAddon, Source, Store};
    use crate::testing::fake_wow_dir;
    use crate::version::Ref;

    fn store_with_server(path: &Path) -> (Store, String) {
        let mut store = Store::default();
        let server = Server::new("Epoch", path, GameVersion::Wotlk);
        let id = server.id.clone();
        store.servers.push(server);
        store.addons.push(Addon::new(
            Source::Github {
                owner: "o".into(),
                repo: "r".into(),
            },
            "R",
        ));
        store.installed.push(InstalledAddon {
            server_id: id.clone(),
            addon_id: "github:o/r".into(),
            channel: crate::model::Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1"),
            archive_sha256: None,
            installed_at: String::new(),
            folders: vec!["R".into()],
            version_matches: true,
        });
        (store, id)
    }

    /// The whole point: a moved game keeps its addons. Forgetting and re-adding
    /// would lose every record of what is installed.
    #[test]
    fn repointing_keeps_the_servers_identity_and_its_addons() {
        let old = tempfile::tempdir().unwrap();
        let new = tempfile::tempdir().unwrap();
        fake_wow_dir(old.path()).unwrap();
        fake_wow_dir(new.path()).unwrap();

        let (mut store, id) = store_with_server(old.path());
        let moved = repoint(&mut store, &id, new.path(), &AddOptions::default()).unwrap();

        assert_eq!(moved.id, id, "the id is stable");
        assert_eq!(moved.name, "Epoch");
        assert_eq!(store.installed_for(&id).len(), 1, "addons come with it");
        assert!(store.server(&id).unwrap().is_available());
    }

    #[test]
    fn repointing_at_a_folder_another_server_uses_is_refused() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fake_wow_dir(a.path()).unwrap();
        fake_wow_dir(b.path()).unwrap();

        let (mut store, id) = store_with_server(a.path());
        let other = Server::new("Other", b.path(), GameVersion::Wotlk);
        store.servers.push(other);

        // Two servers sharing one AddOns folder would each claim the other's
        // addons, so this is refused rather than merged.
        assert!(repoint(&mut store, &id, b.path(), &AddOptions::default()).is_err());
    }

    #[test]
    fn a_folder_that_is_not_a_game_directory_is_refused_unless_forced() {
        let old = tempfile::tempdir().unwrap();
        let empty = tempfile::tempdir().unwrap();
        fake_wow_dir(old.path()).unwrap();

        let (mut store, id) = store_with_server(old.path());
        assert!(repoint(&mut store, &id, empty.path(), &AddOptions::default()).is_err());
        assert!(repoint(&mut store, &id, empty.path(), &AddOptions { force: true }).is_ok());
    }
}
