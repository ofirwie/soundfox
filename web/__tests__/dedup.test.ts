import { describe, it, expect } from "vitest";
import { normalizeTrackName, buildDedupKey, dedupCandidates } from "../src/lib/dedup";
import type { ScoredTrack } from "../src/lib/pipeline/types";
import type { SpotifyTrack, SpotifyArtist } from "../src/lib/spotify-client";

function makeArtist(id: string, name: string): SpotifyArtist {
  return { id, name, genres: [], followers: { total: 0 }, popularity: 0, images: [] };
}

function makeTrack(id: string, artistName: string, trackName: string, popularity = 50): SpotifyTrack {
  return {
    id,
    name: trackName,
    artists: [{ id: `a_${id}`, name: artistName }],
    album: { id: `alb_${id}`, name: "Album", images: [], release_date: "2015-01-01", release_date_precision: "day" },
    duration_ms: 210000,
    popularity,
    preview_url: null,
    external_ids: {},
  };
}

function c(id: string, artistName: string, trackName: string, popularity = 50): ScoredTrack {
  return {
    track: makeTrack(id, artistName, trackName, popularity),
    score: 0.7,
    artist: makeArtist(`a_${id}`, artistName),
    matchedGenres: [],
  };
}

describe("normalizeTrackName", () => {
  it("strips remaster suffix", () => {
    expect(normalizeTrackName("Hey Jude - Remastered 2015")).toBe("hey jude");
    expect(normalizeTrackName("Song - Remastered")).toBe("song");
  });

  it("strips year-first remaster", () => {
    expect(normalizeTrackName("Song - 2015 Remastered")).toBe("song");
  });

  it("strips parenthetical remaster", () => {
    expect(normalizeTrackName("Let It Be (Remastered 2009)")).toBe("let it be");
  });

  it("strips feat from parentheses", () => {
    expect(normalizeTrackName("Let It Be (feat. Paul McCartney)")).toBe("let it be");
  });

  it("strips remix", () => {
    expect(normalizeTrackName("Something (2019 Remix)")).toBe("something");
  });

  it("strips live suffix", () => {
    expect(normalizeTrackName("Song - Live at Wembley")).toBe("song");
    expect(normalizeTrackName("Song (Live at Wembley)")).toBe("song");
  });

  it("strips deluxe / radio edit / version", () => {
    expect(normalizeTrackName("Album Track (Deluxe Edition)")).toBe("album track");
    expect(normalizeTrackName("Hit (Radio Edit)")).toBe("hit");
    expect(normalizeTrackName("Track (Single Version)")).toBe("track");
  });

  it("lowercases and trims", () => {
    expect(normalizeTrackName("  THE SONG  ")).toBe("the song");
  });
});

describe("dedupCandidates", () => {
  it("dedups by Spotify ID (layer 1)", () => {
    const out = dedupCandidates([c("id1", "A", "Song"), c("id1", "A", "Song")]);
    expect(out).toHaveLength(1);
  });

  it("dedups by normalized name + first artist (layer 2)", () => {
    const out = dedupCandidates([
      c("id1", "Foo Fighters", "The Pretender"),
      c("id2", "Foo Fighters", "The Pretender - Remastered"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps the more popular variant when deduping", () => {
    const out = dedupCandidates([
      c("id1", "A", "Song", 20),
      c("id2", "A", "Song - Live", 80),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].track.popularity).toBe(80);
  });

  it("does NOT dedup tracks that only share a generic word like 'intro'", () => {
    const out = dedupCandidates([c("id1", "A", "Intro"), c("id2", "B", "Intro")]);
    expect(out).toHaveLength(2);
  });

  it("does NOT dedup covers by different primary artists", () => {
    const out = dedupCandidates([
      c("id1", "Johnny Cash", "Hurt"),
      c("id2", "Nine Inch Nails", "Hurt"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("preserves all non-duplicate entries", () => {
    const out = dedupCandidates([
      c("id1", "A", "Song One"),
      c("id2", "B", "Song Two"),
      c("id3", "C", "Song Three"),
    ]);
    expect(out).toHaveLength(3);
  });

  it("deduplicates across both layers in a mixed batch", () => {
    const out = dedupCandidates([
      c("id1", "Band", "Track"),
      c("id1", "Band", "Track"),               // same ID → layer 1
      c("id3", "Band", "Track (Remastered)"),   // same normalized → layer 2
      c("id4", "Other Band", "Track"),          // different artist → keep
    ]);
    expect(out).toHaveLength(2); // "Band/Track" once + "Other Band/Track"
  });

  // NEGATIVE TEST (Rule 11): short generic names do not collapse across artists
  it("NEGATIVE: two songs named 'Love' by different artists are NOT deduped", () => {
    const out = dedupCandidates([
      c("id1", "Artist X", "Love"),
      c("id2", "Artist Y", "Love"),
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("buildDedupKey", () => {
  it("returns the correct layer-2 key format", () => {
    const key = buildDedupKey("Foo Fighters", "The Pretender - Remastered");
    expect(key).toBe("foo fighters|||the pretender");
  });
});
