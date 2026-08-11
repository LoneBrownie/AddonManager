//! The addon engine for Brownie's Addon Manager V2.
//!
//! This crate is **headless**: it has no dependency on Tauri, on a webview, or
//! on any UI. That is deliberate. V1's engine grew inside a React renderer and
//! reached the filesystem through generic IPC primitives, which is what made it
//! both slow and unsafe (V2-PLAN.md S1). Keeping the engine in a library the
//! UI cannot bypass is the structural fix.
//!
//! The application layer exposes **intent-level** commands built on this crate
//! — `install_addon`, `remove_addon`, `check_updates`. It does not, and must
//! not, expose `read_file` or `write_file`.
//!
//! # Layout
//!
//! * [`paths`] — canonicalisation and confinement. Every write resolves here.
//! * [`archive`] — zip extraction with explicit, caller-controlled limits.
//! * [`toc`] — `.toc` manifest parsing.
//! * [`version`] — what we installed, and whether something newer exists.
//! * [`model`] — servers, addons, and the join between them.
//! * [`store`] — atomic persistence.
//! * [`sources`] — resolving GitHub and GitLab.
//! * [`install`] — install, update and remove orchestration.
//! * [`servers`] — registering and managing game folders.
//! * [`bulk`] — install-to-many and copy-set-between-servers.
//! * [`adopt`] — adopting addon folders already on disk.
//! * [`http`] — the network trait the engine depends on (no client here).
//! * [`testing`] — fakes, so nothing in the test suite touches the network.

#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

pub mod adopt;
pub mod archive;
pub mod bulk;
pub mod error;
pub mod http;
pub mod install;
pub mod model;
pub mod paths;
pub mod servers;
pub mod sources;
pub mod store;
pub mod testing;
pub mod toc;
pub mod version;

pub use error::{Error, Result};
pub use model::{Addon, Channel, GameVersion, InstalledAddon, Server, Source, Store};
pub use version::{Ref, UpdateStatus};
