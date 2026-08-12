// Bundle configuration sanity checks.
//
// Everything here is something that builds fine on Linux, passes every test,
// and then fails eight minutes into a release build — or worse, ships wrong.
// Cheap to check on every push; expensive to discover from a half-published
// release.
//
//   node scripts/check-bundle-config.mjs            # internal consistency
//   node scripts/check-bundle-config.mjs --tag v2.0.0-beta.1
//
// Node rather than Python so the release workflow can run it on Windows and
// Linux without installing anything: setup-node has already run by then.

import { readFileSync } from "node:fs";

const problems = [];

const tauri = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cargoVersion = (readFileSync("Cargo.toml", "utf8").match(/^version = "(.+)"$/m) ||
  [])[1];

// 1. The three declared versions have to agree.
//
// They are the build's identity: the release name, the installer filenames and
// the string in Settings -> Copy diagnostics each come from a different one of
// these, so a disagreement ships a build that misreports its own version.
const declared = {
  "src-tauri/tauri.conf.json": tauri.version,
  "package.json": pkg.version,
  "Cargo.toml": cargoVersion,
};
const versions = [...new Set(Object.values(declared))];
if (versions.length !== 1) {
  problems.push(
    "version files disagree:\n" +
      Object.entries(declared)
        .map(([file, version]) => `      ${file} declares ${version}`)
        .join("\n"),
  );
}
const version = declared["src-tauri/tauri.conf.json"];

// 2. A tag, when given, has to name that same version.
const tagArg = process.argv.indexOf("--tag");
if (tagArg !== -1) {
  const tag = (process.argv[tagArg + 1] || "").replace(/^v/, "");
  if (tag !== version) {
    problems.push(`tag is ${tag}, but the version files declare ${version}`);
  }
}

// 3. No straight apostrophe in productName.
//
// Tauri interpolates the product name into single-quoted strings in its NSIS
// template — `${IPersistFile::Load} $1 '("${shortcut}", ...)'` — so a straight
// quote closes the string early and the remainder splits into extra macro
// arguments. makensis then fails with the deeply unhelpful
//
//   !insertmacro: macro "NSISCOMCALL" requires 4 parameter(s), passed 8!
//
// after the whole release build has already run. Nothing else notices: the
// Linux bundles and every test are perfectly happy. Use U+2019 (’) in display
// names, which NSIS does not treat as a delimiter.
if (tauri.productName.includes("'")) {
  problems.push(
    `productName ${JSON.stringify(tauri.productName)} contains a straight ` +
      "apostrophe, which breaks NSIS bundling. Use the typographic one (’).",
  );
}

// 4. No rpm target while the version is a prerelease.
//
// RPM forbids a hyphen in its Version field and Tauri writes the config version
// there verbatim, so a 2.0.0-beta.1 build produces a package whose NEVRA cannot
// be parsed. It bundles without complaint — the damage only shows up on the
// user's machine.
if (version?.includes("-") && (tauri.bundle?.targets || []).includes("rpm")) {
  problems.push(
    `version ${version} is a prerelease, so the rpm target must stay out of ` +
      "bundle.targets: RPM does not allow a hyphen in its Version field.",
  );
}

// 5. The declared version has release notes.
//
// Checked on every push rather than only when tagging, so the notes are written
// alongside the change they describe instead of being reconstructed from memory
// at release time — which is when a changelog quietly turns into a commit log.
try {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const heading = new RegExp(`^## ${version?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
  if (version && !heading.test(changelog)) {
    problems.push(
      `CHANGELOG.md has no section for ${version}. The release notes are ` +
        "generated from it, so add one with the change rather than at tag time.",
    );
  }
} catch {
  problems.push("CHANGELOG.md is missing — the release notes are generated from it.");
}

if (problems.length) {
  console.error("bundle config problems:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`bundle config OK — ${tauri.productName} ${version}`);
