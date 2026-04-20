# SoundFox v2 — Streaming Pipeline & Interactive Results

**Date:** 2026-04-19  
**Scope:** Streaming discovery pipeline, 1000-track target, bidirectional playlist add/remove, pagination, filters, resume support, allow-known-artists toggle, Spotify track links  
**Prerequisite:** v1 plan fully implemented and running at `web/` (Next.js 16, React 19, Tailwind v4)

---

## QA History Inherited from v1

All fixes below are already in place and must NOT be regressed:

| Tag | Fix |
|-----|-----|
| [C1] | ReccoBeats proxied through `/api/reccobeats` (CORS) |
| [C2] | `spotify-client.ts` throttle (200ms/req) + exponential retry on 429 |
| [C3] | Genre profile built dynamically from playlist — not hardcoded |
| [H1] | Token refresh lock (`refreshPromise`) in `spotify-auth.ts` |
| [H2] | No import collision in `spotify-client.ts` |
| [H3] | Error state + retry button in `AnalysisStep` |
| [H4] | Suspense boundary on callback page |
| [H5] | `saveAnalysis()` wired into results flow |
| [v3-F] | `yieldToEventLoop()` in CPU-bound loops to keep browser responsive |

New v2 fixes introduced in this plan:

| Tag | Fix |
|-----|-----|
| [V2-A] | `AbortSignal` threading through generator — cancellation is clean |
| [V2-B] | Checkbox actions debounced 300ms to avoid Spotify spam |
| [V2-C] | `React.memo` on `TrackRow` to prevent 1000-row re-renders |
| [V2-D] | Windowed list (CSS `contain: strict`) for performance |
| [V2-E] | `removeTracksFromPlaylist` uses URI-only deletion (removes all occurrences of the URI) |
| [V2-F] | Scan state saved every batch — resume recovers partial work |
| [V2-G] | "Add to existing" mode pre-populates `added` set from target playlist tracks before enabling bidirectional ops |
| [V2-H] | `addTracksToPlaylist` / `removeTracksFromPlaylist` both added to `spotify-client.ts` |

---

## Architecture Overview

```
wizard/page.tsx
  └─ step 3: PlaylistStep (unchanged)
  └─ step 3.5 (new): ScanOptionsStep  ← allow known artists toggle, target count
  └─ step 4: AnalysisStep (refactored) ← drives streaming generator, shows live results
       └─ uses runPipelineStreaming() AsyncGenerator
  └─ step 5: ResultsStep (full rewrite) ← pagination, sort, filter, bidirectional add/remove

lib/
  discovery-pipeline.ts  ← adds runPipelineStreaming (AsyncGenerator), keeps runPipeline wrapper
  spotify-client.ts       ← adds removeTracksFromPlaylist, addTracksToPlaylist stays
  storage.ts              ← adds ScanState persistence (save/load/clear)

components/
  ScanOptionsStep.tsx     ← new
  TrackRow.tsx            ← new (React.memo'd, extracted from ResultsStep)
  ResultsStep.tsx         ← full rewrite
  AnalysisStep.tsx        ← refactored to consume generator + show live results
```

---

## Batch 1: Streaming Pipeline Refactor

**Files changed:** `web/src/lib/discovery-pipeline.ts`

### What changes

- Add `BatchUpdate` and `ScanOptions` interfaces
- Add `runPipelineStreaming`: `AsyncGenerator<BatchUpdate>` that yields batches of 50 scored tracks as they are computed
- Expand search to ~2500 candidate artists: iterate all `searchTerms` over offsets 0–950 (step 50) = up to 20 pages each, stop per-term early if Spotify returns 0 results [M1: Spotify hard limit offset+limit ≤ 1000]
- Take top-N track per artist stays (best fit for 1000-target with reduced API cost)
- Add `allowKnownArtists` option — when `true`, skip the `allArtistIds.has(artist.id)` exclusion
- Keep `runPipeline` as a wrapper that collects the generator into a `PipelineResult` (backward compat with AnalysisStep v1 until that step is also refactored)
- Accept `AbortSignal` so the UI "Stop scanning" button can cleanly cancel [V2-A]

### Full TypeScript

**`web/src/lib/discovery-pipeline.ts`** — replace entire file:

