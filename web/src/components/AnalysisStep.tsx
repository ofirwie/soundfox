"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { runPipeline, type PipelineProgress, type PipelineResult } from "@/lib/discovery-pipeline";
import { type SpotifyPlaylist } from "@/lib/spotify-client";

interface AnalysisStepProps {
  playlist: SpotifyPlaylist;
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

export default function AnalysisStep({ playlist, onComplete }: AnalysisStepProps): React.ReactElement {
  const [progress, setProgress] = useState<PipelineProgress>({
    phase: "analyze",
    message: "Starting...",
    percent: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);

  const start = useCallback((): void => {
    abortRef.current = false;
    setError(null);
    setRunning(true);
    setProgress({ phase: "analyze", message: "Starting...", percent: 0 });

    runPipeline(playlist.id, (p) => {
      if (!abortRef.current) setProgress(p);
    })
      .then((result) => {
        if (!abortRef.current) {
          setRunning(false);
          onComplete(result);
        }
      })
      .catch((err: unknown) => {
        if (!abortRef.current) {
          setRunning(false);
          setError(err instanceof Error ? err.message : "An unexpected error occurred");
        }
      });
  }, [playlist.id, onComplete]);

  // Auto-start on mount
  useEffect(() => {
    start();
    return () => {
      abortRef.current = true;
    };
  }, [start]);

  const currentPhaseIndex = PHASES.findIndex((p) => p.key === progress.phase);

  // [H3 FIX] Error state with retry button
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
        <h2 className="text-3xl font-bold mb-2">Analyzing Playlist</h2>
        <p className="text-[var(--text-secondary)]">
          Finding music that matches the audio DNA of{" "}
          <span className="text-white font-medium">{playlist.name}</span>
        </p>
      </div>

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

      {running && (
        <p className="text-center text-[var(--text-secondary)] text-sm">
          This takes 2-5 minutes depending on playlist size. Please keep the tab open.
        </p>
      )}
    </div>
  );
}
