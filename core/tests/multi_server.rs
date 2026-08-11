//! Phase 2: several servers side by side.
//!
//! Exit criteria from V2-PLAN.md: two servers registered, the same addon at
//! different versions in each, and switching between them works. The switcher
//! itself is UI, but everything it renders and every action it dispatches is
//! exercised here.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use bam_core::bulk::{self, CopyOutcome};
use bam_core::error::Error;
use bam_core::install::{self, InstallOptions};
use bam_core::model::{GameVersion, Source, Store};
use bam_core::servers::{self, AddOptions, Availability};
use bam_core::testing::{addon_zip, fake_wow_dir, FakeHttp};

const RELEASES_URL: &str = "https://api.github.com/repos/o/r/releases/latest";

fn source() -> Source {
    Source::Github {
        owner: "o".into(),
        repo: "r".into(),
    }
}

fn other_source() -> Source {
    Source::Gitlab {
        owner: "t".into(),
        repo: "classicapi".into(),
    }
}

fn forge(tag: &str, folder: &str) -> FakeHttp {
    let asset = format!("https://github.com/o/r/releases/download/{tag}/a.zip");
    let gitlab_asset = "https://gitlab.com/t/classicapi/-/archive/v1/classicapi-v1.zip";
    FakeHttp::new()
        .json(
            RELEASES_URL,
            &format!(
                r#"{{"tag_name":"{tag}","published_at":"2026-01-01T00:00:00Z",
                     "assets":[{{"name":"a.zip","browser_download_url":"{asset}"}}]}}"#
            ),
        )
        .file(&asset, addon_zip(folder, 30300, tag))
        .json(
            "https://gitlab.com/api/v4/projects/t%2Fclassicapi/releases",
            r#"[{"tag_name":"v1","released_at":"2026-01-01T00:00:00Z","assets":{"links":[]}}]"#,
        )
        .file(gitlab_asset, addon_zip("ClassicAPI", 30300, "v1"))
}

/// Register a fresh server and return (tempdir, id).
fn new_server(store: &mut Store, name: &str) -> (tempfile::TempDir, String) {
    let tmp = tempfile::tempdir().unwrap();
    fake_wow_dir(tmp.path()).unwrap();
    let server = servers::add(
        store,
        name,
        tmp.path(),
        GameVersion::Wotlk,
        &AddOptions::default(),
    )
    .expect("add server");
    let id = server.id.clone();
    (tmp, id)
}

#[test]
fn registering_two_servers_gives_the_switcher_two_distinct_rows() {
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (_warmane, warmane_id) = new_server(&mut store, "Warmane");

    let rows = servers::summaries(&store);
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter()
            .map(|r| r.server.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Epoch", "Warmane"],
        "sorted by name for a stable list"
    );
    assert!(rows.iter().all(|r| r.availability == Availability::Ready));
    assert_ne!(epoch_id, warmane_id);

    // Both paths are shown, because two folders can share a name.
    assert!(rows.iter().all(|r| !r.path_display.is_empty()));
}

#[tokio::test]
async fn switching_servers_shows_only_that_servers_addons() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (_warmane, warmane_id) = new_server(&mut store, "Warmane");

    let client = forge("v1.0.0", "MyAddon");
    install::install(
        &client,
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install to epoch only");

    // This is what the addon list renders for the selected server.
    assert_eq!(store.installed_for(&epoch_id).len(), 1);
    assert_eq!(
        store.installed_for(&warmane_id).len(),
        0,
        "installing to one server must not touch the other"
    );

    let rows = servers::summaries(&store);
    let counts: Vec<usize> = rows.iter().map(|r| r.addon_count).collect();
    assert_eq!(counts, vec![1, 0], "the switcher shows per-server counts");
}

