# Changelog

What changed in each release, in terms of what it means to use the app. The
release notes on GitHub are generated from this file, so a version with no
section here cannot be released.

Add the new section *before* tagging. Betas get an entry too — they are what
people are actually running.

## Unreleased

### Added
- **An activity stream**, behind the *Activity* handle down the right-hand edge.
  Every message the app raises goes there and stays for the session, so a
  notification that has been and gone can still be read. It slides out beside
  what you are working on rather than replacing it, filters down to just the
  problems, and copies out as text for a bug report.

### Changed
- **Anything that acts on many addons at once now says so once.** Importing a
  list of thirty with a dozen bad URLs used to put a dozen separate messages on
  screen, each needing its own dismissal; the same is true of *Update all* and
  of installing to several servers. Each of those is now a single line — "6
  imported, 4 failed" — with the individual failures folded underneath it in
  the activity stream.
- **Notifications no longer stay on screen until dismissed.** Errors used to,
  because a dismissed message was gone for good. Now that everything is kept,
  they clear themselves like the rest, and no more than three are ever stacked
  at once.

### Fixed
- **Updating an addon no longer overwrites folders it does not own.** It could,
  unconditionally, which was only ever meant to cover the first update after
  adopting an addon that was already in the game folder — before the app has
  recorded the rest of its folders. It is now limited to exactly that.

## 2.0.1 — 2026-08-12

### Added
- **A theme setting**, under *Settings → Appearance*: **System**, **Dark** or
  **Light**. The light theme existed in the stylesheet from the start and there
  was no way to choose it, so nobody had ever seen it. *System* follows your
  desktop and changes with it; picking dark or light means it stays there.

### Fixed
- **Scrollbars are the right colour.** They were the desktop's default — a white
  bar down the side of every list in a dark window — because nothing told the
  webview which way round the app is.
- **The server you had selected comes back when you reopen the app.** It was
  being recorded on every switch and never read, so it always opened on
  whichever server happened to be first.
- **The GitHub token is no longer readable by the interface.** It was included
  in the preferences the frontend could ask for, which contradicted what
  Settings says about it and what the "is a token set?" check exists for.

## 2.0.0 — 2026-08-12

**V2 is out of beta.** A rewrite — a Rust engine with a React interface,
packaged with Tauri — installing alongside V1 rather than over it, so V1 keeps
working and nothing is migrated without being asked.

Seven betas of real use went into this. If you have been running one, this is
the same application with the beta label removed.

### What it does
- **Several game folders at once**, each with its own addons and its own
  versions of them. Installing touches only the server you have selected.
- **GitHub and GitLab**, with a per-addon choice between tagged releases and the
  latest source build, and pinning to hold a version where it is.
- **Multi-folder addons** tracked as one thing and removed as exactly the
  folders that were installed — never as a guess about which folders looked
  related.
- **A curated list** per game version, with dependencies installed first.
- **Moving in from V1** by pasting its exported addon list. Addons already in
  the game folder are recognised and taken over where they stand rather than
  downloaded again.
- **Warnings before the mistake**, not after: the wrong game version, a folder
  collision that would overwrite something this app did not create, removing an
  addon others depend on, a read-only game folder.
- **Update checks in parallel**, cancellable, and never a phantom one — what was
  installed is recorded at install time instead of being inferred from a version
  string later.

### Changed since the last beta
- **The release notes are no longer printed beside the update button.** They
  were shown there as raw text, which meant a wall of Markdown punctuation the
  moment the notes became real ones. What changed belongs in the window that
  appears after the restart, which renders it properly, and nowhere else.
- **The `.rpm` is back.** It was dropped throughout the beta because RPM refuses
  a version like `2.0.0-beta.1`; a plain `2.0.0` has no such problem.

## 2.0.0-beta.7 — 2026-08-12

### Added
- **What changed, on the first launch after an update.** A window listing the
  entry for the version you have just moved to, shown once and then not again.
  The notes are compiled into the app, so they appear whether or not the machine
  is online and always describe the build actually running.
