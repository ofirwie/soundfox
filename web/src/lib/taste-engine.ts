import { FEATURE_KEYS, type AudioFeatures, type FeatureKey } from "./reccobeats";

export interface TasteVector {
  mean: Partial<Record<FeatureKey, number>>;
  std: Partial<Record<FeatureKey, number>>;
  minVal: Partial<Record<FeatureKey, number>>;
  maxVal: Partial<Record<FeatureKey, number>>;
  sampleCount: number;
}

/**
 * Build a taste vector from a map of trackId -> AudioFeatures.
 * Calculates mean, std, min, max for each feature dimension.
 */
export function buildTasteVector(featuresByTrack: Map<string, AudioFeatures>): TasteVector {
  const tv: TasteVector = {
    mean: {},
    std: {},
    minVal: {},
    maxVal: {},
    sampleCount: featuresByTrack.size,
  };

  if (featuresByTrack.size === 0) return tv;

  // Collect all values per feature
  const featureValues: Record<FeatureKey, number[]> = {} as Record<FeatureKey, number[]>;
  for (const key of FEATURE_KEYS) {
    featureValues[key] = [];
  }

  for (const features of featuresByTrack.values()) {
    for (const key of FEATURE_KEYS) {
      if (features[key] != null) {
        featureValues[key].push(features[key]);
      }
    }
  }

  for (const key of FEATURE_KEYS) {
    const vals = featureValues[key];
    if (vals.length === 0) continue;

    const n = vals.length;
    const mean = vals.reduce((sum, v) => sum + v, 0) / n;
    const variance = n > 1
      ? vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
      : 0;

    tv.mean[key] = mean;
    tv.std[key] = Math.sqrt(variance);
    tv.minVal[key] = Math.min(...vals);
    tv.maxVal[key] = Math.max(...vals);
  }

  return tv;
}

/**
 * Normalize features to roughly 0-1 scale.
 * Loudness: typically -60 to 0 dB -> (v + 60) / 60
 * Tempo: typically 60-200 BPM -> (v - 60) / 140
 * All other features: already 0-1
 */
function normalize(features: Partial<Record<FeatureKey, number>>): Partial<Record<FeatureKey, number>> {
  const result: Partial<Record<FeatureKey, number>> = {};
  for (const [k, v] of Object.entries(features) as Array<[FeatureKey, number]>) {
    if (v == null) continue;
    if (k === "loudness") {
      result[k] = (v + 60) / 60;
    } else if (k === "tempo") {
      result[k] = (v - 60) / 140;
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Compute cosine similarity between two feature dicts.
 * Both are normalized before comparison.
 * Returns value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(
  vecA: Partial<Record<FeatureKey, number>>,
  vecB: Partial<Record<FeatureKey, number>>,
): number {
  const normA = normalize(vecA);
  const normB = normalize(vecB);

  const commonKeys = FEATURE_KEYS.filter(
    (k) => normA[k] != null && normB[k] != null,
  );
  if (commonKeys.length === 0) return 0;

  const dot = commonKeys.reduce((sum, k) => sum + normA[k]! * normB[k]!, 0);
  const magA = Math.sqrt(commonKeys.reduce((sum, k) => sum + normA[k]! ** 2, 0));
  const magB = Math.sqrt(commonKeys.reduce((sum, k) => sum + normB[k]! ** 2, 0));

  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/**
 * Score a candidate track against the taste vector.
 * Combined score: 70% cosine similarity against mean + 30% range-fit (features within 1.5 std).
 */
export function scoreCandidate(
  candidateFeatures: AudioFeatures,
  taste: TasteVector,
): number {
  const similarity = cosineSimilarity(candidateFeatures, taste.mean);

  let withinRange = 0;
  let totalFeatures = 0;

  for (const key of FEATURE_KEYS) {
    const mean = taste.mean[key];
    const std = taste.std[key];
    const val = candidateFeatures[key];
    if (val != null && mean != null && std != null) {
      totalFeatures += 1;
      if (Math.abs(val - mean) <= std * 1.5) {
        withinRange += 1;
      }
    }
  }

  const rangeScore = totalFeatures > 0 ? withinRange / totalFeatures : 0;

  // 70% similarity + 30% range fit (matches Python implementation)
  return 0.7 * similarity + 0.3 * rangeScore;
}
