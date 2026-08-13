//! Updating the app itself, and which channel it updates from.
//!
//! Checking and installing run here rather than in the webview, which is what
//! makes a channel possible at all: the updater plugin's JavaScript API has no
//! way to say which endpoint to read, so the URL compiled into
//! `tauri.conf.json` is the only one it can ever use. The Rust builder does
//! take one, so the choice has to be made on this side.
//!
//! A side effect worth having: `updater:default` is no longer granted to the
//! webview, because the webview no longer talks to the plugin. Two commands
//! that name an intention replace a permission that named a capability.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;
use tauri_plugin_updater::UpdaterExt;

use super::{CommandError, CommandResult};
use crate::state::AppState;

/// Both manifests are served from GitHub Pages.
///
/// A manifest is a file, and it needs an address that never moves. A release
/// that exists only to hold one shows up on the releases page for ever
/// pretending to be a download, and `releases/latest` cannot serve the beta
/// channel at all — GitHub resolves it to the newest *non*-pre-release. Pages
/// deployed from a workflow artifact needs neither a release nor a branch: the
/// files exist only as a deployment.
const STABLE_MANIFEST: &str = "https://lonebrownie.github.io/AddonManager/latest.json";

/// Beta: the newest release of *either* kind.
///
/// It has to include stable releases too, or somebody on `2.1.0-beta.3` would
/// never be offered `2.1.0` when it ships — the channel would be a dead end
/// rather than a fast lane.
const BETA_MANIFEST: &str = "https://lonebrownie.github.io/AddonManager/beta.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfoDto {
    pub version: String,
}

/// Download progress, sent as it arrives.
///
/// `total` is absent when the server does not send a content length, which the
/// interface renders as a spinner rather than inventing a percentage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressDto {
    pub downloaded: u64,
    pub total: Option<u64>,
}

fn failed(message: impl std::fmt::Display) -> CommandError {
    CommandError {
        kind: "updateFailed".into(),
        message: message.to_string(),
        folder: None,
    }
}

/// An updater pointed at the channel this installation is on.
fn updater(app: &tauri::AppHandle, beta: bool) -> CommandResult<tauri_plugin_updater::Updater> {
    let endpoint = if beta { BETA_MANIFEST } else { STABLE_MANIFEST };
    app.updater_builder()
        .endpoints(vec![endpoint.parse().map_err(failed)?])
        .map_err(failed)?
        .build()
        .map_err(failed)
}

/// Is there something newer on this installation's channel?
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> CommandResult<Option<UpdateInfoDto>> {
    let beta = state.prefs()?.beta_channel;
    let found = updater(&app, beta)?.check().await.map_err(failed)?;
    Ok(found.map(|update| UpdateInfoDto {
        version: update.version,
    }))
}

/// Download and install whatever [`check_for_update`] would find.
///
/// The check is repeated rather than the handle being kept between the two
/// commands. It costs one small request on a button press the user has already
/// decided to make, and it avoids parking a live download handle in shared
/// state between two round trips through the webview.
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    progress: Channel<ProgressDto>,
) -> CommandResult<()> {
    let beta = state.prefs()?.beta_channel;
    let update = updater(&app, beta)?
        .check()
        .await
        .map_err(failed)?
        .ok_or_else(|| failed("there is no update to install"))?;

    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                // A failed send means the window has gone; the download itself
                // is still worth finishing.
                let _ = progress.send(ProgressDto { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(failed)?;
    Ok(())
}

/// Which channel this installation is on.
#[tauri::command]
pub fn update_channel(state: State<'_, AppState>) -> CommandResult<String> {
    Ok(if state.prefs()?.beta_channel {
        "beta".into()
    } else {
        "stable".into()
    })
}

/// Move this installation onto the beta channel. There is no way back.
///
/// Deliberately one-way, and said so before it happens. An in-app way back
/// would have to downgrade — a beta is *ahead* of stable, so the updater finds
/// nothing to offer — and downgrading means an older binary opening a store a
/// newer one wrote, which [`bam_core::store`] refuses rather than guesses at.
///
/// There are two honest ways off it, and Settings names both: reinstall the
/// stable build, or wait for the next stable release to overtake the beta you
/// are running, which this channel delivers too. The second leaves you on a
/// stable version but still on the channel, so betas resume after it — which is
/// why it is offered as patience rather than as an exit.
#[tauri::command]
pub fn join_beta_channel(state: State<'_, AppState>) -> CommandResult<()> {
    let mut prefs = state.prefs()?;
    prefs.beta_channel = true;
    state.set_prefs(prefs)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The channels must not collapse into one, and neither may be fetched
    /// over a transport somebody on the same network can rewrite — an update
    /// manifest names the binary this app will download and run.
    #[test]
    fn the_two_channels_read_different_manifests_over_https() {
        assert_ne!(STABLE_MANIFEST, BETA_MANIFEST);
        for endpoint in [STABLE_MANIFEST, BETA_MANIFEST] {
            assert!(
                endpoint.starts_with("https://"),
                "an update manifest must not be fetched over plain HTTP"
            );
            assert!(
                endpoint.starts_with("https://lonebrownie.github.io/AddonManager/"),
                "both are served from the Pages site the release workflow deploys"
            );
        }
    }
}
