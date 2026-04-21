/**
 * Playwright E2E: Blacklist persists across pipeline runs (Task 1.4)
 *
 * Tests:
 *   1. POSITIVE: Run 1 → reject discTrack → Run 2 (same playlist) → discTrack absent
 *   2. NEGATIVE: Run 1 → reject discTrack on playlist A → Run 2 on playlist B →
 *      discTrack appears in B's results (blacklists are per-playlist, not global)
 */
import { chromium } from "playwright";
import fs from "fs";

const SCREENSHOT_DIR = "test-screenshots";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// IDs are alphanumeric-only — extractSpotifyId regex requires [a-zA-Z0-9]+
const PLAYLIST_A = "ple2ePlaylistA";
const PLAYLIST_B = "ple2ePlaylistB";
const SRC_TRACK_A = "srcTrackA001";
const SRC_ARTIST_A = "srcArtistA001";
const DISC_TRACK_ID = "discTrackXYZ";
const DISC_ARTIST_ID = "discArtistXYZ";

const genres3 = ["alternative rock", "indie rock", "post-grunge"];
const featureKeys = {
  acousticness: 0.1, danceability: 0.7, energy: 0.75,
  instrumentalness: 0.0, liveness: 0.15, loudness: -5,
  speechiness: 0.04, tempo: 128, valence: 0.6,
};

const srcTrackA = {
  id: SRC_TRACK_A, name: "Source Track A",
  artists: [{ id: SRC_ARTIST_A, name: "Source Artist A" }],
  album: { id: "albSrcA", name: "Source Album A", images: [],
    release_date: "2015-01-01", release_date_precision: "day" },
  duration_ms: 210000, popularity: 60, preview_url: null, external_ids: {},
};
const srcArtistA = { id: SRC_ARTIST_A, name: "Source Artist A",
  genres: genres3, followers: { total: 80000 }, popularity: 62, images: [] };

const discTrack = {
  id: DISC_TRACK_ID, name: "Discovery Track",
  artists: [{ id: DISC_ARTIST_ID, name: "Discovery Artist" }],
  album: { id: "albDisc", name: "Discovery Album", images: [],
    release_date: "2016-06-01", release_date_precision: "day" },
  duration_ms: 215000, popularity: 48, preview_url: null, external_ids: {},
};
const discArtist = { id: DISC_ARTIST_ID, name: "Discovery Artist",
  genres: genres3, followers: { total: 55000 }, popularity: 50, images: [] };

// ─── Route-mock factory (parameterised by playlistId + srcTrack/Artist) ────
function buildApiMocks(playlistId, srcTrack, srcArtist) {
  return async (context) => {
    await context.route("https://api.spotify.com/v1/**", async (route) => {
      const url = route.request().url();
      const json = (obj) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });

      if (url.includes("/me/playlists")) {
        return json({ items: [{ id: playlistId, name: `Playlist ${playlistId.slice(-1)}`,
          images: [], tracks: { total: 1 }, owner: { display_name: "U" } }], next: null });
      }
      if (url.match(/\/me$/)) return json({ id: "user1", display_name: "Test User", images: [] });
      if (url.includes(`/playlists/${playlistId}/tracks`)) {
        return json({ items: [{ track: srcTrack, added_at: "2023-01-01T00:00:00Z" }],
          next: null, total: 1 });
      }
      if (url.includes("/artists?ids=")) {
        const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
        return json({ artists: [srcArtist, discArtist].filter(a => ids.includes(a.id)) });
      }
      if (url.includes(`${DISC_ARTIST_ID}/top-tracks`)) return json({ tracks: [discTrack] });
      if (url.includes(`${srcArtist.id}/top-tracks`)) return json({ tracks: [] });
      if (url.includes(DISC_ARTIST_ID)) return json(discArtist);
      if (url.includes(srcArtist.id)) return json(srcArtist);
      if (url.includes("/search")) {
        const offset = parseInt(new URL(url).searchParams.get("offset") ?? "0", 10);
        return json({ artists: { items: offset === 0 ? [discArtist] : [], next: null } });
      }
      if (route.request().method() === "POST") return json({ snapshot_id: "snap1" });
      await route.continue();
    });

    await context.route("http://127.0.0.1:3000/api/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/reccobeats")) {
        const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
        const all = [srcTrack.id, DISC_TRACK_ID];
        const content = all
          .filter((id) => ids.includes(id))
          .map((id) => ({
            href: `https://api.reccobeats.com/v1/audio-features/track/${id}`,
            ...featureKeys,
          }));
        return route.fulfill({ status: 200, contentType: "application/json",
          body: JSON.stringify({ content }) });
      }
      if (url.includes("/api/log")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      await route.continue();
    });
  };
}

async function injectAuth(context) {
  await context.addInitScript(() => {
    localStorage.setItem("soundfox_client_id", "test-client-bl");
    localStorage.setItem("soundfox_access_token", "fake-access-bl");
    localStorage.setItem("soundfox_token_expiry", String(Date.now() + 3_600_000));
    localStorage.setItem("soundfox_refresh_token", "fake-refresh-bl");
  });
}

async function runPipelineAndGetResults(page, playlistName) {
  await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector(`text=${playlistName}`, { timeout: 10000 });
  await page.click(`text=${playlistName}`);
  await page.waitForSelector('[aria-label="Reject track"]', { timeout: 45000 });
  await page.waitForTimeout(300);
}

