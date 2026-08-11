//! Addon dependencies.
//!
//! Two independent sources, and they answer different questions:
//!
//! * A `.toc` lists **folder names** it requires (`## Dependencies: Ace3`).
//!   Universal — every addon has a `.toc` — but a folder name says nothing
//!   about where to get it, so this can only ever warn.
//! * The curated catalogue lists **entry ids**, and each entry carries a
//!   repository URL. That one can actually be installed, which is why
//!   [`install_order`] exists.
//!
//! V1 parsed the `.toc` field and carried a `dependencies` array in the curated
//! list, and enforced neither.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Server, Store};
use crate::toc;

/// An addon whose declared dependencies are not all present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmetDependency {
    pub addon_id: String,
    pub addon_name: String,
    /// Folder names the addon asked for that are not in the AddOns directory.
    pub missing: Vec<String>,
}

/// Find addons on a server whose `.toc` dependencies are not satisfied.
///
/// Presence is judged by what is on **disk**, not by what this app manages: a
/// dependency the user installed by hand still satisfies the requirement, and
/// reporting it as missing would be wrong.
pub fn unmet(store: &Store, server: &Server) -> Vec<UnmetDependency> {
    if !server.is_available() {
        return Vec::new();
    }
    let addons_dir = server.addons_dir();

    let present: BTreeSet<String> = std::fs::read_dir(&addons_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().is_dir())
                .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let mut results = Vec::new();

    for installation in store.installed_for(&server.id) {
        let mut missing = BTreeSet::new();

        for folder in &installation.folders {
            for name in crate::archive::toc_file_names(&addons_dir.join(folder)) {
                let Ok(contents) = std::fs::read_to_string(addons_dir.join(folder).join(&name))
                else {
                    continue;
                };
                for required in toc::parse(&contents).dependencies {
                    if !present.contains(&required.to_lowercase()) {
                        missing.insert(required);
                    }
                }
            }
        }

        if missing.is_empty() {
            continue;
        }
        results.push(UnmetDependency {
            addon_name: store
                .addon(&installation.addon_id)
                .map(|addon| addon.display_name.clone())
                .unwrap_or_else(|| installation.addon_id.clone()),
            addon_id: installation.addon_id.clone(),
            missing: missing.into_iter().collect(),
        });
    }

    results
}

/// Addons on this server that declare a dependency on a folder `addon_id` owns.
///
/// Drives the warning shown before removing something other addons rely on.
pub fn dependents_of(store: &Store, server: &Server, addon_id: &str) -> Vec<String> {
    if !server.is_available() {
        return Vec::new();
    }
    let addons_dir = server.addons_dir();

    let Some(target) = store.installation(&server.id, addon_id) else {
        return Vec::new();
    };
    let owned: BTreeSet<String> = target
        .folders
        .iter()
        .map(|folder| folder.to_lowercase())
        .collect();

    let mut dependents = BTreeSet::new();

    for installation in store.installed_for(&server.id) {
        if installation.addon_id == addon_id {
            continue;
        }
        for folder in &installation.folders {
            for name in crate::archive::toc_file_names(&addons_dir.join(folder)) {
                let Ok(contents) = std::fs::read_to_string(addons_dir.join(folder).join(&name))
                else {
                    continue;
                };
                if toc::parse(&contents)
                    .dependencies
                    .iter()
                    .any(|required| owned.contains(&required.to_lowercase()))
                {
                    dependents.insert(
                        store
                            .addon(&installation.addon_id)
                            .map(|addon| addon.display_name.clone())
                            .unwrap_or_else(|| installation.addon_id.clone()),
                    );
                }
            }
        }
    }

    dependents.into_iter().collect()
}

