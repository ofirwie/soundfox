import type { AudioFeatures, FeatureKey } from "./reccobeats";
import type { TasteClusters } from "./clustering";
import type { TasteVector } from "./taste-engine";

export interface WhyBreakdown {
  score: number;
  cluster: { id: number; label: string; distance: number; centroid: Record<string, number> } | null;
  audio: Array<{ feature: string; value: number; clusterMean: number; withinStd: boolean }>;
  genres: { matched: string[]; required: number; total: number };
  llm: { why: string; confidence: number } | null;
  sources: string[];
}

const DISPLAY_FEATURES: FeatureKey[] = [
  "energy", "valence", "tempo", "acousticness", "danceability",
  "instrumentalness", "speechiness",
];

export function buildWhyBreakdown(params: {
  score: number;
  features: AudioFeatures;
  clusters?: TasteClusters;
  clusterId?: number;
  clusterDistance?: number;
  tasteVector: TasteVector;
  matchedGenres: string[];
  coreGenreCount: number;
  llmWhy?: string;
  sources: string[];
}): WhyBreakdown {
  const { score, features, clusters, clusterId, clusterDistance, tasteVector, matchedGenres, coreGenreCount, llmWhy, sources } = params;

  const clusterObj = (clusters && clusterId !== undefined)
    ? (clusters.clusters[clusterId] ?? null)
    : null;

  // Audio feature comparison: value vs cluster centroid (or global mean fallback)
  const referenceMeans = clusterObj ? clusterObj.centroid : tasteVector.mean;
  const audio = DISPLAY_FEATURES
    .map((key) => {
      const value = features[key];
      const clusterMean = referenceMeans[key] ?? tasteVector.mean[key];
      if (value == null || clusterMean == null) return null;
      const std = tasteVector.std[key] ?? 0;
      const withinStd = std > 0 ? Math.abs(value - (tasteVector.mean[key] ?? clusterMean)) <= std * 1.5 : true;
      return { feature: key, value, clusterMean, withinStd };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return {
    score,
    cluster: clusterObj
      ? { id: clusterObj.id, label: clusterObj.label, distance: clusterDistance ?? 0, centroid: clusterObj.centroid }
      : null,
    audio,
    genres: { matched: matchedGenres, required: matchedGenres.length, total: coreGenreCount },
    llm: llmWhy ? { why: llmWhy, confidence: 1 } : null,
    sources,
  };
}
