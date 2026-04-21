import { describe, it, expect } from "vitest";
import type { Intent } from "../src/lib/intent-types";
import { defaultIntent, QUALITY_TIERS } from "../src/lib/intent-types";

describe("Intent contract", () => {
  it("round-trips through JSON without loss", () => {
    const i: Intent = {
      purpose: "workout",
      audioConstraints: { tempoMin: 120, energyMin: 0.7 },
      genres: { include: ["rock"], exclude: ["country"] },
      era: "1990-2010",
      requirements: ["singable chorus"],
      allowKnownArtists: false,
      qualityThreshold: QUALITY_TIERS.premium,
      notes: "test",
    };
    expect(JSON.parse(JSON.stringify(i))).toEqual(i);
  });

  it("defaultIntent always has intentParseFailed: true", () => {
    expect(defaultIntent().intentParseFailed).toBe(true);
  });
});