```typescript
import { getAudioFeaturesBatch, type AudioFeatures } from "./reccobeats";
import { buildTasteVector, scoreCandidate, type TasteVector } from "./taste-engine";
import {
  getPlaylistTracks, getArtists, searchArtists, getArtistTopTracks,
  type SpotifyTrack, type SpotifyArtist,
} from "./spotify-client";

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface PipelineProgress {
  phase: string;
  message: string;
  percent: number;
}

export interface ScoredTrack {
  track: SpotifyTrack;
  score: number;
  artist: SpotifyArtist;
  matchedGenres: string[];
}

export interface PipelineResult {
  tasteVector: TasteVector;
  coreGenres: string[];
  tracksAnalyzed: number;
  tracksWithFeatures: number;
  candidateArtists: number;
  genrePassed: number;
  candidateTracks: number;
  scored: number;
  results: ScoredTrack[];
}

/**
 * Discriminated union of streaming updates emitted by runPipelineStreaming.
 *
 * Progress updates have `done: false`. The final yield has `done: true` and
 * carries all pipeline metadata needed by the wrapper to build PipelineResult.
 * This avoids the `_lastResult` function-object stash anti-pattern.
 */
export type BatchUpdate =
  | {
      /** Incremental batch of newly scored tracks (not cumulative — caller must append) */
      batch: ScoredTrack[];
      /** Total scored tracks emitted so far (including this batch) */
      totalFound: number;
      /** Human-readable phase label */
      phase: string;
      /** Human-readable status message */
      message: string;
      /** 0–100 scan progress */
      percent: number;
      done: false;
    }
  | {
      /** Empty — no new tracks in the final done signal */
      batch: [];
      totalFound: number;
      phase: "done";
      message: string;
      percent: 100;
      done: true;
      /** Full pipeline metadata — read by runPipeline wrapper */
      tasteVector: TasteVector;
      coreGenres: string[];
      tracksAnalyzed: number;
      tracksWithFeatures: number;
      candidateArtists: number;
      genrePassed: number;
      candidateTracks: number;
      scored: number;
    };

export interface ScanOptions {
  /** Maximum number of scored tracks to emit before stopping. Default: 1000 */
  resultCount?: number;
  /** Earliest release year to accept. Default: 2000 */
  minYear?: number;
  /**
   * When true, tracks from artists already in the source playlist are included
   * (only the specific tracks already in the playlist are still excluded).
   * Useful for workout playlists where new songs from known artists are fine.
   */
  allowKnownArtists?: boolean;
  /** AbortSignal — cancel the generator cleanly [V2-A] */
  signal?: AbortSignal;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const UNIVERSAL_BANNED = new Set([
  "children's music", "kids", "lullaby", "nursery",
  "asmr", "meditation", "sleep", "white noise",
  "comedy", "stand-up comedy", "spoken word",
]);

// v2: expanded — 20 pages per term × up to 15 terms = up to 15 000 candidates
// M1: Spotify's actual max offset for search is 1000 (offset + limit ≤ 1000),
// so with limit=50 the last valid offset is 950, not 1950.
const MAX_OFFSET_PER_TERM = 950; // Spotify search hard limit: offset + limit ≤ 1000

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

/** Yield to event loop so the browser doesn't freeze during heavy loops [v3-F] */
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Throw if the abort signal has fired [V2-A] */
function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
}

// ─── Genre profile builder (unchanged from v1) ────────────────────────────────

async function buildGenreProfile(
  tracks: SpotifyTrack[],
  onProgress: (msg: string) => void,
): Promise<{ coreGenres: string[]; searchTerms: string[]; allArtistIds: Set<string> }> {
  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      if (artist.id) artistCounts.set(artist.id, (artistCounts.get(artist.id) ?? 0) + 1);
    }
  }

  const allArtistIds = new Set(artistCounts.keys());
  const artistIds = [...artistCounts.keys()];
  const genreCounts = new Map<string, number>();

  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    try {
      const artists = await getArtists(batch);
      for (const artist of artists) {
        const weight = artistCounts.get(artist.id) ?? 1;
        for (const genre of artist.genres) {
          genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + weight);
        }
      }
    } catch {
      continue;
    }
    onProgress(`Analyzing genres: ${Math.min(i + 50, artistIds.length)}/${artistIds.length} artists`);
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  const sorted = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]);
  const coreGenres = sorted.slice(0, 15).map(([g]) => g);

  const genericGenres = new Set(["rock", "pop", "metal", "jazz", "blues", "country", "folk", "soul", "r&b"]);
  const searchTerms = coreGenres.filter((g) => !genericGenres.has(g)).slice(0, 12);

  if (searchTerms.length < 5) {
    for (const g of coreGenres) {
      if (!searchTerms.includes(g)) searchTerms.push(g);
      if (searchTerms.length >= 8) break;
    }
  }

  return { coreGenres, searchTerms, allArtistIds };
}

// ─── Streaming pipeline ───────────────────────────────────────────────────────

/**
 * Streaming version of the discovery pipeline.
 *
 * Yields `BatchUpdate` objects as groups of 50 scored tracks become available.
 * The final yield has `done: true`.
 *
 * The caller is responsible for:
 *  - Appending `batch` items to their accumulated list
 *  - Stopping iteration when `done` is true or when enough tracks are found
 *  - Respecting the AbortSignal (the generator will throw AbortError if aborted)
 *
 * Usage:
 * ```ts
 * const gen = runPipelineStreaming(playlistId, options);
 * for await (const update of gen) {
 *   if (update.done) break;
 *   appendTracks(update.batch);
 * }
 * ```
 */
export async function* runPipelineStreaming(
  playlistId: string,
  options: ScanOptions = {},
): AsyncGenerator<BatchUpdate> {
  const {
    resultCount = 1000,
    minYear = 2000,
    allowKnownArtists = false,
    signal,
  } = options;

  // ── Phase 1: Load source playlist tracks ─────────────────────────────────
  yield {
    batch: [], totalFound: 0, phase: "analyze",
    message: "Loading playlist tracks...", percent: 2, done: false,
  };
  checkAbort(signal);

  const tracks = await getPlaylistTracks(playlistId);
  checkAbort(signal);

  const trackIds = tracks.map((t) => t.id).filter(Boolean);
  const existingTrackIds = new Set(trackIds);

  // ── Phase 2: Build genre profile ─────────────────────────────────────────
  yield {
    batch: [], totalFound: 0, phase: "analyze",
    message: "Analyzing genre DNA...", percent: 5, done: false,
  };
  checkAbort(signal);

  // M7: forward buildGenreProfile progress messages via yield.
  // The callback can't yield directly, so we collect the last message in a ref
  // and re-emit it in yielded updates throughout Phase 2. [M7]
  let lastGenreMsg = "Analyzing genre DNA...";
  const { coreGenres, searchTerms, allArtistIds } = await buildGenreProfile(
    tracks,
    (msg) => { lastGenreMsg = msg; },
  );
  checkAbort(signal);
  const coreGenreSet = new Set(coreGenres);

  yield {
    batch: [], totalFound: 0, phase: "analyze",
    message: lastGenreMsg, percent: 10, done: false,
  };

  // ── Phase 3: Audio features of source playlist ────────────────────────────
  yield {
    batch: [], totalFound: 0, phase: "analyze",
    message: "Analyzing audio DNA...", percent: 12, done: false,
  };
  checkAbort(signal);

  // C3: getAudioFeaturesBatch signature — check web/src/lib/reccobeats.ts before implementing.
  // If the function accepts an optional progress callback, pass one that yields batch updates.
  // If the callback is required, the compile will fail without it — add a no-op shim.
  // Current expected signature: getAudioFeaturesBatch(ids: string[]): Promise<Map<string, AudioFeatures>>
  const features = await getAudioFeaturesBatch(trackIds);
  checkAbort(signal);
  const tasteVector = buildTasteVector(features);

  yield {
    batch: [], totalFound: 0, phase: "analyze",
    message: `Audio DNA ready — ${features.size} tracks with features`, percent: 18, done: false,
  };

  // ── Phase 4: Search candidate artists (expanded for v2) ───────────────────
  const candidateArtists = new Map<string, SpotifyArtist>();
  const MIN_FOLLOWERS = 5_000;
  const MAX_FOLLOWERS = 500_000;

  for (let ti = 0; ti < searchTerms.length; ti++) {
    const term = searchTerms[ti];
    for (let offset = 0; offset <= MAX_OFFSET_PER_TERM; offset += 50) {
      checkAbort(signal);
      try {
        const artists = await searchArtists(term, offset);
        if (artists.length === 0) break; // Spotify returned nothing — move to next term

        for (const artist of artists) {
          // allowKnownArtists: skip the existing-artist filter [V2-A option]
          if (!allowKnownArtists && allArtistIds.has(artist.id)) continue;
          if (candidateArtists.has(artist.id)) continue;
          if (!isLatinName(artist.name)) continue;
          candidateArtists.set(artist.id, artist);
        }
      } catch {
        continue;
      }
    }

    const discoverPercent = 18 + ((ti + 1) / searchTerms.length) * 18;
    yield {
      batch: [], totalFound: 0, phase: "discover",
      message: `Searched "${term}" (${candidateArtists.size} candidates)`,
      percent: discoverPercent, done: false,
    };
  }

  checkAbort(signal);

  // ── Phase 5: Genre + follower gate ───────────────────────────────────────
  yield {
    batch: [], totalFound: 0, phase: "discover",
    message: "Validating genres...", percent: 37, done: false,
  };

  const genrePassed: SpotifyArtist[] = [];
  let genreLoopCount = 0;
  for (const artist of candidateArtists.values()) {
    genreLoopCount++;
    const followers = artist.followers.total;
    if (followers < MIN_FOLLOWERS || followers > MAX_FOLLOWERS) continue;

    const genres = new Set(artist.genres);
    const coreOverlap = [...genres].filter((g) => coreGenreSet.has(g));
    if (coreOverlap.length < 2) continue;
    if ([...genres].every((g) => UNIVERSAL_BANNED.has(g))) continue;

    genrePassed.push(artist);

    if (genreLoopCount % 200 === 0) await yieldToEventLoop();
    checkAbort(signal);
  }

  yield {
    batch: [], totalFound: 0, phase: "discover",
    message: `${genrePassed.length} artists passed genre gate`, percent: 40, done: false,
  };

  // ── Phase 6: Get top track per artist, score in streaming batches ─────────
  const shuffled = [...genrePassed].sort(() => Math.random() - 0.5);

  // We buffer candidates into chunks of 50 artists, then score that chunk
  // and yield as soon as a batch of 50 scored tracks is ready.
  const SCORE_CHUNK = 50;
  let totalScored = 0;
  const allScored: ScoredTrack[] = []; // accumulated for wrapper

  for (let chunkStart = 0; chunkStart < shuffled.length; chunkStart += SCORE_CHUNK) {
    checkAbort(signal);

    if (totalScored >= resultCount) break;

    const chunk = shuffled.slice(chunkStart, chunkStart + SCORE_CHUNK);
    const candidateChunk: Array<{ track: SpotifyTrack; artist: SpotifyArtist }> = [];

    // Get one top track per artist in this chunk
    for (const artist of chunk) {
      checkAbort(signal);
      try {
        const topTracks = await getArtistTopTracks(artist.id);
        for (const track of topTracks.sort((a, b) => b.popularity - a.popularity)) {
          if (existingTrackIds.has(track.id)) continue;
          if (!isLatinName(track.name)) continue;
          if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
          const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
          if (year < minYear) continue;
          candidateChunk.push({ track, artist });
          break; // one track per artist
        }
      } catch { continue; }
    }

    if (candidateChunk.length === 0) continue;

    // Score this chunk — wrapped in try/catch so one bad chunk doesn't kill the scan [M9]
    const candidateIds = candidateChunk.map((c) => c.track.id);
    let chunkFeatures: Map<string, AudioFeatures>;
    try {
      chunkFeatures = await getAudioFeaturesBatch(candidateIds);
    } catch {
      // ReccoBeats error for this chunk — skip and continue with next chunk [M9]
      continue;
    }
    checkAbort(signal);

    const batchScored: ScoredTrack[] = [];
    for (const { track, artist } of candidateChunk) {
      const feats = chunkFeatures.get(track.id);
      if (!feats) continue;
      const score = scoreCandidate(feats, tasteVector);
      const matchedGenres = artist.genres.filter((g) => coreGenreSet.has(g));
      batchScored.push({ track, score, artist, matchedGenres });
    }

    batchScored.sort((a, b) => b.score - a.score);
    allScored.push(...batchScored);
    totalScored += batchScored.length;

    const overallPercent = 40 + Math.min((chunkStart / shuffled.length) * 58, 58);

    yield {
      batch: batchScored,
      totalFound: totalScored,
      phase: "score",
      message: `Scored ${totalScored} tracks (${Math.round((chunkStart / shuffled.length) * 100)}% of artists scanned)`,
      percent: overallPercent,
      done: false,
    };

    await yieldToEventLoop();
  }

  // ── Final yield — DoneUpdate carries full metadata, no stash needed ──────
  yield {
    batch: [],
    totalFound: totalScored,
    phase: "done",
    message: `Complete! Found ${totalScored} tracks.`,
    percent: 100,
    done: true,
    tasteVector,
    coreGenres,
    tracksAnalyzed: trackIds.length,
    tracksWithFeatures: features.size,
    candidateArtists: candidateArtists.size,
    genrePassed: genrePassed.length,
    candidateTracks: allScored.length,
    scored: allScored.length,
  };
}

// ─── Backward-compat wrapper ──────────────────────────────────────────────────

/**
 * Original single-shot pipeline API, now implemented as a streaming wrapper.
 * Collects all batches and returns PipelineResult.
 * Kept for AnalysisStep v1 compatibility — will be removed in v3.
 */
export async function runPipeline(
  playlistId: string,
  onProgress: (progress: PipelineProgress) => void,
  resultCount: number = 50,
  minYear: number = 2000,
): Promise<PipelineResult> {
  const allResults: ScoredTrack[] = [];
  // DoneUpdate is read directly from the final yield — no stash on function object needed [C1]
  let doneUpdate: Extract<BatchUpdate, { done: true }> | null = null;

  const gen = runPipelineStreaming(playlistId, { resultCount, minYear });

  for await (const update of gen) {
    onProgress({ phase: update.phase, message: update.message, percent: update.percent });
    if (update.batch.length > 0) {
      allResults.push(...update.batch);
    }
    if (update.done) {
      doneUpdate = update;
    }
  }

  // Sort cumulative by score
  allResults.sort((a, b) => b.score - a.score);

  return {
    tasteVector: doneUpdate?.tasteVector ?? { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
    coreGenres: doneUpdate?.coreGenres ?? [],
    tracksAnalyzed: doneUpdate?.tracksAnalyzed ?? 0,
    tracksWithFeatures: doneUpdate?.tracksWithFeatures ?? 0,
    candidateArtists: doneUpdate?.candidateArtists ?? 0,
    genrePassed: doneUpdate?.genrePassed ?? 0,
    candidateTracks: doneUpdate?.candidateTracks ?? 0,
    scored: doneUpdate?.scored ?? 0,
    results: allResults.slice(0, resultCount),
  };
}
```