let passed = 0;
let failed = 0;
function report(label, ok, detail = "") {
  if (ok) { console.log(`  PASS ✓  ${label}`); passed++; }
  else { console.error(`  FAIL ✗  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const browser = await chromium.launch({ headless: true });

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: POSITIVE — rejected track absent on second run (same playlist)
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== Test 1: POSITIVE — blacklist persists across same-playlist runs ===");
{
  const ctx = await browser.newContext();
  await injectAuth(ctx);
  await buildApiMocks(PLAYLIST_A, srcTrackA, srcArtistA)(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  try {
    // Run 1: scan and reject
    await runPipelineAndGetResults(page, "Playlist A");
    const beforeReject = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("track present in run 1", beforeReject > 0, `count=${beforeReject}`);

    await page.click('[aria-label="Reject track"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/blacklist-run1-rejected.png`, fullPage: true });

    // Run 2: navigate back and re-scan (click Back → pick playlist again)
    await page.click('text=Back to playlists');
    await page.waitForSelector("text=Playlist A", { timeout: 10000 });
    await page.click("text=Playlist A");
    // Track is blacklisted → pipeline finds 0 results → "No recommendations" expected
    await page.waitForSelector('text=No recommendations', { timeout: 45000 });
    await page.waitForTimeout(300);

    const run2Count = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("rejected track absent in run 2", run2Count === 0, `count=${run2Count}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/blacklist-run2-absent.png`, fullPage: true });
  } catch (err) {
    console.error("  ERROR:", err.message.split("\n")[0]);
    failed++;
  }
  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: NEGATIVE — playlist A blacklist does NOT leak to playlist B
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== Test 2: NEGATIVE — blacklist scoped to playlist, does not leak ===");
{
  const ctx = await browser.newContext();
  await injectAuth(ctx);

  // Mock Spotify to serve EITHER playlist depending on URL
  await ctx.route("https://api.spotify.com/v1/**", async (route) => {
    const url = route.request().url();
    const json = (obj) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });

    if (url.includes("/me/playlists")) {
      return json({ items: [
        { id: PLAYLIST_A, name: "Playlist A", images: [], tracks: { total: 1 }, owner: { display_name: "U" } },
        { id: PLAYLIST_B, name: "Playlist B", images: [], tracks: { total: 1 }, owner: { display_name: "U" } },
      ], next: null });
    }
    if (url.match(/\/me$/)) return json({ id: "user1", display_name: "Test User", images: [] });
    if (url.includes(`/playlists/${PLAYLIST_A}/tracks`)) {
      return json({ items: [{ track: srcTrackA, added_at: "2023-01-01T00:00:00Z" }], next: null, total: 1 });
    }
    if (url.includes(`/playlists/${PLAYLIST_B}/tracks`)) {
      // Playlist B has different source — but same discovery artist will appear in search
      return json({ items: [{ track: srcTrackA, added_at: "2023-01-01T00:00:00Z" }], next: null, total: 1 });
    }
    if (url.includes("/artists?ids=")) {
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      return json({ artists: [srcArtistA, discArtist].filter(a => ids.includes(a.id)) });
    }
    if (url.includes(`${DISC_ARTIST_ID}/top-tracks`)) return json({ tracks: [discTrack] });
    if (url.includes(`${SRC_ARTIST_A}/top-tracks`)) return json({ tracks: [] });
    if (url.includes(DISC_ARTIST_ID)) return json(discArtist);
    if (url.includes(SRC_ARTIST_A)) return json(srcArtistA);
    if (url.includes("/search")) {
      const offset = parseInt(new URL(url).searchParams.get("offset") ?? "0", 10);
      return json({ artists: { items: offset === 0 ? [discArtist] : [], next: null } });
    }
    if (route.request().method() === "POST") return json({ snapshot_id: "snap1" });
    await route.continue();
  });

  await ctx.route("http://127.0.0.1:3000/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/reccobeats")) {
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      const content = [SRC_TRACK_A, DISC_TRACK_ID]
        .filter((id) => ids.includes(id))
        .map((id) => ({
          href: `https://api.reccobeats.com/v1/audio-features/track/${id}`,
          ...featureKeys,
        }));
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ content }) });
    }
    if (url.includes("/api/log")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    await route.continue();
  });

  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  try {
    // Playlist A: scan and reject discTrack
    await runPipelineAndGetResults(page, "Playlist A");
    const aCount = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("disc track present in playlist A", aCount > 0, `count=${aCount}`);

    if (aCount > 0) await page.locator('[aria-label="Reject track"]').first().click();
    await page.waitForTimeout(300);

    // Navigate to Playlist B — blacklist for A must NOT affect B
    await page.click("text=Back to playlists");
    await page.waitForSelector("text=Playlist B", { timeout: 10000 });
    await page.click("text=Playlist B");
    await page.waitForSelector('[aria-label="Reject track"]', { timeout: 45000 });
    await page.waitForTimeout(300);

    const bCount = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("disc track present in playlist B (no cross-contamination)", bCount > 0, `count=${bCount}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/blacklist-crossplaylist.png`, fullPage: true });
  } catch (err) {
    console.error("  ERROR:", err.message.split("\n")[0]);
    failed++;
  }
  await ctx.close();
}

await browser.close();

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
