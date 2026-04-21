import type { AudioFeatures, FeatureKey } from "./reccobeats";

export interface Cluster {
  id: number;
  centroid: Record<string, number>;
  memberCount: number;
  label: string;
}

export interface TasteClusters {
  clusters: Cluster[];
  k: number;
  assignments: Map<string, number>;
}

const CLUSTER_FEATURES = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
] as const;

type ClusterFeatureKey = (typeof CLUSTER_FEATURES)[number];

export function normalizeFeatureValue(key: string, value: number): number {
  if (key === "loudness") return Math.max(0, Math.min(1, (value + 60) / 60));
  if (key === "tempo") return Math.max(0, Math.min(1, (value - 60) / 140));
  return value;
}

export function normalizeAudioFeatures(features: AudioFeatures): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of CLUSTER_FEATURES) {
    const v = features[key as FeatureKey];
    if (v != null) {
      result[key] = normalizeFeatureValue(key, v);
    }
  }
  return result;
}

// Normalized Euclidean distance — skips missing dimensions, normalizes by count
function euclideanDistance(
  a: Record<string, number>,
  b: Record<string, number>,
): number {
  let sum = 0;
  let count = 0;
  for (const key of CLUSTER_FEATURES as ReadonlyArray<ClusterFeatureKey>) {
    const av = a[key];
    const bv = b[key];
    if (av == null || bv == null) continue;
    sum += (av - bv) ** 2;
    count++;
  }
  if (count === 0) return 0;
  return Math.sqrt(sum / count);
}

// Seeded PRNG (mulberry32)
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = ((s + 0x6d2b79f5) | 0);
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeCentroid(points: Array<Record<string, number>>): Record<string, number> {
  if (points.length === 0) return {};
  const sums: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const p of points) {
    for (const [k, v] of Object.entries(p)) {
      sums[k] = (sums[k] ?? 0) + v;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const centroid: Record<string, number> = {};
  for (const k of Object.keys(sums)) {
    centroid[k] = sums[k] / counts[k];
  }
  return centroid;
}

function assignLabel(centroid: Record<string, number>, id: number): string {
  // These thresholds operate on normalized values (loudness/tempo normalized,
  // all others already 0-1). energy, valence, acousticness, speechiness are
  // identity-normalized so thresholds match Spotify's 0-1 range directly.
  const energy = centroid["energy"] ?? 0.5;
  const valence = centroid["valence"] ?? 0.5;
  const acousticness = centroid["acousticness"] ?? 0.3;
  const speechiness = centroid["speechiness"] ?? 0.05;

  if (energy > 0.7 && valence < 0.45) return "heavy";
  if (energy > 0.7 && valence >= 0.45) return "upbeat";
  if (energy < 0.45 && acousticness > 0.5) return "mellow";
  if (valence < 0.4 && speechiness > 0.1) return "angsty";
  return `cluster ${id}`;
}

function kMeans(
  points: Array<{ id: string; features: Record<string, number> }>,
  k: number,
  seed = 42,
): TasteClusters {
  const rng = makeRng(seed);
  const n = points.length;

  // kmeans++ initialization
  const centroidIndices: number[] = [Math.floor(rng() * n)];
  while (centroidIndices.length < k) {
    const dists = points.map((p, i) => {
      if (centroidIndices.includes(i)) return 0;
      return Math.min(...centroidIndices.map((ci) =>
        euclideanDistance(p.features, points[ci].features),
      )) ** 2;
    });
    const total = dists.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    centroidIndices.push(chosen);
  }

  let centroids: Record<string, number>[] = centroidIndices.map(
    (i) => ({ ...points[i].features }),
  );
  let assignments: number[] = new Array(n).fill(0);

  // Lloyd's algorithm — max 50 iterations
  for (let iter = 0; iter < 50; iter++) {
    const next = points.map((p) => {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclideanDistance(p.features, centroids[c]);
        if (d < bestDist) { bestDist = d; best = c; }
      }
      return best;
    });

    if (next.every((a, i) => a === assignments[i])) break;
    assignments = next;

    const groups: Array<Array<Record<string, number>>> = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) {
      groups[assignments[i]].push(points[i].features);
    }
    centroids = groups.map((g, cid) => g.length > 0 ? computeCentroid(g) : centroids[cid]);
  }

  const assignmentMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    assignmentMap.set(points[i].id, assignments[i]);
  }

  const clusters: Cluster[] = centroids.map((centroid, id) => ({
    id,
    centroid,
    memberCount: assignments.filter((a) => a === id).length,
    label: assignLabel(centroid, id),
  }));

  return { clusters, k, assignments: assignmentMap };
}

function computeWSSForK(
  points: Array<{ id: string; features: Record<string, number> }>,
  k: number,
): number {
  const { clusters, assignments } = kMeans(points, k);
  let wss = 0;
  for (const p of points) {
    const cId = assignments.get(p.id) ?? 0;
    const centroid = clusters[cId]?.centroid ?? {};
    wss += euclideanDistance(p.features, centroid) ** 2;
  }
  return wss;
}

function elbowK(
  points: Array<{ id: string; features: Record<string, number> }>,
): number {
  const maxK = Math.min(6, points.length);
  if (maxK <= 1) return 1;

  const wss: number[] = [];
  for (let k = 1; k <= maxK; k++) {
    wss.push(computeWSSForK(points, k));
  }

  // Find k where the benefit of adding the k-th cluster decelerates most
  let bestK = 2;
  let biggestDecel = -Infinity;
  for (let k = 2; k <= maxK; k++) {
    const dropToK = wss[k - 2] - wss[k - 1];
    const dropToNext = k < maxK ? wss[k - 1] - wss[k] : 0;
    const decel = dropToK - dropToNext;
    if (decel > biggestDecel) {
      biggestDecel = decel;
      bestK = k;
    }
  }
  return bestK;
}

export function buildTasteClusters(
  featuresByTrack: Map<string, AudioFeatures>,
  opts?: { k?: number; autoK?: boolean },
): TasteClusters {
  const n = featuresByTrack.size;
  if (n === 0) throw new Error("cannot cluster empty set");

  const points = Array.from(featuresByTrack, ([id, f]) => ({
    id,
    features: normalizeAudioFeatures(f),
  }));

  const k = opts?.k
    ?? (opts?.autoK ? elbowK(points) : Math.min(3, n));

  if (k > n) throw new Error("k > n");

  return kMeans(points, k);
}
