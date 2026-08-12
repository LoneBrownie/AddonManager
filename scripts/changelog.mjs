// Turn CHANGELOG.md into the body of a GitHub release.
//
//   node scripts/changelog.mjs --version 2.0.0-beta.4
//
// Exits non-zero when the version has no section, which is the point: the
// release workflow runs this before building, so shipping a version nobody
// wrote notes for fails in seconds rather than producing a release whose notes
// describe the previous one.

import { readFileSync } from "node:fs";

const versionArg = process.argv.indexOf("--version");
if (versionArg === -1 || !process.argv[versionArg + 1]) {
  console.error("usage: changelog.mjs --version <x.y.z>");
  process.exit(2);
}
const version = process.argv[versionArg + 1].replace(/^v/, "");

const changelog = readFileSync("CHANGELOG.md", "utf8");

// Sections are `## <version> — <date>`; take everything up to the next one.
const heading = new RegExp(`^## ${version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b.*$`, "m");
const start = changelog.search(heading);
if (start === -1) {
  console.error(
    `CHANGELOG.md has no section for ${version}.\n` +
      "Add one before tagging — the release notes come from it.",
  );
  process.exit(1);
}
const rest = changelog.slice(start);
const nextHeading = rest.slice(1).search(/^## /m);
const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1)).trim();

// Drop the version heading itself: the release is already titled with it.
const changes = section.split("\n").slice(1).join("\n").trim();
if (!changes) {
  console.error(`CHANGELOG.md's ${version} section is empty.`);
  process.exit(1);
}

const beta = version.includes("-");

// The standing part. Every release needs it, and it does not belong in the
// changelog itself, which is a record of changes rather than a readme.
const preamble = beta
  ? `> **This is a beta.** V2 is a rewrite and has had far less real-world use
> than V1. Back up your \`Interface/AddOns\` folder before pointing it at a
> game directory you care about, and please report anything that misbehaves —
> **Settings → Copy diagnostics** produces a redacted summary worth attaching.
`
  : "";

const footer = `
---

**Installs alongside V1, not over the top.** It is a separate application with
its own settings, so V1 keeps working and nothing is migrated automatically. To
bring your addons across: export your list from V1 (**My Addons → Export Addon
List**), add your game folder here as a server, then **Import list**.

### Downloads
**Windows** — the \`.exe\` installer.
**Linux** — the **AppImage** unless you have a reason not to. A \`.deb\` is also
published; your package manager owns updates for it.${
  beta
    ? "\nThere is no `.rpm` during the beta — RPM refuses a version like\n`2.0.0-beta.1` — so on Fedora or openSUSE, take the AppImage."
    : ""
}

### Updating
**Settings → Check for updates** finds the next release and installs it. On
Linux that works for the AppImage only.
`;

process.stdout.write(`${preamble}${preamble ? "\n" : ""}## What changed\n\n${changes}\n${footer}`);
