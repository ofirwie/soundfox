import { describe, it, expect, vi, afterEach } from "vitest";
import { defaultIntent } from "../src/lib/intent-types";

// We mock the entire @google/generative-ai module so no real API calls happen.
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(function () {
      return { getGenerativeModel: vi.fn().mockImplementation(() => mockModel) };
    }),
  };
});

const mockModel = {
  generateContent: vi.fn(),
};

afterEach(() => {
  vi.clearAllMocks();
  // Ensure GEMINI_API_KEY is set so getClient() doesn't throw
  process.env.GEMINI_API_KEY = "test-key";
});

const validIntent = JSON.stringify({
  purpose: "workout",
  audioConstraints: { tempoMin: 120 },
  genres: { include: ["rock"], exclude: [] },
  era: null,
  requirements: [],
  allowKnownArtists: true,
  qualityThreshold: 0.6,
  notes: "high energy workout",
});

describe("parseIntent retry logic", () => {
  it("returns valid intent when first call succeeds", async () => {
    mockModel.generateContent.mockResolvedValueOnce({
      response: { text: () => validIntent },
    });

    process.env.GEMINI_API_KEY = "test-key";
    const { parseIntent } = await import("../src/lib/gemini-server");
    const result = await parseIntent("workout music", { name: "My Playlist", topArtists: [], topGenres: [], trackCount: 10 });

    expect(result.purpose).toBe("workout");
    expect(mockModel.generateContent).toHaveBeenCalledTimes(1);
  });

  it("retries on first failure and returns valid intent from second call", async () => {
    mockModel.generateContent
      .mockResolvedValueOnce({ response: { text: () => "INVALID JSON {{{{" } })
      .mockResolvedValueOnce({ response: { text: () => validIntent } });

    process.env.GEMINI_API_KEY = "test-key";
    const { parseIntent } = await import("../src/lib/gemini-server");
    const result = await parseIntent("workout music", { name: "My Playlist", topArtists: [], topGenres: [], trackCount: 10 });

    expect(result.purpose).toBe("workout");
    expect(result.intentParseFailed).toBeUndefined();
    expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
  });

  // NEGATIVE TEST (Rule 11): both calls return garbage → safe default returned
  it("NEGATIVE: returns defaultIntent when both attempts fail", async () => {
    mockModel.generateContent
      .mockResolvedValueOnce({ response: { text: () => "not json at all" } })
      .mockResolvedValueOnce({ response: { text: () => "also not json" } });

    process.env.GEMINI_API_KEY = "test-key";
    const { parseIntent } = await import("../src/lib/gemini-server");
    const result = await parseIntent("whatever", { name: "P", topArtists: [], topGenres: [], trackCount: 0 });

    expect(result.intentParseFailed).toBe(true);
    expect(result).toMatchObject(defaultIntent());
    expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
  });

  // NEGATIVE TEST: network error on first, success on second
  it("NEGATIVE: recovers from network error on first attempt", async () => {
    mockModel.generateContent
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ response: { text: () => validIntent } });

    process.env.GEMINI_API_KEY = "test-key";
    const { parseIntent } = await import("../src/lib/gemini-server");
    const result = await parseIntent("test", { name: "P", topArtists: [], topGenres: [], trackCount: 0 });

    expect(result.purpose).toBe("workout");
    expect(mockModel.generateContent).toHaveBeenCalledTimes(2);
  });
});
