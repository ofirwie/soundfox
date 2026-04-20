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
