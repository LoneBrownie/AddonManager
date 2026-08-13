//! The Tauri shell.
//!
//! Thin by design: every command in [`commands`] is a few lines wrapping
//! `bam-core`. All the behaviour lives in the engine, which is why the engine
//! can be tested without any of this.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod changelog;
pub mod commands;
pub mod dto;
pub mod state;

use std::path::PathBuf;

use state::AppState;

/// Where the app keeps its data.
///
/// A **new** directory, not V1's. V2 is a separate application (D7, D10): the
/// two coexist, and V1 keeps working untouched for anyone who prefers it.
fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// Start file logging.
///
/// Load-bearing rather than a nicety: the author cannot read the source, so a
/// rotating log plus "open logs folder" is how a failure becomes reportable
/// (V2-PLAN.md 5.1.5).
fn init_logging(dir: &std::path::Path) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    let logs = dir.join("logs");
    std::fs::create_dir_all(&logs).ok()?;

    let appender = tracing_appender::rolling::daily(&logs, "bam.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .finish();

    tracing::subscriber::set_global_default(subscriber).ok()?;
    Some(guard)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Desktop only: the updater plugin has no mobile target, and mobile
        // is not something this app builds for.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = data_dir(&app.handle().clone());

            // Held for the process lifetime so buffered log lines are flushed.
            let guard = init_logging(&dir);
            if let Some(guard) = guard {
                app.manage(guard);
            }
            tracing::info!(?dir, "starting Brownie’s Addon Manager");

            let client = bam_net::ReqwestClient::new()?;
            let state = AppState::new(dir, Box::new(client))?;

            use tauri::Manager;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // servers
            commands::servers::list_servers,
            commands::servers::list_game_versions,
            commands::servers::inspect_folder,
            commands::servers::add_server,
            commands::servers::rename_server,
            commands::servers::set_server_accent,
            commands::servers::set_server_version,
            commands::servers::forget_server,
            commands::servers::copy_addon_set,
            commands::servers::repoint_server,
            commands::servers::open_server_folder,
            commands::servers::set_selected_server,
            commands::servers::scan_existing_addons,
            commands::servers::adopt_addon,
            // addons
            commands::addons::list_addons,
            commands::addons::parse_source,
            commands::addons::install_addon,
            commands::addons::install_addon_to_many,
            commands::addons::remove_addon,
            commands::addons::check_updates,
            commands::addons::update_addon,
            commands::addons::set_addon_pinned,
            commands::addons::set_addon_channel,
            commands::addons::cancel_update_check,
            commands::addons::removal_impact,
            commands::addons::unmet_dependencies,
            // catalogue, sharing, settings
            commands::catalog::get_catalog,
            commands::catalog::resolve_catalog_install,
            commands::catalog::export_addon_list,
            commands::catalog::parse_addon_list,
            commands::import::import_addon,
            commands::catalog::app_version,
            commands::catalog::whats_new,
            commands::catalog::get_preferences,
            commands::catalog::set_github_token,
            commands::catalog::has_github_token,
            commands::catalog::set_theme,
            commands::catalog::open_url,
            commands::catalog::open_logs_folder,
            commands::catalog::diagnostics,
            // the app updating itself
            commands::update::check_for_update,
            commands::update::install_update,
            commands::update::update_channel,
            commands::update::join_beta_channel,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| {
            // The only acceptable hard failure: the window could not be created
            // at all, so there is nowhere to render an error.
            eprintln!("failed to start Brownie’s Addon Manager: {error}");
            std::process::exit(1);
        });
}
