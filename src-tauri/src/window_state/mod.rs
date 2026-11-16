//! Native window lifetime state. Webview reloads leave this state alone.
//! Only normal size and maximization are persisted; the OS chooses a monitor
//! on launch and the window is fitted and centred within its current work area.

mod saved;

use std::path::PathBuf;
use std::sync::Mutex;

use saved::{centered, Geometry, Size, MIN_SIZE};
use tauri::{plugin::TauriPlugin, LogicalSize, Manager, Runtime, Window, WindowEvent};

struct Cache {
    path: Option<PathBuf>,
    geometry: Mutex<Geometry>,
}

impl Cache {
    fn save(&self) {
        if let (Some(path), Ok(geometry)) = (&self.path, self.geometry.lock()) {
            if let Err(error) = geometry.save(path) {
                tracing::warn!(%error, "could not save window state");
            }
        }
    }
}

fn sample<R: Runtime>(window: &Window<R>) {
    let Some(cache) = window.try_state::<Cache>() else {
        return;
    };
    let sample = (|| -> tauri::Result<_> {
        let inner = window.inner_size()?;
        Ok((
            Size::from_physical(inner.width, inner.height, window.scale_factor()?),
            window.is_maximized()?,
            window.is_minimized()?,
            window.is_fullscreen()?,
        ))
    })();
    if let Ok((Some(size), maximized, minimized, fullscreen)) = sample {
        if let Ok(mut geometry) = cache.geometry.lock() {
            geometry.observe(size, maximized, minimized, fullscreen);
        }
    }
}

fn restore<R: Runtime>(window: &Window<R>) -> tauri::Result<()> {
    let cache = window.state::<Cache>();
    let saved = cache
        .geometry
        .lock()
        .map(|state| *state)
        .unwrap_or_default();
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let inner = window.inner_size()?;
    let outer = window.outer_size()?;
    let available = monitor.as_ref().and_then(|monitor| {
        let area = monitor.work_area();
        Size::from_physical(
            area.size
                .width
                .saturating_sub(outer.width.saturating_sub(inner.width)),
            area.size
                .height
                .saturating_sub(outer.height.saturating_sub(inner.height)),
            window.scale_factor().ok()?,
        )
    });
    let fitted = saved.fit(available);
    // Relax the usual minimum only when a smaller screen requires it.
    let minimum = available.unwrap_or(MIN_SIZE);
    window.set_min_size(Some(LogicalSize::new(
        MIN_SIZE.width.min(minimum.width),
        MIN_SIZE.height.min(minimum.height),
    )))?;
    window.set_size(LogicalSize::new(fitted.size.width, fitted.size.height))?;
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let outer = window.outer_size()?;
        let (x, y) = centered(
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
            outer.width,
            outer.height,
        );
        // Some window managers (notably Wayland) choose placement themselves.
        // That must not prevent restoring the size or maximized state.
        if let Err(error) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
            tracing::debug!(%error, "window manager chose the window position");
        }
    } else if let Err(error) = window.center() {
        tracing::debug!(%error, "window manager chose the window position");
    }
    if let Ok(mut state) = cache.geometry.lock() {
        *state = fitted;
    }
    if fitted.maximized {
        window.maximize()?;
    }
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("window-state")
        .setup(|app, _| {
            let path = match app.path().app_data_dir() {
                Ok(dir) => Some(dir.join("window-state.json")),
                Err(error) => {
                    tracing::warn!(%error, "could not locate window state directory");
                    None
                }
            };
            let geometry = path
                .as_ref()
                .map(|path| {
                    Geometry::load(path).unwrap_or_else(|error| {
                        tracing::warn!(%error, "could not restore window state; using defaults");
                        Geometry::default()
                    })
                })
                .unwrap_or_default();
            app.manage(Cache {
                path,
                geometry: Mutex::new(geometry),
            });
            Ok(())
        })
        .on_window_ready(|window| {
            if window.label() != "main" {
                return;
            }
            if let Err(error) = restore(&window) {
                tracing::warn!(%error, "could not apply saved window size");
            }
            // Even a corrupt file or a window-manager error must not hide the app.
            if let Err(error) = window.show() {
                tracing::warn!(%error, "could not show the main window");
            }
            if let Err(error) = window.set_focus() {
                tracing::debug!(%error, "window manager chose the window focus");
            }
            let tracked = window.clone();
            window.on_window_event(move |event| {
                if matches!(
                    event,
                    WindowEvent::Resized(_) | WindowEvent::CloseRequested { .. }
                ) {
                    sample(&tracked);
                }
                if matches!(event, WindowEvent::CloseRequested { .. }) {
                    tracked.state::<Cache>().save();
                }
            });
        })
        .on_event(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                if let Some(window) = app.get_webview_window("main") {
                    sample(&window.as_ref().window());
                }
                app.state::<Cache>().save();
            }
        })
        .build()
}
