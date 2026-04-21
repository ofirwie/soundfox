"use client";

import type { ReactElement } from "react";
import type { WhyBreakdown } from "@/lib/scoring";

interface WhyPanelProps {
  breakdown: WhyBreakdown;
}

function fmt(v: number, key: string): string {
  if (key === "tempo") return `${Math.round(v)} BPM`;
  if (key === "loudness") return `${v.toFixed(1)} dB`;
  return `${Math.round(v * 100)}%`;
}

export default function WhyPanel({ breakdown }: WhyPanelProps): ReactElement {
  return (
    <div className="mt-2 px-3 pb-3 space-y-3 text-xs" data-testid="why-panel">
      {/* Cluster */}
      {breakdown.cluster && (
        <div className="flex items-center gap-2">
          <span className="text-[var(--text-secondary)]">Cluster:</span>
          <span className="font-semibold text-[var(--accent)] capitalize">{breakdown.cluster.label}</span>
          <span className="text-[var(--text-secondary)]">
            (distance {breakdown.cluster.distance.toFixed(3)})
          </span>
        </div>
      )}

      {/* Audio features table */}
      {breakdown.audio.length > 0 && (
        <div>
          <p className="text-[var(--text-secondary)] mb-1 uppercase tracking-wider text-[10px]">Audio match</p>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-[var(--text-secondary)] text-[10px]">
                <th className="text-left py-0.5 pr-2">Feature</th>
                <th className="text-right py-0.5 pr-2">Track</th>
                <th className="text-right py-0.5">Cluster avg</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.audio.map(({ feature, value, clusterMean, withinStd }) => (
                <tr key={feature} className={withinStd ? "text-white" : "text-[var(--text-secondary)]"}>
                  <td className="py-0.5 pr-2 capitalize">{feature}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">{fmt(value, feature)}</td>
                  <td className="py-0.5 text-right tabular-nums text-[var(--text-secondary)]">{fmt(clusterMean, feature)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Genres */}
      {breakdown.genres.matched.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-[var(--text-secondary)]">Genres:</span>
          {breakdown.genres.matched.map((g) => (
            <span key={g} className="px-1.5 py-0.5 bg-[var(--accent)]/10 text-[var(--accent)] rounded text-[10px]">{g}</span>
          ))}
        </div>
      )}

      {/* LLM rationale */}
      {breakdown.llm && (
        <div>
          <span className="text-[var(--text-secondary)]">LLM: </span>
          <span className="italic">{breakdown.llm.why}</span>
        </div>
      )}

      {/* Sources */}
      <div className="flex items-center gap-1">
        <span className="text-[var(--text-secondary)]">Source:</span>
        {breakdown.sources.map((s) => (
          <span key={s} className="px-1.5 py-0.5 bg-[var(--bg-secondary)] rounded text-[10px] uppercase tracking-wider">{s}</span>
        ))}
      </div>
    </div>
  );
}
