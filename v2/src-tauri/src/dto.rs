//! Data the frontend receives.
//!
//! Deliberately separate from the engine's own types. The UI gets flat,
//! camelCase, already-formatted values so it never has to reimplement a rule
//! the engine already owns — and so the engine can change shape without
//! breaking the frontend.

use bam_core::install::UpdateReport;
use bam_core::model::{Channel, GameVersion, InstalledAddon, Store};
use bam_core::servers::{Availability, PathVerdict, ServerSummary};
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
    pub pinned: bool,
    /// Already formatted for display — "v1.2.3" or "master@abc1234".
    pub installed_version: String,
    pub latest_version: Option<String>,
    /// "upToDate" | "updateAvailable" | "channelChanged" | "unknown"
    pub update_status: String,
    pub needs_update: bool,
    pub folders: Vec<String>,
    pub installed_at: String,
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
            pinned: installation.pinned,
            installed_version: installation.installed_ref.display(),
            latest_version: None,
            update_status: "unknown".to_string(),
            needs_update: false,
            folders: installation.folders.clone(),
            installed_at: installation.installed_at.clone(),
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
    /// Which game versions this entry targets. Absent means "all".
    #[serde(default)]
    pub game_versions: Vec<GameVersion>,
    #[serde(default)]
    pub installed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use bam_core::version::Ref;

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
            pinned: false,
            installed_version: "v1.0.0".into(),
            latest_version: None,
            update_status: "unknown".into(),
            needs_update: false,
            folders: vec!["R".into()],
            installed_at: "0".into(),
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
