# Brownie's Addon Manager — V2 Plan

**Status:** Draft for review
**Author:** Claude (via Claude Code)
**Target:** V2.0.0
**Scope:** Modernisation, multiple game-install support (CurseForge-style), Windows + Linux

---

## 1. TL;DR

V1 works, but it has three structural problems that block everything you want from V2:

1. **The addon engine lives in the browser.** `src/services/addon-manager.js` (1,662 lines) does every file operation over IPC from the renderer. A recursive folder scan is hundreds of round-trips, and it forced the preload script to expose *unrestricted* `readFile` / `writeFile` / `removeDirectory` / `downloadFile(url, anyPath)` to web content.
2. **It is Windows-only by construction, not by configuration.** Paths are joined with hard-coded `\\` (`addon-manager.js:31`). This isn't a build flag — it's threaded through the entire codebase.
3. **There is exactly one WoW directory in the data model.** `settings.wowPath` is a single string, and every addon record assumes it. Multi-install isn't a feature you can bolt on; it's a schema change that touches every read and write.

So V2 is a **rewrite of the engine and data model**, with the UI carried across. My recommendation is **Tauri v2 (Rust core + React/TypeScript frontend)** — it fixes the security model by design, gives real cross-platform packaging, and drops the installer from ~150 MB to ~10 MB. Track B (Electron + Vite + TypeScript, engine moved to the main process) is a documented fallback if you'd rather not take on Rust; the Phase 1 design work is identical either way.

Rough sizing: **6–9 weekends of focused work** to a Windows+Linux beta, with the multi-install feature landing at the end of Phase 2 (~40% in).

---

## 2. Decisions I need from you

Read this section first — everything downstream depends on it.

| # | Decision | Options | My recommendation |
|---|---|---|---|
| **D1** | **Stack** | (A) Tauri v2 + Rust + React/TS  (B) Electron + Vite + TS  (C) .NET + Avalonia | **B — Electron + Vite + TypeScript.** Revised from an earlier Tauri recommendation; see §5.1 for the evidence that changed it. |
| **D2** | ~~Auto-update continuity~~ | — | ✅ **DECIDED: break it.** Small user base. V1 users install V2 once by hand. **V2 still has its own auto-updater** — see §9.1. |
| **D3** | **Repo strategy** | New repo vs. `v2` branch in this repo vs. rewrite on `main` | **`v2` branch here**, merged to `main` at release. Keeps issues, stars, release history, and the curated-list workflow in one place. |
| **D4** | **macOS** | Support / ignore | **Build it, don't promise it.** Under Track A it's ~1 day of CI + a code-signing decision. Ship it unsigned as "community build" or skip. |
| **D5** | **Curated list hosting** | Keep Azure Blob / move to GitHub raw / both | **Both** — GitHub raw as primary (free, versioned, no secret), Azure as fallback. Removes a secret from CI. |
| **D6** | **GitHub token** | Ask users for an optional PAT / stay anonymous | **Optional PAT.** Anonymous GitHub API is 60 req/hr per IP — that's why V1 has HTML-scraping fallbacks. A PAT gives 5,000/hr and lets us delete ~200 lines of scraping. |
| **D7** | **Product identity** | Keep name/appId / rename | Keep the name. **Change `appId`** if you switch frameworks so V1 and V2 can coexist during migration. |
| **D8** | **Retail WoW** | Support modern retail / stay focused on 3.3.5a + private servers | **Design for it, don't test it.** The flavor model costs nothing extra; retail detection is a later PR. |

---

## 3. Where V1 stands today

### 3.1 Inventory

```
public/electron.js        989 lines   Main process — 20 IPC handlers, all generic FS/HTTP primitives
public/preload.js          84 lines   contextBridge surface
src/services/addon-manager.js 1662    THE engine: install, update, scan, group, version-compare
src/services/api-client.js    545     GitHub/GitLab release resolution + web-scraping fallbacks
src/hooks/useAddons.js        772     App state, persistence, existence polling
src/App.js                    354     Shell + tabs
src/components/*            ~1200     8 components + CSS
                          -------
                           ~6,600 lines JS/JSX, 0 tests
```

Build: `react-scripts` 5.0.1 (Create React App — **archived and unmaintained**, hence the `overrides` block in `package.json` pinning `nth-check` and `postcss` to dodge advisories).

### 3.2 What it does well

These are real and should survive into V2 unchanged in spirit:

- GitHub **and** GitLab support, with releases-vs-source-code as a per-addon choice.
- Graceful degradation when the API is rate-limited (even if the mechanism is ugly).
- Importing pre-existing addon folders and adopting them into management.
- Multi-folder addons (`WeakAuras` + `WeakAuras_Options`) tracked as one logical addon.
- Export/import of an addon list as plain text — a genuinely good "share with your guild" feature.
- Curated one-click list, CI-published to blob storage.
- Cosign-signed releases.

---

## 4. What's actually wrong

Specific findings, with file references. These are the bugs V2 needs to *not reproduce*.

