# SoundFox Web App Implementation Plan (v3 — full code)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the existing Python CLI recommendation engine into a public, self-hosted Next.js web app with a step-by-step wizard UI that works for ANY playlist genre.

**Architecture:** Next.js 15 App Router with dark-themed Tailwind CSS. Spotify OAuth PKCE (client-side, no server secret). Next.js API routes proxy ReccoBeats calls (CORS). Spotify client includes throttle + retry on 429. Genre gates dynamically derived from playlist analysis — NOT hardcoded. All user state in localStorage.

**Tech Stack:** Next.js 15, TypeScript (strict), Tailwind CSS v4, Spotify Web API (PKCE), ReccoBeats API (proxied via API route), localStorage

**QA Fixes Applied:**
- [C1] ReccoBeats proxied through API route (CORS fix)
- [C2] Spotify client has throttle (5 req/sec) + retry with backoff on 429
- [C3] Genre lists dynamically built from playlist analysis — no hardcoded rock genres
- [H1] Token refresh lock to prevent race condition
- [H2] Fixed import collision in spotify-client.ts
- [H3] Error state + retry in AnalysisStep
- [H4] Suspense boundary on callback page
- [H5] saveAnalysis() wired into results flow
- [M1] Full code for Task 10 (wizard wiring)
- [M2] All paths clarified as `web/src/...`
- [M3] Removed dead STEP_NAMES from WizardLayout
- [M4] Playlist image fallback
- [v3-A] Task 5 taste-engine.ts now has full TypeScript code (ported from Python)
- [v3-B] Task 7 PlaylistStep.tsx now has full TSX code with image fallback
- [v3-C] Task 8 AnalysisStep.tsx now has full TSX code with try/catch error state and retry button
- [v3-D] Task 9 ResultsStep.tsx now has full TSX code with preview player, checkboxes, score display, create playlist button, saveAnalysis() on mount
- [v3-E] Task 4 ReccoBeats proxy now has in-memory rate limiting (30 req/min per IP)
- [v3-F] Pipeline UI-yield note added to Task 6

---

## Batch 1: Project Scaffold + Spotify Auth

### Task 1: Initialize Next.js project

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/next.config.ts`
- Create: `web/src/app/layout.tsx`, `web/src/app/page.tsx`
- Create: `web/src/app/globals.css`

**Step 1: Create Next.js project**

```bash
cd C:\Users\fires\OneDrive\Git\spotify-recommendation
npx create-next-app@latest web --typescript --tailwind --app --src-dir --no-eslint --import-alias "@/*"
```

**Step 2: Create `web/next.config.ts`**

Create `web/next.config.ts`:
```ts
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "i.scdn.co" }],
  },
};
export default nextConfig;
```

**Step 3: Verify it runs**

```bash
cd web && npm run dev
```
Expected: App running on localhost:3000

**Step 4: Set up dark theme in globals.css**

Replace `web/src/app/globals.css`:
```css
@import "tailwindcss";

:root {
  --bg-primary: #0a0a0a;
  --bg-secondary: #141414;
  --bg-card: #1a1a1a;
  --text-primary: #e5e5e5;
  --text-secondary: #a3a3a3;
  --accent: #22c55e;
  --accent-hover: #16a34a;
  --border: #262626;
}

body {
  background: var(--bg-primary);
  color: var(--text-primary);
}
```

**Step 5: Create base layout**

Replace `web/src/app/layout.tsx`:
```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoundFox - Discover Music Your Way",
  description: "Open source playlist analyzer and music discovery engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}
```

**Step 6: Create landing page**

Replace `web/src/app/page.tsx`:
```tsx
import Link from "next/link";

export default function Home(): React.ReactElement {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 gap-8">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-4">SoundFox</h1>
        <p className="text-[var(--text-secondary)] text-xl max-w-lg">
          Discover new music based on what you actually listen to.
          Analyzes your playlist&apos;s audio DNA and finds hidden gems that match.
        </p>
      </div>
      <Link
        href="/wizard"
        className="px-8 py-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)]
                   rounded-full font-semibold text-lg transition-colors"
      >
        Get Started
      </Link>
      <p className="text-[var(--text-secondary)] text-sm">
        Open source &middot; No server &middot; Your data stays local
      </p>
    </main>
  );
}
```

**Step 7: Commit**

```bash
git init && git add -A && git commit -m "feat: initialize Next.js 15 project with dark theme"
```

---

### Task 2: Spotify OAuth PKCE + API client with throttle

**Files:**
- Create: `web/src/lib/storage.ts`
- Create: `web/src/lib/spotify-auth.ts`
- Create: `web/src/lib/spotify-client.ts`
- Create: `web/src/app/callback/page.tsx`

**Step 1: Create localStorage helper**

Create `web/src/lib/storage.ts`:
```typescript
const KEYS = {
  CLIENT_ID: "soundfox_client_id",
  ACCESS_TOKEN: "soundfox_access_token",
  REFRESH_TOKEN: "soundfox_refresh_token",
  TOKEN_EXPIRY: "soundfox_token_expiry",
  CODE_VERIFIER: "soundfox_code_verifier",
  HISTORY: "soundfox_history",
} as const;

export function getClientId(): string | null {
  return localStorage.getItem(KEYS.CLIENT_ID);
}

export function setClientId(id: string): void {
  localStorage.setItem(KEYS.CLIENT_ID, id);
}

export function getAccessToken(): string | null {
  const expiry = localStorage.getItem(KEYS.TOKEN_EXPIRY);
  if (expiry && Date.now() > parseInt(expiry, 10)) {
    return null;
  }
  return localStorage.getItem(KEYS.ACCESS_TOKEN);
}

export function setTokens(accessToken: string, expiresIn: number, refreshToken?: string): void {
  localStorage.setItem(KEYS.ACCESS_TOKEN, accessToken);
  localStorage.setItem(KEYS.TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));
  if (refreshToken) {
    localStorage.setItem(KEYS.REFRESH_TOKEN, refreshToken);
  }
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(KEYS.REFRESH_TOKEN);
}

export function setCodeVerifier(verifier: string): void {
  localStorage.setItem(KEYS.CODE_VERIFIER, verifier);
}

export function getCodeVerifier(): string | null {
  return localStorage.getItem(KEYS.CODE_VERIFIER);
}

export function clearAuth(): void {
  localStorage.removeItem(KEYS.ACCESS_TOKEN);
  localStorage.removeItem(KEYS.REFRESH_TOKEN);
  localStorage.removeItem(KEYS.TOKEN_EXPIRY);
  localStorage.removeItem(KEYS.CODE_VERIFIER);
}

export interface AnalysisRecord {
  id: string;
  playlistId: string;
  playlistName: string;
  trackCount: number;
  tasteVector: Record<string, number>;
  resultCount: number;
  createdAt: string;
}

