"use client";

import { useState, useEffect } from "react";
import type { ReactElement } from "react";
import { parseIntentViaLLM, type Intent } from "@/lib/llm-source";
import { loadProfile } from "@/lib/profile";
import IntentEditor from "./IntentEditor";

interface Props {
  playlistId: string;
  playlistContext: { name: string; topArtists: string[]; topGenres: string[]; trackCount: number };
  onContinue: (intent: Intent | null, intentText: string) => void;
}

export default function IntentStep({ playlistId, playlistContext, onContinue }: Props): ReactElement {
  const [freeText, setFreeText] = useState("");
  const [parsed, setParsed] = useState<Intent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingIntent, setExistingIntent] = useState<{ intent: Intent; text: string } | null>(null);
  const [showChangeForm, setShowChangeForm] = useState(false);

  useEffect(() => {
    const profile = loadProfile(playlistId);
    if (profile?.intent) {
      setExistingIntent({ intent: profile.intent, text: profile.intentText ?? "" });
    }
  }, [playlistId]);

  async function handleParse(): Promise<void> {
    if (!freeText.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await parseIntentViaLLM(freeText, playlistContext);
      if (!result) {
        setError("Couldn't reach the server. Check your connection.");
        return;
      }
      setParsed(result);
    } finally {
      setLoading(false);
    }
  }

  // Returning user: show run-again / change-intent choice
  if (existingIntent && !showChangeForm) {
    return (
      <div className="space-y-6 max-w-xl mx-auto">
        <div>
          <h2 className="text-2xl font-bold mb-1">Run again?</h2>
          <p className="text-[var(--text-secondary)] text-sm">
            Your last intent: <em>{existingIntent.text || existingIntent.intent.purpose}</em>
          </p>
        </div>
        <button
          type="button"
          onClick={() => onContinue(existingIntent.intent, existingIntent.text)}
          className="w-full py-3 bg-green-700 hover:bg-green-600 rounded-xl font-semibold transition-colors"
        >
          Run again
        </button>
        <button
          type="button"
          onClick={() => setShowChangeForm(true)}
          className="w-full py-2 text-sm text-[var(--text-secondary)] hover:text-white border border-[var(--border)] rounded-xl transition-colors"
        >
          Change intent
        </button>
        <button
          type="button"
          onClick={() => onContinue(null, "")}
          className="w-full py-2 text-sm text-[var(--text-secondary)] hover:text-white transition-colors"
        >
          Skip — scan without intent
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-xl mx-auto">
      <div>
        <h2 className="text-2xl font-bold mb-1">What are you looking for?</h2>
        <p className="text-[var(--text-secondary)] text-sm">
          Describe in your own words — e.g. &ldquo;high energy workout, 120+ BPM, no ballads&rdquo;
        </p>
      </div>

      <textarea
        rows={4}
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder="Type what you want…"
        className="w-full bg-[var(--bg-secondary)] rounded-xl px-4 py-3 outline-none resize-none text-sm"
      />

      <button
        type="button"
        onClick={() => { handleParse().catch(console.error); }}
        disabled={loading || !freeText.trim()}
        className="px-6 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-50 rounded-xl font-semibold transition-colors"
      >
        {loading ? "Parsing…" : "Parse"}
      </button>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {parsed && (
        <div className="space-y-4">
          {parsed.intentParseFailed && (
            <div
              role="alert"
              className="px-4 py-3 bg-yellow-950/40 border border-yellow-700 rounded-xl text-yellow-300 text-sm"
            >
              Couldn&apos;t fully understand — here&apos;s a safe default. Edit it below.
            </div>
          )}

          <div className="bg-[var(--bg-secondary)] rounded-xl p-4">
            <p className="text-xs text-[var(--text-secondary)] mb-3 uppercase tracking-wide">
              Parsed intent
            </p>
            <IntentEditor intent={parsed} onChange={setParsed} />
          </div>

          <button
            type="button"
            onClick={() => onContinue(parsed, freeText)}
            className="w-full py-3 bg-green-700 hover:bg-green-600 rounded-xl font-semibold transition-colors"
          >
            Continue
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => onContinue(null, "")}
        className="w-full py-2 text-sm text-[var(--text-secondary)] hover:text-white transition-colors"
      >
        Skip — scan without intent
      </button>
    </div>
  );
}
