//! `.toc` manifest parsing.
//!
//! WoW addon folders declare themselves with a `.toc` file of `## Key: Value`
//! lines. V1 parsed these in three different places with slightly different
//! rules; this is the single implementation.

use std::collections::BTreeMap;

use crate::model::GameVersion;

/// Flavour suffixes addons append to a `.toc` filename so one folder can serve
/// several game versions: `MyAddon_Wrath.toc` alongside `MyAddon_Vanilla.toc`.
const FLAVOUR_SUFFIXES: &[(&str, Option<GameVersion>)] = &[
    ("vanilla", Some(GameVersion::Vanilla)),
    ("classic", Some(GameVersion::Vanilla)),
    ("tbc", Some(GameVersion::Tbc)),
    ("bcc", Some(GameVersion::Tbc)),
    ("wrath", Some(GameVersion::Wotlk)),
    ("wotlk", Some(GameVersion::Wotlk)),
    ("wotlkc", Some(GameVersion::Wotlk)),
    // Retail is out of scope (D8) but the suffix is still recognised so that a
    // retail-only .toc is not mistaken for the addon's base manifest.
    ("mainline", None),
    ("cata", None),
    ("mop", None),
];

/// Parsed contents of a `.toc` file.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TocData {
    pub title: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub notes: Option<String>,
    /// `## Interface:` — may list several values in newer addons.
    pub interface: Vec<u32>,
    pub dependencies: Vec<String>,
    pub website: Option<String>,
    pub repository: Option<String>,
    /// Every `## Key: Value` seen, lowercased keys, for fields we do not model.
    pub extra: BTreeMap<String, String>,
}

impl TocData {
    /// True if this addon declares support for `version`.
    ///
    /// An addon with no `## Interface` line makes no claim, so we do not warn.
    pub fn supports(&self, version: GameVersion) -> bool {
        self.interface.is_empty() || self.interface.contains(&version.interface_version())
    }
}

/// Parse `.toc` file contents.
pub fn parse(contents: &str) -> TocData {
    let mut toc = TocData::default();

    for line in contents.lines() {
        let line = line.trim_start_matches('\u{feff}').trim();
        let Some(rest) = line.strip_prefix("##") else {
            continue;
        };
        let Some((key, value)) = rest.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if value.is_empty() {
            continue;
        }

        match key.as_str() {
            "title" => toc.title = Some(sanitize_title(value)),
            "version" => toc.version = Some(value.to_string()),
            "author" => toc.author = Some(sanitize_title(value)),
            "notes" => toc.notes = Some(sanitize_title(value)),
            "interface" => {
                toc.interface = value
                    .split(',')
                    .filter_map(|part| part.trim().parse::<u32>().ok())
                    .collect();
            }
            "dependencies" | "requireddeps" | "requireddependencies" => {
                for dep in value.split(',') {
                    let dep = dep.trim();
                    if !dep.is_empty() && !toc.dependencies.iter().any(|d| d == dep) {
                        toc.dependencies.push(dep.to_string());
                    }
                }
            }
            "x-website" | "x-web" => toc.website = Some(value.to_string()),
            "x-repository" | "x-repo" | "x-git" => toc.repository = Some(value.to_string()),
            _ => {
                toc.extra.insert(key, value.to_string());
            }
        }
    }

    toc
}

/// Strip WoW markup from a display string.
///
/// `.toc` titles routinely embed colour codes (`|cff33ffcc`), reset markers
/// (`|r`), texture tags (`|T...|t`) and hyperlinks. Rendering those raw puts
/// mojibake in the UI and in exported addon lists.
pub fn sanitize_title(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        if c != '|' {
            // Drop C0 control characters and DEL.
            if (c as u32) >= 0x20 && c != '\u{7f}' {
                out.push(c);
            }
            continue;
        }

        match chars.next() {
            // |cAARRGGBB — colour open. Skip the 8 hex digits that follow.
            Some('c') | Some('C') => {
                for _ in 0..8 {
                    match chars.peek() {
                        Some(h) if h.is_ascii_hexdigit() => {
                            chars.next();
                        }
                        _ => break,
                    }
                }
            }
            // |r — colour reset.
            Some('r') | Some('R') => {}
            // |T...|t — inline texture. Drop the whole run.
            Some('T') | Some('t') => {
                while let Some(inner) = chars.next() {
                    if inner == '|' {
                        chars.next(); // consume the closing 't'
                        break;
                    }
                }
            }
            // |H...|hlabel|h — hyperlink. Drop the target, keep the label.
            Some('H') | Some('h') => {
                // Skip to the terminating '|h' of the target section.
                while let Some(inner) = chars.next() {
                    if inner == '|' {
                        chars.next(); // consume 'h'
                        break;
                    }
                }
            }
            // |n newline, || literal pipe, anything else: drop the escape.
            Some('|') => out.push('|'),
            Some(_) | None => {}
        }
    }

    // Collapse runs of whitespace introduced by the removals.
    let collapsed: Vec<&str> = out.split_whitespace().collect();
    collapsed.join(" ")
}

