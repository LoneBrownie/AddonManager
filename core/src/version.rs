//! What we installed, and whether something newer exists.
//!
//! V1 tried to reverse-engineer this at runtime, classifying version strings
//! into "semver", "branch name" or "date-sha" and applying a matrix of special
//! cases — 130 lines that produced phantom updates (V2-PLAN.md D-a). The
//! information it was guessing at was known at install time. So we record it.
//!
//! The rule that makes this tractable: **compare like with like only.** A
//! tagged release is never compared against a branch head. Changing channel is
//! an explicit user action, not something surfaced as an available update.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

/// The exact upstream artifact an installation tracks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Ref {
    Release {
        tag: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        published_at: Option<String>,
    },
    Branch {
        branch: String,
        sha: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        committed_at: Option<String>,
    },
    Direct {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        etag: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_modified: Option<String>,
    },
    /// The files are on disk but this app did not put them there, so which
    /// upstream version they are is genuinely not known.
    ///
    /// Recorded when an addon is adopted — either one the user hands us, or one
    /// an import found already installed. Inventing a tag instead would make the
    /// first update check compare a fiction against a real release, which is the
    /// phantom-update class this whole type exists to prevent.
    Unknown,
}

impl Ref {
    pub fn release(tag: impl Into<String>) -> Self {
        Ref::Release {
            tag: tag.into(),
            published_at: None,
        }
    }

    pub fn branch(branch: impl Into<String>, sha: impl Into<String>) -> Self {
        Ref::Branch {
            branch: branch.into(),
            sha: sha.into(),
            committed_at: None,
        }
    }

    /// Short human-readable label for the UI.
    pub fn display(&self) -> String {
        match self {
            Ref::Release { tag, .. } => tag.clone(),
            Ref::Branch { branch, sha, .. } => {
                let short: String = sha.chars().take(7).collect();
                format!("{branch}@{short}")
            }
            Ref::Direct { etag, .. } => etag.clone().unwrap_or_else(|| "latest".to_string()),
            Ref::Unknown => "unknown version".to_string(),
        }
    }

    /// True when we do not know what is installed.
    pub fn is_unknown(&self) -> bool {
        matches!(self, Ref::Unknown)
    }
}

/// The outcome of an update check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateStatus {
    UpToDate,
    UpdateAvailable,
    /// The two refs are different kinds, so they are not comparable. The user
    /// changed channel; that is an explicit action, not an update.
    ChannelChanged,
}

/// Compare what is installed against what upstream currently offers.
pub fn check(current: &Ref, latest: &Ref) -> UpdateStatus {
    match (current, latest) {
        // Nothing known to compare against. Whatever upstream offers is worth
        // installing, because it is the first version this app can vouch for —
        // and it is an update, not a channel change: the user never chose a
        // channel that these files came from.
        (Ref::Unknown, _) => UpdateStatus::UpdateAvailable,

        (
            Ref::Release {
                tag: current_tag,
                published_at: current_at,
            },
            Ref::Release {
                tag: latest_tag,
                published_at: latest_at,
            },
        ) => {
            if current_tag == latest_tag {
                return UpdateStatus::UpToDate;
            }
            match compare_tags(current_tag, latest_tag) {
                Some(Ordering::Less) => UpdateStatus::UpdateAvailable,
                Some(_) => UpdateStatus::UpToDate,
                // Tags that are not version-like — date stamps, code names.
                // Fall back to publication order, then to "it changed".
                None => match (current_at, latest_at) {
                    (Some(a), Some(b)) if a == b => UpdateStatus::UpToDate,
                    (Some(a), Some(b)) => {
                        if b > a {
                            UpdateStatus::UpdateAvailable
                        } else {
                            UpdateStatus::UpToDate
                        }
                    }
                    _ => UpdateStatus::UpdateAvailable,
                },
            }
        }

        // The commit identifies the artifact, so the branch name is not
        // consulted. This is why V1's hardcoded main==master and dev==develop
        // equivalences are no longer needed.
        (Ref::Branch { sha: current, .. }, Ref::Branch { sha: latest, .. }) => {
            if current == latest {
                UpdateStatus::UpToDate
            } else {
                UpdateStatus::UpdateAvailable
            }
        }

        (
            Ref::Direct {
                etag: current_etag,
                last_modified: current_modified,
                ..
            },
            Ref::Direct {
                etag: latest_etag,
                last_modified: latest_modified,
                ..
            },
        ) => match (current_etag, latest_etag) {
            (Some(a), Some(b)) => {
                if a == b {
                    UpdateStatus::UpToDate
                } else {
                    UpdateStatus::UpdateAvailable
                }
            }
            _ => match (current_modified, latest_modified) {
                (Some(a), Some(b)) if a == b => UpdateStatus::UpToDate,
                _ => UpdateStatus::UpdateAvailable,
            },
        },

        // Different kinds are never compared. This is the single rule that
        // eliminates V1's whole family of phantom updates.
        _ => UpdateStatus::ChannelChanged,
    }
}

