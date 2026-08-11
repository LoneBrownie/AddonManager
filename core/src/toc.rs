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

/// Choose the addon's canonical folder name from the `.toc` files it contains.
///
/// The folder name a WoW addon must have is the base name of its `.toc`, so
/// this is a lookup rather than the heuristic pile V1 used
/// (V2-PLAN.md D-b). Where several `.toc` files disagree, prefer one whose
/// base name matches the folder we extracted it from, then one matching the
/// repository name, then the alphabetically first — deterministic either way.
pub fn canonical_addon_name(
    toc_file_names: &[String],
    extracted_folder: &str,
    repo_name: Option<&str>,
) -> Option<String> {
    let mut bases: Vec<String> = toc_file_names
        .iter()
        .filter_map(|name| parse_toc_filename(name).map(|(base, _)| base))
        .collect();
    bases.sort();
    bases.dedup();

    if bases.is_empty() {
        return None;
    }
    if let Some(exact) = bases
        .iter()
        .find(|b| b.eq_ignore_ascii_case(extracted_folder))
    {
        return Some(exact.clone());
    }
    if let Some(repo) = repo_name {
        if let Some(matching) = bases.iter().find(|b| b.eq_ignore_ascii_case(repo)) {
            return Some(matching.clone());
        }
    }
    bases.first().cloned()
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

    #[test]
    fn canonical_name_prefers_the_extracted_folder_match() {
        let tocs = vec!["Foo.toc".to_string(), "Bar.toc".to_string()];
        assert_eq!(
            canonical_addon_name(&tocs, "Bar", None).as_deref(),
            Some("Bar")
        );
    }

    #[test]
    fn canonical_name_falls_back_to_repo_name() {
        let tocs = vec!["Zeta.toc".to_string(), "Alpha.toc".to_string()];
        assert_eq!(
            canonical_addon_name(&tocs, "unrelated", Some("Zeta")).as_deref(),
            Some("Zeta")
        );
    }

    #[test]
    fn canonical_name_is_deterministic_without_any_match() {
        let tocs = vec!["Zeta.toc".to_string(), "Alpha.toc".to_string()];
        assert_eq!(
            canonical_addon_name(&tocs, "unrelated", None).as_deref(),
            Some("Alpha")
        );
    }

    #[test]
    fn multi_flavour_tocs_collapse_to_one_name() {
        let tocs = vec![
            "WeakAuras_Wrath.toc".to_string(),
            "WeakAuras_Vanilla.toc".to_string(),
        ];
        assert_eq!(
            canonical_addon_name(&tocs, "WeakAuras", None).as_deref(),
            Some("WeakAuras")
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