/// Split a `.toc` filename into its addon name and declared flavour.
///
/// `MyAddon_Wrath.toc` → (`MyAddon`, Some(Wotlk)). A filename with no
/// recognised suffix returns `None` for the flavour, meaning "serves every
/// version".
pub fn parse_toc_filename(file_name: &str) -> Option<(String, Option<GameVersion>)> {
    let stem = file_name
        .strip_suffix(".toc")
        .or_else(|| file_name.strip_suffix(".TOC"))?;
    if stem.is_empty() {
        return None;
    }

    for (suffix, version) in FLAVOUR_SUFFIXES {
        for separator in ['_', '-'] {
            let candidate = format!("{separator}{suffix}");
            if stem.len() > candidate.len() {
                let split_at = stem.len() - candidate.len();
                let (base, tail) = stem.split_at(split_at);
                if tail.eq_ignore_ascii_case(&candidate) {
                    return Some((base.to_string(), *version));
                }
            }
        }
    }

    Some((stem.to_string(), None))
}

/// A `.toc` file found in an addon folder: its name, and what it declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TocFile {
    pub file_name: String,
    pub data: TocData,
}

impl TocFile {
    /// The filename without its extension — which is exactly the folder name
    /// the client requires if this is the manifest it should load.
    pub fn stem(&self) -> Option<&str> {
        self.file_name
            .strip_suffix(".toc")
            .or_else(|| self.file_name.strip_suffix(".TOC"))
            .filter(|stem| !stem.is_empty())
    }

    fn flavour(&self) -> Option<GameVersion> {
        parse_toc_filename(&self.file_name).and_then(|(_, version)| version)
    }
}

/// Pick the `.toc` the client will actually load, for a given game version.
///
/// These clients — 1.12, 2.4.3, 3.3.5a — load `<Folder>/<Folder>.toc` and
/// nothing else. Flavour-suffixed manifests are a much later retail and Classic
/// feature, so on these versions the folder name has to be the *full* stem of
/// the chosen file, suffix included.
///
/// Which file that is depends on the server. NotPlater ships
/// `NotPlater-2.4.3.toc` and `NotPlater-3.3.5.toc` side by side, so the same
/// repository has to land in `NotPlater-3.3.5` on a WotLK server and
/// `NotPlater-2.4.3` on a TBC one — which is why this takes the target version
/// rather than being a per-addon override. An override is a single value and
/// could only ever be right for one of them.
///
/// Preference runs: a `.toc` that declares the target interface, then one whose
/// *filename* names the target flavour, then one making no version claim at
/// all. Within whichever of those applies, prefer a stem matching the extracted
/// folder, then the repository name, then an unsuffixed name, then the
/// alphabetically first — deterministic at every step, never a guess
/// (V2-PLAN.md D-b).
pub fn choose_toc<'a>(
    tocs: &'a [TocFile],
    target: GameVersion,
    extracted_folder: &str,
    repo_name: Option<&str>,
) -> Option<&'a TocFile> {
    let mut usable: Vec<&TocFile> = tocs.iter().filter(|toc| toc.stem().is_some()).collect();
    usable.sort_by(|a, b| a.stem().cmp(&b.stem()));
    if usable.is_empty() {
        return None;
    }

    let declares = |toc: &&TocFile| toc.data.interface.contains(&target.interface_version());
    let named = |toc: &&TocFile| toc.flavour() == Some(target);
    let unclaimed = |toc: &&TocFile| toc.flavour().is_none() && toc.data.interface.is_empty();

    let narrowed: Vec<&TocFile> = [
        usable.iter().copied().filter(declares).collect::<Vec<_>>(),
        usable.iter().copied().filter(named).collect(),
        usable.iter().copied().filter(unclaimed).collect(),
        usable.clone(),
    ]
    .into_iter()
    .find(|set| !set.is_empty())?;

    narrowed
        .iter()
        .find(|toc| matches(toc, extracted_folder))
        .or_else(|| repo_name.and_then(|repo| narrowed.iter().find(|toc| matches(toc, repo))))
        .or_else(|| narrowed.iter().find(|toc| toc.flavour().is_none()))
        .or_else(|| narrowed.first())
        .copied()
}

