# Releasing V2

## Where things stand

- **`main`** is the default branch and holds V2. The rename in §5 has been done.
- **`v1-archive` is gone.** It held the final V1 code — it was the original
  `main`, renamed rather than force-pushed over — and has since been deleted.
  V1's release assets hang off tags rather than branches, so they are untouched,
  and V1 stays downloadable from its releases. That is the record that matters;
  the branch tip was not preserved and does not need to be.

Because `main` is the default branch, `raw.githubusercontent.com/.../HEAD/...`
resolves to it, which is how the app reaches the curated lists. That URL names
no branch, so neither the rename nor the deletion cost anything.

---

## Shipping a release

Betas and stable releases ship the same way. The tag is the whole difference: a
hyphen in it — `v2.2.0-beta.1` — publishes a pre-release, and one without —
`v2.2.0` — publishes a normal release that becomes `releases/latest`, which is
where the README's download link and version badge point.

> **Prerequisite:** the `TAURI_SIGNING_PRIVATE_KEY` secret must exist — see
> §2 below. Updater artifacts are switched on, so the release workflow refuses
> to start without it. It exists; this is worth re-reading only after a key
> rotation.

1. **Bump the three version strings together.** They are the build's identity —
   the release name, the installer filenames and the string in
   **Settings → Copy diagnostics** all come from them.

   | File | Field |
   |---|---|
   | `Cargo.toml` | `workspace.package.version` |
   | `package.json` | `version` |
   | `src-tauri/tauri.conf.json` | `version` |

   Both lockfiles carry the version too, so they move with them:
   `cargo metadata --locked` rewrites `Cargo.lock` and fails if it could not,
   and `npm install --package-lock-only` does `package-lock.json`. Nothing
   checks these, and a lockfile left behind is invisible until somebody reads
   it.

   `node scripts/check-bundle-config.mjs --tag v2.2.0` confirms the three, and
   both CI and the release workflow run the same check, so a mismatch fails in
   seconds rather than after a full build.

2. **Write the changelog section.** `CHANGELOG.md` gets a `## <version>`
   heading describing what changed *for someone using the app* — not the commit
   titles, which describe the code. The release notes are generated from it, and
   both CI and the release refuse a version with no section, so this is not
   optional and not something to reconstruct from memory later.

   A stable release gets a section of its own rather than a renamed beta one.
   Write it for the previous *stable* version — that is where nearly everybody
   is coming from, and it is what the window after the restart shows them. The
   beta sections stay below it as a record of what those builds were.

3. **Trigger the release.** Two routes, one workflow.

   - **Tag and push.**

     ```sh
     git tag v2.2.0
     git push origin v2.2.0
     ```

   - **Run it by hand** — *Actions → Release → Run workflow*, with the tag as
     the `tag` input. The tag does not have to exist first; publishing the
     release creates it. But the checkout follows the **branch the run is
     dispatched from**, not the tag input, so dispatch from the branch carrying
     the version bump — otherwise the build is of the wrong code under the
     right name.

   Either way the tag has to match the declared version, because the release is
   named from the version and found by the tag. The gates job checks that
   before anything is compiled.

4. **The workflow does the rest.** `.github/workflows/release.yml` runs the
   gates, builds on Windows and Linux, runs the engine's tests as a gate,
   publishes the release — not a draft — Cosign-signs the assets and deploys
   the updater manifests to Pages.

For the next beta, bump the three versions to `-beta.2`, commit, and tag again.

### Why a pre-release rather than a normal one

GitHub keeps pre-releases out of `releases/latest`. That is the behaviour we
wanted while betas were shipping: the README sent people who were not ready for
V2 to *Latest release*, and that had to stay V1's installer until V2 was
actually stable. *Latest release* now points at V2.

It does not cost us the updater. That reads a manifest on Pages rather than
`releases/latest`, so a pre-release is perfectly visible to it — see §3.

---

## Before a stable release

### 1. Validate against a real client

The one thing no test here can substitute for. On a real machine:

