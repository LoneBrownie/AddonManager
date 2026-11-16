//! Persist normal dimensions in logical pixels; native monitor coordinates
//! deliberately stay out of the file so unplugged screens cannot strand it.

use std::io::{self, Read, Write};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct Size {
    pub width: f64,
    pub height: f64,
}

pub(super) const DEFAULT_SIZE: Size = Size {
    width: 1180.0,
    height: 800.0,
};
pub(super) const MIN_SIZE: Size = Size {
    width: 900.0,
    height: 600.0,
};

impl Size {
    fn valid(self) -> bool {
        self.width.is_finite() && self.height.is_finite() && self.width > 0.0 && self.height > 0.0
    }

    pub fn from_physical(width: u32, height: u32, scale: f64) -> Option<Self> {
        let size = Self {
            width: f64::from(width) / scale,
            height: f64::from(height) / scale,
        };
        (scale.is_finite() && scale > 0.0 && size.valid()).then_some(size)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct Geometry {
    pub size: Size,
    #[serde(default)]
    pub maximized: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            size: DEFAULT_SIZE,
            maximized: false,
        }
    }
}

impl Geometry {
    pub fn observe(&mut self, size: Size, maximized: bool, minimized: bool, fullscreen: bool) {
        if minimized || fullscreen || !size.valid() {
            return;
        }
        self.maximized = maximized;
        if !maximized && size.valid() {
            self.size = size;
        }
    }

    pub fn fit(self, available: Option<Size>) -> Self {
        let available = available
            .filter(|size| size.valid())
            .unwrap_or(DEFAULT_SIZE);
        let size = if self.size.valid() {
            self.size
        } else {
            DEFAULT_SIZE
        };
        Self {
            size: Size {
                width: size
                    .width
                    .clamp(MIN_SIZE.width.min(available.width), available.width),
                height: size
                    .height
                    .clamp(MIN_SIZE.height.min(available.height), available.height),
            },
            maximized: self.maximized,
        }
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "window state is too large",
            ));
        }
        let state: Self = serde_json::from_slice(&bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if !state.size.valid() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid window dimensions",
            ));
        }
        Ok(state)
    }

    pub fn save(self, path: &Path) -> io::Result<()> {
        let parent = path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "window state has no parent")
        })?;
        std::fs::create_dir_all(parent)?;
        let temp = path.with_extension("json.tmp");
        bam_core::paths::confine(parent, path).map_err(io::Error::other)?;
        bam_core::paths::confine(parent, &temp).map_err(io::Error::other)?;
        let bytes = serde_json::to_vec_pretty(&self).map_err(io::Error::other)?;
        {
            let mut file = std::fs::File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        std::fs::rename(temp, path)
    }
}

