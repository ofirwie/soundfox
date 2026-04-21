"use client";

import { getAudioFeaturesBatch, type AudioFeatures } from "../reccobeats";
import { buildTasteVector, type TasteVector } from "../taste-engine";
import { getArtists, type SpotifyTrack } from "../spotify-client";

export type { AudioFeatures, TasteVector };

/** Yield to event loop so the browser doesn't freeze during heavy loops */
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export async function buildGenreProfile(
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

export async function buildSourceTasteVector(
  trackIds: string[],
): Promise<{ features: Map<string, AudioFeatures>; tasteVector: TasteVector }> {
  const features = await getAudioFeaturesBatch(trackIds);
  const tasteVector = buildTasteVector(features);
  return { features, tasteVector };
}
