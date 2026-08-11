//! The V2 data model.
//!
//! V1 conflated "the addon" with "an installation of the addon" in one flat
//! record tied to a single `wowPath`. V2 normalises that into three entities so
//! the same addon can live in several servers at different versions
//! (V2-PLAN.md 5.3).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::version::Ref;

/// Game versions this app supports. Retail is deliberately absent (D8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameVersion {
    Vanilla,
    Tbc,
    Wotlk,
}

impl GameVersion {
    pub const ALL: [GameVersion; 3] = [GameVersion::Vanilla, GameVersion::Tbc, GameVersion::Wotlk];

    /// The `## Interface` number addons declare for this version.
    ///
    /// A fixed lookup from the user's dropdown choice — nothing is detected
    /// from disk (D8, V2-PLAN.md 5.3).
    pub fn interface_version(self) -> u32 {
        match self {
            GameVersion::Vanilla => 11200,
            GameVersion::Tbc => 20400,
            GameVersion::Wotlk => 30300,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            GameVersion::Vanilla => "Vanilla 1.12",
            GameVersion::Tbc => "TBC 2.4.3",
            GameVersion::Wotlk => "WotLK 3.3.5a",
        }
    }
}

/// Which upstream artifact an addon tracks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// Tagged releases. The default, and what most users want.
    #[default]
    Release,
    /// Head of the default branch, for addons that never cut releases.
    Source,
}

/// Where an addon comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    Github {
        owner: String,
        repo: String,
    },
    Gitlab {
        owner: String,
        repo: String,
    },
    /// A direct link to a zip, for addons hosted outside either forge.
    Direct {
        url: String,
    },
}

impl Source {
    /// Stable identity for an addon, independent of where it is installed.
    pub fn id(&self) -> String {
        match self {
            Source::Github { owner, repo } => format!("github:{owner}/{repo}"),
            Source::Gitlab { owner, repo } => format!("gitlab:{owner}/{repo}"),
            Source::Direct { url } => format!("direct:{url}"),
        }
    }

    /// The repository name, used when picking a canonical folder name.
    pub fn repo_name(&self) -> Option<&str> {
        match self {
            Source::Github { repo, .. } | Source::Gitlab { repo, .. } => Some(repo),
            Source::Direct { .. } => None,
        }
    }

    pub fn web_url(&self) -> String {
        match self {
            Source::Github { owner, repo } => format!("https://github.com/{owner}/{repo}"),
            Source::Gitlab { owner, repo } => format!("https://gitlab.com/{owner}/{repo}"),
            Source::Direct { url } => url.clone(),
        }
    }
}

/// A registered game folder. Always added manually (D3, V2-PLAN.md 5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    pub id: String,
    /// User-supplied label. Typically the server's name: "Epoch", "Warmane".
    pub name: String,
    /// The WoW root, not the AddOns directory.
    pub path: PathBuf,
    /// Chosen from a dropdown at add time. Never detected.
    pub version: GameVersion,
    /// Accent colour for the switcher, so two folders both called "WoW" are
    /// still distinguishable at a glance.
    #[serde(default)]
    pub accent: Option<String>,
}

impl Server {
    pub fn new(name: impl Into<String>, path: impl Into<PathBuf>, version: GameVersion) -> Self {
        Server {
            id: format!("srv_{}", uuid::Uuid::new_v4().simple()),
            name: name.into(),
            path: path.into(),
            version,
            accent: None,
        }
    }

    /// Resolve `Interface/AddOns`, matching whatever casing is on disk.
    pub fn addons_dir(&self) -> PathBuf {
        crate::paths::resolve_addons_dir(&self.path)
    }

    /// False when the path is not reachable — an unplugged drive, typically.
    ///
    /// Callers must treat this as "cannot check right now", never as "the user
    /// deleted their addons" (V2-PLAN.md B8).
    pub fn is_available(&self) -> bool {
        self.path.is_dir()
    }
}

/// An addon as an upstream thing, independent of where it is installed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Addon {
    /// Derived from the source; stable across reinstalls.
    pub id: String,
    pub source: Source,
    pub display_name: String,
    /// Cached resolution, so an update check can send a conditional request.
    #[serde(default)]
    pub cached_etag: Option<String>,
}