### 4.1 Security

**S1 — The renderer has arbitrary filesystem access.**
`preload.js:7-17` exposes `readFile(path)`, `writeFile(path, content)`, `removeDirectory(path)`, `deleteFile(path)`, and `downloadFile(url, destPath)`. The main-process handlers (`electron.js:216-608`) validate only that the argument is a non-empty string. Any script execution in the renderer — an XSS in rendered remote JSON, a compromised dependency — gets full read/write on the user's disk under their account, plus a download-to-arbitrary-path primitive. `contextIsolation: true` is doing nothing useful here, because the bridge itself is the hole.

**S2 — Archive extraction is unbounded and unvalidated.**
`electron.js:392` calls `zip.extractAllTo(extractPath, true)` and trusts adm-zip entirely. There is no entry-count cap, no uncompressed-size cap (zip bomb), no explicit rejection of `..` / absolute / symlink entries. adm-zip has a history of path-traversal CVEs; relying on the library's internal checks for a program that extracts arbitrary third-party archives is the wrong posture.

**S3 — No write confinement.**
Nothing checks that an install target resolves inside the configured `Interface/AddOns` directory. A crafted `.toc` filename flows into the destination folder name via `determineBestFolderName()` (`addon-manager.js:371`).

**S4 — Elevation by relaunch.**
`electron.js:305-341` shells out to `powershell Start-Process -Verb runAs`, then the whole app runs as Administrator — every download, every extraction, every zip parse. This is the largest possible blast radius for the smallest possible need (writing to a folder under Program Files).

### 4.2 Data-loss and correctness bugs

**B1 — Removing your last addon doesn't persist.**
`useAddons.js:202`: `if (addons.length === 0) return;` — the save effect bails on an empty list, so the old `addons.json` survives. Delete your only addon, restart, and it's back in the list.

**B2 — Install can delete an unrelated addon folder.**
`addon-manager.js:570-577` computes `destPath` from a `.toc` filename and unconditionally `removeDirectory(destPath)` before copying. If that name collides with a folder the user installed by hand, it is deleted with no warning and no backup.

**B3 — Redirects in `fetch-webpage` resolve garbage.**
`electron.js:969`: `resolve(ipcMain.emit('fetch-webpage', event, location))`. `ipcMain.emit` returns a **boolean**, not page content. Any 301/302 in that path resolves `true`/`false` to a caller expecting HTML.

**B4 — `getCuratedAddons()` is broken dead code.**
`api-client.js:533` does `JSON.parse(response)` where the IPC handler (`electron.js:916`) already returns a parsed `{ok, json}` object. It would throw on every call. It's exported but never imported — `HandyAddons.jsx` has its own correct copy of the logic. Delete it.

**B5 — Temp path is always wrong.**
`addon-manager.js:171` reads `process.env.TEMP` in the **renderer**, where CRA only shims `NODE_ENV`, `PUBLIC_URL`, and `REACT_APP_*`. It's always `undefined`, so the temp dir silently falls back to `C:\temp` — a path that typically doesn't exist and isn't user-writable by convention.

**B8 — Missing folders permanently drop addons from management, and V2 would make this worse.**
`useAddons.js:164` filters out any addon whose folders aren't found on disk and persists the result. Today this is partly masked by B1: disconnect the drive and *every* addon vanishes, the list hits zero, the empty-list guard skips the write, and they return on restart. Two bugs cancelling out.

That accident stops working with multiple servers. One server on a disconnected drive goes missing while others remain, so the list isn't empty, so it saves — and that server's entire addon set is permanently gone from management. Given that these clients routinely live on secondary and external drives, this would be a common occurrence rather than an edge case. V2 needs the explicit `unavailable` state described in §5.3, and must never treat "path unreachable" as "user deleted these addons".

**B6 — Existence-check loop churn.**
`useAddons.js:156-197`: the effect depends on `addons`, calls `setAddons` inside itself, and creates a 30-second `setInterval`. Every addon-state change tears down and rebuilds the timer; the effect can also re-enter itself.

**B7 — Context menu resolves `null` after 5 s.**
`electron.js:695` races a 5-second timeout against the user's click. Leave the menu open while you think, and your selection is discarded.

### 4.3 Design debt

**D-a — Version comparison is 130 lines of guesswork.**
`isUpdateAvailable()` (`addon-manager.js:953-1077`) tries to classify strings at runtime into "semver", "branch name", or "date-sha", then applies a matrix of special cases (`main` ≡ `master`, `dev` ≡ `develop`, semver beats date-sha unless the user prefers code…). The information it's reverse-engineering — *what kind of thing did we install?* — was known at install time and simply wasn't recorded.

**D-b — Folder-relatedness heuristics are ~200 lines of string matching.**
`areAddonsRelated()` (`addon-manager.js:1291-1412`) carries a list of expansion names, a list of 60+ addon-ish suffixes, common-prefix analysis, and word-intersection scoring. It'll never be right, because the actual answer ("these folders came from one archive") is knowable and just isn't stored.