- **The update itself now says what it contains** before you install it. It used
  to offer "See the release notes for v2.0.0-beta.6", which is no help to
  somebody deciding inside the app whether to take it.

### Fixed
- **Setting a GitHub token no longer breaks every GitLab addon.** The token was
  being sent to GitLab as well, and GitLab rejects a credential it does not
  recognise — so a setting offered as a pure improvement quietly made most of
  the curated 3.3.5a list unreachable for anyone who used it. GitLab is now
  asked anonymously, which is what it wants: it allows 500 unauthenticated
  requests a *minute*, where GitHub allows 60 an *hour*. The token is a GitHub
  credential and now goes nowhere but GitHub, as Settings always claimed.

## 2.0.0-beta.6 — 2026-08-12

### Fixed
- **Updating an adopted addon is no longer blocked by its own folders.** An
  addon that ships several folders is usually recognised by one of them, so the
  rest were still unclaimed — and the update then refused to write over folders
  you had just told it about. Updating now writes over them and records them, so
  removing the addon later takes all of it. Installing something *new* still
  refuses, which is the case that rule is actually for: there, nothing has said
  the colliding folder is the same addon.
- **An adopted addon whose repository has no releases can be updated.** Adoption
  gives an addon a channel because a record needs one, not because anyone chose
  it, so the first update falls back to the default branch instead of telling
  you to go and switch a channel you never set.

## 2.0.0-beta.5 — 2026-08-12

### Fixed
- **Importing a V1 addon list works on a game folder that already has the
  addons in it** — which is every game folder anyone is importing into. Two
  things were failing nearly every line of the list:
  - An addon whose repository has never published a release now installs from
    its default branch and is recorded as tracking `source`, instead of failing
    with advice to go and switch a channel on an addon that was never installed.
    Outside importing, that refusal stands: silently changing channel would hide
    a mistyped URL.
  - An addon already sitting in the game folder is **taken over where it
    stands** rather than refused. Nothing on disk is touched — your working
    files stay exactly as they are, tagged `adopted` at an unknown version, with
    **Update** on the row to replace them with a version this app can name when
    you want it.
- **The list fills up as an import runs**, one addon at a time, rather than
  staying still until the whole list has finished.

### Changed
- **An addon list now carries the channel, the exact version and the folders
  each addon occupies**, not just its repository. Which means an import into a
  game folder that already has the addons in it **downloads nothing at all** —
  it recognises what is there and records it at the version the list states.
  Exports still read as a plain list of URLs, so V1 and older builds of this app
  can still import them.
- **A V1 list also imports without downloading.** V1 wrote each addon's name
  beside its URL, and a folder on disk reports that same name in its `.toc`, so
  an exact match identifies the folder — its component folders included. Where
  nothing matches, the addon really is not there and is fetched as before.
- The import dialog **lists what it found** — name, version, folders — before
  installing anything, and says how many addons were already present when it
  finishes.
- **An addon adopted from disk shows `unknown version` and offers Update.** It
  used to read `adopted@adopted` and offer *Switch*, as if the user had changed
  a channel they had never chosen.
- **A server with nothing managed yet says so.** It claimed nothing matched a
  search that had not been typed.

## 2.0.0-beta.4 — 2026-08-12

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
- A purple **highlight** under the cursor on Browse cards and server rows.

### Changed
- **Buttons are outlined rather than filled**, taking their colour from what
  they do: ordinary actions stay neutral, the primary action is purple, and
  anything destructive is red. Hovering brightens a button's edge and text
  instead of moving it.
- **Addons already in your game folder that this app does not manage now appear
  in the list**, after your managed ones, greyed and tagged `unmanaged`, each
  with a **Manage** button that asks for its repository URL. They used to be
  visible only behind an *Import existing* button, which meant you had to know
  to go looking; the button is gone, because the list says it now.

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