/// Compare two version-like tags.
///
/// Returns `None` when either tag is not version-like, so the caller can fall
/// back to publication dates rather than inventing an ordering.
pub fn compare_tags(a: &str, b: &str) -> Option<Ordering> {
    let (a_parts, a_pre) = parse_version(a)?;
    let (b_parts, b_pre) = parse_version(b)?;

    let len = a_parts.len().max(b_parts.len());
    for i in 0..len {
        let x = a_parts.get(i).copied().unwrap_or(0);
        let y = b_parts.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return Some(other),
        }
    }

    // Equal numerically: a pre-release sorts below the plain release, per
    // semver. `1.0.0-beta` < `1.0.0`.
    Some(match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => a_pre.cmp(&b_pre),
    })
}

/// Split a tag into numeric components and a pre-release remainder.
///
/// Accepts the shapes addons actually use: `1.2.3`, `v1.2`, `V1.2.3-beta1`,
/// `r42`. Returns `None` if there is no leading numeric component at all.
fn parse_version(tag: &str) -> Option<(Vec<u64>, String)> {
    let trimmed = tag.trim();
    let body = trimmed
        .strip_prefix(['v', 'V'])
        .or_else(|| trimmed.strip_prefix(['r', 'R']))
        .unwrap_or(trimmed);

    // Split the numeric dotted prefix from any pre-release remainder.
    let (numeric, pre) = match body.find(['-', '+', '_']) {
        Some(idx) => {
            let (head, tail) = body.split_at(idx);
            (head, tail.get(1..).unwrap_or_default().to_string())
        }
        None => (body, String::new()),
    };

    let mut parts = Vec::new();
    for segment in numeric.split('.') {
        let digits: String = segment.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            break;
        }
        parts.push(digits.parse::<u64>().ok()?);
    }

    if parts.is_empty() {
        return None;
    }
    Some((parts, pre))
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- releases ---

    #[test]
    fn identical_tags_are_up_to_date() {
        assert_eq!(
            check(&Ref::release("v1.2.3"), &Ref::release("v1.2.3")),
            UpdateStatus::UpToDate
        );
    }

    #[test]
    fn newer_tag_is_an_update() {
        assert_eq!(
            check(&Ref::release("v1.2.3"), &Ref::release("v1.3.0")),
            UpdateStatus::UpdateAvailable
        );
    }

    #[test]
    fn older_tag_upstream_is_not_an_update() {
        // Upstream deleted a bad release and the previous tag is now latest.
        assert_eq!(
            check(&Ref::release("v2.0.0"), &Ref::release("v1.9.0")),
            UpdateStatus::UpToDate
        );
    }

    #[test]
    fn v_prefix_is_not_a_difference() {
        assert_eq!(
            check(&Ref::release("1.2.3"), &Ref::release("v1.2.3")),
            UpdateStatus::UpToDate,
            "v-prefix alone must not trigger a phantom update"
        );
    }

    #[test]
    fn shorter_versions_compare_as_zero_padded() {
        assert_eq!(compare_tags("1.2", "1.2.0"), Some(Ordering::Equal));
        assert_eq!(compare_tags("1.2", "1.2.1"), Some(Ordering::Less));
    }

    #[test]
    fn prereleases_sort_below_their_release() {
        assert_eq!(compare_tags("1.0.0-beta", "1.0.0"), Some(Ordering::Less));
        assert_eq!(compare_tags("1.0.0", "1.0.0-beta"), Some(Ordering::Greater));
        assert_eq!(
            check(&Ref::release("1.0.0-beta"), &Ref::release("1.0.0")),
            UpdateStatus::UpdateAvailable
        );
    }

    #[test]
    fn double_digit_segments_compare_numerically_not_lexically() {
        // The classic string-comparison bug: "9" > "10" lexically.
        assert_eq!(compare_tags("1.9.0", "1.10.0"), Some(Ordering::Less));
    }

    #[test]
    fn non_version_tags_fall_back_to_publication_date() {
        let current = Ref::Release {
            tag: "spring-patch".into(),
            published_at: Some("2026-01-01T00:00:00Z".into()),
        };
        let older = Ref::Release {
            tag: "winter-patch".into(),
            published_at: Some("2025-01-01T00:00:00Z".into()),
        };
        let newer = Ref::Release {
            tag: "summer-patch".into(),
            published_at: Some("2026-06-01T00:00:00Z".into()),
        };
        assert_eq!(check(&current, &older), UpdateStatus::UpToDate);
        assert_eq!(check(&current, &newer), UpdateStatus::UpdateAvailable);
    }

    #[test]
    fn unparseable_tags_without_dates_assume_change_means_update() {
        assert_eq!(
            check(&Ref::release("alpha"), &Ref::release("bravo")),
            UpdateStatus::UpdateAvailable
        );
    }

    // --- branches ---

    #[test]
    fn same_commit_is_up_to_date() {
        assert_eq!(
            check(
                &Ref::branch("master", "abc1234"),
                &Ref::branch("master", "abc1234")
            ),
            UpdateStatus::UpToDate
        );
    }

    #[test]
    fn new_commit_is_an_update() {
        assert_eq!(
            check(
                &Ref::branch("master", "abc1234"),
                &Ref::branch("master", "def5678")
            ),
            UpdateStatus::UpdateAvailable
        );
    }

    // --- the rule that killed V1's phantom updates ---

    #[test]
    fn release_and_branch_are_never_compared() {
        assert_eq!(
            check(&Ref::release("v1.2.3"), &Ref::branch("master", "abc1234")),
            UpdateStatus::ChannelChanged
        );
        assert_eq!(
            check(&Ref::branch("master", "abc1234"), &Ref::release("v1.2.3")),
            UpdateStatus::ChannelChanged
        );
    }

    #[test]
    fn main_and_master_are_not_a_special_case_anymore() {
        // V1 hardcoded main==master, dev==develop and so on. With the commit
        // recorded, equality of the artifact is all that matters.
        assert_eq!(
            check(
                &Ref::branch("main", "abc1234"),
                &Ref::branch("master", "abc1234")
            ),
            UpdateStatus::UpToDate
        );
    }

    // --- direct downloads ---

    #[test]
    fn direct_downloads_compare_by_etag() {
        let with = |etag: &str| Ref::Direct {
            url: "https://example.com/a.zip".into(),
            etag: Some(etag.into()),
            last_modified: None,
        };
        assert_eq!(check(&with("abc"), &with("abc")), UpdateStatus::UpToDate);
        assert_eq!(
            check(&with("abc"), &with("xyz")),
            UpdateStatus::UpdateAvailable
        );
    }

    #[test]
    fn direct_downloads_fall_back_to_last_modified() {
        let at = |modified: &str| Ref::Direct {
            url: "https://example.com/a.zip".into(),
            etag: None,
            last_modified: Some(modified.into()),
        };
        assert_eq!(
            check(
                &at("Wed, 01 Jan 2026 00:00:00 GMT"),
                &at("Wed, 01 Jan 2026 00:00:00 GMT")
            ),
            UpdateStatus::UpToDate
        );
    }

    // --- adopted files, whose version nobody knows ---

    /// Adopting cannot be allowed to strand an addon. An unknown version has to
    /// resolve to "there is something to install", or the row that most needs a
    /// known version is the one row that can never get one.
    #[test]
    fn an_unknown_version_can_always_be_updated() {
        assert_eq!(
            check(&Ref::Unknown, &Ref::release("v1.2.3")),
            UpdateStatus::UpdateAvailable
        );
        assert_eq!(
            check(&Ref::Unknown, &Ref::branch("master", "abc1234")),
            UpdateStatus::UpdateAvailable
        );
    }

    /// It must not be reported as a channel change: the user never chose a
    /// channel for files this app did not install.
    #[test]
    fn an_unknown_version_is_not_a_channel_change() {
        assert_ne!(
            check(&Ref::Unknown, &Ref::release("v1.2.3")),
            UpdateStatus::ChannelChanged
        );
    }

    // --- display ---

    #[test]
    fn display_shortens_commit_shas() {
        assert_eq!(
            Ref::branch("master", "abc1234def5678").display(),
            "master@abc1234"
        );
        assert_eq!(Ref::release("v1.0.0").display(), "v1.0.0");
    }

    #[test]
    fn refs_round_trip_through_json() {
        for value in [
            Ref::release("v1.0.0"),
            Ref::branch("master", "abc1234"),
            Ref::Unknown,
            Ref::Direct {
                url: "https://example.com/a.zip".into(),
                etag: Some("W/\"1\"".into()),
                last_modified: None,
            },
        ] {
            let json = serde_json::to_string(&value).unwrap_or_default();
            let back: Ref = serde_json::from_str(&json).unwrap_or_else(|_| Ref::release("BROKEN"));
            assert_eq!(value, back, "round-trip failed for {json}");
        }
    }
}