impl Addon {
    pub fn new(source: Source, display_name: impl Into<String>) -> Self {
        Addon {
            id: source.id(),
            source,
            display_name: display_name.into(),
            cached_etag: None,
        }
    }
}

/// The join between an addon and a server. One row per pair.
///
/// This is what makes "the same addon in two servers at different versions"
/// expressible, and what lets uninstall remove exactly the folders we wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstalledAddon {
    pub server_id: String,
    pub addon_id: String,
    #[serde(default)]
    pub channel: Channel,
    /// User has pinned this addon; skip it during update checks.
    #[serde(default)]
    pub pinned: bool,
    /// Exactly what we installed. Recording this is what removes V1's
    /// ~200 lines of folder-relatedness guessing (V2-PLAN.md D-b).
    pub installed_ref: Ref,
    /// Every folder this install wrote, so removal is exact.
    pub folders: Vec<String>,
    pub archive_sha256: Option<String>,
    pub installed_at: String,
}

/// Everything persisted to disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Store {
    pub schema_version: u32,
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub addons: Vec<Addon>,
    #[serde(default)]
    pub installed: Vec<InstalledAddon>,
}

pub const SCHEMA_VERSION: u32 = 2;

impl Default for Store {
    fn default() -> Self {
        Store {
            schema_version: SCHEMA_VERSION,
            servers: Vec::new(),
            addons: Vec::new(),
            installed: Vec::new(),
        }
    }
}

