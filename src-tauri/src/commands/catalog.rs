//! The curated catalogue, addon-list sharing, and settings.

use bam_core::http::api_headers;
use bam_core::sources;
use tauri::State;

use super::{CommandError, CommandResult};
use crate::changelog::WhatsNewDto;
use crate::dto::{CatalogEntryDto, CatalogResultDto, ListEntryDto};
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
/// Carries the channel, the exact version and the folders each addon occupies,
/// so importing the list somewhere the addons already exist needs no downloads
/// at all. Every line still contains a bare repository URL, so V1 and older
/// builds of this app read these lists as they always did.
#[tauri::command]
pub fn export_addon_list(state: State<'_, AppState>, server_id: String) -> CommandResult<String> {
    let store = state.snapshot()?;
    Ok(bam_core::list::render(&store, &server_id))
}

/// Read a pasted addon list.
///
/// Tolerant on purpose: people paste V1 exports, bare URL lists, and Discord
/// messages with commentary around them. A line this app wrote is read in full;
/// anything else is scraped for repository URLs.
#[tauri::command]
pub fn parse_addon_list(text: String) -> Vec<ListEntryDto> {
    bam_core::list::parse(&text)
        .iter()
        .map(ListEntryDto::from)
        .collect()
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

/// The running version, for Settings to show.
///
/// Its own command rather than reading Tauri's app metadata from the webview:
/// the version people need to quote in a bug report is the one the binary was
/// compiled as, and this is that string.
#[tauri::command]
pub fn app_version() -> &'static str {
    crate::changelog::VERSION
}

/// What changed in this version, if the user has not seen it yet.
///
/// Called once at startup. Returns `None` when the running version is the one
/// recorded last time — so the notes appear on the launch after an update and
/// never again, without anything to dismiss permanently or a "don't show this"
/// box to get wrong.
///
/// Recording happens whether or not there is anything to show, so a version
/// with no notes still counts as seen.
#[tauri::command]
pub fn whats_new(state: State<'_, AppState>) -> CommandResult<Option<WhatsNewDto>> {
    let current = crate::changelog::VERSION;

    let mut prefs = state.prefs()?;
    let previous = prefs.last_seen_version.clone();
    if previous.as_deref() == Some(current) {
        return Ok(None);
    }
    prefs.last_seen_version = Some(current.to_string());
    state.set_prefs(prefs)?;

    // Nothing recorded. Either this app has never run here — in which case the
    // user chose this version and is not being told what changed since a
    // version they never had — or it ran as a build from before this was
    // recorded, and an existing setup is the evidence for that.
    if previous.is_none() && state.with_store(|store| store.servers.is_empty())? {
        return Ok(None);
    }

    Ok(
        crate::changelog::section_for(current).map(|notes| WhatsNewDto {
            version: current.to_string(),
            notes,
        }),
    )
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

    fn urls(text: &str) -> Vec<String> {
        parse_addon_list(text.to_string())
            .into_iter()
            .map(|entry| entry.url)
            .collect()
    }

    /// The format itself is the engine's; what is checked here is that the
    /// command hands the interface what it needs.
    #[test]
    fn extracts_urls_from_a_v1_style_export() {
        let text = "Questie: https://github.com/o/questie\nAtlasLoot: https://gitlab.com/t/atlas\n";
        assert_eq!(
            urls(text),
            vec![
                "https://github.com/o/questie".to_string(),
                "https://gitlab.com/t/atlas".to_string()
            ]
        );
    }

    #[test]
    fn carries_what_this_apps_own_export_wrote() {
        let text = "Questie | https://github.com/o/questie | source | master@abc1234 | Questie, Questie_Extra";
        let entries = parse_addon_list(text.to_string());
        let entry = entries.first().unwrap_or_else(|| panic!("one entry"));

        assert_eq!(entry.name.as_deref(), Some("Questie"));
        assert_eq!(entry.channel, Some(bam_core::model::Channel::Source));
        assert_eq!(entry.version.as_deref(), Some("master@abc1234"));
        assert_eq!(entry.folders.len(), 2);
    }

    #[test]
    fn extracts_urls_from_prose() {
        let text = "hey grab <https://github.com/o/r> and also (https://github.com/a/b), thanks!";
        assert_eq!(
            urls(text),
            vec![
                "https://github.com/o/r".to_string(),
                "https://github.com/a/b".to_string()
            ]
        );
    }

    #[test]
    fn ignores_non_repository_links_and_noise() {
        assert!(
            urls("see https://example.com/nope and https://github.com/only-an-owner").is_empty()
        );
    }

    #[test]
    fn deduplicates_repeated_urls() {
        let text = "https://github.com/o/r https://github.com/o/r.git https://github.com/o/r/";
        assert_eq!(urls(text), vec!["https://github.com/o/r".to_string()]);
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
        format!("Brownie’s Addon Manager {}", env!("CARGO_PKG_VERSION")),
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
