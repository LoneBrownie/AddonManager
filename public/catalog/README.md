# Curated addon lists

One file per game version. The app fetches `catalog/<version>.json` for the
selected server and shows it as-is — there is no client-side version filtering,
because a 3.3.5a addon and its Vanilla equivalent are almost always different
repositories rather than the same entry tagged twice.

`wotlk.json` is the list that was previously `../handy-addons.json`.

## Serving

The app reads these over `raw.githubusercontent.com` **pinned to `main`**, so
edits only reach users once they are on `main`. V2 development happens on `dev`
and is never merged, so changes to these files go to `main` directly.

## Entry shape

```jsonc
{
  "id": "classicapi",                                  // unique within the file
  "name": "Classic API",
  "description": "Essential API functions…",
  "repoUrl": "https://gitlab.com/Tsoukie/classicapi",  // GitHub or GitLab
  "category": "Core",                                  // groups the Browse page
  "dependencies": ["someOtherId"]                      // optional, ids in THIS file
}
```

Dependencies are resolved before install, including ones the user did not
explicitly pick. Unknown ids are ignored and cycles degrade to an arbitrary
order, so a mistake here cannot break installing.

A missing file means "no curated list for this version yet", which the app
states plainly. An empty array means the same thing.
