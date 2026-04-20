"use client";

import { useState, useEffect, useCallback } from "react";
import WizardLayout from "@/components/WizardLayout";
import SetupStep from "@/components/SetupStep";
import PlaylistStep from "@/components/PlaylistStep";
import ScanOptionsStep from "@/components/ScanOptionsStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import { getClientId, getAccessToken, loadScanState } from "@/lib/storage";
import { startLogin } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult, type ScanOptions } from "@/lib/discovery-pipeline";

const STEP_NAMES = ["Setup", "Connect", "Choose Playlist", "Scan Options", "Analyze", "Results"];

export default function WizardPage(): React.ReactElement {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  // H5: scanOptions is set once by handleScanOptionsConfirmed and never mutated.
  // useState is sufficient here because setScanOptions is called with a fresh object
  // only when the user confirms options — it is not rebuilt on every render.
  const [scanOptions, setScanOptions] = useState<ScanOptions>({});
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);
  // Resume banner: show if a previous partial scan is available
  const [resumeAvailable, setResumeAvailable] = useState(false);

  useEffect(() => {
    if (!getClientId()) return;

    // Check for resumable scan and pre-populate result so "Resume" goes straight to ResultsStep [C2]
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

  const handleScanOptionsConfirmed = useCallback((opts: ScanOptions) => {
    setScanOptions(opts);
    setStep(5);
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setStep(6);
  }, []);

  return (
    <WizardLayout step={step} totalSteps={6} stepName={STEP_NAMES[step - 1]}>
      {/* Resume banner */}
      {resumeAvailable && step === 3 && (
        <div className="mb-4 p-3 bg-yellow-950/30 border border-yellow-700 rounded-xl flex items-center justify-between gap-3 text-sm">
          <span className="text-yellow-300">A previous scan was interrupted. Resume?</span>
          <button
            onClick={() => setStep(6)} // Jump straight to results with saved state
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
        <ScanOptionsStep playlist={selectedPlaylist} onStart={handleScanOptionsConfirmed} />
      )}

      {step === 5 && selectedPlaylist && (
        <AnalysisStep
          playlist={selectedPlaylist}
          scanOptions={scanOptions}
          onComplete={handleAnalysisComplete}
        />
      )}

      {step === 6 && pipelineResult && selectedPlaylist && (
        <ResultsStep
          result={pipelineResult}
          playlistName={selectedPlaylist.name}
          playlistId={selectedPlaylist.id}
        />
      )}
    </WizardLayout>
  );
}
