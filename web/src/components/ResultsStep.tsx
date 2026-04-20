"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { type PipelineResult, type ScoredTrack } from "@/lib/discovery-pipeline";
import { saveAnalysis, saveTargetPlaylist } from "@/lib/storage";
import {
  getCurrentUser, createPlaylist, addTracksToPlaylist, removeTracksFromPlaylist,
  getUserPlaylists, getPlaylistTracks, type SpotifyPlaylist,
} from "@/lib/spotify-client";
import TrackRow, { type TrackStatus } from "./TrackRow";

// ─── Props ────────────────────────────────────────────────────────────────────

interface ResultsStepProps {
  result: PipelineResult;
  playlistName: string;
  playlistId: string;
  onBack?: () => void;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SortKey = "score" | "popularity" | "year" | "random";
type DestinationMode = "new" | "existing";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const DEBOUNCE_MS = 300; // [V2-B]

// ─── Helpers ─────────────────────────────────────────────────────────────────

function releaseDateToYear(releaseDate: string | undefined): number {
  return parseInt(releaseDate?.slice(0, 4) ?? "0", 10);
}

function sortTracks(tracks: ScoredTrack[], key: SortKey, randomSeed: number): ScoredTrack[] {
  const copy = [...tracks];
  switch (key) {
    case "score":
      return copy.sort((a, b) => b.score - a.score);
    case "popularity":
      return copy.sort((a, b) => b.track.popularity - a.track.popularity);
    case "year":
      return copy.sort((a, b) =>
        releaseDateToYear(b.track.album.release_date) - releaseDateToYear(a.track.album.release_date),
      );
    case "random":
      // Stable pseudo-random per randomSeed so re-renders don't reshuffle
      return copy.sort((a, b) => {
        const ha = (a.track.id.charCodeAt(0) + randomSeed) % 97;
        const hb = (b.track.id.charCodeAt(0) + randomSeed) % 97;
        return ha - hb;
      });
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ResultsStep({ result, playlistName, playlistId, onBack }: ResultsStepProps): ReactElement {
  const { results, tasteVector, coreGenres } = result;

  // ── Destination playlist ───────────────────────────────────────────────────
  const [destMode, setDestMode] = useState<DestinationMode>("new");
  const [targetPlaylistId, setTargetPlaylistId] = useState<string | null>(null);
  const [targetPlaylistName, setTargetPlaylistName] = useState<string>(`Discover: ${playlistName}`);
  const [playlistNameInput, setPlaylistNameInput] = useState<string>(`Discover: ${playlistName}`);
  const [showNamePrompt, setShowNamePrompt] = useState(false);
  const [nameConfirmed, setNameConfirmed] = useState(false);
  // For "Add to existing" mode
  const [userPlaylists, setUserPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);

  // ── Track state ────────────────────────────────────────────────────────────
  // added: Set of track IDs that have been confirmed added to the target playlist
  const [added, setAdded] = useState<Set<string>>(new Set());
  // statuses: per-track API call status for optimistic UI
  const [statuses, setStatuses] = useState<Map<string, TrackStatus>>(new Map());
  // debounce timers per track [V2-B]
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Cleanup all debounce timers on unmount [H2] ───────────────────────────
  useEffect(() => {
    return () => {
      for (const timer of debounceTimers.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const [page, setPage] = useState(0);

  // ── Sort & filter ──────────────────────────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [randomSeed] = useState(() => Math.floor(Math.random() * 1000));
  const [textFilter, setTextFilter] = useState("");
  const [genreFilter, setGenreFilter] = useState<string | null>(null);
  const [followerMin, setFollowerMin] = useState<string>("");
  const [followerMax, setFollowerMax] = useState<string>("");

  // ── Audio preview ──────────────────────────────────────────────────────────
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ── Save analysis to history on mount [H5] ─────────────────────────────────
  useEffect(() => {
    const meanVector: Record<string, number> = {};
    for (const [k, v] of Object.entries(tasteVector.mean)) {
      if (v != null) meanVector[k] = v;
    }
    saveAnalysis({
      id: crypto.randomUUID(),
      playlistId,
      playlistName,
      trackCount: result.tracksAnalyzed,
      tasteVector: meanVector,
      resultCount: results.length,
      createdAt: new Date().toISOString(),
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load user playlists when "existing" mode selected ─────────────────────
  useEffect(() => {
    if (destMode === "existing" && !playlistsLoaded) {
      getUserPlaylists()
        .then((pls) => { setUserPlaylists(pls); setPlaylistsLoaded(true); })
        .catch(() => setPlaylistsLoaded(true));
    }
  }, [destMode, playlistsLoaded]);

  // ── Pre-populate `added` set when an existing target playlist is chosen [H1] ──
  // After the user picks an existing playlist, fetch its current tracks and mark
  // any that overlap with our results as already-added. Prevents duplicates.
  useEffect(() => {
    if (destMode !== "existing" || !targetPlaylistId) return;
    void (async () => {
      try {
        const existingTracks = await getPlaylistTracks(targetPlaylistId);
        const existingIds = new Set(existingTracks.map((t) => t.id));
        setAdded((prev) => {
          const next = new Set(prev);
          for (const item of results) {
            if (existingIds.has(item.track.id)) next.add(item.track.id);
          }
          return next;
        });
      } catch {
        // Non-fatal — user can still add tracks, they may just see duplicates
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetPlaylistId, destMode]);

  // ── Filtered & sorted track list ──────────────────────────────────────────
  const filteredSorted = useMemo(() => {
    const fMin = followerMin ? parseInt(followerMin, 10) : 0;
    const fMax = followerMax ? parseInt(followerMax, 10) : Infinity;
    const text = textFilter.toLowerCase().trim();

    const filtered = results.filter((item) => {
      if (text && !item.track.name.toLowerCase().includes(text) && !item.artist.name.toLowerCase().includes(text)) {
        return false;
      }
      if (genreFilter && !item.artist.genres.includes(genreFilter)) return false;
      const followers = item.artist.followers.total;
      if (followers < fMin || followers > fMax) return false;
      return true;
    });

    return sortTracks(filtered, sortKey, randomSeed);
  }, [results, textFilter, genreFilter, followerMin, followerMax, sortKey, randomSeed]);

  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const pageItems = filteredSorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset to page 0 when filter changes
  useEffect(() => { setPage(0); }, [textFilter, genreFilter, followerMin, followerMax, sortKey]);

  // ── Genre chip list (top 20 from results for filter bar) ─────────────────
  const allGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of results) {
      for (const g of item.matchedGenres) {
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([g]) => g);
  }, [results]);

  // ── Create / resolve target playlist ─────────────────────────────────────
  // Wrapped in useCallback so the function reference is stable across renders.
  // handleToggle depends on ensureTargetPlaylist — if ensureTargetPlaylist is
  // recreated on every render, handleToggle would also be recreated, defeating
  // React.memo on TrackRow. [V2-C]

  const ensureTargetPlaylist = useCallback(async (): Promise<string> => {
    if (targetPlaylistId) return targetPlaylistId;

    if (destMode === "new") {
      const user = await getCurrentUser();
      const newPl = await createPlaylist(
        user.id,
        targetPlaylistName,
        `Discovered by SoundFox — matching ${playlistName}`,
      );
      setTargetPlaylistId(newPl.id);
      saveTargetPlaylist(newPl.id, targetPlaylistName);
      return newPl.id;
    }

    throw new Error("No target playlist selected");
  }, [destMode, targetPlaylistId, targetPlaylistName, playlistName]);

  // ── Debounced toggle handler [V2-B] ───────────────────────────────────────

  const handleToggle = useCallback((trackId: string, currentlyAdded: boolean): void => {
    // Cancel any pending debounce for this track
    const existingTimer = debounceTimers.current.get(trackId);
    if (existingTimer) clearTimeout(existingTimer);

    // If we have no playlist name yet (new mode, first check), show the prompt.
    // No debounce timer is started until nameConfirmed=true — serializes the flow [H2]
    if (destMode === "new" && !nameConfirmed) {
      setShowNamePrompt(true);
      return;
    }

    // Optimistic UI: flip the added state immediately
    setAdded((prev) => {
      const next = new Set(prev);
      if (currentlyAdded) next.delete(trackId);
      else next.add(trackId);
      return next;
    });

    setStatuses((prev) => {
      const next = new Map(prev);
      next.set(trackId, currentlyAdded ? "removing" : "adding");
      return next;
    });

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const plId = await ensureTargetPlaylist();
          if (currentlyAdded) {
            await removeTracksFromPlaylist(plId, [`spotify:track:${trackId}`]);
          } else {
            await addTracksToPlaylist(plId, [`spotify:track:${trackId}`]);
          }
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(trackId, currentlyAdded ? "idle" : "added");
            return next;
          });
        } catch {
          // Roll back optimistic update on failure
          setAdded((prev) => {
            const next = new Set(prev);
            if (currentlyAdded) next.add(trackId); // restore added
            else next.delete(trackId); // restore not-added
            return next;
          });
          setStatuses((prev) => {
            const next = new Map(prev);
            next.set(trackId, "idle");
            return next;
          });
        }
      })();
    }, DEBOUNCE_MS);

    debounceTimers.current.set(trackId, timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destMode, nameConfirmed, ensureTargetPlaylist]);

  // ── Audio preview ─────────────────────────────────────────────────────────

  function handlePreview(track: ScoredTrack["track"]): void {
    if (playingId === track.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    if (!track.preview_url) return;
    audioRef.current?.pause();
    if (audioRef.current) {
      audioRef.current.src = track.preview_url;
      audioRef.current.play().catch(() => { /* autoplay blocked */ });
    }
    setPlayingId(track.id);
  }

  // ── Persistent badge count ────────────────────────────────────────────────
  const addedCount = added.size;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} className="hidden" />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h2 className="text-3xl font-bold mb-1">Your Recommendations</h2>
          <p className="text-[var(--text-secondary)] text-sm">
            Found {results.length} tracks matching the audio DNA of{" "}
            <span className="text-white font-medium">{playlistName}</span>
          </p>
        </div>
        {onBack && (
          <button
            onClick={onBack}
            className="px-4 py-2 bg-[var(--bg-card)] hover:bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to playlists
          </button>
        )}
      </div>

      {/* Empty state */}
      {results.length === 0 && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-8 text-center space-y-3">
          <p className="text-lg font-semibold">No recommendations found</p>
          <p className="text-[var(--text-secondary)] text-sm max-w-md mx-auto">
            This usually means: the playlist is empty, ReccoBeats doesn&apos;t have audio features for these
            tracks, or no candidate artists matched the genre profile. Try a different playlist.
          </p>
          {onBack && (
            <button
              onClick={onBack}
              className="mt-2 px-6 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black rounded-lg font-semibold text-sm"
            >
              Pick another playlist
            </button>
          )}
        </div>
      )}

      {/* Persistent badge [Feature 3 — badge] */}
      {addedCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-green-950/30 border border-green-800 rounded-xl text-green-400 text-sm font-medium">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-4 h-4 flex-shrink-0">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          {addedCount} {addedCount === 1 ? "track" : "tracks"} added to{" "}
          <span className="font-semibold">{targetPlaylistName}</span>
          {targetPlaylistId && (
            <a
              href={`https://open.spotify.com/playlist/${targetPlaylistId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-green-400 hover:text-green-300 transition-colors text-xs underline"
            >
              Open in Spotify
            </a>
          )}
        </div>
      )}

      {/* Destination toggle [Feature 3 — destination] */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-3">
        <p className="text-sm font-semibold text-[var(--text-secondary)]">Add tracks to:</p>
        <div className="flex gap-2">
          <button
            onClick={() => setDestMode("new")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              destMode === "new"
                ? "bg-[var(--accent)] text-black"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            New playlist
          </button>
          <button
            onClick={() => setDestMode("existing")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              destMode === "existing"
                ? "bg-[var(--accent)] text-black"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
            }`}
          >
            Add to: {destMode === "existing" && targetPlaylistId
              ? targetPlaylistName
              : "existing playlist"}
          </button>
        </div>

        {destMode === "existing" && (
          <div className="mt-2">
            {!playlistsLoaded ? (
              <p className="text-[var(--text-secondary)] text-xs">Loading your playlists...</p>
            ) : (
              <select
                className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                           text-sm text-white focus:outline-none focus:border-[var(--accent)]"
                value={targetPlaylistId ?? ""}
                onChange={(e) => {
                  const pl = userPlaylists.find((p) => p.id === e.target.value);
                  if (pl) {
                    setTargetPlaylistId(pl.id);
                    setTargetPlaylistName(pl.name);
                    saveTargetPlaylist(pl.id, pl.name);
                    setNameConfirmed(true);
                  }
                }}
              >
                <option value="">— Select a playlist —</option>
                {userPlaylists.map((pl) => (
                  <option key={pl.id} value={pl.id}>{pl.name}</option>
                ))}
              </select>
            )}
          </div>
        )}
      </div>

      {/* Playlist name prompt — appears on first checkbox in "new" mode */}
      {showNamePrompt && (
        <div className="bg-[var(--bg-card)] border border-[var(--accent)]/40 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold">Name your new playlist</p>
          <input
            type="text"
            value={playlistNameInput}
            onChange={(e) => setPlaylistNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && playlistNameInput.trim()) {
                setTargetPlaylistName(playlistNameInput.trim());
                setNameConfirmed(true);
                setShowNamePrompt(false);
              }
            }}
            className="w-full px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm focus:outline-none focus:border-[var(--accent)]"
            autoFocus
          />
          <button
            onClick={() => {
              if (playlistNameInput.trim()) {
                setTargetPlaylistName(playlistNameInput.trim());
                setNameConfirmed(true);
                setShowNamePrompt(false);
              }
            }}
            disabled={!playlistNameInput.trim()}
            className="w-full py-2 bg-[var(--accent)] rounded-lg text-sm font-semibold disabled:opacity-50"
          >
            Confirm name
          </button>
        </div>
      )}

      {/* Sort + Filter bar [Feature 3 — sort/filter] */}
      <div className="space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <input
            type="text"
            value={textFilter}
            onChange={(e) => setTextFilter(e.target.value)}
            placeholder="Search tracks or artists..."
            className="flex-1 min-w-0 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm focus:outline-none focus:border-[var(--accent)] placeholder-gray-600"
          />
          <select
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                       text-sm text-white focus:outline-none focus:border-[var(--accent)]"
          >
            <option value="score">Sort: Match score</option>
            <option value="popularity">Sort: Popularity</option>
            <option value="year">Sort: Year (newest)</option>
            <option value="random">Sort: Random</option>
          </select>
        </div>

        {/* Genre filter chips */}
        {allGenres.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setGenreFilter(null)}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                genreFilter === null
                  ? "bg-[var(--accent)] text-black font-medium"
                  : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
              }`}
            >
              All genres
            </button>
            {allGenres.map((g) => (
              <button
                key={g}
                onClick={() => setGenreFilter(genreFilter === g ? null : g)}
                className={`px-2.5 py-1 rounded-full text-xs capitalize transition-colors ${
                  genreFilter === g
                    ? "bg-[var(--accent)] text-black font-medium"
                    : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-white"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {/* Follower range filter */}
        <div className="flex gap-2 items-center text-xs text-[var(--text-secondary)]">
          <span>Followers:</span>
          <input
            type="number"
            value={followerMin}
            onChange={(e) => setFollowerMin(e.target.value)}
            placeholder="Min"
            className="w-24 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-white
                       focus:outline-none focus:border-[var(--accent)]"
          />
          <span>–</span>
          <input
            type="number"
            value={followerMax}
            onChange={(e) => setFollowerMax(e.target.value)}
            placeholder="Max"
            className="w-24 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded text-white
                       focus:outline-none focus:border-[var(--accent)]"
          />
        </div>
      </div>

      {/* Track list with pagination [Feature 3 — pagination] */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm text-[var(--text-secondary)]">
          <span>
            {filteredSorted.length} tracks
            {genreFilter || textFilter ? " (filtered)" : ""}
          </span>
          <span>Page {page + 1} of {totalPages}</span>
        </div>

        {/* [V2-D] CSS containment for windowing-like performance */}
        <div
          className="space-y-2 max-h-[55vh] overflow-y-auto pr-1"
          style={{ contain: "content" }}
        >
          {pageItems.map((item, idx) => (
            <TrackRow
              key={item.track.id}
              item={item}
              index={page * PAGE_SIZE + idx}
              isAdded={added.has(item.track.id)}
              status={statuses.get(item.track.id) ?? "idle"}
              isPlaying={playingId === item.track.id}
              onToggle={handleToggle}
              onPreview={handlePreview}
            />
          ))}
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg text-sm bg-[var(--bg-secondary)] disabled:opacity-40
                         hover:bg-[var(--bg-card)] transition-colors"
            >
              Previous
            </button>
            <span className="text-sm text-[var(--text-secondary)]">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-3 py-1.5 rounded-lg text-sm bg-[var(--bg-secondary)] disabled:opacity-40
                         hover:bg-[var(--bg-card)] transition-colors"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Taste profile summary */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
        <p className="text-xs font-semibold text-[var(--text-secondary)] mb-2 uppercase tracking-wide">
          Taste Profile
        </p>
        <div className="flex flex-wrap gap-2 mb-3">
          {coreGenres.slice(0, 6).map((genre) => (
            <span
              key={genre}
              className="px-3 py-1 bg-[var(--accent)]/10 border border-[var(--accent)]/30
                         text-[var(--accent)] rounded-full text-xs font-medium capitalize"
            >
              {genre}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-3 text-center text-xs">
          <div>
            <p className="text-[var(--text-secondary)]">Analyzed</p>
            <p className="text-white font-semibold">{result.tracksAnalyzed} tracks</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Candidates</p>
            <p className="text-white font-semibold">{result.candidateTracks}</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Scored</p>
            <p className="text-white font-semibold">{result.scored}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
