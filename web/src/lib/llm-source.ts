"use client";

import { searchArtists, getArtistTopTracks, type SpotifyTrack, type SpotifyArtist } from "./spotify-client";
import type { AudioFeatures } from "./reccobeats";

export interface Intent {
  purpose: string;
  audioConstraints: {
    tempoMin?: number;
    tempoMax?: number;
    energyMin?: number;
    energyMax?: number;
    valenceMin?: number;
    valenceMax?: number;
    popularityHint?: "low" | "mid" | "high";
  };
  genres: { include: string[]; exclude: string[] };
  era?: string | null;
  requirements: string[];
  allowKnownArtists: boolean;
  qualityThreshold: number;
  notes: string;
}

export interface LLMRecommendation {
  artist: string;
  track: string;
  why: string;
  confidence: number;
}

export interface ResolvedLLMTrack {
  track: SpotifyTrack;
  artist: SpotifyArtist;
  why: string;
  confidence: number;
}

// Call our /api/intent route (server-side Gemini)
export async function parseIntentViaLLM(
  freeText: string,
  playlistContext: { name: string; topArtists: string[]; topGenres: string[]; trackCount: number },
): Promise<Intent | null> {
  try {
    const res = await fetch("/api/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freeText, playlistContext }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.intent ?? null;
  } catch {
    return null;
  }
}

// Call our /api/llm-recommend route (server-side Gemini)
export async function getLLMRecommendations(params: {
  intent: Intent;
  tasteVector: Partial<AudioFeatures>;
  topArtists: string[];
  sampleTracks: Array<{ name: string; artist: string }>;
  count?: number;
  excludeArtists?: string[];
}): Promise<LLMRecommendation[]> {
  try {
    const res = await fetch("/api/llm-recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: params.intent,
        tasteVector: params.tasteVector,
        topArtists: params.topArtists,
        sampleTracks: params.sampleTracks ?? [],
        count: params.count ?? 40,
        excludeArtists: params.excludeArtists ?? [],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.recommendations ?? [];
  } catch {
    return [];
  }
}

// Resolve LLM "artist + track name" recommendations to actual Spotify tracks via search
export async function resolveLLMRecommendations(
  recs: LLMRecommendation[],
  onProgress?: (done: number, total: number) => void,
): Promise<ResolvedLLMTrack[]> {
  const resolved: ResolvedLLMTrack[] = [];
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    try {
      // Search for this artist on Spotify
      const artists = await searchArtists(rec.artist, 0);
      const matchedArtist = artists.find(
        (a) => a.name.toLowerCase() === rec.artist.toLowerCase(),
      ) ?? artists[0];
      if (!matchedArtist) continue;

      // Get their top tracks, find matching track name
      const topTracks = await getArtistTopTracks(matchedArtist.id);
      const matchedTrack = topTracks.find(
        (t) => t.name.toLowerCase().includes(rec.track.toLowerCase()) ||
               rec.track.toLowerCase().includes(t.name.toLowerCase()),
      );
      if (!matchedTrack) continue;

      resolved.push({
        track: matchedTrack,
        artist: matchedArtist,
        why: rec.why,
        confidence: rec.confidence,
      });
    } catch {
      // Skip resolution failures
    }
    onProgress?.(i + 1, recs.length);
  }
  return resolved;
}
