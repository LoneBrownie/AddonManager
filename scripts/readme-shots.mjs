// Regenerate the screenshots the README embeds.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/readme-shots.mjs
//
// Driven against the browser build and its in-memory backend, so the images are
// produced from the interface as it actually is rather than edited by hand —
// and regenerating them after a change is one command rather than an afternoon.
//
// The filenames are the ones README.md references. Keep them.

import { chromium } from "playwright";

const OUT = "docs/v2/images";
const CHROME =
  process.env.CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage({
  viewport: { width: 1180, height: 800 },
  deviceScaleFactor: 2,
  // The app is dark-first, and "System" is the default, so the screenshots
  // should show what most people will see.
  colorScheme: "dark",
});

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text());
});

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`wrote ${OUT}/${name}.png`);
};

await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.waitForSelector(".row", { timeout: 10000 });

// The what's-new window opens over everything on first load.
await page.click(".dialog .btn.primary").catch(() => {});
await page.waitForTimeout(400);

// 01 — the addon list, including the folders this app does not manage yet.
await shot("01-addons");

// 02 — the server switcher, which is the feature the README leads with.
await page.click(".switcher-button");
await page.waitForSelector(".switcher-menu");
await page.waitForTimeout(250);
await shot("02-switcher");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 03 — the activity stream, after a check and a batch update have put
// something in it. Driven rather than staged: the panel has to be showing real
// messages for the shot to be worth anything.
await page.click('button:has-text("Check for updates")');
await page.waitForTimeout(1200);
await page.click('button:has-text("Update all")').catch(() => {});
await page.waitForTimeout(1600);
await page.click("aside.dock button.tab");
await page.waitForTimeout(500);
await shot("03-activity");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// 09 — importing a list exported from V1.
await page.click('button:has-text("Import list")');
await page.waitForSelector(".dialog");
await page.fill(
  "#import-text",
  [
    "Questie: https://github.com/Questie/Questie",
    "Classic API: https://gitlab.com/Tsoukie/classicapi",
    "AtlasLoot: https://github.com/Hegarol/AtlasLootClassic",
    "Skada: https://github.com/bkader/Skada-WoTLK",
  ].join("\n"),
);
await page.waitForTimeout(500);
await shot("09-import-list");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 16 — the warning that names what else would break.
await page.click('.row:has-text("Classic API") .btn.danger');
await page.waitForSelector(".dialog");
await page.waitForTimeout(400);
await shot("16-removal-warning");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// 18 — the curated list, searched.
await page.click('.nav button:has-text("Browse")');
await page.waitForSelector(".card", { timeout: 10000 });
await page.fill('input[type="search"]', "raid").catch(() => {});
await page.waitForTimeout(400);
await shot("18-browse-search");

// 20 — where an install can go: switches, and only the servers on this
// server's game version.
await page.click('.nav button:has-text("My addons")');
await page.waitForTimeout(400);
await page.click('button:has-text("Add addon")');
await page.waitForSelector(".choices");
await page.waitForTimeout(300);
await shot("20-install-to");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// 21 — Settings, which is where the update channel lives.
await page.click('.nav button:has-text("Settings")');
await page.waitForSelector(".field");
await page.waitForTimeout(400);
await shot("21-settings");

// 12 — managing servers.
await page.click('.nav button:has-text("Servers")');
await page.waitForSelector(".server-row", { timeout: 10000 });
await page.waitForTimeout(400);
await shot("12-servers");

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join("\n")}` : "no console errors");
await browser.close();
