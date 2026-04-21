/**
 * Playwright E2E: Reject button in ResultsStep
 *
 * Strategy: mock all Spotify + local API endpoints so the pipeline finds
 * one discovery track. The source playlist has "Source Artist" (src_a1),
 * and the search returns a DIFFERENT "Discovery Artist" (disc_a1) with
 * one top track. Pipeline should yield that track → ResultsStep renders it.
 *
 * Tests:
 *   1. positive: click ✗ → row disappears → reload → still gone
 *   2. keyboard: focus reject button + Enter → same outcome
 *   3. negative: quota-prefill → click ✗ → toast shown (not silent)
 */
import { chromium } from "playwright";
import fs from "fs";

const SCREENSHOT_DIR = "test-screenshots";
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const PLAYLIST_ID = "ple2eReject";
const SRC_TRACK_ID = "srcTrack001";
const SRC_ARTIST_ID = "srcArtist001";
const DISC_TRACK_ID = "discTrack001";   // the track we expect to reject
const DISC_ARTIST_ID = "discArtist001"; // different from source — passes allowKnownArtists gate

const features = { tempo: 128, energy: 0.75, valence: 0.6, danceability: 0.7,
  acousticness: 0.1, instrumentalness: 0.0, liveness: 0.15, speechiness: 0.04,
  loudness: -5, mode: 1, key: 5, time_signature: 4, duration_ms: 210000 };

// IDs must be alphanumeric-only — extractSpotifyId regex is [a-zA-Z0-9]+
const srcTrack = {
  id: SRC_TRACK_ID, name: "Source Track",
  artists: [{ id: SRC_ARTIST_ID, name: "Source Artist" }],
  album: { id: "albSrc", name: "Source Album", images: [],
    release_date: "2015-01-01", release_date_precision: "day" },
  duration_ms: 210000, popularity: 60, preview_url: null, external_ids: {},
};
const srcArtist = { id: SRC_ARTIST_ID, name: "Source Artist",
  genres: ["alternative rock", "indie rock", "post-grunge"],
  followers: { total: 80000 }, popularity: 62, images: [] };

const discTrack = {
  id: DISC_TRACK_ID, name: "Discovery Track",
  artists: [{ id: DISC_ARTIST_ID, name: "Discovery Artist" }],
  album: { id: "albDisc", name: "Discovery Album", images: [],
    release_date: "2016-06-01", release_date_precision: "day" },
  duration_ms: 215000, popularity: 48, preview_url: null, external_ids: {},
};
// Must share ≥2 genres with source to pass genre gate (source-spotify.ts:87)
const discArtist = { id: DISC_ARTIST_ID, name: "Discovery Artist",
  genres: ["alternative rock", "indie rock", "post-grunge"],
  followers: { total: 55000 }, popularity: 50, images: [] };

// ─── Route-mock helper ─────────────────────────────────────────────────────
async function mockAllApis(context) {
  await context.route("https://api.spotify.com/v1/**", async (route) => {
    const url = route.request().url();
    const json = (obj) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });

    if (url.includes("/me/playlists")) {
      return json({ items: [{ id: PLAYLIST_ID, name: "E2E Playlist", images: [],
        tracks: { total: 1 }, owner: { display_name: "E2EUser" } }], next: null });
    }
    if (url.match(/\/me$/)) {
      return json({ id: "e2e_user", display_name: "E2E User", images: [] });
    }
    if (url.includes(`/playlists/${PLAYLIST_ID}/tracks`)) {
      return json({ items: [{ track: srcTrack, added_at: "2023-01-01T00:00:00Z" }],
        next: null, total: 1 });
    }
    // Artist batch (for source genre analysis)
    if (url.includes("/artists?ids=")) {
      const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
      const all = [srcArtist, discArtist];
      return json({ artists: all.filter(a => ids.includes(a.id)) });
    }
    // Single source artist
    if (url.includes(`/artists/${SRC_ARTIST_ID}`) && !url.includes("top-tracks")) {
      return json(srcArtist);
    }
    // Single discovery artist
    if (url.includes(`/artists/${DISC_ARTIST_ID}`) && !url.includes("top-tracks")) {
      return json(discArtist);
    }
    // Discovery artist top-tracks → yields the one discovery track
    if (url.includes(`/artists/${DISC_ARTIST_ID}/top-tracks`)) {
      return json({ tracks: [discTrack] });
    }
    // Source artist top-tracks (needed but filtered out as known artist)
    if (url.includes(`/artists/${SRC_ARTIST_ID}/top-tracks`)) {
      return json({ tracks: [srcTrack] });
    }
    // Search → return discovery artist at offset=0 only; empty otherwise to stop pagination
    if (url.includes("/search")) {
      const offset = parseInt(new URL(url).searchParams.get("offset") ?? "0", 10);
      return json({ artists: { items: offset === 0 ? [discArtist] : [], next: null } });
    }
    // Add tracks to playlist
    if (route.request().method() === "POST" && url.includes("/tracks")) {
      return json({ snapshot_id: "snap1" });
    }
    if (route.request().method() === "POST" && url.includes("/playlists")) {
      return json({ id: "new_pl", name: "New Playlist" });
    }
    await route.continue();
  });

  await context.route("http://127.0.0.1:3000/api/**", async (route) => {
    const url = route.request().url();
    const json = (obj) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(obj) });

    if (url.includes("/api/reccobeats")) {
      // ReccoBeats response format: { content: [{ href: ".../track/<id>", ...features }] }
      // reccobeats.ts extracts spotify ID from href using /track/([a-zA-Z0-9]+)
      const ids = new URL(url, "http://localhost").searchParams.get("ids")?.split(",") ?? [];
      const allFeatures = [SRC_TRACK_ID, DISC_TRACK_ID].map((id) => ({
        href: `https://api.reccobeats.com/v1/audio-features/track/${id}`,
        ...features,
      }));
      return json({ content: allFeatures.filter((f) => ids.some((id) => f.href.includes(id))) });
    }
    if (url.includes("/api/log")) return json({});
    await route.continue();
  });
}

