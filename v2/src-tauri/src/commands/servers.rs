//! Server registration and management commands.

use std::path::PathBuf;

use bam_core::model::GameVersion;
use bam_core::servers::{self, AddOptions};
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{game_versions, FolderVerdictDto, GameVersionDto, ServerDto};
use crate::state::AppState;

#[tauri::command]
pub fn list_servers(state: State<'_, AppState>) -> CommandResult<Vec<ServerDto>> {
    let store = state.snapshot()?;
    Ok(servers::summaries(&store)
        .into_iter()
        .map(ServerDto::from)
        .collect())
}

#[tauri::command]
pub fn list_game_versions() -> Vec<GameVersionDto> {
    game_versions()
}

/// Inspect a folder the user picked, before they commit to adding it.
#[tauri::command]
pub fn inspect_folder(path: String) -> FolderVerdictDto {
    let path = PathBuf::from(path);
    FolderVerdictDto::from_verdict(servers::inspect_path(&path), &path)
}

/// Register a server. Always manual — there is no scan (D8).
#[tauri::command]
pub fn add_server(
    state: State<'_, AppState>,
    name: String,
    path: String,
    version: GameVersion,
    force: Option<bool>,
) -> CommandResult<ServerDto> {
    let path = PathBuf::from(path);
    let options = AddOptions {
        force: force.unwrap_or(false),
    };

    let server =
        state.mutate_store(|store| servers::add(store, &name, &path, version, &options))?;

    let store = state.snapshot()?;
    servers::summaries(&store)
        .into_iter()
        .find(|summary| summary.server.id == server.id)
        .map(ServerDto::from)
        .ok_or_else(|| CommandError {
            kind: "unexpected".into(),
            message: "the server was added but could not be read back".into(),
            folder: None,
        })
}

#[tauri::command]
pub fn rename_server(state: State<'_, AppState>, id: String, name: String) -> CommandResult<()> {
    state.mutate_store(|store| servers::rename(store, &id, &name))?;
    Ok(())
}

#[tauri::command]
pub fn set_server_accent(
    state: State<'_, AppState>,
    id: String,
    accent: Option<String>,
) -> CommandResult<()> {
    state.mutate_store(|store| servers::set_accent(store, &id, accent))?;
    Ok(())
}

#[tauri::command]
pub fn set_server_version(
    state: State<'_, AppState>,
    id: String,
    version: GameVersion,
) -> CommandResult<()> {
    state.mutate_store(|store| servers::set_version(store, &id, version))?;
    Ok(())
}

/// Stop tracking a server. Files on disk are left alone — deregistering is not
/// uninstalling, and silently deleting someone's addons would be a nasty
/// surprise.
#[tauri::command]
pub fn forget_server(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.mutate_store(|store| servers::forget(store, &id))?;
    Ok(())
}

/// Copy every addon from one server to another.
///
/// Pure filesystem work — no download, so the copied version is exactly the one
/// already installed rather than whatever upstream now offers.
#[tauri::command]
pub fn copy_addon_set(
    state: State<'_, AppState>,
    from_server_id: String,
    to_server_id: String,
    overwrite_unmanaged: Option<bool>,
) -> CommandResult<Vec<String>> {
    let overwrite = overwrite_unmanaged.unwrap_or(false);
    let outcomes = state.mutate_store(|store| {
        bam_core::bulk::copy_set(store, &from_server_id, &to_server_id, overwrite)
    })?;

    Ok(outcomes
        .into_iter()
        .map(|outcome| match outcome {
            bam_core::bulk::CopyOutcome::Copied { addon_id, .. } => format!("copied {addon_id}"),
            bam_core::bulk::CopyOutcome::AlreadyPresent { addon_id } => {
                format!("already present: {addon_id}")
            }
            bam_core::bulk::CopyOutcome::Failed { addon_id, reason } => {
                format!("failed {addon_id}: {reason}")
            }
        })
        .collect())
}

/// Remember which server the switcher had selected.
#[tauri::command]
pub fn set_selected_server(state: State<'_, AppState>, id: Option<String>) -> CommandResult<()> {
    let mut prefs = state.prefs()?;
    prefs.selected_server_id = id;
    state.set_prefs(prefs)?;
    Ok(())
}
