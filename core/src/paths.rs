//! Path canonicalisation and confinement — the security chokepoint.
//!
//! Every write the engine performs resolves through this module. V1 had no
//! equivalent: it joined strings with hard-coded backslashes and trusted the
//! result (V2-PLAN.md S2, S3). Nothing here touches the filesystem except
//! [`confine`], which canonicalises the *root* only, so it works for
//! destinations that do not exist yet.

use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

/// Names Windows refuses to create, with or without an extension.
const RESERVED_WINDOWS_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Archive metadata directories that should never be installed.
const JUNK_COMPONENTS: &[&str] = &["__macosx", "_macosx", ".ds_store", "thumbs.db", ".git"];

/// Canonicalise a path for storing, falling back to the path as given.
///
/// Canonicalising is what makes `D:\Games\WoW` and `D:\Games\..\Games\WoW` the
/// same folder, which is how a duplicate server is detected. The prefix is then
/// taken back off, because the canonical form is for the computer and this
/// value is also the one shown to the user.
pub fn canonical(path: &Path) -> PathBuf {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    strip_verbatim(&resolved)
}

/// Undo Windows' extended-length prefix: `\\?\C:\Games` → `C:\Games`.
///
/// Canonicalising on Windows returns the *verbatim* form, which is what the
/// API wants and not what anybody wrote down — a server's folder rendered as
/// `\\?\C:\Program Files (x86)\World of Warcraft` in the switcher looks like a
/// bug, because it is one.
///
/// Only the two forms with an ordinary equivalent are converted. A volume GUID
/// path (`\\?\Volume{…}`) has no plain spelling and is left as it is.
///
/// The prefix is real on Windows and impossible elsewhere, but the conversion
/// is spelled out rather than compiled away so it can be tested from any
/// platform — this is a bug nobody working on Linux can otherwise see.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    // Only when the path is valid UTF-8, so nothing is ever reconstructed from
    // a lossy conversion. A canonicalised Windows path always is in practice.
    match path.to_str().and_then(plain_form) {
        Some(plain) => PathBuf::from(plain),
        None => path.to_path_buf(),
    }
}

fn plain_form(text: &str) -> Option<String> {
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        // `\\?\UNC\server\share` is the verbatim spelling of `\\server\share`.
        return Some(format!(r"\\{rest}"));
    }

    let rest = text.strip_prefix(r"\\?\")?;
    let mut chars = rest.chars();
    let drive = chars.next()?;
    if drive.is_ascii_alphabetic() && chars.next() == Some(':') {
        Some(rest.to_string())
    } else {
        None
    }
}

/// True if `name` is a Windows device name such as `CON` or `NUL.txt`.
///
/// Checked on every platform, not just Windows: an addon installed on Linux
/// may later be opened by the same user on Windows, and a `NUL` folder makes
/// the whole directory awkward to remove.
pub fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name);
    RESERVED_WINDOWS_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// True if this component is archive noise rather than addon content.
pub fn is_junk_component(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    JUNK_COMPONENTS.iter().any(|junk| lower == *junk)
}

/// Validate a single path component (one folder or file name).
///
/// Rejects traversal, separators, NUL, drive-letter and alternate-data-stream
/// colons, Windows device names, and the trailing dots or spaces that Windows
/// silently strips — which would otherwise let `evil ` and `evil` collide.
pub fn validate_component(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(Error::unsafe_path(name, "empty component"));
    }
    if name == "." || name == ".." {
        return Err(Error::unsafe_path(name, "traversal component"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(Error::unsafe_path(name, "component contains a separator"));
    }
    if name.contains('\0') {
        return Err(Error::unsafe_path(name, "component contains NUL"));
    }
    if name.contains(':') {
        return Err(Error::unsafe_path(
            name,
            "component contains a colon (drive or alternate data stream)",
        ));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err(Error::unsafe_path(
            name,
            "component contains a control character",
        ));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(Error::unsafe_path(
            name,
            "component ends with a dot or space (Windows strips these)",
        ));
    }
    if is_reserved_windows_name(name) {
        return Err(Error::unsafe_path(name, "reserved Windows device name"));
    }
    Ok(())
}

/// Split an archive-relative path into validated components.
///
/// Accepts both separators, because zip entries produced on Windows use
/// backslashes even though the spec says otherwise. Drops `.` segments and
/// junk directories; rejects anything else suspicious.
pub fn split_relative(relative: &str) -> Result<Vec<String>> {
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(Error::unsafe_path(relative, "absolute path"));
    }
    // `C:foo` or `C:/foo` — a drive-relative or drive-absolute path.
    let bytes = relative.as_bytes();
    if bytes.len() >= 2 && bytes.get(1) == Some(&b':') {
        return Err(Error::unsafe_path(relative, "drive-qualified path"));
    }

    let mut out = Vec::new();
    for raw in relative.split(['/', '\\']) {
        if raw.is_empty() || raw == "." {
            continue;
        }
        if is_junk_component(raw) {
            // Skipping junk means `__MACOSX/foo` yields `foo`, which is the
            // behaviour we want for archives, not an error.
            continue;
        }
        validate_component(raw)?;
        out.push(raw.to_string());
    }
    if out.is_empty() {
        return Err(Error::unsafe_path(
            relative,
            "path is empty after normalisation",
        ));
    }
    Ok(out)
}

