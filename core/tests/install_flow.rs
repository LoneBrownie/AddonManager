//! End-to-end engine tests against a synthetic WoW directory.
//!
//! This is the Phase 1 exit criteria from V2-PLAN.md: install and update a real
//! addon archive into a temp tree, with no network and no UI. The same tests
//! run on Windows and Linux in CI.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::Path;

use bam_core::cancel::CancelToken;
use bam_core::error::Error;
use bam_core::install::{self, InstallOptions};
use bam_core::model::{Channel, GameVersion, Server, Source, Store};
use bam_core::testing::{addon_zip, fake_wow_dir, zip_from, FakeHttp};
use bam_core::updates;
use bam_core::version::{Ref, UpdateStatus};

const RELEASES_URL: &str = "https://api.github.com/repos/o/r/releases/latest";

fn source() -> Source {
    Source::Github {
        owner: "o".into(),
        repo: "r".into(),
    }
}

/// A FakeHttp serving one release whose asset is `zip`.
fn forge_serving(tag: &str, zip: Vec<u8>) -> FakeHttp {
    let asset_url = format!("https://github.com/o/r/releases/download/{tag}/MyAddon.zip");
    FakeHttp::new()
        .json(
            RELEASES_URL,
            &format!(
                r#"{{"tag_name":"{tag}","published_at":"2026-01-01T00:00:00Z",
                     "assets":[{{"name":"MyAddon.zip","browser_download_url":"{asset_url}"}}]}}"#
            ),
        )
        .file(&asset_url, zip)
}

fn register_server(store: &mut Store, root: &Path) -> String {
    fake_wow_dir(root).expect("create fake wow dir");
    let server = Server::new("Epoch", root, GameVersion::Wotlk);
    let id = server.id.clone();
    store.servers.push(server);
    id
}

#[tokio::test]
async fn installs_an_addon_into_the_addons_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));

    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install should succeed");

    let addons = tmp.path().join("Interface").join("AddOns");
    assert!(addons.join("MyAddon").is_dir(), "addon folder written");
    assert!(addons.join("MyAddon/MyAddon.toc").is_file(), "toc written");
    assert!(addons.join("MyAddon/Core.lua").is_file(), "content written");

    assert_eq!(installed.folders, vec!["MyAddon".to_string()]);
    assert_eq!(
        installed.installed_ref,
        Ref::Release {
            tag: "v1.0.0".into(),
            published_at: Some("2026-01-01T00:00:00Z".into())
        }
    );
    assert!(installed.archive_sha256.is_some(), "archive hash recorded");
    assert_eq!(store.installed_for(&server_id).len(), 1);
    assert_eq!(store.addons.len(), 1);
}

#[tokio::test]
async fn detects_and_applies_an_update() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let old = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &old,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("first install");

    // Upstream publishes a newer tag.
    let new = forge_serving("v1.1.0", addon_zip("MyAddon", 30300, "1.1.0"));
    let report = updates::check_update(&new, &store, &server_id, "github:o/r", None)
        .await
        .expect("check should succeed");
    assert_eq!(report.status, UpdateStatus::UpdateAvailable);

    install::install(
        &new,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("update install");

    assert_eq!(store.installed_for(&server_id).len(), 1, "still one row");
    let row = store.installation(&server_id, "github:o/r").unwrap();
    assert_eq!(
        row.installed_ref,
        Ref::Release {
            tag: "v1.1.0".into(),
            published_at: Some("2026-01-01T00:00:00Z".into())
        }
    );

    let toc =
        std::fs::read_to_string(tmp.path().join("Interface/AddOns/MyAddon/MyAddon.toc")).unwrap();
    assert!(toc.contains("1.1.0"), "files on disk actually replaced");
}

#[tokio::test]
async fn reports_up_to_date_when_the_tag_has_not_moved() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    let report = updates::check_update(&client, &store, &server_id, "github:o/r", None)
        .await
        .expect("check");
    assert_eq!(report.status, UpdateStatus::UpToDate);
}

