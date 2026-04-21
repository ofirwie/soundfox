"use client";

import { getPlaylistTracksDetailed } from "./spotify-client";
import { buildGenreProfile, buildSourceTasteVector } from "./pipeline/build-source-taste";
import { buildSpotifyCandidates } from "./pipeline/source-spotify";
import { mergeAndEmit } from "./pipeline/merge-and-emit";
import type { TasteVector } from "./taste-engine";
import type { SpotifyTrack, SpotifyArtist } from "./spotify-client";

// ─── Debug logging ────────────────────────────────────────────────────────────

async function debugLog(data: unknown): Promise<void> {
  try {
    await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch { /* logging must never break the pipeline */ }
}

// ─── Public interfaces (re-exported for backward compat) ─────────────────────

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

export type BatchUpdate =
  | {
      batch: ScoredTrack[];
      totalFound: number;
      phase: string;
      message: string;
      percent: number;
      done: false;
    }
  | {
      batch: [];
      totalFound: number;
      phase: "done";
      message: string;
      percent: 100;
      done: true;
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
  resultCount?: number;
  minYear?: number;
  allowKnownArtists?: boolean;
  signal?: AbortSignal;
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export async function* runPipelineStreaming(
  playlistId: string,
  options: ScanOptions = {},
): AsyncGenerator<BatchUpdate> {
  const { resultCount = 1000, minYear = 2000, allowKnownArtists = false, signal } = options;

  // Phase 1: load source playlist
  yield { batch: [], totalFound: 0, phase: "analyze", message: "Loading playlist tracks...", percent: 2, done: false };
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  await debugLog({ phase: "BEFORE_getPlaylistTracksDetailed", playlistId });
  const detail = await getPlaylistTracksDetailed(playlistId);
  await debugLog({ phase: "AFTER_getPlaylistTracksDetailed", rawItemCount: detail.rawItemCount, tracksCount: detail.tracks.length });
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  const tracks = detail.tracks;
  const trackIds = tracks.map((t) => t.id).filter(Boolean);
  const existingTrackIds = new Set(trackIds);

  await debugLog({ phase: "tracks_loaded", playlistId, rawItemCount: detail.rawItemCount, usableTracks: tracks.length });

  if (tracks.length === 0 && detail.rawItemCount > 0) {
    const reasons = [];
    if (detail.localFileCount > 0) reasons.push(`${detail.localFileCount} local files`);
    if (detail.episodeCount > 0) reasons.push(`${detail.episodeCount} podcast episodes`);
    if (detail.unavailableCount > 0) reasons.push(`${detail.unavailableCount} unavailable tracks`);
    throw new Error(`Playlist has ${detail.rawItemCount} items but none can be analyzed: ${reasons.join(", ")}.`);
  }

  // Phase 2: genre profile (SEAM 1 — build-source-taste)
  yield { batch: [], totalFound: 0, phase: "analyze", message: "Analyzing genre DNA...", percent: 5, done: false };
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  await debugLog({ phase: "BEFORE_buildGenreProfile" });
  let lastGenreMsg = "Analyzing genre DNA...";
  const { coreGenres, searchTerms, allArtistIds } = await buildGenreProfile(tracks, (msg) => { lastGenreMsg = msg; });
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
  const coreGenreSet = new Set(coreGenres);

  await debugLog({ phase: "genre_profile", coreGenres: coreGenres.slice(0, 10), searchTerms });

  yield { batch: [], totalFound: 0, phase: "analyze", message: lastGenreMsg, percent: 10, done: false };

  // Phase 3: audio features (SEAM 1 — build-source-taste)
  yield { batch: [], totalFound: 0, phase: "analyze", message: "Analyzing audio DNA...", percent: 12, done: false };
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  const { features, tasteVector } = await buildSourceTasteVector(trackIds);
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  await debugLog({ phase: "audio_features", requestedTrackIds: trackIds.length, receivedFeatures: features.size, tasteSampleCount: tasteVector.sampleCount });

  yield { batch: [], totalFound: 0, phase: "analyze", message: `Audio DNA ready — ${features.size} tracks with features`, percent: 18, done: false };

  // Phases 4+5: Spotify search + genre gate (SEAM 2 — source-spotify)
  await debugLog({ phase: "BEFORE_search_phase", searchTermsCount: searchTerms.length, searchTerms });

  const genrePassedArtists = await buildSpotifyCandidates({
    searchTerms, coreGenreSet, allArtistIds, allowKnownArtists, signal,
    onBatchYield: (u) => { /* progress already shown in buildSpotifyCandidates */ void u; },
  });

  await debugLog({ phase: "AFTER_genre_gate", genrePassed: genrePassedArtists.length });

  yield { batch: [], totalFound: 0, phase: "discover", message: `${genrePassedArtists.length} artists passed genre gate`, percent: 40, done: false };

  // Phase 6: score + emit (SEAM 3 — merge-and-emit)
  yield* mergeAndEmit(
    { genrePassed: genrePassedArtists, tasteVector, coreGenreSet, existingTrackIds, resultCount, minYear, signal },
    {
      tasteVector, coreGenres,
      tracksAnalyzed: trackIds.length,
      tracksWithFeatures: features.size,
      candidateArtists: genrePassedArtists.length,
      genrePassed: genrePassedArtists.length,
    },
  );
}

// ─── Backward-compat wrapper ──────────────────────────────────────────────────

export async function runPipeline(
  playlistId: string,
  onProgress: (progress: PipelineProgress) => void,
  resultCount: number = 50,
  minYear: number = 2000,
): Promise<PipelineResult> {
  const allResults: ScoredTrack[] = [];
  let doneUpdate: Extract<BatchUpdate, { done: true }> | null = null;

  for await (const update of runPipelineStreaming(playlistId, { resultCount, minYear })) {
    onProgress({ phase: update.phase, message: update.message, percent: update.percent });
    if (update.batch.length > 0) allResults.push(...update.batch);
    if (update.done) doneUpdate = update;
  }

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
