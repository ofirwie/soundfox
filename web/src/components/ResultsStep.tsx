"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { type PipelineResult, type ScoredTrack } from "@/lib/discovery-pipeline";
import { saveAnalysis } from "@/lib/storage";
import { getCurrentUser, createPlaylist, addTracksToPlaylist } from "@/lib/spotify-client";

interface ResultsStepProps {
  result: PipelineResult;
  playlistName: string;
  playlistId: string;
}

export default function ResultsStep({ result, playlistName, playlistId }: ResultsStepProps): React.ReactElement {
  const { results, tasteVector, coreGenres } = result;

  // Checkboxes — all selected by default
  const [selected, setSelected] = useState<Set<string>>(() => new Set(results.map((r) => r.track.id)));
  // Preview player
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Playlist creation
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // [H5 FIX] Save analysis to localStorage on mount
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

  function toggleTrack(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((r) => r.track.id)));
    }
  }

  function handlePreview(track: ScoredTrack["track"]): void {
    if (playingId === track.id) {
      // Stop
      audioRef.current?.pause();
      setPlayingId(null);
      setPreviewUrl(null);
      return;
    }
    if (!track.preview_url) return;
    audioRef.current?.pause();
    setPreviewUrl(track.preview_url);
    setPlayingId(track.id);
  }

  // Auto-play when previewUrl changes
  useEffect(() => {
    if (previewUrl && audioRef.current) {
      audioRef.current.src = previewUrl;
      audioRef.current.play().catch(() => {
        // Autoplay blocked — user must click again
      });
    }
  }, [previewUrl]);

  async function handleCreatePlaylist(): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      const user = await getCurrentUser();
      const selectedTracks = results.filter((r) => selected.has(r.track.id));
      const newPlaylist = await createPlaylist(
        user.id,
        `SoundFox: ${playlistName}`,
        `Discovered by SoundFox — ${selectedTracks.length} tracks matching your taste profile`,
      );
      await addTracksToPlaylist(
        newPlaylist.id,
        selectedTracks.map((r) => `spotify:track:${r.track.id}`),
      );
      setCreatedUrl(`https://open.spotify.com/playlist/${newPlaylist.id}`);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create playlist");
    } finally {
      setCreating(false);
    }
  }

  const selectedCount = selected.size;
  const topGenres = coreGenres.slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        className="hidden"
      />

      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold mb-2">Your Recommendations</h2>
        <p className="text-[var(--text-secondary)]">
          Found {results.length} tracks matching your taste profile from{" "}
          <span className="text-white font-medium">{playlistName}</span>
        </p>
      </div>

      {/* Taste summary — dynamic genres [C3 FIX] */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
        <p className="text-sm font-semibold text-[var(--text-secondary)] mb-2">Your Taste Profile</p>
        <div className="flex flex-wrap gap-2">
          {topGenres.map((genre) => (
            <span
              key={genre}
              className="px-3 py-1 bg-[var(--accent)]/10 border border-[var(--accent)]/30
                         text-[var(--accent)] rounded-full text-xs font-medium capitalize"
            >
              {genre}
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs">
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

      {/* Track list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-[var(--text-secondary)]">{selectedCount} of {results.length} selected</p>
          <button onClick={toggleAll} className="text-sm text-[var(--accent)] hover:underline">
            {selectedCount === results.length ? "Deselect all" : "Select all"}
          </button>
        </div>

        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {results.map((item, index) => {
            const isSelected = selected.has(item.track.id);
            const isPlaying = playingId === item.track.id;
            const hasPreview = !!item.track.preview_url;
            const albumImage = item.track.album.images[0]?.url;
            const scorePercent = Math.round(item.score * 100);

            return (
              <div
                key={item.track.id}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                  isSelected
                    ? "bg-[var(--bg-card)] border-[var(--accent)]/30"
                    : "bg-[var(--bg-secondary)] border-[var(--border)] opacity-60"
                }`}
              >
                {/* Rank */}
                <span className="text-[var(--text-secondary)] text-sm w-6 text-center flex-shrink-0">
                  {index + 1}
                </span>

                {/* Album art */}
                <div className="w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-[var(--bg-secondary)]">
                  {albumImage ? (
                    <Image src={albumImage} alt="" width={40} height={40} className="object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">
                      &#9834;
                    </div>
                  )}
                </div>

                {/* Track info */}
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">{item.track.name}</p>
                  <p className="text-[var(--text-secondary)] text-xs truncate">{item.artist.name}</p>
                  {item.matchedGenres.length > 0 && (
                    <p className="text-[var(--accent)] text-xs truncate mt-0.5">
                      {item.matchedGenres.slice(0, 2).join(", ")}
                    </p>
                  )}
                </div>

                {/* Score badge */}
                <div className="flex-shrink-0 text-center w-12">
                  <p className="text-[var(--accent)] font-bold text-sm">{scorePercent}%</p>
                  <p className="text-[var(--text-secondary)] text-xs">match</p>
                </div>

                {/* Preview button */}
                <button
                  onClick={() => handlePreview(item.track)}
                  disabled={!hasPreview}
                  className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    hasPreview
                      ? isPlaying
                        ? "bg-[var(--accent)] text-black"
                        : "bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/20 text-[var(--text-secondary)]"
                      : "opacity-20 cursor-not-allowed bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                  }`}
                  title={hasPreview ? (isPlaying ? "Stop preview" : "Play 30s preview") : "No preview available"}
                >
                  {isPlaying ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 ml-0.5">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Checkbox */}
                <button
                  onClick={() => toggleTrack(item.track.id)}
                  className={`flex-shrink-0 w-5 h-5 rounded border-2 transition-colors flex items-center justify-center ${
                    isSelected
                      ? "bg-[var(--accent)] border-[var(--accent)]"
                      : "border-[var(--border)] hover:border-[var(--accent)]/50"
                  }`}
                >
                  {isSelected && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="w-3 h-3 text-black">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create playlist CTA */}
      <div className="space-y-3 pt-2">
        {createdUrl ? (
          <div className="bg-green-950/30 border border-green-800 rounded-xl p-4 text-center space-y-2">
            <p className="text-green-400 font-semibold">Playlist created!</p>
            <a
              href={createdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-6 py-2 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-sm transition-colors"
            >
              Open in Spotify
            </a>
          </div>
        ) : (
          <>
            {createError && (
              <p className="text-red-400 text-sm text-center">{createError}</p>
            )}
            <button
              onClick={() => void handleCreatePlaylist()}
              disabled={creating || selectedCount === 0}
              className={`w-full py-3 rounded-lg font-semibold transition-colors ${
                creating || selectedCount === 0
                  ? "bg-[var(--bg-secondary)] text-[var(--text-secondary)] cursor-not-allowed"
                  : "bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
              }`}
            >
              {creating
                ? "Creating playlist..."
                : `Create Playlist (${selectedCount} tracks)`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