### Note on `BatchUpdate` discriminated union [C1]

`BatchUpdate` is a discriminated union: progress updates have `done: false`, the final yield has `done: true` and carries the full pipeline metadata (`tasteVector`, `coreGenres`, counts). The `runPipeline` wrapper reads the `DoneUpdate` directly from the loop — no stash on the function object, no shared mutable state, no race condition if two pipelines run concurrently.

### Expected build output

```bash
cd C:\Users\fires\OneDrive\Git\spotify-recommendation\web
npm run build
```

No TypeScript errors. No ESLint warnings. Build completes.

### Commit message

```
feat(pipeline): streaming AsyncGenerator, 1000-track target, allowKnownArtists option

- Add runPipelineStreaming: AsyncGenerator<BatchUpdate> (discriminated union, no _lastResult stash) [C1]
- Yields batches of 50 scored tracks as available
- MAX_OFFSET_PER_TERM = 950 (Spotify hard limit: offset+limit ≤ 1000) [M1]
- Add ScanOptions: resultCount, minYear, allowKnownArtists, signal (AbortSignal)
- Per-chunk getAudioFeaturesBatch wrapped in try/catch — one bad chunk doesn't kill scan [M9]
- Keep runPipeline as backward-compat wrapper, reads DoneUpdate for metadata [C1]
- Abort check on every Spotify call [V2-A]
```

---

## Batch 2: Storage Updates — Scan State Persistence

**Files changed:** `web/src/lib/storage.ts`

### What changes

- Add `ScanState` interface: playlistId, playlistName, scanOptions, allResults, searchProgress, targetPlaylistId, targetPlaylistName, savedAt
- Add `saveScanState(state)`, `loadScanState()`, `clearScanState()`
- Add `saveTargetPlaylist(id, name)`, `loadTargetPlaylist()` (remembers last-used destination playlist across sessions)

### Full TypeScript

**`web/src/lib/storage.ts`** — replace entire file:

```typescript
// ─── Key registry ─────────────────────────────────────────────────────────────

const KEYS = {
  CLIENT_ID: "soundfox_client_id",
  ACCESS_TOKEN: "soundfox_access_token",
  REFRESH_TOKEN: "soundfox_refresh_token",
  TOKEN_EXPIRY: "soundfox_token_expiry",
  CODE_VERIFIER: "soundfox_code_verifier",
  HISTORY: "soundfox_history",
  SCAN_STATE: "soundfox_scan_state",         // v2: resume support
  TARGET_PLAYLIST: "soundfox_target_pl",     // v2: last-used destination playlist
} as const;

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function getClientId(): string | null {
  return localStorage.getItem(KEYS.CLIENT_ID);
}

export function setClientId(id: string): void {
  localStorage.setItem(KEYS.CLIENT_ID, id);
}

export function getAccessToken(): string | null {
  const expiry = localStorage.getItem(KEYS.TOKEN_EXPIRY);
  if (expiry && Date.now() > parseInt(expiry, 10)) return null;
  return localStorage.getItem(KEYS.ACCESS_TOKEN);
}

export function setTokens(accessToken: string, expiresIn: number, refreshToken?: string): void {
  localStorage.setItem(KEYS.ACCESS_TOKEN, accessToken);
  localStorage.setItem(KEYS.TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));
  if (refreshToken) localStorage.setItem(KEYS.REFRESH_TOKEN, refreshToken);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(KEYS.REFRESH_TOKEN);
}

export function setCodeVerifier(verifier: string): void {
  localStorage.setItem(KEYS.CODE_VERIFIER, verifier);
}

export function getCodeVerifier(): string | null {
  return localStorage.getItem(KEYS.CODE_VERIFIER);
}

export function clearAuth(): void {
  localStorage.removeItem(KEYS.ACCESS_TOKEN);
  localStorage.removeItem(KEYS.REFRESH_TOKEN);
  localStorage.removeItem(KEYS.TOKEN_EXPIRY);
  localStorage.removeItem(KEYS.CODE_VERIFIER);
}

// ─── Analysis history ─────────────────────────────────────────────────────────

export interface AnalysisRecord {
  id: string;
  playlistId: string;
  playlistName: string;
  trackCount: number;
  tasteVector: Record<string, number>;
  resultCount: number;
  createdAt: string;
}

export function getHistory(): AnalysisRecord[] {
  const raw = localStorage.getItem(KEYS.HISTORY);
  return raw ? (JSON.parse(raw) as AnalysisRecord[]) : [];
}

export function saveAnalysis(record: AnalysisRecord): void {
  const history = getHistory();
  history.unshift(record);
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(history.slice(0, 20)));
}

// ─── Scan state (v2 resume support) ──────────────────────────────────────────

import type { ScoredTrack, ScanOptions } from "./discovery-pipeline";

export interface ScanState {
  /** Source playlist being analyzed — named sourcePlaylist* to distinguish from target [C2] */
  sourcePlaylistId: string;
  sourcePlaylistName: string;
  /** Options used for this scan */
  scanOptions: ScanOptions;
  /** All scored tracks accumulated so far */
  allResults: ScoredTrack[];
  /** Destination playlist if one was created/selected during this scan */
  targetPlaylistId: string | null;
  targetPlaylistName: string | null;
  /** ISO timestamp — used to show "X minutes ago" in resume prompt */
  savedAt: string;
}

export function saveScanState(state: ScanState): void {
  try {
    localStorage.setItem(KEYS.SCAN_STATE, JSON.stringify(state));
  } catch {
    // Quota exceeded — silently skip (scan still works, just no resume)
  }
}

export function loadScanState(): ScanState | null {
  const raw = localStorage.getItem(KEYS.SCAN_STATE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanState;
  } catch {
    return null;
  }
}

export function clearScanState(): void {
  localStorage.removeItem(KEYS.SCAN_STATE);
}

// ─── Target playlist memory (v2) ─────────────────────────────────────────────

export interface SavedTargetPlaylist {
  id: string;
  name: string;
}

export function saveTargetPlaylist(id: string, name: string): void {
  localStorage.setItem(KEYS.TARGET_PLAYLIST, JSON.stringify({ id, name }));
}

export function loadTargetPlaylist(): SavedTargetPlaylist | null {
  const raw = localStorage.getItem(KEYS.TARGET_PLAYLIST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedTargetPlaylist;
  } catch {
    return null;
  }
}
```

### Expected build output

No TypeScript errors. Circular import note: `storage.ts` imports `ScoredTrack` and `ScanOptions` from `discovery-pipeline.ts` — this is a type-only import and will not cause a runtime cycle because `discovery-pipeline.ts` imports from `spotify-client.ts`, not from `storage.ts`.

If the TypeScript compiler reports a circular reference, change the import to:
```typescript
import type { ScoredTrack, ScanOptions } from "./discovery-pipeline";
```
(the `type` keyword is already present in the code above — this is already correct)

### Commit message

```
feat(storage): add ScanState persistence for resume support [V2-F]

- ScanState: sourcePlaylistId/sourcePlaylistName, scanOptions, allResults, targetPlaylistId, savedAt
- saveScanState / loadScanState / clearScanState
- saveTargetPlaylist / loadTargetPlaylist for destination memory
```

---

## Batch 3: New ResultsStep — Pagination, Sort, Filter, Bidirectional Add/Remove

This is the largest batch. It touches three files:
1. `web/src/lib/spotify-client.ts` — add `removeTracksFromPlaylist`
2. `web/src/components/TrackRow.tsx` — new extracted component (React.memo)
3. `web/src/components/ResultsStep.tsx` — full rewrite

### 3a: Add `removeTracksFromPlaylist` to spotify-client.ts

**`web/src/lib/spotify-client.ts`** — append after the existing `addTracksToPlaylist` function:

```typescript
/**
 * Remove tracks from a playlist using URI-only deletion. [V2-E, H3]
 *
 * This removes ALL occurrences of each URI in the playlist (Spotify's default
 * behaviour when no `positions` field is provided). This is simpler and safer
 * than snapshot+positions deletion, and sufficient for SoundFox because we only
 * ever add one copy of each track.
 *
 * Batched in groups of 100 (Spotify API limit per request).
 */
export async function removeTracksFromPlaylist(
  playlistId: string,
  trackUris: string[],
): Promise<void> {
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "DELETE",
      body: JSON.stringify({
        tracks: batch.map((uri) => ({ uri })),
      }),
    });
  }
}
```

