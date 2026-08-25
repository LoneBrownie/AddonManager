//! Typed errors for the addon engine.
//!
//! Every fallible path returns one of these. The crate denies `unwrap`,
//! `expect` and `panic!`, so a failure surfaces as a value the UI can render
//! rather than taking the process down mid-install.

use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // ---- path safety (V2-PLAN.md S2, S3) ----
    /// An archive entry or folder name tried to escape its root.
    #[error("unsafe path {raw:?}: {reason}")]
    UnsafePath { raw: String, reason: &'static str },

    /// A resolved path landed outside the directory it was confined to.
    #[error("path {path} escapes its root {root}")]
    PathEscapesRoot { path: PathBuf, root: PathBuf },

    // ---- archives ----
    #[error("archive rejected: {0}")]
    ArchiveRejected(String),

    #[error("no addon folders containing a .toc file were found in the archive")]
    NoAddonFolders,

    #[error("archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    // ---- install-time collisions (V2-PLAN.md B2) ----
    /// Refusing to overwrite something we did not create.
    #[error("folder {folder:?} already exists and is not managed by this app")]
    UnmanagedCollision { folder: String },

    /// Refusing to overwrite a folder owned by a different managed addon.
    #[error("folder {folder:?} is already owned by addon {owner:?}")]
    ManagedCollision { folder: String, owner: String },

    // ---- changing an addon's source ----
    /// Asked to act on an addon this server does not have.
    #[error("{addon_id:?} is not installed to {server_id:?}")]
    NotInstalled { addon_id: String, server_id: String },

    /// Asked to move an addon onto a repository this server already has a row
    /// for. Allowing it would collapse two installations into one.
    #[error("{addon_id:?} is already installed to this server")]
    AlreadyInstalled { addon_id: String },

    // ---- sources ----
    #[error("unsupported repository URL: {0}")]
    UnsupportedRepoUrl(String),

    #[error("no release or source archive could be resolved for {0}")]
    NoResolvableRef(String),

    #[error("http {status} from {url}")]
    HttpStatus { status: u16, url: String },

    #[error("network error: {0}")]
    Network(String),

    // ---- storage ----
    #[error("store schema version {found} is not supported (expected {expected})")]
    UnsupportedSchema { found: u32, expected: u32 },

    #[error("server {0} is not registered")]
    UnknownServer(String),

    /// The server's path is not reachable right now — an unplugged external
    /// drive, typically. Never treat this as "the user deleted their addons".
    /// See V2-PLAN.md B8.
    #[error("server {name:?} is unavailable at {path}")]
    ServerUnavailable { name: String, path: PathBuf },

    #[error("{path} is not a World of Warcraft directory ({reason})")]
    NotAWowDirectory { path: PathBuf, reason: &'static str },

    #[error("{path} is not writable — {hint}")]
    NotWritable { path: PathBuf, hint: String },

    // ---- generic ----
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io error at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("io error: {0}")]
    BareIo(#[from] std::io::Error),
}

impl Error {
    pub fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Error::Io {
            path: path.into(),
            source,
        }
    }

    pub fn unsafe_path(raw: impl Into<String>, reason: &'static str) -> Self {
        Error::UnsafePath {
            raw: raw.into(),
            reason,
        }
    }
}