- [ ] Add a real WoW folder as a server; confirm it is detected as valid.
- [ ] Install an addon from GitHub and from GitLab; confirm the game loads them.
- [ ] Check for updates; confirm a real update installs and the game still loads.
- [ ] Import a V1 export into a fresh server and confirm the set installs.
- [ ] Import an existing hand-installed folder.
- [ ] Confirm a second server gets its own addons and the first is untouched.
- [ ] **Confirm NotPlater loads.** It ships a manifest per game version, and
      the folder name is now derived from whichever one matches the server —
      `NotPlater-3.3.5` on WotLK. Covered by an end-to-end engine test, but the
      one thing that test cannot do is watch the game load it. Check DBM too:
      its per-raid modules exercise the same multi-folder path.

This is what the beta is *for*, so it can be done with real users rather than
alone. The boxes are left unticked on purpose: this is run again for each
stable release, not once.

### 2. Generate the updater signing key

**Done.** Kept for the next key rotation. Recorded here because the release
workflow depends on the secret and cannot create it.

```sh
npm install                                    # `tauri` is node_modules/.bin/tauri
npm run tauri -- signer generate -w ~/.tauri/bam.key
```

On Windows, `~` does not expand — give the path in full:

```powershell
npx @tauri-apps/cli signer generate -w "$env:USERPROFILE\.tauri\bam.key"
```

- [x] Put the **public** half in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- [x] Put the **private** half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret.
- [ ] If you set a password, add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.

**The two halves have to be from the same keypair, and nothing enforces it.**
If they disagree, Tauri prints a *warning* and carries on:

> Warn The updater secret key from `TAURI_SIGNING_PRIVATE_KEY` does not match
> the public key from `plugins > updater > pubkey`.

The build stays green and the release publishes; the failure only appears later,
on a user's machine, as an update that refuses to install. The key ID is inside
the encrypted half of the secret key, so this cannot be checked before building
— read the release log for that warning after any key change.

The release workflow does check that the secret *exists*, and fails in seconds
if it does not, because `createUpdaterArtifacts` is on and Tauri would otherwise
build every installer before refusing to finish.

### 3. How the in-app updater works

Done, but worth understanding, because the obvious configuration silently never
updates anything.

**The manifests are two files on GitHub Pages**, deployed by the release
workflow:

| Channel | URL |
|---|---|
| Stable | `https://lonebrownie.github.io/AddonManager/latest.json` |
| Beta | `https://lonebrownie.github.io/AddonManager/beta.json` |

The updater reads one fixed URL, so each channel needs an address that never
moves, and `releases/latest/download/latest.json` cannot be one of them. GitHub
defines "latest" as the newest release that is neither a draft nor a
*pre-release*, so that URL can never resolve to a beta — and it is a property of
the repository, not of the client, so a beta install cannot ask it for
pre-release content either. Holding each manifest in a release of its own would
work, at the price of two permanent entries on the releases page that are not
downloads. Pages costs neither: deployed from a workflow artifact, the files
exist as a deployment rather than as a branch or a release.

**The beta channel carries stable releases too.** Every tag writes `beta.json`;
only a stable tag writes `latest.json`, and a pre-release carries the current
stable manifest forward rather than disturbing it. That is what ends a beta
opt-in rather than stranding it: somebody on `2.2.0-beta.1` is offered `2.2.0`
when it ships and lands back on stable.

**Which of the two a build reads is decided in Rust**, in
`src-tauri/src/commands/update.rs`, from the stored channel preference. The
updater plugin's JavaScript API has no way to name an endpoint, so the URL in
`tauri.conf.json` would otherwise be the only one a build could ever read.

**There was an `updater` release** holding a single manifest at a fixed tag,
which is how this worked up to 2.0.1. Every build from 2.1.0 on reads Pages;
that release, and the workflow blocks that kept feeding it, are gone.