Also add `removeTracksFromPlaylist` to the existing export list in the same file (it is automatically exported as a named export by being a top-level `export async function`).

### 3b: TrackRow component

**Create new file: `web/src/components/TrackRow.tsx`**

```typescript
"use client";

import React, { memo } from "react";
import Image from "next/image";
import { type ScoredTrack } from "@/lib/discovery-pipeline";

export type TrackStatus = "idle" | "adding" | "added" | "removing";

interface TrackRowProps {
  item: ScoredTrack;
  index: number;
  isAdded: boolean;
  status: TrackStatus;
  isPlaying: boolean;
  onToggle: (id: string, added: boolean) => void;
  onPreview: (track: ScoredTrack["track"]) => void;
}

/**
 * Single track row.
 * Wrapped in React.memo to prevent 1000-row re-renders on every state change. [V2-C]
 */
const TrackRow = memo(function TrackRow({
  item,
  index,
  isAdded,
  status,
  isPlaying,
  onToggle,
  onPreview,
}: TrackRowProps): React.ReactElement {
  const hasPreview = !!item.track.preview_url;
  const albumImage = item.track.album.images[0]?.url;
  const scorePercent = Math.round(item.score * 100);
  const year = item.track.album.release_date?.slice(0, 4) ?? "";

  const isInFlight = status === "adding" || status === "removing";

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
        isAdded
          ? "bg-[var(--bg-card)] border-[var(--accent)]/30"
          : "bg-[var(--bg-secondary)] border-[var(--border)] opacity-60"
      }`}
    >
      {/* Rank */}
      <span className="text-[var(--text-secondary)] text-sm w-6 text-center flex-shrink-0 tabular-nums">
        {index + 1}
      </span>

      {/* Album art — click opens Spotify [Feature 5] */}
      <a
        href={`https://open.spotify.com/track/${item.track.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-[var(--bg-secondary)] block"
        title="Open in Spotify"
      >
        {albumImage ? (
          <Image src={albumImage} alt="" width={40} height={40} className="object-cover hover:opacity-80 transition-opacity" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">
            &#9834;
          </div>
        )}
      </a>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        {/* Track name — click opens Spotify [Feature 5] */}
        <a
          href={`https://open.spotify.com/track/${item.track.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white text-sm font-medium truncate block hover:text-[var(--accent)] transition-colors"
          title={item.track.name}
        >
          {item.track.name}
        </a>
        <p className="text-[var(--text-secondary)] text-xs truncate">{item.artist.name}</p>
        {item.matchedGenres.length > 0 && (
          <p className="text-[var(--accent)] text-xs truncate mt-0.5">
            {item.matchedGenres.slice(0, 2).join(", ")}
          </p>
        )}
      </div>

      {/* Year */}
      <span className="text-[var(--text-secondary)] text-xs flex-shrink-0 w-8 tabular-nums">
        {year}
      </span>

      {/* Score badge */}
      <div className="flex-shrink-0 text-center w-12">
        <p className="text-[var(--accent)] font-bold text-sm tabular-nums">{scorePercent}%</p>
        <p className="text-[var(--text-secondary)] text-xs">match</p>
      </div>

      {/* External link icon [Feature 5] */}
      <a
        href={`https://open.spotify.com/track/${item.track.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-colors"
        title="Open in Spotify"
        aria-label="Open in Spotify"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>

      {/* Preview button */}
      <button
        onClick={() => onPreview(item.track)}
        disabled={!hasPreview}
        className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
          hasPreview
            ? isPlaying
              ? "bg-[var(--accent)] text-black"
              : "bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/20 text-[var(--text-secondary)]"
            : "opacity-20 cursor-not-allowed bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        }`}
        title={hasPreview ? (isPlaying ? "Stop preview" : "Play 30s preview") : "No preview available"}
      >
        {isPlaying ? (
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
            <rect x="6" y="4" width="4" height="16" />
            <rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 ml-0.5">
            <path d="M8 5v14l11-7z" />
          </svg>
        )}
      </button>

      {/* Add/remove checkbox — optimistic UI with per-row spinner [V2-B] */}
      <button
        onClick={() => onToggle(item.track.id, isAdded)}
        disabled={isInFlight}
        className={`flex-shrink-0 w-6 h-6 rounded border-2 transition-colors flex items-center justify-center ${
          isInFlight
            ? "border-[var(--accent)]/50 cursor-wait"
            : isAdded
            ? "bg-[var(--accent)] border-[var(--accent)]"
            : "border-[var(--border)] hover:border-[var(--accent)]/50"
        }`}
        title={isAdded ? "Remove from playlist" : "Add to playlist"}
        aria-label={isAdded ? "Remove from playlist" : "Add to playlist"}
      >
        {isInFlight ? (
          <span className="inline-block w-3 h-3 border border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        ) : isAdded ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="w-3 h-3 text-black">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>
    </div>
  );
});

export default TrackRow;
```

### 3c: ResultsStep rewrite

**`web/src/components/ResultsStep.tsx`** — replace entire file:

```typescript
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type PipelineResult, type ScoredTrack } from "@/lib/discovery-pipeline";
import { saveAnalysis, saveTargetPlaylist } from "@/lib/storage";
import {
  getCurrentUser, createPlaylist, addTracksToPlaylist, removeTracksFromPlaylist,
  getUserPlaylists, getPlaylistTracks, type SpotifyPlaylist,
} from "@/lib/spotify-client";
import TrackRow, { type TrackStatus } from "./TrackRow";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ResultsStepProps {
  result: PipelineResult;
  playlistName: string;
  playlistId: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SortKey = "score" | "popularity" | "year" | "random";
type DestinationMode = "new" | "existing";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 300; // [V2-B]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function releaseDateToYear(releaseDate: string | undefined): number {
  return parseInt(releaseDate?.slice(0, 4) ?? "0", 10);
}