fn matches(toc: &TocFile, name: &str) -> bool {
    toc.stem()
        .is_some_and(|stem| stem.eq_ignore_ascii_case(name))
}

/// The folder name this addon must have on `target`.
///
/// See [`choose_toc`] — this is that file's stem.
pub fn canonical_addon_name(
    tocs: &[TocFile],
    target: GameVersion,
    extracted_folder: &str,
    repo_name: Option<&str>,
) -> Option<String> {
    choose_toc(tocs, target, extracted_folder, repo_name)
        .and_then(|toc| toc.stem())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_fields() {
        let toc = parse(
            "## Interface: 30300\n\
             ## Title: My Addon\n\
             ## Version: 1.2.3\n\
             ## Author: Someone\n\
             ## Notes: Does a thing\n\
             ## X-Website: https://example.com\n\
             \n\
             Core.lua\n",
        );
        assert_eq!(toc.title.as_deref(), Some("My Addon"));
        assert_eq!(toc.version.as_deref(), Some("1.2.3"));
        assert_eq!(toc.author.as_deref(), Some("Someone"));
        assert_eq!(toc.interface, vec![30300]);
        assert_eq!(toc.website.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn parses_multiple_interface_values() {
        let toc = parse("## Interface: 11200, 20400, 30300\n");
        assert_eq!(toc.interface, vec![11200, 20400, 30300]);
    }

    #[test]
    fn collects_dependencies_from_all_spellings() {
        let toc = parse("## Dependencies: Ace3, LibStub\n## RequiredDeps: Ace3, Foo\n");
        assert_eq!(toc.dependencies, vec!["Ace3", "LibStub", "Foo"]);
    }

    #[test]
    fn ignores_lines_without_a_colon_and_blank_values() {
        let toc = parse("## NotAField\n## Title:\n## Author: Real\n");
        assert_eq!(toc.title, None);
        assert_eq!(toc.author.as_deref(), Some("Real"));
    }

    #[test]
    fn tolerates_a_utf8_bom() {
        let toc = parse("\u{feff}## Title: Bommed\n");
        assert_eq!(toc.title.as_deref(), Some("Bommed"));
    }

    // --- title sanitisation ---

    #[test]
    fn strips_colour_codes() {
        assert_eq!(sanitize_title("|cff33ffccQuestie|r"), "Questie");
        assert_eq!(sanitize_title("|CFF33FFCCUpper|R"), "Upper");
    }

    #[test]
    fn strips_textures_and_keeps_surrounding_text() {
        assert_eq!(
            sanitize_title("|TInterface\\Icons\\foo:16|t AtlasLoot"),
            "AtlasLoot"
        );
    }

    #[test]
    fn keeps_plain_text_untouched() {
        assert_eq!(sanitize_title("Plain Addon Name"), "Plain Addon Name");
    }

    #[test]
    fn collapses_whitespace_left_behind() {
        assert_eq!(sanitize_title("|cff112233A|r   |cff112233B|r"), "A B");
    }

    #[test]
    fn strips_control_characters() {
        assert_eq!(sanitize_title("Ad\u{7}don"), "Addon");
    }

    // --- filenames ---

    #[test]
    fn splits_flavour_suffixes() {
        assert_eq!(
            parse_toc_filename("MyAddon_Wrath.toc"),
            Some(("MyAddon".into(), Some(GameVersion::Wotlk)))
        );
        assert_eq!(
            parse_toc_filename("MyAddon-Vanilla.toc"),
            Some(("MyAddon".into(), Some(GameVersion::Vanilla)))
        );
        assert_eq!(
            parse_toc_filename("MyAddon_TBC.toc"),
            Some(("MyAddon".into(), Some(GameVersion::Tbc)))
        );
    }

    #[test]
    fn plain_filenames_have_no_flavour() {
        assert_eq!(
            parse_toc_filename("MyAddon.toc"),
            Some(("MyAddon".into(), None))
        );
    }

    #[test]
    fn rejects_non_toc_filenames() {
        assert_eq!(parse_toc_filename("Core.lua"), None);
        assert_eq!(parse_toc_filename(".toc"), None);
    }

    #[test]
    fn does_not_split_a_name_that_merely_ends_in_a_suffix_word() {
        // "Vanilla.toc" is the whole name, not a suffix on an empty base.
        assert_eq!(
            parse_toc_filename("Vanilla.toc"),
            Some(("Vanilla".into(), None))
        );
    }

    // --- canonical name, replacing V1's relatedness heuristics ---

    /// `name.toc` declaring `interface`, or nothing if `interface` is 0.
    fn toc_file(name: &str, interface: u32) -> TocFile {
        TocFile {
            file_name: name.to_string(),
            data: TocData {
                interface: if interface == 0 {
                    Vec::new()
                } else {
                    vec![interface]
                },
                ..TocData::default()
            },
        }
    }

    #[test]
    fn canonical_name_prefers_the_extracted_folder_match() {
        let tocs = vec![toc_file("Foo.toc", 0), toc_file("Bar.toc", 0)];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "Bar", None).as_deref(),
            Some("Bar")
        );
    }

    #[test]
    fn canonical_name_falls_back_to_repo_name() {
        let tocs = vec![toc_file("Zeta.toc", 0), toc_file("Alpha.toc", 0)];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "unrelated", Some("Zeta")).as_deref(),
            Some("Zeta")
        );
    }

    #[test]
    fn canonical_name_is_deterministic_without_any_match() {
        let tocs = vec![toc_file("Zeta.toc", 0), toc_file("Alpha.toc", 0)];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "unrelated", None).as_deref(),
            Some("Alpha")
        );
    }

    /// The NotPlater case, and the reason this takes a game version at all.
    ///
    /// Two manifests differing only by a version suffix the flavour list does
    /// not recognise. The old rule stripped nothing, found no match, and took
    /// the alphabetically first — which is the 2.4.3 one, on every server.
    #[test]
    fn two_version_specific_tocs_are_chosen_by_the_servers_version() {
        let tocs = vec![
            toc_file("NotPlater-2.4.3.toc", 20400),
            toc_file("NotPlater-3.3.5.toc", 30300),
        ];
        // Extracted as "NotPlater-<ref>" from a GitHub archive, so neither the
        // folder nor the repo name settles it.
        assert_eq!(
            canonical_addon_name(
                &tocs,
                GameVersion::Wotlk,
                "NotPlater-3.2.4",
                Some("NotPlater")
            )
            .as_deref(),
            Some("NotPlater-3.3.5")
        );
        assert_eq!(
            canonical_addon_name(
                &tocs,
                GameVersion::Tbc,
                "NotPlater-3.2.4",
                Some("NotPlater")
            )
            .as_deref(),
            Some("NotPlater-2.4.3")
        );
    }

    /// The suffix stays on. These clients only ever open `<Folder>/<Folder>.toc`,
    /// so stripping `_Wrath` produced a folder whose manifest the game could
    /// not find, and the addon silently did not load.
    #[test]
    fn a_flavour_suffix_is_kept_because_the_client_matches_on_the_whole_name() {
        let tocs = vec![
            toc_file("WeakAuras_Wrath.toc", 30300),
            toc_file("WeakAuras_Vanilla.toc", 11200),
        ];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "WeakAuras", None).as_deref(),
            Some("WeakAuras_Wrath")
        );
    }

    /// The ordinary case: one manifest, no suffix, no change from before.
    #[test]
    fn a_single_plain_toc_names_the_folder_after_itself() {
        let tocs = vec![toc_file("MyAddon.toc", 30300)];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "MyAddon-main", None).as_deref(),
            Some("MyAddon")
        );
    }

    /// A filename can name a flavour even when the manifest declares nothing.
    #[test]
    fn the_filename_decides_when_no_toc_declares_an_interface() {
        let tocs = vec![
            toc_file("Thing_Vanilla.toc", 0),
            toc_file("Thing_Wrath.toc", 0),
        ];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "Thing", None).as_deref(),
            Some("Thing_Wrath")
        );
    }

    /// Nothing matches the server: still deterministic, still installable, and
    /// the version warning is left to say so.
    #[test]
    fn an_addon_for_another_version_entirely_still_resolves_to_a_name() {
        let tocs = vec![toc_file("OldThing-2.4.3.toc", 20400)];
        assert_eq!(
            canonical_addon_name(&tocs, GameVersion::Wotlk, "OldThing", None).as_deref(),
            Some("OldThing-2.4.3")
        );
    }

    #[test]
    fn supports_reports_declared_versions() {
        let toc = parse("## Interface: 30300\n");
        assert!(toc.supports(GameVersion::Wotlk));
        assert!(!toc.supports(GameVersion::Tbc));

        let silent = parse("## Title: No interface line\n");
        assert!(
            silent.supports(GameVersion::Tbc),
            "no claim means no warning"
        );
    }
}