#[tokio::test]
async fn removes_exactly_the_folders_it_wrote() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());
    let addons = tmp.path().join("Interface").join("AddOns");

    // A folder the user put there themselves.
    std::fs::create_dir_all(addons.join("HandInstalled")).unwrap();
    std::fs::write(addons.join("HandInstalled/x.lua"), b"mine").unwrap();

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    let removed = install::remove(&mut store, &server_id, "github:o/r").expect("remove");

    assert_eq!(removed, vec!["MyAddon".to_string()]);
    assert!(!addons.join("MyAddon").exists(), "our folder is gone");
    assert!(
        addons.join("HandInstalled/x.lua").is_file(),
        "an unrelated folder must be untouched"
    );
    assert!(store.installed.is_empty());
    assert!(store.addons.is_empty(), "orphan addon record pruned");
}

/// V2-PLAN.md B2 — the V1 data-loss bug, through the full install path.
#[tokio::test]
async fn refuses_to_overwrite_a_hand_installed_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let addons = tmp.path().join("Interface").join("AddOns");
    std::fs::create_dir_all(addons.join("MyAddon")).unwrap();
    std::fs::write(addons.join("MyAddon/precious.lua"), b"user data").unwrap();

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    let result = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(
        matches!(result, Err(Error::UnmanagedCollision { .. })),
        "install must refuse, got {result:?}"
    );
    assert_eq!(
        std::fs::read_to_string(addons.join("MyAddon/precious.lua")).unwrap(),
        "user data",
        "the user's file must survive"
    );
}

#[tokio::test]
async fn overwrites_a_hand_installed_folder_only_when_explicitly_allowed() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let addons = tmp.path().join("Interface").join("AddOns");
    std::fs::create_dir_all(addons.join("MyAddon")).unwrap();

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    let options = InstallOptions {
        overwrite_unmanaged: true,
        ..InstallOptions::default()
    };

    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("install with explicit consent should succeed");

    assert!(addons.join("MyAddon/MyAddon.toc").is_file());
}

/// Importing a V1 list: a repository that never cut a release is not an error.
///
/// Half the 3.3.5a scene ships from a branch and nothing else. Refusing those
/// turned a migration into a screen of failures, each telling the user to go and
/// switch a channel on an addon that had not been installed.
#[tokio::test]
async fn falls_back_to_the_branch_when_asked_and_there_are_no_releases() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = FakeHttp::new()
        .status(RELEASES_URL, 404, r#"{"message":"Not Found"}"#)
        .json(
            "https://api.github.com/repos/o/r",
            r#"{"default_branch":"master"}"#,
        )
        .json(
            "https://api.github.com/repos/o/r/commits/master",
            r#"{"sha":"abc1234def","commit":{"author":{"date":"2026-02-02T00:00:00Z"}}}"#,
        )
        .file(
            "https://codeload.github.com/o/r/zip/refs/heads/master",
            addon_zip("MyAddon", 30300, "1.0.0"),
        );

    let options = InstallOptions {
        fallback_to_source: true,
        ..InstallOptions::default()
    };
    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("a repo with no releases should install from its branch");

    assert!(
        matches!(installed.installed_ref, Ref::Branch { .. }),
        "got {:?}",
        installed.installed_ref
    );
    assert_eq!(
        installed.channel,
        Channel::Source,
        "the channel actually used has to be recorded, or the next update check \
         asks for a release again"
    );
    assert!(tmp.path().join("Interface/AddOns/MyAddon").is_dir());
}

/// And only when asked. Silently switching channel would hide a mistyped URL.
#[tokio::test]
async fn a_repo_with_no_releases_still_fails_by_default() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = FakeHttp::new().status(RELEASES_URL, 404, r#"{"message":"Not Found"}"#);
    let result = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(matches!(result, Err(Error::NoResolvableRef(_))));
}