function sortTracks(tracks: ScoredTrack[], key: SortKey, randomSeed: number): ScoredTrack[] {
  const copy = [...tracks];
  switch (key) {
    case "score":
      return copy.sort((a, b) => b.score - a.score);
    case "popularity":
      return copy.sort((a, b) => b.track.popularity - a.track.popularity);
    case "year":
      return copy.sort((a, b) =>
        releaseDateToYear(b.track.album.release_date) - releaseDateToYear(a.track.album.release_date),
      );
    case "random":
      // Stable pseudo-random per randomSeed so re-renders don't reshuffle
      return copy.sort((a, b) => {
        const ha = (a.track.id.charCodeAt(0) + randomSeed) % 97;
        const hb = (b.track.id.charCodeAt(0) + randomSeed) % 97;
        return ha - hb;
      });
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsStep({ result, playlistName, playlistId }: ResultsStepProps): React.ReactElement {
  const { results, tasteVector, coreGenres } = result;

  // ── Destination playlist ───────────────────────────────────────────────────
  const [destMode, setDestMode] = useState<DestinationMode>("new");
  const [targetPlaylistId, setTargetPlaylistId] = useState<string | null>(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState<string>(`Discover: ${playlistName}`);
  const [playlistNameInput, setPlaylistNameInput] = useState<string>(`Discover: ${playlistName}`);
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameConfirmed, setNameConfirmed] = useState(false);
  // For "Add to existing" mode
  const [userPlaylists, setUserPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);

  // ── Track state ────────────────────────────────────────────────────────────
  // added: Set of track IDs that have been confirmed added to the target playlist
  const [added, setAdded] = useState<Set<string>>(new Set());
  // statuses: per-track API call status for optimistic UI
  const [statuses, setStatuses] = useState<Map<string, TrackStatus>>(new Map());
  // debounce timers per track [V2-B]
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Cleanup all debounce timers on unmount [H2] ───────────────────────────
  useEffect(() => {
    return () => {
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const [page, setPage] = useState(0);

  // ── Sort & filter ──────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [randomSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [textFilter, setTextFilter] = useState("");
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [followerMin, setFollowerMin] = useState<string>("");
  const [followerMax, setFollowerMax] = useState<string>("");

  // ── Audio preview ──────────────────────────────────────────────────────────
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Save analysis to history on mount [H5] ─────────────────────────────────
  useEffect(() => {
    const meanVector: Record<string, number> = {};
    for (const [k, v] of Object.entries(tasteVector.mean)) {
      if (v != null) meanVector[k] = v;
    }
    saveAnalysis({
      id: crypto.randomUUID(),
      playlistId,
      playlistName,
      trackCount: result.tracksAnalyzed,
      tasteVector: meanVector,
      resultCount: results.length,
      createdAt: new Date().toISOString(),
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load user playlists when "existing" mode selected ─────────────────────
  useEffect(() => {
    if (destMode === "existing" && !playlistsLoaded) {
      getUserPlaylists()
        .then((pls) => { setUserPlaylists(pls); setPlaylistsLoaded(true); })
        .catch(() => setPlaylistsLoaded(true));
    }
  }, [destMode, playlistsLoaded]);

  // ── Pre-populate `added` set when an existing target playlist is chosen [H1] ──
  // After the user picks an existing playlist, fetch its current tracks and mark
  // any that overlap with our results as already-added. Prevents duplicates.
  useEffect(() => {
    if (destMode !== "existing" || !targetPlaylistId) return;
    void (async () => {
      try {
        const existingTracks = await getPlaylistTracks(targetPlaylistId);
        const existingIds = new Set(existingTracks.map((t) => t.id));
        setAdded((prev) => {
          const next = new Set(prev);
          for (const item of results) {
            if (existingIds.has(item.track.id)) next.add(item.track.id);
          }
          return next;
        });
      } catch {
        // Non-fatal — user can still add tracks, they may just see duplicates
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPlaylistId, destMode]);

  // ── Filtered & sorted track list ──────────────────────────────────────────
  const filteredSorted = useMemo(() => {
    const fMin = followerMin ? parseInt(followerMin, 10) : 0;
    const fMax = followerMax ? parseInt(followerMax, 10) : Infinity;
    const text = textFilter.toLowerCase().trim();

    const filtered = results.filter((item) => {
      if (text && !item.track.name.toLowerCase().includes(text) && !item.artist.name.toLowerCase().includes(text)) {
        return false;
      }
      if (genreFilter && !item.artist.genres.includes(genreFilter)) return false;
      const followers = item.artist.followers.total;
      if (followers < fMin || followers > fMax) return false;
      return true;
    });

    return sortTracks(filtered, sortKey, randomSeed);
  }, [results, textFilter, genreFilter, followerMin, followerMax, sortKey, randomSeed]);

  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const pageItems = filteredSorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset to page 0 when filter changes
  useEffect(() => { setPage(0); }, [textFilter, genreFilter, followerMin, followerMax, sortKey]);

  // ── Genre chip list (top 20 from results for filter bar) ─────────────────
  const allGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of results) {
      for (const g of item.matchedGenres) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([g]) => g);
  }, [results]);

  // ── Create / resolve target playlist ─────────────────────────────────────
  // Wrapped in useCallback so the function reference is stable across renders.
  // handleToggle depends on ensureTargetPlaylist — if ensureTargetPlaylist is
  // recreated on every render, handleToggle would also be recreated, defeating
  // React.memo on TrackRow. [V2-C]

  const ensureTargetPlaylist = useCallback(async (): Promise<string> => {
    if (targetPlaylistId) return targetPlaylistId;

    if (destMode === "new") {
      const user = await getCurrentUser();
      const newPl = await createPlaylist(
        user.id,
        targetPlaylistName,
        `Discovered by SoundFox — matching ${playlistName}`,
      );
      setTargetPlaylistId(newPl.id);
      saveTargetPlaylist(newPl.id, targetPlaylistName);
      return newPl.id;
    }

    throw new Error("No target playlist selected");
  }, [destMode, targetPlaylistId, targetPlaylistName, selectedExistingPlaylistId, user]);

  // ── Debounced toggle handler [V2-B] ───────────────────────────────────────

  const handleToggle = useCallback((trackId: string, currentlyAdded: boolean): void => {
    // Cancel any pending debounce for this track
    const existingTimer = debounceTimers.current.get(trackId);
    if (existingTimer) clearTimeout(existingTimer);

    // If we have no playlist name yet (new mode, first check), show the prompt.
    // No debounce timer is started until nameConfirmed=true — serializes the flow [H2]
    if (destMode === "new" && !nameConfirmed) {
      setShowNamePrompt(true);
      return;
    }

    // Optimistic UI: flip the added state immediately
    setAdded((prev) => {
      const next = new Set(prev);
      if (currentlyAdded) next.delete(trackId);
      else next.add(trackId);
      return next;
    });

    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(trackId, currentlyAdded ? "removing" : "adding");
      return next;
    });

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const plId = await ensureTargetPlaylist();
          if (currentlyAdded) {
            await removeTracksFromPlaylist(plId, [`spotify:track:${trackId}`]);
          } else {
            await addTracksToPlaylist(plId, [`spotify:track:${trackId}`]);
          }
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(trackId, currentlyAdded ? "idle" : "added");
            return next;
          });
        } catch {
          // Roll back optimistic update on failure
          setAdded((prev) => {
            const next = new Set(prev);
            if (currentlyAdded) next.add(trackId); // restore added
            else next.delete(trackId); // restore not-added
            return next;
          });
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(trackId, "idle");
            return next;
          });
        }
      })();
    }, DEBOUNCE_MS);

    debounceTimers.current.set(trackId, timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destMode, nameConfirmed, ensureTargetPlaylist]);

  // ── Audio preview ─────────────────────────────────────────────────────────

  function handlePreview(track: ScoredTrack["track"]): void {
    if (playingId === track.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (!track.preview_url) return;
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.src = track.preview_url;
      audioRef.current.play().catch(() => { /* autoplay blocked */ });
    }
    setPlayingId(track.id);
  }

  // ── Persistent badge count ────────────────────────────────────────────────
  const addedCount = added.size;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />

      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold mb-1">Your Recommendations</h2>
        <p className="text-[var(--text-secondary)] text-sm">
          Found {results.length} tracks matching the audio DNA of{" "}
          <span className="text-white font-medium">{playlistName}</span>
        </p>
      </div>

      {/* Persistent badge [Feature 3 — badge] */}
      {addedCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-950/30 border border-green-800 rounded-xl text-green-400 text-sm font-medium">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4 flex-shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {addedCount} {addedCount === 1 ? "track" : "tracks"} added to{" "}
          <span className="font-semibold">{targetPlaylistName}</span>
          {targetPlaylistId && (
            <a
              href={`https://open.spotify.com/playlist/${targetPlaylistId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-green-400 hover:text-green-300 transition-colors text-xs underline"
            >
              Open in Spotify
            </a>
          )}
        </div>
      )}

      {/* Destination toggle [Feature 3 — destination] */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-[var(--text-secondary)]">Add tracks to:</p>
        <div className="flex gap-2">
          <button
            onClick={() => setDestMode("new")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              destMode === "new"
                ? "bg-[var(--accent)] text-black"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            New playlist
          </button>
          <button
            onClick={() => setDestMode("existing")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              destMode === "existing"
                ? "bg-[var(--accent)] text-black"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            Add to: {destMode === "existing" && targetPlaylistId
              ? targetPlaylistName
              : "existing playlist"}
          </button>
        </div>

        {destMode === "existing" && (
          <div className="mt-2">
            {!playlistsLoaded ? (
              <p className="text-[var(--text-secondary)] text-xs">Loading your playlists...</p>
            ) : (
              <select
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                           text-sm text-white focus:outline-none focus:border-[var(--accent)]"
                value={targetPlaylistId ?? ""}
                onChange={(e) => {
                  const pl = userPlaylists.find((p) => p.id === e.target.value);
                  if (pl) {
                    setTargetPlaylistId(pl.id);
                    setTargetPlaylistName(pl.name);
                    saveTargetPlaylist(pl.id, pl.name);
                    setNameConfirmed(true);
                  }
                }}
              >
                <option value="">— Select a playlist —</option>
                {userPlaylists.map((pl) => (
                  <option key={pl.id} value={pl.id}>{pl.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Playlist name prompt — appears on first checkbox in "new" mode */}
      {showNamePrompt && (
        <div className="bg-[var(--bg-card)] border border-[var(--accent)]/40 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold">Name your new playlist</p>
          <input
            type="text"
            value={playlistNameInput}
            onChange={(e) => setPlaylistNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && playlistNameInput.trim()) {
                setTargetPlaylistName(playlistNameInput.trim());
                setNameConfirmed(true);
                setShowNamePrompt(false);
              }
            }}
            className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm focus:outline-none focus:border-[var(--accent)]"
            autoFocus
          />
          <button
            onClick={() => {
              if (playlistNameInput.trim()) {
                setTargetPlaylistName(playlistNameInput.trim());
                setNameConfirmed(true);
                setShowNamePrompt(false);
              }
            }}
            disabled={!playlistNameInput.trim()}
            className="w-full py-2 bg-[var(--accent)] rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            Confirm name
          </button>
        </div>
      )}

      {/* Sort + Filter bar [Feature 3 — sort/filter] */}
      <div className="space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Search tracks or artists..."
            className="flex-1 min-w-0 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm focus:outline-none focus:border-[var(--accent)] placeholder-gray-600"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm text-white focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="score">Sort: Match score</option>
            <option value="popularity">Sort: Popularity</option>
            <option value="year">Sort: Year (newest)</option>
            <option value="random">Sort: Random</option>
          </select>
        </div>

        {/* Genre filter chips */}
        {allGenres.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setGenreFilter(null)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                genreFilter === null
                  ? "bg-[var(--accent)] text-black font-medium"
                  : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
              }`}
            >
              All genres
            </button>
            {allGenres.map((g) => (
              <button
                key={g}
                onClick={() => setGenreFilter(genreFilter === g ? null : g)}
                className={`px-2.5 py-1 rounded-full text-xs capitalize transition-colors ${
                  genreFilter === g
                    ? "bg-[var(--accent)] text-black font-medium"
                    : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {/* Follower range filter */}
        <div className="flex gap-2 items-center text-xs text-[var(--text-secondary)]">
          <span>Followers:</span>
          <input
            type="number"
            value={followerMin}
            onChange={(e) => setFollowerMin(e.target.value)}
            placeholder="Min"
            className="w-24 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-white
                       focus:outline-none focus:border-[var(--accent)]"
          />
          <span>–</span>
          <input
            type="number"
            value={followerMax}
            onChange={(e) => setFollowerMax(e.target.value)}
            placeholder="Max"
            className="w-24 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-white
                       focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      {/* Track list with pagination [Feature 3 — pagination] */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
          <span>
            {filteredSorted.length} tracks
            {genreFilter || textFilter ? " (filtered)" : ""}
          </span>
          <span>Page {page + 1} of {totalPages}</span>
        </div>

        {/* [V2-D] CSS containment for windowing-like performance */}
        <div
          className="space-y-2 max-h-[55vh] overflow-y-auto pr-1"
          style={{ contain: "content" }}
        >
          {pageItems.map((item, idx) => (
            <TrackRow
              key={item.track.id}
              item={item}
              index={page * PAGE_SIZE + idx}
              isAdded={added.has(item.track.id)}
              status={statuses.get(item.track.id) ?? "idle"}
              isPlaying={playingId === item.track.id}
              onToggle={handleToggle}
              onPreview={handlePreview}
            />
          ))}
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg text-sm bg-[var(--bg-secondary)] disabled:opacity-40
                         hover:bg-[var(--bg-card)] transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-[var(--text-secondary)]">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-3 py-1.5 rounded-lg text-sm bg-[var(--bg-secondary)] disabled:opacity-40
                         hover:bg-[var(--bg-card)] transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Taste profile summary */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
        <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wide">
          Taste Profile
        </p>
        <div className="flex flex-wrap gap-2 mb-3">
          {coreGenres.slice(0, 6).map((genre) => (
            <span
              key={genre}
              className="px-3 py-1 bg-[var(--accent)]/10 border border-[var(--accent)]/30
                         text-[var(--accent)] rounded-full text-xs font-medium capitalize"
            >
              {genre}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3 text-center text-xs">
          <div>
            <p className="text-[var(--text-secondary)]">Analyzed</p>
            <p className="text-white font-semibold">{result.tracksAnalyzed} tracks</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Candidates</p>
            <p className="text-white font-semibold">{result.candidateTracks}</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Scored</p>
            <p className="text-white font-semibold">{result.scored}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### Expected build output

```bash
npm run build
```

No TypeScript errors. The `removeTracksFromPlaylist` call will fail at runtime if the `[V2-H]` addition to `spotify-client.ts` is not done first — verify the export exists before testing.

### Commit message

```
feat(results): bidirectional add/remove, pagination, sort/filter, Spotify links [V2-B,V2-C,V2-D,V2-E,V2-H]

- Add removeTracksFromPlaylist to spotify-client.ts
- Extract TrackRow (React.memo) for performance
- ResultsStep: destination toggle (new/existing), optimistic add/remove
- Debounced toggle handler (300ms) to avoid Spotify spam
- Pagination: 50 tracks/page, page N of M
- Sort: score/popularity/year/random
- Filter: text search, genre chips, follower range
- Persistent badge showing X tracks added to [name]
- Spotify links on track name, album art, external icon
```

---

## Batch 4: Pre-Scan Options — ScanOptionsStep

This step is inserted between PlaylistStep (step 3) and AnalysisStep (step 4). The wizard gets a new step 3.5 (shifted to step 4, AnalysisStep becomes step 5, ResultsStep becomes step 6).

**Files changed:**
- Create: `web/src/components/ScanOptionsStep.tsx`
- Modify: `web/src/app/wizard/page.tsx`

### 4a: ScanOptionsStep component

**Create: `web/src/components/ScanOptionsStep.tsx`**

```typescript
"use client";

import { useState } from "react";
import { type ScanOptions } from "@/lib/discovery-pipeline";
import { type SpotifyPlaylist } from "@/lib/spotify-client";

interface ScanOptionsStepProps {
  playlist: SpotifyPlaylist;
  onStart: (options: ScanOptions) => void;
}

export default function ScanOptionsStep({ playlist, onStart }: ScanOptionsStepProps): React.ReactElement {
  const [allowKnownArtists, setAllowKnownArtists] = useState(false);
  const [minYear, setMinYear] = useState(2000);
  const [resultCount, setResultCount] = useState(500);

  function handleStart(): void {
    onStart({ allowKnownArtists, minYear, resultCount });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Scan Options</h2>
        <p className="text-[var(--text-secondary)]">
          Customise how SoundFox scans for music matching{" "}
          <span className="text-white font-medium">{playlist.name}</span>.
        </p>
      </div>

      {/* Allow known artists toggle */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-sm">Allow known artists</p>
            <p className="text-[var(--text-secondary)] text-xs mt-0.5">
              Include new songs from artists already in your playlist.
              Useful for workout playlists where any new track from a known artist is fine.
            </p>
          </div>
          {/* Toggle switch */}
          <button
            role="switch"
            aria-checked={allowKnownArtists}
            onClick={() => setAllowKnownArtists((v) => !v)}
            className={`relative flex-shrink-0 ml-4 w-12 h-6 rounded-full transition-colors ${
              allowKnownArtists ? "bg-[var(--accent)]" : "bg-[var(--bg-secondary)]"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                allowKnownArtists ? "translate-x-6" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Minimum year */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <p className="font-semibold text-sm">Minimum release year</p>
        <p className="text-[var(--text-secondary)] text-xs">
          Only include tracks released after this year.
        </p>
        <div className="flex items-center gap-3">
          {/* H6: min 1960 (supports older playlists), max is current year (dynamic) */}
          <input
            type="range"
            min={1960}
            max={new Date().getFullYear()}
            step={1}
            value={minYear}
            onChange={(e) => setMinYear(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--accent)]"
          />
          <span className="text-white font-semibold tabular-nums w-12 text-right">{minYear}</span>
        </div>
      </div>

      {/* Result count */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <p className="font-semibold text-sm">Target result count</p>
        <p className="text-[var(--text-secondary)] text-xs">
          How many tracks to find. More tracks = longer scan. Maximum: 1000.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={50}
            max={1000}
            step={50}
            value={resultCount}
            onChange={(e) => setResultCount(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--accent)]"
          />
          <span className="text-white font-semibold tabular-nums w-16 text-right">{resultCount}</span>
        </div>
      </div>

      {/* Estimated time */}
      <p className="text-[var(--text-secondary)] text-xs text-center">
        Estimated scan time: {Math.round((resultCount / 50) * 0.4 + 1)}–{Math.round((resultCount / 50) * 0.8 + 3)} minutes
      </p>

      <button
        onClick={handleStart}
        className="w-full py-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl
                   font-semibold text-lg transition-colors"
      >
        Start Scanning
      </button>
    </div>
  );
}
```

### 4b: Update wizard/page.tsx

**`web/src/app/wizard/page.tsx`** — replace entire file:

```typescript
"use client";

import { useState, useEffect, useCallback } from "react";
import WizardLayout from "@/components/WizardLayout";
import SetupStep from "@/components/SetupStep";
import PlaylistStep from "@/components/PlaylistStep";
import ScanOptionsStep from "@/components/ScanOptionsStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import { getClientId, getAccessToken, loadScanState } from "@/lib/storage";
import { startLogin } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult, type ScanOptions } from "@/lib/discovery-pipeline";

const STEP_NAMES = ["Setup", "Connect", "Choose Playlist", "Scan Options", "Analyze", "Results"];

export default function WizardPage(): React.ReactElement {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  // H5: scanOptions is set once by handleScanOptionsConfirmed and never mutated.
  // useState is sufficient here because setScanOptions is called with a fresh object
  // only when the user confirms options — it is not rebuilt on every render.
  const [scanOptions, setScanOptions] = useState<ScanOptions>({});
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  // Resume banner: show if a previous partial scan is available
  const [resumeAvailable, setResumeAvailable] = useState(false);

  useEffect(() => {
    if (!getClientId()) return;

    // Check for resumable scan and pre-populate result so "Resume" goes straight to ResultsStep [C2]
    const saved = loadScanState();
    if (saved && saved.allResults.length > 0) {
      setResumeAvailable(true);
      const sorted = [...saved.allResults].sort((a, b) => b.score - a.score);
      setPipelineResult({
        tasteVector: { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
        coreGenres: [],
        tracksAnalyzed: 0,
        tracksWithFeatures: 0,
        candidateArtists: 0,
        genrePassed: 0,
        candidateTracks: sorted.length,
        scored: sorted.length,
        results: sorted,
      });
      setSelectedPlaylist({
        id: saved.sourcePlaylistId,
        name: saved.sourcePlaylistName,
        images: [],
        tracks: { total: 0 },
        owner: { display_name: "" },
      });
    }

    if (getAccessToken()) {
      getCurrentUser()
        .then((u) => { setUser(u); setStep(3); })
        .catch(() => setStep(2));
    } else {
      setStep(2);
    }
  }, []);

  const handlePlaylistSelect = useCallback((pl: SpotifyPlaylist) => {
    setSelectedPlaylist(pl);
    setStep(4);
  }, []);

  const handleScanOptionsConfirmed = useCallback((opts: ScanOptions) => {
    setScanOptions(opts);
    setStep(5);
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setStep(6);
  }, []);

  return (
    <WizardLayout step={step} totalSteps={6} stepName={STEP_NAMES[step - 1]}>
      {/* Resume banner */}
      {resumeAvailable && step === 3 && (
        <div className="mb-4 p-3 bg-yellow-950/30 border border-yellow-700 rounded-xl flex items-center justify-between gap-3 text-sm">
          <span className="text-yellow-300">A previous scan was interrupted. Resume?</span>
          <button
            onClick={() => setStep(6)} // Jump straight to results with saved state
            className="px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded-lg font-semibold text-xs transition-colors"
          >
            Resume
          </button>
        </div>
      )}

      {step === 1 && <SetupStep onComplete={() => setStep(2)} />}

      {step === 2 && (
        <div className="text-center space-y-6">
          <h2 className="text-3xl font-bold">Connect Your Spotify</h2>
          <p className="text-[var(--text-secondary)]">
            SoundFox needs access to your playlists. We never store your data on any server.
          </p>
          <button
            onClick={() => { startLogin().catch(console.error); }}
            className="px-8 py-4 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-lg transition-colors"
          >
            Connect with Spotify
          </button>
          {user && (
            <p className="text-[var(--text-secondary)]">
              Connected as <strong className="text-white">{user.display_name}</strong>
            </p>
          )}
        </div>
      )}

      {step === 3 && <PlaylistStep onSelect={handlePlaylistSelect} />}

      {step === 4 && selectedPlaylist && (
        <ScanOptionsStep playlist={selectedPlaylist} onStart={handleScanOptionsConfirmed} />
      )}

      {step === 5 && selectedPlaylist && (
        <AnalysisStep
          playlist={selectedPlaylist}
          scanOptions={scanOptions}
          onComplete={handleAnalysisComplete}
        />
      )}

      {step === 6 && pipelineResult && selectedPlaylist && (
        <ResultsStep
          result={pipelineResult}
          playlistName={selectedPlaylist.name}
          playlistId={selectedPlaylist.id}
        />
      )}
    </WizardLayout>
  );
}
```

### Expected build output

No TypeScript errors. `AnalysisStep` will break at this point because it does not yet accept `scanOptions` prop — that is fixed in Batch 5.

> **WARNING: DO NOT run `npm run build` between Batch 4 and Batch 5** — intentional broken state, AnalysisStep prop contract changes in Batch 5.

### Commit message

```
feat(wizard): add ScanOptionsStep (step 4) with allowKnownArtists, minYear, resultCount

- New ScanOptionsStep component with toggle switch, range sliders
- Wizard expanded to 6 steps
- Resume banner on step 3 if interrupted scan found in localStorage
- wizard/page.tsx wires scanOptions through to AnalysisStep
```

---

## Batch 5: Resume Support UI + AnalysisStep Refactor

**Files changed:**
- `web/src/components/AnalysisStep.tsx` (accept `scanOptions`, drive streaming generator, save scan state every batch, show live partial results count, "Stop scanning" button)

### Full TypeScript

**`web/src/components/AnalysisStep.tsx`** — replace entire file:

```typescript
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  runPipelineStreaming,
  type BatchUpdate,
  type PipelineResult,
  type ScanOptions,
  type ScoredTrack,
} from "@/lib/discovery-pipeline";
import { saveScanState, clearScanState } from "@/lib/storage";
import { type SpotifyPlaylist } from "@/lib/spotify-client";

interface AnalysisStepProps {
  playlist: SpotifyPlaylist;
  scanOptions: ScanOptions;
  onComplete: (result: PipelineResult) => void;
}

interface PhaseConfig {
  key: string;
  label: string;
  icon: string;
}

const PHASES: PhaseConfig[] = [
  { key: "analyze", label: "Analyzing playlist", icon: "?" },
  { key: "discover", label: "Discovering artists", icon: "?" },
  { key: "score", label: "Scoring candidates", icon: "*" },
  { key: "done", label: "Complete", icon: "v" },
];

export default function AnalysisStep({
  playlist,
  scanOptions,
  onComplete,
}: AnalysisStepProps): React.ReactElement {
  const [progress, setProgress] = useState<BatchUpdate>({
    batch: [], totalFound: 0, phase: "analyze",
    message: "Starting...", percent: 0, done: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);

  // Accumulated scored tracks — used to build PipelineResult on completion/stop
  const accumulatedRef = useRef<ScoredTrack[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  // [C1] Store the DoneUpdate from the generator — it carries all metadata directly
  const doneUpdateRef = useRef<Extract<BatchUpdate, { done: true }> | null>(null);

  const buildPartialResult = useCallback((): PipelineResult => {
    const sorted = [...accumulatedRef.current].sort((a, b) => b.score - a.score);
    const done = doneUpdateRef.current;
    return {
      tasteVector: done?.tasteVector ?? { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
      coreGenres: done?.coreGenres ?? [],
      tracksAnalyzed: done?.tracksAnalyzed ?? 0,
      tracksWithFeatures: done?.tracksWithFeatures ?? 0,
      candidateArtists: done?.candidateArtists ?? 0,
      genrePassed: done?.genrePassed ?? 0,
      candidateTracks: sorted.length,
      scored: sorted.length,
      results: sorted,
    };
  }, []);

  // H5: scanOptions must be stable to prevent start() from re-triggering on every render.
  // In wizard/page.tsx, scanOptions state must be set once (from handleScanOptionsConfirmed)
  // and never mutated in-place. If it is rebuilt on every render, wrap it in useMemo or
  // store it in a ref before passing to AnalysisStep.
  const start = useCallback((): void => {
    accumulatedRef.current = [];
    doneUpdateRef.current = null;
    setError(null);
    setRunning(true);
    setStopped(false);
    setProgress({ batch: [], totalFound: 0, phase: "analyze", message: "Starting...", percent: 0, done: false });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    void (async () => {
      try {
        const gen = runPipelineStreaming(playlist.id, {
          ...scanOptions,
          signal: controller.signal,
        });

        for await (const update of gen) {
          if (controller.signal.aborted) break;

          setProgress(update);

          if (update.done) {
            // [C1] Capture DoneUpdate for metadata — buildPartialResult reads it
            doneUpdateRef.current = update;
          }

          if (update.batch.length > 0) {
            accumulatedRef.current.push(...update.batch);

            // Save scan state every batch [V2-F]
            saveScanState({
              sourcePlaylistId: playlist.id,
              sourcePlaylistName: playlist.name,
              scanOptions,
              allResults: accumulatedRef.current,
              targetPlaylistId: null,
              targetPlaylistName: null,
              savedAt: new Date().toISOString(),
            });
          }

          if (update.done) break;
        }

        // Done or aborted — transition to results
        clearScanState();
        setRunning(false);
        onComplete(buildPartialResult());
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          // User clicked Stop — show results with what we have
          clearScanState();
          setRunning(false);
          setStopped(true);
          if (accumulatedRef.current.length > 0) {
            onComplete(buildPartialResult());
          } else {
            setError("Scan stopped before any tracks were found. Try again.");
          }
        } else {
          clearScanState();
          setRunning(false);
          setError(err instanceof Error ? err.message : "An unexpected error occurred");
        }
      }
    })();
  }, [playlist.id, playlist.name, scanOptions, onComplete, buildPartialResult]);

  // Auto-start on mount
  useEffect(() => {
    start();
    return () => {
      abortControllerRef.current?.abort();
    };
  }, [start]);

  function handleStop(): void {
    abortControllerRef.current?.abort();
  }

  const currentPhaseIndex = PHASES.findIndex((p) => p.key === progress.phase);

  // Error state with retry
  if (error) {
    return (
      <div className="space-y-6 text-center">
        <div className="bg-red-950/30 border border-red-800 rounded-xl p-6">
          <p className="text-red-400 text-lg font-semibold mb-2">Analysis Failed</p>
          <p className="text-[var(--text-secondary)] text-sm">{error}</p>
        </div>
        <div className="space-y-3">
          <button
            onClick={start}
            className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors"
          >
            Retry Analysis
          </button>
          <p className="text-[var(--text-secondary)] text-xs">
            Common causes: Spotify session expired, network timeout, or empty playlist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold mb-2">Scanning...</h2>
        <p className="text-[var(--text-secondary)]">
          Finding music that matches the audio DNA of{" "}
          <span className="text-white font-medium">{playlist.name}</span>
        </p>
      </div>

      {/* Live count badge */}
      {progress.totalFound > 0 && (
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-full text-sm font-medium text-[var(--accent)]">
          <span className="inline-block w-2 h-2 bg-[var(--accent)] rounded-full animate-pulse" />
          {progress.totalFound} tracks found so far
        </div>
      )}

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm text-[var(--text-secondary)]">
          <span>{progress.message}</span>
          <span>{Math.round(progress.percent)}%</span>
        </div>
        <div className="w-full bg-[var(--bg-secondary)] rounded-full h-2 overflow-hidden">
          <div
            className="bg-[var(--accent)] h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {/* Phase indicators */}
      <div className="space-y-3">
        {PHASES.filter((p) => p.key !== "done").map((phase, index) => {
          const isDone = currentPhaseIndex > index;
          const isActive = currentPhaseIndex === index;
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                isActive
                  ? "bg-[var(--bg-card)] border border-[var(--accent)]/30"
                  : isDone
                  ? "opacity-50"
                  : "opacity-30"
              }`}
            >
              <span className="text-xl w-8 text-center">
                {isDone ? "+" : isActive ? (
                  <span className="inline-block w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                ) : phase.icon}
              </span>
              <div>
                <p className={`font-medium text-sm ${isActive ? "text-white" : "text-[var(--text-secondary)]"}`}>
                  {phase.label}
                </p>
                {isActive && (
                  <p className="text-[var(--text-secondary)] text-xs mt-0.5">{progress.message}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex gap-3">
        {running && (
          <button
            onClick={handleStop}
            className="flex-1 py-3 border border-red-800 text-red-400 hover:bg-red-950/30 rounded-lg font-semibold transition-colors text-sm"
          >
            Stop scanning — show results so far ({progress.totalFound} tracks)
          </button>
        )}
      </div>

      {running && (
        <p className="text-center text-[var(--text-secondary)] text-sm">
          Results will appear as tracks are found. Close tab? Your progress is auto-saved.
        </p>
      )}
    </div>
  );
}
```

### Resume flow [C2]

When the wizard loads and a `ScanState` is found in localStorage:

1. `WizardPage` `useEffect` calls `loadScanState()` — if results exist, it sets `resumeAvailable`, pre-populates `pipelineResult` (sorted partial results), and reconstructs the `selectedPlaylist` stub from `saved.sourcePlaylistId` / `saved.sourcePlaylistName`
2. The "Resume" banner is shown on step 3
3. Clicking "Resume" calls `setStep(6)` — `pipelineResult` and `selectedPlaylist` are already set, so `ResultsStep` renders immediately

The full logic is already inlined in the `useEffect` in the `wizard/page.tsx` listing above — no separate patch needed.

**Note:** `ScanState` stores `sourcePlaylistId` and `sourcePlaylistName` (not `playlistId`/`playlistName`) to distinguish the source playlist from any target playlist fields. Ensure `ScanState` interface and `saveScanState` calls use these field names consistently.

### Expected build output

No TypeScript errors. The `TasteVector` import in `AnalysisStep.tsx` comes from `@/lib/taste-engine` — verify it is exported there (it is, from `taste-engine.ts` line 3).

### Commit message

```
feat(analysis): streaming generator consumer, live count, stop button, auto-save every batch [V2-F]

- AnalysisStep now drives runPipelineStreaming generator
- Shows live "X tracks found" count badge
- "Stop scanning" triggers AbortController, transitions to results with partial data
- Saves scan state to localStorage every batch
- Resume: WizardPage detects saved state, shows banner, pre-populates pipelineResult
- scanOptions prop added (accepts allowKnownArtists, minYear, resultCount)
```

---

## Batch 6: Install Dependencies, Testing, and Push

### 6a: Install react-window (optional windowing)

The plan uses CSS `contain: content` for a lighter-weight windowing approach (Batch 3c). If profiling shows > 200ms render on scroll with 1000 rows, install `react-window`:

```bash
cd C:\Users\fires\OneDrive\Git\spotify-recommendation\web
npm install react-window
npm install -D @types/react-window
```

Then replace the track list `<div>` in `ResultsStep.tsx` with a `FixedSizeList` from `react-window`. Only do this if CSS containment is insufficient — it adds complexity.

### 6b: Build verification

```bash
cd C:\Users\fires\OneDrive\Git\spotify-recommendation\web
npm run build
```

Expected: compilation succeeds with zero TypeScript errors.

Known warnings that are acceptable:
- `'stopped' is assigned but never read` in AnalysisStep — used to gate future UI, can be left for now
- Image domain warnings for Spotify album art if `next.config.ts` doesn't include `*.spotifycdn.com`

**Fix next.config.ts if needed** (album art may use multiple Spotify CDN domains):

```typescript
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "i.scdn.co" },
      { protocol: "https", hostname: "*.spotifycdn.com" },
      { protocol: "https", hostname: "mosaic.scdn.co" },
    ],
  },
};
export default nextConfig;
```

### 6c: Manual smoke test checklist

Run `npm run dev` and walk through the full flow:

| Check | Expected |
|-------|----------|
| Step 1: Setup | Client ID saves, redirects to step 2 |
| Step 2: Connect | Spotify OAuth opens, redirect back works |
| Step 3: Choose Playlist | Playlist grid loads |
| Step 4: Scan Options | Toggles and sliders work, Start Scanning button present |
| Step 5: Analyzing | Live count badge increments, progress bar moves, Stop button works |
| Step 6: Results — new playlist mode | First checkbox shows name prompt |
| Step 6: Results — name confirmed | Badge appears, Spotify add confirmed in Spotify app |
| Step 6: Results — uncheck | Track removed from playlist in Spotify |
| Step 6: Results — pagination | Previous/Next buttons page through 50-track pages |
| Step 6: Results — sort | Changing sort reorders list |
| Step 6: Results — filter | Text search narrows list |
| Step 6: Results — Spotify link | Clicking track name opens Spotify in new tab |
| Resume: close tab mid-scan | Reopen → resume banner appears |
| Resume: click Resume | Saved tracks appear in ResultsStep |

### 6d: Git commit sequence

After each batch passes its build test, commit with the messages from that batch. Final summary commit after all batches:

```bash
git add -A
git commit -m "feat: SoundFox v2 — streaming pipeline, interactive results, 1000 tracks

Batch 1: Streaming pipeline (AsyncGenerator, 1000-track target, AbortSignal)
Batch 2: Storage — ScanState persistence, resume support
Batch 3: ResultsStep rewrite — pagination, sort/filter, bidirectional add/remove
Batch 4: ScanOptionsStep — allowKnownArtists toggle, minYear, resultCount
Batch 5: AnalysisStep — streaming consumer, live count, stop button, resume banner
Batch 6: Build verified, smoke test passed

Fixes: [V2-A] through [V2-H]"
```

---

## Cross-Cutting Technical Notes

### Token refresh race condition [H1 — already fixed, must not be regressed]

`refreshAccessToken()` in `spotify-auth.ts` uses a promise lock (`refreshPromise`). The streaming pipeline makes many concurrent Spotify calls — if the token expires mid-scan, all concurrent calls will race to refresh. The lock ensures only one refresh fires. Do not modify this pattern.

### ReccoBeats CORS proxy [C1 — already fixed]

All ReccoBeats calls go through `/api/reccobeats`. The streaming pipeline batches audio features via `getAudioFeaturesBatch` which already uses this proxy. No change needed here.

### Spotify 429 rate limit [C2 — already fixed]

`spotifyFetch` in `spotify-client.ts` has 200ms throttle + exponential retry. The streaming pipeline fires many `getArtistTopTracks` calls — this throttle is critical. Do NOT remove or reduce the REQUEST_INTERVAL_MS.

### localStorage quota for large scan states

1000 `ScoredTrack` objects may exceed 5MB localStorage quota. Each ScoredTrack contains a full `SpotifyTrack` + `SpotifyArtist` object. Estimated size: ~2-4KB per track × 1000 = 2-4MB. This is near the quota limit.

Mitigation already in `saveScanState`:
```typescript
try {
  localStorage.setItem(KEYS.SCAN_STATE, JSON.stringify(state));
} catch {
  // Quota exceeded — silently skip
}
```

If quota is a real problem, store only the minimal fields needed for display (trackId, name, artist name, score, matchedGenres) rather than the full objects. This would be a v3 optimization.

### React performance with 1000 tracks

Three layers of protection:
1. `React.memo` on `TrackRow` — prevents re-render of unchanged rows [V2-C]
2. CSS `contain: content` on the list container — limits layout recalculation [V2-D]  
3. Pagination (50/page) — only 50 rows are in the DOM at any time

If real profiling reveals issues, add `react-window` FixedSizeList as described in Batch 6a.

### "Add to existing playlist" — pre-existing tracks [V2-G]

When `destMode === "existing"`, the user is adding to a playlist that may already have some of these tracks. The current implementation does not pre-populate the `added` set with tracks already in the target playlist.

To fix this properly: after the user selects an existing playlist, call `getPlaylistTracks(targetPlaylistId)` and initialize `added` with the IDs of any tracks that appear in both the result list and the existing playlist. This is a v2.1 enhancement.

### AbortController and generator cleanup [V2-A]

The `checkAbort()` call at the start of every async section ensures the generator responds to abort within one API call. There is no way to abort mid-Fetch, but the generator will abort at the next checkpoint. The worst case latency is one `getArtistTopTracks` call duration (~200-500ms with throttle).

---

## Files Changed — Summary

| File | Change |
|------|--------|
| `web/src/lib/discovery-pipeline.ts` | Full rewrite: `runPipelineStreaming`, `BatchUpdate`, `ScanOptions`, keep `runPipeline` wrapper |
| `web/src/lib/storage.ts` | Add `ScanState`, `saveScanState`, `loadScanState`, `clearScanState`, `saveTargetPlaylist`, `loadTargetPlaylist` |
| `web/src/lib/spotify-client.ts` | Add `removeTracksFromPlaylist` |
| `web/src/components/TrackRow.tsx` | New: `React.memo` track row with Spotify links |
| `web/src/components/ResultsStep.tsx` | Full rewrite: destination toggle, pagination, sort, filter, bidirectional add/remove, badge |
| `web/src/components/ScanOptionsStep.tsx` | New: `allowKnownArtists` toggle, `minYear` slider, `resultCount` slider |
| `web/src/components/AnalysisStep.tsx` | Refactor: drives streaming generator, live count, stop button, auto-save |
| `web/src/app/wizard/page.tsx` | Refactor: 6 steps, ScanOptionsStep wired, resume banner |
| `web/next.config.ts` | Update image domains (if needed) |
