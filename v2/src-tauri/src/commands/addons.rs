//! Addon install, update and removal commands.

use bam_core::install::{self, InstallOptions};
use bam_core::model::{Channel, Source};
use bam_core::sources;
use bam_core::updates;
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{AddonDto, OutcomeDto};
use crate::state::AppState;

/// Everything installed to one server — what the list renders when that server
/// is selected in the switcher.
#[tauri::command]
pub fn list_addons(state: State<'_, AppState>, server_id: String) -> CommandResult<Vec<AddonDto>> {
    let store = state.snapshot()?;
    let mut rows: Vec<AddonDto> = store
        .installed_for(&server_id)
        .into_iter()
        .filter_map(|installation| AddonDto::build(&store, installation))
        .collect();
    rows.sort_by_key(|row| row.name.to_lowercase());
    Ok(rows)
}

/// Validate a repository URL without installing anything.
#[tauri::command]
pub fn parse_source(url: String) -> CommandResult<String> {
    let source = sources::parse_repo_url(&url)?;
    Ok(source.id())
}

fn options_for(
    state: &AppState,
    channel: Option<Channel>,
    overwrite: Option<bool>,
) -> InstallOptions {
    InstallOptions {
        channel: channel.unwrap_or_default(),
        token: state.token(),
        overwrite_unmanaged: overwrite.unwrap_or(false),
        ..InstallOptions::default()
    }
}

/// Install an addon into the selected server, and **only** that server.
#[tauri::command]
pub async fn install_addon(
    state: State<'_, AppState>,
    server_id: String,
    url: String,
    channel: Option<Channel>,
    overwrite_unmanaged: Option<bool>,
) -> CommandResult<AddonDto> {
    let source = sources::parse_repo_url(&url)?;
    let options = options_for(&state, channel, overwrite_unmanaged);

    // The store lock is never held across an await: take a snapshot, do the
    // slow work, commit the result.
    let mut store = state.snapshot()?;
    let installed = install::install(
        state.client.as_ref(),
        &mut store,
        &server_id,
        &source,
        &options,
        &state.work_dir,
    )
    .await?;

    let dto = AddonDto::build(&store, &installed);
    state.commit(store)?;

    dto.ok_or_else(|| CommandError {
        kind: "unexpected".into(),
        message: "the addon installed but could not be read back".into(),
        folder: None,
    })
}

/// Install one addon into several servers at once.
///
/// An explicit opt-in action — the default remains one server at a time. Not
/// atomic: one blocked target must not stop the others.
#[tauri::command]
pub async fn install_addon_to_many(
    state: State<'_, AppState>,
    server_ids: Vec<String>,
    url: String,
    channel: Option<Channel>,
    overwrite_unmanaged: Option<bool>,
) -> CommandResult<Vec<OutcomeDto>> {
    let source = sources::parse_repo_url(&url)?;
    let options = options_for(&state, channel, overwrite_unmanaged);

    let mut store = state.snapshot()?;
    let outcomes = bam_core::bulk::install_to_many(
        state.client.as_ref(),
        &mut store,
        &server_ids,
        &source,
        &options,
        &state.work_dir,
    )
    .await;
    state.commit(store)?;

    Ok(outcomes
        .into_iter()
        .map(|outcome| OutcomeDto {
            server_id: outcome.server_id,
            server_name: outcome.server_name.clone(),
            ok: outcome.result.is_ok(),
            message: match outcome.result {
                Ok(installed) => format!("installed {}", installed.installed_ref.display()),
                Err(error) => CommandError::from(error).message,
            },
        })
        .collect())
}

/// Remove an addon from one server, deleting exactly the folders we recorded.
#[tauri::command]
pub fn remove_addon(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
) -> CommandResult<Vec<String>> {
    let removed = state.mutate_store(|store| install::remove(store, &server_id, &addon_id))?;
    Ok(removed)
}

/// Check every addon on a server for updates.
///
/// Returns the full row set so the list re-renders in one pass rather than
/// flickering row by row.
#[tauri::command]
pub async fn check_updates(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<Vec<AddonDto>> {
    let store = state.snapshot()?;
    let token = state.token();

    let mut rows: Vec<AddonDto> = store
        .installed_for(&server_id)
        .into_iter()
        .filter_map(|installation| AddonDto::build(&store, installation))
        .collect();

    // Six at a time: the forges rate-limit, so unlimited concurrency turns a
    // slow check into a failed one. Pinned addons are not requested at all.
    let reports = updates::check_updates_for_server(
        state.client.as_ref(),
        &store,
        &server_id,
        token.as_deref(),
        6,
    )
    .await;

    for (addon_id, outcome) in reports {
        let Some(row) = rows.iter_mut().find(|row| row.addon_id == addon_id) else {
            continue;
        };
        match outcome {
            Ok(report) => row.apply_report(&report),
            Err(error) => {
                // One unreachable addon must not fail the whole sweep.
                row.update_status = "error".into();
                row.latest_version = Some(CommandError::from(error).message);
            }
        }
    }
    for row in rows.iter_mut().filter(|row| row.pinned) {
        row.update_status = "upToDate".into();
    }

    rows.sort_by_key(|row| row.name.to_lowercase());
    Ok(rows)
}

/// Reinstall an addon at whatever its channel currently resolves to.
#[tauri::command]
pub async fn update_addon(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
) -> CommandResult<AddonDto> {
    let store = state.snapshot()?;
    let installation = store
        .installation(&server_id, &addon_id)
        .cloned()
        .ok_or_else(|| CommandError {
            kind: "unknownServer".into(),
            message: format!("{addon_id} is not installed to this server"),
            folder: None,
        })?;
    let source: Source = store
        .addon(&addon_id)
        .map(|addon| addon.source.clone())
        .ok_or_else(|| CommandError {
            kind: "unexpected".into(),
            message: format!("no record of {addon_id}"),
            folder: None,
        })?;

    let options = InstallOptions {
        channel: installation.channel,
        token: state.token(),
        // Updating replaces folders this app already owns, so no extra consent
        // is needed — plan_folders classifies them as ReplaceOwn.
        overwrite_unmanaged: false,
        ..InstallOptions::default()
    };

    let mut store = store;
    let installed = install::install(
        state.client.as_ref(),
        &mut store,
        &server_id,
        &source,
        &options,
        &state.work_dir,
    )
    .await?;

    let dto = AddonDto::build(&store, &installed);
    state.commit(store)?;

    dto.ok_or_else(|| CommandError {
        kind: "unexpected".into(),
        message: "the addon updated but could not be read back".into(),
        folder: None,
    })
}

/// Pin or unpin. Pinning means "leave this alone", per server.
#[tauri::command]
pub fn set_addon_pinned(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
    pinned: bool,
) -> CommandResult<()> {
    state.mutate_store(|store| {
        if let Some(installation) = store
            .installed
            .iter_mut()
            .find(|i| i.server_id == server_id && i.addon_id == addon_id)
        {
            installation.pinned = pinned;
        }
        Ok(())
    })?;
    Ok(())
}

/// Switch an addon between releases and source builds, per server.
///
/// An explicit action. The engine never infers a channel change and never
/// presents one as an available update.
#[tauri::command]
pub fn set_addon_channel(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
    channel: Channel,
) -> CommandResult<()> {
    state.mutate_store(|store| {
        if let Some(installation) = store
            .installed
            .iter_mut()
            .find(|i| i.server_id == server_id && i.addon_id == addon_id)
        {
            installation.channel = channel;
        }
        Ok(())
    })?;
    Ok(())
}
