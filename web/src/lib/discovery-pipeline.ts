"use client";

import { getPlaylistTracksDetailed } from "./spotify-client";
import { buildGenreProfile, buildSourceTasteVector } from "./pipeline/build-source-taste";
import { buildSpotifyCandidates } from "./pipeline/source-spotify";
import { mergeAndEmit } from "./pipeline/merge-and-emit";
import { buildLLMCandidates } from "./llm-source";
import { buildLastfmCandidates } from "./lastfm-source";
import { mergeAsyncGenerators } from "./merge-generators";
import { buildTasteClusters } from "./clustering";
import { getAudioFeaturesBatch } from "./reccobeats";
import { scoreCandidate, scoreCandidateClustered } from "./taste-engine";
import { buildWhyBreakdown } from "./scoring";
import type { Candidate } from "./pipeline/types";
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
  const { resultCount = 1000, minYear = 2000, allowKnownArtists = false, signal, blacklist, genreWeights, refinedClusters } = options;

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

  // Phase 8: prefer refined clusters from accepted tracks; fall back to auto-built clusters
  let tasteClusters = refinedClusters;
  const refinedActive = !!refinedClusters;
  if (!tasteClusters) {
    try {
      if (features.size >= 2) {
        tasteClusters = buildTasteClusters(features, { autoK: true });
      }
    } catch {
      // Fall back to legacy single-vector scoring if clustering fails
    }
  }
  await debugLog({ phase: "clusters_built", k: tasteClusters?.k ?? 0, refinedActive, labels: tasteClusters?.clusters.map((c) => c.label) ?? [] });

  const genrePassedArtists = await buildSpotifyCandidates({
    searchTerms, coreGenreSet, allArtistIds, allowKnownArtists, signal, blacklist,
    onBatchYield: (u) => { void u; },
  });
  await debugLog({ phase: "AFTER_genre_gate", genrePassed: genrePassedArtists.length });

  yield { batch: [], totalFound: 0, phase: "discover", message: `${genrePassedArtists.length} artists passed genre gate`, percent: 40, done: false };

  // Start LLM + Last.fm sources concurrently via mergeAsyncGenerators — fill a shared buffer.
  const scanId = `scan_${Date.now()}`;
  const nonSpotifyBuffer: ScoredTrack[] = [];

  const topArtistNames = tracks.flatMap((t) => t.artists.map((a) => a.name)).slice(0, 20);

  async function scoreCandidate_andPush(candidate: Candidate): Promise<void> {
    const feats = await getAudioFeaturesBatch([candidate.track.id]);
    const f = feats.get(candidate.track.id);
    if (!f) return;
    let score: number;
    let clusterId: number | undefined;
    let clusterDistance: number | undefined;
    if (tasteClusters) {
      const r = scoreCandidateClustered(f, tasteClusters);
      score = r.score; clusterId = r.clusterId; clusterDistance = r.distance;
    } else {
      score = scoreCandidate(f, tasteVector);
    }
    const breakdown = buildWhyBreakdown({
      score, features: f, clusters: tasteClusters, clusterId, clusterDistance,
      tasteVector, matchedGenres: candidate.matchedGenres, coreGenreCount: coreGenreSet.size,
      llmWhy: candidate.llmWhy, sources: candidate.sourceTags,
    });
    nonSpotifyBuffer.push({
      track: candidate.track, score, artist: candidate.artist,
      matchedGenres: candidate.matchedGenres, sourceTags: candidate.sourceTags,
      llmWhy: candidate.llmWhy, clusterId, clusterDistance, breakdown,
    });
  }

  const nonSpotifySources: AsyncGenerator<Candidate>[] = [];

  if (options.intent) {
    const sampleTracks = tracks.slice(0, 20).map((t) => ({
      name: t.name, artist: t.artists[0]?.name ?? "",
    }));
    nonSpotifySources.push(buildLLMCandidates({
      intent: options.intent,
      tasteVector: tasteVector.mean,
      topArtistNames,
      sampleTracks,
      blacklistArtistNames: blacklist?.artistNames ?? [],
      playlistId,
      scanId,
    }));
  }

  nonSpotifySources.push(buildLastfmCandidates({
    topArtistNames,
    existingTrackIds,
    allArtistIds,
    blacklistArtistNames: blacklist?.artistNames ?? [],
    blacklistArtistIds: blacklist?.artistIds ?? [],
    blacklistTrackIds: blacklist?.trackIds ?? [],
    minYear,
    signal,
  }));

  const nonSpotifyCollectPromise = (async () => {
    if (nonSpotifySources.length === 0) return;
    try {
      for await (const candidate of mergeAsyncGenerators<Candidate>(
        nonSpotifySources,
        (i, err) => void debugLog({ event: "source_error", scanId, sourceIndex: i + 1, err: String(err) }),
      )) {
        if (signal?.aborted) return;
        try { await scoreCandidate_andPush(candidate); } catch { /* skip */ }
      }
    } catch (err) {
      void debugLog({ event: "source_error", scanId, sourceIndex: "non-spotify", err: String(err) });
    }
  })();

  // Stream Spotify results, injecting buffered LLM + Last.fm results into each batch
  for await (const update of mergeAndEmit(
    { genrePassed: genrePassedArtists, tasteVector, tasteClusters, coreGenreSet, existingTrackIds, resultCount, minYear, qualityThreshold: options.intent?.qualityThreshold, genreWeights, signal, blacklist },
    { tasteVector, tasteClusters, coreGenres, tracksAnalyzed: trackIds.length, tracksWithFeatures: features.size, candidateArtists: genrePassedArtists.length, genrePassed: genrePassedArtists.length },
  )) {
    const drained = nonSpotifyBuffer.splice(0);

    if (update.done) {
      await nonSpotifyCollectPromise;
      const remaining = nonSpotifyBuffer.splice(0);
      const allLLM = [...drained, ...remaining];

      if (allLLM.length > 0) {
        // Emit a non-done batch with LLM results before the done batch
        yield {
          batch: allLLM,
          totalFound: update.totalFound + allLLM.length,
          phase: "score",
          message: `+${allLLM.length} LLM recommendations`,
          percent: 99,
          done: false,
        };
      }

      yield { ...update, totalFound: update.totalFound + allLLM.length } as BatchUpdate;
    } else if (drained.length > 0) {
      yield { ...update, batch: [...update.batch, ...drained], totalFound: update.totalFound + drained.length } as typeof update;
    } else {
      yield update;
    }
  }
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
