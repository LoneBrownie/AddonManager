//! Reading and writing the shareable addon list.
//!
//! An addon list is what someone moving between installations actually carries:
//! a list of the repositories they run. V1's export said only *which* — a line
//! per addon, `Name: url` — and that is all V1 knew.
//!
//! This app knows more, and writing it down is what lets an import stop
//! guessing. Given the folders an addon occupies, importing into a game
//! directory that already contains it takes the folders over without touching
//! the network at all; given the channel and version, it records what the user
//! actually has rather than "something, we cannot say what". So the format
//! grows four columns:
//!
//! ```text
//! Questie | https://github.com/Questie/Questie | release | v11.2.1 | Questie
//! DevTool | https://github.com/o/DevTool | source | master@3f9c… | DevTool
//! ```
//!
//! Two properties matter more than elegance:
//!
//! * **V1's lists still import.** A line with no `|` in it is read the old way,
//!   which is the only way a migration from V1 can work at all.
//! * **These lists still import into V1-era readers**, and into this app's own
//!   older builds, because every line still contains a bare repository URL that
//!   a URL scrape finds. Nothing is lost by pasting a new list somewhere old.

use crate::model::{Channel, Store};
use crate::version::Ref;

/// One addon, as a list describes it.
///
/// Everything except the URL is optional, because a V1 list supplies nothing
/// else and this type has to be able to represent that honestly.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ListEntry {
    /// What the exporting app called it. For a V1 list this is the `.toc`
    /// title, which is also what a folder on disk reports — so it is the one
    /// thing a V1 list gives us to match against.
    pub name: Option<String>,
    pub url: String,
    pub channel: Option<Channel>,
    pub version: Option<Ref>,
    /// The folders this addon occupies. Empty for a V1 list.
    pub folders: Vec<String>,
}

const HEADER: &str = "# Brownie’s Addon Manager — addon list";

/// Render a server's addons as shareable text.
pub fn render(store: &Store, server_id: &str) -> String {
    let server_line = store
        .server(server_id)
        .map(|server| format!("# {} · {}\n", server.name, server.version.label()))
        .unwrap_or_default();

    let mut lines: Vec<String> = store
        .installed_for(server_id)
        .into_iter()
        .filter_map(|installation| {
            let addon = store.addon(&installation.addon_id)?;
            Some(format!(
                "{} | {} | {} | {} | {}",
                addon.display_name,
                addon.source.web_url(),
                match installation.channel {
                    Channel::Release => "release",
                    Channel::Source => "source",
                },
                write_ref(&installation.installed_ref),
                installation.folders.join(", "),
            ))
        })
        .collect();
    lines.sort_by_key(|line| line.to_lowercase());

    format!(
        "{HEADER}\n{server_line}# name | repository | channel | version | folders\n{}",
        lines.join("\n")
    )
}

/// Read a pasted list.
///
/// Tolerant on purpose: people paste V1 exports, bare URL lists and Discord
/// messages with commentary around them. A line this app wrote is read in full;
/// anything else is scraped for repository URLs and taken at that.
pub fn parse(text: &str) -> Vec<ListEntry> {
    let mut entries: Vec<ListEntry> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        for entry in parse_line(line) {
            // First mention wins: a list that names the same repository twice
            // is describing one addon, and installing it twice would only
            // overwrite the first with the second.
            if !entries.iter().any(|existing| existing.url == entry.url) {
                entries.push(entry);
            }
        }
    }

    entries
}

/// One line, in either format.
fn parse_line(line: &str) -> Vec<ListEntry> {
    let columns: Vec<&str> = line.split('|').map(str::trim).collect();
    if columns.len() >= 2 {
        if let Some(entry) = parse_columns(&columns) {
            return vec![entry];
        }
    }
    parse_loose(line)
}

fn parse_columns(columns: &[&str]) -> Option<ListEntry> {
    // Column 1 is the URL in a line we wrote. Anything else is not our format,
    // however many pipes it happens to contain — a Discord table, say — so it
    // falls through to the scrape rather than being half-read.
    let url = crate::sources::parse_repo_url(columns.get(1)?)
        .ok()?
        .web_url();

    let name = columns
        .first()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    let channel = match columns.get(2).map(|value| value.to_ascii_lowercase()) {
        Some(value) if value == "source" => Some(Channel::Source),
        Some(value) if value == "release" => Some(Channel::Release),
        _ => None,
    };

    let version = columns
        .get(3)
        .filter(|value| !value.is_empty())
        .and_then(|value| read_ref(value, channel));

    let folders: Vec<String> = columns
        .get(4)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|folder| !folder.is_empty())
                // A folder name that could escape the addons directory is not
                // one we will act on, whoever wrote the list.
                .filter(|folder| crate::paths::validate_component(folder).is_ok())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    Some(ListEntry {
        name,
        url,
        channel,
        version,
        folders,
    })
}