**D-c — Hardcoded addon special-cases in three files.**
AtlasLoot Epoch / Questie Epoch string matching appears in `addon-manager.js:461`, `addon-manager.js:1540`, and `useAddons.js:19` — and the addons themselves have since been removed from the curated list. This is display metadata leaking into logic.

**D-d — HTML scraping as a rate-limit workaround.**
`electron.js:726-848` regex-matches GitHub and GitLab web pages for release tags. It exists purely because 60 anonymous API requests/hour isn't enough for a user with 30 addons. A PAT plus ETag-conditional requests (which don't count against the limit when they 304) makes the whole thing unnecessary.

**D-e — Everything is sequential.**
`checkForUpdates()` (`addon-manager.js:849`) loops addons one at a time, awaiting each network round-trip. 30 addons ≈ 30 serial requests. There's no download progress, and nothing is cancellable.

**D-f — Diagnostics are invisible.**
Extensive `console.log` throughout, all of it in a renderer with DevTools closed in production. When a user reports "install failed", there's nothing to ask them for.

---

## 5. Target architecture

### 5.1 Stack recommendation

> **Revision note.** This section originally recommended Tauri. Two things changed it: (i) you confirmed you won't be writing any of the code yourself, which removes the costs Rust imposes on a *learner* but makes weak AI-assistance for Rust the dominant cost and leaves you unable to debug anything when a session isn't running; and (ii) checking the comparables (§5.1.1) showed the maintained apps in this exact niche are all Electron, and the one Rust attempt is archived. The recommendation is now **B**. The original Tauri case is preserved below because it isn't wrong — it's outweighed.

| | **A. Tauri v2** | **B. Electron + Vite + TS** *(recommended)* | **C. .NET 9 + Avalonia** |
|---|---|---|---|
| Backend language | Rust | TypeScript (Node) | C# |
| Installer size | ~8–12 MB | ~120–180 MB | ~35–70 MB |
| Idle RAM | ~60–90 MB | ~200–300 MB | ~80–120 MB |
| UI reuse from V1 | High (React + CSS port cleanly) | Highest (near drop-in) | None |
| Linux packaging | AppImage / .deb / .rpm, first-class | AppImage / .deb, workable | AppImage / .deb, workable |
| Security model | Capability-based, opt-in per command | Whatever you build | N/A (single process) |
| Auto-update | `tauri-plugin-updater` (signed manifest) | electron-updater (unchanged) | Custom / Velopack |
| Main risk | **Rust learning curve**; Linux WebKitGTK quirks | Keeps the heavy runtime; discipline-only security | Full UI rewrite; smallest ecosystem for this niche |

**The case for A, preserved.** The defining defects in V1 are (i) privileged filesystem primitives exposed to web content and (ii) an engine that can't do real work efficiently. Tauri fixes (i) *by construction* — the frontend can only call the commands you explicitly define and permit, and there is no ambient `fs` bridge to leak. And (ii) is exactly what Rust is good at: `zip` for traversal-safe extraction, `reqwest` for streaming downloads with progress, `tokio` for bounded concurrency, `serde` for a typed schema, `sha2` for integrity. The parts of V1 that are slow and dangerous become the parts that are fast and boring.

The secondary wins are real for a utility people leave running: a ~10 MB installer instead of ~150 MB, and roughly a third of the memory.

**The honest costs of Rust.** These are real, and worth weighing properly rather than skimming:

- **The learning curve is front-loaded, and async is the wall.** Ownership and borrowing click reasonably fast. Async Rust, `tokio`, and error handling across async boundaries are a genuine step up — and downloads-with-progress is async work, so you meet it early.
- **AI assistance is meaningfully weaker for Rust than TypeScript.** More iterations to reach compiling code, particularly around lifetimes and crate API churn. Given how this project has been built so far, this is a bigger practical cost than it looks on paper.
- **Compile times, asymmetrically.** Frontend work still hot-reloads instantly under Tauri dev. Backend edits cost 5–30 s incremental, and a clean release build is a couple of minutes.
- **Worse debugging.** No DevTools for the backend — it's `tracing` plus a debugger you configure, versus a Node inspector you may already know.
- **Two languages and a serialization boundary.** Track B is one language with shared types for free. `specta` / `ts-rs` generate TS types from Rust and mostly close the gap, but it's still two mental models.
- **Fewer potential contributors.** WoW tooling is overwhelmingly JS/TS. A Rust core shrinks the pool of people who might send a PR.
- **Prototyping is slower.** Rust makes you handle every error case up front — excellent for correctness, friction when you're still exploring a design.
- **Linux rendering goes through WebKitGTK** (`webkit2gtk-4.1`), not Chromium. For a UI this simple that means "test on Ubuntu and Fedora", not "rewrite the CSS" — but it is a consistency you give up.

### 5.1.1 What the comparables actually use

Checked rather than assumed, because it's the strongest available evidence about what this domain rewards:

