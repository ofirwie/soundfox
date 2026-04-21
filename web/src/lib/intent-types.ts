export interface Intent {
  purpose: string;
  audioConstraints: {
    tempoMin?: number;
    tempoMax?: number;
    energyMin?: number;
    energyMax?: number;
    valenceMin?: number;
    valenceMax?: number;
    popularityHint?: "low" | "mid" | "high";
  };
  genres: { include: string[]; exclude: string[] };
  era?: string | null;
  requirements: string[];
  allowKnownArtists: boolean;
  qualityThreshold: number;
  notes: string;
  /** Set true when the server couldn't parse and returned a safe default (fix-H9) */
  intentParseFailed?: boolean;
}

export interface LLMRecommendation {
  artist: string;
  track: string;
  why: string;
  confidence: number;
}

/** Calibrated quality thresholds — values come from Phase 4 H5 calibration task */
export const QUALITY_TIERS = {
  premium: 0.75,
  balanced: 0.60,
  inclusive: 0.40,
} as const;
export type QualityTier = keyof typeof QUALITY_TIERS;

/** Safe default intent used when Gemini parse fails after retry (fix-H9) */
export function defaultIntent(): Intent {
  return {
    purpose: "general",
    audioConstraints: {},
    genres: { include: [], exclude: [] },
    era: null,
    requirements: [],
    allowKnownArtists: true,
    qualityThreshold: QUALITY_TIERS.balanced,
    notes: "Safe default — Gemini parse failed, user should edit",
    intentParseFailed: true,
  };
}
