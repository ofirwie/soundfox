const BATCH_SIZE = 40;
const RATE_LIMIT_MS = 2000;

export const FEATURE_KEYS = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type AudioFeatures = Record<FeatureKey, number>;

function extractSpotifyId(href: string): string {
  const match = href.match(/\/track\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getAudioFeaturesBatch(
  trackIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, AudioFeatures>> {
  const results = new Map<string, AudioFeatures>();

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);

    try {
      // [C1 FIX] Call local API route proxy, not ReccoBeats directly
      const resp = await fetch(`/api/reccobeats?ids=${batch.join(",")}`);
      if (resp.ok) {
        const data = await resp.json();
        const items: Array<Record<string, unknown>> = data.content ?? data ?? [];
        for (const item of items) {
          if (!item) continue;
          const spotifyId = extractSpotifyId(String(item.href ?? ""));
          if (!spotifyId) continue;
          const features: Partial<AudioFeatures> = {};
          let has = false;
          for (const key of FEATURE_KEYS) {
            if (item[key] != null) { features[key] = Number(item[key]); has = true; }
          }
          if (has) results.set(spotifyId, features as AudioFeatures);
        }
      }
    } catch {
      // Skip failed batches
    }

    onProgress?.(Math.min(i + BATCH_SIZE, trackIds.length), trackIds.length);
    if (i + BATCH_SIZE < trackIds.length) await sleep(RATE_LIMIT_MS);
  }

  return results;
}
