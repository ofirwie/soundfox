import type { TasteVector, TasteClusters } from "../taste-engine";
import type { SpotifyTrack, SpotifyArtist } from "../spotify-client";
import type { WhyBreakdown } from "../scoring";

export interface PipelineProgress {
  phase: string;
  message: string;
  percent: number;
}

export interface ScoredTrack {
  track: SpotifyTrack;
  score: number;
  artist: SpotifyArtist;
  matchedGenres: string[];
  sourceTags?: string[];
  llmWhy?: string;
  clusterId?: number;
  clusterDistance?: number;
  breakdown?: WhyBreakdown;
}

export type { TasteClusters, WhyBreakdown };

export interface Candidate {
  track: SpotifyTrack;
  artist: SpotifyArtist;
  sourceTags: string[];
  matchedGenres: string[];
  llmWhy?: string;
}

export interface PipelineResult {
  tasteVector: TasteVector;
  tasteClusters?: TasteClusters;
  coreGenres: string[];
  tracksAnalyzed: number;
  tracksWithFeatures: number;
  candidateArtists: number;
  genrePassed: number;
  candidateTracks: number;
  scored: number;
  results: ScoredTrack[];
  qualityThresholdApplied?: number;
}

export type BatchUpdate =
  | {
      batch: ScoredTrack[];
      totalFound: number;
      phase: string;
      message: string;
      percent: number;
      done: false;
    }
  | {
      batch: [];
      totalFound: number;
      phase: "done";
      message: string;
      percent: 100;
      done: true;
      tasteVector: TasteVector;
      tasteClusters?: TasteClusters;
      qualityThresholdApplied?: number;
      coreGenres: string[];
      tracksAnalyzed: number;
      tracksWithFeatures: number;
      candidateArtists: number;
      genrePassed: number;
      candidateTracks: number;
      scored: number;
    };

export interface ScanOptions {
  resultCount?: number;
  minYear?: number;
  allowKnownArtists?: boolean;
  signal?: AbortSignal;
  blacklist?: import("../profile").BlacklistEntry;
  intent?: import("../intent-types").Intent;
  /** Phase 8: genre weights from rejection/acceptance history (1.0=neutral, 0.3=min) */
  genreWeights?: Record<string, number>;
  /** Phase 8: refined clusters from accepted tracks — replaces autoK clusters when set */
  refinedClusters?: import("../clustering").TasteClusters;
}
