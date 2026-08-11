//! The curated catalogue, addon-list sharing, and settings.

use bam_core::http::api_headers;
use bam_core::sources;
use tauri::State;

use super::{CommandError, CommandResult};
use crate::dto::{CatalogEntryDto, CatalogResultDto};
use crate::state::{AppState, Preferences};
use bam_core::model::GameVersion;

/// Base for the curated lists.
///
/// `HEAD` rather than a branch name. This was pinned to `main`, which broke the
/// moment `main` was renamed to `v1-archive` — a shipped binary cannot be told
/// about a rename, so every installed copy would have lost Browse. `HEAD` is
/// served by raw.githubusercontent as an alias for whatever the default branch
/// currently is, so the rename of `dev` to `main` later on costs nothing.
///
/// It also keeps the original intent (D5): the default branch is what users
/// get, so unreviewed edits on a side branch still never reach them.
const CATALOG_BASE: &str = "https://raw.githubusercontent.com/LoneBrownie/AddonManager/HEAD/public";

fn catalog_url(version: GameVersion) -> String {
    let name = match version {
        GameVersion::Vanilla => "vanilla",
        GameVersion::Tbc => "tbc",
        GameVersion::Wotlk => "wotlk",
    };
    format!("{CATALOG_BASE}/catalog/{name}.json")
}

/// Fetch the curated list for a server's game version.
///
/// One file per version rather than one file with version tags: a 3.3.5a addon
/// and its Vanilla equivalent are almost always different repositories, not the
/// same entry tagged twice. So there is no client-side filtering — the file
/// fetched is the list shown.
///
/// The three outcomes are reported separately, because "you are offline" and
/// "nobody has curated a list for TBC yet" need different words.
#[tauri::command]
pub async fn get_catalog(
    state: State<'_, AppState>,
    server_id: Option<String>,
) -> CommandResult<CatalogResultDto> {
    let store = state.snapshot()?;
    let server = server_id.as_ref().and_then(|id| store.server(id).cloned());

    let Some(server) = server else {
        return Ok(CatalogResultDto {
            status: "noServer".into(),
            entries: Vec::new(),
        });
    };

    // The pre-split `public/handy-addons.json` fallback is gone: that file now
    // only exists on `v1-archive`, and `catalog/wotlk.json` carries the same
    // entries on the default branch.
    let response = state
        .client
        .get(&catalog_url(server.version), &api_headers(None, None))
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(%error, "curated list unreachable");
            return Ok(CatalogResultDto {
                status: "unavailable".into(),
                entries: Vec::new(),
            });
        }
    };

    if response.status == 404 {
        return Ok(CatalogResultDto {
            status: "noListForVersion".into(),
            entries: Vec::new(),
        });
    }
    if !response.is_success() {
        return Ok(CatalogResultDto {
            status: "unavailable".into(),
            entries: Vec::new(),
        });
    }

    let mut entries: Vec<CatalogEntryDto> = match serde_json::from_slice(&response.body) {
        Ok(entries) => entries,
        Err(error) => {
            // A malformed list is a maintenance mistake, not a user problem.
            tracing::warn!(%error, "curated list is not valid JSON");
            return Ok(CatalogResultDto {
                status: "malformed".into(),
                entries: Vec::new(),
            });
        }
    };

    let installed: Vec<String> = store
        .installed_for(&server.id)
        .into_iter()
        .map(|i| i.addon_id.clone())
        .collect();
    for entry in entries.iter_mut() {
        entry.installed = sources::parse_repo_url(&entry.repo_url)
            .map(|source| installed.contains(&source.id()))
            .unwrap_or(false);
    }

    Ok(CatalogResultDto {
        status: "ok".into(),
        entries,
    })
}

/// Render a server's addons as shareable text.
///
/// Kept in V1's format — `Name: url`, one per line — so lists already floating
/// around a guild's Discord still work.
#[tauri::command]
pub fn export_addon_list(state: State<'_, AppState>, server_id: String) -> CommandResult<String> {
    let store = state.snapshot()?;
    let mut lines: Vec<String> = store
        .installed_for(&server_id)
        .into_iter()
        .filter_map(|installation| {
            let addon = store.addon(&installation.addon_id)?;
            Some(format!(
                "{}: {}",
                addon.display_name,
                addon.source.web_url()
            ))
        })
        .collect();
    lines.sort_by_key(|line| line.to_lowercase());
    Ok(lines.join("\n"))
}

/// Pull repository URLs out of pasted text.
///
/// Tolerant on purpose: people paste V1 exports, bare URL lists, and Discord
/// messages with commentary around them. Anything that parses as a repo URL is
/// taken; everything else is ignored.
#[tauri::command]
pub fn parse_addon_list(text: String) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    for token in text.split([
        ' ', '\t', '\n', '\r', ',', ';', '<', '>', '"', '\'', '(', ')',
    ]) {
        let cleaned = token.trim().trim_end_matches(['.', ':', '!', '?']);
        if cleaned.is_empty() {
            continue;
        }
        if !cleaned.contains("github.com") && !cleaned.contains("gitlab.com") {
            continue;
        }
        if let Ok(source) = sources::parse_repo_url(cleaned) {
            let url = source.web_url();
            if !found.contains(&url) {
                found.push(url);
            }
        }
    }

    found
}