/// A V1 line, a bare URL, or prose with URLs in it.
///
/// `Name: https://…` gives up a name, which is worth having: V1 wrote the
/// `.toc` title there, and that is what a folder on disk reports about itself.
fn parse_loose(line: &str) -> Vec<ListEntry> {
    let name = line
        .split_once(": ")
        .map(|(before, _)| before.trim())
        .filter(|before| !before.is_empty() && !before.contains("://") && !before.contains('/'))
        .map(str::to_string);

    let mut found = Vec::new();
    for token in line.split([' ', '\t', ',', ';', '<', '>', '"', '\'', '(', ')']) {
        let cleaned = token.trim().trim_end_matches(['.', ':', '!', '?']);
        if !cleaned.contains("github.com") && !cleaned.contains("gitlab.com") {
            continue;
        }
        let Ok(source) = crate::sources::parse_repo_url(cleaned) else {
            continue;
        };
        found.push(ListEntry {
            // Only when the line describes one addon. A sentence with three
            // URLs in it is not naming any of them.
            name: name.clone(),
            url: source.web_url(),
            ..ListEntry::default()
        });
    }

    if found.len() > 1 {
        for entry in found.iter_mut() {
            entry.name = None;
        }
    }
    found
}

/// A ref as a list writes it: lossless, unlike [`Ref::display`].
pub fn write_ref(reference: &Ref) -> String {
    match reference {
        // The full commit, not the shortened form the row displays: a seven
        // character sha read back in would not equal the one the forge reports,
        // and every check would then claim an update.
        Ref::Branch { branch, sha, .. } => format!("{branch}@{sha}"),
        Ref::Unknown => "unknown".to_string(),
        other => other.display(),
    }
}

