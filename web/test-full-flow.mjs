import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

// Mock Spotify API
await context.route("https://api.spotify.com/v1/**", async (route) => {
  const url = route.request().url();
  if (url.includes("/me/playlists")) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          // Real Spotify can return null for images — must not crash
          { id: "pl1", name: "Sample Playlist A", images: null, tracks: { total: 1367 }, owner: { display_name: "Test User" } },
          { id: "pl2", name: "Sample Playlist B", images: [], tracks: { total: 40 }, owner: { display_name: "Test User" } },
          { id: "pl3", name: "Chill Vibes", images: [{ url: "https://i.scdn.co/image/abc" }], tracks: { total: 120 }, owner: { display_name: "Test User" } },
        ],
        next: null,
      }),
    });
  } else if (url.includes("/me")) {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "user1", display_name: "Test User", images: [] }),
    });
  } else {
    await route.continue();
  }
});

const page = await context.newPage();
const consoleLog = [];
page.on("console", (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleLog.push(`[ERROR] ${err.message}`));

await page.addInitScript(() => {
  localStorage.setItem("soundfox_client_id", "test-client-id-placeholder-1234");
  localStorage.setItem("soundfox_access_token", "real-token");
  localStorage.setItem("soundfox_token_expiry", String(Date.now() + 3600_000));
  localStorage.setItem("soundfox_history", JSON.stringify([
    { id: "a1", playlistId: "pl1", playlistName: "Sample Playlist A", trackCount: 1367, tasteVector: {}, resultCount: 50, createdAt: "2026-04-19T00:00:00Z" },
  ]));
});

const res = await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

const url = page.url();
const bodyText = await page.textContent("body");
const hasPlaylistPicker = bodyText.includes("Choose a Playlist");
const hasRecent = bodyText.includes("Recently analyzed");
const hasNightRock = bodyText.includes("Sample Playlist A");
const hasRockWorkout = bodyText.includes("Sample Playlist B");
const hasUser = bodyText.includes("Test User");

console.log("=== Test results ===");
console.log("Final URL:", url);
console.log("Status:", res.status());
console.log("Has 'Choose a Playlist':", hasPlaylistPicker);
console.log("Has 'Recently analyzed':", hasRecent);
console.log("Has 'Sample Playlist A':", hasNightRock);
console.log("Has 'Sample Playlist B':", hasRockWorkout);
console.log("Has 'Test User' (display_name):", hasUser);

await page.screenshot({ path: "test-full-flow-screenshot.png", fullPage: true });

console.log("\n=== Console ===");
consoleLog.slice(0, 20).forEach((l) => console.log(l));

const pass = hasPlaylistPicker && hasRecent && hasNightRock && hasRockWorkout && hasUser && url.includes("/go");
console.log("\n=== " + (pass ? "PASS ✓" : "FAIL ✗") + " ===");

await browser.close();
process.exit(pass ? 0 : 1);