export function getHistory(): AnalysisRecord[] {
  const raw = localStorage.getItem(KEYS.HISTORY);
  return raw ? JSON.parse(raw) : [];
}

export function saveAnalysis(record: AnalysisRecord): void {
  const history = getHistory();
  history.unshift(record);
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(history.slice(0, 20)));
}
```

**Step 2: Create Spotify PKCE auth**

Create `web/src/lib/spotify-auth.ts`:
```typescript
import { getClientId, setCodeVerifier, getCodeVerifier, setTokens, getRefreshToken } from "./storage";

const SCOPES = [
  "user-library-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startLogin(): Promise<void> {
  const clientId = getClientId();
  if (!clientId) throw new Error("No Client ID configured");

  const verifier = generateRandomString(64);
  setCodeVerifier(verifier);

  const challenge = base64urlEncode(await sha256(verifier));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: `${window.location.origin}/callback`,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export async function handleCallback(code: string): Promise<boolean> {
  const clientId = getClientId();
  const verifier = getCodeVerifier();
  if (!clientId || !verifier) return false;

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${window.location.origin}/callback`,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) return false;
  const data = await response.json();
  setTokens(data.access_token, data.expires_in, data.refresh_token);
  return true;
}

// [H1 FIX] Refresh lock to prevent race condition
let refreshPromise: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const clientId = getClientId();
    const refreshToken = getRefreshToken();
    if (!clientId || !refreshToken) return false;

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return false;
    const data = await response.json();
    setTokens(data.access_token, data.expires_in, data.refresh_token);
    return true;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}
```

**Step 3: Create Spotify API client with throttle + retry** [C2 FIX]

Create `web/src/lib/spotify-client.ts`:
```typescript
import { getAccessToken } from "./storage";
import { refreshAccessToken } from "./spotify-auth";

const BASE = "https://api.spotify.com/v1";

// [C2 FIX] Throttle: max 5 requests per second
const REQUEST_INTERVAL_MS = 200;
let lastRequestTime = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// [C2 FIX] Retry with exponential backoff on 429
async function spotifyFetch(path: string, options?: RequestInit, retries: number = 3): Promise<Response> {
  await throttle();

  let token = getAccessToken();
  if (!token) {
    const ok = await refreshAccessToken();
    if (!ok) throw new Error("Not authenticated");
    token = getAccessToken();
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...options?.headers,
  };

  const response = await fetch(`${BASE}${path}`, { ...options, headers });

  if (response.status === 401) {
    const ok = await refreshAccessToken();
    if (!ok) throw new Error("Session expired");
    token = getAccessToken();
    return fetch(`${BASE}${path}`, {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${token}` },
    });
  }

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("Retry-After") ?? "2", 10);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return spotifyFetch(path, options, retries - 1);
  }

  return response;
}

export interface SpotifyUser {
  id: string;
  display_name: string;
  images: Array<{ url: string }>;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  images: Array<{ url: string }>;
  tracks: { total: number };
  owner: { display_name: string };
}

export interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  popularity: number;
  preview_url: string | null;
  album: {
    name: string;
    release_date: string;
    images: Array<{ url: string }>;
  };
  artists: Array<{ id: string; name: string }>;
  explicit: boolean;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
  followers: { total: number };
  images: Array<{ url: string }>;
  popularity: number;
}

export async function getCurrentUser(): Promise<SpotifyUser> {
  const res = await spotifyFetch("/me");
  return res.json();
}

export async function getUserPlaylists(): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let url = "/me/playlists?limit=50";
  while (url) {
    const res = await spotifyFetch(url);
    const data = await res.json();
    playlists.push(...data.items);
    url = data.next ? data.next.replace(BASE, "") : "";
  }
  return playlists;
}

export async function getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url = `/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await spotifyFetch(url);
    const data = await res.json();
    for (const item of data.items) {
      if (item.track?.id) tracks.push(item.track);
    }
    url = data.next ? data.next.replace(BASE, "") : "";
  }
  return tracks;
}

export async function getArtists(artistIds: string[]): Promise<SpotifyArtist[]> {
  const results: SpotifyArtist[] = [];
  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    const res = await spotifyFetch(`/artists?ids=${batch.join(",")}`);
    const data = await res.json();
    results.push(...data.artists.filter(Boolean));
  }
  return results;
}

export async function searchArtists(query: string, offset: number = 0): Promise<SpotifyArtist[]> {
  const res = await spotifyFetch(
    `/search?q=${encodeURIComponent(query)}&type=artist&limit=50&offset=${offset}&market=US`
  );
  const data = await res.json();
  return data.artists?.items ?? [];
}

export async function getArtistTopTracks(artistId: string): Promise<SpotifyTrack[]> {
  const res = await spotifyFetch(`/artists/${artistId}/top-tracks?market=US`);
  const data = await res.json();
  return data.tracks ?? [];
}

export async function createPlaylist(userId: string, name: string, description: string): Promise<{ id: string }> {
  const res = await spotifyFetch(`/users/${userId}/playlists`, {
    method: "POST",
    body: JSON.stringify({ name, description, public: false }),
  });
  return res.json();
}

export async function addTracksToPlaylist(playlistId: string, trackUris: string[]): Promise<void> {
  for (let i = 0; i < trackUris.length; i += 100) {
    await spotifyFetch(`/playlists/${playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: trackUris.slice(i, i + 100) }),
    });
  }
}
```

**Step 4: Create callback page** [H4 FIX — Suspense boundary]

Create `web/src/app/callback/page.tsx`:
```tsx
"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { handleCallback } from "@/lib/spotify-auth";

function CallbackHandler(): React.ReactElement {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get("code");
    const errorParam = searchParams.get("error");

    if (errorParam) {
      setError(`Spotify denied access: ${errorParam}`);
      return;
    }
    if (code) {
      handleCallback(code).then((ok) => {
        if (ok) router.replace("/wizard");
        else setError("Failed to exchange authorization code");
      });
    }
  }, [searchParams, router]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 text-xl">{error}</p>
          <button onClick={() => router.replace("/")} className="mt-4 px-6 py-2 bg-[var(--accent)] rounded-lg">
            Try Again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-[var(--text-secondary)] text-xl">Connecting to Spotify...</p>
    </main>
  );
}

export default function CallbackPage(): React.ReactElement {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center"><p>Loading...</p></main>}>
      <CallbackHandler />
    </Suspense>
  );
}
```

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: Spotify OAuth PKCE + throttled API client"
```

---

### Task 3: Setup wizard + Connect step

**Files:**
- Create: `web/src/components/WizardLayout.tsx`
- Create: `web/src/components/SetupStep.tsx`
- Create: `web/src/app/wizard/page.tsx` (initial — steps 1-2 only)

**Step 1: Create wizard layout** [M3 FIX — no dead STEP_NAMES]

