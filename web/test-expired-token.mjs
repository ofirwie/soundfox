import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

// Mock both Spotify accounts API (token refresh) and Web API
await context.route("https://accounts.spotify.com/api/token", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      access_token: "fresh-after-refresh",
      expires_in: 3600,
      refresh_token: "refresh-still-valid",
    }),
  });
});

await context.route("https://api.spotify.com/v1/**", async (route) => {
  const url = route.request().url();
  if (url.includes("/me/playlists")) {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ items: [{ id: "p1", name: "Test PL", images: [], tracks: { total: 5 }, owner: { display_name: "Me" } }], next: null }),
    });
  } else if (url.includes("/me")) {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ id: "u1", display_name: "Ofir", images: [] }),
    });
  } else {
    await route.continue();
  }
});

const page = await context.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));

// Simulate EXPIRED token + valid refresh token (the user's real situation)
await page.addInitScript(() => {
  localStorage.setItem("soundfox_client_id", "test-client-id-1234567890");
  localStorage.setItem("soundfox_access_token", "expired-token");
  localStorage.setItem("soundfox_token_expiry", String(Date.now() - 1000)); // EXPIRED
  localStorage.setItem("soundfox_refresh_token", "valid-refresh-token");
});

const res = await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

const url = page.url();
const bodyText = await page.textContent("body");
const stayedOnGo = url.includes("/go");
const showsPicker = bodyText.includes("Choose a Playlist");

console.log("Final URL:", url);
console.log("Stayed on /go (didn't bounce to /wizard):", stayedOnGo);
console.log("Shows playlist picker:", showsPicker);
console.log("Refresh token after:", await page.evaluate(() => localStorage.getItem("soundfox_access_token")));

await page.screenshot({ path: "test-expired-token.png", fullPage: true });

const pass = stayedOnGo && showsPicker;
console.log("\n=== " + (pass ? "PASS ✓ — refresh path works" : "FAIL ✗") + " ===");

await browser.close();
process.exit(pass ? 0 : 1);
