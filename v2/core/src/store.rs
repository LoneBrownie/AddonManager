//! Persistence, written atomically.
//!
//! V1 wrote its JSON in place, so a crash or power cut mid-write truncated it.
//! It also skipped the write entirely when the addon list was empty, meaning a
//! deleted last addon came back on restart (V2-PLAN.md B1). Both are fixed
//! here: every save is temp-file + fsync + rename, and an empty collection is
//! a perfectly valid thing to persist.
//!
//! There is no V1 importer. V2 is a new application with its own data
//! directory (D10).

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::model::{Store, SCHEMA_VERSION};

/// How many previous states to retain beside the live file.
const BACKUP_SLOTS: usize = 3;

/// Reads and writes the store file.
#[derive(Debug, Clone)]
pub struct StoreFile {
    path: PathBuf,
}

impl StoreFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        StoreFile { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Load the store, or return a default one if the file does not exist yet.
    ///
    /// A corrupt file is not silently discarded: the most recent readable
    /// backup is used instead, so a bad write costs the last change rather
    /// than the whole configuration.
    pub fn load(&self) -> Result<Store> {
        match self.read_from(&self.path) {
            Ok(store) => Ok(store),
            Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                Ok(Store::default())
            }
            Err(primary) => {
                for slot in 0..BACKUP_SLOTS {
                    if let Ok(store) = self.read_from(&self.backup_path(slot)) {
                        tracing::warn!(
                            error = %primary,
                            slot,
                            "store file unreadable; recovered from backup"
                        );
                        return Ok(store);
                    }
                }
                Err(primary)
            }
        }
    }

    fn read_from(&self, path: &Path) -> Result<Store> {
        let bytes = std::fs::read(path).map_err(|e| Error::io(path, e))?;
        let store: Store = serde_json::from_slice(&bytes)?;
        if store.schema_version != SCHEMA_VERSION {
            return Err(Error::UnsupportedSchema {
                found: store.schema_version,
                expected: SCHEMA_VERSION,
            });
        }
        Ok(store)
    }

    /// Persist the store atomically.
    ///
    /// Writes to a sibling temp file, flushes it to disk, rotates the previous
    /// state into a backup slot, then renames into place. A reader either sees
    /// the old file or the new one, never a half-written one.
    pub fn save(&self, store: &Store) -> Result<()> {
        let mut to_write = store.clone();
        to_write.schema_version = SCHEMA_VERSION;

        let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;

        let json = serde_json::to_vec_pretty(&to_write)?;
        let temp = self.path.with_extension("json.tmp");

        {
            use std::io::Write as _;
            let mut file = std::fs::File::create(&temp).map_err(|e| Error::io(&temp, e))?;
            file.write_all(&json).map_err(|e| Error::io(&temp, e))?;
            file.flush().map_err(|e| Error::io(&temp, e))?;
            // Without this the rename can land before the bytes do.
            file.sync_all().map_err(|e| Error::io(&temp, e))?;
        }

        self.rotate_backups();
        std::fs::rename(&temp, &self.path).map_err(|e| Error::io(&self.path, e))?;
        Ok(())
    }

    fn backup_path(&self, slot: usize) -> PathBuf {
        self.path.with_extension(format!("json.bak{slot}"))
    }

    /// Shift bak1 → bak2, bak0 → bak1, live → bak0. Best-effort throughout:
    /// failing to keep a backup must never block the save itself.
    fn rotate_backups(&self) {
        for slot in (1..BACKUP_SLOTS).rev() {
            let _ = std::fs::rename(self.backup_path(slot - 1), self.backup_path(slot));
        }
        if self.path.exists() {
            let _ = std::fs::copy(&self.path, self.backup_path(0));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{GameVersion, Server};

    fn store_with_one_server() -> Store {
        let mut store = Store::default();
        store
            .servers
            .push(Server::new("Epoch", "/games/epoch", GameVersion::Wotlk));
        store
    }

    #[test]
    fn missing_file_loads_as_empty() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = StoreFile::new(tmp.path().join("store.json"));
        let store = file.load().unwrap_or_else(|e| panic!("{e}"));
        assert!(store.servers.is_empty());
        assert_eq!(store.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn round_trips_through_disk() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = StoreFile::new(tmp.path().join("store.json"));
        let original = store_with_one_server();

        file.save(&original).unwrap_or_else(|e| panic!("{e}"));
        let loaded = file.load().unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(original, loaded);
    }

    /// V2-PLAN.md B1: V1 skipped the write when the list was empty, so
    /// deleting your last addon did not stick.
    #[test]
    fn saving_an_empty_store_actually_persists() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = StoreFile::new(tmp.path().join("store.json"));

        file.save(&store_with_one_server())
            .unwrap_or_else(|e| panic!("{e}"));
        file.save(&Store::default())
            .unwrap_or_else(|e| panic!("{e}"));

        let loaded = file.load().unwrap_or_else(|e| panic!("{e}"));
        assert!(
            loaded.servers.is_empty(),
            "an emptied store must stay empty across a reload"
        );
    }

    #[test]
    fn leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = StoreFile::new(tmp.path().join("store.json"));
        file.save(&store_with_one_server())
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(!tmp.path().join("store.json.tmp").exists());
    }

    #[test]
    fn keeps_a_backup_of_the_previous_state() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let file = StoreFile::new(tmp.path().join("store.json"));

        file.save(&store_with_one_server())
            .unwrap_or_else(|e| panic!("{e}"));
        file.save(&Store::default())
            .unwrap_or_else(|e| panic!("{e}"));

        assert!(tmp.path().join("store.json.bak0").exists());
    }

    #[test]
    fn recovers_from_a_corrupt_live_file() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = tmp.path().join("store.json");
        let file = StoreFile::new(&path);

        file.save(&store_with_one_server())
            .unwrap_or_else(|e| panic!("{e}"));
        // Second save so a backup exists, then corrupt the live file.
        file.save(&store_with_one_server())
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(&path, b"{ not json").unwrap_or_else(|e| panic!("{e}"));

        let recovered = file.load().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(recovered.servers.len(), 1, "should fall back to the backup");
    }

    #[test]
    fn rejects_an_unknown_schema_version() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = tmp.path().join("store.json");
        std::fs::write(&path, br#"{"schema_version":999,"servers":[]}"#)
            .unwrap_or_else(|e| panic!("{e}"));

        let result = StoreFile::new(&path).load();
        assert!(matches!(
            result,
            Err(Error::UnsupportedSchema { found: 999, .. })
        ));
    }

    #[test]
    fn tolerates_missing_optional_collections() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = tmp.path().join("store.json");
        std::fs::write(&path, br#"{"schema_version":2}"#).unwrap_or_else(|e| panic!("{e}"));

        let store = StoreFile::new(&path)
            .load()
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(store.servers.is_empty());
        assert!(store.installed.is_empty());
    }
}
