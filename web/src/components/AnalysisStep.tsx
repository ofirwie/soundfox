"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  runPipelineStreaming,
  type BatchUpdate,
  type PipelineResult,
  type ScanOptions,
  type ScoredTrack,
} from "@/lib/discovery-pipeline";
import { saveScanState, clearScanState } from "@/lib/storage";
import { type SpotifyPlaylist } from "@/lib/spotify-client";
import { loadProfile, createEmptyProfile, saveProfile } from "@/lib/profile";

interface AnalysisStepProps {
  playlist: SpotifyPlaylist;
  scanOptions: ScanOptions;
  onComplete: (result: PipelineResult) => void;
}

interface PhaseConfig {
  key: string;
  label: string;
  icon: string;
}

const PHASES: PhaseConfig[] = [
  { key: "analyze", label: "Analyzing playlist", icon: "?" },
  { key: "discover", label: "Discovering artists", icon: "?" },
  { key: "score", label: "Scoring candidates", icon: "*" },
  { key: "done", label: "Complete", icon: "v" },
];

export default function AnalysisStep({
  playlist,
  scanOptions,
  onComplete,
}: AnalysisStepProps): ReactElement {
  const [progress, setProgress] = useState<BatchUpdate>({
    batch: [], totalFound: 0, phase: "analyze",
    message: "Starting...", percent: 0, done: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stopped, setStopped] = useState(false);

  // Accumulated scored tracks — used to build PipelineResult on completion/stop
  const accumulatedRef = useRef<ScoredTrack[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  // [C1] Store the DoneUpdate from the generator — it carries all metadata directly
  const doneUpdateRef = useRef<Extract<BatchUpdate, { done: true }> | null>(null);

  const buildPartialResult = useCallback((): PipelineResult => {
    const sorted = [...accumulatedRef.current].sort((a, b) => b.score - a.score);
    const done = doneUpdateRef.current;
    return {
      tasteVector: done?.tasteVector ?? { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
      coreGenres: done?.coreGenres ?? [],
      tracksAnalyzed: done?.tracksAnalyzed ?? 0,
      tracksWithFeatures: done?.tracksWithFeatures ?? 0,
      candidateArtists: done?.candidateArtists ?? 0,
      genrePassed: done?.genrePassed ?? 0,
      candidateTracks: sorted.length,
      scored: sorted.length,
      results: sorted,
    };
  }, []);

  // H5: scanOptions must be stable to prevent start() from re-triggering on every render.
  // In wizard/page.tsx, scanOptions state must be set once (from handleScanOptionsConfirmed)
  // and never mutated in-place. If it is rebuilt on every render, wrap it in useMemo or
  // store it in a ref before passing to AnalysisStep.
  const start = useCallback((): void => {
    accumulatedRef.current = [];
    doneUpdateRef.current = null;
    setError(null);
    setRunning(true);
    setStopped(false);
    setProgress({ batch: [], totalFound: 0, phase: "analyze", message: "Starting...", percent: 0, done: false });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    void (async () => {
      try {
        // Load per-playlist profile — create and save if first time for this playlist
        const profile = loadProfile(playlist.id) ?? createEmptyProfile(playlist.id);
        if (!loadProfile(playlist.id)) saveProfile(profile);

        const gen = runPipelineStreaming(playlist.id, {
          ...scanOptions,
          signal: controller.signal,
          blacklist: profile.blacklist,
        });

        for await (const update of gen) {
          if (controller.signal.aborted) break;

          setProgress(update);

          if (update.done) {
            // [C1] Capture DoneUpdate for metadata — buildPartialResult reads it
            doneUpdateRef.current = update;
          }

          if (update.batch.length > 0) {
            accumulatedRef.current.push(...update.batch);

            // Save scan state every batch [V2-F]
            saveScanState({
              sourcePlaylistId: playlist.id,
              sourcePlaylistName: playlist.name,
              scanOptions,
              allResults: accumulatedRef.current,
              targetPlaylistId: null,
              targetPlaylistName: null,
              savedAt: new Date().toISOString(),
            });
          }

          if (update.done) break;
        }

        // Done or aborted — transition to results
        clearScanState();
        setRunning(false);
        onComplete(buildPartialResult());
      } catch (err: unknown) {
        // Always log errors to debug file
        void fetch("/api/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phase: "PIPELINE_CAUGHT_ERROR",
            errorName: (err as Error)?.name,
            errorMessage: (err as Error)?.message,
            stack: (err as Error)?.stack?.slice(0, 500),
          }),
        });
        if ((err as Error).name === "AbortError") {
          clearScanState();
          setRunning(false);
          setStopped(true);
          if (accumulatedRef.current.length > 0) {
            onComplete(buildPartialResult());
          } else {
            setError("Scan stopped before any tracks were found. Try again.");
          }
        } else {
          clearScanState();
          setRunning(false);
          setError(err instanceof Error ? err.message : "An unexpected error occurred");
        }
      }
    })();
  }, [playlist.id, playlist.name, scanOptions, onComplete, buildPartialResult]);

  // Auto-start on mount.
  // CRITICAL: do NOT abort on cleanup. React Strict Mode (dev) double-mounts
  // components, and the cleanup fires AFTER the second mount has already
  // replaced abortControllerRef.current with the new pipeline's controller.
  // Aborting here would kill the second pipeline instead of the first.
  // The first pipeline's results are simply discarded — handleStop() is the
  // only legitimate abort path.
  useEffect(() => {
    start();
  }, [start]);

  function handleStop(): void {
    abortControllerRef.current?.abort();
  }

  const currentPhaseIndex = PHASES.findIndex((p) => p.key === progress.phase);

  // Error state with retry
  if (error) {
    return (
      <div className="space-y-6 text-center">
        <div className="bg-red-950/30 border border-red-800 rounded-xl p-6">
          <p className="text-red-400 text-lg font-semibold mb-2">Analysis Failed</p>
          <p className="text-[var(--text-secondary)] text-sm">{error}</p>
        </div>
        <div className="space-y-3">
          <button
            onClick={start}
            className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors"
          >
            Retry Analysis
          </button>
          <p className="text-[var(--text-secondary)] text-xs">
            Common causes: Spotify session expired, network timeout, or empty playlist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold mb-2">Scanning...</h2>
        <p className="text-[var(--text-secondary)]">
          Finding music that matches the audio DNA of{" "}
          <span className="text-white font-medium">{playlist.name}</span>
        </p>
      </div>

      {/* Live count badge */}
      {progress.totalFound > 0 && (
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--accent)]/10 border border-[var(--accent)]/30 rounded-full text-sm font-medium text-[var(--accent)]">
          <span className="inline-block w-2 h-2 bg-[var(--accent)] rounded-full animate-pulse" />
          {progress.totalFound} tracks found so far
        </div>
      )}

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm text-[var(--text-secondary)]">
          <span>{progress.message}</span>
          <span>{Math.round(progress.percent)}%</span>
        </div>
        <div className="w-full bg-[var(--bg-secondary)] rounded-full h-2 overflow-hidden">
          <div
            className="bg-[var(--accent)] h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {/* Phase indicators */}
      <div className="space-y-3">
        {PHASES.filter((p) => p.key !== "done").map((phase, index) => {
          const isDone = currentPhaseIndex > index;
          const isActive = currentPhaseIndex === index;
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                isActive
                  ? "bg-[var(--bg-card)] border border-[var(--accent)]/30"
                  : isDone
                  ? "opacity-50"
                  : "opacity-30"
              }`}
            >
              <span className="text-xl w-8 text-center">
                {isDone ? "+" : isActive ? (
                  <span className="inline-block w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                ) : phase.icon}
              </span>
              <div>
                <p className={`font-medium text-sm ${isActive ? "text-white" : "text-[var(--text-secondary)]"}`}>
                  {phase.label}
                </p>
                {isActive && (
                  <p className="text-[var(--text-secondary)] text-xs mt-0.5">{progress.message}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex gap-3">
        {running && (
          <button
            onClick={handleStop}
            className="flex-1 py-3 border border-red-800 text-red-400 hover:bg-red-950/30 rounded-lg font-semibold transition-colors text-sm"
          >
            Stop scanning — show results so far ({progress.totalFound} tracks)
          </button>
        )}
      </div>

      {running && (
        <p className="text-center text-[var(--text-secondary)] text-sm">
          Results will appear as tracks are found. Close tab? Your progress is auto-saved.
        </p>
      )}

      {/* Suppress unused variable warning — stopped is used for future UI gate */}
      {stopped && false && null}
    </div>
  );
}
