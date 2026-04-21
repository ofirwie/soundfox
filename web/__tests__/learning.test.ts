import { describe, it, expect, beforeEach, vi } from "vitest";
import { getGenreWeights, createEmptyProfile } from "../src/lib/profile";
import type { PlaylistProfile } from "../src/lib/profile";

// localStorage mock provided by jsdom

function makeProfile(overrides: Partial<PlaylistProfile["blacklist"]> = {}): PlaylistProfile {
  const p = createEmptyProfile("test-playlist");
  p.blacklist = { ...p.blacklist, ...overrides };
  return p;
}

describe("getGenreWeights", () => {
  it("returns weight 1.0 for genres with no rejection data", () => {
    const profile = makeProfile();
    const weights = getGenreWeights(profile);
    expect(Object.keys(weights)).toHaveLength(0); // no genres seen → empty (neutral)
  });

  it("genre with 10 rejections + 0 accepts → weight 0.3 (min cap)", () => {
    const profile = makeProfile({ rejectionsByGenre: { "doom-metal": 10 }, acceptancesByGenre: {} });
    const weights = getGenreWeights(profile);
    expect(weights["doom-metal"]).toBeCloseTo(0.3, 2);
  });

  it("genre with 0 rejections → weight 1.0", () => {
    const profile = makeProfile({ rejectionsByGenre: {}, acceptancesByGenre: { "post-rock": 5 } });
    const weights = getGenreWeights(profile);
    expect(weights["post-rock"]).toBeCloseTo(1.0, 2);
  });

  it("NEGATIVE: no rejection data at all → all weights neutral (empty object)", () => {
    const profile = createEmptyProfile("p");
    const weights = getGenreWeights(profile);
    // No genres = no weights = neutral
    expect(Object.values(weights).every((w) => w === 1.0)).toBe(true);
  });

  it("partial rejection: 5 rejections + 5 acceptances → rate 0.5 → weight 0.65", () => {
    const profile = makeProfile({ rejectionsByGenre: { "stoner-rock": 5 }, acceptancesByGenre: { "stoner-rock": 5 } });
    const weights = getGenreWeights(profile);
    // weight = 1 - 0.5 * 0.7 = 0.65
    expect(weights["stoner-rock"]).toBeCloseTo(0.65, 2);
  });
});
