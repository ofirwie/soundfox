"use client";

import { searchArtists, type SpotifyArtist } from "../spotify-client";
import type { BatchUpdate } from "../discovery-pipeline";

const UNIVERSAL_BANNED = new Set([
  "children's music", "kids", "lullaby", "nursery",
  "asmr", "meditation", "sleep", "white noise",
  "comedy", "stand-up comedy", "spoken word",
]);

const MAX_OFFSET_PER_TERM = 950; // Spotify search hard limit: offset + limit ≤ 1000

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

export interface SpotifyCandidateOptions {
  searchTerms: string[];
  coreGenreSet: Set<string>;
  allArtistIds: Set<string>;
  allowKnownArtists: boolean;
  signal?: AbortSignal;
  onBatchYield?: (update: Pick<BatchUpdate & { done: false }, "batch" | "totalFound" | "phase" | "message" | "percent" | "done">) => void;
}

/**
 * Searches Spotify by genre terms, applies genre+follower gate, returns qualifying artists.
 * Phase 4 + 5 of the original pipeline.
 */
export async function buildSpotifyCandidates(
  opts: SpotifyCandidateOptions,
): Promise<SpotifyArtist[]> {
  const { searchTerms, coreGenreSet, allArtistIds, allowKnownArtists, signal } = opts;
  const MIN_FOLLOWERS = 5_000;
  const MAX_FOLLOWERS = 500_000;

  const candidateArtists = new Map<string, SpotifyArtist>();

  for (let ti = 0; ti < searchTerms.length; ti++) {
    const term = searchTerms[ti];
    for (let offset = 0; offset <= MAX_OFFSET_PER_TERM; offset += 50) {
      if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
      try {
        const artists = await searchArtists(term, offset);
        if (artists.length === 0) break;

        for (const artist of artists) {
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
    opts.onBatchYield?.({
      batch: [], totalFound: 0, phase: "discover",
      message: `Searched "${term}" (${candidateArtists.size} candidates)`,
      percent: discoverPercent, done: false,
    });
  }

  if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");

  // Phase 5: genre + follower gate
  const genrePassed: SpotifyArtist[] = [];
  let i = 0;
  for (const artist of candidateArtists.values()) {
    i++;
    const followers = artist.followers.total;
    if (followers < MIN_FOLLOWERS || followers > MAX_FOLLOWERS) continue;

    const genres = new Set(artist.genres);
    const coreOverlap = [...genres].filter((g) => coreGenreSet.has(g));
    if (coreOverlap.length < 2) continue;
    if ([...genres].every((g) => UNIVERSAL_BANNED.has(g))) continue;

    genrePassed.push(artist);
    if (i % 200 === 0) await new Promise((r) => setTimeout(r, 0));
    if (signal?.aborted) throw new DOMException("Pipeline aborted", "AbortError");
  }

  return genrePassed;
}