| App | Stack | Status |
|---|---|---|
| **WowUp** | Electron + Angular + TypeScript | Active. **Already implements multi-client detection** — the headline V2 feature |
| **CurseForge** (standalone) | Electron | Active |
| **Ajour** | Rust + `iced` | **Archived September 2024**, 1,020 stars |

**Why this is decisive here.** WowUp is open source and solves the exact problem in §5.3 — detecting multiple game clients, per-install addon lists, the switcher. When a session hits a question like *"how do you reliably identify a WoW install across Wine prefixes?"*, being in the same language as the best reference implementation means reading and adapting their approach directly, rather than performing a translation across a language boundary every time. **Because the code is AI-written rather than hand-written, proximity to the reference implementation is worth considerably more than it would otherwise be.**

Two out of two maintained apps in this niche chose Electron. That isn't fashion — it says the domain doesn't demand native performance, and the ecosystem gravity is in JS.

Ajour deserves a fair reading rather than an opportunistic one: it used `iced`, a *native Rust GUI*, so its authors were writing the interface in Rust too — a considerably harder path than Tauri, where the UI stays React. Plenty of Electron addon managers have also died. It is nonetheless the closest comparable, and it stopped.

### 5.1.2 What choosing B gives up, and how it gets paid for

The compiler-as-substitute-for-review argument in favour of Rust is *correct*; it is simply outweighed. That safety therefore has to be bought explicitly rather than inherited:

- **TypeScript strict**, `noUncheckedIndexedAccess`, no `any` — CI-enforced, not aspirational.
- **The intent-level IPC surface of §5.2.** This was always the real fix for S1, and it is stack-independent. Electron is not why V1 is unsafe — generic primitives in the preload bridge are.
- **Tests as the actual merge gate** (§8), since they are the only code review this project gets. Coverage floor on the core; every behaviour change ships a test.
- **CI-enforced file-size and module limits**, so no future session recreates a 1,662-line `addon-manager.js`.

### 5.1.3 Licensing note

WowUp is **GPL-3**. Reading it to understand an approach is fine; lifting code is not, unless V2 is also GPL-3. This repo currently has **no LICENSE file at all** — worth choosing one for V2 either way.

**Phase 1 remains stack-independent.** The schema, update-resolution model, path-safety rules and their tests carry over unchanged if this decision is ever revisited.

### 5.2 Layering

The single most important structural change: **the frontend never touches the filesystem or the network.**

```
┌─────────────────────────────────────────────────────────┐
│  UI (React + TypeScript)                                │
│  Renders state. Dispatches intents. Zero I/O.           │
└───────────────────────┬─────────────────────────────────┘
                        │  typed commands + event stream
                        │  install_addon / remove_addon /
                        │  scan_installation / check_updates
┌───────────────────────┴─────────────────────────────────┐
│  Core (Rust)                                            │
│  ┌────────────┬────────────┬────────────┬────────────┐  │
│  │ sources    │ installer  │ store      │ discovery  │  │
│  │ gh/gl/     │ download,  │ schema v2, │ find WoW   │  │
│  │ direct     │ verify,    │ atomic     │ installs,  │  │
│  │ resolution │ extract,   │ writes,    │ detect     │  │
│  │            │ place,     │ migration  │ flavor     │  │
│  │            │ backup     │            │            │  │
│  └────────────┴────────────┴────────────┴────────────┘  │
│  All paths validated. All writes confined. All logged.  │
└─────────────────────────────────────────────────────────┘
```

Every command is **intent-level**, never primitive-level. There is no `write_file` command in V2. The frontend can ask to install addon X into installation Y; it cannot ask to write bytes to a path.

### 5.3 Data model — multiple installations

This is the headline feature, and it's a schema change more than a UI change.

**Today:** `settings.wowPath` is one string, and each addon record carries its own install state inline.

**V2:** three entities, normalised.

```jsonc
// Installation — one per game folder the user manages
{
  "id": "inst_01H...",
  "name": "Project Epoch",              // user-editable label
  "path": "C:\\Games\\Epoch",           // WoW root, not the AddOns dir
  "flavor": "wotlk",                    // vanilla|tbc|wotlk|cata|mop|retail|custom
  "interfaceVersion": 30300,            // for .toc ## Interface matching
  "addonsPath": "Interface/AddOns",     // resolved, case-corrected per platform
  "accent": "#c8a15a",                  // visual identity in the switcher
  "detected": true,                     // auto-found vs. manually added
  "writable": true                      // checked at registration, re-checked on install
}

// Addon — the upstream thing, independent of where it's installed
{
  "id": "github:LoneBrownie/SomeAddon",  // stable, derived from source
  "source": { "kind": "github", "owner": "…", "repo": "…" },
  "displayName": "Some Addon",
  "cache": { "etag": "…", "lastResolved": "…", "latest": { /* Ref */ } }
}

// InstalledAddon — the join. One row per (addon, installation).
{
  "installationId": "inst_01H...",
  "addonId": "github:LoneBrownie/SomeAddon",
  "channel": "release",                  // release | source   (was downloadPriority)
  "pinned": false,                       // was allowUpdates:false
  "installedRef": { /* Ref — see §5.4 */ },
  "folders": ["SomeAddon", "SomeAddon_Options"],  // exactly what we wrote
  "archiveSha256": "…",
  "installedAt": "2026-08-11T…",
  "backupId": "bk_…"                     // previous version, for rollback
}
```

