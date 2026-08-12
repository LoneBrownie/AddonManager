//! Server registration and management commands.

use std::path::PathBuf;

use bam_core::model::GameVersion;
use bam_core::servers::{self, AddOptions};
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{game_versions, FolderVerdictDto, FoundAddonDto, GameVersionDto, ServerDto};
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

/// Point an existing server at a different folder.
///
/// For a game that moved or a drive that changed letter. Keeps the server's
/// name, colour and every addon recorded against it — the alternative,
/// forgetting and re-adding, loses all of that.
#[tauri::command]
pub fn repoint_server(
    state: State<'_, AppState>,
    id: String,
    path: String,
    force: Option<bool>,
) -> CommandResult<ServerDto> {
    let path = PathBuf::from(path);
    let options = AddOptions {
        force: force.unwrap_or(false),
    };
    let server = state.mutate_store(|store| servers::repoint(store, &id, &path, &options))?;

    let store = state.snapshot()?;
    servers::summaries(&store)
        .into_iter()
        .find(|summary| summary.server.id == server.id)
        .map(ServerDto::from)
        .ok_or_else(|| CommandError {
            kind: "unexpected".into(),
            message: "the server moved but could not be read back".into(),
            folder: None,
        })
}

/// Open a server's `Interface/AddOns` folder in the system file manager.
///
/// The folder itself, not any addon inside it — the point is to get at the
/// directory the app installs into, for the things a manager will never do:
/// dropping in a hand-built addon, clearing out a stray folder, checking what
/// is actually there.
///
/// Created if missing, because a freshly registered server may not have one
/// yet, and opening nothing is a worse answer than opening an empty folder.
#[tauri::command]
pub fn open_server_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<()> {
    let store = state.snapshot()?;
    let server = store
        .server(&server_id)
        .ok_or_else(|| CommandError {
            kind: "unknownServer".into(),
            message: format!("no server with id {server_id}"),
            folder: None,
        })?
        .clone();

    // An unplugged drive is a "not right now", not a failure to explain away.
    if !server.is_available() {
        return Err(CommandError {
            kind: "unavailable".into(),
            message: format!("{} is not reachable right now", server.name),
            folder: None,
        });
    }

    let dir = server.addons_dir();
    let _ = std::fs::create_dir_all(&dir);
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| CommandError {
            kind: "unexpected".into(),
            message: e.to_string(),
            folder: None,
        })
}

/// Remember which server the switcher had selected.
#[tauri::command]
pub fn set_selected_server(state: State<'_, AppState>, id: Option<String>) -> CommandResult<()> {
    let mut prefs = state.prefs()?;
    prefs.selected_server_id = id;
    state.set_prefs(prefs)?;
    Ok(())
}

/// Addon folders already on disk that this app does not manage.
///
/// The "import existing addons" flow — and the reason dropping V1 migration
/// (D10) costs users so little.
#[tauri::command]
pub fn scan_existing_addons(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<Vec<FoundAddonDto>> {
    let store = state.snapshot()?;
    let server = store
        .server(&server_id)
        .cloned()
        .ok_or_else(|| CommandError {
            kind: "unknownServer".into(),
            message: "that server is not registered".into(),
            folder: None,
        })?;

    Ok(bam_core::adopt::scan(&store, &server)?
        .into_iter()
        .map(FoundAddonDto::from)
        .collect())
}

/// Adopt folders on disk as a managed addon.
#[tauri::command]
pub fn adopt_addon(
    state: State<'_, AppState>,
    server_id: String,
    folders: Vec<String>,
    url: String,
    name: Option<String>,
) -> CommandResult<()> {
    state.mutate_store(|store| {
        bam_core::adopt::adopt(
            store,
            &server_id,
            folders,
            &url,
            name,
            bam_core::model::Channel::Release,
        )
        .map(|_| ())
    })?;
    Ok(())
}
