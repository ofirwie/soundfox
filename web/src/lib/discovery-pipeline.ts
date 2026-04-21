"use client";

import { getPlaylistTracksDetailed } from "./spotify-client";
import { buildGenreProfile, buildSourceTasteVector } from "./pipeline/build-source-taste";
import { buildSpotifyCandidates } from "./pipeline/source-spotify";
import { mergeAndEmit } from "./pipeline/merge-and-emit";
import type {
  BatchUpdate, ScanOptions, ScoredTrack, PipelineResult, PipelineProgress,
} from "./pipeline/types";

// Re-export all public types — existing callers' imports stay unchanged
export type { BatchUpdate, ScanOptions, ScoredTrack, PipelineResult, PipelineProgress };

async function debugLog(data: unknown): Promise<void> {
  try {
    await fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  } catch { /* logging must never break the pipeline */ }
}

export async function* runPipelineStreaming(
  playlistId: string,
  options: ScanOptions = {},
): AsyncGenerator<BatchUpdate> {
  const { resultCount = 1000, minYear = 2000, allowKnownArtists = false, signal, blacklist } = options;

  yield { batch: [], totalFound: 0, phase: "analyze", message: "Loading playlist tracks...", percent: 2, done: false };
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  await debugLog({ phase: "BEFORE_getPlaylistTracksDetailed", playlistId });
  const detail = await getPlaylistTracksDetailed(playlistId);
  await debugLog({ phase: "AFTER_getPlaylistTracksDetailed", rawItemCount: detail.rawItemCount, tracksCount: detail.tracks.length });
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  const tracks = detail.tracks;
  const trackIds = tracks.map((t) => t.id).filter(Boolean);
  const existingTrackIds = new Set(trackIds);

  if (tracks.length === 0 && detail.rawItemCount > 0) {
    const reasons = [];
    if (detail.localFileCount > 0) reasons.push(`${detail.localFileCount} local files`);
    if (detail.episodeCount > 0) reasons.push(`${detail.episodeCount} podcast episodes`);
    if (detail.unavailableCount > 0) reasons.push(`${detail.unavailableCount} unavailable tracks`);
    throw new Error(`Playlist has ${detail.rawItemCount} items but none can be analyzed: ${reasons.join(", ")}.`);
  }

  yield { batch: [], totalFound: 0, phase: "analyze", message: "Analyzing genre DNA...", percent: 5, done: false };
  let lastGenreMsg = "Analyzing genre DNA...";
  const { coreGenres, searchTerms, allArtistIds } = await buildGenreProfile(tracks, (msg) => { lastGenreMsg = msg; });
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
  const coreGenreSet = new Set(coreGenres);

  yield { batch: [], totalFound: 0, phase: "analyze", message: lastGenreMsg, percent: 10, done: false };
  yield { batch: [], totalFound: 0, phase: "analyze", message: "Analyzing audio DNA...", percent: 12, done: false };

  const { features, tasteVector } = await buildSourceTasteVector(trackIds);
  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  await debugLog({ phase: "audio_features", requestedTrackIds: trackIds.length, receivedFeatures: features.size });
  yield { batch: [], totalFound: 0, phase: "analyze", message: `Audio DNA ready — ${features.size} tracks with features`, percent: 18, done: false };

  const genrePassedArtists = await buildSpotifyCandidates({
    searchTerms, coreGenreSet, allArtistIds, allowKnownArtists, signal, blacklist,
    onBatchYield: (u) => { void u; },
  });
  await debugLog({ phase: "AFTER_genre_gate", genrePassed: genrePassedArtists.length });

  yield { batch: [], totalFound: 0, phase: "discover", message: `${genrePassedArtists.length} artists passed genre gate`, percent: 40, done: false };

  yield* mergeAndEmit(
    { genrePassed: genrePassedArtists, tasteVector, coreGenreSet, existingTrackIds, resultCount, minYear, signal, blacklist },
    { tasteVector, coreGenres, tracksAnalyzed: trackIds.length, tracksWithFeatures: features.size, candidateArtists: genrePassedArtists.length, genrePassed: genrePassedArtists.length },
  );
}

// Backward-compat wrapper — kept for AnalysisStep v1 compatibility, will be removed in v3
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