**Checking is one look on opening, and then on request.** The app says once,
when it opens, if a new version is out, and says nothing at all if that check
fails — being offline is not news. Everything after that is *Settings → Check
for updates*: this app writes into a game directory and someone mid-session does
not want it restarting itself, so nothing downloads until it is asked for.

Linux self-updates as the AppImage, which is the only Linux package built — see
§4.

### 4. Linux is the AppImage and nothing else

Not a to-do — a decision, recorded because it once read like a temporary one.
`.deb` and `.rpm` are gone from both `bundle.targets` in
`src-tauri/tauri.conf.json` and the Linux `args` in the release workflow, and
they stay gone.

**Why they stay gone.** The updater picks its download by searching the manifest
for `linux-x86_64-<installer>` and falling back to `linux-x86_64`, which names
the AppImage. A `.deb` installation was therefore offered an update, downloaded
an AppImage and handed it to `install_deb`. A package whose update button cannot
work is worse than one package fewer.
`scripts/check-bundle-config.mjs` fails the build if either target reappears in
the workflow — the workflow rather than the config, because `--bundles` on the
command line overrides `bundle.targets`.

**Why they went in the first place**, which no longer applies and is not a
reason to bring them back: RPM forbids a hyphen in its `Version` field and
Tauri's bundler writes the config version there verbatim, so `2.0.0-beta.1`
produced a package whose NEVRA could not be parsed — confirmed by reading
`VERSION` out of a real bundle's header, not inferred. A plain version fixes
that and changes nothing above.

The `.deb` had a milder version of the same wart: Debian reads `2.0.0-beta.1` as
upstream `2.0.0` with revision `beta.1`, which sorts *newer* than a later plain
`2.0.0`.

### 5. Rename `dev` to `main`

**Done.** `main` is the default branch, and no `dev` branch remains — work lands
on `main`. Nothing in the code needed editing: `ci.yml` already triggered on
`[main, dev]`, and the curated-list URL uses `HEAD` rather than a branch name.

### 6. Housekeeping

- [ ] Revoke the `BlobKey` repository secret. The workflow that used it is gone,
      and a live storage key with nothing pointing at it is worth removing.
- [x] Tag V1's tip — **decided against.** `v1-archive` was deleted without
      tagging its tip, so the one commit it carried past `v1.4.0` (a README
      edit) is not referenced by anything. That is deliberate: V1 remains
      downloadable from its releases, which is all that is needed of it.

---

## What is already done

Nothing below needs action; it is recorded so the checklist above is trusted to
be complete.

- The `v2/` subdirectory has been flattened to the repository root.
- V1's source, build files and workflows are removed from this branch. They
  remain at the `v1.4.0` tag and in V1's releases.
- CI (`.github/workflows/ci.yml`) runs on `main` and `dev`, on Windows and
  Linux, and builds the engine, the frontend and the Tauri shell.
- The release workflow publishes rather than drafting, and derives
  pre-release status from the tag — reading the `workflow_dispatch` input first,
  since `github.ref_name` is a *branch* on a hand-triggered run.
- `scripts/check-bundle-config.mjs` runs in CI and again at the top of a release.
  It catches the three declared versions disagreeing, a tag that disagrees
  with them, a straight apostrophe in `productName` (which breaks NSIS and
  nothing else), a `deb` or `rpm` target in the release workflow, and a version
  with no changelog section.
- The product name uses a typographic apostrophe. A straight one broke the
  Windows installer for exactly one beta.
- The curated lists are served from `HEAD`, so they survive branch renames. The
  `public/handy-addons.json` shim is gone; `catalog/wotlk.json` carries those
  entries and only the default branch is consulted.
- `vite.config.ts` sets `publicDir: false`, so the curated lists in `public/`
  are not bundled into the app as a stale copy.
- The app identifier is `com.lonebrownie.browniesaddonmanager.v2`, distinct from
  V1's, so both can be installed at once.
- The README describes V2 with real download instructions. Its V1 sections are
  gone; *Moving over from V1* is all that remains, and it no longer points at
  `v1-archive` or at a V1 download.
