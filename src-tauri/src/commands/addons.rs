//! Addon install, update and removal commands.

use bam_core::install::{self, InstallOptions};
use bam_core::model::{Channel, Source};
use bam_core::sources;
use bam_core::updates;
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{AddonDto, ImportedDto, ListEntryDto, OutcomeDto, UnmetDto};
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
///
/// `fallback_to_source` and `adopt_existing` are what importing a list turns on:
/// a repository with no releases installs from its branch, and an addon already
/// sitting in the game folder is taken over rather than downloaded over. Both
/// stay off everywhere else, where the refusal is the useful answer.
#[tauri::command]
pub async fn install_addon(
    state: State<'_, AppState>,
    server_id: String,
    url: String,
    channel: Option<Channel>,
    overwrite_unmanaged: Option<bool>,
    fallback_to_source: Option<bool>,
    adopt_existing: Option<bool>,
) -> CommandResult<AddonDto> {
    let source = sources::parse_repo_url(&url)?;
    let options = InstallOptions {
        fallback_to_source: fallback_to_source.unwrap_or(false),
        adopt_existing: adopt_existing.unwrap_or(false),
        ..options_for(&state, channel, overwrite_unmanaged)
    };

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

/// Apply one line of a pasted addon list.
///
/// Not the same thing as installing it. The list is the user's own record of
/// what they run, so where it identifies something already in the game folder —
/// by naming the folders, or by naming the addon in a way a folder on disk
/// answers to — that folder is taken over as it stands and nothing is
/// downloaded at all. Only what is genuinely not there yet is fetched.
#[tauri::command]
pub async fn import_addon(
    state: State<'_, AppState>,
    server_id: String,
    entry: ListEntryDto,
) -> CommandResult<ImportedDto> {
    let entry = entry.into_entry()?;

    let mut store = state.snapshot()?;
    let (installed, outcome) = bam_core::import::apply(
        state.client.as_ref(),
        &mut store,
        &server_id,
        &entry,
        state.token(),
        &state.work_dir,
    )
    .await?;

    let dto = AddonDto::build(&store, &installed);
    state.commit(store)?;

    Ok(ImportedDto {
        addon: dto.ok_or_else(|| CommandError {
            kind: "unexpected".into(),
            message: "the addon imported but could not be read back".into(),
            folder: None,
        })?,
        adopted: outcome == bam_core::import::Outcome::Adopted,
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
    let cancel = state.begin_check(&server_id);
    let reports = updates::check_updates_for_server(
        state.client.as_ref(),
        &store,
        &server_id,
        token.as_deref(),
        6,
        &cancel,
    )
    .await;
    state.finish_check(&server_id);

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

/// Stop an update check that is running.
///
/// Requests already in flight finish rather than being torn down, so nothing
/// is left half-checked — cancelling means "stop starting new work".
#[tauri::command]
pub fn cancel_update_check(state: State<'_, AppState>, server_id: String) -> CommandResult<()> {
    state.cancel_check(&server_id);
    Ok(())
}

/// What else would break if this addon were removed.
///
/// Called before showing the confirmation, so the warning names the addons
/// that declare a dependency on it rather than leaving the user to find out.
#[tauri::command]
pub fn removal_impact(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
) -> CommandResult<Vec<String>> {
    let store = state.snapshot()?;
    let Some(server) = store.server(&server_id).cloned() else {
        return Ok(Vec::new());
    };
    Ok(bam_core::deps::dependents_of(&store, &server, &addon_id))
}

/// Addons whose declared dependencies are not present on this server.
#[tauri::command]
pub fn unmet_dependencies(
    state: State<'_, AppState>,
    server_id: String,
) -> CommandResult<Vec<UnmetDto>> {
    let store = state.snapshot()?;
    let Some(server) = store.server(&server_id).cloned() else {
        return Ok(Vec::new());
    };
    Ok(bam_core::deps::unmet(&store, &server)
        .into_iter()
        .map(|item| UnmetDto {
            addon_id: item.addon_id,
            addon_name: item.addon_name,
            missing: item.missing,
        })
        .collect())
}

/// Reinstall an addon at whatever its channel currently resolves to.
///
/// Unlike installing, this writes over folders the app did not create. That is
/// not a weakening of the rule that protects hand-installed folders — it is
/// where the rule stops applying. The refusal exists so that installing a *new*
/// addon cannot destroy an unrelated folder that happens to share its name;
/// nobody has said the two are the same thing. Here somebody has: this addon is
/// already managed, the user named the repository it comes from, and they have
/// asked for that repository to be put on disk.
///
/// It matters most straight after adopting. Adoption records the folders that
/// were on disk, and an addon that ships several usually has only one of them
/// recognised — so the first update would land on the addon's own remaining
/// folders and refuse, naming folders the user had just claimed. Those folders
/// become recorded like the rest, so removing the addon later takes all of it.
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
        // See above: the user has already told us what this addon is and where
        // it comes from, so its own folders are not somebody else's files.
        overwrite_unmanaged: true,
        // An adopted addon has a channel because a record needs one, not
        // because anybody picked it. So if the repository turns out to publish
        // no releases, taking the branch is not overriding a choice — and
        // refusing would leave the addon stuck at an unknown version forever,
        // which is the one thing adoption exists to escape. Once updated it has
        // a real version and this stops applying.
        fallback_to_source: installation.installed_ref.is_unknown(),
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
) -> CommandResult<AddonDto> {
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

    // The updated row, so the interface shows the consequence of the switch
    // rather than working it out again from a rule the engine already owns.
    let store = state.snapshot()?;
    store
        .installation(&server_id, &addon_id)
        .and_then(|installation| AddonDto::build(&store, installation))
        .ok_or_else(|| CommandError {
            kind: "unknownAddon".into(),
            message: format!("{addon_id} is not installed to {server_id}"),
            folder: None,
        })
}
