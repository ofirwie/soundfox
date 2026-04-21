import { describe, it, expect } from "vitest";
import { buildTasteClusters } from "../src/lib/clustering";
import { scoreCandidateClustered } from "../src/lib/taste-engine";
import type { AudioFeatures } from "../src/lib/reccobeats";

// Helper: make a point with given energy + valence, rest filled with defaults
function makeFeatures(overrides: Partial<AudioFeatures>): AudioFeatures {
  return {
    acousticness: 0.3,
    danceability: 0.5,
    energy: 0.5,
    instrumentalness: 0.0,
    liveness: 0.1,
    loudness: -8,
    speechiness: 0.05,
    tempo: 120,
    valence: 0.5,
    ...overrides,
  };
}

// Build a map of N points all near the given features (with slight jitter)
function makeCluster(
  id: string,
  n: number,
  base: Partial<AudioFeatures>,
  jitter = 0.03,
  seed = 1,
): Map<string, AudioFeatures> {
  const map = new Map<string, AudioFeatures>();
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 4294967296; };
  for (let i = 0; i < n; i++) {
    map.set(`${id}_${i}`, makeFeatures({
      ...base,
      energy: Math.max(0, Math.min(1, (base.energy ?? 0.5) + (rng() - 0.5) * 2 * jitter)),
      valence: Math.max(0, Math.min(1, (base.valence ?? 0.5) + (rng() - 0.5) * 2 * jitter)),
      acousticness: Math.max(0, Math.min(1, (base.acousticness ?? 0.3) + (rng() - 0.5) * 2 * jitter)),
    }));
  }
  return map;
}

// Merge multiple cluster maps
function merge(...maps: Map<string, AudioFeatures>[]): Map<string, AudioFeatures> {
  const result = new Map<string, AudioFeatures>();
  for (const m of maps) for (const [k, v] of m) result.set(k, v);
  return result;
}

// ─── buildTasteClusters ──────────────────────────────────────────────────────

