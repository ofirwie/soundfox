"use client";

export interface LastfmSimilarArtist {
  name: string;
  match: number; // 0-1 similarity score from Last.fm
}

export async function getLastfmSimilarArtists(
  artist: string,
  limit = 10,
): Promise<LastfmSimilarArtist[]> {
  const res = await fetch("/api/lastfm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method: "artist.getSimilar", artist, limit: String(limit) }),
  });

  if (!res.ok) return [];

  const data = await res.json() as {
    similarartists?: { artist?: Array<{ name: string; match: string }> };
    error?: number;
  };

  if (data.error || !data.similarartists?.artist) return [];

  return data.similarartists.artist.map((a) => ({
    name: a.name,
    match: parseFloat(a.match) || 0,
  }));
}
