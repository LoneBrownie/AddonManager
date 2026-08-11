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

**Rename both branches. Do not force-push `main`.**

`main` holds V1 and shares no layout history with this branch, so a normal merge
would conflict across every file. The obvious alternative — force-pushing this
tree over `main` — works, but it rewrites the default branch of a public
repository: anyone who has cloned gets a divergence git cannot reconcile, and
undoing it means recovering a SHA from the reflog.

Renaming avoids all of that. Neither history is rewritten, GitHub retargets open
issues and pull requests automatically, and anyone with a clone is shown the
commands to update.

**Release assets are unaffected either way** — they hang off tags, not branches
— so V1's installers stay downloadable regardless. That is the part existing
users care about.

### Steps

1. **Tag V1's tip.** The `v1.4.0` tag is one commit behind `main`, so tag the
   exact archived state. A tag is harder to delete by accident than a branch.

   ```sh
   git fetch origin
   git tag v1-final origin/main
   git push origin v1-final
   ```

2. **Rename `main` → `v1-archive`** in GitHub's branch settings
   (*Settings → Branches*, or the pencil icon on the branches page). GitHub
   retargets open PRs and shows a rename notice to anyone with a clone.

3. **Rename `dev` → `main`.**

4. **Set `main` as the default branch.** Renaming step 2 leaves `v1-archive`
   as default, so this must be done explicitly.

5. **Check CI ran** on the new `main`. The workflow triggers on `[main, dev]`,
   so it should fire on the first push after promotion.

### Afterwards

There is no `dev` branch any more, because it became `main`. Either work
directly on `main` or create a fresh `dev` — decide rather than drift into it.

> If you would rather keep `main` as a continuous branch and accept the
> rewrite, the equivalent is `git push origin dev:main --force-with-lease`
> after tagging V1. `--force-with-lease` at least refuses if someone else has
> pushed since you fetched. The rename is still the better option.

---

## After promoting

- [ ] Update the README: swap the "not released yet" warning for real download
      links, and repoint the *Using V1* section at the `v1-archive` branch once
      V2 has an actual release.
- [ ] Tag a release: `git tag v2.0.0-beta.1 && git push origin v2.0.0-beta.1`.
      The release workflow builds Windows and Linux artifacts and opens a draft.
- [ ] Revoke the `BlobKey` repository secret. The workflow that used it is gone,
      and a live storage key with nothing pointing at it is worth removing.
- [ ] Decide whether to create a fresh `dev` branch or work on `main`
      directly. The old `dev` no longer exists — it became `main`.
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