impl Store {
    pub fn server(&self, server_id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == server_id)
    }

    pub fn addon(&self, addon_id: &str) -> Option<&Addon> {
        self.addons.iter().find(|a| a.id == addon_id)
    }

    /// Everything installed to one server. This is what the UI list shows when
    /// that server is selected in the switcher.
    pub fn installed_for(&self, server_id: &str) -> Vec<&InstalledAddon> {
        self.installed
            .iter()
            .filter(|i| i.server_id == server_id)
            .collect()
    }

    pub fn installation(&self, server_id: &str, addon_id: &str) -> Option<&InstalledAddon> {
        self.installed
            .iter()
            .find(|i| i.server_id == server_id && i.addon_id == addon_id)
    }

    /// Which addon, if any, owns `folder` on this server.
    ///
    /// Drives the collision check that replaces V1's blind delete
    /// (V2-PLAN.md B2, D11).
    pub fn folder_owner(&self, server_id: &str, folder: &str) -> Option<&InstalledAddon> {
        self.installed.iter().find(|i| {
            i.server_id == server_id && i.folders.iter().any(|f| f.eq_ignore_ascii_case(folder))
        })
    }

    /// Remove a server and everything recorded against it.
    pub fn remove_server(&mut self, server_id: &str) {
        self.servers.retain(|s| s.id != server_id);
        self.installed.retain(|i| i.server_id != server_id);
        self.prune_orphan_addons();
    }

    /// Drop addon records no longer installed anywhere.
    pub fn prune_orphan_addons(&mut self) {
        self.addons
            .retain(|a| self.installed.iter().any(|i| i.addon_id == a.id));
    }

    /// Insert or replace an installation row.
    pub fn upsert_installation(&mut self, installation: InstalledAddon) {
        if let Some(existing) = self
            .installed
            .iter_mut()
            .find(|i| i.server_id == installation.server_id && i.addon_id == installation.addon_id)
        {
            *existing = installation;
        } else {
            self.installed.push(installation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wotlk_server() -> Server {
        Server::new("Epoch", "/games/epoch", GameVersion::Wotlk)
    }

    #[test]
    fn interface_versions_are_fixed_lookups() {
        assert_eq!(GameVersion::Vanilla.interface_version(), 11200);
        assert_eq!(GameVersion::Tbc.interface_version(), 20400);
        assert_eq!(GameVersion::Wotlk.interface_version(), 30300);
    }

    #[test]
    fn source_ids_are_stable_and_distinct() {
        let a = Source::Github {
            owner: "o".into(),
            repo: "r".into(),
        };
        let b = Source::Gitlab {
            owner: "o".into(),
            repo: "r".into(),
        };
        assert_eq!(a.id(), "github:o/r");
        assert_ne!(a.id(), b.id(), "same owner/repo on different forges differ");
    }

    #[test]
    fn servers_get_unique_ids() {
        let a = wotlk_server();
        let b = wotlk_server();
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn installed_for_scopes_to_one_server() {
        let mut store = Store::default();
        let s1 = wotlk_server();
        let s2 = Server::new("Warmane", "/games/warmane", GameVersion::Wotlk);

        store.installed.push(sample_install(&s1.id, "github:o/r"));
        store.installed.push(sample_install(&s2.id, "github:o/r"));
        store.servers.push(s1.clone());
        store.servers.push(s2);

        assert_eq!(store.installed_for(&s1.id).len(), 1);
    }

    #[test]
    fn the_same_addon_can_sit_in_two_servers() {
        let mut store = Store::default();
        let s1 = wotlk_server();
        let s2 = Server::new("Warmane", "/games/warmane", GameVersion::Wotlk);

        let mut a = sample_install(&s1.id, "github:o/r");
        a.installed_ref = Ref::release("v1.0.0");
        let mut b = sample_install(&s2.id, "github:o/r");
        b.installed_ref = Ref::release("v2.0.0");
        b.pinned = true;

        store.upsert_installation(a);
        store.upsert_installation(b);

        assert_eq!(store.installed.len(), 2, "one row per (addon, server)");
        let first = store.installation(&s1.id, "github:o/r");
        let second = store.installation(&s2.id, "github:o/r");
        assert_eq!(
            first.map(|i| i.installed_ref.clone()),
            Some(Ref::release("v1.0.0"))
        );
        assert_eq!(second.map(|i| i.pinned), Some(true));
    }

    #[test]
    fn upsert_replaces_rather_than_duplicating() {
        let mut store = Store::default();
        let server = wotlk_server();
        store.upsert_installation(sample_install(&server.id, "github:o/r"));
        store.upsert_installation(sample_install(&server.id, "github:o/r"));
        assert_eq!(store.installed.len(), 1);
    }

    #[test]
    fn folder_owner_is_case_insensitive() {
        let mut store = Store::default();
        let server = wotlk_server();
        let mut install = sample_install(&server.id, "github:o/r");
        install.folders = vec!["WeakAuras".into()];
        store.upsert_installation(install);

        assert!(store.folder_owner(&server.id, "weakauras").is_some());
        assert!(store.folder_owner(&server.id, "Something").is_none());
        assert!(
            store.folder_owner("other-server", "WeakAuras").is_none(),
            "ownership does not leak between servers"
        );
    }

    #[test]
    fn removing_a_server_removes_only_its_rows() {
        let mut store = Store::default();
        let s1 = wotlk_server();
        let s2 = Server::new("Warmane", "/games/warmane", GameVersion::Wotlk);
        store.servers.push(s1.clone());
        store.servers.push(s2.clone());
        store.addons.push(Addon::new(
            Source::Github {
                owner: "o".into(),
                repo: "r".into(),
            },
            "R",
        ));
        store.upsert_installation(sample_install(&s1.id, "github:o/r"));
        store.upsert_installation(sample_install(&s2.id, "github:o/r"));

        store.remove_server(&s1.id);

        assert_eq!(store.servers.len(), 1);
        assert_eq!(store.installed.len(), 1);
        assert_eq!(store.addons.len(), 1, "still installed elsewhere");

        store.remove_server(&s2.id);
        assert!(store.addons.is_empty(), "orphan addon pruned");
    }

    fn sample_install(server_id: &str, addon_id: &str) -> InstalledAddon {
        InstalledAddon {
            server_id: server_id.to_string(),
            addon_id: addon_id.to_string(),
            channel: Channel::Release,
            pinned: false,
            installed_ref: Ref::release("v1.0.0"),
            folders: vec!["Addon".into()],
            archive_sha256: None,
            installed_at: "2026-01-01T00:00:00Z".into(),
        }
    }
}