/// Importing into a game folder that already has the addons in it.
///
/// The V1-to-V2 case: the files are already there and working. Downloading over
/// the top would swap them for whatever upstream is today, which is a change
/// nobody asked for — so they are taken over as they stand, at a version this
/// app cannot name, and left alone until the user updates.
#[tokio::test]
async fn takes_over_an_addon_already_on_disk_instead_of_reinstalling_it() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let addons = tmp.path().join("Interface").join("AddOns");
    std::fs::create_dir_all(addons.join("MyAddon")).unwrap();
    std::fs::write(addons.join("MyAddon/MyAddon.toc"), b"## Interface: 30300\n").unwrap();
    std::fs::write(addons.join("MyAddon/precious.lua"), b"user data").unwrap();

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    let options = InstallOptions {
        adopt_existing: true,
        ..InstallOptions::default()
    };
    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("an addon already on disk should be adopted, not refused");

    assert_eq!(installed.installed_ref, Ref::Unknown, "version not invented");
    assert_eq!(installed.folders, vec!["MyAddon".to_string()]);
    assert_eq!(
        std::fs::read_to_string(addons.join("MyAddon/precious.lua")).unwrap(),
        "user data",
        "nothing on disk may be touched"
    );
    assert!(
        !addons.join("MyAddon/Core.lua").exists(),
        "the archive must not be written over what is already there"
    );

    // ...and the whole point: it is now updatable to a version we can name.
    let report = updates::check_update(&client, &store, &server_id, "github:o/r", None)
        .await
        .expect("check");
    assert_eq!(report.status, UpdateStatus::UpdateAvailable);

    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("updating an adopted addon replaces folders it now owns");

    assert!(addons.join("MyAddon/Core.lua").is_file());
    assert_eq!(
        store
            .installation(&server_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v1.0.0".to_string())
    );
}

/// Updating an adopted addon finishes the job adoption started.
///
/// An addon that ships several folders is usually recognised by one of them, so
/// the rest are still sitting there unowned. Refusing to write over those would
/// name folders the user had just claimed and leave the addon permanently stuck
/// at an unknown version — which is why `update_addon` overwrites and this test
/// exists to pin the shape it has to survive.
#[tokio::test]
async fn updating_an_adopted_addon_takes_over_the_rest_of_its_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    // On disk by hand: the main folder and one of its modules.
    let addons = tmp.path().join("Interface").join("AddOns");
    for folder in ["Skada", "Skada_Damage"] {
        std::fs::create_dir_all(addons.join(folder)).unwrap();
        std::fs::write(
            addons.join(folder).join(format!("{folder}.toc")),
            b"## Interface: 30300\n",
        )
        .unwrap();
        std::fs::write(addons.join(folder).join("old.lua"), b"hand installed").unwrap();
    }

    // Adopted knowing only about the main folder — the case the list leaves.
    store.upsert_installation(bam_core::model::InstalledAddon {
        server_id: server_id.clone(),
        addon_id: "github:o/r".into(),
        channel: Channel::Release,
        pinned: false,
        installed_ref: Ref::Unknown,
        folders: vec!["Skada".into()],
        archive_sha256: None,
        installed_at: "0".into(),
        version_matches: true,
    });
    store.addons.push(bam_core::model::Addon::new(source(), "Skada".to_string()));

    let client = forge_serving(
        "v1.9.0",
        zip_from(&[
            ("Skada/Skada.toc", b"## Interface: 30300\n"),
            ("Skada_Damage/Skada_Damage.toc", b"## Interface: 30300\n"),
        ]),
    );

    // What `update_addon` passes: the addon is already managed and the user
    // named its repository, so its own folders are not somebody else's files.
    let options = InstallOptions {
        overwrite_unmanaged: true,
        ..InstallOptions::default()
    };
    let updated = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("updating an adopted addon must not be blocked by its own folders");

    assert_eq!(
        updated.installed_ref.display(),
        "v1.9.0",
        "no longer an unknown version"
    );
    assert_eq!(
        updated.folders,
        vec!["Skada".to_string(), "Skada_Damage".to_string()],
        "the module is recorded too, so removing the addon later takes all of it"
    );
    assert!(!addons.join("Skada_Damage/old.lua").exists(), "replaced");
    assert!(addons.join("Skada_Damage/Skada_Damage.toc").is_file());
}