/// Order catalogue entries so that every dependency is installed before the
/// thing that needs it.
///
/// `edges` maps an entry id to the ids it depends on. Unknown ids are ignored —
/// the catalogue may reference something that has since been removed, and that
/// should not stop the rest installing. **Cycles do not hang or panic**: any
/// entry still unresolved after progress stops is appended, so a malformed
/// catalogue degrades to "install in some order" rather than to nothing.
pub fn install_order(wanted: &[String], edges: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let known: BTreeSet<&String> = edges.keys().collect();
    let mut ordered: Vec<String> = Vec::new();
    let mut placed: BTreeSet<String> = BTreeSet::new();

    // Everything reachable from what was asked for, so a dependency that was
    // not explicitly requested still gets installed.
    let mut required: BTreeSet<String> = BTreeSet::new();
    let mut queue: Vec<String> = wanted.to_vec();
    while let Some(id) = queue.pop() {
        if !known.contains(&id) || !required.insert(id.clone()) {
            continue;
        }
        if let Some(children) = edges.get(&id) {
            queue.extend(children.iter().cloned());
        }
    }

    loop {
        let mut progressed = false;
        for id in &required {
            if placed.contains(id) {
                continue;
            }
            let ready = edges
                .get(id)
                .map(|deps| {
                    deps.iter()
                        .all(|dep| !required.contains(dep) || placed.contains(dep))
                })
                .unwrap_or(true);
            if ready {
                ordered.push(id.clone());
                placed.insert(id.clone());
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    // Whatever is left is part of a cycle. Append it rather than dropping it.
    for id in &required {
        if !placed.contains(id) {
            ordered.push(id.clone());
        }
    }

    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Addon, Channel, GameVersion, InstalledAddon, Source};
    use crate::testing::fake_wow_dir;
    use crate::version::Ref;

    fn edges(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(id, deps)| {
                (
                    (*id).to_string(),
                    deps.iter().map(|d| (*d).to_string()).collect(),
                )
            })
            .collect()
    }

    // --- install order ---

    #[test]
    fn puts_dependencies_before_dependants() {
        let graph = edges(&[("clique", &["classicapi"]), ("classicapi", &[])]);
        let order = install_order(&["clique".into()], &graph);
        assert_eq!(order, vec!["classicapi".to_string(), "clique".to_string()]);
    }

    #[test]
    fn pulls_in_dependencies_that_were_not_asked_for() {
        let graph = edges(&[
            ("raidframes", &["clique"]),
            ("clique", &["classicapi"]),
            ("classicapi", &[]),
        ]);
        let order = install_order(&["raidframes".into()], &graph);
        assert_eq!(
            order,
            vec![
                "classicapi".to_string(),
                "clique".to_string(),
                "raidframes".to_string()
            ]
        );
    }

    #[test]
    fn ignores_dependencies_that_are_not_in_the_catalogue() {
        // The catalogue may reference an entry that has since been removed.
        let graph = edges(&[("clique", &["deleted-entry"])]);
        let order = install_order(&["clique".into()], &graph);
        assert_eq!(order, vec!["clique".to_string()]);
    }

    #[test]
    fn a_cycle_degrades_to_some_order_rather_than_hanging() {
        let graph = edges(&[("a", &["b"]), ("b", &["a"])]);
        let order = install_order(&["a".into()], &graph);
        assert_eq!(order.len(), 2, "both still install");
        assert!(order.contains(&"a".to_string()));
        assert!(order.contains(&"b".to_string()));
    }

    #[test]
    fn deduplicates_a_dependency_shared_by_two_addons() {
        let graph = edges(&[("one", &["shared"]), ("two", &["shared"]), ("shared", &[])]);
        let order = install_order(&["one".into(), "two".into()], &graph);
        assert_eq!(order.len(), 3);
        assert_eq!(order.first(), Some(&"shared".to_string()));
    }

    #[test]
    fn an_empty_request_produces_nothing() {
        assert!(install_order(&[], &edges(&[("a", &[])])).is_empty());
    }

    // --- on-disk dependency checks ---

    /// Builds a server whose AddOns folder contains `(folder, toc)` pairs, and
    /// registers `managed` folders against addon ids.
    fn scenario(
        folders: &[(&str, &str)],
        managed: &[(&str, &[&str])],
    ) -> (tempfile::TempDir, Store, Server) {
        let tmp = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        fake_wow_dir(tmp.path()).unwrap_or_else(|e| panic!("{e}"));
        let addons = tmp.path().join("Interface").join("AddOns");

        for (folder, contents) in folders {
            let dir = addons.join(folder);
            std::fs::create_dir_all(&dir).unwrap_or_else(|e| panic!("{e}"));
            std::fs::write(dir.join(format!("{folder}.toc")), contents)
                .unwrap_or_else(|e| panic!("{e}"));
        }

        let mut store = Store::default();
        let server = Server::new("Epoch", tmp.path(), GameVersion::Wotlk);
        store.servers.push(server.clone());

        for (addon_id, owned) in managed {
            store.addons.push(Addon::new(
                Source::Github {
                    owner: "o".into(),
                    repo: (*addon_id).to_string(),
                },
                (*addon_id).to_string(),
            ));
            store.upsert_installation(InstalledAddon {
                server_id: server.id.clone(),
                addon_id: format!("github:o/{addon_id}"),
                channel: Channel::Release,
                pinned: false,
                installed_ref: Ref::release("v1"),
                folders: owned.iter().map(|f| (*f).to_string()).collect(),
                archive_sha256: None,
                installed_at: "0".into(),
                version_matches: true,
            });
        }
        (tmp, store, server)
    }

    #[test]
    fn reports_a_dependency_that_is_not_installed() {
        let (_tmp, store, server) = scenario(
            &[(
                "Clique",
                "## Interface: 30300\n## Dependencies: ClassicAPI\n",
            )],
            &[("Clique", &["Clique"])],
        );

        let unmet = unmet(&store, &server);
        assert_eq!(unmet.len(), 1);
        assert_eq!(
            unmet.first().map(|u| u.missing.clone()),
            Some(vec!["ClassicAPI".to_string()])
        );
    }

    /// A dependency the user installed by hand still satisfies the requirement.
    #[test]
    fn a_dependency_present_on_disk_counts_even_if_unmanaged() {
        let (_tmp, store, server) = scenario(
            &[
                (
                    "Clique",
                    "## Interface: 30300\n## Dependencies: ClassicAPI\n",
                ),
                ("ClassicAPI", "## Interface: 30300\n"),
            ],
            // Only Clique is managed; ClassicAPI was dropped in by hand.
            &[("Clique", &["Clique"])],
        );

        assert!(
            unmet(&store, &server).is_empty(),
            "presence on disk is what matters, not whether we installed it"
        );
    }

    #[test]
    fn dependency_names_match_case_insensitively() {
        let (_tmp, store, server) = scenario(
            &[
                (
                    "Clique",
                    "## Interface: 30300\n## Dependencies: classicapi\n",
                ),
                ("ClassicAPI", "## Interface: 30300\n"),
            ],
            &[("Clique", &["Clique"])],
        );
        assert!(unmet(&store, &server).is_empty());
    }

    #[test]
    fn an_addon_with_no_dependencies_is_never_reported() {
        let (_tmp, store, server) =
            scenario(&[("Solo", "## Interface: 30300\n")], &[("Solo", &["Solo"])]);
        assert!(unmet(&store, &server).is_empty());
    }

    #[test]
    fn finds_what_would_break_if_an_addon_were_removed() {
        let (_tmp, store, server) = scenario(
            &[
                (
                    "Clique",
                    "## Interface: 30300\n## Dependencies: ClassicAPI\n",
                ),
                ("ClassicAPI", "## Interface: 30300\n"),
            ],
            &[("Clique", &["Clique"]), ("ClassicAPI", &["ClassicAPI"])],
        );

        let dependents = dependents_of(&store, &server, "github:o/ClassicAPI");
        assert_eq!(dependents, vec!["Clique".to_string()]);

        assert!(
            dependents_of(&store, &server, "github:o/Clique").is_empty(),
            "nothing depends on Clique"
        );
    }

    #[test]
    fn an_unavailable_server_reports_nothing_rather_than_everything_missing() {
        let (tmp, store, server) = scenario(
            &[(
                "Clique",
                "## Interface: 30300\n## Dependencies: ClassicAPI\n",
            )],
            &[("Clique", &["Clique"])],
        );
        let moved = tmp.path().with_extension("unplugged");
        std::fs::rename(tmp.path(), &moved).unwrap_or_else(|e| panic!("{e}"));

        assert!(
            unmet(&store, &server).is_empty(),
            "an unreachable drive must not look like every dependency vanished"
        );
        assert!(dependents_of(&store, &server, "github:o/Clique").is_empty());

        std::fs::rename(&moved, tmp.path()).unwrap_or_else(|e| panic!("{e}"));
    }
}
