// Server-side only — reads GEMINI_API_KEY from process.env (never reaches browser)
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { Intent, LLMRecommendation } from "./intent-types";
import { defaultIntent } from "./intent-types";
export type { Intent, LLMRecommendation };

const MODEL = process.env.GEMINI_MODEL ?? "gemini-1.5-pro";

function getClient(): GoogleGenerativeAI {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set in .env");
  return new GoogleGenerativeAI(key);
}

export async function parseIntent(freeText: string, playlistContext: {
  name: string;
  topArtists: string[];
  topGenres: string[];
  trackCount: number;
}): Promise<Intent> {
  const prompt = `You are a music recommendation assistant. A user wants to extend their playlist and describes what they want in free text.

Playlist context:
- Name: "${playlistContext.name}"
- Track count: ${playlistContext.trackCount}
- Top artists: ${playlistContext.topArtists.slice(0, 10).join(", ")}
- Top genres: ${playlistContext.topGenres.slice(0, 10).join(", ")}

User's description of what they want:
"${freeText}"

Respond with ONLY a JSON object (no markdown, no explanation) matching this TypeScript type:
{
  "purpose": "short description like 'workout' or 'cover band' or 'chill evening'",
  "audioConstraints": {
    "tempoMin": number (optional, BPM),
    "tempoMax": number (optional, BPM),
    "energyMin": number (optional, 0-1),
    "energyMax": number (optional, 0-1),
    "valenceMin": number (optional, 0-1),
    "valenceMax": number (optional, 0-1),
    "popularityHint": "low" | "mid" | "high" (optional)
  },
  "genres": {
    "include": ["specific spotify sub-genres like 'post-grunge', 'doom metal'"],
    "exclude": ["genres to avoid"]
  },
  "era": "year range like '1990-2010' or null",
  "requirements": ["free-text requirements like 'singable chorus', 'crowd-pleaser', 'instrumental'"],
  "allowKnownArtists": boolean (true if user wants known artists included, false if only new),
  "qualityThreshold": number (0-1, how strict to be; 0.7 default, higher for premium curation),
  "notes": "brief summary of what you inferred"
}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = getClient();
      const model = client.getGenerativeModel({
        model: MODEL,
        ...(attempt === 1 ? { generationConfig: { temperature: 0 } } : {}),
      });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return JSON.parse(json) as Intent;
    } catch {
      // first attempt failed — retry at temperature=0; second failure falls through
    }
  }

  return defaultIntent();
}

export async function generateRecommendations(params: {
  intent: Intent;
  tasteVector: Record<string, number>;
  topArtists: string[];
  sampleTracks: Array<{ name: string; artist: string }>;
  count: number;
  excludeArtists: string[];
}): Promise<LLMRecommendation[]> {
  const client = getClient();
  const model = client.getGenerativeModel({ model: MODEL });

  const prompt = `You are a music expert. Based on the user's playlist taste and stated intent, recommend ${params.count} tracks.

Playlist taste summary:
- Top artists: ${params.topArtists.slice(0, 10).join(", ")}
- Sample tracks: ${params.sampleTracks.slice(0, 10).map((t) => `"${t.name}" by ${t.artist}`).join("; ")}
- Audio DNA averages: ${JSON.stringify(params.tasteVector)}

Intent:
${JSON.stringify(params.intent, null, 2)}

Excluded artists (already in playlist or blacklisted): ${params.excludeArtists.slice(0, 30).join(", ")}${params.excludeArtists.length > 30 ? `, and ${params.excludeArtists.length - 30} more` : ""}

Generate ${params.count} specific track recommendations that fit the intent. Each should be a REAL track by a REAL artist that exists on Spotify.

Respond with ONLY a JSON array (no markdown, no prose), each item:
{
  "artist": "Artist Name",
  "track": "Track Title",
  "why": "1-sentence reason specific to this track (not generic)",
  "confidence": 0-1 (how confident this fits the intent)
}

Focus on quality and specificity. Include mix of well-known and deeper cuts based on intent.popularityHint.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(json) as LLMRecommendation[];
}
