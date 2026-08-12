//! Archive extraction, with limits the caller controls.
//!
//! V1 called `zip.extractAllTo(path, true)` and delegated every safety question
//! to adm-zip — no entry cap, no size cap, no explicit traversal or symlink
//! rejection (V2-PLAN.md S2). Since this program extracts arbitrary
//! third-party archives, the checks are done here, explicitly, and they fail
//! closed.

use std::collections::BTreeSet;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::paths;

/// Ceilings applied to every archive. Defaults are far above any real addon
/// (the largest, Questie, is tens of megabytes) and far below anything that
/// would exhaust a disk.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_entries: usize,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
    /// Highest tolerated total compression ratio, to stop zip bombs.
    pub max_ratio: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_entries: 10_000,
            max_entry_bytes: 256 * 1024 * 1024,
            max_total_bytes: 1024 * 1024 * 1024,
            max_ratio: 200,
        }
    }
}

/// What an extraction produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    /// Directories containing at least one `.toc`, relative to the extraction
    /// root — in other words, the actual addon folders.
    pub addon_dirs: Vec<PathBuf>,
    pub files_written: usize,
    pub bytes_written: u64,
}

/// Extract `reader` into `dest`, enforcing `limits`.
///
/// `dest` must already exist. Every entry is validated before anything is
/// written, so a rejected archive leaves no partial output.
pub fn extract<R: Read + Seek>(reader: R, dest: &Path, limits: Limits) -> Result<Extracted> {
    let mut archive = zip::ZipArchive::new(reader)?;

    if archive.len() > limits.max_entries {
        return Err(Error::ArchiveRejected(format!(
            "{} entries exceeds the limit of {}",
            archive.len(),
            limits.max_entries
        )));
    }

    // --- pass 1: validate everything, write nothing ---
    let mut planned: Vec<(usize, PathBuf)> = Vec::new();
    let mut total_uncompressed: u64 = 0;
    let mut total_compressed: u64 = 0;

    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let raw_name = entry.name().to_string();

        // Symlinks can point anywhere; an addon has no legitimate use for one.
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err(Error::unsafe_path(raw_name, "archive contains a symlink"));
            }
        }

        if entry.is_dir() {
            continue;
        }

        total_uncompressed = total_uncompressed.saturating_add(entry.size());
        total_compressed = total_compressed.saturating_add(entry.compressed_size());

        if entry.size() > limits.max_entry_bytes {
            return Err(Error::ArchiveRejected(format!(
                "entry {raw_name:?} is {} bytes, over the per-entry limit of {}",
                entry.size(),
                limits.max_entry_bytes
            )));
        }
        if total_uncompressed > limits.max_total_bytes {
            return Err(Error::ArchiveRejected(format!(
                "uncompressed size exceeds the limit of {} bytes",
                limits.max_total_bytes
            )));
        }

        // Rejects traversal, absolute and drive-qualified paths, device names,
        // and strips archive junk. Fails closed on anything unexpected.
        let relative = paths::split_relative(&raw_name)?;
        let mut target = dest.to_path_buf();
        for component in &relative {
            target.push(component);
        }
        planned.push((index, target));
    }

    // Ratio is only meaningful once there is something to compress.
    if total_compressed > 0 && total_uncompressed / total_compressed.max(1) > limits.max_ratio {
        return Err(Error::ArchiveRejected(format!(
            "compression ratio {}:1 exceeds the limit of {}:1",
            total_uncompressed / total_compressed.max(1),
            limits.max_ratio
        )));
    }

    // --- pass 2: write ---
    let mut files_written = 0usize;
    let mut bytes_written = 0u64;
    let mut addon_dirs: BTreeSet<PathBuf> = BTreeSet::new();

    for (index, target) in planned {
        // Belt and braces: the lexical checks above already guarantee this, but
        // confinement is cheap and this is the last point before a write.
        paths::confine(dest, &target)?;

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| Error::io(parent, e))?;
        }

        let mut entry = archive.by_index(index)?;

        // Pass 1 checked the size the central directory *declares*. That is a
        // number in the archive, not a fact about it: the zip crate bounds a
        // reader by the entry's compressed length, so the decompressor will
        // happily emit as many bytes as the compressed stream asks it to,
        // however few it claimed. An entry declaring a kilobyte can therefore
        // write gigabytes, and every check above would have passed. So the
        // write is bounded too, and the declared size is held to.
        let declared = entry.size();
        let mut bounded = (&mut entry).take(declared.saturating_add(1));
        let mut file = std::fs::File::create(&target).map_err(|e| Error::io(&target, e))?;
        let copied = std::io::copy(&mut bounded, &mut file).map_err(|e| Error::io(&target, e))?;
        file.flush().map_err(|e| Error::io(&target, e))?;

        if copied > declared {
            return Err(Error::ArchiveRejected(format!(
                "entry {:?} declared {declared} bytes but contains more",
                target.file_name().unwrap_or_default()
            )));
        }

        files_written += 1;
        bytes_written = bytes_written.saturating_add(copied);
        if bytes_written > limits.max_total_bytes {
            return Err(Error::ArchiveRejected(format!(
                "extraction exceeded the limit of {} bytes",
                limits.max_total_bytes
            )));
        }

        if is_toc(&target) {
            if let Some(parent) = target.parent() {
                if let Ok(relative) = parent.strip_prefix(dest) {
                    addon_dirs.insert(relative.to_path_buf());
                }
            }
        }
    }

    if addon_dirs.is_empty() {
        return Err(Error::NoAddonFolders);
    }

    // Keep only the outermost ones. Plenty of addons vendor their libraries,
    // and some of those libraries ship a `.toc` of their own — without this,
    // each embedded library is treated as an addon in its own right and copied
    // into `Interface/AddOns` as a sibling, as well as remaining nested inside
    // the addon that bundles it. A directory inside another addon's directory
    // is part of that addon, not a separate one.
    let top_level: Vec<PathBuf> = addon_dirs
        .iter()
        .filter(|dir| {
            !dir.ancestors()
                .skip(1)
                .any(|ancestor| addon_dirs.contains(ancestor))
        })
        .cloned()
        .collect();

    Ok(Extracted {
        addon_dirs: top_level,
        files_written,
        bytes_written,
    })
}