describe("buildTasteClusters", () => {
  it("separates two clearly distinct groups with k=2", () => {
    const heavy = makeCluster("heavy", 50, { energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const mellow = makeCluster("mellow", 50, { energy: 0.1, valence: 0.7, acousticness: 0.85 });
    const tc = buildTasteClusters(merge(heavy, mellow), { k: 2 });

    expect(tc.k).toBe(2);
    expect(tc.clusters).toHaveLength(2);

    // The two centroids should be far apart
    const [c0, c1] = tc.clusters;
    const energyDiff = Math.abs((c0.centroid["energy"] ?? 0) - (c1.centroid["energy"] ?? 0));
    expect(energyDiff).toBeGreaterThan(0.3);
  });

  it("autoK returns 3 for a clear 3-cluster dataset (±1 tolerance)", () => {
    const g1 = makeCluster("g1", 40, { energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const g2 = makeCluster("g2", 40, { energy: 0.15, valence: 0.8, acousticness: 0.9 });
    const g3 = makeCluster("g3", 40, { energy: 0.55, valence: 0.5, acousticness: 0.3 });
    const tc = buildTasteClusters(merge(g1, g2, g3), { autoK: true });

    expect(tc.k).toBeGreaterThanOrEqual(2);
    expect(tc.k).toBeLessThanOrEqual(4);
  });

  it("produces deterministic results with same seed", () => {
    const data = merge(
      makeCluster("a", 30, { energy: 0.9 }),
      makeCluster("b", 30, { energy: 0.1 }),
    );
    const run1 = buildTasteClusters(data, { k: 2 });
    const run2 = buildTasteClusters(data, { k: 2 });
    // Same data + same seed → same cluster centroids (order may vary)
    const e1 = run1.clusters.map((c) => c.centroid["energy"] ?? 0).sort();
    const e2 = run2.clusters.map((c) => c.centroid["energy"] ?? 0).sort();
    expect(e1[0]).toBeCloseTo(e2[0], 3);
    expect(e1[1]).toBeCloseTo(e2[1], 3);
  });

  it("NEGATIVE: throws on empty input", () => {
    expect(() => buildTasteClusters(new Map())).toThrow("cannot cluster empty set");
  });

  it("NEGATIVE: throws when k > n", () => {
    const data = new Map([["a", makeFeatures({})]]);
    expect(() => buildTasteClusters(data, { k: 5 })).toThrow("k > n");
  });
});

// ─── Cluster labels ──────────────────────────────────────────────────────────

describe("cluster labels", () => {
  it("assigns 'heavy' label to high-energy / low-valence centroid", () => {
    const data = makeCluster("h", 20, { energy: 0.9, valence: 0.25, acousticness: 0.05 });
    const tc = buildTasteClusters(data, { k: 1 });
    expect(tc.clusters[0].label).toBe("heavy");
  });

  it("assigns 'upbeat' label to high-energy / high-valence centroid", () => {
    const data = makeCluster("u", 20, { energy: 0.85, valence: 0.75, acousticness: 0.05 });
    const tc = buildTasteClusters(data, { k: 1 });
    expect(tc.clusters[0].label).toBe("upbeat");
  });

  it("assigns 'mellow' label to low-energy / high-acousticness centroid", () => {
    const data = makeCluster("m", 20, { energy: 0.2, valence: 0.5, acousticness: 0.8 });
    const tc = buildTasteClusters(data, { k: 1 });
    expect(tc.clusters[0].label).toBe("mellow");
  });

  it("assigns 'angsty' label to low-valence / high-speechiness centroid", () => {
    const data = makeCluster("an", 20, { energy: 0.5, valence: 0.25, speechiness: 0.25 });
    const tc = buildTasteClusters(data, { k: 1 });
    expect(tc.clusters[0].label).toBe("angsty");
  });

  it("NEGATIVE: no-rule centroid gets fallback label (not empty / undefined)", () => {
    // energy=0.5, valence=0.5 → no rule matches → fallback
    const data = makeCluster("mid", 10, { energy: 0.5, valence: 0.5, acousticness: 0.3, speechiness: 0.04 });
    const tc = buildTasteClusters(data, { k: 1 });
    expect(typeof tc.clusters[0].label).toBe("string");
    expect(tc.clusters[0].label.length).toBeGreaterThan(0);
    expect(tc.clusters[0].label).toMatch(/^cluster \d+$/);
  });
});

// ─── scoreCandidateClustered ─────────────────────────────────────────────────

describe("scoreCandidateClustered", () => {
  it("candidate close to its cluster gets score > 0.7", () => {
    const data = makeCluster("h", 30, { energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const tc = buildTasteClusters(data, { k: 1 });
    // A candidate right at the centroid
    const candidate = makeFeatures({ energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const result = scoreCandidateClustered(candidate, tc);
    expect(result.score).toBeGreaterThan(0.7);
  });

  it("candidate far from all clusters scores lower than one right on a cluster", () => {
    const heavy = makeCluster("h", 30, { energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const mellw = makeCluster("m", 30, { energy: 0.1, valence: 0.8, acousticness: 0.9 });
    const tc = buildTasteClusters(merge(heavy, mellw), { k: 2 });

    const onCluster = makeFeatures({ energy: 0.9, valence: 0.2, acousticness: 0.05 });
    const midpoint  = makeFeatures({ energy: 0.5, valence: 0.5, acousticness: 0.47 });

    const scoreOn  = scoreCandidateClustered(onCluster, tc).score;
    const scoreMid = scoreCandidateClustered(midpoint, tc).score;
    expect(scoreOn).toBeGreaterThan(scoreMid);
  });

  it("NEGATIVE: missing energy and tempo does not produce NaN", () => {
    const data = makeCluster("x", 10, { energy: 0.5 });
    const tc = buildTasteClusters(data, { k: 1 });
    const sparse: AudioFeatures = { valence: 0.5, danceability: 0.6 }; // no energy, no tempo
    const result = scoreCandidateClustered(sparse, tc);
    expect(Number.isNaN(result.score)).toBe(false);
    expect(result.score).toBeGreaterThan(0);
  });
});
