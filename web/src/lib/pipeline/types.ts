import type { TasteVector } from "../taste-engine";
import type { SpotifyTrack, SpotifyArtist } from "../spotify-client";

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
}

export interface PipelineResult {
  tasteVector: TasteVector;
  coreGenres: string[];
  tracksAnalyzed: number;
  tracksWithFeatures: number;
  candidateArtists: number;
  genrePassed: number;
  candidateTracks: number;
  scored: number;
  results: ScoredTrack[];
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
}