fn is_toc(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("toc"))
}

/// SHA-256 of a file, recorded against an installation for troubleshooting.
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|e| Error::io(path, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| Error::io(path, e))?;
        if read == 0 {
            break;
        }
        match buffer.get(..read) {
            Some(chunk) => hasher.update(chunk),
            None => break,
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Names of the `.toc` files directly inside `dir`.
pub fn toc_file_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_file() && is_toc(&e.path()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    /// Build an in-memory zip from (name, contents) pairs.
    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = SimpleFileOptions::default();
            for (name, contents) in entries {
                if writer.start_file(*name, options).is_err() {
                    break;
                }
                if writer.write_all(contents).is_err() {
                    break;
                }
            }
            let _ = writer.finish();
        }
        buffer.into_inner()
    }

    fn extract_to_temp(bytes: Vec<u8>) -> (tempfile::TempDir, Result<Extracted>) {
        let tmp = match tempfile::tempdir() {
            Ok(t) => t,
            Err(e) => {
                return (
                    tempfile::TempDir::new().unwrap_or_else(|_| panic!("{e}")),
                    Err(Error::BareIo(e)),
                )
            }
        };
        let result = extract(Cursor::new(bytes), tmp.path(), Limits::default());
        (tmp, result)
    }

    /// A vendored library that ships its own `.toc` is part of the addon that
    /// bundles it, not a second addon. Without this it would be copied into
    /// `Interface/AddOns` alongside its host *and* stay nested inside it.
    #[test]
    fn a_bundled_library_is_not_treated_as_its_own_addon() {
        let bytes = zip_with(&[
            (
                "NotPlater-3.2.4/NotPlater-3.3.5.toc",
                b"## Interface: 30300\n",
            ),
            ("NotPlater-3.2.4/NotPlater.lua", b"-- code\n"),
            (
                "NotPlater-3.2.4/libs/LibStub/LibStub.toc",
                b"## Interface: 30300\n",
            ),
            ("NotPlater-3.2.4/libs/LibStub/LibStub.lua", b"-- lib\n"),
        ]);
        let (tmp, result) = extract_to_temp(bytes);
        let extracted = result.unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            extracted.addon_dirs,
            vec![PathBuf::from("NotPlater-3.2.4")],
            "the bundled library must not become a top-level addon folder"
        );
        // It is still on disk, still where the addon expects to find it.
        assert!(tmp
            .path()
            .join("NotPlater-3.2.4/libs/LibStub/LibStub.lua")
            .exists());
    }

    /// Genuine siblings are still separate — this is WeakAuras and
    /// WeakAuras_Options, not a library.
    #[test]
    fn sibling_addon_folders_are_all_kept() {
        let bytes = zip_with(&[
            (
                "Repo-main/WeakAuras/WeakAuras.toc",
                b"## Interface: 30300\n",
            ),
            (
                "Repo-main/WeakAuras_Options/WeakAuras_Options.toc",
                b"## Interface: 30300\n",
            ),
        ]);
        let (_tmp, result) = extract_to_temp(bytes);
        let extracted = result.unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(
            extracted.addon_dirs,
            vec![
                PathBuf::from("Repo-main/WeakAuras"),
                PathBuf::from("Repo-main/WeakAuras_Options"),
            ]
        );
    }

    // --- happy path ---

    #[test]
    fn extracts_a_normal_addon() {
        let bytes = zip_with(&[
            ("MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
            ("MyAddon/Core.lua", b"-- code\n"),
        ]);
        let (tmp, result) = extract_to_temp(bytes);
        let extracted = result.unwrap_or_else(|e| panic!("{e}"));

        assert_eq!(extracted.addon_dirs, vec![PathBuf::from("MyAddon")]);
        assert_eq!(extracted.files_written, 2);
        assert!(tmp.path().join("MyAddon/MyAddon.toc").is_file());
    }

    #[test]
    fn finds_several_addon_folders_in_one_archive() {
        let bytes = zip_with(&[
            ("WeakAuras/WeakAuras.toc", b"## Interface: 30300\n"),
            (
                "WeakAuras_Options/WeakAuras_Options.toc",
                b"## Interface: 30300\n",
            ),
            ("README.md", b"not an addon\n"),
        ]);
        let (_tmp, result) = extract_to_temp(bytes);
        let extracted = result.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            extracted.addon_dirs,
            vec![
                PathBuf::from("WeakAuras"),
                PathBuf::from("WeakAuras_Options")
            ]
        );
    }

    #[test]
    fn handles_the_github_wrapper_directory() {
        // GitHub archives wrap everything in `repo-main/`.
        let bytes = zip_with(&[
            ("MyAddon-main/MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
            ("MyAddon-main/MyAddon/Core.lua", b"-- code\n"),
        ]);
        let (_tmp, result) = extract_to_temp(bytes);
        let extracted = result.unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            extracted.addon_dirs,
            vec![PathBuf::from("MyAddon-main/MyAddon")]
        );
    }

    #[test]
    fn strips_macos_metadata_directories() {
        let bytes = zip_with(&[
            ("MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
            ("__MACOSX/MyAddon/._MyAddon.toc", b"junk"),
        ]);
        let (tmp, result) = extract_to_temp(bytes);
        assert!(result.is_ok());
        assert!(
            !tmp.path().join("__MACOSX").exists(),
            "__MACOSX must not be written"
        );
    }

    // --- zip slip (V2-PLAN.md S2). These must fail closed, permanently. ---

    #[test]
    fn rejects_parent_traversal_entries() {
        let bytes = zip_with(&[("../evil.toc", b"pwned")]);
        let (tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
        assert!(
            !tmp.path()
                .parent()
                .is_some_and(|p| p.join("evil.toc").exists()),
            "nothing may be written outside the destination"
        );
    }

    #[test]
    fn rejects_deep_traversal_entries() {
        let bytes = zip_with(&[("good/../../../../etc/evil.toc", b"pwned")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
    }

    #[test]
    fn rejects_absolute_entries() {
        let bytes = zip_with(&[("/etc/evil.toc", b"pwned")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
    }

    #[test]
    fn rejects_windows_drive_entries() {
        let bytes = zip_with(&[("C:/Windows/System32/evil.toc", b"pwned")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
    }

    #[test]
    fn rejects_backslash_traversal() {
        let bytes = zip_with(&[("..\\..\\evil.toc", b"pwned")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
    }

    #[test]
    fn rejects_windows_device_names() {
        let bytes = zip_with(&[("MyAddon/NUL.toc", b"x")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::UnsafePath { .. })));
    }

    #[test]
    fn a_rejected_archive_writes_nothing_at_all() {
        // Validation is a separate pass, so a bad entry late in the archive
        // still prevents the good ones ahead of it from landing.
        let bytes = zip_with(&[
            ("MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
            ("MyAddon/Core.lua", b"-- code\n"),
            ("../escape.lua", b"pwned"),
        ]);
        let (tmp, result) = extract_to_temp(bytes);
        assert!(result.is_err());
        assert!(
            !tmp.path().join("MyAddon").exists(),
            "no partial extraction may survive a rejected archive"
        );
    }

    // --- resource limits ---

    #[test]
    fn rejects_too_many_entries() {
        let limits = Limits {
            max_entries: 2,
            ..Limits::default()
        };
        let bytes = zip_with(&[("A/A.toc", b"x"), ("A/b.lua", b"x"), ("A/c.lua", b"x")]);
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let result = extract(Cursor::new(bytes), tmp.path(), limits);
        assert!(matches!(result, Err(Error::ArchiveRejected(_))));
    }

    #[test]
    fn rejects_entries_over_the_size_cap() {
        let limits = Limits {
            max_entry_bytes: 8,
            ..Limits::default()
        };
        let bytes = zip_with(&[("A/A.toc", b"considerably more than eight bytes")]);
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let result = extract(Cursor::new(bytes), tmp.path(), limits);
        assert!(matches!(result, Err(Error::ArchiveRejected(_))));
    }

    /// Rewrite the uncompressed size the central directory records for an
    /// entry, leaving its data alone.
    ///
    /// This is what a hostile archive looks like from the inside: every number
    /// the validation pass reads is simply untrue. The size cap, the total cap
    /// and the ratio check are all computed from these fields, so a small
    /// enough lie walks past all three.
    fn lie_about_size(mut bytes: Vec<u8>, real: u32, claimed: u32) -> Vec<u8> {
        let real = real.to_le_bytes();
        let claimed = claimed.to_le_bytes();
        let mut index = 0usize;
        while index + 28 <= bytes.len() {
            let is_central_header = bytes.get(index..index + 4) == Some(b"PK\x01\x02".as_slice());
            if is_central_header {
                if let Some(field) = bytes.get_mut(index + 24..index + 28) {
                    if field == real {
                        field.copy_from_slice(&claimed);
                    }
                }
            }
            index += 1;
        }
        bytes
    }

    /// The declared size is a claim, not a fact, and the checks above run on
    /// the claim. So the write itself is bounded by it too — otherwise an entry
    /// declaring sixteen bytes fills the disk and every limit reads as passed.
    #[test]
    fn an_entry_that_understates_its_size_is_cut_off_mid_write() {
        let payload = vec![0u8; 4 * 1024 * 1024];
        let bytes = zip_with(&[
            ("A/A.toc", b"## Interface: 30300\n"),
            ("A/big.bin", &payload),
        ]);
        let bytes = lie_about_size(bytes, 4 * 1024 * 1024, 16);

        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let result = extract(Cursor::new(bytes), tmp.path(), Limits::default());

        assert!(
            matches!(result, Err(Error::ArchiveRejected(_))),
            "an entry longer than it claims must be rejected, got {result:?}"
        );
        let written = std::fs::metadata(tmp.path().join("A/big.bin"))
            .map(|meta| meta.len())
            .unwrap_or(0);
        assert!(
            written <= 17,
            "the write must stop at the declared size, not run to four megabytes ({written} written)"
        );
    }

    #[test]
    fn rejects_zip_bombs_by_ratio() {
        // A megabyte of zeroes compresses to almost nothing.
        let payload = vec![0u8; 1024 * 1024];
        let bytes = zip_with(&[
            ("A/A.toc", b"## Interface: 30300\n"),
            ("A/bomb.bin", &payload),
        ]);
        let limits = Limits {
            max_ratio: 10,
            ..Limits::default()
        };
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let result = extract(Cursor::new(bytes), tmp.path(), limits);
        assert!(
            matches!(result, Err(Error::ArchiveRejected(_))),
            "highly compressible payload should trip the ratio limit"
        );
    }

    // --- shape errors ---

    #[test]
    fn rejects_archives_with_no_toc_anywhere() {
        let bytes = zip_with(&[("docs/README.md", b"no addon here")]);
        let (_tmp, result) = extract_to_temp(bytes);
        assert!(matches!(result, Err(Error::NoAddonFolders)));
    }

    #[test]
    fn toc_file_names_lists_only_tocs() {
        let bytes = zip_with(&[
            ("A/A.toc", b"x"),
            ("A/A_Vanilla.toc", b"x"),
            ("A/Core.lua", b"x"),
        ]);
        let (tmp, result) = extract_to_temp(bytes);
        assert!(result.is_ok());
        assert_eq!(
            toc_file_names(&tmp.path().join("A")),
            vec!["A.toc".to_string(), "A_Vanilla.toc".to_string()]
        );
    }

    #[test]
    fn sha256_is_stable() {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let path = tmp.path().join("f.bin");
        std::fs::write(&path, b"abc").unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            sha256_file(&path).unwrap_or_default(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
