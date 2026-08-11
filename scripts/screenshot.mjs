import { chromium } from "playwright";

const OUT = "./screenshots";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 800 }, deviceScaleFactor: 2 });

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.waitForSelector(".row", { timeout: 10000 });
await page.screenshot({ path: `${OUT}/01-addons.png` });

// Switcher open — the headline feature.
await page.click(".switcher-button");
await page.waitForSelector(".switcher-menu");
await page.screenshot({ path: `${OUT}/02-switcher.png` });
await page.keyboard.press("Escape");

// Second server: same addon, different version.
await page.click(".switcher-button");
await page.click('.switcher-menu button:has-text("Warmane")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/03-second-server.png` });

// Add-addon dialog with multi-target.
await page.click('button:has-text("Add addon")');
await page.waitForSelector(".dialog");
await page.fill("#addon-url", "https://github.com/owner/SomeAddon");
await page.screenshot({ path: `${OUT}/04-add-addon.png` });
await page.keyboard.press("Escape");

// Browse + settings.
await page.click('.nav button:has-text("Browse")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/05-browse.png` });

await page.click('.nav button:has-text("Settings")');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/06-settings.png` });

// Offline server must warn, not wipe.
await page.click('.nav button:has-text("My addons")');
await page.click(".switcher-button");
await page.click('.switcher-menu button:has-text("Turtle")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/07-offline.png` });

// Light theme.
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
await page.click(".switcher-button");
await page.click('.switcher-menu button:has-text("Epoch")');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/08-light.png` });

console.log(errors.length ? "CONSOLE ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
