//! What an addon list looks like crossing the boundary.
//!
//! Split from the rest because sharing a set of addons between installs is its
//! own feature with its own engine modules — `bam_core::list` reads and writes
//! the format, `bam_core::import` applies it — and the types that carry it
//! belong beside them rather than among the addon and server rows.

use serde::{Deserialize, Serialize};

use super::AddonDto;
use bam_core::model::Channel;

/// One line of a pasted addon list, as the engine reads it.
///
/// Everything but the URL is optional: a V1 list carries a name and nothing
/// else, and the interface has to be able to say so rather than invent the
/// difference.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntryDto {
    pub name: Option<String>,
    pub url: String,
    pub channel: Option<Channel>,
    /// Formatted for display — "v1.2.3", "master@abc1234", or absent.
    pub version: Option<String>,
    /// The same version, written the way a list writes it.
    ///
    /// Opaque to the interface, which passes it straight back when importing.
    /// `version` shortens a commit to seven characters for reading, and handing
    /// *that* back would record a sha no forge will ever report — every check
    /// would then claim an update.
    pub version_ref: Option<String>,
    pub folders: Vec<String>,
}

impl From<&bam_core::list::ListEntry> for ListEntryDto {
    fn from(entry: &bam_core::list::ListEntry) -> Self {
        ListEntryDto {
            name: entry.name.clone(),
            url: entry.url.clone(),
            channel: entry.channel,
            version: entry
                .version
                .as_ref()
                .filter(|reference| !reference.is_unknown())
                .map(|reference| reference.display()),
            version_ref: entry.version.as_ref().map(bam_core::list::write_ref),
            folders: entry.folders.clone(),
        }
    }
}

impl ListEntryDto {
    /// Back to what the engine works with.
    pub fn into_entry(self) -> Result<bam_core::list::ListEntry, crate::commands::CommandError> {
        // Re-validated here rather than trusted: this arrives from the webview,
        // and a folder name is about to be acted on.
        for folder in &self.folders {
            bam_core::paths::validate_component(folder)?;
        }
        Ok(bam_core::list::ListEntry {
            name: self.name,
            url: self.url,
            channel: self.channel,
            version: self
                .version_ref
                .as_deref()
                .and_then(|value| bam_core::list::read_ref(value, self.channel)),
            folders: self.folders,
        })
    }
}

/// What importing one entry did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedDto {
    pub addon: AddonDto,
    /// True when the addon was already on disk and was taken over rather than
    /// downloaded. Worth reporting: it is the difference between an import that
    /// moved several gigabytes and one that moved none.
    pub adopted: bool,
}
