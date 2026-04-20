"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import Image from "next/image";
import { getUserPlaylists, type SpotifyPlaylist } from "@/lib/spotify-client";
import { getRecentPlaylistIds } from "@/lib/storage";

interface PlaylistStepProps {
  onSelect: (playlist: SpotifyPlaylist) => void;
}

// [M4 FIX] Placeholder when playlist has no cover image
function PlaylistImagePlaceholder(): ReactElement {
  return (
    <div className="w-full aspect-square bg-[var(--bg-secondary)] flex items-center justify-center rounded-md">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="w-12 h-12 text-[var(--text-secondary)]"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
        />
      </svg>
    </div>
  );
}

export default function PlaylistStep({ onSelect }: PlaylistStepProps): ReactElement {
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getUserPlaylists()
      .then((data) => {
        setPlaylists(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load playlists");
        setLoading(false);
      });
  }, []);

  // Sort: recent (last 5 analyzed) first, then rest
  const sorted = useMemo(() => {
    const recentIds = getRecentPlaylistIds();
    const recentSet = new Set(recentIds);
    const recent: SpotifyPlaylist[] = [];
    const rest: SpotifyPlaylist[] = [];
    for (const pl of playlists) {
      if (recentSet.has(pl.id)) recent.push(pl);
      else rest.push(pl);
    }
    // Preserve recent order (newest first)
    recent.sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
    return { recent, rest };
  }, [playlists]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return sorted;
    return {
      recent: sorted.recent.filter((pl) => pl.name.toLowerCase().includes(q)),
      rest: sorted.rest.filter((pl) => pl.name.toLowerCase().includes(q)),
    };
  }, [sorted, search]);

  const totalFiltered = filtered.recent.length + filtered.rest.length;

  if (loading) {
    return (
      <div className="text-center space-y-4">
        <div className="inline-block w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <p className="text-[var(--text-secondary)]">Loading your playlists...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={() => { setError(null); setLoading(true); getUserPlaylists().then(setPlaylists).catch((e: unknown) => setError(e instanceof Error ? e.message : "Error")).finally(() => setLoading(false)); }}
          className="px-6 py-2 bg-[var(--accent)] rounded-lg font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Choose a Playlist</h2>
        <p className="text-[var(--text-secondary)]">
          SoundFox will analyze this playlist&apos;s audio DNA to find matching hidden gems.
        </p>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search playlists..."
        className="w-full px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                   focus:outline-none focus:border-[var(--accent)] text-white placeholder-gray-500"
      />

      {totalFiltered === 0 ? (
        <p className="text-center text-[var(--text-secondary)] py-8">
          {search ? "No playlists match your search." : "No playlists found."}
        </p>
      ) : (
        <div className="space-y-6 max-h-[60vh] overflow-y-auto pr-1">
          {filtered.recent.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-[var(--accent)] mb-3 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Recently analyzed
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {filtered.recent.map((pl) => <PlaylistCard key={pl.id} pl={pl} onSelect={onSelect} />)}
              </div>
            </div>
          )}

          {filtered.rest.length > 0 && (
            <div>
              {filtered.recent.length > 0 && (
                <h3 className="text-sm font-semibold text-[var(--text-secondary)] mb-3">All playlists</h3>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {filtered.rest.map((pl) => <PlaylistCard key={pl.id} pl={pl} onSelect={onSelect} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PlaylistCard({ pl, onSelect }: { pl: SpotifyPlaylist; onSelect: (pl: SpotifyPlaylist) => void }): ReactElement {
  return (
    <button
      onClick={() => onSelect(pl)}
      className="group bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-3
                 hover:border-[var(--accent)] hover:bg-[var(--bg-secondary)] transition-all
                 text-left flex flex-col gap-2"
    >
      {pl.images && pl.images.length > 0 && pl.images[0]?.url ? (
        <div className="w-full aspect-square relative rounded-md overflow-hidden">
          <Image
            src={pl.images[0].url}
            alt={pl.name}
            fill
            sizes="(max-width: 640px) 50vw, 33vw"
            className="object-cover group-hover:scale-105 transition-transform duration-300"
          />
        </div>
      ) : (
        <PlaylistImagePlaceholder />
      )}
      <div className="min-w-0">
        <p className="font-semibold text-sm truncate group-hover:text-[var(--accent)] transition-colors">
          {pl.name}
        </p>
        <p className="text-[var(--text-secondary)] text-xs mt-0.5">
          {pl.tracks.total} tracks
        </p>
      </div>
    </button>
  );
}
