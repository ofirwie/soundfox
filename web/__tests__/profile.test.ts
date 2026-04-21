import { describe, it, expect, beforeEach } from "vitest";
import {
  loadProfile, saveProfile, blacklistTrack, blacklistArtist,
  markAccepted, isTrackBlacklisted, isArtistBlacklisted, createEmptyProfile,
  migrateProfile,
} from "../src/lib/profile";

describe("PlaylistProfile", () => {
  beforeEach(() => localStorage.clear());

  it("returns null when no profile exists", () => {
    expect(loadProfile("pl1")).toBeNull();
  });

  it("round-trips through localStorage", () => {
    const profile = createEmptyProfile("pl1");
    saveProfile(profile);
    expect(loadProfile("pl1")).toEqual(profile);
  });

  it("blacklists a track and isTrackBlacklisted returns true", () => {
    saveProfile(createEmptyProfile("pl1"));
    blacklistTrack("pl1", "trackA");
    expect(isTrackBlacklisted("pl1", "trackA")).toBe(true);
    expect(isTrackBlacklisted("pl1", "trackB")).toBe(false);
  });

  it("auto-blacklists artist after 2 rejected tracks by same artist — stores both id AND name [fix-C4]", () => {
    saveProfile(createEmptyProfile("pl1"));
    blacklistTrack("pl1", "t1", { artistId: "a1", artistName: "Nickelback" });
    expect(isArtistBlacklisted("pl1", "a1")).toBe(false);
    blacklistTrack("pl1", "t2", { artistId: "a1", artistName: "Nickelback" });
    expect(isArtistBlacklisted("pl1", "a1")).toBe(true);
    expect(loadProfile("pl1")!.blacklist.artistNames).toContain("Nickelback");
  });

  it("markAccepted appends and does not duplicate", () => {
    saveProfile(createEmptyProfile("pl1"));
    markAccepted("pl1", "t1");
    markAccepted("pl1", "t1");
    expect(loadProfile("pl1")!.accepted.trackIds).toEqual(["t1"]);
  });

  it("blacklistTrack on missing profile auto-creates the profile and applies the blacklist", () => {
    expect(loadProfile("nope")).toBeNull();
    blacklistTrack("nope", "t1", { artistId: "a1", artistName: "X" });
    const after = loadProfile("nope");
    expect(after).not.toBeNull();
    expect(after!.blacklist.trackIds).toContain("t1");
  });

  // NEGATIVE TEST (Rule 11) — schemaVersion mismatch should NOT crash [fix-M7]
  it("migrateProfile returns null for unreadable garbage", () => {
    expect(migrateProfile("not-json")).toBeNull();
    expect(migrateProfile({ schemaVersion: 999 })).toBeNull();
  });

  // NEGATIVE TEST (Rule 11) — quota-exceeded must be caught silently, not crash [fix-H3]
  it("saveProfile swallows QuotaExceededError (caller handles UI)", () => {
    const big = "x".repeat(1024 * 1024);
    try {
      for (let i = 0; i < 10; i++) localStorage.setItem(`_pad_${i}`, big);
    } catch { /* quota already hit — good */ }
    expect(() => saveProfile(createEmptyProfile("pl1"))).not.toThrow();
  });
});