/// Installing something new is still refused, which is the case the rule is
/// actually for: nobody has said the colliding folder is the same addon.
#[tokio::test]
async fn a_fresh_install_still_refuses_to_write_over_a_hand_installed_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let addons = tmp.path().join("Interface").join("AddOns");
    std::fs::create_dir_all(addons.join("MyAddon")).unwrap();
    std::fs::write(addons.join("MyAddon/precious.lua"), b"user data").unwrap();

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    let result = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(matches!(result, Err(Error::UnmanagedCollision { .. })));
    assert_eq!(
        std::fs::read_to_string(addons.join("MyAddon/precious.lua")).unwrap(),
        "user data"
    );
}

/// Adoption is opt-in too — the default is still the refusal that stops the app
/// destroying a folder it did not create.
#[tokio::test]
async fn only_the_folders_actually_on_disk_are_taken_over() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let addons = tmp.path().join("Interface").join("AddOns");
    std::fs::create_dir_all(addons.join("WeakAuras")).unwrap();
    std::fs::write(addons.join("WeakAuras/WeakAuras.toc"), b"## Interface: 30300\n").unwrap();

    // The archive ships two folders; only one of them is on disk.
    let client = forge_serving(
        "v1.0.0",
        zip_from(&[
            ("WeakAuras/WeakAuras.toc", b"## Interface: 30300\n"),
            (
                "WeakAuras_Options/WeakAuras_Options.toc",
                b"## Interface: 30300\n",
            ),
        ]),
    );
    let options = InstallOptions {
        adopt_existing: true,
        ..InstallOptions::default()
    };
    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("adopt");

    assert_eq!(
        installed.folders,
        vec!["WeakAuras".to_string()],
        "recording a folder that is not there would flag the addon missing the \
         instant it was adopted"
    );
    assert!(
        !addons.join("WeakAuras_Options").exists(),
        "nothing is written: the addon is taken over as it stands"
    );
}