/// Centre the outer frame inside a monitor's work area, including monitors
/// left of the primary display and taskbars at any screen edge.
pub(super) fn centered(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    outer_width: u32,
    outer_height: u32,
) -> (i32, i32) {
    let x = i64::from(x) + i64::from(width.saturating_sub(outer_width)) / 2;
    let y = i64::from(y) + i64::from(height.saturating_sub(outer_height)) / 2;
    (
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resized(width: f64, height: f64) -> Geometry {
        let mut state = Geometry::default();
        state.observe(Size { width, height }, false, false, false);
        state
    }

    #[test]
    fn resized_window_survives_repeated_relaunches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        let first = resized(1400.0, 900.0);
        first.save(&path).unwrap();
        let mut relaunched = Geometry::load(&path).unwrap();
        assert_eq!(relaunched, first);
        relaunched.observe(
            Size {
                width: 1000.0,
                height: 650.0,
            },
            false,
            false,
            false,
        );
        relaunched.save(&path).unwrap();
        assert_eq!(Geometry::load(&path).unwrap(), resized(1000.0, 650.0));
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn maximizing_and_minimizing_preserve_the_normal_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        let mut state = resized(1000.0, 700.0);
        state.observe(
            Size {
                width: 1920.0,
                height: 1080.0,
            },
            true,
            false,
            false,
        );
        state.observe(
            Size {
                width: 0.0,
                height: 0.0,
            },
            false,
            true,
            false,
        );
        state.save(&path).unwrap();
        let mut relaunched = Geometry::load(&path).unwrap();
        assert_eq!(
            relaunched.size,
            Size {
                width: 1000.0,
                height: 700.0
            }
        );
        assert!(relaunched.maximized);
        relaunched.observe(relaunched.size, false, false, false);
        assert!(!relaunched.maximized);
    }

    #[test]
    fn fullscreen_and_invalid_resize_events_do_not_replace_the_normal_size() {
        let mut state = resized(1000.0, 700.0);
        let original = state;
        state.observe(
            Size {
                width: 1920.0,
                height: 1080.0,
            },
            false,
            false,
            true,
        );
        state.observe(
            Size {
                width: 0.0,
                height: 0.0,
            },
            false,
            false,
            false,
        );
        assert_eq!(state, original);
    }

    #[test]
    fn restore_fits_a_smaller_monitor_even_below_the_usual_minimum() {
        let restored = resized(3000.0, 2000.0).fit(Some(Size {
            width: 800.0,
            height: 500.0,
        }));
        assert_eq!(
            restored.size,
            Size {
                width: 800.0,
                height: 500.0
            }
        );
        assert_eq!(
            resized(10.0, 10.0)
                .fit(Some(Size {
                    width: 1920.0,
                    height: 1040.0
                }))
                .size,
            MIN_SIZE
        );
    }

    #[test]
    fn valid_size_is_restored_without_changes() {
        let state = resized(1100.0, 750.0);
        assert_eq!(
            state.fit(Some(Size {
                width: 1600.0,
                height: 1000.0
            })),
            state
        );
    }

    #[test]
    fn unknown_or_invalid_monitor_uses_a_bounded_fallback() {
        let huge = resized(f64::MAX, f64::MAX);
        assert_eq!(huge.fit(None).size, DEFAULT_SIZE);
        assert_eq!(
            huge.fit(Some(Size {
                width: f64::NAN,
                height: 0.0
            }))
            .size,
            DEFAULT_SIZE
        );
    }

    #[test]
    fn saved_sizes_use_logical_pixels_across_dpi_changes() {
        let logical = Size::from_physical(1500, 1050, 1.5).unwrap();
        assert_eq!(
            logical,
            Size {
                width: 1000.0,
                height: 700.0
            }
        );
        let state = resized(logical.width, logical.height);
        assert_eq!(state.fit(Size::from_physical(1920, 1200, 1.25)), state);
        assert!(Size::from_physical(1000, 700, 0.0).is_none());
        assert!(Size::from_physical(1000, 700, f64::NAN).is_none());
    }

    #[test]
    fn bad_saved_files_fall_back_without_preventing_startup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        assert_eq!(Geometry::load(&path).unwrap(), Geometry::default());
        for bytes in [
            b"not json".as_slice(),
            br#"{"size":{"width":0,"height":700}}"#,
            br#"{"size":{"width":-10,"height":700}}"#,
            br#"{"size":{"width":1000}}"#,
            &[b' '; 4097],
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(
                Geometry::load(&path).unwrap_or_default(),
                Geometry::default()
            );
        }
    }

    #[test]
    fn a_failed_save_keeps_the_previous_state_readable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state.json");
        let previous = resized(1000.0, 700.0);
        previous.save(&path).unwrap();
        std::fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(resized(1400.0, 900.0).save(&path).is_err());
        assert_eq!(Geometry::load(&path).unwrap(), previous);
    }

    #[test]
    fn old_or_offscreen_coordinates_are_never_restored() {
        let state: Geometry =
            serde_json::from_str(r#"{"size":{"width":1000,"height":700},"x":999999,"y":-999999}"#)
                .unwrap();
        assert_eq!(
            state.size,
            Size {
                width: 1000.0,
                height: 700.0
            }
        );
        // A secondary display may have negative coordinates. Keep the whole
        // window inside its work area, including a taskbar along the top.
        assert_eq!(centered(-1920, 40, 1920, 1040, 1000, 740), (-1460, 190));
    }
}