Three things fall out of this for free:

- **`folders` is recorded, so `areAddonsRelated()` disappears.** We know `WeakAuras` and `WeakAuras_Options` are one addon because we wrote both from one archive. ~200 lines of heuristics deleted (§4.3 D-b).
- **The same addon can be installed to several installations at different versions**, tracked independently — which is precisely the CurseForge behaviour you asked for.
- **Uninstall is exact.** We remove the folders we created, and nothing else.

**Adding a server: always manual. No auto-detection, no scan button.**

> **Decided.** An earlier draft proposed drive scanning plus flavor detection from `.build.info`, MPQ contents, and executable build numbers. That was retail-shaped thinking, inherited from CurseForge and WowUp — both of which sit on top of Battle.net and get a product database and predictable install paths for free.
>
> Private-server clients have none of that. They're extracted from a zip to wherever the user felt like putting them, so scanning is slow, noisy (it surfaces every backup, every stale client, every half-extracted archive), and produces near-identical results the user then has to disambiguate anyway.

The flow is one dialog:

1. **Browse to the folder** — the WoW root, validated by the presence of `Wow.exe` and a `Data/` directory.
2. **Pick the version** from a dropdown: *WotLK 3.3.5a · TBC 2.4.3 · Vanilla 1.12*. User-selected, not detected.
3. **Name it** — defaults to the folder name, and users will typically enter the server ("Epoch", "Warmane Lordaeron").

This deletes an entire subsystem: no drive walking, no MPQ inspection, no build-number parsing, no `.build.info`, no Wine/Proton prefix hunting, no heuristics that can be wrong. It also removes one of the larger cross-platform risks, since per-platform discovery was the code most likely to diverge between Windows and Linux.

**Terminology:** the UI should say **"server"** rather than "installation" — for this audience an install effectively *is* a server, and that's the word users reach for. The underlying entity keeps a UUID identity so two folders for the same server, or a server with no addons, both remain expressible.

**Multiple servers on the same version is the normal case here, not the exception.** Retail managers assume one install per flavor; this audience routinely runs three separate 3.3.5a folders for three different servers. Identity is therefore the UUID plus the user's name — never the version — and the switcher shows the **name** prominently with the **path** beneath it, because "WoW" and "WoW" are otherwise indistinguishable.

**Unavailable paths.** These folders live on second drives, external drives, and removable media, so a server's path being temporarily unreachable is routine, not exceptional. A server whose path can't be resolved enters an explicit **`unavailable`** state: greyed in the switcher, its addon records left completely untouched. See finding B8 — V1's current behaviour would silently destroy them.

**UI and behaviour** — confirmed against how CurseForge and WowUp do it:

- A **dropdown switcher** pinned at the top of the sidebar (name + accent colour + addon count), the same shape as CurseForge's game-version selector.
- The addon list shows **only the addons installed to the selected install**. Switching the dropdown switches the whole view.
- **Installing an addon adds it to the selected install only.** That is the default and the only implicit behaviour — nothing is ever silently installed into another install.
- Update checks, pins, and channel settings are all **per install**. The same addon can sit in two installs at different versions, pinned in one and auto-updating in the other.
- **Uninstalling from one install does not touch the others.** Because `folders` is recorded per row, we remove exactly what we wrote there.
- A "Manage installations" screen to add, rename, re-detect, recolour, and remove.

Two additions on top, both **explicit opt-in actions** rather than default behaviour: an "Install to…" multi-select for when you *do* want an addon in several installs at once, and a **"Copy addon set from → to"** action for standing up a new install from an existing one — the feature people actually want the moment they run a live and a test install side by side.

### 5.4 Update resolution — record the ref, don't guess it

Replace the 130-line classifier (§4.3 D-a) with a recorded, tagged type:

```
Ref =
  | { kind: "release", tag: "v1.4.0", assetId?: 12345, publishedAt: "…" }
  | { kind: "branch",  branch: "master", sha: "abc1234", committedAt: "…" }
  | { kind: "direct",  url: "…", etag: "…", lastModified: "…" }
```

The rules become trivial and testable:

- **Compare like with like only.** `release` vs `release` → semver where both parse, publish date otherwise. `branch` vs `branch` → SHA inequality. `direct` vs `direct` → ETag / Last-Modified.
- **Never compare across kinds.** Today's "is a date-sha newer than a semver?" question doesn't arise, because the channel determines which kind we resolve.
- **Switching channel is an explicit user action**, presented as "switch to source builds", not surfaced as a phantom available update.

This kills the entire family of false-positive update bugs, and it's straightforwardly unit-testable — which the current version genuinely is not.

### 5.5 Security model

