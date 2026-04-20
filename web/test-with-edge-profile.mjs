// Launch chromium with a COPY of user's Edge profile to inherit localStorage,
// then navigate to /go, click ISA ROCK, capture everything.
import { chromium } from "playwright";
import { cp, mkdtemp, rm } from "fs/promises";
import { existsSync as exists, readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const EDGE_PROFILE = "C:/Users/fires/AppData/Local/Microsoft/Edge/User Data/Default";
const LOG_FILE = "soundfox-debug.log";

// Clear log
try { unlinkSync(LOG_FILE); } catch {}

console.log("Copying Edge profile (this takes 30-60s)...");
const tmp = await mkdtemp(join(tmpdir(), "edge-prof-"));
// Copy only what we need — Local Storage + Cookies
await cp(`${EDGE_PROFILE}/Local Storage`, `${tmp}/Local Storage`, { recursive: true });
await cp(`${EDGE_PROFILE}/Cookies`, `${tmp}/Cookies`).catch(() => {});

// Remove leveldb LOCK
try { await rm(`${tmp}/Local Storage/leveldb/LOCK`); } catch {}

console.log("Launching chromium with Edge profile copy...");
const ctx = await chromium.launchPersistentContext(tmp, {
  headless: true,
  channel: "msedge", // try Edge channel
  args: ["--disable-blink-features=AutomationControlled"],
}).catch(async () => {
  console.log("Edge channel failed, falling back to chromium...");
  return chromium.launchPersistentContext(tmp, { headless: true });
});

const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[err] ${e.message}`));

console.log("Navigate to /go...");
await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 20000 });
await page.waitForTimeout(3000);

const url1 = page.url();
console.log("URL after load:", url1);

// Print localStorage for diagnostic
const lsKeys = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("soundfox_")) out[k] = localStorage.getItem(k)?.slice(0, 30);
  }
  return out;
});
console.log("localStorage soundfox_*:", lsKeys);

if (url1.includes("/wizard")) {
  console.log("BOUNCED to wizard — token expired or client invalid");
  await page.screenshot({ path: "diag-wizard.png", fullPage: true });
  await ctx.close();
  process.exit(1);
}

// We're on /go — find ISA ROCK
console.log("\nLooking for ISA ROCK...");
const isa = page.locator("button:has-text('ISA ROCK')").first();
const visible = await isa.isVisible().catch(() => false);
if (!visible) {
  const allNames = await page.locator("button h3, button p.font-semibold").allTextContents();
  console.log("Visible playlists:");
  allNames.slice(0, 10).forEach((n) => console.log("  - " + n));
  await page.screenshot({ path: "diag-no-isa.png", fullPage: true });
  await ctx.close();
  process.exit(1);
}

console.log("Clicking ISA ROCK...");
await isa.click();
console.log("Wait 30s for pipeline...");
await page.waitForTimeout(30000);

await page.screenshot({ path: "diag-after.png", fullPage: true });
await ctx.close();

console.log("\n=== Pipeline debug log ===");
if (exists(LOG_FILE)) {
  console.log(readFileSync(LOG_FILE, "utf8"));
} else {
  console.log("(no log file written)");
}

console.log("\n=== Last browser console logs ===");
logs.slice(-15).forEach((l) => console.log("  " + l.slice(0, 300)));
