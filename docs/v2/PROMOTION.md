# Promoting `dev` to `main`

**Do not do this yet.** V2 has not been validated against a real game client.
The engine and interface are tested, but nobody has installed a real addon into
a real WoW folder with this build. That has to happen first.

This branch is *shaped* to become `main` — the layout, workflows and docs are
already what `main` should look like — so this is a checklist rather than a
migration.

---

## Before promoting

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

### 2. Generate the updater signing key

Needs a repository secret, so it cannot be done from a coding session.

```sh
npm run tauri signer generate -- -w ~/.tauri/bam.key
```

- [ ] Put the **public** half in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- [ ] Put the **private** half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret.
- [ ] If you set a password, add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` too.

Until this is done the release still builds, but produces unsigned artifacts the
in-app updater will refuse to install.

### 3. Publish the curated lists

The app fetches `public/catalog/<version>.json` from **`main`**. Those files
exist on this branch but not yet on `main`.

- [ ] Copy `public/catalog/` to `main`, **or** let the promotion carry it.

Until then a shim in `src-tauri/src/commands/catalog.rs` falls back to the old
`public/handy-addons.json` path for WotLK. Once the lists are live on `main`:

- [ ] Delete `LEGACY_URL` and its fallback branch.

---

## Promoting

`main` currently holds V1 and shares no history with this branch's layout, so a
normal merge would produce conflicts across every file. Replace the tree
instead:

```sh
# Tag V1 first so it stays reachable and installable.
git checkout main
git tag v1-final
git push origin v1-final

# Point main at this branch's tree.
git checkout dev
git push origin dev:main --force-with-lease
```

`--force-with-lease` rather than `--force`: it refuses if someone else has
pushed to `main` since you last fetched.

**V1 remains available** at the `v1-final` tag and in every existing V1 release,
so nothing is destroyed — but this does rewrite `main`, so do it deliberately.

---

## After promoting

- [ ] Update the README: swap the "not released yet" warning for real download
      links, and drop the *Using V1* section once V2 has an actual release.
- [ ] Tag a release: `git tag v2.0.0-beta.1 && git push origin v2.0.0-beta.1`.
      The release workflow builds Windows and Linux artifacts and opens a draft.
- [ ] Revoke the `BlobKey` repository secret. The workflow that used it is gone,
      and a live storage key with nothing pointing at it is worth removing.
- [ ] Delete the `dev` branch, or keep it as the working branch — either is
      fine, but decide rather than drift.
- [ ] Check that `.claude/settings.json` is present on `main`, so the
      session-start hook runs for future work.

---

## What is already done

Nothing below needs action; it is recorded so the checklist above is trusted to
be complete.

- The `v2/` subdirectory has been flattened to the repository root.
- V1's source, build files and workflows are removed from this branch. They
  remain on `main` and in its releases.
- CI (`.github/workflows/ci.yml`) runs on `main` and `dev`, on Windows and
  Linux, and builds the engine, the frontend and the Tauri shell.
- The release workflow (`.github/workflows/release.yml`) triggers on any `v*`
  tag and keeps V1's Cosign signing.
- `vite.config.ts` sets `publicDir: false`, so the curated lists in `public/`
  are not bundled into the app as a stale copy.
- The app identifier is `com.lonebrownie.browniesaddonmanager.v2`, distinct from
  V1's, so both can be installed at once.