| Threat | V2 control |
|---|---|
| Renderer compromise → disk access (S1) | No generic FS commands exist. Intent-level API only. Tauri capability allowlist. |
| Zip slip / traversal (S2, S3) | Canonicalise every entry against the target root; reject `..`, absolute paths, symlinks, and device names (`CON`, `NUL`, `AUX`, …). Confine all writes under the registered installation's AddOns dir. |
| Zip bomb (S2) | Cap entry count (10k), per-entry size (256 MB), total uncompressed size (1 GB), compression ratio (200:1). Abort with a clear error. |
| Malicious redirect / SSRF | HTTPS only. Redirects followed only to an allowlist (github.com, codeload, objects.githubusercontent.com, gitlab.com, and their release CDNs). Max 5 hops. |
| Oversized / hung downloads | Streaming with a hard byte cap and idle timeout; partial files cleaned up. |
| Elevation blast radius (S4) | **Drop app-wide elevation.** Check writability when an installation is registered and tell the user exactly what to fix (move the install out of Program Files, or grant your user write access to `Interface\AddOns`). Never run downloads and archive parsing as Administrator. |
| Token leakage (D6) | PAT stored in the OS keychain (Windows Credential Manager / libsecret), never in the JSON store, never sent anywhere but the API host, redacted from all logs. |

### 5.6 Storage and migration

- One versioned store file (`schemaVersion: 2`), written **atomically**: temp file → `fsync` → rename. V1 writes in place and can be truncated by a crash or a power cut.
- Keep the last N states as rolling backups, so a corrupt store is recoverable rather than a fresh start.
- **V1 → V2 migration**, run once on first launch:
  1. Read V1 `settings.json` and `addons.json` from the old userData path.
  2. Create one `Installation` from `settings.wowPath` (name it from the folder, detect flavor, let the user confirm).
  3. Map each V1 addon → `Addon` + one `InstalledAddon` row.
  4. Translate `allowUpdates: false` → `pinned: true`; `downloadPriority` → `channel`.
  5. `currentVersion` → best-effort `Ref`. Where it's ambiguous (`"Imported"`, a bare branch name), mark the row `refUnknown` and resolve on the next update check rather than guessing.
  6. Archive the V1 files rather than deleting them, and show a migration summary.
- **Migration is a tested unit** with fixtures captured from real V1 data. It's the single thing most likely to annoy existing users, so it gets the same rigour as the installer.

---

## 6. Feature plan

### 6.1 Parity — must ship in 2.0

Everything V1 does today, on the new engine: GitHub + GitLab sources, release-vs-source channel per addon, add by URL, curated one-click list, import existing folders, export/import addon lists as text, per-addon update toggle (now "pin"), multi-folder addons, app auto-update.

### 6.2 New in 2.0

- **Multiple installations** (§5.3) — switcher, per-install addon sets, install-to-many, copy set between installs.
- **Linux support** — proper paths, Wine/Proton prefix discovery, case-insensitive `Interface/AddOns` resolution (Wine prefixes vary), AppImage + .deb + .rpm.
- **Backup and rollback.** Before overwriting, move the existing folders to a timestamped backup under app data; keep the last 3 per addon; expose "Restore previous version". This directly retires bug B2.
- **Flavor mismatch warnings.** Compare the `## Interface` value in an addon's `.toc` against the installation's interface version and warn *before* installing "this addon targets 5.4.8, this install is 3.3.5a". Cheap once multi-install exists, and prevents the most common private-server support question.
- **Real dependency handling.** The curated list already carries a `dependencies` array that nothing enforces. Resolve it on install; warn on removal when something still depends on it.
- **Bounded parallelism + progress.** Update checks 6-at-a-time; per-addon download progress; a cancel button that actually cancels.
- **Optional GitHub PAT** with ETag-conditional requests — retires the HTML scraper (§4.3 D-d).
- **Diagnostics.** Rotating structured log file, "Open logs folder", and a one-click "Copy diagnostics" that produces a redacted paste for issue reports.
- **UI modernisation.** Search / filter / sort, virtualised list, per-addon detail panel with release notes, keyboard navigation and focus-trapped modals (current modals have neither), light/dark themes, toasts instead of the single global error banner.

### 6.3 Deliberately out of scope for 2.0

Backlogged to 2.1+: CurseForge API integration (needs an API key and a ToS review), WoWInterface / Wago catalogs, cloud sync of addon profiles, WTF/SavedVariables backup, in-app addon browsing with screenshots, a plugin system.

---

## 7. Delivery plan

Each phase ends in something demonstrable. Estimates assume solo evenings/weekends.

### Phase 0 — Decisions and scaffolding · ~1 weekend
Settle D1–D8. Scaffold the chosen stack, TypeScript strict, lint + format, CI on Windows and Ubuntu from day one (a cross-platform project whose CI only runs Windows will silently stop being cross-platform). Write ADRs for the stack and schema choices.
**Exit:** an empty app builds and packages on both OSes in CI.