Create `web/src/components/WizardLayout.tsx`:
```tsx
interface WizardLayoutProps {
  step: number;
  totalSteps: number;
  stepName: string;
  children: React.ReactNode;
}

export default function WizardLayout({ step, totalSteps, stepName, children }: WizardLayoutProps): React.ReactElement {
  return (
    <main className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--border)] px-8 py-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <h1 className="text-2xl font-bold">SoundFox</h1>
          <span className="text-[var(--text-secondary)]">Step {step} of {totalSteps}: {stepName}</span>
        </div>
      </header>
      <div className="w-full bg-[var(--bg-secondary)] h-1">
        <div className="bg-[var(--accent)] h-1 transition-all duration-500" style={{ width: `${(step / totalSteps) * 100}%` }} />
      </div>
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-2xl w-full">{children}</div>
      </div>
    </main>
  );
}
```

**Step 2: Create setup step**

Create `web/src/components/SetupStep.tsx`:
```tsx
"use client";

import { useState } from "react";
import { getClientId, setClientId } from "@/lib/storage";

interface SetupStepProps {
  onComplete: () => void;
}

export default function SetupStep({ onComplete }: SetupStepProps): React.ReactElement {
  const [clientId, setClientIdValue] = useState(getClientId() ?? "");
  const [error, setError] = useState("");

  function handleSubmit(): void {
    const trimmed = clientId.trim();
    if (trimmed.length < 10) {
      setError("That doesn't look like a valid Client ID");
      return;
    }
    setClientId(trimmed);
    onComplete();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Welcome to SoundFox</h2>
        <p className="text-[var(--text-secondary)]">To get started, you need a free Spotify Developer app.</p>
      </div>

      <div className="bg-[var(--bg-card)] rounded-xl p-6 space-y-4 border border-[var(--border)]">
        <h3 className="text-lg font-semibold">How to get your Client ID:</h3>
        <ol className="list-decimal list-inside space-y-2 text-[var(--text-secondary)]">
          <li>Go to <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">developer.spotify.com/dashboard</a></li>
          <li>Click <strong className="text-white">Create App</strong></li>
          <li>Name it anything (e.g. &quot;SoundFox&quot;)</li>
          <li>Set Redirect URI to: <code className="bg-[var(--bg-secondary)] px-2 py-1 rounded text-sm">{typeof window !== "undefined" ? `${window.location.origin}/callback` : "http://localhost:3000/callback"}</code></li>
          <li>Check <strong className="text-white">Web API</strong> under APIs</li>
          <li>Copy the <strong className="text-white">Client ID</strong></li>
        </ol>
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">Your Spotify Client ID</label>
        <input type="text" value={clientId} onChange={(e) => { setClientIdValue(e.target.value); setError(""); }}
          placeholder="e.g. abcdef1234567890abcdef1234567890"
          className="w-full px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] text-white placeholder-gray-500" />
        {error && <p className="text-red-400 text-sm mt-1">{error}</p>}
      </div>

      <button onClick={handleSubmit} className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors">
        Continue
      </button>
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: wizard layout + setup step"
```

---

## Batch 2: Core Engine (TypeScript port)

### Task 4: ReccoBeats API route (CORS proxy + rate limiting) [C1 FIX, v3-E]

**Files:**
- Create: `web/src/app/api/reccobeats/route.ts`
- Create: `web/src/lib/reccobeats.ts`

**Step 1: Create API route proxy with rate limiting** [v3-E FIX]

Create `web/src/app/api/reccobeats/route.ts`:
```typescript
import { NextRequest, NextResponse } from "next/server";

const RECCOBEATS_BASE = "https://api.reccobeats.com/v1";

// [v3-E] In-memory rate limiter: max 30 requests per minute per IP
// Note: this resets on server restart; use Redis for persistent rate limiting in production
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 30;
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
      { error: "Rate limit exceeded. Max 30 requests per minute." },
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
```

**Step 2: Create ReccoBeats client (calls local proxy)**

Create `web/src/lib/reccobeats.ts`:
```typescript
const BATCH_SIZE = 40;
const RATE_LIMIT_MS = 2000;

export const FEATURE_KEYS = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type AudioFeatures = Record<FeatureKey, number>;

function extractSpotifyId(href: string): string {
  const match = href.match(/\/track\/([a-zA-Z0-9]+)/);
  return match?.[1] ?? "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getAudioFeaturesBatch(
  trackIds: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, AudioFeatures>> {
  const results = new Map<string, AudioFeatures>();

  for (let i = 0; i < trackIds.length; i += BATCH_SIZE) {
    const batch = trackIds.slice(i, i + BATCH_SIZE);

    try {
      // [C1 FIX] Call local API route proxy, not ReccoBeats directly
      const resp = await fetch(`/api/reccobeats?ids=${batch.join(",")}`);
      if (resp.ok) {
        const data = await resp.json();
        const items: Array<Record<string, unknown>> = data.content ?? data ?? [];
        for (const item of items) {
          if (!item) continue;
          const spotifyId = extractSpotifyId(String(item.href ?? ""));
          if (!spotifyId) continue;
          const features: Partial<AudioFeatures> = {};
          let has = false;
          for (const key of FEATURE_KEYS) {
            if (item[key] != null) { features[key] = Number(item[key]); has = true; }
          }
          if (has) results.set(spotifyId, features as AudioFeatures);
        }
      }
    } catch {
      // Skip failed batches
    }

    onProgress?.(Math.min(i + BATCH_SIZE, trackIds.length), trackIds.length);
    if (i + BATCH_SIZE < trackIds.length) await sleep(RATE_LIMIT_MS);
  }

  return results;
}
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: ReccoBeats CORS proxy + rate limiting + client"
```

---

### Task 5: Taste engine [v3-A — full TypeScript code]

**Files:**
- Create: `web/src/lib/taste-engine.ts`

**Step 1: Create taste engine**

Create `web/src/lib/taste-engine.ts`:

> Ported from `src/taste_engine.py`. Logic is identical: mean/std/min/max per feature, cosine similarity with loudness+tempo normalization, combined 70% similarity + 30% range-fit score.

