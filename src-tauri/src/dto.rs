//! Data the frontend receives.
//!
//! Deliberately separate from the engine's own types. The UI gets flat,
//! camelCase, already-formatted values so it never has to reimplement a rule
//! the engine already owns — and so the engine can change shape without
//! breaking the frontend.

use bam_core::model::{Channel, GameVersion, InstalledAddon, Store};
use bam_core::servers::{Availability, PathVerdict, ServerSummary};
use bam_core::updates::UpdateReport;
use bam_core::version::UpdateStatus;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDto {
    pub id: String,
    pub name: String,
    pub path: String,
    pub version: GameVersion,
    pub version_label: String,
    pub accent: Option<String>,
    pub addon_count: usize,
    /// "ready" | "readOnly" | "unavailable"
    pub availability: String,
    pub can_install: bool,
}

impl From<ServerSummary> for ServerDto {
    fn from(summary: ServerSummary) -> Self {
        ServerDto {
            id: summary.server.id,
            name: summary.server.name,
            path: summary.path_display,
            version: summary.server.version,
            version_label: summary.server.version.label().to_string(),
            accent: summary.server.accent,
            addon_count: summary.addon_count,
            availability: match summary.availability {
                Availability::Ready => "ready",
                Availability::ReadOnly => "readOnly",
                Availability::Unavailable => "unavailable",
            }
            .to_string(),
            can_install: summary.availability.can_install(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderVerdictDto {
    /// "confident" | "plausible" | "rejected"
    pub verdict: String,
    pub reason: Option<String>,
    pub usable: bool,
    /// Suggested server name, taken from the folder.
    pub suggested_name: Option<String>,
}

impl FolderVerdictDto {
    pub fn from_verdict(verdict: PathVerdict, path: &std::path::Path) -> Self {
        let suggested_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string);
        match verdict {
            PathVerdict::Confident => FolderVerdictDto {
                verdict: "confident".into(),
                reason: None,
                usable: true,
                suggested_name,
            },
            PathVerdict::Plausible { reason } => FolderVerdictDto {
                verdict: "plausible".into(),
                reason: Some(reason),
                usable: true,
                suggested_name,
            },
            PathVerdict::Rejected { reason } => FolderVerdictDto {
                verdict: "rejected".into(),
                reason: Some(reason),
                usable: false,
                suggested_name,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonDto {
    pub addon_id: String,
    pub name: String,
    pub source_url: String,
    /// "github" | "gitlab" | "direct"
    pub source_kind: String,
    pub channel: Channel,
    /// The tracked channel no longer matches what is actually installed.
    ///
    /// Answered here rather than left to an update check: switching channel is
    /// a decision the user just made, and the row has to offer the switch
    /// immediately. `UpdateStatus::ChannelChanged` says the same thing but can
    /// only be reached by fetching a ref to compare against, so it is not
    /// available until a check has run.
    pub channel_pending: bool,
    pub pinned: bool,
    /// Already formatted for display — "v1.2.3" or "master@abc1234".
    pub installed_version: String,
    pub latest_version: Option<String>,
    /// "upToDate" | "updateAvailable" | "channelChanged" | "unknown"
    pub update_status: String,
    pub needs_update: bool,
    pub folders: Vec<String>,
    pub installed_at: String,
    /// False when the addon targets a different game version than this server.
    pub version_matches: bool,
}

impl AddonDto {
    pub fn build(store: &Store, installation: &InstalledAddon) -> Option<Self> {
        let addon = store.addon(&installation.addon_id)?;
        Some(AddonDto {
            addon_id: installation.addon_id.clone(),
            name: addon.display_name.clone(),
            source_url: addon.source.web_url(),
            source_kind: match addon.source {
                bam_core::model::Source::Github { .. } => "github",
                bam_core::model::Source::Gitlab { .. } => "gitlab",
                bam_core::model::Source::Direct { .. } => "direct",
            }
            .to_string(),
            channel: installation.channel,
            channel_pending: channel_pending(installation),
            pinned: installation.pinned,
            installed_version: installation.installed_ref.display(),
            latest_version: None,
            update_status: "unknown".to_string(),
            needs_update: false,
            folders: installation.folders.clone(),
            installed_at: installation.installed_at.clone(),
            version_matches: installation.version_matches,
        })
    }

    /// Fold an update check into the row.
    pub fn apply_report(&mut self, report: &UpdateReport) {
        self.latest_version = Some(report.latest.display());
        self.update_status = status_label(report.status).to_string();
        // A pinned addon is never shown as needing an update: the user asked
        // for it to stay where it is.
        self.needs_update = !self.pinned && report.status == UpdateStatus::UpdateAvailable;
    }
}

/// Does the tracked channel disagree with the installed ref?
///
/// A direct download belongs to neither channel, so it never disagrees.
fn channel_pending(installation: &InstalledAddon) -> bool {
    use bam_core::version::Ref;
    matches!(
        (&installation.installed_ref, installation.channel),
        (Ref::Release { .. }, Channel::Source) | (Ref::Branch { .. }, Channel::Release)
    )
}

pub fn status_label(status: UpdateStatus) -> &'static str {
    match status {
        UpdateStatus::UpToDate => "upToDate",
        UpdateStatus::UpdateAvailable => "updateAvailable",
        UpdateStatus::ChannelChanged => "channelChanged",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersionDto {
    pub value: GameVersion,
    pub label: String,
    pub interface_version: u32,
}

pub fn game_versions() -> Vec<GameVersionDto> {
    GameVersion::ALL
        .iter()
        .map(|version| GameVersionDto {
            value: *version,
            label: version.label().to_string(),
            interface_version: version.interface_version(),
        })
        .collect()
}

/// Result of a multi-target operation, one row per server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutcomeDto {
    pub server_id: String,
    pub server_name: String,
    pub ok: bool,
    pub message: String,
}

/// An addon folder found on disk that this app does not manage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundAddonDto {
    pub folder: String,
    pub title: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    /// Sibling folders that look like parts of the same addon. A suggestion
    /// for the user to confirm, never applied automatically.
    pub related: Vec<String>,
    /// False when the addon targets a different game version than this server.
    pub version_matches: bool,
}

impl From<bam_core::adopt::FoundAddon> for FoundAddonDto {
    fn from(found: bam_core::adopt::FoundAddon) -> Self {
        FoundAddonDto {
            folder: found.folder,
            title: found.toc.title,
            version: found.toc.version,
            author: found.toc.author,
            related: found.related,
            version_matches: found.version_matches,
        }
    }
}

/// An addon whose declared dependencies are not all present.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmetDto {
    pub addon_id: String,
    pub addon_name: String,
    pub missing: Vec<String>,
}

/// The curated list, plus why it might be empty.
///
/// "You are offline" and "nobody has curated a list for TBC yet" are different
/// situations and deserve different words, so they are not both an empty array.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResultDto {
    /// "ok" | "noServer" | "noListForVersion" | "unavailable" | "malformed"
    pub status: String,
    pub entries: Vec<CatalogEntryDto>,
}

/// One entry from the curated catalogue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntryDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub repo_url: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    /// Which channel to install this entry on, when it is not the usual one.
    ///
    /// Plenty of 3.3.5a addons never cut a release and are only ever the head
    /// of their default branch. Installing those on the release channel fails
    /// outright — deliberately, since silently switching channel would hide a
    /// mistyped URL — so the list has to say which ones they are. Absent means
    /// releases, which is right for most entries.
    #[serde(default)]
    pub channel: Option<Channel>,
    #[serde(default)]
    pub installed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bam_core::version::Ref;

    /// The switch has to be offered the moment the channel changes, before any
    /// update check has run — otherwise the user is told to switch and given
    /// nothing to press until they check for updates by hand.
    #[test]
    fn a_switch_is_pending_when_the_channel_disagrees_with_what_is_installed() {
        let release_installed = |channel| InstalledAddon {
            server_id: "s".into(),
            addon_id: "a".into(),
            channel,
            pinned: false,
            installed_ref: Ref::release("v1.0.0"),
            archive_sha256: None,
            installed_at: String::new(),
            folders: Vec::new(),
            version_matches: true,
        };
        assert!(channel_pending(&release_installed(Channel::Source)));
        assert!(!channel_pending(&release_installed(Channel::Release)));

        let branch_installed = |channel| InstalledAddon {
            installed_ref: Ref::Branch {
                branch: "master".into(),
                sha: "abc1234".into(),
                committed_at: None,
            },
            ..release_installed(channel)
        };
        assert!(channel_pending(&branch_installed(Channel::Release)));
        assert!(!channel_pending(&branch_installed(Channel::Source)));
    }

    #[test]
    fn a_catalogue_entry_without_a_channel_means_releases() {
        let entry: CatalogEntryDto =
            serde_json::from_str(r#"{"id":"a","name":"A","repoUrl":"https://github.com/o/r"}"#)
                .expect("the common case has no channel field at all");
        assert_eq!(entry.channel, None);
    }

    /// The whole point of the field: addons that never cut a release install
    /// from the branch instead of failing.
    #[test]
    fn a_catalogue_entry_can_ask_for_the_source_channel() {
        let entry: CatalogEntryDto = serde_json::from_str(
            r#"{"id":"a","name":"A","repoUrl":"https://github.com/o/r","channel":"source"}"#,
        )
        .expect("channel is lowercase in the list, matching Channel's serde");
        assert_eq!(entry.channel, Some(Channel::Source));
    }

    #[test]
    fn status_labels_are_stable_strings_for_the_ui() {
        assert_eq!(status_label(UpdateStatus::UpToDate), "upToDate");
        assert_eq!(
            status_label(UpdateStatus::UpdateAvailable),
            "updateAvailable"
        );
        assert_eq!(status_label(UpdateStatus::ChannelChanged), "channelChanged");
    }

    #[test]
    fn game_versions_expose_all_three_with_labels() {
        let versions = game_versions();
        assert_eq!(versions.len(), 3);
        assert!(versions.iter().any(|v| v.interface_version == 30300));
        assert!(versions.iter().all(|v| !v.label.is_empty()));
    }

    fn row() -> AddonDto {
        AddonDto {
            addon_id: "github:o/r".into(),
            name: "R".into(),
            source_url: "https://github.com/o/r".into(),
            source_kind: "github".into(),
            channel: Channel::Release,
            channel_pending: false,
            pinned: false,
            installed_version: "v1.0.0".into(),
            latest_version: None,
            update_status: "unknown".into(),
            needs_update: false,
            folders: vec!["R".into()],
            installed_at: "0".into(),
            version_matches: true,
        }
    }

    #[test]
    fn an_available_update_marks_the_row() {
        let mut dto = row();
        dto.apply_report(&UpdateReport {
            addon_id: "github:o/r".into(),
            status: UpdateStatus::UpdateAvailable,
            installed: Ref::release("v1.0.0"),
            latest: Ref::release("v1.1.0"),
        });
        assert!(dto.needs_update);
        assert_eq!(dto.latest_version.as_deref(), Some("v1.1.0"));
    }

    /// Pinning means "leave this alone", so it must not nag.
    #[test]
    fn a_pinned_addon_never_reports_needing_an_update() {
        let mut dto = row();
        dto.pinned = true;
        dto.apply_report(&UpdateReport {
            addon_id: "github:o/r".into(),
            status: UpdateStatus::UpdateAvailable,
            installed: Ref::release("v1.0.0"),
            latest: Ref::release("v1.1.0"),
        });
        assert!(!dto.needs_update, "a pinned addon must not nag");
        assert_eq!(
            dto.latest_version.as_deref(),
            Some("v1.1.0"),
            "but the newer version is still shown"
        );
    }

    #[test]
    fn a_channel_change_is_not_an_update() {
        let mut dto = row();
        dto.apply_report(&UpdateReport {
            addon_id: "github:o/r".into(),
            status: UpdateStatus::ChannelChanged,
            installed: Ref::release("v1.0.0"),
            latest: Ref::branch("master", "abc1234"),
        });
        assert!(!dto.needs_update);
        assert_eq!(dto.update_status, "channelChanged");
    }
}