### Phase 1 — Core engine, headless · ~2 weekends
Schema v2 + store with atomic writes and migration. Source resolution (GitHub, GitLab, direct) with ETag caching. Streaming download with progress and caps. Traversal-safe extraction. `.toc` parsing (multi-flavor filenames, `## Interface` lists, dependency fields). Install / update / remove against a **fake WoW directory in a temp dir**. Full unit test coverage on version resolution, path safety, extraction, and migration.
**Exit:** a CLI or test harness installs and updates a real addon into a temp tree on both OSes. No UI yet.

### Phase 2 — Multiple servers · ~1 weekend *(reduced)*
Server entity, manual add flow (browse → pick version → name), writability check, `unavailable` state, switcher UI, manage-servers screen, install-to-many, copy-set-between-servers.
**Exit:** two servers registered side by side, the same addon at different versions in each, switching works. **This is the feature you asked for — it lands here.**

*Reduced from ~1.5 weekends: dropping auto-detection removes per-platform drive scanning and all flavor-detection heuristics.*

### Phase 3 — UI parity · ~2 weekends
Port the React components onto the new command API. Addon list, add-by-URL, curated list, import-existing, export/import lists, settings. Search/filter/sort, toasts, focus-trapped modals, themes.
**Exit:** feature-complete against V1, driven entirely by intent-level commands.

### Phase 4 — Cross-platform hardening · ~1 weekend
Linux path resolution and case handling, Wine/Proton discovery, permission errors with actionable messages, packaging (NSIS + portable zip on Windows; AppImage + .deb + .rpm on Linux), auto-update on both, keep Cosign signing.
**Exit:** installable artifacts for both OSes from a tagged CI run, auto-update verified end to end.

### Phase 5 — New capabilities · ~1.5 weekends
Backup/rollback, dependency resolution, flavor-mismatch warnings, PAT + keychain, parallel checks with cancellation, diagnostics and log export.
**Exit:** the §6.2 list is done.