/// The inverse of [`write_ref`].
pub fn read_ref(value: &str, channel: Option<Channel>) -> Option<Ref> {
    if value.eq_ignore_ascii_case("unknown") {
        return Some(Ref::Unknown);
    }
    // The channel says which kind this is; the shape of the string is only
    // consulted when the list did not say. A tag can contain an `@`.
    let branch_like = || value.split_once('@').map(|(b, s)| Ref::branch(b, s));
    match channel {
        Some(Channel::Source) => branch_like(),
        Some(Channel::Release) => Some(Ref::release(value)),
        None => branch_like().or_else(|| Some(Ref::release(value))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{GameVersion, InstalledAddon, Server, Source};

    fn store_with(installations: Vec<InstalledAddon>) -> (Store, String) {
        let mut store = Store::default();
        let server = Server::new("Epoch", "/games/epoch", GameVersion::Wotlk);
        let id = server.id.clone();
        store.servers.push(server);

        for installation in installations {
            let source = Source::Github {
                owner: "o".into(),
                repo: installation.addon_id.replace("github:o/", ""),
            };
            let name = source.repo_name().unwrap_or("x").to_string();
            store.addons.push(crate::model::Addon::new(source, name));
            store.upsert_installation(InstalledAddon {
                server_id: id.clone(),
                ..installation
            });
        }
        (store, id)
    }

    fn installed(addon: &str, channel: Channel, r#ref: Ref, folders: &[&str]) -> InstalledAddon {
        InstalledAddon {
            server_id: String::new(),
            addon_id: format!("github:o/{addon}"),
            channel,
            pinned: false,
            installed_ref: r#ref,
            folders: folders.iter().map(|f| f.to_string()).collect(),
            archive_sha256: None,
            installed_at: "0".into(),
            version_matches: true,
        }
    }

    #[test]
    fn an_exported_list_carries_channel_version_and_folders() {
        let (store, id) = store_with(vec![installed(
            "Questie",
            Channel::Release,
            Ref::release("v11.2.1"),
            &["Questie"],
        )]);

        let text = render(&store, &id);
        assert!(
            text.contains("Questie | https://github.com/o/Questie | release | v11.2.1 | Questie"),
            "got:\n{text}"
        );
    }

    /// Round-tripping is the property that matters: what an export writes, an
    /// import has to read back as the same thing.
    #[test]
    fn a_list_round_trips_through_export_and_import() {
        let (store, id) = store_with(vec![
            installed(
                "Questie",
                Channel::Release,
                Ref::release("v11.2.1"),
                &["Questie"],
            ),
            installed(
                "WeakAuras",
                Channel::Release,
                Ref::release("v2.4.8"),
                &["WeakAuras", "WeakAuras_Options"],
            ),
            installed(
                "DevTool",
                Channel::Source,
                Ref::branch("master", "abc1234def5678"),
                &["DevTool"],
            ),
            installed("Skada", Channel::Release, Ref::Unknown, &["Skada"]),
        ]);

        let entries = parse(&render(&store, &id));
        assert_eq!(entries.len(), 4);

        let find = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.name.as_deref() == Some(name))
                .cloned()
                .unwrap_or_default()
        };

        let questie = find("Questie");
        assert_eq!(questie.url, "https://github.com/o/Questie");
        assert_eq!(questie.channel, Some(Channel::Release));
        assert_eq!(questie.version, Some(Ref::release("v11.2.1")));
        assert_eq!(questie.folders, vec!["Questie".to_string()]);

        assert_eq!(
            find("WeakAuras").folders,
            vec!["WeakAuras".to_string(), "WeakAuras_Options".to_string()]
        );

        let devtool = find("DevTool");
        assert_eq!(devtool.channel, Some(Channel::Source));
        assert_eq!(
            devtool.version,
            Some(Ref::branch("master", "abc1234def5678")),
            "the whole commit, not the shortened display form"
        );

        assert_eq!(find("Skada").version, Some(Ref::Unknown));
    }

    /// The migration path. V1 wrote nothing but a name and a URL, and that has
    /// to keep working exactly as it did.
    #[test]
    fn a_v1_list_still_imports() {
        let text = "Questie: https://github.com/o/questie\nAtlasLoot: https://gitlab.com/t/atlas\n";
        let entries = parse(text);

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].url, "https://github.com/o/questie");
        assert_eq!(
            entries[0].name.as_deref(),
            Some("Questie"),
            "V1 put the .toc title here, which is what a folder on disk reports"
        );
        assert_eq!(entries[0].channel, None, "V1 knew of no such thing");
        assert_eq!(entries[0].version, None);
        assert!(entries[0].folders.is_empty());
    }

    #[test]
    fn urls_pasted_out_of_a_chat_message_still_work() {
        let entries =
            parse("hey grab <https://github.com/o/r> and (https://github.com/a/b) thanks");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].url, "https://github.com/o/r");
        assert_eq!(
            entries[0].name, None,
            "a sentence with two URLs in it is not naming either of them"
        );
    }

    #[test]
    fn a_repository_named_twice_is_one_addon() {
        let entries = parse(
            "Questie: https://github.com/o/questie\nQuestie again: https://github.com/o/questie",
        );
        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let entries = parse("# a header\n\n   \nQuestie: https://github.com/o/questie");
        assert_eq!(entries.len(), 1);
    }

    /// Half-reading a line that merely contains a pipe would be worse than not
    /// reading it: the URL is what matters, and the scrape still finds it.
    #[test]
    fn a_line_with_pipes_that_is_not_ours_falls_back_to_the_scrape() {
        let entries = parse("| Questie | see https://github.com/o/questie | great addon |");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].url, "https://github.com/o/questie");
        assert!(entries[0].folders.is_empty());
    }

    /// A folder name out of a pasted file is not a name to act on unchecked.
    #[test]
    fn folder_names_that_could_escape_the_addons_directory_are_dropped() {
        let entries = parse(
            "Bad | https://github.com/o/r | release | v1 | ../../Windows, Fine, ./x, C:\\evil",
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].folders, vec!["Fine".to_string()]);
    }

    /// Lists this app writes have to stay importable by anything that only
    /// knows how to look for URLs — including its own older builds.
    #[test]
    fn a_new_list_is_still_a_list_of_urls() {
        let (store, id) = store_with(vec![installed(
            "Questie",
            Channel::Release,
            Ref::release("v11.2.1"),
            &["Questie"],
        )]);
        let text = render(&store, &id);
        assert!(text.contains("https://github.com/o/Questie"));
    }
}
