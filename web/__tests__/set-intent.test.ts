import { describe, it, expect, beforeEach } from "vitest";
import { setIntent, loadProfile } from "../src/lib/profile";
import type { Intent } from "../src/lib/intent-types";

const PLAYLIST_ID = "test-playlist-setintent";

const baseIntent: Intent = {
  purpose: "workout",
  audioConstraints: { tempoMin: 120 },
  genres: { include: ["rock"], exclude: [] },
  era: null,
  requirements: [],
  allowKnownArtists: true,
  qualityThreshold: 0.6,
  notes: "test intent",
};

beforeEach(() => {
  localStorage.clear();
});

describe("setIntent", () => {
  it("persists intent and intentText across page reload (localStorage round-trip)", () => {
    setIntent(PLAYLIST_ID, baseIntent, "high energy workout");
    const profile = loadProfile(PLAYLIST_ID);
    expect(profile?.intent?.purpose).toBe("workout");
    expect(profile?.intentText).toBe("high energy workout");
  });

  // NEGATIVE (Rule 11): intentParseFailed must be stripped before storage
  it("NEGATIVE: strips intentParseFailed flag before persisting", () => {
    const failedIntent: Intent = { ...baseIntent, intentParseFailed: true };
    setIntent(PLAYLIST_ID, failedIntent, "some query");
    const profile = loadProfile(PLAYLIST_ID);
    expect(profile?.intent?.intentParseFailed).toBeUndefined();
  });
});