/// The headline feature, end to end.
#[tokio::test]
async fn the_same_addon_sits_at_different_versions_in_two_servers() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (warmane, warmane_id) = new_server(&mut store, "Warmane");

    install::install(
        &forge("v1.0.0", "MyAddon"),
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("v1 to epoch");

    install::install(
        &forge("v2.0.0", "MyAddon"),
        &mut store,
        &warmane_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("v2 to warmane");

    assert_eq!(
        store
            .installation(&epoch_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v1.0.0".into())
    );
    assert_eq!(
        store
            .installation(&warmane_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v2.0.0".into())
    );

    // And the files on disk really differ.
    let epoch_toc =
        std::fs::read_to_string(epoch.path().join("Interface/AddOns/MyAddon/MyAddon.toc")).unwrap();
    let warmane_toc =
        std::fs::read_to_string(warmane.path().join("Interface/AddOns/MyAddon/MyAddon.toc"))
            .unwrap();
    assert!(epoch_toc.contains("v1.0.0"));
    assert!(warmane_toc.contains("v2.0.0"));
}

#[tokio::test]
async fn install_to_many_targets_every_selected_server() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (warmane, warmane_id) = new_server(&mut store, "Warmane");

    let outcomes = bulk::install_to_many(
        &forge("v1.0.0", "MyAddon"),
        &mut store,
        &[epoch_id.clone(), warmane_id.clone()],
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert_eq!(outcomes.len(), 2);
    assert!(outcomes.iter().all(|o| o.succeeded()));
    assert!(epoch.path().join("Interface/AddOns/MyAddon").is_dir());
    assert!(warmane.path().join("Interface/AddOns/MyAddon").is_dir());
    assert_eq!(store.installed.len(), 2);
}

/// One bad target must not sink the others.
#[tokio::test]
async fn install_to_many_reports_per_server_and_keeps_going() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (_blocked, blocked_id) = new_server(&mut store, "Blocked");

    // Put a hand-installed folder in the way on the second server only.
    let blocked_dir = store
        .server(&blocked_id)
        .map(|s| s.addons_dir())
        .expect("server");
    std::fs::create_dir_all(blocked_dir.join("MyAddon")).unwrap();

    let outcomes = bulk::install_to_many(
        &forge("v1.0.0", "MyAddon"),
        &mut store,
        &[epoch_id.clone(), blocked_id.clone()],
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    let by_id = |id: &str| {
        outcomes
            .iter()
            .find(|o| o.server_id == id)
            .expect("outcome")
    };
    assert!(
        by_id(&epoch_id).succeeded(),
        "the good target still installs"
    );
    assert!(!by_id(&blocked_id).succeeded(), "the blocked one reports");
    assert!(matches!(
        by_id(&blocked_id).result,
        Err(Error::UnmanagedCollision { .. })
    ));

    assert!(epoch.path().join("Interface/AddOns/MyAddon").is_dir());
    assert_eq!(store.installed.len(), 1);
}

#[tokio::test]
async fn copy_set_stands_up_a_new_server_from_an_existing_one() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (fresh, fresh_id) = new_server(&mut store, "Fresh");

    let client = forge("v1.0.0", "MyAddon");
    install::install(
        &client,
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");
    install::install(
        &client,
        &mut store,
        &epoch_id,
        &other_source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install second addon");

    // No client is passed: copying is a pure filesystem operation.
    let outcomes = bulk::copy_set(&mut store, &epoch_id, &fresh_id, false).expect("copy");

    assert_eq!(outcomes.len(), 2);
    assert!(outcomes
        .iter()
        .all(|o| matches!(o, CopyOutcome::Copied { .. })));
    assert!(fresh.path().join("Interface/AddOns/MyAddon").is_dir());
    assert!(fresh.path().join("Interface/AddOns/ClassicAPI").is_dir());
    assert_eq!(store.installed_for(&fresh_id).len(), 2);
}

/// Copying preserves the version that was installed, rather than picking up
/// whatever upstream happens to offer now.
#[tokio::test]
async fn copy_set_preserves_the_installed_version() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (fresh, fresh_id) = new_server(&mut store, "Fresh");

    install::install(
        &forge("v1.0.0", "MyAddon"),
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install v1");

    bulk::copy_set(&mut store, &epoch_id, &fresh_id, false).expect("copy");

    assert_eq!(
        store
            .installation(&fresh_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v1.0.0".into()),
        "the copy is of what is installed, not of what upstream now offers"
    );
    let toc =
        std::fs::read_to_string(fresh.path().join("Interface/AddOns/MyAddon/MyAddon.toc")).unwrap();
    assert!(toc.contains("v1.0.0"));
}

#[tokio::test]
async fn copy_set_skips_addons_already_on_the_target() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (_other, other_id) = new_server(&mut store, "Other");

    let client = forge("v1.0.0", "MyAddon");
    for id in [&epoch_id, &other_id] {
        install::install(
            &client,
            &mut store,
            id,
            &source(),
            &InstallOptions::default(),
            work.path(),
        )
        .await
        .expect("install");
    }

    let outcomes = bulk::copy_set(&mut store, &epoch_id, &other_id, false).expect("copy");
    assert_eq!(
        outcomes,
        vec![CopyOutcome::AlreadyPresent {
            addon_id: "github:o/r".into()
        }]
    );
    assert_eq!(store.installed.len(), 2, "no duplicate row created");
}

#[tokio::test]
async fn copy_set_refuses_to_clobber_an_unmanaged_folder_on_the_target() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (_epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (target, target_id) = new_server(&mut store, "Target");

    install::install(
        &forge("v1.0.0", "MyAddon"),
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    let precious = target.path().join("Interface/AddOns/MyAddon");
    std::fs::create_dir_all(&precious).unwrap();
    std::fs::write(precious.join("mine.lua"), b"user data").unwrap();

    let outcomes = bulk::copy_set(&mut store, &epoch_id, &target_id, false).expect("copy");

    assert!(matches!(outcomes.first(), Some(CopyOutcome::Failed { .. })));
    assert_eq!(
        std::fs::read_to_string(precious.join("mine.lua")).unwrap(),
        "user data",
        "the user's file survives a copy just as it survives an install"
    );
    assert_eq!(store.installed_for(&target_id).len(), 0);
}

#[test]
fn copy_set_to_the_same_server_is_rejected() {
    let mut store = Store::default();
    let (_tmp, id) = new_server(&mut store, "Epoch");
    assert!(bulk::copy_set(&mut store, &id, &id, false).is_err());
}

#[test]
fn copy_set_from_an_unavailable_server_errors_rather_than_producing_an_empty_set() {
    let mut store = Store::default();
    let (source_dir, source_id) = new_server(&mut store, "Epoch");
    let (_target, target_id) = new_server(&mut store, "Target");

    let moved = source_dir.path().with_extension("unplugged");
    std::fs::rename(source_dir.path(), &moved).unwrap();

    let result = bulk::copy_set(&mut store, &source_id, &target_id, false);
    assert!(matches!(result, Err(Error::ServerUnavailable { .. })));

    std::fs::rename(&moved, source_dir.path()).unwrap();
}

#[tokio::test]
async fn forgetting_a_server_drops_its_rows_but_keeps_the_other_servers() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let (epoch, epoch_id) = new_server(&mut store, "Epoch");
    let (_warmane, warmane_id) = new_server(&mut store, "Warmane");

    let client = forge("v1.0.0", "MyAddon");
    for id in [&epoch_id, &warmane_id] {
        install::install(
            &client,
            &mut store,
            id,
            &source(),
            &InstallOptions::default(),
            work.path(),
        )
        .await
        .expect("install");
    }

    servers::forget(&mut store, &epoch_id).expect("forget");

    assert_eq!(store.servers.len(), 1);
    assert_eq!(store.installed.len(), 1);
    assert_eq!(store.installed_for(&warmane_id).len(), 1);
    assert!(
        epoch.path().join("Interface/AddOns/MyAddon").is_dir(),
        "deregistering is not uninstalling — files stay put"
    );
}

#[test]
fn an_offline_server_is_reported_as_unavailable_in_the_switcher() {
    let mut store = Store::default();
    let (tmp, _id) = new_server(&mut store, "Epoch");

    let moved = tmp.path().with_extension("unplugged");
    std::fs::rename(tmp.path(), &moved).unwrap();

    let rows = servers::summaries(&store);
    assert_eq!(
        rows.first().map(|r| r.availability),
        Some(Availability::Unavailable)
    );
    assert!(
        rows.first().is_some_and(|r| !r.availability.can_install()),
        "an unavailable server must not accept installs"
    );

    std::fs::rename(&moved, tmp.path()).unwrap();
}