/// The headline feature: one addon, two servers, independent versions.
#[tokio::test]
async fn the_same_addon_installs_independently_to_two_servers() {
    let epoch = tempfile::tempdir().unwrap();
    let warmane = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();

    let epoch_id = register_server(&mut store, epoch.path());
    fake_wow_dir(warmane.path()).unwrap();
    let warmane_server = Server::new("Warmane", warmane.path(), GameVersion::Wotlk);
    let warmane_id = warmane_server.id.clone();
    store.servers.push(warmane_server);

    let old = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &old,
        &mut store,
        &epoch_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install to epoch");

    let new = forge_serving("v2.0.0", addon_zip("MyAddon", 30300, "2.0.0"));
    install::install(
        &new,
        &mut store,
        &warmane_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install to warmane");

    assert_eq!(store.installed.len(), 2, "one row per (addon, server)");
    assert_eq!(
        store
            .installation(&epoch_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v1.0.0".to_string())
    );
    assert_eq!(
        store
            .installation(&warmane_id, "github:o/r")
            .map(|i| i.installed_ref.display()),
        Some("v2.0.0".to_string())
    );

    // Removing from one server leaves the other alone.
    install::remove(&mut store, &epoch_id, "github:o/r").expect("remove from epoch");
    assert!(!epoch.path().join("Interface/AddOns/MyAddon").exists());
    assert!(warmane.path().join("Interface/AddOns/MyAddon").is_dir());
    assert_eq!(store.installed.len(), 1);
}

#[tokio::test]
async fn installs_every_folder_of_a_multi_folder_addon() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let zip = zip_from(&[
        ("WeakAuras/WeakAuras.toc", b"## Interface: 30300\n"),
        ("WeakAuras/Core.lua", b"-- code\n"),
        (
            "WeakAuras_Options/WeakAuras_Options.toc",
            b"## Interface: 30300\n",
        ),
    ]);
    let client = forge_serving("v1.0.0", zip);

    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    assert_eq!(
        installed.folders,
        vec!["WeakAuras".to_string(), "WeakAuras_Options".to_string()],
        "both folders recorded as one addon — no relatedness guessing needed"
    );

    let addons = tmp.path().join("Interface").join("AddOns");
    assert!(addons.join("WeakAuras").is_dir());
    assert!(addons.join("WeakAuras_Options").is_dir());

    install::remove(&mut store, &server_id, "github:o/r").expect("remove");
    assert!(!addons.join("WeakAuras").exists());
    assert!(!addons.join("WeakAuras_Options").exists(), "both removed");
}

#[tokio::test]
async fn strips_the_github_wrapper_directory_from_folder_names() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    // What a codeload source archive actually looks like.
    let zip = zip_from(&[
        ("r-main/MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
        ("r-main/MyAddon/Core.lua", b"-- code\n"),
    ]);
    let client = forge_serving("v1.0.0", zip);

    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    assert_eq!(installed.folders, vec!["MyAddon".to_string()]);
    assert!(tmp
        .path()
        .join("Interface/AddOns/MyAddon/MyAddon.toc")
        .is_file());
    assert!(
        !tmp.path().join("Interface/AddOns/r-main").exists(),
        "the wrapper directory must not be installed"
    );
}

/// V2-PLAN.md S2 — zip slip must fail closed through the whole install path,
/// not just in the extractor's unit tests.
#[tokio::test]
async fn a_malicious_archive_cannot_escape_the_addons_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let evil = zip_from(&[
        ("MyAddon/MyAddon.toc", b"## Interface: 30300\n"),
        ("../../../../evil.lua", b"pwned"),
    ]);
    let client = forge_serving("v1.0.0", evil);

    let result = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(
        matches!(result, Err(Error::UnsafePath { .. })),
        "traversal must be rejected, got {result:?}"
    );
    assert!(
        store.installed.is_empty(),
        "nothing recorded for a failed install"
    );
    assert!(
        !tmp.path().join("Interface/AddOns/MyAddon").exists(),
        "no partial install survives"
    );
}

/// V2-PLAN.md B8 — an unreachable path is "cannot check", never "deleted".
#[tokio::test]
async fn an_offline_server_errors_rather_than_dropping_its_addons() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    // Simulate the external drive being unplugged.
    let moved = tmp.path().with_extension("unplugged");
    std::fs::rename(tmp.path(), &moved).unwrap();

    let result = install::remove(&mut store, &server_id, "github:o/r");
    assert!(
        matches!(result, Err(Error::ServerUnavailable { .. })),
        "should report unavailable, got {result:?}"
    );
    assert_eq!(
        store.installed.len(),
        1,
        "records must survive an unreachable drive"
    );

    std::fs::rename(&moved, tmp.path()).unwrap();
}

#[tokio::test]
async fn a_failed_install_leaves_no_staging_debris() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", zip_from(&[("docs/README.md", b"no addon")]));
    let result = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(matches!(result, Err(Error::NoAddonFolders)));
    let leftovers: Vec<_> = std::fs::read_dir(work.path())
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(
        leftovers.is_empty(),
        "staging cleaned up, found {leftovers:?}"
    );
}

