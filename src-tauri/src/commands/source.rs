//! Changing where an installed addon comes from.
//!
//! Kept out of `addons.rs` because that module is already close to the
//! 400-line limit, and because this is one coherent intention rather than
//! another verb on the pile: *this addon, this server, that repository now*.

use bam_core::install::InstallOptions;
use bam_core::model::Channel;
use bam_core::retarget;
use bam_core::sources;
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::AddonDto;
use crate::state::AppState;

/// Move one installed addon onto a different repository and install from it.
///
/// Scoped to a single server on purpose. The same addon can sit in two game
/// folders tracking two different forks, and switching one is not a statement
/// about the other (V2-PLAN.md 5.3).
///
/// `channel` is required rather than carried over: a fork may number its
/// releases differently or cut none at all, so the old setting is not evidence
/// about the new repository. Getting it wrong surfaces as the resolver's own
/// refusal, which already names the remedy.
///
/// Any pin on the row is cleared. A pin holds a version, and this replaces the
/// version with one from a repository that has never been checked — see
/// `bam_core::retarget` for why keeping it would be worse than dropping it.
#[tauri::command]
pub async fn change_addon_source(
    state: State<'_, AppState>,
    server_id: String,
    addon_id: String,
    url: String,
    channel: Channel,
) -> CommandResult<AddonDto> {
    let source = sources::parse_repo_url(&url)?;

    // Every other concession an install can be given stays off: a switch is an
    // ordinary write, and a folder in the way that this addon does not own is
    // still worth refusing over.
    let options = InstallOptions {
        channel,
        token: state.token(),
        ..InstallOptions::default()
    };

    // The store lock is never held across an await: take a snapshot, do the
    // slow work, commit only if it worked. That is also what makes a failed
    // switch leave nothing behind — the re-keyed snapshot is simply dropped.
    let mut store = state.snapshot()?;
    let installed = retarget::change_source(
        state.client.as_ref(),
        &mut store,
        &server_id,
        &addon_id,
        &source,
        &options,
        &state.work_dir,
    )
    .await?;

    let dto = AddonDto::build(&store, &installed);
    state.commit(store)?;

    dto.ok_or_else(|| CommandError {
        kind: "unexpected".into(),
        message: "the source changed but the addon could not be read back".into(),
        folder: None,
    })
}
