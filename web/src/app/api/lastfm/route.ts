import { NextRequest, NextResponse } from "next/server";

const LASTFM_BASE = "https://ws.audioscrobbler.com/2.0/";
const ALLOWED_METHODS = ["artist.getSimilar", "artist.getTopTracks"] as const;
type AllowedMethod = (typeof ALLOWED_METHODS)[number];

// In-memory rate limiter (same pattern as /api/reccobeats)
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ip = request.headers.get("x-forwarded-for") ?? "local";
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "LASTFM_API_KEY not configured" }, { status: 503 });
  }

  let body: Record<string, string>;
  try {
    body = await request.json() as Record<string, string>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { method, artist, limit } = body;

  if (!method) return NextResponse.json({ error: "method is required" }, { status: 400 });
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json({ error: `Invalid method: ${method}` }, { status: 400 });
  }
  if (!artist) return NextResponse.json({ error: "artist is required" }, { status: 400 });

  const url = new URL(LASTFM_BASE);
  url.searchParams.set("method", method as AllowedMethod);
  url.searchParams.set("artist", artist);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  url.searchParams.set("autocorrect", "1");
  if (limit) url.searchParams.set("limit", limit);

  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: "Last.fm API error", detail: data }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Last.fm request failed" }, { status: 502 });
  }
}