### Phase 6 — Beta and release · ~1 weekend
Migration testing against real V1 profiles (yours and a couple of guildies'). Docs and screenshots. A final V1.x release that points users at V2. Tag 2.0.0.

**Total: ~10 weekends of solo work**, with the headline feature demonstrable after ~4.

Two sequencing notes that matter more than the estimates:

- **Phase 1 before any UI.** V1's problems trace back to the engine growing inside React. Building it headless and test-first is what prevents that recurrence.
- **CI on both OSes from Phase 0.** Retrofitting Linux CI in Phase 4 means discovering Phase-1 assumptions were Windows-shaped, three phases too late.

---

## 8. Testing strategy

Currently: zero tests. The single biggest quality lever in this plan.

| Layer | What | How |
|---|---|---|
| Unit | Version/ref comparison, `.toc` parsing, path safety, folder-name derivation, migration | Pure functions, table-driven cases. Every §4 bug gets a regression test. |
| Security | Zip slip, zip bomb, symlink entries, absolute paths, device names, redirect escapes | Committed **malicious archive fixtures**. These must fail closed, permanently. |
| Integration | install / update / remove / scan against a synthetic WoW tree | Temp dir fixtures, run on Windows **and** Linux in CI. |
| Contract | GitHub/GitLab response handling incl. 403, 404, empty releases, no-zip-asset | Recorded HTTP fixtures — no live network in CI. |
| Migration | V1 store → V2 store | Real captured V1 profiles as fixtures. |
| Smoke | App launches, switcher renders, install flow completes | One headed run per OS per release. |

Rule: **every bug in §4 ships with a failing test first.** That list is the initial backlog.

---

## 9. Build, packaging, release

### 9.1 Auto-update in V2

D2 ("break continuity") means *existing V1 users install V2 once by hand*. It does **not** mean V2 ships without an updater. V2 has a full auto-updater on both stacks:

| | Track A (Tauri) | Track B (Electron) |
|---|---|---|
| Mechanism | `tauri-plugin-updater` | `electron-updater` (unchanged from V1) |
| Signing | minisign keypair, private key in CI secrets | existing Cosign flow retained |
| Manifest | `latest.json` on GitHub Releases | `latest.yml` on GitHub Releases |
| Windows | ✅ NSIS / MSI self-update | ✅ NSIS self-update |
| Linux | ✅ **AppImage only** | ✅ **AppImage only** |
| macOS | ✅ (needs a signing decision — D4) | ✅ (same) |

Behaviour matches V1: check on launch and on an interval, download in the background with progress, install and relaunch.

**The one real caveat is a Linux constraint, not a framework one.** `.deb` and `.rpm` cannot self-update — that's the system package manager's job. Those users either re-download on release or you host an apt/dnf repo, which is meaningful ongoing work. **Recommendation: don't.** Ship AppImage as the self-updating Linux artifact, offer `.deb`/`.rpm` as convenience downloads, and have the app show a "new version available" notice with a link when it detects it can't self-update. Windows — where nearly all your users are — updates exactly as it does today.

### 9.2 Pipeline

- CI matrix: `windows-latest` + `ubuntu-latest` (+ `macos-latest` if D4 says yes) on every PR — build, lint, test.
- Release on tag, not on a `package.json` diff. The current version-diff trigger (`release.yml`) is clever but fires on unrelated pushes and makes re-releasing awkward.
- Artifacts: Windows NSIS installer + portable zip; Linux AppImage + .deb + .rpm.
- Keep Cosign keyless signing for all artifacts.
- Auto-update: signed manifest on GitHub Releases (Track A) or `latest.yml` unchanged (Track B). Manifest generation goes in CI — the current hand-rolled PowerShell that builds `latest.yml` by string concatenation is a maintenance hazard.
- Curated list: publish to GitHub raw as primary and Azure Blob as fallback (D5), with a schema version and CI validation of the JSON shape before upload.

---

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Codebase drift across many AI sessions** — the failure mode that produced V1's 1,662-line file, triplicated special-cases, and 200 lines of unverifiable heuristics | **High** | This is now the top risk, since no human reviews the diffs. CI-enforced file-size and module limits, a coverage floor on the core, every behaviour change shipping a test, and a maintained architecture doc re-read at the start of each session. TypeScript strict with no `any`. |
| No human can debug the code when a session isn't running | Medium | Chose the stack the author can at least read and inspect in DevTools (§5.1). Structured logs plus a one-click diagnostics export (§6.2) so failures are reportable without reading source. |
| Migration corrupts a user's V1 data | High | Archive V1 files rather than deleting. Tested against real profiles. Migration summary screen with an "undo" that just restores the archive. |
| Linux WebKitGTK rendering quirks | Medium | Simple UI, no exotic CSS. Test Ubuntu LTS + Fedora in CI. AppImage bundles what it can; document the `webkit2gtk-4.1` dependency. |
| Auto-update break strands V1 users | Medium | A final V1.x release that surfaces an in-app "V2 available" notice with a link. Announce in the README and release notes. |
| ~~Private-server layouts defeat detection~~ | — | **Eliminated.** There is no detection: adding a server is always manual, and the version is chosen from a dropdown (§5.3). |
| A server's drive is offline when the app checks | Medium | Explicit `unavailable` state. Never treat an unreachable path as "these addons were deleted" — see B8. |
| Scope creep (the §6.3 list is tempting) | Medium | 2.0 ships parity + multi-install + Linux. Everything else is 2.1. Write it down and hold the line. |
| Solo-maintainer bandwidth | Medium | Phases are independently shippable. Phase 2 alone is worth a release if you stop there. |

---

## 11. Appendix A — proposed repo layout (Track A)

```
src-tauri/
  src/
    main.rs
    commands/        # the intent-level API surface — the ONLY frontend entry point
    core/
      sources/       # github.rs, gitlab.rs, direct.rs, mod.rs
      installer/     # download.rs, extract.rs, place.rs, backup.rs
      store/         # schema.rs, migrate.rs, atomic.rs
      discovery/     # windows.rs, linux.rs, flavor.rs
      toc.rs
      paths.rs       # canonicalisation + confinement — the security chokepoint
    error.rs
  tests/
    fixtures/
      archives/      # incl. malicious zips — these must stay failing-closed
      v1-profiles/   # real captured V1 stores for migration tests
src/                 # React + TypeScript frontend
  features/
    installations/
    addons/
    catalog/
    settings/
  lib/api.ts         # generated/typed command bindings
docs/
  v2/
    V2-PLAN.md       # this file
    adr/             # architecture decision records
```

## 12. Appendix B — V1 file disposition

| V1 file | V2 |
|---|---|
| `public/electron.js` | **Deleted.** Its 20 generic handlers become ~12 intent-level commands. |
| `public/preload.js` | **Deleted.** Replaced by typed, permission-gated bindings. |
| `src/services/addon-manager.js` | **Rewritten** as `core/installer` + `core/toc` + `core/store`. Roughly 400 lines of heuristics (§4.3 D-a, D-b) don't survive, because V2 records what V1 was guessing. |
| `src/services/api-client.js` | **Rewritten** as `core/sources`. Scraping fallbacks retired in favour of PAT + ETag. |
| `src/hooks/useAddons.js` | **Rewritten.** Persistence and existence-polling move to the core; the hook becomes thin state binding. |
| `src/components/*` | **Ported.** Structure and CSS carry over; data access swaps to typed commands. Modals gain focus traps. |
| `public/handy-addons.json` | **Kept**, extended with a schema version and flavor tags. |
| `.github/workflows/*` | **Rewritten** for a build matrix and tag-triggered releases; Cosign retained. |
| `.github/copilot-instructions.md` | **Rewritten** — it currently states "Platform: Windows only". |
| `installer.nsh` | **Reviewed and carried** if the Windows installer stays NSIS. |

---

## Next step

Answer **D1–D8** in §2 (D1 and D2 are the ones everything else hangs off). Once the stack is settled I can scaffold Phase 0 and start Phase 1 — the schema, path-safety module, and their tests are the right first commit either way.
