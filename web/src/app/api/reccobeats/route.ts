import { NextRequest, NextResponse } from "next/server";

const RECCOBEATS_BASE = "https://api.reccobeats.com/v1";

// In-memory rate limiter — v3: raised to 120/min to accommodate multi-source fan-out + deep sampling
// Note: this resets on server restart; use Redis for persistent rate limiting in production
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 120;  // v3: raised from 30 to accommodate multi-source fan-out + deep sampling
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    // New window
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count += 1;
  return true;
}

// Periodically clean up stale entries to avoid unbounded memory growth
// (runs at most once per request, only when map is large)
function cleanupRateLimitMap(): void {
  if (rateLimitMap.size < 500) return;
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Extract IP: prefer x-forwarded-for (set by Vercel/proxies), fall back to remote address
  const forwarded = request.headers.get("x-forwarded-for");
  const ip = (forwarded ? forwarded.split(",")[0].trim() : null) ?? "unknown";

  cleanupRateLimitMap();

  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Max 120 requests per minute." },
      {
        status: 429,
        headers: { "Retry-After": "60" },
      },
    );
  }

  const ids = request.nextUrl.searchParams.get("ids");
  if (!ids) {
    return NextResponse.json({ error: "Missing ids parameter" }, { status: 400 });
  }

  try {
    const resp = await fetch(`${RECCOBEATS_BASE}/audio-features?ids=${ids}`, {
      headers: { Accept: "application/json" },
    });
    const data = await resp.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "ReccoBeats API error" }, { status: 502 });
  }
}
