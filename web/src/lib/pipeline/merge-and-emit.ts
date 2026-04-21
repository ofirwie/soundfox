"use client";

import { getAudioFeaturesBatch, type AudioFeatures } from "../reccobeats";
import { scoreCandidate, type TasteVector } from "../taste-engine";
import { getArtistTopTracks, type SpotifyTrack, type SpotifyArtist } from "../spotify-client";
import type { BatchUpdate, ScoredTrack } from "../discovery-pipeline";

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

export interface MergeAndEmitOptions {
  genrePassed: SpotifyArtist[];
  tasteVector: TasteVector;
  coreGenreSet: Set<string>;
  existingTrackIds: Set<string>;
  resultCount: number;
  minYear: number;
  signal?: AbortSignal;
}

/**
 * Phase 6: iterate artists, get top track, score, yield batches.
 * Yields BatchUpdate (done: false) per chunk, then final (done: true).
 */
export async function* mergeAndEmit(
  opts: MergeAndEmitOptions,
  pipelineMeta: {
    tasteVector: TasteVector;
    coreGenres: string[];
    tracksAnalyzed: number;
    tracksWithFeatures: number;
    candidateArtists: number;
    genrePassed: number;
  },
): AsyncGenerator<BatchUpdate> {
  const {
    genrePassed, tasteVector, coreGenreSet, existingTrackIds,
    resultCount, minYear, signal,
  } = opts;

  const shuffled = [...genrePassed].sort(() => Math.random() - 0.5);
  const SCORE_CHUNK = 50;
  let totalScored = 0;
  let candidateTracks = 0;

  for (let chunkStart = 0; chunkStart < shuffled.length; chunkStart += SCORE_CHUNK) {
    if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
    if (totalScored >= resultCount) break;

    const chunk = shuffled.slice(chunkStart, chunkStart + SCORE_CHUNK);
    const candidateChunk: Array<{ track: SpotifyTrack; artist: SpotifyArtist }> = [];

    for (const artist of chunk) {
      if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
      try {
        const topTracks = await getArtistTopTracks(artist.id);
        for (const track of topTracks.sort((a, b) => b.popularity - a.popularity)) {
          if (existingTrackIds.has(track.id)) continue;
          if (!isLatinName(track.name)) continue;
          if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
          const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
          if (year < minYear) continue;
          candidateChunk.push({ track, artist });
          break;
        }
      } catch { continue; }
    }

    if (candidateChunk.length === 0) continue;

    const candidateIds = candidateChunk.map((c) => c.track.id);
    let chunkFeatures: Map<string, AudioFeatures>;
    try {
      chunkFeatures = await getAudioFeaturesBatch(candidateIds);
    } catch {
      continue;
    }
    if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

    const batchScored: ScoredTrack[] = [];
    for (const { track, artist } of candidateChunk) {
      const feats = chunkFeatures.get(track.id);
      if (!feats) continue;
      const score = scoreCandidate(feats, tasteVector);
      const matchedGenres = artist.genres.filter((g) => coreGenreSet.has(g));
      batchScored.push({ track, score, artist, matchedGenres });
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
    candidateTracks,
    scored: candidateTracks,
  };
}