/// Join an untrusted relative path onto a trusted root.
///
/// The result is guaranteed to be inside `root`.
pub fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for component in split_relative(relative)? {
        path.push(component);
    }
    Ok(path)
}

/// Normalise a path lexically, without touching the filesystem.
///
/// `a/b/../c` becomes `a/c`. Used by [`confine`] so that destinations which do
/// not exist yet can still be checked.
pub fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Verify that `candidate` resolves inside `root`.
///
/// `root` must exist and is canonicalised, which resolves symlinks — so a
/// symlinked AddOns directory is handled correctly rather than rejected.
/// `candidate` need not exist; it is normalised lexically. Returns the
/// canonical-root-relative absolute path.
pub fn confine(root: &Path, candidate: &Path) -> Result<PathBuf> {
    let canonical_root = root
        .canonicalize()
        .map_err(|source| Error::io(root, source))?;

    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        canonical_root.join(candidate)
    };
    let normalized = normalize_lexical(&absolute);

    // Re-canonicalise the deepest existing ancestor so a symlink partway down
    // the path cannot point outside the root.
    let resolved = resolve_existing_prefix(&normalized);

    if !resolved.starts_with(&canonical_root) {
        return Err(Error::PathEscapesRoot {
            path: normalized,
            root: canonical_root,
        });
    }
    Ok(normalized)
}