// ─── Auth injection ────────────────────────────────────────────────────────
async function injectAuth(context, { quotaPrefill = false } = {}) {
  await context.addInitScript(({ quotaPrefill }) => {
    localStorage.setItem("soundfox_client_id", "test-client-e2e");
    localStorage.setItem("soundfox_access_token", "fake-access-e2e");
    localStorage.setItem("soundfox_token_expiry", String(Date.now() + 3_600_000));
    localStorage.setItem("soundfox_refresh_token", "fake-refresh-e2e");
    if (quotaPrefill) {
      // Simulate quota by making setItem throw only for profile keys.
      // (Filling real storage also breaks auth-token writes above if quota is tight.)
      const origSetItem = localStorage.setItem.bind(localStorage);
      Object.defineProperty(localStorage, "setItem", {
        value(key, value) {
          if (key.startsWith("soundfox_profile_")) {
            throw new DOMException("QuotaExceededError", "QuotaExceededError");
          }
          return origSetItem(key, value);
        },
        writable: true, configurable: true,
      });
    }
  }, { quotaPrefill });
}

// ─── Drive app to ResultsStep ──────────────────────────────────────────────
async function navigateToResults(page) {
  await page.goto("http://127.0.0.1:3000/go", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForSelector("text=E2E Playlist", { timeout: 10000 });
  await page.click("text=E2E Playlist");
  // Wait for the discovery track's reject button to appear (pipeline completes)
  await page.waitForSelector('[aria-label="Reject track"]', { timeout: 45000 });
}

let passed = 0;
let failed = 0;
function report(label, ok, detail = "") {
  if (ok) { console.log(`  PASS ✓  ${label}`); passed++; }
  else { console.error(`  FAIL ✗  ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

const browser = await chromium.launch({ headless: true });

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: POSITIVE — reject hides row immediately + persists after reload
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== Test 1: Reject button — positive path (mouse click) ===");
{
  const ctx = await browser.newContext();
  await injectAuth(ctx);
  await mockAllApis(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  try {
    await navigateToResults(page);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase1-reject-before.png`, fullPage: true });

    const rowBefore = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("discovery track visible before reject", rowBefore > 0, `count=${rowBefore}`);

    await page.click('[aria-label="Reject track"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase1-reject-after.png`, fullPage: true });

    const rowAfter = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("track disappears after reject", rowAfter === 0, `count=${rowAfter}`);

    // Reload — need to re-mock APIs because page reloads (new fetch context)
    await page.reload({ waitUntil: "networkidle", timeout: 15000 });
    // After reload: page re-runs pipeline with same mocked data;
    // the profile blacklist is persisted in localStorage, so disc_track_001 should be filtered
    await page.waitForSelector('text=E2E Playlist, text=No recommendations, [aria-label="Reject track"]',
      { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase1-reject-reload.png`, fullPage: true });

    const rowAfterReload = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("track still gone after reload", rowAfterReload === 0, `count=${rowAfterReload}`);
  } catch (err) {
    console.error("  ERROR:", err.message.split("\n")[0]);
    failed++;
  }
  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Keyboard path — focus reject button + Enter
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== Test 2: Reject button — keyboard path (Tab+Enter) ===");
{
  const ctx = await browser.newContext();
  await injectAuth(ctx);
  await mockAllApis(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  try {
    await navigateToResults(page);

    await page.focus('[aria-label="Reject track"]');
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const rowAfterKeyboard = await page.locator(`[data-track-id="${DISC_TRACK_ID}"]`).count();
    report("keyboard Enter activates reject (row gone)", rowAfterKeyboard === 0, `count=${rowAfterKeyboard}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase1-reject-keyboard.png`, fullPage: true });
  } catch (err) {
    console.error("  ERROR:", err.message.split("\n")[0]);
    failed++;
  }
  await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: NEGATIVE — quota error shows toast, not silent failure
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== Test 3: NEGATIVE — quota error shows toast ===");
{
  const ctx = await browser.newContext();
  await injectAuth(ctx, { quotaPrefill: true });
  await mockAllApis(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  try {
    await navigateToResults(page);
    await page.click('[aria-label="Reject track"]');
    await page.waitForTimeout(500);

    const toastCount = await page.locator("text=/storage full/i").count();
    report("toast shown on quota error", toastCount > 0, `toast count=${toastCount}`);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/phase1-reject-quota.png`, fullPage: true });
  } catch (err) {
    console.error("  ERROR:", err.message.split("\n")[0]);
    failed++;
  }
  await ctx.close();
}

await browser.close();

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
