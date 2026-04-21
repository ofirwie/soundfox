"use client";

import { useState, useEffect, useCallback } from "react";
import type { ReactElement } from "react";
import WizardLayout from "@/components/WizardLayout";
import SetupStep from "@/components/SetupStep";
import PlaylistStep from "@/components/PlaylistStep";
import IntentStep from "@/components/IntentStep";
import ScanOptionsStep from "@/components/ScanOptionsStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import { getClientId, getAccessToken, loadScanState } from "@/lib/storage";
import { startLogin } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult, type ScanOptions } from "@/lib/discovery-pipeline";
import { setIntent } from "@/lib/profile";
import type { Intent } from "@/lib/intent-types";

const STEP_NAMES = ["Setup", "Connect", "Choose Playlist", "Intent", "Scan Options", "Analyze", "Results"];

export default function WizardPage(): ReactElement {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [scanOptions, setScanOptions] = useState<ScanOptions>({});
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  const [resumeAvailable, setResumeAvailable] = useState(false);

  useEffect(() => {
    if (!getClientId()) return;

    const saved = loadScanState();
    if (saved && saved.allResults.length > 0) {
      setResumeAvailable(true);
      const sorted = [...saved.allResults].sort((a, b) => b.score - a.score);
      setPipelineResult({
        tasteVector: { mean: {}, std: {}, minVal: {}, maxVal: {}, sampleCount: 0 },
        coreGenres: [],
        tracksAnalyzed: 0,
        tracksWithFeatures: 0,
        candidateArtists: 0,
        genrePassed: 0,
        candidateTracks: sorted.length,
        scored: sorted.length,
        results: sorted,
      });
      setSelectedPlaylist({
        id: saved.sourcePlaylistId,
        name: saved.sourcePlaylistName,
        images: [],
        tracks: { total: 0 },
        owner: { display_name: "" },
      });
    }

    if (getAccessToken()) {
      getCurrentUser()
        .then((u) => { setUser(u); setStep(3); })
        .catch(() => setStep(2));
    } else {
      setStep(2);
    }
  }, []);

  const handlePlaylistSelect = useCallback((pl: SpotifyPlaylist) => {
    setSelectedPlaylist(pl);
    setStep(4);
  }, []);

  const handleIntentConfirmed = useCallback(
    (intent: Intent | null, intentText: string) => {
      if (intent && selectedPlaylist) {
        setIntent(selectedPlaylist.id, intent, intentText);
        setScanOptions((prev) => ({ ...prev, intent: intent ?? undefined }));
      }
      setStep(5);
    },
    [selectedPlaylist],
  );

  const handleScanOptionsConfirmed = useCallback((opts: ScanOptions) => {
    setScanOptions(opts);
    setStep(6);
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setStep(7);
  }, []);

  return (
    <WizardLayout step={step} totalSteps={7} stepName={STEP_NAMES[step - 1]}>
      {/* Resume banner */}
      {resumeAvailable && step === 3 && (
        <div className="mb-4 p-3 bg-yellow-950/30 border border-yellow-700 rounded-xl flex items-center justify-between gap-3 text-sm">
          <span className="text-yellow-300">A previous scan was interrupted. Resume?</span>
          <button
            onClick={() => setStep(7)}
            className="px-3 py-1 bg-yellow-600 hover:bg-yellow-500 rounded-lg font-semibold text-xs transition-colors"
          >
            Resume
          </button>
        </div>
      )}

      {step === 1 && <SetupStep onComplete={() => setStep(2)} />}

      {step === 2 && (
        <div className="text-center space-y-6">
          <h2 className="text-3xl font-bold">Connect Your Spotify</h2>
          <p className="text-[var(--text-secondary)]">
            SoundFox needs access to your playlists. We never store your data on any server.
          </p>
          <button
            onClick={() => { startLogin().catch(console.error); }}
            className="px-8 py-4 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-lg transition-colors"
          >
            Connect with Spotify
          </button>
          {user && (
            <p className="text-[var(--text-secondary)]">
              Connected as <strong className="text-white">{user.display_name}</strong>
            </p>
          )}
        </div>
      )}

      {step === 3 && <PlaylistStep onSelect={handlePlaylistSelect} />}

      {step === 4 && selectedPlaylist && (
        <IntentStep
          playlistId={selectedPlaylist.id}
          playlistContext={{
            name: selectedPlaylist.name,
            topArtists: [],
            topGenres: [],
            trackCount: selectedPlaylist.tracks.total,
          }}
          onContinue={handleIntentConfirmed}
        />
      )}

      {step === 5 && selectedPlaylist && (
        <ScanOptionsStep playlist={selectedPlaylist} onStart={handleScanOptionsConfirmed} />
      )}

      {step === 6 && selectedPlaylist && (
        <AnalysisStep
          playlist={selectedPlaylist}
          scanOptions={scanOptions}
          onComplete={handleAnalysisComplete}
        />
      )}

      {step === 7 && pipelineResult && selectedPlaylist && (
        <ResultsStep
          result={pipelineResult}
          playlistName={selectedPlaylist.name}
          playlistId={selectedPlaylist.id}
          onBack={() => {
            setPipelineResult(null);
            setSelectedPlaylist(null);
            setStep(3);
          }}
        />
      )}
    </WizardLayout>
  );
}