/// Canonicalise the longest existing prefix of `path`, re-appending the rest.
fn resolve_existing_prefix(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();

    loop {
        if let Ok(canonical) = existing.canonicalize() {
            let mut out = canonical;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name);
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Resolve `Interface/AddOns` beneath a server root, matching whatever casing
/// already exists on disk.
///
/// Wine prefixes and hand-assembled private-server clients are inconsistent
/// about casing (`Interface/AddOns`, `interface/addons`, `Interface/Addons`),
/// and on a case-sensitive filesystem the wrong guess creates a second
/// directory the game never reads.
pub fn resolve_addons_dir(server_root: &Path) -> PathBuf {
    let interface = find_child_ignoring_case(server_root, "Interface")
        .unwrap_or_else(|| server_root.join("Interface"));
    find_child_ignoring_case(&interface, "AddOns").unwrap_or_else(|| interface.join("AddOns"))
}

/// Find a directory entry matching `wanted` case-insensitively.
fn find_child_ignoring_case(parent: &Path, wanted: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(parent).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.eq_ignore_ascii_case(wanted) {
            return Some(entry.path());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    /// The Windows path bug: canonicalising returns the verbatim form, which
    /// was being stored and then shown to the user as their server's folder.
    /// Tested on every platform because it is a string transformation, and
    /// because nobody developing on Linux can otherwise see it.
    mod verbatim {
        use super::super::strip_verbatim;
        use std::path::{Path, PathBuf};

        fn plain(text: &str) -> PathBuf {
            strip_verbatim(Path::new(text))
        }

        #[test]
        fn a_drive_path_loses_the_prefix() {
            assert_eq!(
                plain(r"\\?\C:\Program Files (x86)\World of Warcraft"),
                PathBuf::from(r"C:\Program Files (x86)\World of Warcraft")
            );
        }

        #[test]
        fn a_lowercase_drive_letter_is_handled_too() {
            assert_eq!(plain(r"\\?\d:\Games\WoW"), PathBuf::from(r"d:\Games\WoW"));
        }

        #[test]
        fn a_network_share_gets_its_ordinary_spelling_back() {
            assert_eq!(
                plain(r"\\?\UNC\nas\games\WoW"),
                PathBuf::from(r"\\nas\games\WoW")
            );
        }

        /// A volume GUID has no plain equivalent, so mangling it into one
        /// would produce a path that does not resolve.
        #[test]
        fn a_volume_guid_path_is_left_alone() {
            let raw = r"\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\WoW";
            assert_eq!(plain(raw), PathBuf::from(raw));
        }

        #[test]
        fn an_ordinary_path_is_untouched() {
            assert_eq!(plain(r"C:\Games\WoW"), PathBuf::from(r"C:\Games\WoW"));
            assert_eq!(plain("/home/andy/wow"), PathBuf::from("/home/andy/wow"));
            assert_eq!(plain(r"\\nas\games"), PathBuf::from(r"\\nas\games"));
        }

        /// Twice is the same as once, which is what makes it safe to run over
        /// every stored path on load.
        #[test]
        fn stripping_is_idempotent() {
            let once = plain(r"\\?\C:\Games\WoW");
            assert_eq!(strip_verbatim(&once), once);
        }
    }

    use super::*;

    #[test]
    fn rejects_traversal_in_components() {
        for bad in ["..", ".", "", "a/b", "a\\b", "a\0b"] {
            assert!(
                validate_component(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_windows_device_names() {
        for bad in ["CON", "con", "NUL.txt", "CoM1", "lpt9.lua"] {
            assert!(
                validate_component(bad).is_err(),
                "{bad:?} should be rejected as a device name"
            );
        }
        // Not device names, despite the prefix.
        for ok in ["CONsole", "NULlified", "COM10", "Comment"] {
            assert!(validate_component(ok).is_ok(), "{ok:?} should be allowed");
        }
    }

    #[test]
    fn rejects_trailing_dot_or_space() {
        assert!(validate_component("evil ").is_err());
        assert!(validate_component("evil.").is_err());
        assert!(validate_component("evil.lua").is_ok());
    }

    #[test]
    fn rejects_colon_components() {
        assert!(validate_component("C:").is_err());
        assert!(validate_component("file:stream").is_err());
    }

    // --- zip slip (V2-PLAN.md S2) ---

    #[test]
    fn split_rejects_absolute_and_drive_paths() {
        for bad in [
            "/etc/passwd",
            "\\Windows\\System32",
            "C:/Windows/System32",
            "C:foo",
        ] {
            assert!(split_relative(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn split_rejects_parent_traversal() {
        for bad in [
            "../evil",
            "a/../../evil",
            "..\\..\\evil",
            "good/../../../evil",
        ] {
            assert!(split_relative(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn split_drops_junk_and_current_dir() {
        assert_eq!(
            split_relative("__MACOSX/MyAddon/Core.lua").unwrap_or_default(),
            vec!["MyAddon", "Core.lua"]
        );
        assert_eq!(
            split_relative("./MyAddon/./Core.lua").unwrap_or_default(),
            vec!["MyAddon", "Core.lua"]
        );
    }

    #[test]
    fn split_rejects_paths_that_are_only_junk() {
        assert!(split_relative("__MACOSX/").is_err());
        assert!(split_relative(".DS_Store").is_err());
    }

    #[test]
    fn safe_join_stays_under_root() {
        let root = Path::new("/srv/addons");
        let joined = safe_join(root, "MyAddon/Core.lua").unwrap_or_default();
        assert_eq!(joined, Path::new("/srv/addons/MyAddon/Core.lua"));
        assert!(safe_join(root, "../../etc/passwd").is_err());
    }

    #[test]
    fn normalize_lexical_resolves_parents() {
        assert_eq!(
            normalize_lexical(Path::new("/a/b/../c")),
            PathBuf::from("/a/c")
        );
        assert_eq!(
            normalize_lexical(Path::new("/a/./b/")),
            PathBuf::from("/a/b")
        );
    }

    // --- confinement against a real directory ---

    #[test]
    fn confine_accepts_paths_inside_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let inside = tmp.path().join("MyAddon");
        assert!(confine(tmp.path(), &inside).is_ok());
    }

    #[test]
    fn confine_rejects_paths_outside_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let outside = tmp.path().join("..").join("elsewhere");
        assert!(confine(tmp.path(), &outside).is_err());
    }

    #[test]
    fn confine_rejects_sibling_prefix_collisions() {
        // `/tmp/rootevil` must not be accepted for root `/tmp/root` just
        // because the string starts with it.
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path().join("root");
        let sibling = tmp.path().join("rootevil");
        std::fs::create_dir_all(&root).expect("create root");
        std::fs::create_dir_all(&sibling).expect("create sibling");
        assert!(confine(&root, &sibling).is_err());
    }

    #[test]
    fn resolve_addons_dir_matches_existing_casing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let actual = tmp.path().join("interface").join("addons");
        std::fs::create_dir_all(&actual).expect("create dirs");

        let resolved = resolve_addons_dir(tmp.path());
        assert_eq!(resolved, actual, "should match the casing already on disk");
    }

    #[test]
    fn resolve_addons_dir_falls_back_to_canonical_casing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let resolved = resolve_addons_dir(tmp.path());
        assert_eq!(resolved, tmp.path().join("Interface").join("AddOns"));
    }
}