#[tokio::test]
async fn the_source_channel_installs_the_branch_head() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = FakeHttp::new()
        .json(
            "https://api.github.com/repos/o/r",
            r#"{"default_branch":"master"}"#,
        )
        .json(
            "https://api.github.com/repos/o/r/commits/master",
            r#"{"sha":"abc1234def","commit":{"author":{"date":"2026-02-02T00:00:00Z"}}}"#,
        )
        .file(
            "https://codeload.github.com/o/r/zip/refs/heads/master",
            addon_zip("MyAddon", 30300, "dev"),
        );

    let options = InstallOptions {
        channel: Channel::Source,
        ..InstallOptions::default()
    };
    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &options,
        work.path(),
    )
    .await
    .expect("source install");

    assert_eq!(installed.installed_ref.display(), "master@abc1234");
    assert_eq!(installed.channel, Channel::Source);
}

#[tokio::test]
async fn installing_to_an_unknown_server_is_an_error() {
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));

    let result = install::install(
        &client,
        &mut store,
        "srv_does_not_exist",
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await;

    assert!(matches!(result, Err(Error::UnknownServer(_))));
}

#[tokio::test]
async fn flags_an_addon_built_for_a_different_game_version() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    // The server is WotLK; the addon declares Vanilla.
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("OldAddon", 11200, "1.0.0"));
    let installed = install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install still succeeds");

    assert!(
        !installed.version_matches,
        "a Vanilla addon in a WotLK folder should be flagged"
    );
    assert!(
        tmp.path().join("Interface/AddOns/OldAddon").is_dir(),
        "flagged, not blocked — the user may know better than the .toc"
    );
}

#[tokio::test]
async fn does_not_flag_an_addon_that_declares_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let zip = zip_from(&[("Quiet/Quiet.toc", b"## Title: No interface line\n")]);
    let installed = install::install(
        &forge_serving("v1.0.0", zip),
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    assert!(installed.version_matches, "no claim means no warning");
}

#[tokio::test]
async fn update_checks_run_in_parallel_and_skip_pinned_addons() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    // Unpinned: it is checked.
    let reports = updates::check_updates_for_server(
        &client,
        &store,
        &server_id,
        None,
        6,
        &CancelToken::new(),
    )
    .await;
    assert_eq!(reports.len(), 1);

    // Pinned: no request is made for it at all.
    if let Some(row) = store
        .installed
        .iter_mut()
        .find(|i| i.server_id == server_id)
    {
        row.pinned = true;
    }
    let reports = updates::check_updates_for_server(
        &client,
        &store,
        &server_id,
        None,
        6,
        &CancelToken::new(),
    )
    .await;
    assert!(
        reports.is_empty(),
        "a pinned addon must not be checked, let alone nag"
    );
}

#[tokio::test]
async fn a_cancelled_check_stops_issuing_requests() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());

    let client = forge_serving("v1.0.0", addon_zip("MyAddon", 30300, "1.0.0"));
    install::install(
        &client,
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("install");

    let before = client.request_count();
    let cancelled = CancelToken::cancelled();
    let reports =
        updates::check_updates_for_server(&client, &store, &server_id, None, 6, &cancelled).await;

    assert!(reports.is_empty(), "nothing is checked once cancelled");
    assert_eq!(
        client.request_count(),
        before,
        "and no request is issued at all"
    );
}