/// Work out what installing a catalogue entry actually entails.
///
/// The curated list carries a `dependencies` array that V1 never enforced.
/// Returns repository URLs in install order — dependencies first — including
/// any the user did not explicitly ask for. Anything already installed on this
/// server is left out.
#[tauri::command]
pub async fn resolve_catalog_install(
    state: State<'_, AppState>,
    server_id: String,
    entry_id: String,
) -> CommandResult<Vec<CatalogEntryDto>> {
    let entries = get_catalog(state.clone(), Some(server_id.clone()))
        .await?
        .entries;

    let edges: std::collections::BTreeMap<String, Vec<String>> = entries
        .iter()
        .map(|entry| (entry.id.clone(), entry.dependencies.clone()))
        .collect();

    let order = bam_core::deps::install_order(&[entry_id], &edges);

    Ok(order
        .into_iter()
        .filter_map(|id| entries.iter().find(|entry| entry.id == id).cloned())
        .filter(|entry| !entry.installed)
        .collect())
}

#[tauri::command]
pub fn get_preferences(state: State<'_, AppState>) -> CommandResult<Preferences> {
    Ok(state.prefs()?)
}

/// Store or clear the GitHub token.
///
/// An empty string clears it. The token is never returned to the UI in full —
/// see [`has_token`].
#[tauri::command]
pub fn set_github_token(state: State<'_, AppState>, token: Option<String>) -> CommandResult<()> {
    let mut prefs = state.prefs()?;
    prefs.github_token = token.filter(|t| !t.trim().is_empty());
    state.set_prefs(prefs)?;
    Ok(())
}

/// Whether a token is configured, without revealing it.
#[tauri::command]
pub fn has_github_token(state: State<'_, AppState>) -> CommandResult<bool> {
    Ok(state.token().is_some())
}

#[tauri::command]
pub fn set_theme(state: State<'_, AppState>, theme: Option<String>) -> CommandResult<()> {
    let mut prefs = state.prefs()?;
    prefs.theme = theme;
    state.set_prefs(prefs)?;
    Ok(())
}

/// Open a repository page in the user's browser.
#[tauri::command]
pub fn open_url(app: tauri::AppHandle, url: String) -> CommandResult<()> {
    // Only ever a forge page — the same allowlist the engine uses for requests.
    if !bam_core::http::is_allowed_url(&url) {
        return Err(CommandError {
            kind: "unsafeUrl".into(),
            message: format!("refusing to open {url}"),
            folder: None,
        });
    }
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_url(url, None::<String>)
        .map_err(|e| CommandError {
            kind: "unexpected".into(),
            message: e.to_string(),
            folder: None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_urls_from_a_v1_style_export() {
        let text = "Questie: https://github.com/o/questie\nAtlasLoot: https://gitlab.com/t/atlas\n";
        assert_eq!(
            parse_addon_list(text.to_string()),
            vec![
                "https://github.com/o/questie".to_string(),
                "https://gitlab.com/t/atlas".to_string()
            ]
        );
    }

    #[test]
    fn extracts_urls_from_prose() {
        let text = "hey grab <https://github.com/o/r> and also (https://github.com/a/b), thanks!";
        assert_eq!(
            parse_addon_list(text.to_string()),
            vec![
                "https://github.com/o/r".to_string(),
                "https://github.com/a/b".to_string()
            ]
        );
    }

    #[test]
    fn ignores_non_repository_links_and_noise() {
        let text = "see https://example.com/nope and https://github.com/only-an-owner";
        assert!(parse_addon_list(text.to_string()).is_empty());
    }

    #[test]
    fn deduplicates_repeated_urls() {
        let text = "https://github.com/o/r https://github.com/o/r.git https://github.com/o/r/";
        assert_eq!(
            parse_addon_list(text.to_string()),
            vec!["https://github.com/o/r".to_string()]
        );
    }

    #[test]
    fn returns_nothing_for_empty_input() {
        assert!(parse_addon_list(String::new()).is_empty());
    }
}

/// Open the folder containing the app's logs and data.
///
/// Load-bearing rather than a convenience: the author cannot read the source,
/// so this plus the rotating log is how a failure becomes reportable
/// (V2-PLAN.md 5.1.5).
#[tauri::command]
pub fn open_logs_folder(app: tauri::AppHandle) -> CommandResult<()> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError {
            kind: "unexpected".into(),
            message: e.to_string(),
            folder: None,
        })?
        .join("logs");

    let _ = std::fs::create_dir_all(&dir);
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy().to_string(), None::<String>)
        .map_err(|e| CommandError {
            kind: "unexpected".into(),
            message: e.to_string(),
            folder: None,
        })
}

/// A redacted summary to paste into a bug report.
///
/// Server *names* and game versions are included because they explain the
/// shape of a problem; full paths are reduced to their last component, and the
/// GitHub token is reported only as present or absent.
#[tauri::command]
pub fn diagnostics(state: State<'_, AppState>) -> CommandResult<String> {
    let store = state.snapshot()?;
    let mut lines = vec![
        format!("Brownie's Addon Manager {}", env!("CARGO_PKG_VERSION")),
        format!(
            "Platform: {} {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
        format!("GitHub token configured: {}", state.token().is_some()),
        format!("Servers: {}", store.servers.len()),
    ];

    for server in &store.servers {
        let installed = store.installed_for(&server.id);
        let leaf = server
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".into());
        lines.push(format!(
            "\n  {} — {} — .../{} — {} — {} addon(s)",
            server.name,
            server.version.label(),
            leaf,
            if server.is_available() {
                "available"
            } else {
                "UNAVAILABLE"
            },
            installed.len()
        ));
        for row in installed {
            let name = store
                .addon(&row.addon_id)
                .map(|addon| addon.display_name.clone())
                .unwrap_or_else(|| row.addon_id.clone());
            lines.push(format!(
                "    {} {} [{}]{}{}",
                name,
                row.installed_ref.display(),
                if row.channel == bam_core::model::Channel::Source {
                    "source"
                } else {
                    "release"
                },
                if row.pinned { " pinned" } else { "" },
                if row.version_matches {
                    ""
                } else {
                    " VERSION-MISMATCH"
                },
            ));
        }
    }

    Ok(lines.join("\n"))
}
