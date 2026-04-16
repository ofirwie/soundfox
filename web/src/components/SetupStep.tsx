"use client";

import { useState } from "react";
import { getClientId, setClientId } from "@/lib/storage";

interface SetupStepProps {
  onComplete: () => void;
}

export default function SetupStep({ onComplete }: SetupStepProps): React.ReactElement {
  const [clientId, setClientIdValue] = useState(() => {
    if (typeof window === "undefined") return "";
    return getClientId() ?? "";
  });
  const [error, setError] = useState("");

  function handleSubmit(): void {
    const trimmed = clientId.trim();
    if (trimmed.length < 10) {
      setError("That doesn't look like a valid Client ID");
      return;
    }
    setClientId(trimmed);
    onComplete();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Welcome to SoundFox</h2>
        <p className="text-[var(--text-secondary)]">To get started, you need a free Spotify Developer app.</p>
      </div>

      <div className="bg-[var(--bg-card)] rounded-xl p-6 space-y-4 border border-[var(--border)]">
        <h3 className="text-lg font-semibold">How to get your Client ID:</h3>
        <ol className="list-decimal list-inside space-y-2 text-[var(--text-secondary)]">
          <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">developer.spotify.com/dashboard</a></li>
          <li>Click <strong className="text-white">Create App</strong></li>
          <li>Name it anything (e.g. &quot;SoundFox&quot;)</li>
          <li>Set Redirect URI to: <code className="bg-[var(--bg-secondary)] px-2 py-1 rounded text-sm">{typeof window !== "undefined" ? `${window.location.origin}/callback` : "http://localhost:3000/callback"}</code></li>
          <li>Check <strong className="text-white">Web API</strong> under APIs</li>
          <li>Copy the <strong className="text-white">Client ID</strong></li>
        </ol>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Your Spotify Client ID</label>
        <input type="text" value={clientId} onChange={(e) => { setClientIdValue(e.target.value); setError(""); }}
          placeholder="e.g. abcdef1234567890abcdef1234567890"
          className="w-full px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] text-white placeholder-gray-500" />
        {error && <p className="text-red-400 text-sm mt-1">{error}</p>}
      </div>

      <button onClick={handleSubmit} className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors">
        Continue
      </button>
    </div>
  );
}