```typescript
import { FEATURE_KEYS, type AudioFeatures, type FeatureKey } from "./reccobeats";

export interface TasteVector {
  mean: Partial<Record<FeatureKey, number>>;
  std: Partial<Record<FeatureKey, number>>;
  minVal: Partial<Record<FeatureKey, number>>;
  maxVal: Partial<Record<FeatureKey, number>>;
  sampleCount: number;
}

/**
 * Build a taste vector from a map of trackId -> AudioFeatures.
 * Calculates mean, std, min, max for each feature dimension.
 */
export function buildTasteVector(featuresByTrack: Map<string, AudioFeatures>): TasteVector {
  const tv: TasteVector = {
    mean: {},
    std: {},
    minVal: {},
    maxVal: {},
    sampleCount: featuresByTrack.size,
  };

  if (featuresByTrack.size === 0) return tv;

  // Collect all values per feature
  const featureValues: Record<FeatureKey, number[]> = {} as Record<FeatureKey, number[]>;
  for (const key of FEATURE_KEYS) {
    featureValues[key] = [];
  }

  for (const features of featuresByTrack.values()) {
    for (const key of FEATURE_KEYS) {
      if (features[key] != null) {
        featureValues[key].push(features[key]);
      }
    }
  }

  for (const key of FEATURE_KEYS) {
    const vals = featureValues[key];
    if (vals.length === 0) continue;

    const n = vals.length;
    const mean = vals.reduce((sum, v) => sum + v, 0) / n;
    const variance = n > 1
      ? vals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n
      : 0;

    tv.mean[key] = mean;
    tv.std[key] = Math.sqrt(variance);
    tv.minVal[key] = Math.min(...vals);
    tv.maxVal[key] = Math.max(...vals);
  }

  return tv;
}

/**
 * Normalize features to roughly 0-1 scale.
 * Loudness: typically -60 to 0 dB -> (v + 60) / 60
 * Tempo: typically 60-200 BPM -> (v - 60) / 140
 * All other features: already 0-1
 */
function normalize(features: Partial<Record<FeatureKey, number>>): Partial<Record<FeatureKey, number>> {
  const result: Partial<Record<FeatureKey, number>> = {};
  for (const [k, v] of Object.entries(features) as Array<[FeatureKey, number]>) {
    if (v == null) continue;
    if (k === "loudness") {
      result[k] = (v + 60) / 60;
    } else if (k === "tempo") {
      result[k] = (v - 60) / 140;
    } else {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Compute cosine similarity between two feature dicts.
 * Both are normalized before comparison.
 * Returns value in [-1, 1]; higher = more similar.
 */
export function cosineSimilarity(
  vecA: Partial<Record<FeatureKey, number>>,
  vecB: Partial<Record<FeatureKey, number>>,
): number {
  const normA = normalize(vecA);
  const normB = normalize(vecB);

  const commonKeys = FEATURE_KEYS.filter(
    (k) => normA[k] != null && normB[k] != null,
  );
  if (commonKeys.length === 0) return 0;

  const dot = commonKeys.reduce((sum, k) => sum + normA[k]! * normB[k]!, 0);
  const magA = Math.sqrt(commonKeys.reduce((sum, k) => sum + normA[k]! ** 2, 0));
  const magB = Math.sqrt(commonKeys.reduce((sum, k) => sum + normB[k]! ** 2, 0));

  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

/**
 * Score a candidate track against the taste vector.
 * Combined score: 70% cosine similarity against mean + 30% range-fit (features within 1.5 std).
 */
export function scoreCandidate(
  candidateFeatures: AudioFeatures,
  taste: TasteVector,
): number {
  const similarity = cosineSimilarity(candidateFeatures, taste.mean);

  let withinRange = 0;
  let totalFeatures = 0;

  for (const key of FEATURE_KEYS) {
    const mean = taste.mean[key];
    const std = taste.std[key];
    const val = candidateFeatures[key];
    if (val != null && mean != null && std != null) {
      totalFeatures += 1;
      if (Math.abs(val - mean) <= std * 1.5) {
        withinRange += 1;
      }
    }
  }

  const rangeScore = totalFeatures > 0 ? withinRange / totalFeatures : 0;

  // 70% similarity + 30% range fit (matches Python implementation)
  return 0.7 * similarity + 0.3 * rangeScore;
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: taste engine (cosine similarity scoring)"
```

---

### Task 6: Discovery pipeline with dynamic genre extraction [C3 FIX, v3-F]

**Files:**
- Create: `web/src/lib/discovery-pipeline.ts`

**Note on UI yielding [v3-F]:** The pipeline is all async/await. Every `await` call (fetch, sleep, etc.) yields to the event loop, keeping the browser responsive. The progress callback fires regularly so React can re-render. For the two tight CPU loops (genre scoring in `buildGenreProfile` and the scoring loop in Phase 7), an explicit `await new Promise(r => setTimeout(r, 0))` is inserted every 200 iterations to yield the event loop and allow React to flush pending state updates.

**Step 1: Create pipeline with dynamic genre lists**

Create `web/src/lib/discovery-pipeline.ts`:

Key differences from v1:
- **NO hardcoded CORE_GENRES or BANNED_GENRES**
- Instead: `buildGenreProfile()` function that:
  1. Collects all artist IDs from the playlist
  2. Fetches artist details (in batches of 50)
  3. Counts genre occurrences weighted by track count
  4. Top 15 genres become `coreGenres` for this playlist
  5. Search terms derived from top genres (excluding generic "rock", "pop", "metal")
