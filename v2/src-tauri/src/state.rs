//! Application state: the store, the HTTP client, and where scratch files go.

use std::path::PathBuf;
use std::sync::Mutex;

use bam_core::error::{Error, Result};
use bam_core::http::HttpClient;
use bam_core::model::Store;
use bam_core::store::StoreFile;

/// User preferences that are not part of the addon graph.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Optional GitHub token (D6). Lifts the anonymous 60 requests/hour limit
    /// to 5,000. Never required, and never logged.
    #[serde(default)]
    pub github_token: Option<String>,
    /// Which server the switcher had selected last.
    #[serde(default)]
    pub selected_server_id: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
}

pub struct AppState {
    store_file: StoreFile,
    prefs_path: PathBuf,
    store: Mutex<Store>,
    prefs: Mutex<Preferences>,
    pub client: Box<dyn HttpClient>,
    pub work_dir: PathBuf,
}

impl AppState {
    pub fn new(data_dir: PathBuf, client: Box<dyn HttpClient>) -> Result<Self> {
        std::fs::create_dir_all(&data_dir).map_err(|e| Error::io(&data_dir, e))?;

        let store_file = StoreFile::new(data_dir.join("store.json"));
        let store = store_file.load()?;

        let prefs_path = data_dir.join("preferences.json");
        let prefs = std::fs::read(&prefs_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();

        let work_dir = data_dir.join("work");
        std::fs::create_dir_all(&work_dir).map_err(|e| Error::io(&work_dir, e))?;
        // Clear anything a previous run left behind after a crash.
        if let Ok(entries) = std::fs::read_dir(&work_dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }

        Ok(AppState {
            store_file,
            prefs_path,
            store: Mutex::new(store),
            prefs: Mutex::new(prefs),
            client,
            work_dir,
        })
    }

    /// Read the store.
    pub fn with_store<T>(&self, f: impl FnOnce(&Store) -> T) -> Result<T> {
        let guard = self
            .store
            .lock()
            .map_err(|_| Error::Network("store lock poisoned".into()))?;
        Ok(f(&guard))
    }

    /// Mutate the store and persist the result atomically.
    ///
    /// Saving inside the lock means a failed write cannot leave memory and disk
    /// disagreeing about what is installed.
    pub fn mutate_store<T>(&self, f: impl FnOnce(&mut Store) -> Result<T>) -> Result<T> {
        let mut guard = self
            .store
            .lock()
            .map_err(|_| Error::Network("store lock poisoned".into()))?;
        let outcome = f(&mut guard)?;
        self.store_file.save(&guard)?;
        Ok(outcome)
    }

    /// Take a snapshot to hand to an async operation, which must not hold the
    /// lock across an await point.
    pub fn snapshot(&self) -> Result<Store> {
        self.with_store(|store| store.clone())
    }

    /// Replace the store wholesale after an async operation completes.
    pub fn commit(&self, next: Store) -> Result<()> {
        self.mutate_store(|store| {
            *store = next;
            Ok(())
        })
    }

    pub fn prefs(&self) -> Result<Preferences> {
        let guard = self
            .prefs
            .lock()
            .map_err(|_| Error::Network("prefs lock poisoned".into()))?;
        Ok(guard.clone())
    }

    pub fn set_prefs(&self, next: Preferences) -> Result<()> {
        let mut guard = self
            .prefs
            .lock()
            .map_err(|_| Error::Network("prefs lock poisoned".into()))?;
        *guard = next;
        let json = serde_json::to_vec_pretty(&*guard)?;
        let temp = self.prefs_path.with_extension("json.tmp");
        std::fs::write(&temp, &json).map_err(|e| Error::io(&temp, e))?;
        std::fs::rename(&temp, &self.prefs_path).map_err(|e| Error::io(&self.prefs_path, e))?;
        Ok(())
    }

    /// The configured token, if any.
    pub fn token(&self) -> Option<String> {
        self.prefs().ok().and_then(|p| p.github_token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bam_core::testing::FakeHttp;

    fn state(dir: &std::path::Path) -> AppState {
        AppState::new(dir.to_path_buf(), Box::new(FakeHttp::new()))
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn starts_empty_and_persists_changes() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        {
            let app = state(tmp.path());
            assert_eq!(app.with_store(|s| s.servers.len()).unwrap_or(9), 0);
            app.mutate_store(|store| {
                store.servers.push(bam_core::model::Server::new(
                    "Epoch",
                    "/games/epoch",
                    bam_core::model::GameVersion::Wotlk,
                ));
                Ok(())
            })
            .unwrap_or_else(|e| panic!("{e}"));
        }

        // A fresh instance sees the saved state.
        let reopened = state(tmp.path());
        assert_eq!(reopened.with_store(|s| s.servers.len()).unwrap_or(0), 1);
    }

    #[test]
    fn preferences_round_trip() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        {
            let app = state(tmp.path());
            app.set_prefs(Preferences {
                github_token: Some("ghp_x".into()),
                selected_server_id: Some("srv_1".into()),
                theme: Some("dark".into()),
            })
            .unwrap_or_else(|e| panic!("{e}"));
        }
        let reopened = state(tmp.path());
        assert_eq!(reopened.token().as_deref(), Some("ghp_x"));
        assert_eq!(
            reopened.prefs().ok().and_then(|p| p.selected_server_id),
            Some("srv_1".into())
        );
    }

    #[test]
    fn stale_work_directories_are_cleared_on_start() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let leftover = tmp.path().join("work").join("staging-crashed");
        std::fs::create_dir_all(&leftover).unwrap_or_else(|e| panic!("{e}"));

        let _app = state(tmp.path());
        assert!(
            !leftover.exists(),
            "a crashed run's staging must be cleared"
        );
    }
}
