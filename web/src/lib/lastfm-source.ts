"use client";

import { getLastfmSimilarArtists } from "./lastfm";
import { searchArtists, getArtistTopTracks, type SpotifyArtist, type SpotifyTrack } from "./spotify-client";
import { buildDedupKey } from "./dedup";
import type { Candidate } from "./pipeline/types";

// Budget per plan Task 7.2: 5 seed artists × 10 similar = 50 similar, top-3 tracks = 150 candidates
const SEED_ARTIST_COUNT = 5;
const SIMILAR_PER_ARTIST = 10;
const DEEP_SAMPLE_TOP_N = 3;

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

export async function* buildLastfmCandidates(args: {
  topArtistNames: string[];
  existingTrackIds: Set<string>;
  allArtistIds: Set<string>;
  blacklistArtistNames: string[];
  blacklistArtistIds: string[];
  blacklistTrackIds: string[];
  minYear: number;
  signal?: AbortSignal;
}): AsyncGenerator<Candidate> {
  const {
    topArtistNames, existingTrackIds, allArtistIds,
    blacklistArtistNames, blacklistArtistIds, blacklistTrackIds, minYear, signal,
  } = args;

  const blacklistArtistNameSet = new Set(blacklistArtistNames.map((n) => n.toLowerCase()));
  const blacklistArtistIdSet = new Set(blacklistArtistIds);
  const blacklistTrackIdSet = new Set(blacklistTrackIds);
  const emittedKeys = new Set<string>();

  const seedArtists = topArtistNames.slice(0, SEED_ARTIST_COUNT);

  for (const seedArtist of seedArtists) {
    if (signal?.aborted) return;

    let similar: Array<{ name: string; match: number }>;
    try {
      similar = await getLastfmSimilarArtists(seedArtist, SIMILAR_PER_ARTIST);
    } catch {
      continue;
    }

    for (const { name: similarName, match } of similar) {
      if (signal?.aborted) return;
      if (!isLatinName(similarName)) continue;
      if (blacklistArtistNameSet.has(similarName.toLowerCase())) continue;

      // Resolve to Spotify artist
      let spotifyArtist: SpotifyArtist | null = null;
      try {
        const results = await searchArtists(similarName, 1);
        if (results.length === 0) continue;
        spotifyArtist = results[0];
      } catch {
        continue;
      }

      if (!spotifyArtist) continue;
      if (allArtistIds.has(spotifyArtist.id)) continue; // already in playlist
      if (blacklistArtistIdSet.has(spotifyArtist.id)) continue;

      // Deep sample top-3 tracks
      let topTracks: SpotifyTrack[] = [];
      try {
        topTracks = await getArtistTopTracks(spotifyArtist.id);
      } catch {
        continue;
      }

      let emittedForArtist = 0;
      for (const track of topTracks) {
        if (emittedForArtist >= DEEP_SAMPLE_TOP_N) break;
        if (existingTrackIds.has(track.id)) continue;
        if (blacklistTrackIdSet.has(track.id)) continue;
        if (!isLatinName(track.name)) continue;
        if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
        const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
        if (year < minYear) continue;
        const dk = buildDedupKey(spotifyArtist.name, track.name);
        if (emittedKeys.has(dk)) continue;
        emittedKeys.add(dk);

        emittedForArtist++;
        yield {
          track,
          artist: spotifyArtist,
          sourceTags: ["lastfm"],
          matchedGenres: [],
          llmWhy: `Last.fm similarity ${match.toFixed(2)} to ${seedArtist}`,
        };
      }
    }
  }
}
