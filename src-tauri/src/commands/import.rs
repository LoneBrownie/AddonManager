//! Applying a pasted addon list to a server.
//!
//! Its own module because importing is its own intent, not a variation on
//! installing: the list is the user's own record of what they run, so most of
//! the work is recognising what is already in the game folder rather than
//! fetching anything.

use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{AddonDto, ImportedDto, ListEntryDto};
use crate::state::AppState;

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
