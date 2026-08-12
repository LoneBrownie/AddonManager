//! What changed in the build that is running.
//!
//! `CHANGELOG.md` is compiled into the binary rather than fetched. Three
//! reasons, in order of how much they matter:
//!
//! * The notes are shown *after* an update has installed and the app has
//!   restarted, which is exactly when asking the network for them would be an
//!   unnecessary way to fail. A build always knows what it is.
//! * They cannot disagree with the binary. A fetched note describes whatever
//!   the release page says today; an embedded one describes the code actually
//!   running.
//! * The release notes on GitHub are generated from this same file, so there is
//!   one source and no second place to keep in step.

use serde::{Deserialize, Serialize};

/// The changelog as it stood when this binary was compiled.
const CHANGELOG: &str = include_str!("../../CHANGELOG.md");

/// The version this binary was compiled as.
///
/// `check-bundle-config.mjs` holds this in agreement with `tauri.conf.json` and
/// `package.json`, so it is also the version the updater reports.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatsNewDto {
    pub version: String,
    /// The changelog section, as Markdown. Rendered by the interface, which
    /// supports the small subset this file actually uses.
    pub notes: String,
}

/// The changelog section for one version, without its heading.
///
/// Sections are `## <version> — <date>`, and one runs until the next `##`. The
/// same shape `scripts/changelog.mjs` reads to build the release notes — kept
/// deliberately simple so the two cannot disagree about where a section ends.
pub fn section_for(version: &str) -> Option<String> {
    let mut body: Vec<&str> = Vec::new();
    let mut inside = false;

    for line in CHANGELOG.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            if inside {
                break;
            }
            // The version is the first word of the heading; the date follows it.
            inside = heading.split_whitespace().next() == Some(version);
            continue;
        }
        if inside {
            body.push(line);
        }
    }

    let text = body.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The version being built must have notes, or an update installs and then
    /// has nothing to say for itself. `scripts/changelog.mjs` enforces the same
    /// thing at release time; this catches it at `cargo test` time.
    #[test]
    fn the_running_version_has_a_changelog_section() {
        assert!(
            section_for(VERSION).is_some(),
            "CHANGELOG.md has no section for {VERSION} — add one before releasing"
        );
    }

    #[test]
    fn a_section_stops_at_the_next_version() {
        let notes = section_for("2.0.0-beta.1").unwrap_or_default();
        assert!(notes.contains("First public build"));
        assert!(
            !notes.contains("## 2.0.0-beta.2"),
            "a section must not run into the one below it"
        );
    }

    #[test]
    fn the_heading_itself_is_not_part_of_the_notes() {
        let notes = section_for("2.0.0-beta.1").unwrap_or_default();
        assert!(!notes.starts_with("##"));
        assert!(!notes.starts_with("2.0.0-beta.1"));
    }

    #[test]
    fn an_unknown_version_has_no_section() {
        assert!(section_for("9.9.9").is_none());
        assert!(section_for("").is_none());
    }

    /// A prefix must not match: `2.0.0-beta.1` is not `2.0.0-beta.10`, and
    /// `2.0.0` is not `2.0.0-beta.7`.
    #[test]
    fn versions_match_whole_words_only() {
        let first = section_for("2.0.0-beta.1").unwrap_or_default();
        assert!(
            !first.contains("Change folder"),
            "matched a later beta's section"
        );
        // Strict prefixes of real headings, which are not themselves headings.
        assert!(section_for("2.0").is_none());
        assert!(section_for("2.0.0-beta").is_none());
    }
}
