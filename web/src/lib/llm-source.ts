"use client";

import { searchArtists, getArtistTopTracks, type SpotifyTrack, type SpotifyArtist } from "./spotify-client";
import type { AudioFeatures } from "./reccobeats";
import type { Intent, LLMRecommendation } from "./intent-types";
import type { Candidate } from "./pipeline/types";
import { isTrackBlacklisted, isArtistBlacklisted } from "./profile";
export type { Intent, LLMRecommendation };

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
    if (!res.ok) throw new Error(`LLM source error: ${res.status}`);
    const data = await res.json();
    return data.recommendations ?? [];
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("LLM source error")) throw err;
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

// Session-scoped caches: re-use Spotify lookups within one buildLLMCandidates run
type ArtistSearchCache = Map<string, SpotifyArtist | null>;
type TopTracksCache = Map<string, SpotifyTrack[]>;

async function resolveOne(
  rec: LLMRecommendation,
  artistCache: ArtistSearchCache,
  topTracksCache: TopTracksCache,
): Promise<{ track: SpotifyTrack; artist: SpotifyArtist; why: string; confidence: number } | null> {
  const key = rec.artist.toLowerCase();
  let artist = artistCache.get(key);
  if (artist === undefined) {
    const results = await searchArtists(rec.artist, 0);
    artist = results.find((a) => a.name.toLowerCase() === key) ?? results[0] ?? null;
    artistCache.set(key, artist);
  }
  if (!artist) return null;

  let tops = topTracksCache.get(artist.id);
  if (!tops) {
    tops = await getArtistTopTracks(artist.id);
    topTracksCache.set(artist.id, tops);
  }
  const track = tops.find(
    (t) =>
      t.name.toLowerCase().includes(rec.track.toLowerCase()) ||
      rec.track.toLowerCase().includes(t.name.toLowerCase()),
  );
  if (!track) return null;
  return { track, artist, why: rec.why, confidence: rec.confidence };
}

async function* resolveInParallel(
  recs: LLMRecommendation[],
  limit: number,
  artistCache: ArtistSearchCache,
  topTracksCache: TopTracksCache,
): AsyncGenerator<{ track: SpotifyTrack; artist: SpotifyArtist; why: string; confidence: number }> {
  const inflight = new Map<
    number,
    Promise<{ idx: number; resolved: { track: SpotifyTrack; artist: SpotifyArtist; why: string; confidence: number } | null }>
  >();
  let next = 0;
  function launch(idx: number): void {
    const p = resolveOne(recs[idx], artistCache, topTracksCache)
      .then((resolved) => ({ idx, resolved }))
      .catch(() => ({ idx, resolved: null }));
    inflight.set(idx, p);
  }
  while (next < limit && next < recs.length) launch(next++);
  while (inflight.size > 0) {
    const winner = await Promise.race(inflight.values());
    inflight.delete(winner.idx);
    if (winner.resolved) yield winner.resolved;
    if (next < recs.length) launch(next++);
  }
}

export async function* buildLLMCandidates(args: {
  intent: Intent;
  tasteVector: Partial<AudioFeatures>;
  topArtistNames: string[];
  sampleTracks: Array<{ name: string; artist: string }>;
  blacklistArtistNames: string[];
  playlistId: string;
  scanId: string;
}): AsyncGenerator<Candidate> {
  const requested = 40;
  const recs = await getLLMRecommendations({
    intent: args.intent,
    tasteVector: args.tasteVector,
    topArtists: args.topArtistNames,
    sampleTracks: args.sampleTracks,
    excludeArtists: [...args.topArtistNames, ...args.blacklistArtistNames],
    count: requested,
  });

  const artistCache: ArtistSearchCache = new Map();
  const topTracksCache: TopTracksCache = new Map();

  for await (const resolved of resolveInParallel(recs, 5, artistCache, topTracksCache)) {
    if (isTrackBlacklisted(args.playlistId, resolved.track.id)) continue;
    if (isArtistBlacklisted(args.playlistId, resolved.artist.id)) continue;
    yield {
      track: resolved.track,
      artist: resolved.artist,
      sourceTags: ["llm"],
      matchedGenres: [],
      llmWhy: resolved.why,
    };
  }
}
