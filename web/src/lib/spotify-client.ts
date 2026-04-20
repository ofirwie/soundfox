import { getAccessToken } from "./storage";
import { refreshAccessToken } from "./spotify-auth";

const BASE = "https://api.spotify.com/v1";

// [C2 FIX] Throttle: max 5 requests per second
const REQUEST_INTERVAL_MS = 200;
let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// [C2 FIX] Retry with exponential backoff on 429
async function spotifyFetch(path: string, options?: RequestInit, retries: number = 3): Promise<Response> {
  await throttle();

  let token = getAccessToken();
  if (!token) {
    const ok = await refreshAccessToken();
    if (!ok) throw new Error("Not authenticated");
    token = getAccessToken();
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...options?.headers,
  };

  const response = await fetch(`${BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    const ok = await refreshAccessToken();
    if (!ok) throw new Error("Session expired");
    token = getAccessToken();
    return fetch(`${BASE}${path}`, {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${token}` },
    });
  }

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "2", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyFetch(path, options, retries - 1);
  }

  return response;
}

export interface SpotifyUser {
  id: string;
  display_name: string;
  images: Array<{ url: string }> | null;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: Array<{ url: string }> | null;
  tracks: { total: number };
  owner: { display_name: string };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  popularity: number;
  preview_url: string | null;
  album: {
    name: string;
    release_date: string;
    images: Array<{ url: string }> | null;
  };
  artists: Array<{ id: string; name: string }>;
  explicit: boolean;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  followers: { total: number };
  images: Array<{ url: string }> | null;
  popularity: number;
}

export async function getCurrentUser(): Promise<SpotifyUser> {
  const res = await spotifyFetch("/me");
  return res.json();
}

export async function getUserPlaylists(): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const res = await spotifyFetch(url);
    const data = await res.json();
    playlists.push(...data.items);
    url = data.next ? data.next.replace(BASE, "") : "";
  }
  return playlists;
}

export async function getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url = `/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await spotifyFetch(url);
    const data = await res.json();
    for (const item of data.items) {
      if (item.track?.id) tracks.push(item.track);
    }
    url = data.next ? data.next.replace(BASE, "") : "";
  }
  return tracks;
}

export async function getArtists(artistIds: string[]): Promise<SpotifyArtist[]> {
  const results: SpotifyArtist[] = [];
  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    const res = await spotifyFetch(`/artists?ids=${batch.join(",")}`);
    const data = await res.json();
    results.push(...data.artists.filter(Boolean));
  }
  return results;
}

export async function searchArtists(query: string, offset: number = 0): Promise<SpotifyArtist[]> {
  const res = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=50&offset=${offset}&market=US`
  );
  const data = await res.json();
  return data.artists?.items ?? [];
}

export async function getArtistTopTracks(artistId: string): Promise<SpotifyTrack[]> {
  const res = await spotifyFetch(`/artists/${artistId}/top-tracks?market=US`);
  const data = await res.json();
  return data.tracks ?? [];
}

export async function createPlaylist(userId: string, name: string, description: string): Promise<{ id: string }> {
  const res = await spotifyFetch(`/users/${userId}/playlists`, {
    method: "POST",
    body: JSON.stringify({ name, description, public: false }),
  });
  return res.json();
}

export async function addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
  for (let i = 0; i < trackUris.length; i += 100) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
    });
  }
}

/**
 * Remove tracks from a playlist using URI-only deletion. [V2-E, H3]
 *
 * This removes ALL occurrences of each URI in the playlist (Spotify's default
 * behaviour when no `positions` field is provided). This is simpler and safer
 * than snapshot+positions deletion, and sufficient for SoundFox because we only
 * ever add one copy of each track.
 *
 * Batched in groups of 100 (Spotify API limit per request).
 */
export async function removeTracksFromPlaylist(
  playlistId: string,
  trackUris: string[],
): Promise<void> {
  for (let i = 0; i < trackUris.length; i += 100) {
    const batch = trackUris.slice(i, i + 100);
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "DELETE",
      body: JSON.stringify({
        tracks: batch.map((uri) => ({ uri })),
      }),
    });
  }
}
