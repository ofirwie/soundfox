"use client";

import React, { memo } from "react";
import Image from "next/image";
import { type ScoredTrack } from "@/lib/discovery-pipeline";

export type TrackStatus = "idle" | "adding" | "added" | "removing";

interface TrackRowProps {
  item: ScoredTrack;
  index: number;
  isAdded: boolean;
  status: TrackStatus;
  isPlaying: boolean;
  onToggle: (id: string, added: boolean) => void;
  onPreview: (track: ScoredTrack["track"]) => void;
}

/**
 * Single track row.
 * Wrapped in React.memo to prevent 1000-row re-renders on every state change. [V2-C]
 */
const TrackRow = memo(function TrackRow({
  item,
  index,
  isAdded,
  status,
  isPlaying,
  onToggle,
  onPreview,
}: TrackRowProps): React.ReactElement {
  const hasPreview = !!item.track.preview_url;
  const albumImage = item.track.album.images[0]?.url;
  const scorePercent = Math.round(item.score * 100);
  const year = item.track.album.release_date?.slice(0, 4) ?? "";

  const isInFlight = status === "adding" || status === "removing";

  return (
    <div
      className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
        isAdded
          ? "bg-[var(--bg-card)] border-[var(--accent)]/30"
          : "bg-[var(--bg-secondary)] border-[var(--border)] opacity-60"
      }`}
    >
      {/* Rank */}
      <span className="text-[var(--text-secondary)] text-sm w-6 text-center flex-shrink-0 tabular-nums">
        {index + 1}
      </span>

      {/* Album art — click opens Spotify [Feature 5] */}
      <a
        href={`https://open.spotify.com/track/${item.track.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-[var(--bg-secondary)] block"
        title="Open in Spotify"
      >
        {albumImage ? (
          <Image src={albumImage} alt="" width={40} height={40} className="object-cover hover:opacity-80 transition-opacity" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">
            &#9834;
          </div>
        )}
      </a>

      {/* Track info */}
      <div className="flex-1 min-w-0">
        {/* Track name — click opens Spotify [Feature 5] */}
        <a
          href={`https://open.spotify.com/track/${item.track.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-white text-sm font-medium truncate block hover:text-[var(--accent)] transition-colors"
          title={item.track.name}
        >
          {item.track.name}
        </a>
        <p className="text-[var(--text-secondary)] text-xs truncate">{item.artist.name}</p>
        {item.matchedGenres.length > 0 && (
          <p className="text-[var(--accent)] text-xs truncate mt-0.5">
            {item.matchedGenres.slice(0, 2).join(", ")}
          </p>
        )}
      </div>

      {/* Year */}
      <span className="text-[var(--text-secondary)] text-xs flex-shrink-0 w-8 tabular-nums">
        {year}
      </span>

      {/* Score badge */}
      <div className="flex-shrink-0 text-center w-12">
        <p className="text-[var(--accent)] font-bold text-sm tabular-nums">{scorePercent}%</p>
        <p className="text-[var(--text-secondary)] text-xs">match</p>
      </div>

      {/* External link icon [Feature 5] */}
      <a
        href={`https://open.spotify.com/track/${item.track.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center text-[var(--text-secondary)] hover:text-white transition-colors"
        title="Open in Spotify"
        aria-label="Open in Spotify"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>

      {/* Preview button */}
      <button
        onClick={() => onPreview(item.track)}
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

      {/* Add/remove checkbox — optimistic UI with per-row spinner [V2-B] */}
      <button
        onClick={() => onToggle(item.track.id, isAdded)}
        disabled={isInFlight}
        className={`flex-shrink-0 w-6 h-6 rounded border-2 transition-colors flex items-center justify-center ${
          isInFlight
            ? "border-[var(--accent)]/50 cursor-wait"
            : isAdded
            ? "bg-[var(--accent)] border-[var(--accent)]"
            : "border-[var(--border)] hover:border-[var(--accent)]/50"
        }`}
        title={isAdded ? "Remove from playlist" : "Add to playlist"}
        aria-label={isAdded ? "Remove from playlist" : "Add to playlist"}
      >
        {isInFlight ? (
          <span className="inline-block w-3 h-3 border border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        ) : isAdded ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="w-3 h-3 text-black">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : null}
      </button>
    </div>
  );
});

export default TrackRow;
