"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { getClientId, setClientId } from "@/lib/storage";

interface SetupStepProps {
  onComplete: () => void;
}

export default function SetupStep({ onComplete }: SetupStepProps): ReactElement {
  // Hydration-safe: start empty on SSR + first client render, then populate from localStorage
  const [clientId, setClientIdValue] = useState("");
  const [error, setError] = useState("");
  const [showWhy, setShowWhy] = useState(false);
  const [isLocalhost, setIsLocalhost] = useState(false);
  const [port, setPort] = useState("3000");

  useEffect(() => {
    setClientIdValue(getClientId() ?? "");
    setIsLocalhost(window.location.hostname === "localhost");
    setPort(window.location.port);
  }, []);

  const redirectUri = `http://127.0.0.1:${port}/callback`;

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
        <p className="text-[var(--text-secondary)]">
          To use SoundFox you need a free Spotify Developer app. It takes 2 minutes.
        </p>
        <button
          onClick={() => setShowWhy(!showWhy)}
          className="text-[var(--accent)] text-sm underline mt-2"
        >
          {showWhy ? "Hide" : "Why do I need this?"}
        </button>
        {showWhy && (
          <div className="mt-3 bg-[var(--bg-card)] rounded-lg p-4 text-sm text-[var(--text-secondary)] border border-[var(--border)]">
            <p className="mb-2">
              SoundFox is 100% open source and runs entirely on your computer. We never store your Spotify
              credentials on any server.
            </p>
            <p className="mb-2">
              To access YOUR playlists, Spotify requires YOU to create a &quot;developer app&quot; on their
              platform — think of it as giving SoundFox a key to your Spotify account. Only you have this key.
            </p>
            <p>
              This means: no shared rate limits, no tracking, no company in the middle. Your keys, your data.
            </p>
          </div>
        )}
      </div>

      {isLocalhost && (
        <div className="bg-yellow-900/40 border border-yellow-600/50 rounded-xl p-4">
          <p className="text-yellow-200 text-sm mb-2">
            <strong>Important:</strong> You&apos;re accessing this app via <code>localhost</code>.
            Spotify rejects <code>localhost</code> as insecure for OAuth.
          </p>
          <p className="text-yellow-200 text-sm">
            Please reopen the app at{" "}
            <a href={`http://127.0.0.1:${port}`} className="underline font-mono font-bold">
              http://127.0.0.1:{port}
            </a>
            {" "}(same machine, just a different address).
          </p>
        </div>
      )}

      <div className="bg-[var(--bg-card)] rounded-xl p-6 space-y-5 border border-[var(--border)]">
        <h3 className="text-lg font-semibold">Setup steps:</h3>

        <div className="space-y-4 text-[var(--text-secondary)]">
          {/* Step 1 */}
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-black font-bold flex items-center justify-center">1</span>
            <div className="flex-1 pt-0.5">
              <p>
                Go to{" "}
                <a href="https://developer.spotify.com/" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">
                  developer.spotify.com
                </a>{" "}
                and <strong className="text-white">log in</strong>
              </p>
              <p className="text-sm opacity-70 mt-1">
                Use the same Spotify account where your playlists are. This is just regular Spotify login —
                no special developer account needed.
              </p>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-black font-bold flex items-center justify-center">2</span>
            <div className="flex-1 pt-0.5">
              <p>
                Click your <strong className="text-white">profile picture</strong> (top-right corner) and select{" "}
                <strong className="text-white">Dashboard</strong>
              </p>
              <p className="text-sm opacity-70 mt-1">
                The Dashboard is where you manage your Spotify developer apps.
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-black font-bold flex items-center justify-center">3</span>
            <div className="flex-1 pt-0.5">
              <p>
                Click <strong className="text-white">Create App</strong> (big green button)
              </p>
            </div>
          </div>

          {/* Step 4 */}
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-black font-bold flex items-center justify-center">4</span>
            <div className="flex-1 pt-0.5">
              <p className="mb-2">Fill in the form:</p>

              <div className="space-y-3 bg-[var(--bg-secondary)] rounded-lg p-4 text-sm">
                <div>
                  <p className="text-white font-semibold">App name</p>
                  <p className="opacity-70">Anything. &quot;SoundFox&quot; works. This is just a label for you.</p>
                </div>

                <div>
                  <p className="text-white font-semibold">App description</p>
                  <p className="opacity-70">Anything. Spotify requires a description but doesn&apos;t validate it.</p>
                </div>

                <div>
                  <p className="text-white font-semibold">Redirect URI</p>
                  <p className="opacity-70 mb-2">
                    This is where Spotify sends you back after login. Copy exactly:
                  </p>
                  <code className="block bg-black/40 px-3 py-2 rounded border border-[var(--border)] text-[var(--accent)] font-mono text-sm select-all cursor-pointer">
                    {redirectUri}
                  </code>
                  <p className="opacity-70 text-xs mt-2">
                    <strong>Why 127.0.0.1 and not localhost?</strong> They mean the same thing (&quot;your own computer&quot;),
                    but Spotify only accepts <code>127.0.0.1</code>. This address works identically on every
                    computer — it&apos;s not your personal IP.
                  </p>
                </div>

                <div>
                  <p className="text-white font-semibold">Which API/SDKs are you planning to use?</p>
                  <p className="opacity-70">Check <strong className="text-white">Web API</strong>. Leave the others unchecked.</p>
                </div>
              </div>

              <p className="text-sm opacity-70 mt-2">
                Accept the terms and click <strong className="text-white">Save</strong>.
              </p>
            </div>
          </div>

          {/* Step 5 */}
          <div className="flex gap-3">
            <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[var(--accent)] text-black font-bold flex items-center justify-center">5</span>
            <div className="flex-1 pt-0.5">
              <p>
                On your new app&apos;s page, find <strong className="text-white">Client ID</strong> and click to copy it
              </p>
              <p className="text-sm opacity-70 mt-1">
                It&apos;s a 32-character string like <code className="font-mono">abcdef1234567890abcdef1234567890</code>.
                Paste it below.
              </p>
              <p className="text-sm opacity-70 mt-1">
                <strong className="text-white">Don&apos;t confuse</strong> Client ID with Client Secret — we only need Client ID.
                Never share your Client Secret.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Paste your Client ID here:</label>
        <input
          type="text"
          value={clientId}
          onChange={(e) => { setClientIdValue(e.target.value); setError(""); }}
          placeholder="e.g. abcdef1234567890abcdef1234567890"
          className="w-full px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] text-white placeholder-gray-500 font-mono"
        />
        {error && <p className="text-red-400 text-sm mt-1">{error}</p>}
        <p className="text-xs text-[var(--text-secondary)] mt-2">
          Saved only on this device, in your browser&apos;s localStorage. Never sent anywhere.
        </p>
      </div>

      <button
        onClick={handleSubmit}
        disabled={isLocalhost}
        className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLocalhost ? "Switch to 127.0.0.1 first" : "Continue"}
      </button>
    </div>
  );
}
