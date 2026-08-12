# Changelog

What changed in each release, in terms of what it means to use the app. The
release notes on GitHub are generated from this file, so a version with no
section here cannot be released.

Add the new section *before* tagging. Betas get an entry too — they are what
people are actually running.

## 2.0.0-beta.4 — unreleased

### Fixed
- **Switching an addon between releases and source** now offers the **Switch**
  button straight away. It used to appear only after pressing *Check for
  updates* by hand, so the app told you to switch and gave you nothing to press.
- **A server whose folder cannot be reached** keeps its addon list on screen,
  dimmed, under a banner — instead of replacing the whole list with a notice and
  hiding what you came to look at.
- **A server that comes back** is noticed. Availability was only worked out when
  the server list was reloaded, so a reconnected drive stayed "offline" until
  something unrelated refreshed it; renaming the server was the only reliable
  trick. The list is re-read when the window regains focus, and the banner has a
  **Check again** button.
- **A read-only server** says so on both My Addons and Browse, and every control
  it disables explains itself. Update and Switch were not blocked at all, so they
  ran an entire install before failing with a permission error from underneath.

### Added
- **Change folder** on each server, for a game that moved or a drive that changed
  letter. The server keeps its name, colour and every addon recorded against it.
- **Addons removed outside the app** are flagged `missing`, naming the folders
  that are gone, with **Reinstall** to put them back. The record is never
  silently dropped — and an unreachable drive is never mistaken for a deletion.
- **Open folder**, on each server row and beside the addon list, opening that
  server's `Interface/AddOns` in the file manager.
- The **running version** at the foot of Settings.
- A purple **highlight on Browse cards** under the cursor.

## 2.0.0-beta.3 — 2026-08-12

### Fixed
- **The missing-dependency warning** disappears once the addon it wanted is
  installed, instead of staying until you changed page.
- Switching an addon's channel no longer leaves the row with no way to act on it.

### Added
- **Open folder** for the selected server's `Interface/AddOns`.
- The app's version, shown in Settings.

## 2.0.0-beta.2 — 2026-08-12

### Fixed
- **Addon folder names are chosen for the server's game version.** NotPlater
  ships one manifest per version and has to land in `NotPlater-3.3.5` on WotLK;
  it was going to `NotPlater-2.4.3` on every server, so the game loaded the wrong
  one. Installing also clears folders an addon no longer uses, so an updated
  addon cannot end up loaded twice.
- **Bundled libraries stay inside the addon that ships them** rather than being
  installed alongside it as separate addons.
- **Browse marks an entry installed straight away**, rather than on the next page
  change.
- **Curated entries can track a branch.** Addons that never cut a release could
  not be installed from Browse at all.
- **"Copy addons to…"** says why it is unavailable, and a read-only game folder
  explains what to do about it.

### Removed
- The **Details Damage Meter** entry — the repository no longer exists.

## 2.0.0-beta.1 — 2026-08-12

First public build of V2. A rewrite: a Rust engine with a React interface,
packaged with Tauri, installing alongside V1 rather than over it.

- **Several game folders at once**, each with its own addons. Installing touches
  only the selected one.
- **GitHub and GitLab**, with a per-addon choice of tagged releases or the latest
  source build, and pinning to hold a version.
- **Multi-folder addons** tracked as one thing, removed as exactly the folders
  that were installed.
- **A curated list** with dependencies resolved and installed first.
- **Warnings before the mistake** — wrong game version, a folder collision that
  would overwrite something the app did not create, removing an addon others
  depend on.
- **Import from V1** by pasting its exported addon list.
- **Update checks in parallel**, cancellable.
