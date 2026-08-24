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

## Shipping a beta

> **Prerequisite:** the `TAURI_SIGNING_PRIVATE_KEY` secret must exist — see
> §2 below. Updater artifacts are switched on, so the release workflow refuses
> to start without it. That is the only manual setup a beta needs.

1. **Bump the three version strings together.** They are the beta's identity —
   the release name, the installer filenames and the string in
   **Settings → Copy diagnostics** all come from them.

   | File | Field |
   |---|---|
   | `Cargo.toml` | `workspace.package.version` |
   | `package.json` | `version` |
   | `src-tauri/tauri.conf.json` | `version` |

   `node scripts/check-bundle-config.mjs --tag v2.0.0-beta.4` confirms it, and
   both CI and the release workflow run the same check, so a mismatch fails in
   seconds rather than after a full build.

2. **Write the changelog section.** `CHANGELOG.md` gets a `## <version>`
   heading describing what changed *for someone using the app* — not the commit
   titles, which describe the code. The release notes are generated from it, and
   both CI and the release refuse a version with no section, so this is not
   optional and not something to reconstruct from memory later.

3. **Tag and push.**

   ```sh
   git tag v2.0.0-beta.1
   git push origin v2.0.0-beta.1
   ```

   The tag has to match the version, because the release is named from the
   version and found by the tag.

4. **The workflow does the rest.** `.github/workflows/release.yml` builds on
   Windows and Linux, runs the engine's tests as a gate, publishes a
   **pre-release** — not a draft — and then Cosign-signs the assets.

   `workflow_dispatch` with a `tag` input does the same thing for a tag that
   already exists.

For the next beta, bump the three versions to `-beta.2`, commit, and tag again.

### Why a pre-release rather than a normal one

GitHub keeps pre-releases out of `releases/latest`. That is the behaviour we
wanted while betas were shipping: the README sent people who were not ready for
V2 to *Latest release*, and that had to stay V1's installer until V2 was
actually stable. *Latest release* now points at V2.

It does not cost us the updater. That reads a fixed `updater` tag rather than
`releases/latest`, so betas are perfectly visible to it — see §3.

---

## Before 2.0.0 proper

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
alone.

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
- [ ] Put the **private** half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret.
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

**The manifest lives at a fixed `updater` tag**, not at
`releases/latest/download/latest.json`. GitHub defines "latest" as the newest
release that is neither a draft nor a *pre-release*, so that URL can never
resolve to a beta — and it is a property of the repository, not of the client,
so a beta install cannot ask it for pre-release content either. Publishing betas
as normal releases would fix the URL and break something worse: `releases/latest`
is the link the README gives for downloads.

A direct `releases/download/<tag>/` URL serves pre-release assets happily, so the
release workflow copies each build's `latest.json` onto a permanent `updater`
release. That release is itself marked as a pre-release, so it never becomes
anyone's "latest". Nothing needs changing when 2.0.0 ships.

**Checking is manual**, from *Settings → Check for updates*. This app writes into
a game directory, and someone mid-session does not want it restarting itself, so
there is no check on startup and nothing downloads until asked.

Only the AppImage self-updates on Linux; `.deb` and `.rpm` are owned by the
package manager.

### 4. Put the `.rpm` back

Dropped for the beta, from both `bundle.targets` in
`src-tauri/tauri.conf.json` and the Linux `args` in the release workflow.

RPM forbids a hyphen in its `Version` field, and Tauri's bundler writes the
config version there verbatim, so `2.0.0-beta.1` produces a package whose NEVRA
cannot be parsed. Confirmed by reading `VERSION` out of a real bundle's header,
not inferred. Once the version is plain `2.0.0` the problem disappears.

The `.deb` has a milder version of the same wart and is shipped anyway: Debian
reads `2.0.0-beta.1` as upstream `2.0.0` with revision `beta.1`, which sorts
*newer* than a future plain `2.0.0`. `dpkg -i` installs over it regardless, and
the `.deb` is not self-updating anyway, so it does not bite in practice — but do
not be surprised if `apt` calls the stable release a downgrade.

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
  It catches a tag that disagrees with the declared version, a straight
  apostrophe in `productName` (which breaks NSIS and nothing else), and an rpm
  target while the version is a prerelease.
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
