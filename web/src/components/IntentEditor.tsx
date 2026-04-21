"use client";

import { useState, useEffect } from "react";
import type { ReactElement } from "react";
import type { Intent } from "@/lib/intent-types";
import { QUALITY_TIERS, type QualityTier } from "@/lib/intent-types";

interface Props {
  intent: Intent;
  onChange: (updated: Intent) => void;
}

function qualityTierFromThreshold(threshold: number): QualityTier {
  if (threshold >= QUALITY_TIERS.premium) return "premium";
  if (threshold >= QUALITY_TIERS.balanced) return "balanced";
  return "inclusive";
}

function ChipInput({
  chips,
  onChange,
  placeholder,
}: {
  chips: string[];
  onChange: (chips: string[]) => void;
  placeholder: string;
}): ReactElement {
  const [input, setInput] = useState("");

  function add(): void {
    const val = input.trim();
    if (val && !chips.includes(val)) onChange([...chips, val]);
    setInput("");
  }

  return (
    <div className="flex flex-wrap gap-1 items-center">
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-xs"
        >
          {chip}
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => onChange(chips.filter((c) => c !== chip))}
            className="hover:text-red-400"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
        }}
        placeholder={placeholder}
        className="bg-transparent outline-none text-sm min-w-[120px]"
      />
    </div>
  );
}

export default function IntentEditor({ intent, onChange }: Props): ReactElement {
  const [local, setLocal] = useState<Intent>(intent);
  const [tempoError, setTempoError] = useState<string | null>(null);

  useEffect(() => { setLocal(intent); }, [intent]);

  function update(patch: Partial<Intent>): void {
    setLocal((prev) => ({ ...prev, ...patch }));
  }

  function updateAudio(patch: Partial<Intent["audioConstraints"]>): void {
    setLocal((prev) => ({
      ...prev,
      audioConstraints: { ...prev.audioConstraints, ...patch },
    }));
  }

  function handleApply(): void {
    const { tempoMin, tempoMax } = local.audioConstraints;
    if (tempoMin !== undefined && tempoMax !== undefined && tempoMin > tempoMax) {
      setTempoError("Tempo min cannot exceed tempo max");
      return;
    }
    setTempoError(null);
    onChange(local);
  }

  const qualityTier = qualityTierFromThreshold(local.qualityThreshold);

  return (
    <div className="space-y-4 text-sm">
      {/* Purpose */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Purpose</label>
        <input
          type="text"
          value={local.purpose}
          onChange={(e) => update({ purpose: e.target.value })}
          className="w-full bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
          placeholder="e.g. workout, chill evening, cover band"
        />
      </div>

      {/* Tempo */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Tempo (BPM)</label>
        <div className="flex gap-2 items-center">
          <input
            type="number"
            value={local.audioConstraints.tempoMin ?? ""}
            onChange={(e) => updateAudio({ tempoMin: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="Min"
            aria-label="Tempo min"
            className="w-24 bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
          />
          <span className="text-[var(--text-secondary)]">–</span>
          <input
            type="number"
            value={local.audioConstraints.tempoMax ?? ""}
            onChange={(e) => updateAudio({ tempoMax: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="Max"
            aria-label="Tempo max"
            className="w-24 bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
          />
        </div>
        {tempoError && (
          <p role="alert" className="text-red-400 text-xs mt-1">{tempoError}</p>
        )}
      </div>

      {/* Energy */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Energy (0–1)</label>
        <div className="flex gap-2 items-center">
          <input
            type="number" step="0.05" min="0" max="1"
            value={local.audioConstraints.energyMin ?? ""}
            onChange={(e) => updateAudio({ energyMin: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="Min"
            aria-label="Energy min"
            className="w-24 bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
          />
          <span className="text-[var(--text-secondary)]">–</span>
          <input
            type="number" step="0.05" min="0" max="1"
            value={local.audioConstraints.energyMax ?? ""}
            onChange={(e) => updateAudio({ energyMax: e.target.value ? Number(e.target.value) : undefined })}
            placeholder="Max"
            aria-label="Energy max"
            className="w-24 bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
          />
        </div>
      </div>

      {/* Popularity hint */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Popularity</label>
        <div className="flex gap-2">
          {(["low", "mid", "high"] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() =>
                updateAudio({ popularityHint: local.audioConstraints.popularityHint === h ? undefined : h })
              }
              className={`px-3 py-1 rounded-full text-xs border transition-colors ${
                local.audioConstraints.popularityHint === h
                  ? "bg-green-700 border-green-500 text-white"
                  : "border-[var(--border)] text-[var(--text-secondary)] hover:border-green-600"
              }`}
            >
              {h}
            </button>
          ))}
        </div>
      </div>

      {/* Genres */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Include genres</label>
        <div className="bg-[var(--bg-secondary)] rounded-lg px-3 py-2">
          <ChipInput
            chips={local.genres.include}
            onChange={(chips) => update({ genres: { ...local.genres, include: chips } })}
            placeholder="add genre…"
          />
        </div>
      </div>
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Exclude genres</label>
        <div className="bg-[var(--bg-secondary)] rounded-lg px-3 py-2">
          <ChipInput
            chips={local.genres.exclude}
            onChange={(chips) => update({ genres: { ...local.genres, exclude: chips } })}
            placeholder="exclude genre…"
          />
        </div>
      </div>

      {/* Era */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Era (optional)</label>
        <input
          type="text"
          value={local.era ?? ""}
          onChange={(e) => update({ era: e.target.value || null })}
          placeholder="e.g. 1990-2010"
          className="w-full bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
        />
      </div>

      {/* Requirements */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Requirements (one per line)</label>
        <textarea
          rows={3}
          value={local.requirements.join("\n")}
          onChange={(e) =>
            update({
              requirements: e.target.value
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          className="w-full bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none resize-none"
          placeholder="singable chorus, crowd-pleaser…"
        />
      </div>

      {/* Allow known artists */}
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={local.allowKnownArtists}
          onChange={(e) => update({ allowKnownArtists: e.target.checked })}
          className="accent-green-500"
        />
        <span>Allow known artists</span>
      </label>

      {/* Quality tier */}
      <div>
        <label className="block text-[var(--text-secondary)] mb-1">Quality tier</label>
        <select
          value={qualityTier}
          onChange={(e) => update({ qualityThreshold: QUALITY_TIERS[e.target.value as QualityTier] })}
          className="bg-[var(--bg-secondary)] rounded-lg px-3 py-2 outline-none"
        >
          <option value="premium">Premium (strict)</option>
          <option value="balanced">Balanced</option>
          <option value="inclusive">Inclusive (lenient)</option>
        </select>
      </div>

      {/* Apply */}
      <button
        type="button"
        onClick={handleApply}
        className="w-full py-2 bg-green-700 hover:bg-green-600 rounded-xl font-semibold transition-colors"
      >
        Apply
      </button>
    </div>
  );
}
