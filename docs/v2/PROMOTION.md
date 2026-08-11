# Releasing V2

## Where things stand

- **`v1-archive`** holds the final V1 code. It was `main`, renamed rather than
  force-pushed over, so V1's history is intact and its release assets — which
  hang off tags, not branches — are untouched.
- **`dev`** is the default branch and holds V2.
- **`dev` has not been renamed to `main`,** and does not need to be in order to
  ship a beta. That rename is a tidying-up step for 2.0.0 proper; see below.

Because `dev` is the default branch, `raw.githubusercontent.com/.../HEAD/...`
resolves to it, which is how the app reaches the curated lists. That URL names
no branch, so the eventual rename costs nothing.

---

## Shipping a beta

1. **Check the three version strings agree.** They are the beta's identity —
   the release name, the installer filenames and the string in
   **Settings → Copy diagnostics** all come from them.

   | File | Field |
   |---|---|
   | `Cargo.toml` | `workspace.package.version` |
   | `package.json` | `version` |
   | `src-tauri/tauri.conf.json` | `version` |

2. **Tag and push.**

   ```sh
   git tag v2.0.0-beta.1
   git push origin v2.0.0-beta.1
   ```

   The tag has to match the version, because the release is named from the
   version and found by the tag.

3. **The workflow does the rest.** `.github/workflows/release.yml` builds on
   Windows and Linux, runs the engine's tests as a gate, publishes a
   **pre-release** — not a draft — and then Cosign-signs the assets.

   `workflow_dispatch` with a `tag` input does the same thing for a tag that
   already exists.

For the next beta, bump the three versions to `-beta.2`, commit, and tag again.

### Why a pre-release rather than a normal one

GitHub keeps pre-releases out of `releases/latest`. That is the behaviour we
want: the README still sends people who are not ready for V2 to *Latest
release*, and that has to stay V1's installer until V2 is actually stable.

The cost is that the in-app updater cannot see betas either — which is moot for
now, because it is not switched on (see below).

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
- [ ] **Test `customFolderName`** — see the open question in
      [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md). Install `notplater` and
      confirm the game loads it from the folder V2 chooses. V1 forced
      `NotPlater-3.3.5`; V2 derives the name from the `.toc`. If the game needs
      the suffixed name, the override has to come back before release.

This is what the beta is *for*, so it can be done with real users rather than
alone.

### 2. Generate the updater signing key

Needs a repository secret, so it cannot be done from a coding session.

```sh
npm install                                    # `tauri` is node_modules/.bin/tauri
npm run tauri -- signer generate -w ~/.tauri/bam.key
```

On Windows, `~` does not expand — give the path in full:

```powershell
npx @tauri-apps/cli signer generate -w "$env:USERPROFILE\.tauri\bam.key"
```

- [ ] Put the **public** half in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- [ ] Put the **private** half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret.
- [ ] If you set a password, add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.

Until this is done the release still builds — it simply produces no updater
artifacts, because `createUpdaterArtifacts` is off. See the next section before
turning it back on.

### 3. Switch the in-app updater on

Four separate things are missing, and all four are needed:

- [ ] The signing key above. Without a `pubkey` the plugin has nothing to
      verify against.
- [ ] **`createUpdaterArtifacts` is `false`** in `src-tauri/tauri.conf.json`.
      Set it back to `true` *at the same time as* the signing secret, not
      before: with it `true` and no `TAURI_SIGNING_PRIVATE_KEY`, the bundler
      builds every installer and then fails the job outright — *"a public key
      has been found, but no private key"* — so the release never gets
      published. That is a hard dependency on a repository secret, which is why
      it is off for the beta.
- [ ] **Nothing calls it.** `tauri-plugin-updater` is registered in
      `src-tauri/src/lib.rs`, but no command or startup hook invokes a check, so
      the app never looks. This is deliberate for the beta rather than an
      oversight.
- [ ] The endpoint is `releases/latest/download/latest.json`, which resolves
      only once there is a non-pre-release. It will start working by itself when
      2.0.0 ships; it cannot be made to serve betas without publishing them as
      normal releases, which would hijack the link V1 users follow.

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
beta updates are manual, so it does not bite in practice — but do not be
surprised if `apt` calls the stable release a downgrade.

### 5. Rename `dev` to `main`

Optional, and purely cosmetic now that `dev` is already the default branch. If
you want the conventional name back:

1. Rename `dev` → `main` in *Settings → Branches*.
2. Confirm `main` is still the default afterwards.
3. Nothing in the code needs editing. `ci.yml` already triggers on `[main, dev]`,
   and the curated-list URL uses `HEAD` rather than a branch name.

Decide afterwards whether to create a fresh `dev` to work on or commit to `main`
directly, rather than drifting into one.

### 6. Housekeeping

- [ ] Revoke the `BlobKey` repository secret. The workflow that used it is gone,
      and a live storage key with nothing pointing at it is worth removing.
- [ ] Consider tagging V1's tip. The `v1.4.0` tag is one commit behind
      `v1-archive`, so it does not name the exact archived state, and a tag is
      harder to delete by accident than a branch.

      ```sh
      git fetch origin
      git tag v1-final origin/v1-archive
      git push origin v1-final
      ```

---

## What is already done

Nothing below needs action; it is recorded so the checklist above is trusted to
be complete.

- The `v2/` subdirectory has been flattened to the repository root.
- V1's source, build files and workflows are removed from this branch. They
  remain on `v1-archive` and in its releases.
- CI (`.github/workflows/ci.yml`) runs on `main` and `dev`, on Windows and
  Linux, and builds the engine, the frontend and the Tauri shell.
- The release workflow publishes rather than drafting, and derives
  pre-release status from the tag — reading the `workflow_dispatch` input first,
  since `github.ref_name` is a *branch* on a hand-triggered run.
- The curated lists are served from `HEAD`, so they survive branch renames. The
  `public/handy-addons.json` shim is gone; `catalog/wotlk.json` carries those
  entries and only the default branch is consulted.
- `vite.config.ts` sets `publicDir: false`, so the curated lists in `public/`
  are not bundled into the app as a stale copy.
- The app identifier is `com.lonebrownie.browniesaddonmanager.v2`, distinct from
  V1's, so both can be installed at once.
- The README describes V2 as a beta with real download instructions, and points
  people who want V1 at `v1-archive` and at *Latest release*.
