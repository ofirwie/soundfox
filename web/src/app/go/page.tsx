"use client";

import { useEffect, useState, useCallback } from "react";
import type { ReactElement } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import PlaylistStep from "@/components/PlaylistStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import {
  getClientId, getAccessToken, getRefreshToken,
  loadScanState, loadLastScanOptions, saveLastScanOptions,
} from "@/lib/storage";
import { refreshAccessToken } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult, type ScanOptions } from "@/lib/discovery-pipeline";

type Mode = "loading" | "home" | "analyze" | "results";

export default function GoPage(): ReactElement {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [scanOptions, setScanOptions] = useState<ScanOptions>({});
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);

  useEffect(() => {
    let cancelled = false;

    const init = async (): Promise<void> => {
      // Need Client ID at minimum
      if (!getClientId()) {
        router.replace("/wizard");
        return;
      }

      // Try to ensure we have a valid token (refresh if expired)
      let authed = !!getAccessToken();
      if (!authed && getRefreshToken()) {
        authed = await refreshAccessToken();
      }
      if (!authed || cancelled) {
        if (!cancelled) router.replace("/wizard");
        return;
      }

      // Restore any in-progress scan
      const saved = loadScanState();
      if (saved && saved.allResults.length > 0) {
        const sorted = [...saved.allResults].sort((a, b) => b.score - a.score);
        setPipelineResult({
          tasteVector: { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
          coreGenres: [],
          tracksAnalyzed: 0, tracksWithFeatures: 0,
          candidateArtists: 0, genrePassed: 0,
          candidateTracks: sorted.length, scored: sorted.length,
          results: sorted,
        });
        setSelectedPlaylist({
          id: saved.sourcePlaylistId,
          name: saved.sourcePlaylistName,
          images: [], tracks: { total: 0 }, owner: { display_name: "" },
        });
      }

      setMode("home");

      // Load user profile in background
      try {
        const u = await getCurrentUser();
        if (!cancelled) setUser(u);
      } catch {
        if (!cancelled) router.replace("/wizard");
      }
    };

    void init();
    return () => { cancelled = true; };
  }, [router]);

  const handlePlaylistSelect = useCallback((pl: SpotifyPlaylist) => {
    const options = loadLastScanOptions() ?? { allowKnownArtists: false, minYear: 2000, resultCount: 500 };
    saveLastScanOptions(options);
    setSelectedPlaylist(pl);
    setScanOptions(options);
    setMode("analyze");
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setMode("results");
  }, []);

  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] px-8 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <button onClick={() => setMode("home")} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <h1 className="text-2xl font-bold">SoundFox</h1>
          </button>
          <div className="flex items-center gap-3">
            {user?.images && user.images[0]?.url ? (
              <Image src={user.images[0].url} alt="" width={32} height={32} className="rounded-full" unoptimized />
            ) : user ? (
              <div className="w-8 h-8 rounded-full bg-[var(--accent)] text-black flex items-center justify-center text-sm font-bold">
                {user.display_name?.[0] ?? "?"}
              </div>
            ) : null}
            <span className="text-[var(--text-secondary)] text-sm">{user?.display_name ?? ""}</span>
            <button
              onClick={() => router.push("/wizard")}
              className="text-[var(--text-secondary)] text-xs hover:text-white"
              title="Full setup / change account"
            >
              Settings
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 p-8">
        <div className="max-w-5xl mx-auto">
          {mode === "loading" && (
            <div className="flex flex-col items-center justify-center py-24 gap-3">
              <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
              <p className="text-[var(--text-secondary)] text-sm">Connecting to Spotify...</p>
            </div>
          )}

          {mode === "home" && <PlaylistStep onSelect={handlePlaylistSelect} />}

          {mode === "analyze" && selectedPlaylist && (
            <AnalysisStep
              playlist={selectedPlaylist}
              scanOptions={scanOptions}
              onComplete={handleAnalysisComplete}
            />
          )}

          {mode === "results" && pipelineResult && selectedPlaylist && (
            <ResultsStep
              result={pipelineResult}
              playlistName={selectedPlaylist.name}
              playlistId={selectedPlaylist.id}
              onBack={() => {
                setPipelineResult(null);
                setSelectedPlaylist(null);
                setMode("home");
              }}
            />
          )}
        </div>
      </div>
    </main>
  );
}
