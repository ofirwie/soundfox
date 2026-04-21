"use client";

import { getAudioFeaturesBatch, type AudioFeatures } from "../reccobeats";
import { scoreCandidate, scoreCandidateClustered, type TasteVector, type TasteClusters } from "../taste-engine";
import { getArtistTopTracks, type SpotifyTrack, type SpotifyArtist } from "../spotify-client";
import { buildDedupKey, dedupCandidates } from "../dedup";
import { buildWhyBreakdown } from "../scoring";
import type { BatchUpdate, ScoredTrack } from "../discovery-pipeline";
import type { BlacklistEntry } from "../profile";

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

// Deep sampling: score top-N per artist, keep the best-fitting one
const DEEP_SAMPLE_TOP_N = 5;

export interface MergeAndEmitOptions {
  genrePassed: SpotifyArtist[];
  tasteVector: TasteVector;
  tasteClusters?: TasteClusters;
  coreGenreSet: Set<string>;
  existingTrackIds: Set<string>;
  resultCount: number;
  minYear: number;
  qualityThreshold?: number;
  genreWeights?: Record<string, number>;
  signal?: AbortSignal;
  blacklist?: BlacklistEntry;
}

/**
 * Phase 6: iterate artists, get top track, score, yield batches.
 * Yields BatchUpdate (done: false) per chunk, then final (done: true).
 */
export async function* mergeAndEmit(
  opts: MergeAndEmitOptions,
  pipelineMeta: {
    tasteVector: TasteVector;
    tasteClusters?: TasteClusters;
    coreGenres: string[];
    tracksAnalyzed: number;
    tracksWithFeatures: number;
    candidateArtists: number;
    genrePassed: number;
  },
): AsyncGenerator<BatchUpdate> {
  const {
    genrePassed, tasteVector, tasteClusters, coreGenreSet, existingTrackIds,
    resultCount, minYear, qualityThreshold, genreWeights, signal,
  } = opts;
  const blacklistedTrackIds = new Set(opts.blacklist?.trackIds ?? []);

  // Persistent dedup state across all chunks (fix-M5)
  const emittedIds = new Set<string>();
  const emittedKeys = new Set<string>();

  const shuffled = [...genrePassed].sort(() => Math.random() - 0.5);
  const SCORE_CHUNK = 50;
  let totalScored = 0;
  let candidateTracks = 0;

  for (let chunkStart = 0; chunkStart < shuffled.length; chunkStart += SCORE_CHUNK) {
    if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
    if (totalScored >= resultCount) break;

    const chunk = shuffled.slice(chunkStart, chunkStart + SCORE_CHUNK);

    // Deep sampling: collect up to DEEP_SAMPLE_TOP_N valid tracks per artist
    // so we can score all of them and keep the best-fitting one (Phase 5)
    const deepSampleChunk: Array<{ track: SpotifyTrack; artist: SpotifyArtist }> = [];
    const artistToTrackIds = new Map<string, string[]>();

    for (const artist of chunk) {
      if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
      try {
        const topTracks = await getArtistTopTracks(artist.id);
        const validTracks: SpotifyTrack[] = [];
        for (const track of topTracks) {
          if (existingTrackIds.has(track.id)) continue;
          if (emittedIds.has(track.id)) continue;
          const dk = buildDedupKey(artist.name, track.name);
          if (emittedKeys.has(dk)) continue;
          if (blacklistedTrackIds.has(track.id)) {
            void fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "blacklist_skip", reason: "track", id: track.id }) }).catch(() => {});
            continue;
          }
          if (!isLatinName(track.name)) continue;
          if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
          const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
          if (year < minYear) continue;
          validTracks.push(track);
          if (validTracks.length >= DEEP_SAMPLE_TOP_N) break;
        }
        for (const track of validTracks) {
          deepSampleChunk.push({ track, artist });
          artistToTrackIds.set(artist.id, [...(artistToTrackIds.get(artist.id) ?? []), track.id]);
        }
      } catch { continue; }
    }

    if (deepSampleChunk.length === 0) continue;

    const candidateIds = deepSampleChunk.map((c) => c.track.id);
    let chunkFeatures: Map<string, AudioFeatures>;
    try {
      chunkFeatures = await getAudioFeaturesBatch(candidateIds);
    } catch {
      continue;
    }
    if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

    // Score all candidates, then pick the best-scoring track per artist
    type Scored = { track: SpotifyTrack; artist: SpotifyArtist; score: number; clusterId?: number; clusterDistance?: number };
    const scoredByArtist = new Map<string, Scored>();
    for (const { track, artist } of deepSampleChunk) {
      const feats = chunkFeatures.get(track.id);
      if (!feats) continue;
      let score: number;
      let clusterId: number | undefined;
      let clusterDistance: number | undefined;
      if (tasteClusters) {
        const r = scoreCandidateClustered(feats, tasteClusters);
        score = r.score;
        clusterId = r.clusterId;
        clusterDistance = r.distance;
      } else {
        score = scoreCandidate(feats, tasteVector);
      }
      const prev = scoredByArtist.get(artist.id);
      if (!prev || score > prev.score) {
        scoredByArtist.set(artist.id, { track, artist, score, clusterId, clusterDistance });
      }
    }

    const batchScoredRaw: ScoredTrack[] = [];
    for (let { track, artist, score, clusterId, clusterDistance } of scoredByArtist.values()) {
      // Phase 8: apply genre weights from rejection/acceptance history
      if (genreWeights) {
        const artistGenres = artist.genres;
        if (artistGenres.length > 0) {
          const weights = artistGenres.map((g) => genreWeights[g] ?? 1.0);
          const avgWeight = weights.reduce((a, b) => a + b, 0) / weights.length;
          score = score * avgWeight;
        }
      }
      if (qualityThreshold !== undefined && score < qualityThreshold) continue;
      const matchedGenres = artist.genres.filter((g) => coreGenreSet.has(g));
      const feats = chunkFeatures.get(track.id);
      const breakdown = feats ? buildWhyBreakdown({
        score, features: feats, clusters: tasteClusters, clusterId, clusterDistance,
        tasteVector, matchedGenres, coreGenreCount: coreGenreSet.size,
        sources: ["spotify"],
      }) : undefined;
      batchScoredRaw.push({ track, score, artist, matchedGenres, sourceTags: ["spotify"], clusterId, clusterDistance, breakdown });
    }

    // Intra-batch dedup (same source returns same track twice on one page)
    const batchScored = dedupCandidates(batchScoredRaw);

    // Register emitted keys so future chunks skip these tracks
    for (const scored of batchScored) {
      emittedIds.add(scored.track.id);
      emittedKeys.add(buildDedupKey(scored.artist.name, scored.track.name));
    }

    batchScored.sort((a, b) => b.score - a.score);
    candidateTracks += batchScored.length;
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

    await new Promise((r) => setTimeout(r, 0));
  }

  yield {
    batch: [],
    totalFound: totalScored,
    phase: "done",
    message: `Complete! Found ${totalScored} tracks.`,
    percent: 100,
    done: true,
    ...pipelineMeta,
    qualityThresholdApplied: qualityThreshold,
    candidateTracks,
    scored: candidateTracks,
  };
}
