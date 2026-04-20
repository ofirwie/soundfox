"use client";

import { useState, useEffect } from "react";
import type { ReactElement } from "react";
import { type ScanOptions } from "@/lib/discovery-pipeline";
import { type SpotifyPlaylist } from "@/lib/spotify-client";
import { loadLastScanOptions, saveLastScanOptions } from "@/lib/storage";

interface ScanOptionsStepProps {
  playlist: SpotifyPlaylist;
  onStart: (options: ScanOptions) => void;
}

export default function ScanOptionsStep({ playlist, onStart }: ScanOptionsStepProps): ReactElement {
  // Pre-fill with last used options if available
  const [allowKnownArtists, setAllowKnownArtists] = useState(() => {
    if (typeof window === "undefined") return false;
    return loadLastScanOptions()?.allowKnownArtists ?? false;
  });
  const [minYear, setMinYear] = useState(() => {
    if (typeof window === "undefined") return 2000;
    return loadLastScanOptions()?.minYear ?? 2000;
  });
  const [resultCount, setResultCount] = useState(() => {
    if (typeof window === "undefined") return 500;
    return loadLastScanOptions()?.resultCount ?? 500;
  });
  const [lastOptions, setLastOptions] = useState<ScanOptions | null>(null);
  useEffect(() => {
    setLastOptions(loadLastScanOptions());
  }, []);

  function handleStart(): void {
    const options = { allowKnownArtists, minYear, resultCount };
    saveLastScanOptions(options);
    onStart(options);
  }

  function handleQuickStart(): void {
    if (lastOptions) {
      saveLastScanOptions(lastOptions);
      onStart(lastOptions);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Scan Options</h2>
        <p className="text-[var(--text-secondary)]">
          Customise how SoundFox scans for music matching{" "}
          <span className="text-white font-medium">{playlist.name}</span>.
        </p>
      </div>

      {lastOptions && (
        <div className="bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-xl p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-[var(--accent)]">Use your last options</p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">
              {lastOptions.resultCount} tracks · from {lastOptions.minYear} ·{" "}
              {lastOptions.allowKnownArtists ? "known artists allowed" : "new artists only"}
            </p>
          </div>
          <button
            onClick={handleQuickStart}
            className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-black rounded-lg font-semibold text-sm transition-colors whitespace-nowrap"
          >
            Quick Start &rarr;
          </button>
        </div>
      )}

      {/* Allow known artists toggle */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-sm">Allow known artists</p>
            <p className="text-[var(--text-secondary)] text-xs mt-0.5">
              Include new songs from artists already in your playlist.
              Useful for workout playlists where any new track from a known artist is fine.
            </p>
          </div>
          {/* Toggle switch */}
          <button
            role="switch"
            aria-checked={allowKnownArtists}
            onClick={() => setAllowKnownArtists((v) => !v)}
            className={`relative flex-shrink-0 ml-4 w-12 h-6 rounded-full transition-colors ${
              allowKnownArtists ? "bg-[var(--accent)]" : "bg-[var(--bg-secondary)]"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                allowKnownArtists ? "translate-x-6" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Minimum year */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <p className="font-semibold text-sm">Minimum release year</p>
        <p className="text-[var(--text-secondary)] text-xs">
          Only include tracks released after this year.
        </p>
        <div className="flex items-center gap-3">
          {/* H6: min 1960 (supports older playlists), max is current year (dynamic) */}
          <input
            type="range"
            min={1960}
            max={new Date().getFullYear()}
            step={1}
            value={minYear}
            onChange={(e) => setMinYear(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--accent)]"
          />
          <span className="text-white font-semibold tabular-nums w-12 text-right">{minYear}</span>
        </div>
      </div>

      {/* Result count */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 space-y-2">
        <p className="font-semibold text-sm">Target result count</p>
        <p className="text-[var(--text-secondary)] text-xs">
          How many tracks to find. More tracks = longer scan. Maximum: 1000.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={50}
            max={1000}
            step={50}
            value={resultCount}
            onChange={(e) => setResultCount(parseInt(e.target.value, 10))}
            className="flex-1 accent-[var(--accent)]"
          />
          <span className="text-white font-semibold tabular-nums w-16 text-right">{resultCount}</span>
        </div>
      </div>

      {/* Estimated time */}
      <p className="text-[var(--text-secondary)] text-xs text-center">
        Estimated scan time: {Math.round((resultCount / 50) * 0.4 + 1)}–{Math.round((resultCount / 50) * 0.8 + 3)} minutes
      </p>

      <button
        onClick={handleStart}
        className="w-full py-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-xl
                   font-semibold text-lg transition-colors"
      >
        Start Scanning
      </button>
    </div>
  );
}
