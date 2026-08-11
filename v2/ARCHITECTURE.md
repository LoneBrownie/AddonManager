# V2 Architecture

**Read this at the start of any session that touches `v2/`.** It exists because
no human reviews these diffs, so the rules that keep the codebase from drifting
have to be written down rather than remembered.

The full reasoning lives in [`../docs/v2/V2-PLAN.md`](../docs/v2/V2-PLAN.md).
This is the short operational version.

---

## The one rule

**The UI never touches the filesystem or the network.**

V1's defining flaw was an engine that lived in a React renderer and reached the
disk through generic IPC primitives — `readFile(path)`, `writeFile(path, data)`,
`removeDirectory(path)`, `downloadFile(url, anyPath)` — exposed to web content
with no validation beyond "is it a string" (V2-PLAN.md S1).

So: commands are **intent-level**, never primitive-level.

```
install_addon(server_id, source, options)     ✅
remove_addon(server_id, addon_id)             ✅
check_updates(server_id)                      ✅

write_file(path, contents)                    ❌ never
read_file(path)                               ❌ never
```

If a UI feature seems to need a primitive, the answer is a new intent-level
command, not a new primitive.

---

## Layout

```
v2/
  core/          Rust engine. No Tauri, no webview, no UI dependency.
    src/
      paths.rs      Canonicalisation and confinement — the security chokepoint
      archive.rs    Zip extraction with explicit, caller-controlled limits
      toc.rs        .toc manifest parsing
      version.rs    Ref type and update comparison
      model.rs      Server / Addon / InstalledAddon, and the Store
      store.rs      Atomic persistence
      sources/      GitHub and GitLab resolution
      install.rs    Install, update, remove orchestration
      servers.rs    Registering and managing game folders (manual add only)
      bulk.rs       Install-to-many and copy-set-between-servers
      http.rs       The network trait (no client lives here)
      testing.rs    Fakes — nothing in the suite touches the network
    tests/
      install_flow.rs   End-to-end against a synthetic WoW directory
      multi_server.rs   Several servers side by side (phase 2 exit criteria)
  net/           reqwest-backed HttpClient. Kept out of core so the engine
                 stays network-free in tests.
  src-tauri/     The Tauri shell — thin wrappers over the engine.
    src/
      commands/     The ONLY surface the UI can call
      dto.rs        Flat, camelCase shapes for the frontend
      state.rs      Store, preferences, work directory
  src/           React + TypeScript frontend
    api.ts          One function per Rust command. No primitives.
    mock.ts         In-memory backend, so the UI runs in a plain browser
    components/
  scripts/       CI guardrails and the screenshot harness
```

`core` being a plain library is deliberate: it builds and tests on a bare
runner with no `webkit2gtk`, which is what makes the engine verifiable
independently of the GUI.

---

## Invariants

These are enforced by tests. Breaking one should turn the suite red.

1. **Every write resolves through `paths::confine`.** No exceptions.
2. **Nothing is deleted that the app did not create.** Before writing, each
   destination folder is classified by `install::plan_folders` as ours, another
   addon's, or unmanaged. The last two block unless the user has explicitly
   consented. Backups are out of scope (D11), so the collision is *prevented*
   rather than made recoverable (V2-PLAN.md B2).
3. **Archives are validated before anything is written.** Extraction is two
   passes; a bad entry anywhere aborts the whole archive with nothing on disk.
4. **Refs are compared like-with-like only.** A release is never compared
   against a branch head. Changing channel is an explicit user action, not an
   available update (V2-PLAN.md D-a).
5. **An unreachable server path means "cannot check", never "deleted".** A drive
   being unplugged must never remove installation records (V2-PLAN.md B8).
6. **Folders written are recorded.** That is what makes removal exact and what
   removes the need for V1's folder-relatedness heuristics (V2-PLAN.md D-b).
7. **No panics in the engine.** `unwrap`, `expect` and `panic!` are denied by
   lint. A panic mid-install takes the app down with a half-written game folder.

---

## Guardrails

| Gate | Enforced by |
|---|---|
| No module over 400 lines of non-test code | `scripts/check_module_size.py` in CI |
| No `unwrap` / `expect` / `panic!` in the engine | `[lints.clippy]` in `core/Cargo.toml` |
| No warnings anywhere | `RUSTFLAGS: -D warnings` in CI |
| Formatting | `cargo fmt --check` in CI |
| Windows and Linux both build and test | CI matrix, from the first commit |

Raising a limit is not the fix when a gate trips. Splitting along a real seam is.

---

## Testing

Run everything:

```sh
cd v2 && cargo test
```

**No test touches the network.** `testing::FakeHttp` serves canned responses and
records what was asked for; `testing::zip_from` builds archives in memory.
Adding a test that needs a network connection means the design is wrong.

The malicious-archive tests in `archive.rs` and `install_flow.rs` are
**permanent**. They encode zip slip, drive-qualified paths, Windows device
names, symlinks and zip bombs. They must keep failing closed forever.

Every finding in V2-PLAN.md section 4 either has a regression test or is
structurally impossible in V2. When fixing a new bug, write the failing test
first.

---

## Building the GUI in a web session

The Tauri app **can** be compiled and run here. The base container lacks
WebKitGTK and its apt index is stale enough that a plain `apt-get install`
404s — which looks like a blocked network but is not. `.claude/hooks/session-start.sh`
runs `apt-get update` first and installs the toolchain, so this is handled
automatically at session start.

The React frontend needs none of that: it is an ordinary web app, so it can be
served with Vite and driven with the preinstalled Playwright Chromium against a
mocked `invoke` bridge. Screenshots of real UI are therefore possible without
Tauri at all.

What still cannot be done here: running the finished app against a **real WoW
folder with a real network**. That is release acceptance testing and belongs to
the author regardless of tooling.

---

## Not yet built

Phases 3 onward, tracked in V2-PLAN.md:

- Renaming, recolouring and forgetting a server from the UI. The commands
  exist; the manage-servers screen does not.
- Copy-set and install-to-many are wired end to end, but only install-to-many
  has a UI entry point.
- Import existing addon folders, and addon-list export/import screens. The
  `export_addon_list` and `parse_addon_list` commands exist and are tested.
- Dependency resolution, version-mismatch warnings, and diagnostics export
  (phase 5).

## Seeing the UI without a WoW install

`npm run dev` serves the frontend against `mock.ts`, an in-memory backend, so
the whole interface can be exercised in a plain browser. `node scripts/screenshot.mjs`
drives it with Playwright and writes to `screenshots/`. Run `npx vite preview`
first. Point `executablePath` at whatever Chromium the container has.
