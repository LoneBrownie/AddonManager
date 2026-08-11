# Working in this repository

This is **V2**, a rewrite. The `dev` branch is the V2 line; `main` holds the
shipping V1 (Electron + Create React App) and the two are never merged.

**Read [`v2/ARCHITECTURE.md`](../v2/ARCHITECTURE.md) before changing anything
under `v2/`.** It records the invariants that are not obvious from the code, and
it exists because no human reviews these diffs. The reasoning behind the rewrite
is in [`docs/v2/V2-PLAN.md`](../docs/v2/V2-PLAN.md).

## The one rule

**The UI never touches the filesystem or the network.** Commands are
intent-level — `install_addon`, `remove_addon`, `check_updates` — never
primitive-level. There is no `read_file` and no `write_file`, and adding one is
not the fix for anything. V1's renderer had exactly those primitives, and that
is what made it unsafe.

## Stack

| Layer | What |
|---|---|
| `v2/core` | The engine. Pure Rust, no Tauri, no UI dependency. Where behaviour lives. |
| `v2/net` | The `reqwest` client. Separate so the engine's tests need no network. |
| `v2/src-tauri` | The shell. Thin wrappers over the engine. |
| `v2/src` | React + TypeScript, strict mode. |

## Before you commit

```sh
cd v2
cargo fmt --all
cargo clippy --all-targets -- -D warnings
cargo test
npx tsc --noEmit
python3 scripts/check_module_size.py
```

CI runs all of these on Windows and Linux. `unwrap`, `expect` and `panic!` are
denied by lint in the engine — a panic mid-install leaves a half-written game
folder. No module may exceed 400 lines of non-test code; when that trips, split
along a real seam rather than raising the limit.

## Tests

No test touches the network. `testing::FakeHttp` serves canned responses and
`testing::zip_from` builds archives in memory. Needing a live connection means
the design is wrong.

The malicious-archive fixtures are permanent. They encode zip slip, drive-
qualified paths, Windows device names, symlinks and zip bombs, and must keep
failing closed.

When fixing a bug, write the failing test first.
