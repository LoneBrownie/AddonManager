//! Checking whether something newer exists upstream.
//!
//! Separate from [`crate::install`] because it is a different job: that module
//! places files, this one only asks questions of the forges.

use crate::error::{Error, Result};
use crate::http::HttpClient;
use crate::model::Store;
use crate::sources;
use crate::version::{self, Ref, UpdateStatus};

/// What an update check found for one installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReport {
    pub addon_id: String,
    pub status: UpdateStatus,
    pub installed: Ref,
    pub latest: Ref,
}

/// Check one installation for an update.
pub async fn check_update(
    client: &dyn HttpClient,
    store: &Store,
    server_id: &str,
    addon_id: &str,
    token: Option<&str>,
) -> Result<UpdateReport> {
    let installation = store.installation(server_id, addon_id).ok_or_else(|| {
        Error::UnknownServer(format!("{addon_id} is not installed to {server_id}"))
    })?;
    let addon = store
        .addon(addon_id)
        .ok_or_else(|| Error::UnknownServer(addon_id.to_string()))?;

    let resolved = sources::resolve(client, &addon.source, installation.channel, token).await?;

    Ok(UpdateReport {
        addon_id: addon_id.to_string(),
        status: version::check(&installation.installed_ref, &resolved.r#ref),
        installed: installation.installed_ref.clone(),
        latest: resolved.r#ref,
    })
}

/// Check every addon on a server, a few at a time.
///
/// V1 checked serially, so thirty addons meant thirty round-trips one after
/// another (V2-PLAN.md D-e). Concurrency is bounded rather than unlimited: the
/// forges rate-limit, and firing thirty simultaneous requests is a good way to
/// turn a slow check into a failed one.
///
/// Pinned addons are skipped entirely — no request is made for them at all.
pub async fn check_updates_for_server(
    client: &dyn HttpClient,
    store: &Store,
    server_id: &str,
    token: Option<&str>,
    concurrency: usize,
) -> Vec<(String, Result<UpdateReport>)> {
    use futures_util::stream::{self, StreamExt};

    let to_check: Vec<String> = store
        .installed_for(server_id)
        .into_iter()
        .filter(|installation| !installation.pinned)
        .map(|installation| installation.addon_id.clone())
        .collect();

    stream::iter(to_check)
        .map(|addon_id| async move {
            let report = check_update(client, store, server_id, &addon_id, token).await;
            (addon_id, report)
        })
        .buffer_unordered(concurrency.max(1))
        .collect()
        .await
}
