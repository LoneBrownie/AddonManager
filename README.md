<div align="center">

<img src="docs/v2/images/logo.png" alt="" width="120" />

# Brownie's Addon Manager

**Install and update World of Warcraft addons from GitHub and GitLab —
across as many game folders as you run.**

[![Version](https://img.shields.io/badge/version-2.0.0--beta-8b5cf6?style=flat-square)](https://github.com/LoneBrownie/AddonManager/releases)
[![Windows](https://img.shields.io/badge/Windows-supported-8b5cf6?style=flat-square&logo=windows&logoColor=white)](#installing)
[![Linux](https://img.shields.io/badge/Linux-supported-8b5cf6?style=flat-square&logo=linux&logoColor=white)](#installing)
[![Licence](https://img.shields.io/badge/licence-GPL--3.0-a78bfa?style=flat-square)](LICENSE)
[![Built with](https://img.shields.io/badge/built%20with-Rust%20%2B%20React-c084fc?style=flat-square&logo=rust&logoColor=white)](#building-it-yourself)

</div>

---

> [!WARNING]
> **V2 is in beta.** There are installers to download — see
> [Installing](#installing) — but this is a rewrite with far less real-world use
> behind it than V1. Back up your `Interface/AddOns` folder before pointing it
> at a game directory you care about, and expect to install new betas by hand.
> If you would rather wait, [V1 is still there](#using-v1). What is left before
> 2.0.0 proper is tracked in [`docs/v2/PROMOTION.md`](docs/v2/PROMOTION.md).

---

## Moving over from V1

> [!IMPORTANT]
> **V2 installs alongside V1, not over the top.** It is a separate application
> with its own settings, so V1 keeps working and nothing is changed or migrated
> automatically. If you dislike V2, carry on using V1.

Bringing your addons across takes about a minute:

| | Step |
|---|---|
| **1** | In **V1**, open **My Addons → Export Addon List** and copy the text. |
| **2** | In **V2**, add your game folder as a server (Browse to it, pick the game version, name it). |
| **3** | Click **Import list**, paste, and press **Install**. |

<div align="center">
  <img src="docs/v2/images/09-import-list.png" alt="Importing an addon list exported from V1" width="760" />
</div>

**Why the export rather than a folder scan?** V1 records the repository URL for
every addon it manages, so its export is the only reliable record of where your
addons actually came from. Most 3.3.5a addons are backports and forks, which
means a folder on disk cannot tell you which repository it was installed from —
an addon's own metadata usually names the *upstream* project, not the fork you
are running. Guessing would point updates at the wrong repository.

For addons V1 never managed, **Import existing** lists the unmanaged folders in
your game directory and lets you supply each URL yourself.

---

## What it does

### Several servers, side by side

A dropdown at the top of the sidebar scopes the whole app to one game folder.
Installing an addon touches **only** the selected server. The same addon can sit
in two servers at different versions, pinned in one and auto-updating in the
other, and removing it from one never touches the other.

Running three separate 3.3.5a folders for three different private servers is a
normal thing to do here, so servers are identified by the name *you* give them
with the path shown underneath.

<div align="center">
  <img src="docs/v2/images/02-switcher.png" alt="The server switcher, showing three registered servers" width="760" />
</div>

### Everything else

- **GitHub and GitLab**, with a per-addon choice between tagged releases and the
  latest source build.
- **Pin an addon** to keep a version and stop it being checked at all.
- **Multi-folder addons** — `WeakAuras` and `WeakAuras_Options` are tracked as
  one thing, and removing it removes exactly the folders that were installed.
- **A curated list** of one-click installs, with dependencies resolved and
  installed first.
- **Warnings that arrive before the mistake**: an addon built for another game
  version, a folder collision that would overwrite something the app did not
  create, or removing an addon others depend on.
- **Export and import addon lists** as plain text, to share with your guild.
- **Optional GitHub token** to lift the anonymous 60-requests-an-hour API limit
  to 5,000.
- **Update checks run in parallel** and can be cancelled.

<div align="center">
  <img src="docs/v2/images/01-addons.png" alt="The addon list for one server" width="760" />
</div>

<details>
<summary><b>More screenshots</b></summary>

<br />

**Managing servers** — rename, recolour, forget, or copy an addon set across.

<img src="docs/v2/images/12-servers.png" alt="The servers management screen" width="760" />

**Browsing the curated list**

<img src="docs/v2/images/18-browse-search.png" alt="Searching the curated addon list" width="760" />

**Removing an addon others depend on**

<img src="docs/v2/images/16-removal-warning.png" alt="A removal warning naming dependent addons" width="760" />

</details>

---

## Installing

Take the newest **`v2.0.0-beta`** build from the
[releases page](https://github.com/LoneBrownie/AddonManager/releases).

> [!IMPORTANT]
> Betas are published as pre-releases, so they are **not** what *Latest release*
> points at — that is still V1. Scroll to the top of the releases page rather
> than following a `/latest` link.

**Windows** — download and run the `.exe` installer.

**Linux** — take the **AppImage** unless you have a reason not to. A `.deb` is
also published; your package manager owns updates for it. There is **no `.rpm`
during the beta** — RPM refuses a version like `2.0.0-beta.1` — so on Fedora or
openSUSE, take the AppImage.

macOS is not supported.

**Updating during the beta is manual.** The app does not yet check for its own
new versions, and pre-releases would be invisible to that check anyway. Watch
the repository to hear about new betas. Self-updating switches on for 2.0.0 —
and on Linux only the AppImage can self-update at all.

### Where your addons go

Addons install to `Interface/AddOns` inside each server's folder. The app never
writes anywhere else, and **never deletes a folder it did not create** without
asking first.

If a folder is not writable — which usually means the game is installed under
`Program Files` — the app tells you rather than asking to restart as
Administrator.

---

## Using V1

V1 is still the stable release, and it is what
[*Latest release*](https://github.com/LoneBrownie/AddonManager/releases/latest)
points at — download the Windows installer from there.

Its source is on the
[`v1-archive`](https://github.com/LoneBrownie/AddonManager/tree/v1-archive)
branch. It is finished rather than maintained: it will keep working, but fixes
go into V2.

Its known issue stands: if your WoW directory is under Program Files, you need
to run it as Administrator. V2 does not have this requirement.

---

## Building it yourself

V2 is a Rust core with a React and TypeScript interface, packaged with Tauri.

```sh
npm install
npm run tauri dev        # run it
cargo test               # the engine's test suite
npm run tauri build      # produce installers for your platform
```

**Linux build dependencies:**

```sh
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

You can also run the interface on its own in a browser, with an in-memory
backend and no WoW installation needed:

```sh
npm run dev
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces fit together,
and [`docs/v2/V2-PLAN.md`](docs/v2/V2-PLAN.md) for why V2 exists and what was
decided along the way.

---

## Contributing

The curated lists live in [`public/catalog/`](public/catalog/) — one file per
game version, with [a README](public/catalog/README.md) describing the entry
shape. Adding an addon is a small pull request.

Bug reports are welcome. **Settings → Copy diagnostics** produces a redacted
summary worth attaching; it shortens paths and never includes your token.

## Licence

[GPL-3.0-or-later](LICENSE). You can use and modify this freely; if you
distribute a modified version, it has to stay open too.

## Acknowledgments

Our AI overlords Claude and ChatGPT.

My guildies for early testing.
