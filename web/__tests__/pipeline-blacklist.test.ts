import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BlacklistEntry } from "../src/lib/profile";

// We test buildSpotifyCandidates directly, mocking searchArtists
vi.mock("../src/lib/spotify-client", () => ({
  searchArtists: vi.fn(),
  getArtists: vi.fn(),
  getArtistTopTracks: vi.fn(),
  getPlaylistTracksDetailed: vi.fn(),
}));

// Suppress fetch (debug log calls)
global.fetch = vi.fn().mockResolvedValue({ ok: true });

import { buildSpotifyCandidates } from "../src/lib/pipeline/source-spotify";
import { searchArtists } from "../src/lib/spotify-client";

const mockArtist = (id: string, name: string) => ({
  id, name, genres: ["post-grunge", "hard rock"], followers: { total: 50_000 }, popularity: 60,
});

describe("pipeline blacklist filter", () => {
  beforeEach(() => {
    vi.mocked(searchArtists).mockResolvedValue([
      mockArtist("a1", "Nickelback"),
      mockArtist("a2", "Foo Fighters"),
    ] as never);
  });

  it("POSITIVE — without blacklist, all artists pass through", async () => {
    const result = await buildSpotifyCandidates({
      searchTerms: ["post-grunge"],
      coreGenreSet: new Set(["post-grunge", "hard rock"]),
      allArtistIds: new Set(),
      allowKnownArtists: true,
    });
    const ids = result.map((a) => a.id);
    expect(ids).toContain("a1");
    expect(ids).toContain("a2");
  });

  it("NEGATIVE — blacklisted artist a1 never appears in candidates", async () => {
    const blacklist: BlacklistEntry = {
      trackIds: [], artistIds: ["a1"], artistNames: ["Nickelback"], genres: [], rejectionsByArtist: {},
    };
    const result = await buildSpotifyCandidates({
      searchTerms: ["post-grunge"],
      coreGenreSet: new Set(["post-grunge", "hard rock"]),
      allArtistIds: new Set(),
      allowKnownArtists: true,
      blacklist,
    });
    const ids = result.map((a) => a.id);
    expect(ids).not.toContain("a1");
    expect(ids).toContain("a2");
  });
});
