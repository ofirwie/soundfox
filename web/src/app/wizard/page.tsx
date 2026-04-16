"use client";

import { useState, useEffect, useCallback } from "react";
import WizardLayout from "@/components/WizardLayout";
import SetupStep from "@/components/SetupStep";
import PlaylistStep from "@/components/PlaylistStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import { getClientId, getAccessToken } from "@/lib/storage";
import { startLogin } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult } from "@/lib/discovery-pipeline";

const STEP_NAMES = ["Setup", "Connect", "Choose Playlist", "Analyze", "Results"];

export default function WizardPage(): React.ReactElement {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);

  useEffect(() => {
    if (getClientId()) {
      if (getAccessToken()) {
        getCurrentUser().then((u) => { setUser(u); setStep(3); }).catch(() => setStep(2));
      } else {
        setStep(2);
      }
    }
  }, []);

  const handlePlaylistSelect = useCallback((pl: SpotifyPlaylist) => {
    setSelectedPlaylist(pl);
    setStep(4);
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setStep(5);
  }, []);

  return (
    <WizardLayout step={step} totalSteps={5} stepName={STEP_NAMES[step - 1]}>
      {step === 1 && <SetupStep onComplete={() => setStep(2)} />}

      {step === 2 && (
        <div className="text-center space-y-6">
          <h2 className="text-3xl font-bold">Connect Your Spotify</h2>
          <p className="text-[var(--text-secondary)]">
            SoundFox needs access to your playlists. We never store your data on any server.
          </p>
          <button onClick={() => { startLogin().catch(console.error); }}
            className="px-8 py-4 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-lg transition-colors">
            Connect with Spotify
          </button>
          {user && <p className="text-[var(--text-secondary)]">Connected as <strong className="text-white">{user.display_name}</strong></p>}
        </div>
      )}

      {step === 3 && <PlaylistStep onSelect={handlePlaylistSelect} />}

      {step === 4 && selectedPlaylist && (
        <AnalysisStep playlist={selectedPlaylist} onComplete={handleAnalysisComplete} />
      )}

      {step === 5 && pipelineResult && selectedPlaylist && (
        <ResultsStep result={pipelineResult} playlistName={selectedPlaylist.name} playlistId={selectedPlaylist.id} />
      )}
    </WizardLayout>
  );
}