/// NotPlater, end to end: one folder carrying a manifest per game version, a
/// bundled library that ships its own `.toc`, and a server that decides which
/// of the two manifests the client will open.
///
/// The repository *is* the addon — there is no inner folder — so a GitHub
/// archive extracts as `NotPlater-<ref>`, which matches neither manifest and
/// neither the repository name. That is what used to send the old rule to its
/// alphabetical last resort and pick the 2.4.3 manifest on every server.
#[tokio::test]
async fn a_two_manifest_addon_lands_in_the_folder_its_server_needs() {
    async fn install_to(
        version: GameVersion,
    ) -> (tempfile::TempDir, bam_core::model::InstalledAddon) {
        let tmp = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let mut store = Store::default();
        fake_wow_dir(tmp.path()).expect("create fake wow dir");
        let server = Server::new("Server", tmp.path(), version);
        let server_id = server.id.clone();
        store.servers.push(server);

        let zip = zip_from(&[
            (
                "NotPlater-3.2.4/NotPlater-2.4.3.toc",
                b"## Interface: 20400\n",
            ),
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

        let installed = install::install(
            &forge_serving("v3.2.4", zip),
            &mut store,
            &server_id,
            &source(),
            &InstallOptions::default(),
            work.path(),
        )
        .await
        .expect("install should succeed");

        (tmp, installed)
    }

    // --- WotLK ---
    let (tmp, installed) = install_to(GameVersion::Wotlk).await;
    let addons = tmp.path().join("Interface").join("AddOns");

    assert_eq!(installed.folders, vec!["NotPlater-3.3.5".to_string()]);
    assert!(
        addons.join("NotPlater-3.3.5/NotPlater-3.3.5.toc").is_file(),
        "the folder name must equal the manifest the client opens"
    );
    assert!(
        addons.join("NotPlater-3.3.5/NotPlater-2.4.3.toc").is_file(),
        "the other manifest comes along, inert"
    );
    assert!(
        installed.version_matches,
        "a 2.4.3 manifest sitting beside the 3.3.5 one is not a version mismatch: \
         the client never opens it"
    );

    // The bundled library stays where the addon expects it, and does not become
    // an addon in its own right.
    assert!(
        !addons.join("LibStub").exists(),
        "a vendored library must not be installed as a sibling addon"
    );
    assert!(addons
        .join("NotPlater-3.3.5/libs/LibStub/LibStub.lua")
        .is_file());

    // --- the same archive, a TBC server ---
    let (tbc_tmp, tbc_installed) = install_to(GameVersion::Tbc).await;
    assert_eq!(tbc_installed.folders, vec!["NotPlater-2.4.3".to_string()]);
    assert!(tbc_tmp
        .path()
        .join("Interface/AddOns/NotPlater-2.4.3/NotPlater-2.4.3.toc")
        .is_file());
    assert!(
        tbc_installed.version_matches,
        "and it is a correct install there too"
    );
}

/// An addon that changes its folder set between versions must not leave the old
/// folders behind. Correcting the folder-name rule moves existing installs, so
/// without this an updated NotPlater would sit next to its former self and the
/// game would load both.
#[tokio::test]
async fn updating_removes_folders_the_addon_no_longer_installs() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tempfile::tempdir().unwrap();
    let mut store = Store::default();
    let server_id = register_server(&mut store, tmp.path());
    let addons = tmp.path().join("Interface").join("AddOns");

    // v1 ships two folders.
    let v1 = zip_from(&[
        ("Repo-1/Thing/Thing.toc", b"## Interface: 30300\n"),
        (
            "Repo-1/Thing_Extra/Thing_Extra.toc",
            b"## Interface: 30300\n",
        ),
    ]);
    install::install(
        &forge_serving("v1.0.0", v1),
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("first install");
    assert!(addons.join("Thing").is_dir());
    assert!(addons.join("Thing_Extra").is_dir());

    // v2 drops the second one.
    let v2 = zip_from(&[("Repo-2/Thing/Thing.toc", b"## Interface: 30300\n")]);
    let updated = install::install(
        &forge_serving("v2.0.0", v2),
        &mut store,
        &server_id,
        &source(),
        &InstallOptions::default(),
        work.path(),
    )
    .await
    .expect("update");

    assert_eq!(updated.folders, vec!["Thing".to_string()]);
    assert!(addons.join("Thing").is_dir(), "the surviving folder stays");
    assert!(
        !addons.join("Thing_Extra").exists(),
        "the folder this addon no longer installs must be gone, not orphaned"
    );
}
