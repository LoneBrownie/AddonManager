//! The intent-level command surface — the **only** way the UI reaches the disk
//! or the network.
//!
//! There is deliberately no `read_file`, no `write_file`, no `download_to`.
//! V1's preload script exposed exactly those primitives to web content
//! (V2-PLAN.md S1); every command here names a user intention instead, and the
//! engine decides which paths that intention is allowed to touch.

pub mod addons;
pub mod catalog;
pub mod import;
pub mod servers;

use serde::Serialize;

/// A failure the UI can render.
///
/// Errors reach the user, so they carry a message written for a person, plus a
/// stable `kind` the frontend can branch on for the cases that need a specific
/// affordance — a collision needs an "overwrite anyway?" prompt, an unavailable
/// server needs "reconnect the drive".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: String,
    pub message: String,
    /// The folder at fault, for collision errors.
    pub folder: Option<String>,
}

impl From<bam_core::error::Error> for CommandError {
    fn from(error: bam_core::error::Error) -> Self {
        use bam_core::error::Error as E;

        let (kind, folder) = match &error {
            E::UnmanagedCollision { folder } => ("unmanagedCollision", Some(folder.clone())),
            E::ManagedCollision { folder, .. } => ("managedCollision", Some(folder.clone())),
            E::ServerUnavailable { .. } => ("serverUnavailable", None),
            E::NotWritable { .. } => ("notWritable", None),
            E::NotAWowDirectory { .. } => ("notAWowDirectory", None),
            E::UnsupportedRepoUrl(_) => ("unsupportedRepoUrl", None),
            E::NoResolvableRef(_) => ("noResolvableRef", None),
            E::HttpStatus { status, .. } if *status == 403 => ("rateLimited", None),
            E::HttpStatus { .. } | E::Network(_) => ("network", None),
            E::UnsafePath { .. } | E::PathEscapesRoot { .. } | E::ArchiveRejected(_) => {
                ("unsafeArchive", None)
            }
            E::NoAddonFolders => ("noAddonFolders", None),
            E::UnknownServer(_) => ("unknownServer", None),
            _ => ("unexpected", None),
        };

        CommandError {
            kind: kind.to_string(),
            message: friendly_message(&error),
            folder,
        }
    }
}

/// Turn an engine error into something worth showing a person.
///
/// The engine's `Display` is accurate but terse; these add the "and here is
/// what to do about it" half.
fn friendly_message(error: &bam_core::error::Error) -> String {
    use bam_core::error::Error as E;
    match error {
        E::UnmanagedCollision { folder } => format!(
            "The folder \"{folder}\" already exists and this app did not create it. \
             Installing would overwrite whatever is in it."
        ),
        E::ManagedCollision { folder, owner } => format!(
            "The folder \"{folder}\" belongs to \"{owner}\". Remove that addon first \
             if you want this one to take over the folder."
        ),
        E::ServerUnavailable { name, path } => format!(
            "\"{name}\" is not reachable at {}. If it is on an external drive, \
             reconnect it — your addon list has been kept.",
            path.display()
        ),
        E::HttpStatus { status, .. } if *status == 403 => {
            "GitHub is rate limiting anonymous requests. Adding a personal access \
             token in Settings raises the limit from 60 requests an hour to 5,000."
                .to_string()
        }
        E::NoAddonFolders => {
            "That archive does not contain a WoW addon — no folder with a .toc file was found."
                .to_string()
        }
        E::UnsafePath { .. } | E::PathEscapesRoot { .. } => {
            "That archive tried to write outside the AddOns folder, so it was rejected. \
             Nothing was installed."
                .to_string()
        }
        other => other.to_string(),
    }
}

pub type CommandResult<T> = std::result::Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;
    use bam_core::error::Error;

    #[test]
    fn collision_errors_carry_the_folder_for_the_prompt() {
        let error: CommandError = Error::UnmanagedCollision {
            folder: "MyAddon".into(),
        }
        .into();
        assert_eq!(error.kind, "unmanagedCollision");
        assert_eq!(error.folder.as_deref(), Some("MyAddon"));
        assert!(error.message.contains("MyAddon"));
    }

    #[test]
    fn rate_limiting_points_at_the_fix() {
        let error: CommandError = Error::HttpStatus {
            status: 403,
            url: "https://api.github.com/x".into(),
        }
        .into();
        assert_eq!(error.kind, "rateLimited");
        assert!(
            error.message.contains("token"),
            "should tell the user how to fix it"
        );
    }

    #[test]
    fn an_unavailable_server_reassures_rather_than_alarms() {
        let error: CommandError = Error::ServerUnavailable {
            name: "Epoch".into(),
            path: "/mnt/usb/epoch".into(),
        }
        .into();
        assert_eq!(error.kind, "serverUnavailable");
        assert!(
            error.message.contains("kept"),
            "must say the addon list survived"
        );
    }

    #[test]
    fn a_rejected_archive_says_nothing_was_installed() {
        let error: CommandError = Error::unsafe_path("../evil", "traversal").into();
        assert_eq!(error.kind, "unsafeArchive");
        assert!(error.message.contains("Nothing was installed"));
    }
}