- Genre gate requires 2+ overlaps with the **dynamically built** core genres
- Banned genres: only truly unrelated genres (k-pop, reggaeton, classical, children's, etc.)
- `isLatinName()` filter on artists and tracks
- `market=US` on all searches
- All catch blocks log the error type and count for reporting
- Explicit `await setTimeout(0)` every 200 iterations in CPU-bound loops [v3-F]

```typescript
import { getAudioFeaturesBatch, type AudioFeatures } from "./reccobeats";
import { buildTasteVector, scoreCandidate, type TasteVector } from "./taste-engine";
import {
  getPlaylistTracks, getArtists, searchArtists, getArtistTopTracks,
  type SpotifyTrack, type SpotifyArtist,
} from "./spotify-client";

export interface PipelineProgress {
  phase: string;
  message: string;
  percent: number;
}

export interface ScoredTrack {
  track: SpotifyTrack;
  score: number;
  artist: SpotifyArtist;
  matchedGenres: string[];
}

export interface PipelineResult {
  tasteVector: TasteVector;
  coreGenres: string[];
  tracksAnalyzed: number;
  tracksWithFeatures: number;
  candidateArtists: number;
  genrePassed: number;
  candidateTracks: number;
  scored: number;
  results: ScoredTrack[];
}

// Genres that are NEVER relevant regardless of playlist
const UNIVERSAL_BANNED = new Set([
  "children's music", "kids", "lullaby", "nursery",
  "asmr", "meditation", "sleep", "white noise",
  "comedy", "stand-up comedy", "spoken word",
]);

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

// Yield to event loop to keep the browser responsive during heavy loops [v3-F]
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// [C3 FIX] Build genre profile dynamically from playlist
async function buildGenreProfile(
  tracks: SpotifyTrack[],
  onProgress: (msg: string) => void,
): Promise<{ coreGenres: string[]; searchTerms: string[]; allArtistIds: Set<string> }> {
  // Count artist frequency
  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      if (artist.id) artistCounts.set(artist.id, (artistCounts.get(artist.id) ?? 0) + 1);
    }
  }

  const allArtistIds = new Set(artistCounts.keys());

  // Fetch artist details in batches
  const artistIds = [...artistCounts.keys()];
  const genreCounts = new Map<string, number>();

  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    try {
      const artists = await getArtists(batch);
      for (const artist of artists) {
        const weight = artistCounts.get(artist.id) ?? 1;
        for (const genre of artist.genres) {
          genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + weight);
        }
      }
    } catch {
      continue;
    }
    onProgress(`Analyzing genres: ${Math.min(i + 50, artistIds.length)}/${artistIds.length} artists`);

    // [v3-F] Yield every batch to keep browser responsive
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  // Sort genres by weighted count
  const sorted = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]);
  const coreGenres = sorted.slice(0, 15).map(([g]) => g);

  // Search terms: skip generic single-word genres, use specific ones
  const genericGenres = new Set(["rock", "pop", "metal", "jazz", "blues", "country", "folk", "soul", "r&b"]);
  const searchTerms = coreGenres.filter((g) => !genericGenres.has(g)).slice(0, 12);

  // If we filtered too many, add back the top ones
  if (searchTerms.length < 5) {
    for (const g of coreGenres) {
      if (!searchTerms.includes(g)) searchTerms.push(g);
      if (searchTerms.length >= 8) break;
    }
  }

  return { coreGenres, searchTerms, allArtistIds };
}

export async function runPipeline(
  playlistId: string,
  onProgress: (progress: PipelineProgress) => void,
  resultCount: number = 50,
  minYear: number = 2000,
): Promise<PipelineResult> {
  // Phase 1: Load tracks
  onProgress({ phase: "analyze", message: "Loading playlist tracks...", percent: 5 });
  const tracks = await getPlaylistTracks(playlistId);
  const trackIds = tracks.map((t) => t.id).filter(Boolean);
  const existingTrackIds = new Set(trackIds);

  // Phase 2: Build genre profile dynamically [C3 FIX]
  onProgress({ phase: "analyze", message: "Analyzing genre DNA...", percent: 8 });
  const { coreGenres, searchTerms, allArtistIds } = await buildGenreProfile(
    tracks,
    (msg) => onProgress({ phase: "analyze", message: msg, percent: 12 }),
  );
  const coreGenreSet = new Set(coreGenres);

  // Phase 3: Audio features
  onProgress({ phase: "analyze", message: "Analyzing audio DNA...", percent: 15 });
  const features = await getAudioFeaturesBatch(trackIds, (done, total) => {
    onProgress({ phase: "analyze", message: `Audio features: ${done}/${total}`, percent: 15 + (done / total) * 15 });
  });
  const tasteVector = buildTasteVector(features);

  // Phase 4: Search for candidate artists
  onProgress({ phase: "discover", message: "Searching for new artists...", percent: 35 });
  const candidateArtists = new Map<string, SpotifyArtist>();
  const MIN_FOLLOWERS = 5_000;
  const MAX_FOLLOWERS = 500_000;

  for (let ti = 0; ti < searchTerms.length; ti++) {
    const term = searchTerms[ti];
    for (let offset = 0; offset < 1000; offset += 50) {
      try {
        const artists = await searchArtists(term, offset);
        if (artists.length === 0) break;
        for (const artist of artists) {
          if (allArtistIds.has(artist.id) || candidateArtists.has(artist.id)) continue;
          if (!isLatinName(artist.name)) continue;
          candidateArtists.set(artist.id, artist);
        }
      } catch { continue; }
    }
    onProgress({
      phase: "discover",
      message: `Searched "${term}" (${candidateArtists.size} found)`,
      percent: 35 + (ti / searchTerms.length) * 15,
    });
  }

  // Phase 5: Genre gate (dynamic)
  onProgress({ phase: "discover", message: "Validating genres...", percent: 50 });
  const genrePassed: SpotifyArtist[] = [];
  let genreLoopCount = 0;
  for (const artist of candidateArtists.values()) {
    genreLoopCount++;
    const followers = artist.followers.total;
    if (followers < MIN_FOLLOWERS || followers > MAX_FOLLOWERS) continue;

    const genres = new Set(artist.genres);
    const coreOverlap = [...genres].filter((g) => coreGenreSet.has(g));
    if (coreOverlap.length < 2) continue;

    if ([...genres].every((g) => UNIVERSAL_BANNED.has(g))) continue;

    genrePassed.push(artist);

    // [v3-F] Yield every 200 iterations in CPU-bound genre loop
    if (genreLoopCount % 200 === 0) await yieldToEventLoop();
  }

  // Phase 6: Get top tracks
  const shuffled = [...genrePassed].sort(() => Math.random() - 0.5);
  const candidateTracks: Array<{ track: SpotifyTrack; artist: SpotifyArtist }> = [];

  for (let i = 0; i < shuffled.length; i++) {
    const artist = shuffled[i];
    try {
      const topTracks = await getArtistTopTracks(artist.id);
      for (const track of topTracks.sort((a, b) => b.popularity - a.popularity)) {
        if (existingTrackIds.has(track.id)) continue;
        if (!isLatinName(track.name)) continue;
        if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
        const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
        if (year < minYear) continue;
        candidateTracks.push({ track, artist });
        break;
      }
    } catch { continue; }

    if (i % 10 === 0) {
      onProgress({ phase: "discover", message: `Checking artists: ${i}/${shuffled.length}`, percent: 55 + (i / shuffled.length) * 15 });
    }
  }

  // Phase 7: Score ALL candidates
  onProgress({ phase: "score", message: "Scoring all candidates...", percent: 75 });
  const candidateIds = candidateTracks.map((c) => c.track.id);
  const candidateFeatures = await getAudioFeaturesBatch(candidateIds, (done, total) => {
    onProgress({ phase: "score", message: `Audio scoring: ${done}/${total}`, percent: 75 + (done / total) * 20 });
  });

  const scored: ScoredTrack[] = [];
  for (let i = 0; i < candidateTracks.length; i++) {
    const { track, artist } = candidateTracks[i];
    const feats = candidateFeatures.get(track.id);
    if (!feats) continue;
    const score = scoreCandidate(feats, tasteVector);
    const matchedGenres = artist.genres.filter((g) => coreGenreSet.has(g));
    scored.push({ track, score, artist, matchedGenres });

    // [v3-F] Yield every 200 iterations in scoring loop
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  scored.sort((a, b) => b.score - a.score);
  onProgress({ phase: "done", message: "Complete!", percent: 100 });

  return {
    tasteVector,
    coreGenres,
    tracksAnalyzed: trackIds.length,
    tracksWithFeatures: features.size,
    candidateArtists: candidateArtists.size,
    genrePassed: genrePassed.length,
    candidateTracks: candidateTracks.length,
    scored: scored.length,
    results: scored.slice(0, resultCount),
  };
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: discovery pipeline with dynamic genre extraction"
```

---

## Batch 3: Wizard UI (Steps 3-6)

### Task 7: Playlist selection step [v3-B — full TSX code]

**Files:**
- Create: `web/src/components/PlaylistStep.tsx`

**Step 1: Create playlist grid** [M4 FIX — image fallback, v3-B — full code]

Create `web/src/components/PlaylistStep.tsx`:
```tsx
"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { getUserPlaylists, type SpotifyPlaylist } from "@/lib/spotify-client";

interface PlaylistStepProps {
  onSelect: (playlist: SpotifyPlaylist) => void;
}

// [M4 FIX] Placeholder when playlist has no cover image
function PlaylistImagePlaceholder(): React.ReactElement {
  return (
    <div className="w-full aspect-square bg-[var(--bg-secondary)] flex items-center justify-center rounded-md">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className="w-12 h-12 text-[var(--text-secondary)]"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={1}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"
        />
      </svg>
    </div>
  );
}

export default function PlaylistStep({ onSelect }: PlaylistStepProps): React.ReactElement {
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getUserPlaylists()
      .then((data) => {
        setPlaylists(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load playlists");
        setLoading(false);
      });
  }, []);

  const filtered = playlists.filter((pl) =>
    pl.name.toLowerCase().includes(search.toLowerCase()),
  );

  if (loading) {
    return (
      <div className="text-center space-y-4">
        <div className="inline-block w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
        <p className="text-[var(--text-secondary)]">Loading your playlists...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center space-y-4">
        <p className="text-red-400">{error}</p>
        <button
          onClick={() => { setError(null); setLoading(true); getUserPlaylists().then(setPlaylists).catch((e: unknown) => setError(e instanceof Error ? e.message : "Error")).finally(() => setLoading(false)); }}
          className="px-6 py-2 bg-[var(--accent)] rounded-lg font-semibold"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold mb-2">Choose a Playlist</h2>
        <p className="text-[var(--text-secondary)]">
          SoundFox will analyze this playlist&apos;s audio DNA to find matching hidden gems.
        </p>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search playlists..."
        className="w-full px-4 py-3 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg
                   focus:outline-none focus:border-[var(--accent)] text-white placeholder-gray-500"
      />

      {filtered.length === 0 ? (
        <p className="text-center text-[var(--text-secondary)] py-8">
          {search ? "No playlists match your search." : "No playlists found."}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 max-h-[60vh] overflow-y-auto pr-1">
          {filtered.map((pl) => (
            <button
              key={pl.id}
              onClick={() => onSelect(pl)}
              className="group bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-3
                         hover:border-[var(--accent)] hover:bg-[var(--bg-secondary)] transition-all
                         text-left flex flex-col gap-2"
            >
              {/* [M4 FIX] Image with fallback */}
              {pl.images.length > 0 ? (
                <div className="w-full aspect-square relative rounded-md overflow-hidden">
                  <Image
                    src={pl.images[0].url}
                    alt={pl.name}
                    fill
                    sizes="(max-width: 640px) 50vw, 33vw"
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
              ) : (
                <PlaylistImagePlaceholder />
              )}

              <div className="min-w-0">
                <p className="font-semibold text-sm truncate group-hover:text-[var(--accent)] transition-colors">
                  {pl.name}
                </p>
                <p className="text-[var(--text-secondary)] text-xs mt-0.5">
                  {pl.tracks.total} tracks
                </p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: playlist selection step"
```

---

### Task 8: Analysis step with error handling [H3 FIX, v3-C — full TSX code]

**Files:**
- Create: `web/src/components/AnalysisStep.tsx`

**Step 1: Create analysis progress with error state** [v3-C — full code]

Create `web/src/components/AnalysisStep.tsx`:
```tsx
"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { runPipeline, type PipelineProgress, type PipelineResult } from "@/lib/discovery-pipeline";
import { type SpotifyPlaylist } from "@/lib/spotify-client";

interface AnalysisStepProps {
  playlist: SpotifyPlaylist;
  onComplete: (result: PipelineResult) => void;
}

interface PhaseConfig {
  key: string;
  label: string;
  icon: string;
}

const PHASES: PhaseConfig[] = [
  { key: "analyze", label: "Analyzing playlist", icon: "🔬" },
  { key: "discover", label: "Discovering artists", icon: "🔍" },
  { key: "score", label: "Scoring candidates", icon: "⭐" },
  { key: "done", label: "Complete", icon: "✓" },
];

export default function AnalysisStep({ playlist, onComplete }: AnalysisStepProps): React.ReactElement {
  const [progress, setProgress] = useState<PipelineProgress>({
    phase: "analyze",
    message: "Starting...",
    percent: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef(false);

  const start = useCallback((): void => {
    abortRef.current = false;
    setError(null);
    setRunning(true);
    setProgress({ phase: "analyze", message: "Starting...", percent: 0 });

    runPipeline(playlist.id, (p) => {
      if (!abortRef.current) setProgress(p);
    })
      .then((result) => {
        if (!abortRef.current) {
          setRunning(false);
          onComplete(result);
        }
      })
      .catch((err: unknown) => {
        if (!abortRef.current) {
          setRunning(false);
          setError(err instanceof Error ? err.message : "An unexpected error occurred");
        }
      });
  }, [playlist.id, onComplete]);

  // Auto-start on mount
  useEffect(() => {
    start();
    return () => {
      abortRef.current = true;
    };
  }, [start]);

  const currentPhaseIndex = PHASES.findIndex((p) => p.key === progress.phase);

  // [H3 FIX] Error state with retry button
  if (error) {
    return (
      <div className="space-y-6 text-center">
        <div className="bg-red-950/30 border border-red-800 rounded-xl p-6">
          <p className="text-red-400 text-lg font-semibold mb-2">Analysis Failed</p>
          <p className="text-[var(--text-secondary)] text-sm">{error}</p>
        </div>
        <div className="space-y-3">
          <button
            onClick={start}
            className="w-full py-3 bg-[var(--accent)] hover:bg-[var(--accent-hover)] rounded-lg font-semibold transition-colors"
          >
            Retry Analysis
          </button>
          <p className="text-[var(--text-secondary)] text-xs">
            Common causes: Spotify session expired, network timeout, or empty playlist.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-3xl font-bold mb-2">Analyzing Playlist</h2>
        <p className="text-[var(--text-secondary)]">
          Finding music that matches the audio DNA of{" "}
          <span className="text-white font-medium">{playlist.name}</span>
        </p>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm text-[var(--text-secondary)]">
          <span>{progress.message}</span>
          <span>{Math.round(progress.percent)}%</span>
        </div>
        <div className="w-full bg-[var(--bg-secondary)] rounded-full h-2 overflow-hidden">
          <div
            className="bg-[var(--accent)] h-2 rounded-full transition-all duration-500"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      </div>

      {/* Phase indicators */}
      <div className="space-y-3">
        {PHASES.filter((p) => p.key !== "done").map((phase, index) => {
          const isDone = currentPhaseIndex > index;
          const isActive = currentPhaseIndex === index;
          return (
            <div
              key={phase.key}
              className={`flex items-center gap-3 p-3 rounded-lg transition-colors ${
                isActive
                  ? "bg-[var(--bg-card)] border border-[var(--accent)]/30"
                  : isDone
                  ? "opacity-50"
                  : "opacity-30"
              }`}
            >
              <span className="text-xl w-8 text-center">
                {isDone ? "✓" : isActive ? (
                  <span className="inline-block w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                ) : phase.icon}
              </span>
              <div>
                <p className={`font-medium text-sm ${isActive ? "text-white" : "text-[var(--text-secondary)]"}`}>
                  {phase.label}
                </p>
                {isActive && (
                  <p className="text-[var(--text-secondary)] text-xs mt-0.5">{progress.message}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {running && (
        <p className="text-center text-[var(--text-secondary)] text-sm">
          This takes 2-5 minutes depending on playlist size. Please keep the tab open.
        </p>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: analysis step with progress + error handling"
```

---

### Task 9: Results step with history saving [H5 FIX, v3-D — full TSX code]

**Files:**
- Create: `web/src/components/ResultsStep.tsx`

**Step 1: Create results with preview + history save** [v3-D — full code]

Create `web/src/components/ResultsStep.tsx`:
```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { type PipelineResult, type ScoredTrack } from "@/lib/discovery-pipeline";
import { saveAnalysis } from "@/lib/storage";
import { getCurrentUser, createPlaylist, addTracksToPlaylist } from "@/lib/spotify-client";

interface ResultsStepProps {
  result: PipelineResult;
  playlistName: string;
  playlistId: string;
}

export default function ResultsStep({ result, playlistName, playlistId }: ResultsStepProps): React.ReactElement {
  const { results, tasteVector, coreGenres } = result;

  // Checkboxes — all selected by default
  const [selected, setSelected] = useState<Set<string>>(() => new Set(results.map((r) => r.track.id)));
  // Preview player
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Playlist creation
  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  // [H5 FIX] Save analysis to localStorage on mount
  useEffect(() => {
    const meanVector: Record<string, number> = {};
    for (const [k, v] of Object.entries(tasteVector.mean)) {
      if (v != null) meanVector[k] = v;
    }
    saveAnalysis({
      id: crypto.randomUUID(),
      playlistId,
      playlistName,
      trackCount: result.tracksAnalyzed,
      tasteVector: meanVector,
      resultCount: results.length,
      createdAt: new Date().toISOString(),
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleTrack(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(): void {
    if (selected.size === results.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(results.map((r) => r.track.id)));
    }
  }

  function handlePreview(track: ScoredTrack["track"]): void {
    if (playingId === track.id) {
      // Stop
      audioRef.current?.pause();
      setPlayingId(null);
      setPreviewUrl(null);
      return;
    }
    if (!track.preview_url) return;
    audioRef.current?.pause();
    setPreviewUrl(track.preview_url);
    setPlayingId(track.id);
  }

  // Auto-play when previewUrl changes
  useEffect(() => {
    if (previewUrl && audioRef.current) {
      audioRef.current.src = previewUrl;
      audioRef.current.play().catch(() => {
        // Autoplay blocked — user must click again
      });
    }
  }, [previewUrl]);

  async function handleCreatePlaylist(): Promise<void> {
    setCreating(true);
    setCreateError(null);
    try {
      const user = await getCurrentUser();
      const selectedTracks = results.filter((r) => selected.has(r.track.id));
      const newPlaylist = await createPlaylist(
        user.id,
        `SoundFox: ${playlistName}`,
        `Discovered by SoundFox — ${selectedTracks.length} tracks matching your taste profile`,
      );
      await addTracksToPlaylist(
        newPlaylist.id,
        selectedTracks.map((r) => `spotify:track:${r.track.id}`),
      );
      setCreatedUrl(`https://open.spotify.com/playlist/${newPlaylist.id}`);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : "Failed to create playlist");
    } finally {
      setCreating(false);
    }
  }

  const selectedCount = selected.size;
  const topGenres = coreGenres.slice(0, 6);

  return (
    <div className="space-y-6">
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        onEnded={() => setPlayingId(null)}
        className="hidden"
      />

      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold mb-2">Your Recommendations</h2>
        <p className="text-[var(--text-secondary)]">
          Found {results.length} tracks matching your taste profile from{" "}
          <span className="text-white font-medium">{playlistName}</span>
        </p>
      </div>

      {/* Taste summary — dynamic genres [C3 FIX] */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
        <p className="text-sm font-semibold text-[var(--text-secondary)] mb-2">Your Taste Profile</p>
        <div className="flex flex-wrap gap-2">
          {topGenres.map((genre) => (
            <span
              key={genre}
              className="px-3 py-1 bg-[var(--accent)]/10 border border-[var(--accent)]/30
                         text-[var(--accent)] rounded-full text-xs font-medium capitalize"
            >
              {genre}
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 text-center text-xs">
          <div>
            <p className="text-[var(--text-secondary)]">Analyzed</p>
            <p className="text-white font-semibold">{result.tracksAnalyzed} tracks</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Candidates</p>
            <p className="text-white font-semibold">{result.candidateTracks}</p>
          </div>
          <div>
            <p className="text-[var(--text-secondary)]">Scored</p>
            <p className="text-white font-semibold">{result.scored}</p>
          </div>
        </div>
      </div>

      {/* Track list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm text-[var(--text-secondary)]">{selectedCount} of {results.length} selected</p>
          <button onClick={toggleAll} className="text-sm text-[var(--accent)] hover:underline">
            {selectedCount === results.length ? "Deselect all" : "Select all"}
          </button>
        </div>

        <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
          {results.map((item, index) => {
            const isSelected = selected.has(item.track.id);
            const isPlaying = playingId === item.track.id;
            const hasPreview = !!item.track.preview_url;
            const albumImage = item.track.album.images[0]?.url;
            const scorePercent = Math.round(item.score * 100);

            return (
              <div
                key={item.track.id}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                  isSelected
                    ? "bg-[var(--bg-card)] border-[var(--accent)]/30"
                    : "bg-[var(--bg-secondary)] border-[var(--border)] opacity-60"
                }`}
              >
                {/* Rank */}
                <span className="text-[var(--text-secondary)] text-sm w-6 text-center flex-shrink-0">
                  {index + 1}
                </span>

                {/* Album art */}
                <div className="w-10 h-10 flex-shrink-0 rounded overflow-hidden bg-[var(--bg-secondary)]">
                  {albumImage ? (
                    <Image src={albumImage} alt="" width={40} height={40} className="object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[var(--text-secondary)] text-xs">
                      ♪
                    </div>
                  )}
                </div>

                {/* Track info */}
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">{item.track.name}</p>
                  <p className="text-[var(--text-secondary)] text-xs truncate">{item.artist.name}</p>
                  {item.matchedGenres.length > 0 && (
                    <p className="text-[var(--accent)] text-xs truncate mt-0.5">
                      {item.matchedGenres.slice(0, 2).join(", ")}
                    </p>
                  )}
                </div>

                {/* Score badge */}
                <div className="flex-shrink-0 text-center w-12">
                  <p className="text-[var(--accent)] font-bold text-sm">{scorePercent}%</p>
                  <p className="text-[var(--text-secondary)] text-xs">match</p>
                </div>

                {/* Preview button */}
                <button
                  onClick={() => handlePreview(item.track)}
                  disabled={!hasPreview}
                  className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    hasPreview
                      ? isPlaying
                        ? "bg-[var(--accent)] text-black"
                        : "bg-[var(--bg-secondary)] hover:bg-[var(--accent)]/20 text-[var(--text-secondary)]"
                      : "opacity-20 cursor-not-allowed bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
                  }`}
                  title={hasPreview ? (isPlaying ? "Stop preview" : "Play 30s preview") : "No preview available"}
                >
                  {isPlaying ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3">
                      <rect x="6" y="4" width="4" height="16" />
                      <rect x="14" y="4" width="4" height="16" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3 ml-0.5">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>

                {/* Checkbox */}
                <button
                  onClick={() => toggleTrack(item.track.id)}
                  className={`flex-shrink-0 w-5 h-5 rounded border-2 transition-colors flex items-center justify-center ${
                    isSelected
                      ? "bg-[var(--accent)] border-[var(--accent)]"
                      : "border-[var(--border)] hover:border-[var(--accent)]/50"
                  }`}
                >
                  {isSelected && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} className="w-3 h-3 text-black">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Create playlist CTA */}
      <div className="space-y-3 pt-2">
        {createdUrl ? (
          <div className="bg-green-950/30 border border-green-800 rounded-xl p-4 text-center space-y-2">
            <p className="text-green-400 font-semibold">Playlist created!</p>
            <a
              href={createdUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-6 py-2 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-sm transition-colors"
            >
              Open in Spotify
            </a>
          </div>
        ) : (
          <>
            {createError && (
              <p className="text-red-400 text-sm text-center">{createError}</p>
            )}
            <button
              onClick={() => void handleCreatePlaylist()}
              disabled={creating || selectedCount === 0}
              className={`w-full py-3 rounded-lg font-semibold transition-colors ${
                creating || selectedCount === 0
                  ? "bg-[var(--bg-secondary)] text-[var(--text-secondary)] cursor-not-allowed"
                  : "bg-[var(--accent)] hover:bg-[var(--accent-hover)]"
              }`}
            >
              {creating
                ? "Creating playlist..."
                : `Create Playlist (${selectedCount} tracks)`}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: results step with preview + history saving"
```

---

### Task 10: Wire all wizard steps together [M1 FIX — full code]

**Files:**
- Modify: `web/src/app/wizard/page.tsx`

**Step 1: Full wizard page**

Replace `web/src/app/wizard/page.tsx`:
```tsx
"use client";

import { useState, useEffect, useCallback } from "react";
import WizardLayout from "@/components/WizardLayout";
import SetupStep from "@/components/SetupStep";
import PlaylistStep from "@/components/PlaylistStep";
import AnalysisStep from "@/components/AnalysisStep";
import ResultsStep from "@/components/ResultsStep";
import { getClientId, getAccessToken } from "@/lib/storage";
import { startLogin } from "@/lib/spotify-auth";
import { getCurrentUser, type SpotifyUser, type SpotifyPlaylist } from "@/lib/spotify-client";
import { type PipelineResult } from "@/lib/discovery-pipeline";

const STEP_NAMES = ["Setup", "Connect", "Choose Playlist", "Analyze", "Results"];

export default function WizardPage(): React.ReactElement {
  const [step, setStep] = useState(1);
  const [user, setUser] = useState<SpotifyUser | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<SpotifyPlaylist | null>(null);
  const [pipelineResult, setPipelineResult] = useState<PipelineResult | null>(null);

  useEffect(() => {
    if (getClientId()) {
      if (getAccessToken()) {
        getCurrentUser().then((u) => { setUser(u); setStep(3); }).catch(() => setStep(2));
      } else {
        setStep(2);
      }
    }
  }, []);

  const handlePlaylistSelect = useCallback((pl: SpotifyPlaylist) => {
    setSelectedPlaylist(pl);
    setStep(4);
  }, []);

  const handleAnalysisComplete = useCallback((result: PipelineResult) => {
    setPipelineResult(result);
    setStep(5);
  }, []);

  return (
    <WizardLayout step={step} totalSteps={5} stepName={STEP_NAMES[step - 1]}>
      {step === 1 && <SetupStep onComplete={() => setStep(2)} />}

      {step === 2 && (
        <div className="text-center space-y-6">
          <h2 className="text-3xl font-bold">Connect Your Spotify</h2>
          <p className="text-[var(--text-secondary)]">
            SoundFox needs access to your playlists. We never store your data on any server.
          </p>
          <button onClick={() => { startLogin().catch(console.error); }}
            className="px-8 py-4 bg-[#1DB954] hover:bg-[#1aa34a] rounded-full font-semibold text-lg transition-colors">
            Connect with Spotify
          </button>
          {user && <p className="text-[var(--text-secondary)]">Connected as <strong className="text-white">{user.display_name}</strong></p>}
        </div>
      )}

      {step === 3 && <PlaylistStep onSelect={handlePlaylistSelect} />}

      {step === 4 && selectedPlaylist && (
        <AnalysisStep playlist={selectedPlaylist} onComplete={handleAnalysisComplete} />
      )}

      {step === 5 && pipelineResult && selectedPlaylist && (
        <ResultsStep result={pipelineResult} playlistName={selectedPlaylist.name} playlistId={selectedPlaylist.id} />
      )}
    </WizardLayout>
  );
}
```

**Step 2: Test full flow**

```bash
cd web && npm run dev
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: wire all wizard steps together"
```

---

## Batch 4: Polish + GitHub

### Task 11: GitHub setup

**Step 1: Initialize repo**

```bash
cd C:\Users\fires\OneDrive\Git\spotify-recommendation
git init
```

Update root `.gitignore` to include `web/node_modules`, `web/.next`.

**Step 2: Create GitHub repo**

```bash
gh repo create soundfox --public --source=. --push
```

---

### Task 12: End-to-end verification

- Clear localStorage
- localhost:3000 → Get Started → Enter Client ID → Connect Spotify → Pick playlist → Watch analysis → See results → Create playlist
- Verify playlist appears in Spotify
- Verify history saved in localStorage
