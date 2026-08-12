//! Deciding what an install *would* do, before it does any of it.
//!
//! Split from the orchestration on purpose. Every rule that can refuse an
//! install lives here and is answerable without a network, a download or a
//! single byte written — which is what lets the interface show a user the
//! consequence of an action before they take it, and what makes the rules
//! testable as rules rather than as side effects of a full install.

use std::path::Path;

use crate::error::{Error, Result};
use crate::model::{Server, Store};

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

/// A server's path being unreachable means "cannot check right now".
///
/// It must never be read as "the user deleted their addons" — that is exactly
/// the mistake that made V1's B8 destroy records when a drive was unplugged.
pub(crate) fn ensure_available(server: &Server) -> Result<()> {
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
pub(crate) fn ensure_writable(dir: &Path) -> Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Channel, GameVersion, InstalledAddon, Server};
    use crate::version::Ref;

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
            version_matches: true,
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
            version_matches: true,
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
            version_matches: true,
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
}
