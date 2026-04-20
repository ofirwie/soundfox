// Mock a real-shaped playlist with 100 tracks. Pipeline must NOT return 0.
// If it does, there's a real bug in the code (independent of user data).
import { chromium } from "playwright";
import { existsSync, readFileSync, unlinkSync } from "fs";

try { unlinkSync("soundfox-debug.log"); } catch {}

// Build 100 fake tracks shaped exactly like Spotify
const fakeTracks = Array.from({ length: 100 }, (_, i) => ({
  added_at: "2024-01-01T00:00:00Z",
  added_by: { id: "user1" },
  is_local: false,
  primary_color: null,
  video_thumbnail: { url: null },
  track: {
    id: `track${i.toString().padStart(3, "0")}xxxxxxxxxxxxxxxxxxxx`.slice(0, 22),
    name: `Real Track ${i + 1}`,
    type: "track",
    duration_ms: 240000,
    popularity: 50,
    preview_url: null,
    explicit: false,
    album: { name: "Album", release_date: "2020-01-01", images: [] },
    artists: [{ id: `artist${i % 20}xxxxxxxxxxxxxxxxxxxxx`.slice(0, 22), name: `Artist ${(i % 20) + 1}` }],
  },
}));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();

await ctx.route("https://accounts.spotify.com/api/token", (r) =>
  r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ access_token: "v", expires_in: 3600, refresh_token: "v" }) })
);
const calledUrls = [];
await ctx.route("https://api.spotify.com/v1/**", async (route) => {
  const url = route.request().url();
  calledUrls.push(url);
  if (url.includes("/me/playlists")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      items: [{ id: "isa", name: "ISA ROCK", images: null, tracks: { total: 100 }, owner: { display_name: "U" } }],
      next: null,
    })});
  }
  if (url.includes("/me")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "u", display_name: "U", images: [] }) });
  }
  if (url.includes("/playlists/isa/tracks")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: fakeTracks, next: null, total: 100 }) });
  }
  if (url.includes("/artists?ids=")) {
    // 20 artists with rock genres
    const ids = new URL(url).searchParams.get("ids").split(",");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      artists: ids.map((id) => ({ id, name: `Artist ${id}`, genres: ["rock", "alternative rock", "post-grunge"], followers: { total: 50000 }, images: [], popularity: 60 })),
    })});
  }
  if (url.includes("/search")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      artists: { items: [{ id: `cand${Math.random().toString(36).slice(2, 12)}`, name: "Candidate", genres: ["rock", "post-grunge"], followers: { total: 100000 }, images: [], popularity: 60 }] },
    })});
  }
  if (url.includes("/artists/") && url.includes("/top-tracks")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      tracks: [{ id: `top${Math.random().toString(36).slice(2, 12)}`, name: "Candidate Track", album: { name: "A", release_date: "2020-01-01", images: [] }, artists: [{ id: "a", name: "A" }], duration_ms: 240000, popularity: 60, preview_url: null, explicit: false }],
    })});
  }
  return route.continue();
});
await ctx.route("**/api/reccobeats**", (r) => r.fulfill({
  status: 200, contentType: "application/json",
  body: JSON.stringify({ content: fakeTracks.slice(0, 50).map((t, i) => ({
    href: `https://open.spotify.com/track/${t.track.id}`,
    acousticness: 0.3, danceability: 0.5, energy: 0.7, instrumentalness: 0.1,
    liveness: 0.2, loudness: -7, speechiness: 0.05, tempo: 120, valence: 0.5,
  })) }),
}));

const page = await ctx.newPage();
const consoleLogs = [];
page.on("console", (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => consoleLogs.push(`[err] ${e.message}`));

await page.addInitScript(() => {
  localStorage.setItem("soundfox_client_id", "x".repeat(32));
  localStorage.setItem("soundfox_access_token", "v");
  localStorage.setItem("soundfox_token_expiry", String(Date.now() + 3600_000));
  localStorage.setItem("soundfox_refresh_token", "v");
});

await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 15000 });
await page.waitForTimeout(2000);

console.log("Click ISA ROCK (mocked, 100 tracks)...");
await page.locator("button:has-text('ISA ROCK')").first().click();
await page.waitForTimeout(60000);

const bodyText = await page.textContent("body");
const foundMatch = bodyText.match(/Found (\d+) tracks/);
const found = foundMatch ? parseInt(foundMatch[1]) : -1;
const analyzedMatch = bodyText.match(/Analyzed[^\d]+(\d+)\s*tracks/);
const analyzed = analyzedMatch ? parseInt(analyzedMatch[1]) : -1;

console.log("Found tracks:", found);
console.log("Analyzed tracks:", analyzed);

await page.screenshot({ path: "test-100-after.png", fullPage: true });
const pageHtml = await page.content();
console.log("\n=== Page body excerpt ===");
console.log(pageHtml.match(/<main[\s\S]*?<\/main>/)?.[0]?.slice(0, 2000) ?? "no main");
await browser.close();

console.log("\n=== Spotify URLs called (first 30) ===");
calledUrls.slice(0, 30).forEach((u) => console.log("  " + u));
console.log("\n=== Debug log ===");
if (existsSync("soundfox-debug.log")) {
  console.log(readFileSync("soundfox-debug.log", "utf8"));
} else {
  console.log("(no log written)");
}

const pass = analyzed > 0;
console.log("\n=== " + (pass ? "PASS — pipeline handles 100 tracks correctly" : "FAIL — pipeline returns 0 even with 100 valid tracks!") + " ===");
process.exit(pass ? 0 : 1);
