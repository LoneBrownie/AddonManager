# Curated addon lists

One file per game version. The app fetches `catalog/<version>.json` for the
selected server and shows it as-is — there is no client-side version filtering,
because a 3.3.5a addon and its Vanilla equivalent are almost always different
repositories rather than the same entry tagged twice.

`wotlk.json` is the list that was previously `../handy-addons.json`.

## Serving

The app reads these over `raw.githubusercontent.com` at
**`.../AddonManager/HEAD/public/catalog/`**. `HEAD` is GitHub's alias for the
default branch, so an edit reaches users as soon as it lands on the default
branch, and renaming that branch does not break copies already installed.

That last part is not hypothetical — this used to name `main` explicitly, and
renaming `main` to `v1-archive` would have taken Browse down for every shipped
build.

## These are not release notes

Edits here reach users as soon as they land on the default branch, because the
app fetches the lists rather than bundling them. They are not tied to a build
and do not belong in `CHANGELOG.md`, which records what changed in a *release*.

`customFolderName` is gone. V1 used it to force an install folder; V2 derives
the folder from the `.toc` matching the server's game version, so the field did
nothing and named the wrong folder for any version but one.

## Entry shape

```jsonc
{
  "id": "classicapi",                                  // unique within the file
  "name": "Classic API",
  "description": "Essential API functions…",
  "repoUrl": "https://gitlab.com/Tsoukie/classicapi",  // GitHub or GitLab
  "category": "Core",                                  // groups the Browse page
  "dependencies": ["someOtherId"],                     // optional, ids in THIS file
  "channel": "source"                                  // optional, see below
}
```

## `channel`

Leave it out unless you need it. Omitted means tagged releases, which is right
for most addons.

Set it to `"source"` when the repository **never cuts releases** and only exists
as the head of its default branch — common for 3.3.5a backports. Without it the
entry installs on the release channel and fails outright, because the app
refuses to quietly switch channel behind your back: doing so would turn a
mistyped URL into a silent install of the wrong thing.

If you are unsure, open the repository's *Releases* page. Nothing there means
`"channel": "source"`.

Dependencies are resolved before install, including ones the user did not
explicitly pick. Unknown ids are ignored and cycles degrade to an arbitrary
order, so a mistake here cannot break installing.

A missing file means "no curated list for this version yet", which the app
states plainly. An empty array means the same thing.
