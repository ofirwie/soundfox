# SoundFox v3 — Intent-Driven Multi-Source Learning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform SoundFox from a single-source (Spotify + ReccoBeats) averaged-vector recommender into an intent-driven, multi-source, learning system that respects playlist purpose, never re-shows rejected tracks, explains every recommendation, and uses multi-cluster taste modeling so heavy rock and mellow ballads don't average into "mushy middle" noise.

**Architecture:**
1. **Per-playlist profile** in `localStorage` stores `{intent, blacklist, accepted, stats}` keyed by `playlistId`.
2. **Intent pipeline** routes free text through `/api/intent` (Gemini) → structured `Intent` → optional user edit → pipeline config.
3. **Multi-source candidate fan-out** (Spotify search + LLM via `/api/llm-recommend` + Last.fm similar-artists) → merge → strong dedup → multi-cluster scoring → quality threshold → render with "Why this" panel.
4. **Learning loop** replaces the averaged taste vector with a *refined* vector from accepted tracks (once ≥20), re-weights genres by acceptance rate, and hard-blacklists rejections.

**Tech Stack:** Next.js 16.2.4, React 19.2.4 (strict), TypeScript strict, Tailwind v4, Gemini 3.1 Pro Preview (server-side only), ReccoBeats (audio features proxy), Spotify Web API (client-side), Last.fm API (new), Playwright (verification).

**Local-only:** Runs on `127.0.0.1:3000` via `npm run dev`. No hosted services. All secrets in `web/.env` (gitignored). `allowedDevOrigins` in `next.config.ts` is mandatory.

---

## Ground Rules for Every Phase

Copy this checklist. Apply it at the end of every batch before marking the phase done.

- [ ] `npm run build` (inside `web/`) passes with **zero** TypeScript / ESLint errors.
- [ ] Playwright test for the phase asserts the golden path AND at least one negative case (Global Rule 11).
- [ ] Screenshot captured at `web/test-screenshots/<phase>-<task>.png` and referenced in the commit message.
- [ ] If the phase touches UI: visual diff against the previous version (compare the two screenshots, describe what changed).
- [ ] All files that use `localStorage` / `window` / `document` start with `"use client";` (primer rule).
- [ ] All React type annotations use named imports (`ReactElement`, `ReactNode`) — **never** `React.*`.
- [ ] No `localStorage` read at the top level of a component body or as a direct `useState` initializer (hydration safety).
- [ ] `web/soundfox-debug.log` inspected for any new errors after the Playwright run.
- [ ] No secret values printed to conversation. No secret values hard-coded in source.
- [ ] Commit message authored as `SoundFox Dev <dev@soundfox.local>` — follow the convention from `docs/handoff/2026-04-21-soundfox-v3-full-context.md` section 6.

**Reality check before claiming a phase is done:** run `/reality-check` (Global Rule 16) — list what you ran, generate 5 adversarial questions, answer each VERIFIED / ASSUMED / UNKNOWN. Any ASSUMED or UNKNOWN = not done.

---

## Glossary

Exact names used throughout this plan. Never invent variants.

| Term | Where | Meaning |
|---|---|---|
| `PlaylistProfile` | new interface in `lib/profile.ts` | Full per-playlist memory object |
| `Blacklist` | field of `PlaylistProfile` | `{ trackIds, artistIds, artistNames, genres, rejectionsByArtist }` — **both** artist IDs (for local filtering) and artist names (for passing to Gemini as excludeArtists) |
| `AcceptanceLog` | field of `PlaylistProfile` | `{ trackIds[], refinedTasteVector | null }` |
| `Intent` | canonical definition in **new** `lib/intent-types.ts` (Phase 0 Task 0.3). Re-exported from `gemini-server.ts` and `llm-source.ts`. Single source of truth — do not redefine elsewhere. |
| `LLMRecommendation` | canonical definition in `lib/intent-types.ts` (same file as Intent) | `{ artist, track, why, confidence }` |
| `Candidate` | new interface in `lib/candidates.ts` | `{ track, artist, sourceTags: SourceTag[], matchedGenres, llmWhy? }` — pre-score |
| `ScoredCandidate` | extends `Candidate` | Adds `{ score, cluster, breakdown }` |
| `Cluster` | new interface in `lib/clustering.ts` | `{ id, centroid, memberCount, label: string }` — label is assigned at cluster-build time (Phase 4), not retrofitted in Phase 6 |
| `TasteClusters` | new interface in `lib/clustering.ts` | `{ clusters[], k, assignments }` |
| `WhyBreakdown` | new interface in `lib/scoring.ts` | Per-track explanation object used by "Why this" panel |
| `SourceTag` | string union in `lib/candidates.ts` | `"spotify"` \| `"llm"` \| `"lastfm"` |
| `sourceTags` | field of `Candidate` | `SourceTag[]` (**array, plural**) — a single track can be surfaced by multiple fan-out paths; preserve all tags for transparency in the Why panel |
| `qualityTier` | UI concept in `IntentEditor.tsx` (not stored on Intent) | `"premium"` \| `"balanced"` \| `"inclusive"`. Maps 1:1 to numeric `Intent.qualityThreshold`. Calibrated thresholds live in `intent-types.ts` (see Phase 4 H5 calibration task). |
| `scanId` | `crypto.randomUUID()` minted at start of `runPipelineStreaming` | Correlation ID attached to every `/api/log` event from a single scan (H6) |

**Rule:** if code needs a name for a new concept, add it to this glossary **first**, then use it. If this plan says `PlaylistProfile`, do not type `PlaylistContext`.

---

## Phase 0 — Pre-flight (must complete before Phase 1)

**Why:** Next.js 16 / React 19.2 have breaking changes from training data. Pre-flight locks in the authoritative references.

**Files to read (do not modify):**
- `web/AGENTS.md`
- `web/CLAUDE.md`
- `.claude/primer.md`
- `node_modules/next/dist/docs/` — at minimum skim `app-router.md`, `route-handlers.md`, `suspense.md`
- `docs/handoff/2026-04-21-soundfox-v3-full-context.md` (full)
- `web/src/lib/discovery-pipeline.ts` — read the full streaming generator
- `web/src/lib/taste-engine.ts` — understand the current scoring math
- `web/src/lib/storage.ts` — understand existing `localStorage` keys (do not collide)
- `web/src/lib/gemini-server.ts` + `web/src/lib/llm-source.ts` — understand existing Gemini contract
- `web/src/components/ResultsStep.tsx` — understand the existing row rendering so the "Why" panel can slot in without breakage

**Step 1: Verify env file state (do NOT print values)**
```bash
git -C C:/Users/fires/OneDrive/Git/spotify-recommendation check-ignore web/.env
# expected output: web/.env  (exit 0)
```
If `web/.env` is not gitignored → STOP and fix `.gitignore` first. Global Rule 18.

**Step 2: Verify env vars exist (presence, not value)**

Do **not** use `node --env-file=.env` (requires Node ≥ 20.6 and may not be available). Use a version-agnostic check:
```bash
cd web
node -e "console.log('.env:', require('fs').existsSync('.env') ? 'FOUND' : 'MISSING')"
grep -c '^GEMINI_API_KEY=' .env
grep -c '^GEMINI_MODEL=' .env
# For Phase 7 only:
grep -c '^LASTFM_API_KEY=' .env  # expect 0 until Phase 7
```
Expected: each grep returns `1` for required keys. This counts the **variable name**, never prints the value. [fix-M3]

**Step 3: Baseline Playwright smoke test**
Run the existing `web/test-full-flow.mjs` and confirm it still passes against the v2 code before touching anything. Save the before-screenshot as `web/test-screenshots/baseline-v2.png`. If the baseline is broken, fix the baseline first — do not start v3 on top of a broken baseline.

**Step 4: Clean Turbopack cache**

**Windows note [fix-M6]:** before `rm -rf web/.next`, kill any running `next dev` process — otherwise Windows throws `EBUSY` on locked files. If you see `EBUSY`, find the node PID (`tasklist | grep node`), kill it, wait 2 seconds, retry.
```bash
# Stop dev server first if running, then:
rm -rf web/.next
cd web && npm run build
```
Expected: zero errors.

**Step 5: Commit the baseline screenshot**
```bash
git add web/test-screenshots/baseline-v2.png
git commit -m "chore: v3 pre-flight — baseline screenshot"
```

### Task 0.1 — Install Vitest + jsdom test runner [fix-C1 / fix-H1]

**Why:** Plan uses `import { describe, it, expect } from "vitest"` in every unit test and needs `localStorage.clear()` (requires DOM env). Current `package.json` has no runner installed — every Phase 1+ unit test would fail with `Cannot find module 'vitest'`.

**Files:**
- Modify: `web/package.json` — add `test` script
- Create: `web/vitest.config.ts`

**Step 1:** Install:
```bash
cd web
npm i -D vitest @vitest/ui jsdom
```

**Step 2:** Create `web/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: [],  // add if we need global mocks later
  },
  resolve: {
    alias: { "@": "/src" },
  },
});
```

**Step 3:** Add to `web/package.json` scripts:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 4:** Sanity test. Create `web/__tests__/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
describe("runner", () => {
  it("has localStorage (jsdom)", () => {
    localStorage.setItem("x", "1");
    expect(localStorage.getItem("x")).toBe("1");
    localStorage.clear();
  });
});
```
Run `npx vitest run` → 1 passing test.

**Step 5: Commit.**
```bash
git add web/package.json web/vitest.config.ts web/__tests__/smoke.test.ts
git commit -m "chore(v3): install vitest + jsdom for unit tests"
```

**Note:** The earlier wording *"use `vitest` if present; otherwise `node:test`"* is **removed**. The fallback was a trap — `node:test` uses a different API (`test()` + `assert`) and none of the plan's tests would run against it. Vitest is the single runner. [fix-C1]

### Task 0.2 — Tighten `AudioFeatures` to `Partial<Record<FeatureKey, number>>` [fix-C2]

**Why:** Plan's negative tests (Phase 4.2, Phase 6.1) assume a candidate can have *missing* audio features. Current type `AudioFeatures = Record<FeatureKey, number>` says every feature is required — TS strict refuses to construct a partial literal. Meanwhile `reccobeats.ts:40-45` already builds partials at runtime and casts with `as AudioFeatures`. The runtime is honest; the type is a lie.

**Files:**
- Modify: `web/src/lib/reccobeats.ts:10` — change type
- Modify: `web/src/lib/reccobeats.ts:40-45` — remove the `as AudioFeatures` cast
- Verify: `taste-engine.ts:32-38, 97` — already handles missing values at runtime (no change needed, but read and confirm)

**Step 1:** Edit `reccobeats.ts:10`:
```ts
export type AudioFeatures = Partial<Record<FeatureKey, number>>;
```

**Step 2:** Edit `reccobeats.ts:40-45` — drop the cast:
```ts
const features: AudioFeatures = {};
let has = false;
for (const key of FEATURE_KEYS) {
  if (item[key] != null) { features[key] = Number(item[key]); has = true; }
}
if (has) results.set(spotifyId, features);
```

**Step 3:** `cd web && npm run build` → expect zero errors. If TypeScript complains elsewhere, fix those call sites — they were relying on the lie. Most likely `taste-engine.ts` already handles `null` correctly (it does — verified `taste-engine.ts:32-38` uses `features[key] != null` guard).

**Step 4:** Run `npx vitest run` → smoke test still passes.

**Step 5: Commit.**
```bash
git add web/src/lib/reccobeats.ts
git commit -m "refactor(v3): AudioFeatures is Partial — runtime always was"
```

### Task 0.3 — Extract canonical `Intent` + `LLMRecommendation` types [fix-C3]

**Why:** `Intent` is defined twice — `gemini-server.ts:12-32` and `llm-source.ts:6-23` — and the two definitions already drift (`era?: string` vs `era?: string | null`). Phase 3 adds consumers on both sides; the drift will grow. Consolidate before the drift compounds.

**Files:**
- Create: `web/src/lib/intent-types.ts`
- Modify: `web/src/lib/gemini-server.ts` — import + re-export from `intent-types.ts`, delete local `Intent` / `LLMRecommendation`
- Modify: `web/src/lib/llm-source.ts` — same
- Create: `web/__tests__/intent-types.test.ts` — contract round-trip

**Step 1:** Create `web/src/lib/intent-types.ts` (no `"use client"` — pure types, usable server + client):
```ts
export interface Intent {
  purpose: string;
  audioConstraints: {
    tempoMin?: number;
    tempoMax?: number;
    energyMin?: number;
    energyMax?: number;
    valenceMin?: number;
    valenceMax?: number;
    popularityHint?: "low" | "mid" | "high";
  };
  genres: { include: string[]; exclude: string[] };
  era?: string | null;
  requirements: string[];
  allowKnownArtists: boolean;
  qualityThreshold: number;
  notes: string;
  /** Set true when the server couldn't parse and returned a safe default (fix-H9) */
  intentParseFailed?: boolean;
}

export interface LLMRecommendation {
  artist: string;
  track: string;
  why: string;
  confidence: number;
}

/** Calibrated quality thresholds — values come from Phase 4 H5 calibration task */
export const QUALITY_TIERS = {
  premium: 0.75,
  balanced: 0.60,
  inclusive: 0.40,
} as const;
export type QualityTier = keyof typeof QUALITY_TIERS;

/** Safe default intent used when Gemini parse fails after retry (fix-H9) */
export function defaultIntent(): Intent {
  return {
    purpose: "general",
    audioConstraints: {},
    genres: { include: [], exclude: [] },
    era: null,
    requirements: [],
    allowKnownArtists: true,
    qualityThreshold: QUALITY_TIERS.balanced,
    notes: "Safe default — Gemini parse failed, user should edit",
    intentParseFailed: true,
  };
}
```

**Step 2:** In `gemini-server.ts`, delete the local `Intent` and `LLMRecommendation` interfaces and add at the top:
```ts
import type { Intent, LLMRecommendation } from "./intent-types";
export type { Intent, LLMRecommendation }; // re-export for callers that import from this module
```

**Step 3:** Same in `llm-source.ts` — delete the local `Intent` and `LLMRecommendation`, import + re-export from `intent-types`.

**Step 4:** Contract test — `web/__tests__/intent-types.test.ts`:
```ts
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
```

**Step 5:** `cd web && npm run build && npx vitest run` → zero errors, tests pass.

**Step 6: Commit.**
```bash
git add web/src/lib/intent-types.ts web/src/lib/gemini-server.ts web/src/lib/llm-source.ts web/__tests__/intent-types.test.ts
git commit -m "refactor(v3): single source of truth for Intent + LLMRecommendation types"
```

### Task 0.4 — Raise ReccoBeats proxy rate limit to 120/min [fix-C6]

**Why:** Multi-source fan-out (Spotify search + LLM + Last.fm) combined with deep sampling (top-5 per artist) can produce ~4000 candidate tracks per scan. At batch size 40 that's 100 audio-feature calls. The current 30/min limit turns a scan into a 3–5 minute ordeal. The limit exists to throttle abuse — we are the only client of this local dev server.

**Scan-time budget:** a scan of a 171-track source playlist (ISA ROCK) must complete in **≤60 seconds** end-to-end. If it takes longer, investigate rather than accept — a 3-minute scan is a bug, not a feature.

**Files:**
- Modify: `web/src/app/api/reccobeats/route.ts:13` — raise `RATE_LIMIT_MAX` from 30 to 120

**Step 1:** Edit:
```ts
const RATE_LIMIT_MAX = 120;  // v3: raised from 30 to accommodate multi-source fan-out + deep sampling
```
Update the 429 error message to match: `"Rate limit exceeded. Max 120 requests per minute."`.

**Step 2:** `cd web && npm run build` → zero errors.

**Step 3:** Smoke test — start `npm run dev`, run the existing `test-full-flow.mjs` baseline again, confirm no regression.

**Step 4: Commit.**
```bash
git add web/src/app/api/reccobeats/route.ts
git commit -m "feat(v3): raise ReccoBeats proxy rate limit to 120/min for multi-source fan-out"
```

### Task 0.5 — Refactor `discovery-pipeline.ts` into pluggable modules [review-1]

**Why:** `discovery-pipeline.ts` is modified in **every** subsequent phase (1, 2, 3, 4, 5, 6, 7, 8). As a single 600-line async generator it becomes a merge-conflict machine and forces the engineer to rebuild their mental model every phase. Split it once, up front, as a pure no-op refactor so later phases can each touch one seam.

**Non-goal:** this task must not change behavior. If `test-full-flow.mjs` still passes unchanged against the refactored pipeline, the refactor is done.

**Files:**
- Create: `web/src/lib/pipeline/build-source-taste.ts` — move `buildGenreProfile` + the taste-vector builder from the current file
- Create: `web/src/lib/pipeline/source-spotify.ts` — move the Spotify-search candidate-collection block; expose as `async function* buildSpotifyCandidates(...)`
- Create: `web/src/lib/pipeline/merge-and-emit.ts` — the batch loop: collect from source(s) → genre gate → score → emit `BatchUpdate`
- Modify: `web/src/lib/discovery-pipeline.ts` — shrinks to ~50 lines of orchestration. Re-exports `runPipelineStreaming`, `ScanOptions`, `BatchUpdate`, `ScoredTrack`, `PipelineResult` so existing callers don't change their imports.

**Step 1:** Read the full current `discovery-pipeline.ts` end-to-end. Identify the 3 natural regions (taste/genre build, candidate fan-out, batch emit). Annotate with comments marking seam boundaries. Do not refactor yet.

**Step 2:** Commit the annotation pass alone:
```bash
git commit -m "chore(v3): annotate pipeline seam boundaries (prep for split)"
```

**Step 3:** Extract each module one at a time. After each extraction:
- `cd web && npm run build` → zero errors
- Run `web/test-full-flow.mjs` → must still pass identically (same results, same timings within ±10%)
- Commit with message `refactor(v3): extract <module-name> (no behavior change)`

**Step 4:** Final state check. `web/src/lib/discovery-pipeline.ts` is ≤80 lines, contains only:
- Imports from the new `pipeline/*` modules
- Type re-exports for backward compatibility
- `runPipelineStreaming` — 10–15 lines of orchestration calling the new modules

**Step 5:** Baseline smoke test again — same 171-track ISA ROCK scan, same result count (±2), same top-10 results within 5% score variance. Save a new screenshot `web/test-screenshots/baseline-v2-refactored.png`.

**Acceptance:** later phases modify one seam each:
- Phase 1 blacklist → `source-spotify.ts` (and later, all sources)
- Phase 2 dedup → `merge-and-emit.ts`
- Phase 3 LLM source → new file `source-llm.ts` next to spotify
- Phase 4 clustering → `merge-and-emit.ts` scorer swap
- Phase 7 Last.fm → new file `source-lastfm.ts`

**Commit gate:** after each per-module commit, **stop and verify** `test-full-flow.mjs` before moving on. A broken refactor compounds if you extract three modules and only then re-test.

**Reader note for Phases 1–8:** subsequent phase file lists still say "Modify: `web/src/lib/discovery-pipeline.ts`" for historical reasons. After this refactor, interpret each such reference as "the appropriate module within `pipeline/`":
- Candidate-source changes (Phase 1 blacklist, Phase 3 LLM, Phase 7 Last.fm) → `pipeline/source-*.ts`
- Scoring / dedup / gate / emit changes (Phase 3.6 dedup wire-up, Phase 4 cluster scorer, Phase 5 deep-sampling aggregation) → `pipeline/merge-and-emit.ts`
- Orchestration-level changes (scanId minting, top-level ScanOptions fields) → `discovery-pipeline.ts` (the thin shell)

If you find yourself opening the 600-line version of `discovery-pipeline.ts` to edit inside Phase 3+, stop — Task 0.5 wasn't actually completed.

**Gate:** Do not start Phase 1 until all 5 pre-flight steps AND all 5 Task 0.x changes are green.

---

## Phase 1 — Per-Playlist Profile Storage + Blacklist Enforcement

**Goal:** Every playlist has a durable memory object. Rejected tracks never re-appear on subsequent scans.

**Files:**
- Create: `web/src/lib/profile.ts`
- Create: `web/__tests__/profile.test.ts` (vitest — installed in Phase 0 Task 0.1)
- Create: `web/test-profile-e2e.mjs` (Playwright)
- Modify: `web/src/lib/storage.ts` — add new `KEYS.PROFILES` key; do NOT touch existing keys
- Modify: `web/src/lib/discovery-pipeline.ts` — accept optional `blacklist` parameter, skip blacklisted tracks/artists BEFORE calling `searchArtists` / `getArtistTopTracks`
- Modify: `web/src/components/ResultsStep.tsx` — add ✗ Reject button next to existing ✓ Add button; persist rejection into profile
- Modify: `web/src/components/AnalysisStep.tsx` — load profile before kicking off pipeline, pass blacklist into `runPipelineStreaming`

### Task 1.1 — Define `PlaylistProfile` types + storage helpers

**Files:**
- Create: `web/src/lib/profile.ts`
- Modify: `web/src/lib/storage.ts:5-15` (add `PROFILES` to `KEYS`)

**Step 1: Write failing test** — `web/__tests__/profile.test.ts`:
```ts
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
    // The name is also stored so Phase 3 can pass it to Gemini:
    expect(loadProfile("pl1")!.blacklist.artistNames).toContain("Nickelback");
  });

  it("markAccepted appends and does not duplicate", () => {
    saveProfile(createEmptyProfile("pl1"));
    markAccepted("pl1", "t1");
    markAccepted("pl1", "t1");
    expect(loadProfile("pl1")!.accepted.trackIds).toEqual(["t1"]);
  });

  // Positive test replacing the old "throws on missing" negative [fix-H2]
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
    // Fill localStorage to ~5MB to trigger quota on next write
    const big = "x".repeat(1024 * 1024); // 1MB string
    try {
      for (let i = 0; i < 10; i++) localStorage.setItem(`_pad_${i}`, big);
    } catch { /* quota already hit — good */ }
    // Should not throw:
    expect(() => saveProfile(createEmptyProfile("pl1"))).not.toThrow();
  });
});
```

**Step 2:** Run test → expect FAIL (module not found).

**Step 3: Minimal implementation** — `web/src/lib/profile.ts`:
```ts
"use client";

import type { TasteVector } from "./taste-engine";
import type { Intent } from "./intent-types"; // fix-C3: single source of truth

export interface BlacklistEntry {
  trackIds: string[];
  artistIds: string[];
  /** fix-C4: Gemini recommends by NAME, not Spotify ID — we must pass names as excludeArtists */
  artistNames: string[];
  genres: string[];
  rejectionsByArtist: Record<string, number>;
}
export interface PlaylistProfile {
  playlistId: string;
  intent: Intent | null;
  intentText: string;
  blacklist: BlacklistEntry;
  accepted: { trackIds: string[]; refinedTasteVector: TasteVector | null };
  stats: { runsCount: number; acceptedCount: number; rejectedCount: number; lastRunAt: string | null };
  schemaVersion: 1;
}

const KEY_PREFIX = "soundfox_profile_";
const AUTO_BLACKLIST_ARTIST_THRESHOLD = 2;
const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyProfile(playlistId: string): PlaylistProfile {
  return {
    playlistId, intent: null, intentText: "",
    blacklist: { trackIds: [], artistIds: [], artistNames: [], genres: [], rejectionsByArtist: {} },
    accepted: { trackIds: [], refinedTasteVector: null },
    stats: { runsCount: 0, acceptedCount: 0, rejectedCount: 0, lastRunAt: null },
    schemaVersion: 1,
  };
}

/** fix-M7: future schema bumps add transforms here. Today it only validates. */
export function migrateProfile(raw: unknown): PlaylistProfile | null {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PlaylistProfile>;
  if (r.schemaVersion !== CURRENT_SCHEMA_VERSION) return null;
  if (typeof r.playlistId !== "string") return null;
  // Future: if (r.schemaVersion === 0) { ...transform to 1... }
  return r as PlaylistProfile;
}

export function loadProfile(playlistId: string): PlaylistProfile | null {
  const raw = localStorage.getItem(KEY_PREFIX + playlistId);
  if (!raw) return null;
  return migrateProfile(raw);
}

export function saveProfile(profile: PlaylistProfile): void {
  try { localStorage.setItem(KEY_PREFIX + profile.playlistId, JSON.stringify(profile)); }
  catch { /* fix-H3: quota — silently skip. UI layer handles visible feedback via try/catch wrapping. */ }
}

/** fix-H2: auto-creates a profile if one doesn't exist. Never throws. */
export function blacklistTrack(
  playlistId: string,
  trackId: string,
  opts?: { artistId?: string; artistName?: string; genres?: string[] },
): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  if (!profile.blacklist.trackIds.includes(trackId)) profile.blacklist.trackIds.push(trackId);
  if (opts?.artistId) {
    const count = (profile.blacklist.rejectionsByArtist[opts.artistId] ?? 0) + 1;
    profile.blacklist.rejectionsByArtist[opts.artistId] = count;
    if (count >= AUTO_BLACKLIST_ARTIST_THRESHOLD && !profile.blacklist.artistIds.includes(opts.artistId)) {
      profile.blacklist.artistIds.push(opts.artistId);
      // fix-C4: store the name alongside the ID
      if (opts.artistName && !profile.blacklist.artistNames.includes(opts.artistName)) {
        profile.blacklist.artistNames.push(opts.artistName);
      }
    }
  }
  profile.stats.rejectedCount += 1;
  saveProfile(profile);
}

export function blacklistArtist(playlistId: string, artistId: string, artistName?: string): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  if (!profile.blacklist.artistIds.includes(artistId)) profile.blacklist.artistIds.push(artistId);
  if (artistName && !profile.blacklist.artistNames.includes(artistName)) {
    profile.blacklist.artistNames.push(artistName);
  }
  saveProfile(profile);
}

export function markAccepted(playlistId: string, trackId: string): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  if (!profile.accepted.trackIds.includes(trackId)) {
    profile.accepted.trackIds.push(trackId);
    profile.stats.acceptedCount += 1;
    saveProfile(profile);
  }
}

export function isTrackBlacklisted(playlistId: string, trackId: string): boolean {
  return !!loadProfile(playlistId)?.blacklist.trackIds.includes(trackId);
}

export function isArtistBlacklisted(playlistId: string, artistId: string): boolean {
  return !!loadProfile(playlistId)?.blacklist.artistIds.includes(artistId);
}
```

**Step 4:** Run test → PASS (all 6 cases including negative).

**Step 5: Commit**
```bash
git add web/src/lib/profile.ts web/__tests__/profile.test.ts
git commit -m "feat(v3): PlaylistProfile storage + blacklist auto-escalation"
```

### Task 1.2 — Wire blacklist into `discovery-pipeline.ts`

**Files:**
- Modify: `web/src/lib/discovery-pipeline.ts` — `runPipelineStreaming` signature

**Step 1: Test (add to `web/__tests__/pipeline-blacklist.test.ts`)**
```ts
// Mock spotify-client to return a known candidate set.
// Given blacklist { artistIds: ["a1"] }, assert the pipeline never yields a track with artist.id === "a1".
// NEGATIVE TEST: call pipeline WITHOUT blacklist argument — assert track "a1" DOES appear
// (proves the filter is load-bearing, not a no-op).
```

**Step 2:** Run → FAIL.

**Step 3:** Add `blacklist?: BlacklistEntry` to `ScanOptions` (defined in `discovery-pipeline.ts`). In the candidate-collection loop, skip any `artist.id` in `blacklist.artistIds` and any `track.id` in `blacklist.trackIds` **before** the genre gate and **before** the scoring call. Log each skip to `/api/log` with `{ event: "blacklist_skip", reason: "artist"|"track", id }` so we can audit.

**Step 4:** Run → PASS both cases.

**Step 5: Commit.**

### Task 1.3 — Reject button in `ResultsStep.tsx`

**Files:**
- Modify: `web/src/components/ResultsStep.tsx`
- Modify: `web/src/components/TrackRow.tsx` (extract reject button here if the row is already its own component; otherwise inline)

**Step 1: Playwright test `web/test-reject-button.mjs`:**
- Inject mocked auth + one fake playlist + one fake result.
- Click ✗ Reject on a row.
- Assert the row disappears from the list immediately.
- Reload the page; assert the row still does not appear (persistence proof).
- **Keyboard path [fix-M8]:** repeat with Tab-to-focus + Enter-to-activate the ✗ button. Assert same outcome.
- **NEGATIVE TEST [fix-H3]:** pre-fill `localStorage` with ~5 MB of padding (see helper below) so the next `setItem` throws `QuotaExceededError`. Click ✗. Assert the UI shows a toast like "Could not save rejection — storage full" — NOT a silent failure.
- Screenshot: `web/test-screenshots/phase1-reject.png` (mouse path) + `phase1-reject-keyboard.png`.

**Quota-fill helper** (add to the test file):
```js
// Inject before interacting with the UI
await page.addInitScript(() => {
  const big = "x".repeat(512 * 1024); // 512KB chunks
  for (let i = 0; i < 10; i++) {
    try { localStorage.setItem(`_pad_${i}`, big); } catch { break; }
  }
});
```

**Step 2:** Run → FAIL.

**Step 3:** Implement. Use the existing `TrackRow` component; add a small red ✗ button next to the ✓ Add button. On click (**or keypress Enter while focused — fix-M8**):
```ts
try {
  blacklistTrack(playlistId, track.id, {
    artistId: artist.id,
    artistName: artist.name, // fix-C4: store name for Gemini excludeArtists later
    genres: artist.genres,
  });
  // optimistic remove from local results state
} catch (err) {
  // saveProfile swallows quota silently — check via loadProfile round-trip
  // If the write actually failed, show toast:
  if (!isTrackBlacklisted(playlistId, track.id)) {
    showToast("Could not save rejection — storage full. Clear old data and try again.");
  }
}
```

The button must be a real `<button>` element (native keyboard support) with `aria-label="Reject track"`, not a clickable `<div>`.

**Step 4:** Run → PASS.

**Step 5:** Visual check the screenshot against `baseline-v2.png`. Describe the diff ("new red ✗ button in results rows"). Commit.

### Task 1.4 — AnalysisStep loads profile and passes blacklist into pipeline

**Files:**
- Modify: `web/src/components/AnalysisStep.tsx`

**Step 1: Playwright test `web/test-blacklist-across-runs.mjs`:**
- Run 1: complete a scan, click ✗ on a specific track (note its `track.id`).
- Run 2: start a new scan on the same playlist. Assert the rejected `track.id` does not appear anywhere in results.
- NEGATIVE TEST: run 2 on a **different** playlist. Assert the blacklist from the first playlist does NOT cross over (profiles are per-playlist).

**Step 2:** Run → FAIL.

**Step 3:** In `AnalysisStep`, before calling `runPipelineStreaming`, call `loadProfile(sourcePlaylistId)` and feed `profile.blacklist` into the scan options. If no profile exists, call `createEmptyProfile` and save it.

**Step 4:** Run → PASS both cases.

**Step 5:** Commit.

### Phase 1 Acceptance Criteria (user-visible)

- [ ] Each playlist has a durable profile in `localStorage` (inspect via DevTools → Application → Local Storage → key starts with `soundfox_profile_`).
- [ ] ✗ Reject button visible on every result row, next to ✓ Add.
- [ ] Clicking ✗ makes the track disappear from results and it does not come back on re-scan.
- [ ] Rejecting 2 tracks by the same artist blacklists the whole artist (check `blacklist.artistIds` in storage).
- [ ] Blacklist from playlist A does not leak into playlist B.
- [ ] `web/soundfox-debug.log` contains `blacklist_skip` events for rejected artists on re-scan.

**Reality check (Rule 16):**
1. Did you run both Playwright tests and see them pass? VERIFIED / ASSUMED / UNKNOWN
2. Is the ✗ button reachable by keyboard (tab + enter)? If not, note as UNKNOWN and file follow-up.
3. What happens when `localStorage` is full? (Quota test — `saveProfile` silently skips. Is that OK? Document.)
4. Does `AnalysisStep` still work for a user who has the existing v2 localStorage state and no new profile? (Migration: first run creates empty profile.)
5. Is the auto-artist-blacklist threshold (2) documented for the user in the UI? If not — UNKNOWN gap.

---

## Phase 2 — Strong Dedup (pure functions only)

**Goal:** The user never sees the same song twice — whether it's single vs album, original vs remaster, or a re-upload under a different artist alias.

**Split note [review-2]:** Phase 2 only delivers the **pure dedup functions** (Tasks 2.1 + 2.2). The pipeline wiring that was originally Task 2.3 has moved to **Phase 3 Task 3.6 — Wire dedup into merged stream** (after Phase 3 introduces `mergeAsyncGenerators`). Doing the wiring in Phase 2 would mean integrating into the v2 single-source pipeline, then rewriting the integration in Phase 3 when the pipeline becomes multi-source. We write the integration once, in its final home.

**Files (Phase 2 only):**
- Create: `web/src/lib/dedup.ts`
- Create: `web/__tests__/dedup.test.ts`
- **No `discovery-pipeline.ts` changes in this phase.**

### Task 2.1 — Normalization + three-layer dedup key

**Step 1: Write failing test — `web/__tests__/dedup.test.ts`:**
```ts
import { describe, it, expect } from "vitest";
import { normalizeTrackName, buildDedupKey, dedupCandidates } from "../src/lib/dedup";

describe("dedup", () => {
  it("strips remaster/version/feat from track name", () => {
    expect(normalizeTrackName("Hey Jude - Remastered 2015")).toBe("hey jude");
    expect(normalizeTrackName("Let It Be (feat. Paul McCartney)")).toBe("let it be");
    expect(normalizeTrackName("Something (2019 Remix)")).toBe("something");
    expect(normalizeTrackName("Song - Live at Wembley")).toBe("song");
  });

  it("dedups by Spotify ID (layer 1)", () => {
    const out = dedupCandidates([c("id1","A","Song"), c("id1","A","Song")]);
    expect(out).toHaveLength(1);
  });

  it("dedups by normalized name + first artist (layer 2)", () => {
    const out = dedupCandidates([
      c("id1","Foo Fighters","The Pretender"),
      c("id2","Foo Fighters","The Pretender - Remastered"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps the more popular variant", () => {
    const out = dedupCandidates([
      c("id1","A","Song", 20), c("id2","A","Song - Live", 80),
    ]);
    expect(out[0].track.popularity).toBe(80);
  });

  it("audio fingerprint fallback (layer 3) — same duration/tempo/energy within ε", () => {
    // two tracks with slightly different IDs AND different name spellings
    // but duration±2s, tempo±2bpm, energy±0.03 → should dedup
    // NEGATIVE TEST included below.
  });

  // NEGATIVE TEST (Rule 11)
  it("does NOT dedup tracks that only share a generic word like 'intro'", () => {
    const out = dedupCandidates([c("id1","A","Intro"), c("id2","B","Intro")]);
    expect(out).toHaveLength(2);
  });

  it("does NOT dedup covers by different primary artists", () => {
    const out = dedupCandidates([c("id1","Johnny Cash","Hurt"), c("id2","Nine Inch Nails","Hurt")]);
    expect(out).toHaveLength(2);
  });
});
```

**Step 2:** FAIL.

**Step 3: Implement `dedup.ts`:**
```ts
const NOISE_PATTERNS = [
  /\s*-\s*remaster(ed)?(\s*\d{4})?$/i,
  /\s*-\s*\d{4}\s*remaster(ed)?$/i,
  /\s*\(remaster(ed)?(\s*\d{4})?\)/i,
  /\s*\(live(\s+at[^)]*)?\)/i,
  /\s*-\s*live(\s+at.*)?$/i,
  /\s*\(\d{4}\s*remix\)/i,
  /\s*\(feat\.?[^)]*\)/i,
  /\s*\(version[^)]*\)/i,
  /\s*\(deluxe.*\)/i,
  /\s*\(radio edit\)/i,
];

export function normalizeTrackName(name: string): string {
  let out = name;
  for (const rx of NOISE_PATTERNS) out = out.replace(rx, "");
  return out.trim().toLowerCase();
}

export function buildDedupKey(candidate: Candidate): string {
  return `${normalizeTrackName(candidate.track.name)}|${candidate.artist.name.toLowerCase()}`;
}

export function dedupCandidates(cands: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  const byKey = new Map<string, Candidate>();
  for (const c of cands) {
    if (byId.has(c.track.id)) continue;
    const k = buildDedupKey(c);
    const existing = byKey.get(k);
    if (existing) {
      // keep the more popular
      if ((c.track.popularity ?? 0) > (existing.track.popularity ?? 0)) {
        byKey.set(k, c); byId.delete(existing.track.id); byId.set(c.track.id, c);
      }
      continue;
    }
    byId.set(c.track.id, c); byKey.set(k, c);
  }
  // Layer 3 audio fingerprint is implemented as a second pass after scoring
  // (we only have audio features post-scoring). See Task 2.2.
  return Array.from(byId.values());
}
```

**Step 4:** PASS.

**Step 5: Commit.**

### Task 2.2 — Audio fingerprint fallback (post-scoring)

**Files:**
- Modify: `web/src/lib/dedup.ts` — add `dedupByFingerprint(scored: ScoredCandidate[]): ScoredCandidate[]`

**Step 1:** Test — two scored candidates with duration within 2s, tempo within 2 bpm, energy within 0.03 → dedup. NEGATIVE: two candidates with duration 180s vs 240s → kept separately.

**Step 2:** FAIL.

**Step 3:** Implement — bucket key = `Math.round(duration/5)`; within bucket compare `|dTempo| < 2 && |dEnergy| < 0.03 && |dDuration_ms| < 2000`. Keep the higher-popularity candidate.

**Step 4:** PASS.

**Step 5:** Commit.

### Phase 2 Acceptance Criteria (unit-level only)

- [ ] `normalizeTrackName`, `buildDedupKey`, `dedupCandidates`, `dedupByFingerprint` exist and pass all unit tests including negative cases.
- [ ] No pipeline changes yet — `test-full-flow.mjs` produces the same output as after Phase 0.

**End-to-end dedup behavior** (no-dup results, merged sources, `dedup_collapse` events) is validated at the end of **Phase 3 Task 3.6** (see below), when dedup is wired into the merged stream.

---

## Phase 3 — Intent UI + Gemini Integration into Pipeline

**Goal:** User types `"רוצה שירים לאימון בוקר, BPM גבוה, חדש לי"`. System parses via Gemini, shows the structured Intent for user edit, remembers it per-playlist, and feeds constraints + LLM recommendations into the scoring pipeline.

**Files:**
- Create: `web/src/components/IntentStep.tsx`
- Create: `web/src/components/IntentEditor.tsx`
- Modify: `web/src/app/wizard/page.tsx` — insert IntentStep between PlaylistStep and ScanOptionsStep (or merge into ScanOptions if the user explicitly requests — this is open question 3.1)
- Modify: `web/src/lib/discovery-pipeline.ts` — accept `intent` in `ScanOptions`, fan out to LLM source
- Modify: `web/src/lib/llm-source.ts` — already exists; add `buildLLMCandidates(intent, tasteVector, topArtists, blacklist)` that returns `Candidate[]` with `sourceTags: ["llm"]`

### Task 3.0 — Harden `parseIntent` with retry + safe default [fix-H9]

**Why:** Gemini occasionally returns malformed JSON or times out. A single failure shouldn't dump the user back to a blank free-text box. Two attempts (second at temperature=0 for determinism) then fall back to `defaultIntent()` with `intentParseFailed: true`.

**Files:**
- Modify: `web/src/lib/gemini-server.ts` — `parseIntent` gets retry
- Modify: `web/src/app/api/intent/route.ts` — return 200 with safe default instead of 500 when parse fails

**Step 1: Unit test** `web/__tests__/parse-intent-retry.test.ts`:
```ts
// Mock GoogleGenerativeAI so first call returns malformed JSON, second returns valid JSON.
// Assert parseIntent returns the valid Intent (second attempt succeeded).
// NEGATIVE: both calls return garbage → parseIntent returns defaultIntent() with intentParseFailed: true.
// NEGATIVE: first call throws network error → second call retries → eventually returns default if both fail.
```

**Step 2:** Run → FAIL.

**Step 3:** Implement in `gemini-server.ts`:
```ts
import { defaultIntent } from "./intent-types";

export async function parseIntent(freeText: string, playlistContext: {...}): Promise<Intent> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = getClient();
      const model = client.getGenerativeModel({
        model: MODEL,
        generationConfig: attempt === 1 ? { temperature: 0 } : undefined, // 2nd attempt deterministic
      });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
      return JSON.parse(json) as Intent;
    } catch (e) {
      if (attempt === 1) break;
    }
  }
  return defaultIntent();
}
```

**Step 4:** Update `web/src/app/api/intent/route.ts` — it no longer throws on parse failure (parseIntent never throws now). Keep the try/catch only for truly unexpected errors (e.g., missing API key). Always return 200 with the intent (default or parsed).

**Step 5:** Run → PASS all 3 cases. Commit.

**Files:** Create `web/src/components/IntentStep.tsx`.

**Step 1: Playwright test `web/test-intent-step.mjs`:**
- Mock `/api/intent` to return a known Intent object (so we don't hit Gemini in tests).
- Render step with `playlistContext`. Type `"workout music, high energy, 120+ BPM"`.
- Click "Parse".
- Assert the parsed Intent is displayed (purpose: "workout", tempoMin: 120).
- **NEGATIVE TEST [fix-H9]:** mock `/api/intent` to return the **safe default** payload `{ intent: { ...defaultIntent(), intentParseFailed: true } }` (as the route will do after its 2-attempt retry exhausts). Assert the UI shows:
  - A yellow banner: *"Couldn't fully understand — here's a safe default. Edit it below."*
  - The IntentEditor pre-filled with the default values.
  - The "Continue" button is NOT blocked (user can proceed with the safe default or edit it).
- Screenshot: `web/test-screenshots/phase3-intent-parsed.png` + `phase3-intent-default.png`.

**Step 2:** FAIL.

**Step 3:** Component outline:
```tsx
"use client";
import { useState } from "react";
import type { ReactElement } from "react";
import { parseIntentViaLLM, type Intent } from "@/lib/llm-source";
import { loadProfile, saveProfile } from "@/lib/profile";

interface Props {
  playlistId: string;
  playlistContext: { name: string; topArtists: string[]; topGenres: string[]; trackCount: number };
  onContinue: (intent: Intent | null, intentText: string) => void;
}

export default function IntentStep(props: Props): ReactElement {
  const [freeText, setFreeText] = useState("");
  const [parsed, setParsed] = useState<Intent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // load previous intent for this playlist (in useEffect, not at top — hydration)
  // ... (omitted for brevity in plan; implement with useEffect guard)

  const handleParse = async () => { /* call parseIntentViaLLM */ };
  return ( /* textarea + Parse button + IntentEditor when parsed + Continue button */ );
}
```

**Step 4:** PASS both cases.

**Step 5:** Commit.

### Task 3.2 — IntentEditor component

**Files:** Create `web/src/components/IntentEditor.tsx`.

Form-based editor (NOT raw JSON — open question 3.6 answered: "form with chips for genres, sliders for audio constraints, free text for requirements"). Fields:
- Purpose (text input)
- Tempo (dual-range slider 60–200)
- Energy / Valence (dual-range sliders 0–1)
- Popularity hint (radio: low/mid/high/any)
- Genres: include (chip input), exclude (chip input)
- Era (text input or null)
- Requirements (textarea, one per line)
- Allow known artists (checkbox)
- Quality tier (select: premium/balanced/inclusive → maps to threshold)

Playwright test: tweak each field, click "Apply", assert `onChange(intent)` fires with updated values. **NEGATIVE:** setting `tempoMin > tempoMax` shows a validation error and blocks Apply.

### Task 3.3 — Wizard routing (first-time vs returning)

**Files:** Modify `web/src/app/wizard/page.tsx`.

Logic:
- After PlaylistStep selects a playlist, call `loadProfile(playlistId)`.
- If `profile?.intent` exists → skip to a "Run with last intent | Change intent" choice page (reuse IntentStep with `parsed` pre-filled).
- If no profile or no intent → IntentStep (free text).

**Playwright test `web/test-intent-returning-user.mjs`:**
- Seed `localStorage` with a profile that has an intent.
- Pick the playlist.
- Assert the UI shows "Run again" + "Change intent" — not the free text box.

### Task 3.4 — Pipeline fan-out to LLM source (streaming merge) [fix-C5]

**Files:**
- Modify: `web/src/lib/discovery-pipeline.ts`
- Modify: `web/src/lib/llm-source.ts` — add `buildLLMCandidates` helper
- Create: `web/src/lib/merge-generators.ts` — streaming-safe merge helper

**DO NOT use `Promise.allSettled`.** That collapses the three sources into a single barrier — nothing emits until all resolve — which kills the v2 streaming UX and wastes 30+ seconds of user time. Use a merged async generator that yields a candidate the moment **any** source produces one.

**Step 1: Create the merge helper** — `web/src/lib/merge-generators.ts`:
```ts
/**
 * Merge N async generators into one. Yields values as soon as any source produces one.
 * Individual source failures are logged and skipped — they do not kill sibling sources.
 */
export async function* mergeAsyncGenerators<T>(
  sources: Array<AsyncGenerator<T> | AsyncIterable<T>>,
  onSourceError?: (i: number, err: unknown) => void,
): AsyncGenerator<T> {
  const iters = sources.map((s) => (Symbol.asyncIterator in s ? s[Symbol.asyncIterator]() : s) as AsyncIterator<T>);
  const pending: Array<Promise<{ i: number; res: IteratorResult<T> } | { i: number; err: unknown }> | null> =
    iters.map((it, i) =>
      it.next().then(res => ({ i, res })).catch(err => ({ i, err })),
    );

  while (pending.some(p => p !== null)) {
    const active = pending.filter((p): p is Promise<{ i: number; res: IteratorResult<T> } | { i: number; err: unknown }> => p !== null);
    const winner = await Promise.race(active);
    const i = winner.i;
    if ("err" in winner) {
      onSourceError?.(i, winner.err);
      pending[i] = null;
      continue;
    }
    if (winner.res.done) {
      pending[i] = null;
      continue;
    }
    yield winner.res.value;
    pending[i] = iters[i].next().then(res => ({ i, res })).catch(err => ({ i, err }));
  }
}
```

**Step 2:** Unit test `web/__tests__/merge-generators.test.ts`:
```ts
// Three sources: fast (yields every 10ms), medium (50ms), slow (200ms).
// Assert values arrive in time-of-production order, not source-order.
// NEGATIVE: source 2 throws mid-stream. Assert sources 1+3 keep yielding.
```

**Step 3: `buildLLMCandidates` (async generator, not a Promise) — parallel resolve with cap, session cache [review-3 SHIP-BLOCKER]** — in `llm-source.ts`:

**Why parallel:** serial resolve makes the LLM source take ~16 seconds for 40 recs at 400ms per Spotify lookup. That means a 15-second gap in the merged stream with nothing new appearing — users will call v3 "broken" before minute 2. Bounded parallelism (cap=5) brings first-result latency down to ~2s after Gemini returns.

**Why session cache:** Gemini typically returns 40 recs covering 20–30 unique artists. Caching `searchArtists` + `getArtistTopTracks` per artist name within one scan cuts Spotify calls roughly in half.

```ts
// Session-scoped caches live for the duration of a single buildLLMCandidates run
type ArtistSearchCache = Map<string, SpotifyArtist | null>;
type TopTracksCache = Map<string, SpotifyTrack[]>;

async function resolveOne(
  rec: LLMRecommendation,
  artistCache: ArtistSearchCache,
  topTracksCache: TopTracksCache,
): Promise<ResolvedLLMTrack | null> {
  const key = rec.artist.toLowerCase();
  let artist = artistCache.get(key);
  if (artist === undefined) {
    const results = await searchArtists(rec.artist, 0);
    artist = results.find(a => a.name.toLowerCase() === key) ?? results[0] ?? null;
    artistCache.set(key, artist);
  }
  if (!artist) return null;

  let tops = topTracksCache.get(artist.id);
  if (!tops) {
    tops = await getArtistTopTracks(artist.id);
    topTracksCache.set(artist.id, tops);
  }
  const track = tops.find(t =>
    t.name.toLowerCase().includes(rec.track.toLowerCase()) ||
    rec.track.toLowerCase().includes(t.name.toLowerCase()),
  );
  if (!track) return null;
  return { track, artist, why: rec.why, confidence: rec.confidence };
}

/**
 * Bounded-parallelism helper — at most `limit` in-flight, yields results as they resolve.
 * Cap of 5 is a compromise between user-perceived latency and Spotify's 200ms-throttle.
 */
async function* resolveInParallel(
  recs: LLMRecommendation[],
  limit: number,
  artistCache: ArtistSearchCache,
  topTracksCache: TopTracksCache,
): AsyncGenerator<ResolvedLLMTrack> {
  const inflight = new Map<number, Promise<{ idx: number; resolved: ResolvedLLMTrack | null }>>();
  let next = 0;
  function launch(idx: number): void {
    const p = resolveOne(recs[idx], artistCache, topTracksCache)
      .then(resolved => ({ idx, resolved }))
      .catch(() => ({ idx, resolved: null as ResolvedLLMTrack | null }));
    inflight.set(idx, p);
  }
  while (next < limit && next < recs.length) launch(next++);
  while (inflight.size > 0) {
    const winner = await Promise.race(inflight.values());
    inflight.delete(winner.idx);
    if (winner.resolved) yield winner.resolved;
    if (next < recs.length) launch(next++);
  }
}

export async function* buildLLMCandidates(args: {
  intent: Intent;
  tasteVector: Partial<AudioFeatures>;
  topArtistNames: string[];          // fix-C4: Gemini needs NAMES, not IDs
  sampleTracks: Array<{ name: string; artist: string }>;
  blacklistArtistNames: string[];    // fix-C4: pass blacklisted artist NAMES
  playlistId: string;                // for isTrackBlacklisted / isArtistBlacklisted checks after resolve
  scanId: string;                    // fix-H6: correlation ID
}): AsyncGenerator<Candidate> {
  const requested = 40;
  const recs = await getLLMRecommendations({
    intent: args.intent,
    tasteVector: args.tasteVector,
    topArtists: args.topArtistNames,
    sampleTracks: args.sampleTracks,
    excludeArtists: [...args.topArtistNames, ...args.blacklistArtistNames], // fix-C4
    count: requested,
  });
  debugLog({ event: "llm_candidates", scanId: args.scanId, requested, returned: recs.length });

  const artistCache: ArtistSearchCache = new Map();
  const topTracksCache: TopTracksCache = new Map();
  let resolvedCount = 0;

  for await (const resolved of resolveInParallel(recs, 5, artistCache, topTracksCache)) {
    resolvedCount += 1;
    if (isTrackBlacklisted(args.playlistId, resolved.track.id)) continue;
    if (isArtistBlacklisted(args.playlistId, resolved.artist.id)) continue;
    yield {
      track: resolved.track,
      artist: resolved.artist,
      sourceTags: ["llm"],
      matchedGenres: [],
      llmWhy: resolved.why,
    };
  }
  // fix: review-10 — log the resolve ratio so we can watch for Gemini hallucination drift
  debugLog({
    event: "llm_resolved",
    scanId: args.scanId,
    requested,
    resolved: resolvedCount,
    ratio: requested > 0 ? resolvedCount / requested : 0,
  });
}
```

**Step 4: Pipeline changes** in `discovery-pipeline.ts`:
- After building the source taste + genre profile, construct the three source generators:
  ```ts
  const sources = [
    buildSpotifyCandidates({ ..., scanId, blacklist: profile.blacklist }),
    buildLLMCandidates({ ..., topArtistNames, blacklistArtistNames: profile.blacklist.artistNames, playlistId }),
    // Phase 7 adds: buildLastfmCandidates(...)
  ];
  const merged = mergeAsyncGenerators(sources, (i, err) => debugLog({ event: "source_error", scanId, sourceIndex: i, err: String(err) }));
  ```
- Consume `merged` through the persistent-dedup state (Task 3.6 [fix-M5]) → genre gate → scoring → emit in batches of 50 as before.
- Blacklist is already embedded in each source generator; no additional post-filter needed, but keep the final `isTrackBlacklisted` check as defense-in-depth.

**Step 5: Negative test (Rule 11):** mock `/api/llm-recommend` to return 500 → pipeline still completes using Spotify-only candidates. Assert `sourceTags: ["spotify"]` on all rows. **AND** `/api/log` contains a `source_error` event with `sourceIndex: 1`.

### Task 3.5 — Per-playlist persistence of intent (strip transport flag) [review-6]

**Files:** Modify `web/src/lib/profile.ts` — add `setIntent(playlistId, intent, intentText)` helper.

```ts
export function setIntent(playlistId: string, intent: Intent, intentText: string): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  // review-6: intentParseFailed is transport-only metadata — it describes the HTTP response,
  // not the intent's persisted content. Strip before storing, otherwise it lives in
  // localStorage forever and confuses future "returning user" logic.
  const { intentParseFailed, ...cleanIntent } = intent;
  profile.intent = cleanIntent as Intent;
  profile.intentText = intentText;
  saveProfile(profile);
}
```

On IntentEditor "Apply": `setIntent(playlistId, intent, freeText)`. Write Playwright test that verifies:
1. The intent round-trips across page reload.
2. An intent with `intentParseFailed: true` is saved **without** the flag — `loadProfile(id)!.intent!.intentParseFailed` is `undefined`.

### Task 3.6 — Wire dedup into the merged stream [review-2] [fix-M5]

**Why:** Dedup functions exist from Phase 2 but haven't been wired yet. Now that Phase 3 introduces the merged stream, wire them into the single correct integration point — `pipeline/merge-and-emit.ts` — rather than retrofitting.

**Files:**
- Modify: `web/src/lib/pipeline/merge-and-emit.ts`

With streaming fan-out, dedup cannot be "run after all candidates collected" — candidates arrive incrementally from multiple merged async generators. Use **persistent state** carried across the whole scan:

```ts
// Inside the emit loop:
const emittedKeys = new Set<string>();        // normalized name|artist keys already yielded
const emittedIds = new Set<string>();         // Spotify track IDs already yielded
const emittedFingerprints = new Set<string>(); // bucketed audio fingerprints

// For each incoming Candidate yielded by the merged stream:
for await (const c of merged) {
  if (emittedIds.has(c.track.id)) continue;
  const k = buildDedupKey(c);
  if (emittedKeys.has(k)) continue;
  // fresh → genre gate → scoring → fingerprint check against emittedFingerprints
  // When emitting, add id, key, and fingerprint to the respective Sets.
}
```

Call `dedupCandidates` per batch as a first pass to handle intra-batch dups (same source returns the same track twice on one page). Call `dedupByFingerprint` after scoring per batch, checking against `emittedFingerprints` plus intra-batch duplicates.

**Merged source-tag handling:** when a new Candidate matches an existing emitted key, don't drop it silently — merge its `sourceTags` into the already-emitted row's tags and log a `dedup_collapse` event with both tags. This way the WhyPanel (Phase 6) can show "Spotify + LLM both found this."

**Playwright test** `web/test-dedup.mjs`:
- Mock two search results that are the same song under different IDs. Assert only one row appears in the UI.
- **NEGATIVE [Rule 11]:** mock the LLM source and Spotify source to both return the same track. Assert it appears exactly once AND the row's Why panel shows `sourceTags: ["spotify", "llm"]` (both tags preserved — see Glossary `sourceTags`).

### Phase 3 Acceptance Criteria

- [ ] First-time playlist: user sees free-text box → types in Hebrew or English → Gemini returns structured Intent → user can edit → click Continue.
- [ ] Returning playlist: user sees their last intent with Run/Edit options — no free-text re-prompt.
- [ ] Pipeline receives both Spotify and LLM candidates. Results contain tracks from both sources (check `sourceTags` via "Why this" panel in Phase 6).
- [ ] Audio constraints from Intent filter out tracks outside the tempo/energy/valence range.
- [ ] Exclude-genres list prevents tracks in those genres from appearing.
- [ ] If Gemini is down, scan still completes from Spotify catalog.
- [ ] `/api/log` shows `intent_parsed`, `llm_candidates`, `llm_resolved` events.
- [ ] **First LLM-sourced result appears in the UI within 10 seconds of scan start [review-3].** Measured via Playwright `waitForSelector` on a row with `data-source="llm"`; assert the elapsed time ≤10,000ms.
- [ ] **LLM resolve ratio ≥ 0.7 [review-10].** Over 3 smoke-test scans, the average `llm_resolved.ratio` (resolved/requested) is ≥ 0.7. If it drops below 0.5, tighten the Gemini prompt or gate the LLM source off for that scan.

**Visual verification (Rule 2):** screenshot the wizard for first-time vs returning user. Attach both.

---

## Phase 4 — Multi-Cluster Taste Vector

**Goal:** A 171-track rock playlist with mellow acoustic + heavy metal subsets no longer averages into "mid-energy" goo. Each cluster is scored independently; a candidate's score = similarity to its *nearest* cluster.

**Files:**
- Create: `web/src/lib/clustering.ts`
- Create: `web/__tests__/clustering.test.ts`
- Modify: `web/src/lib/taste-engine.ts` — add `scoreCandidateClustered(candidate, clusters, weights)`
- Modify: `web/src/lib/discovery-pipeline.ts` — build `TasteClusters` once per scan, pass to scorer

### Task 4.1 — k-means implementation

**Files:** `web/src/lib/clustering.ts`.

**Step 1: Tests — `web/__tests__/clustering.test.ts`:**
- Given 100 points clearly split into 2 gaussians → k=2 → 2 clusters separated cleanly.
- Elbow method: run k=1..6, pick the k where WSS drop plateaus. Given a 3-cluster dataset, elbow returns k=3 (±1).
- Seed fixed → results deterministic across runs.
- NEGATIVE: empty input → throws `Error: cannot cluster empty set`.
- NEGATIVE: k > n → throws `Error: k > n`.

**Step 2:** FAIL.

**Step 3:** Implement:
```ts
// fix-M4: label is assigned at build time, not retrofitted in Phase 6
export interface Cluster { id: number; centroid: Record<string, number>; memberCount: number; label: string; }
export interface TasteClusters { clusters: Cluster[]; k: number; assignments: Map<string, number>; }

const FEATURES = ["danceability","energy","valence","tempo","acousticness","instrumentalness","liveness","speechiness","loudness"] as const;

function distance(a, b): number { /* normalized Euclidean over FEATURES */ }
function kMeans(points: Array<{ id: string; features: AudioFeatures }>, k: number, seed = 42): TasteClusters { /* Lloyd's, max 50 iter, kmeans++ init */ }
export function buildTasteClusters(featuresByTrack: Map<string, AudioFeatures>, opts?: { k?: number; autoK?: boolean }): TasteClusters {
  const n = featuresByTrack.size;
  if (n === 0) throw new Error("cannot cluster empty set");
  const k = opts?.k ?? (opts?.autoK ? elbowK(featuresByTrack) : Math.min(3, n));
  if (k > n) throw new Error("k > n");
  return kMeans(Array.from(featuresByTrack, ([id, f]) => ({ id, features: f })), k);
}
function elbowK(featuresByTrack): number { /* try k=1..min(6,n); pick where WSS drop flattens */ }
```

**Step 4:** PASS including negatives.

**Step 5:** Commit.

### Task 4.2 — Cluster-aware scoring

**Files:** Modify `web/src/lib/taste-engine.ts`.

Add:
```ts
export function scoreCandidateClustered(
  features: AudioFeatures,
  clusters: TasteClusters,
  options?: { clusterWeight?: number; rangeWeight?: number },
): { score: number; clusterId: number; distance: number } {
  let bestId = -1; let bestDist = Infinity;
  for (const c of clusters.clusters) {
    const d = distance(features, c.centroid);
    if (d < bestDist) { bestDist = d; bestId = c.id; }
  }
  // convert distance (lower = better) to similarity in 0..1
  const sim = 1 / (1 + bestDist);
  return { score: sim, clusterId: bestId, distance: bestDist };
}
```
Unit tests: candidate close to heavy cluster gets score > 0.7; candidate between clusters gets lower score than candidate inside a cluster.

**Negative test (Rule 11):** call `scoreCandidateClustered` with a feature set that is missing `energy` and `tempo` — assert it does not NaN (the scorer handles missing features by dropping them from distance calc).

### Task 4.3 — Wire into pipeline

**Files:** Modify `web/src/lib/discovery-pipeline.ts`.

- After building `featuresByTrack` for the source playlist, call `buildTasteClusters(featuresByTrack, { autoK: true })`.
- For every candidate, use `scoreCandidateClustered` **instead of** `scoreCandidate`.
- Keep legacy `scoreCandidate` export for backward compatibility tests (do not delete yet — Phase 8 may swap them).
- In `BatchUpdate` add optional `clusters` so the UI (Phase 6) can show cluster labels.

### Task 4.4 — Cluster labels (assigned at build time) [fix-M4]

**Files:** Modify `web/src/lib/clustering.ts` — add label assignment inside `buildTasteClusters`.

Rule-based label from centroid values:
- `energy > 0.7 && valence < 0.45` → `"heavy"`
- `energy > 0.7 && valence >= 0.45` → `"upbeat"`
- `energy < 0.45 && acousticness > 0.5` → `"mellow"`
- `valence < 0.4 && speechiness > 0.1` → `"angsty"`
- else → `"cluster ${id}"`

Unit test: 4 hand-crafted centroids → 4 matching labels. NEGATIVE: centroid in a "no rule matches" zone → label is the fallback `"cluster 0"` (not empty, not undefined).

### Task 4.5 — Calibrate `qualityThreshold` tiers against real scores [fix-H5]

**Why:** The new cluster-based scorer returns `1/(1+distance)` — a non-linear curve. A threshold of 0.60 in v2 (weighted sum) means something very different from 0.60 in v3 (distance-to-centroid). Without calibration, "Balanced" tier may return 2 tracks instead of 20. Calibrate against real playlist scores before locking the tiers.

**Files:**
- Create: `web/scripts/calibrate-tiers.mjs` (node script, not committed to src)
- Modify: `web/src/lib/intent-types.ts` — replace the `QUALITY_TIERS` constant with calibrated values

**Step 1:** Write `web/scripts/calibrate-tiers.mjs`:
- Start `npm run dev` in a separate terminal.
- Inject real auth into a Playwright context (reuse `test-full-flow.mjs` pattern).
- Run the pipeline on ISA ROCK with the NEW cluster scorer, **no threshold filter**.
- Collect the top 500 candidate scores.
- Compute percentiles: p40, p70, p90.
- Print them as a JSON blob.

**Step 2:** Run the script. Inspect the printed percentiles. Sanity-check against manual spot review of tracks at each threshold (do tracks at p90 actually look like premium matches?).

**Step 3:** Update `intent-types.ts`:
```ts
export const QUALITY_TIERS = {
  premium: <p90>,    // ~0.80 expected for ISA ROCK, actual from calibration
  balanced: <p70>,   // ~0.65 expected
  inclusive: <p40>,  // ~0.50 expected
} as const;
```
Commit the calibration script output as a comment above the constants so future calibration runs can compare.

**Step 4:** Screenshot `web/test-screenshots/phase4-score-distribution.png` — a histogram of the 500 scores with vertical lines at each tier (use a one-liner with matplotlib-in-node or just a text-based histogram in the script output).

**Step 5:** Commit. Note in the commit message that these values are **playlist-sensitive** — a user with a very homogeneous playlist will see different percentiles. Phase 8 learning (refined taste vector) will re-calibrate implicitly over time.

### Phase 4 Acceptance Criteria

- [ ] Playlists with high audio-feature variance (stddev > 0.15 on energy) produce ≥2 clusters.
- [ ] A heavy candidate (energy > 0.8) is scored against the heavy cluster — not the averaged mean.
- [ ] Recommendation quality visibly improves on the Night Rock test playlist (spot-check 10 tracks). Record a before/after screenshot pair.
- [ ] Pipeline does not crash on single-cluster (k=1) playlists.

**Reality check:**
1. Did you run k-means on the actual ISA ROCK playlist audio features and inspect the cluster assignments manually? If not → ASSUMED, do it.
2. How many clusters does ISA ROCK produce with autoK? Is that reasonable given the playlist contents?
3. Does elbow method give a stable answer across 3 runs with same data? (Determinism via seed.)

---

## Phase 5 — Deep Track Sampling + Quality Threshold

**Goal:** Instead of always picking an artist's top track, score ALL top-10 tracks and pick the best fit. Apply a hard quality threshold so users never see <X% matches.

**Files:**
- Modify: `web/src/lib/discovery-pipeline.ts`
- Modify: `web/src/lib/spotify-client.ts` — ensure `getArtistTopTracks` returns 10 (already should, verify)

### Task 5.1 — Score all 10 top tracks per artist

**Files:** Modify `discovery-pipeline.ts`.

In the loop that collects tracks per candidate artist:
- Call `getArtistTopTracks(artistId, market="US")` → up to 10 tracks
- Fetch audio features for ALL of them (batched via `/api/reccobeats`)
- Score each against clusters → keep only the **best** one per artist
- Log `deep_sampling` event with `{ artistId, consideredN, pickedTrackId, pickedScore, topScore }`

**Negative test:** artist with only 1 top track → pipeline emits that 1 track (no crash).

**Rate-limit consideration:** 10x more ReccoBeats calls. The existing rate limit is 30/min/IP. Update the proxy to be ≥60/min **OR** cap deep sampling to top-5 per artist (open question 5.1 — document both options, default to top-5).

### Task 5.2 — Quality threshold filter

**Files:** Modify `discovery-pipeline.ts`; Intent already has `qualityThreshold`.

After scoring, filter `candidates.filter(c => c.score >= intent.qualityThreshold)`.

**Playwright test** with mocked `intent.qualityThreshold = 0.75` → assert no row shows score < 75%. **NEGATIVE:** set threshold to 0.99 → assert the UI shows "No matches — try a lower quality tier" message (not an empty grid with no explanation).

### Task 5.3 — Quality tier selector in IntentEditor

Already covered by Phase 3.2 (quality tier select). Make sure it maps:
- `premium` → 0.75
- `balanced` → 0.60
- `inclusive` → 0.40

### Phase 5 Acceptance Criteria

- [ ] For each artist in results, the chosen track is NOT always their #1 popularity track (spot-check: pick 5 artists, verify at least 2 chose a non-top track).
- [ ] Raising quality tier to Premium visibly reduces result count.
- [ ] Setting an impossibly high threshold shows a friendly empty-state, not a blank page.
- [ ] `/api/log` contains `deep_sampling` events showing the score distribution across top tracks.

---

## Phase 6 — Per-Track "Why This" Expandable Panel

**Goal:** Every row has an expandable section that explains the score: which cluster, audio match breakdown, matched genres, LLM rationale (if source=llm), blacklist state, sources.

**Files:**
- Create: `web/src/components/WhyPanel.tsx`
- Modify: `web/src/components/TrackRow.tsx` — expand/collapse button + mount WhyPanel
- Modify: `web/src/lib/scoring.ts` (new) — export `buildWhyBreakdown(scored)` producing the shape below
- Modify: `web/src/lib/discovery-pipeline.ts` — populate `breakdown` on every `ScoredCandidate`

### Task 6.1 — `WhyBreakdown` data shape + builder

**Files:** `web/src/lib/scoring.ts`.

```ts
export interface WhyBreakdown {
  score: number;
  cluster: { id: number; label: string; distance: number; centroid: Record<string, number> };
  audio: Array<{ feature: string; value: number; clusterMean: number; withinStd: boolean }>;
  genres: { matched: string[]; required: number; total: number };
  llm: { why: string; confidence: number } | null;
  blacklist: { tracked: boolean; artistTracked: boolean };
  sources: SourceTag[];
}
```
Test: given a known `ScoredCandidate` + `TasteClusters`, `buildWhyBreakdown` returns the expected object. **NEGATIVE:** candidate with no audio features → `audio: []` (not NaN).

### Task 6.2 — WhyPanel component

**Files:** `web/src/components/WhyPanel.tsx`.

Layout matches handoff section 5.7. Expandable. Pure presentational (no data fetching). Uses the tree-style ASCII from the handoff for the text, or a table — pick the more legible one and screenshot both during design.

**Playwright test** `web/test-why-panel.mjs`:
- Mock one result with known breakdown
- Click expand
- Assert the text content matches expected (audio features listed, cluster label, sources listed)
- Screenshot `web/test-screenshots/phase6-why-expanded.png`
- **NEGATIVE:** click expand twice → panel collapses (state toggles correctly)

### Task 6.3 — Display cluster labels in the WhyPanel

Cluster labels are already assigned at build time (Phase 4 Task 4.4 [fix-M4]) — this task is purely presentational.

**Files:** `WhyPanel.tsx` (already modified in 6.2).

- Read `cluster.label` from the breakdown.
- Show it prominently (large, above the centroid values).
- Below the label, show the centroid values for `energy`, `valence`, `tempo`, `acousticness`, `speechiness` as a small table — the label is approximate; the real signal is the numbers.

### Phase 6 Acceptance Criteria

- [ ] Every result row has an expand button that reveals the breakdown.
- [ ] Breakdown shows: score, cluster label, 3-5 audio features with values and cluster means, matched genres, LLM reason (if present), source tags.
- [ ] On a playlist rescored after Phase 4, different tracks show different cluster assignments.

---

## Phase 7 — Last.fm Source

**Goal:** Add a third candidate source: Last.fm's `artist.getSimilar` API (real listening-pattern similarity, complements Spotify's popularity bias and LLM's semantic bias).

**Files:**
- Create: `web/src/app/api/lastfm/route.ts` — server-side proxy (keeps API key in `.env`, never exposed to client)
- Create: `web/src/lib/lastfm.ts` — client helper
- Create: `web/src/lib/lastfm-source.ts` — builds `Candidate[]` with `sourceTags: ["lastfm"]`
- Modify: `web/src/lib/discovery-pipeline.ts` — fan-out to Last.fm in parallel with Spotify + LLM

### Prerequisite — register Last.fm API key

**Who registers:** the user (open question 7.1 from handoff). They register at https://www.last.fm/api/account/create (5 min, free, no rate-limit hell). Once key exists, add `LASTFM_API_KEY=...` to `web/.env` (gitignored — verify with `git check-ignore`).

**If key is not registered yet** → implement the module behind a feature flag `NEXT_PUBLIC_LASTFM_ENABLED=false` by default. Pipeline skips Last.fm fan-out when disabled. Unit tests for `lastfm-source.ts` run against mocked fetches.

### Task 7.1 — Server-side proxy

**Files:** `web/src/app/api/lastfm/route.ts`.

`POST { method: "artist.getSimilar", artist: "Foo Fighters", limit: 20 }` → server injects API key → proxies to `http://ws.audioscrobbler.com/2.0/` → returns JSON. In-memory rate limit (same pattern as `/api/reccobeats`).

**Negative test:** omit `method` param → 400. Invalid method → 400. Gemini-style curl test documented in the plan's "Quick Reference" section.

### Task 7.2 — `lastfm-source.ts`: build candidates [fix-H8 budget]

**Budget (derived from [fix-C6] 120/min ReccoBeats limit):**
- **5 seed artists** (from playlist top-10) × **10 similar each** = 50 similar artists
- **Top-3 deep sampling** per similar artist (not top-5 like Spotify source) = 150 candidate tracks
- Features call: `ceil(150 / 40)` = 4 batches. Combined with Spotify's ~75 batches + LLM's 1 batch ≈ 80 batches per scan. At 120/min, fits comfortably in <60s budget.

For each of the **5 top artists** (not 10) in the source playlist:
1. Call `/api/lastfm` → getSimilar → list of **10** similar artists (not 20) with `match` score.
2. For each similar artist, `searchArtists(name)` on Spotify to get Spotify ID + genres.
3. Filter out already-in-playlist artists, blacklisted artists (by ID AND name).
4. For each, `getArtistTopTracks(id)` → deep-sample **top 3** (not top 5).
5. Return `Candidate[]` with `sourceTags: ["lastfm"]` and `llmWhy: "Last.fm similarity ${match.toFixed(2)} to ${seedArtist}"`.

Emit as an async generator (same pattern as `buildLLMCandidates` [fix-C5]) so it plugs into `mergeAsyncGenerators`.

### Task 7.3 — Fan-out

In `runPipelineStreaming`, extend the `sources` array from Phase 3 Task 3.4 to include `buildLastfmCandidates(...)`. The `mergeAsyncGenerators` helper already handles per-source failure (logs `source_error` event, keeps sibling sources yielding). **Do not** use `Promise.allSettled` — that was the rejected pattern in [fix-C5].

**Playwright test** `web/test-lastfm-integration.mjs`:
- Mock `/api/lastfm` and `/api/llm-recommend` and Spotify — assert results contain tracks from all three sources.
- **NEGATIVE:** mock `/api/lastfm` to return empty → results still populate from Spotify + LLM.

### Phase 7 Acceptance Criteria

- [ ] With all three sources enabled, results contain a mix of source tags (verify in WhyPanel).
- [ ] Last.fm returning empty does not degrade Spotify/LLM results.
- [ ] `LASTFM_API_KEY` never appears in the browser network tab or built JS bundle (`grep` the `.next/static/` output).

**Security check (Rule 18 / Rule 3) — grep for the VALUE, not the name [fix-H4]:** the name appearing in bundled code is harmless; only the value leaking matters. Use a node helper that reads the real key from env (never prints it) and greps the bundle for a unique prefix:

```bash
cd web && npm run build

# Grep .next/static for the first 8 chars of the actual key value.
# If this finds a match, the key leaked into the client bundle.
node -e '
  const k = process.env.LASTFM_API_KEY;
  if (!k || k.length < 8) { console.log("no key set — skip"); process.exit(0); }
  const prefix = k.slice(0, 8);
  const { execSync } = require("child_process");
  try {
    execSync("grep -r \"" + prefix + "\" .next/static/", { stdio: "pipe" });
    console.error("LEAK DETECTED: key prefix found in client bundle");
    process.exit(1);
  } catch (e) {
    // grep exit 1 = no match = safe
    console.log("OK: key value not found in client bundle");
  }
'

# Also grep the debug log and any Playwright stdout captures
node -e '
  const k = process.env.LASTFM_API_KEY;
  if (!k) process.exit(0);
  const prefix = k.slice(0, 8);
  const { execSync } = require("child_process");
  for (const f of ["soundfox-debug.log"]) {
    try { execSync("grep \"" + prefix + "\" " + f, { stdio: "pipe" }); console.error("LEAK: " + f); process.exit(1); } catch {}
  }
'
```

Neither command prints the key. If either finds it, fix the leak before proceeding.

---

## Phase 8 — Learning: Refined Taste Vector + Genre Re-Weighting

**Goal:** Once the user has accepted ≥20 tracks for a playlist, future scans use a taste vector derived from accepted tracks only (not raw playlist). Genres with a high rejection rate get de-prioritized.

**Files:**
- Modify: `web/src/lib/profile.ts` — add `computeRefinedTasteVector(profile, featuresByTrack)` + `getGenreWeights(profile)`
- Modify: `web/src/lib/discovery-pipeline.ts` — prefer refined vector when available + weight genre gate by `getGenreWeights`
- Modify: `web/src/components/ResultsStep.tsx` — small banner "Using learned preferences (N accepted tracks)" when refined vector is active

### Task 8.0 — Seed a synthetic profile so Phase 8 is actually testable [review-4]

**Why:** Phase 8 activates when a playlist has ≥20 accepted tracks. On ship day, v3 has zero. Testing "re-scans produce noticeably different results before vs after 20 acceptances" against a live user is impossible without real history — the engineer either waits days or eyeballs "feels different" and calls it done. Neither is good enough for the single most ambitious feature of v3.

**Files:**
- Create: `web/scripts/seed-profile.mjs` — local one-shot seed script (not committed to `src/`)

**Step 1: Gather 25 track IDs.** Pick from the user's real v2 analysis history (stored in `soundfox_history` key in localStorage). The script reads that history, picks 25 tracks the user previously added to Spotify (a good proxy for "accepted"). Alternative: hand-curated list of 25 known-good tracks from ISA ROCK.

**Step 2:** Write `web/scripts/seed-profile.mjs`:
```js
// Usage: node web/scripts/seed-profile.mjs <playlistId>
// Opens a Playwright browser, reads v2 history from localStorage, picks 25 tracks,
// fetches ReccoBeats features via /api/reccobeats, writes a full PlaylistProfile
// keyed by <playlistId> into localStorage with:
//   - accepted.trackIds = [25 ids]
//   - accepted.refinedTasteVector = null  (Phase 8.1 will compute it)
//   - blacklist = empty
//   - schemaVersion = 1
// Does NOT touch the real profile if it exists — writes to soundfox_profile_<playlistId>_seed
// so the test can compare seeded vs empty profiles explicitly.
```

Key logic (abbreviated):
```js
const profile = {
  playlistId, intent: null, intentText: "",
  blacklist: { trackIds: [], artistIds: [], artistNames: [], genres: [], rejectionsByArtist: {} },
  accepted: { trackIds: twentyFiveIds, refinedTasteVector: null },
  stats: { runsCount: 0, acceptedCount: 25, rejectedCount: 0, lastRunAt: null },
  schemaVersion: 1,
};
await page.evaluate((k, v) => localStorage.setItem(k, v),
  "soundfox_profile_" + playlistId + "_seed", JSON.stringify(profile));
```

**Step 3:** Run the script once. Verify in DevTools that `soundfox_profile_<id>_seed` exists and has `accepted.trackIds.length === 25`.

**Step 4:** Playwright test `web/test-phase8-seeded.mjs`:
- Baseline run: clear the seed, scan the playlist, capture top-50 result IDs as `A`.
- Seed the profile, re-scan the **same playlist**, capture top-50 result IDs as `B`.
- Compute Jaccard distance: `|A ∩ B| / |A ∪ B|`.
- Assert the set `B` differs from `A` by **≥ 10%** (i.e. Jaccard ≤ 0.9). Lower than 0.9 proves the refined taste vector moved the recommendations at all. If the change is imperceptible, the learning loop is a no-op and Phase 8 has failed.

**Step 5: Commit.**

### Task 8.1 — Refined taste vector

**Files:** `web/src/lib/profile.ts`.

```ts
export async function computeRefinedTasteVector(
  profile: PlaylistProfile,
  getFeatures: (trackIds: string[]) => Promise<Map<string, AudioFeatures>>,
): Promise<TasteVector | null> {
  const accepted = profile.accepted.trackIds;
  if (accepted.length < 20) return null;  // open question 8.1 — configurable?
  const feats = await getFeatures(accepted);
  return buildTasteClustersToVector(feats); // OR buildTasteVector for single-cluster mode
}
```

**Design note:** once Phase 4 is in, "refined taste vector" may become "refined TasteClusters" — they're compatible. Write `computeRefinedTasteClusters` instead if Phase 4 was completed before 8. Make the call site use whichever representation matches the scorer.

**Unit tests:** <20 accepted → returns null. ≥20 → returns clusters. **NEGATIVE:** 20 accepted but getFeatures returns empty → null (don't crash).

### Task 8.2 — Genre re-weighting

Compute `getGenreWeights(profile)`:
- For each genre seen in rejected tracks, `rejectionRate = rejections / (rejections + acceptances)`
- `weight = 1 - rejectionRate * 0.7` (cap at 0.3 min — never fully zero out)
- Tracks with only low-weight genres have their `score *= avgGenreWeight`

**Unit tests:** genre with 10 rejections + 0 accepts → weight 0.3. Genre with 0 rejections → weight 1.0. **NEGATIVE:** no rejection data at all → all weights = 1.0 (neutral, no change to scores).

### Task 8.3 — UI banner

Above the results grid, when `profile.accepted.trackIds.length >= 20`:
```
🧠 Using learned preferences — 47 accepted, 12 rejected across 3 runs
```
Screenshot: `web/test-screenshots/phase8-learning-banner.png`.

### Phase 8 Acceptance Criteria

- [ ] After accepting 20+ tracks, next scan uses the refined vector (verify via log: `refined_vector_active: true`).
- [ ] Genres the user has rejected repeatedly score lower on subsequent runs.
- [ ] Banner appears with correct stats.
- [ ] **Seeded-profile Jaccard test [review-4]:** using the 25-track seeded profile from Task 8.0, re-scan produces top-50 results with **Jaccard distance ≥ 0.1** vs a clean-profile scan. Target: the refined taste vector must actually change ≥ 10% of the top-50 picks — otherwise the learning loop is cosmetic.

---

## Cross-Cutting Concerns (apply in every phase)

### Testing ladder
1. **Unit** (`vitest` in `web/__tests__/*.test.ts`) — pure functions, no network.
2. **Component** (Playwright `web/test-*.mjs`) — single component mounted, mocked APIs.
3. **E2E** (Playwright `web/test-full-flow-v3.mjs`) — whole wizard, mocked Spotify + mocked Gemini + mocked Last.fm.
4. **Smoke** (manual) — run dev server against the real Spotify account on ISA ROCK, capture screenshot, inspect debug.log.

Every phase must add at least a unit test + a Playwright test + a new smoke-test screenshot.

### Rate-limit hygiene
- Gemini: one intent parse per playlist (cached). One recommendation call per scan (40 LLM recs per call default). Open question 8.1 from handoff: cache intent parses for N hours.
- Last.fm: 5 req/s limit. In-memory proxy throttle.
- ReccoBeats: 30/min/IP current. Deep sampling increases load — default to top-5 per artist (not top-10) to stay under budget. Revisit if user wants premium.
- Spotify: existing throttle + 429 retry is already in `spotify-client.ts` — do not re-invent.

### Migration path for existing users
First scan of a playlist for a user who already had a v2 history:
1. `loadProfile(playlistId)` → null
2. Create empty profile, **prefill `intent: null`** → user gets the first-time intent prompt (friendly)
3. Existing `analysis history` (from v2) is kept separately — not deleted. Profile starts fresh.

Write a one-shot migration helper that scans existing v2 history entries and creates empty profiles for each (no intent) so users don't have to re-prompt for each playlist on first run. Optional — default to lazy creation.

### Security checklist (run at end of every phase)
- [ ] No secret values in commits (`git log --all -p | grep -E "GEMINI|LASTFM|SPOTIFY"` — expect no hits on values, only variable names).
- [ ] `web/.env` is gitignored.
- [ ] No secret values in source files (grep source dir for the literal prefix of your Gemini key format `AIza` or Last.fm key format — assert no matches).
- [ ] No secret values in Playwright test logs (review `web/soundfox-debug.log` and test stdout).
- [ ] No secret values printed in this conversation (Global Rule: never print token values, transcripts persist).

### Observability [fix-H6]

Every scan mints a `scanId` (`crypto.randomUUID()`) at the start of `runPipelineStreaming`. Every `/api/log` POST from the pipeline includes `{ scanId, event, ...payload }`. This makes it possible to `grep` the log for a single scan's full trace even when two tabs produce interleaved events.

**Log rotation:** modify `web/src/app/api/log/route.ts` — before every append, check the file size. If `soundfox-debug.log` exceeds 10 MB:
1. Rename it to `soundfox-debug.1.log` (overwriting any previous `.1` file).
2. Start a new empty `soundfox-debug.log`.
3. Append the current event to the fresh file.

No retention beyond `.1` — this is a local dev tool, not a production audit log. Write a Playwright test that writes 10,001 KB of events, asserts the rotation happened.

Events that should carry `scanId`:
- `blacklist_skip` (Phase 1)
- `dedup_collapse` (Phase 2)
- `intent_parsed`, `llm_candidates`, `llm_resolved`, `source_error` (Phase 3)
- `deep_sampling` (Phase 5)
- `refined_vector_active`, `genre_reweight_applied` (Phase 8)

### Concurrency [fix-H7]

`PlaylistProfile` writes are vulnerable to multi-tab races: two tabs both call `loadProfile → modify → saveProfile`, last write wins, earlier tab's changes are lost silently.

**Mitigation pattern** — all write helpers in `profile.ts` (`blacklistTrack`, `markAccepted`, `setIntent`) already do `loadProfile → modify → saveProfile` atomically per call. Callers MUST NOT hold a stale in-memory profile across user interactions; each click/action re-loads, mutates, and saves.

**Acceptable residual risk** — this is a single-user local tool. Two-tab races are rare and the consequence is at most one lost rejection. Full mutex via the Web Locks API is overkill for v3.

**Definition of Done check:** manual two-tab test —
1. Open `/wizard` in tab A, `/go` in tab B, both on playlist P.
2. Reject track T1 in tab A. Confirm persists (reload tab A).
3. Reject track T2 in tab B. Confirm persists (reload tab B).
4. Reload tab A. Confirm T1 AND T2 are both in `blacklist.trackIds` (neither tab clobbered the other because each call re-loads before writing).

If this test fails, the implementation is holding a stale profile reference somewhere — fix by inlining `loadProfile` before every mutation.

### Rollback plan
- Each phase is an independent commit group.
- If a phase ships broken behavior, revert the commit range; `localStorage` data persists across reverts so users don't lose profiles.
- Profiles have a `schemaVersion: 1` — future schema changes go through `migrateProfile` in `profile.ts` [fix-M7], which reads old versions and transforms them. If a bump goes wrong, the function returns `null` and `loadProfile` falls back to treating the playlist as new (not a crash).

---

## Open Questions (decide before starting the phase that depends on them)

| # | Phase | Question | Default if unresolved |
|---|---|---|---|
| 1 | 3 | Intent editing UI: JSON textbox, structured form, or chips? | **Form + chips** (chosen in Task 3.2) |
| 2 | 7 | Last.fm key: who registers? | **User registers before Phase 7 starts.** Feature flag off otherwise. |
| 3 | 4 | k-means cluster count: fixed k=3 or auto-detect via elbow? | **Auto via elbow, bounded 2 ≤ k ≤ 5** |
| 4 | 8 | Refined taste vector trigger: ≥20 accepted? | **20 is the default; expose in settings later** |
| 5 | 8 | Learning timing: every run / continuous / manual "apply learnings" button? | **Every run, fully automatic** |
| 6 | 3 | Merge strategy when Spotify + LLM + Last.fm all return candidates? | **Union → dedup (Phase 2) → score all → rank by score (source-neutral)**. `sourceTags` preserved for transparency. |
| 7 | 3 | Gemini rate-limit budget: cache intent parses? | **Cache per-playlist on `intentText` hash; invalidate when user edits text** |
| 8 | 3 | LLM model: flash for intent, pro for recs? | **Use `GEMINI_MODEL` from env for both; user's existing `gemini-3.1-pro-preview` is fine. Revisit if cost matters.** |
| 9 | 1 | Migration for existing v2 users with no profile? | **Lazy: create empty profile on first scan after v3 ship** |
| 10 | 5 | Deep sampling depth: top-5 or top-10 per artist? | **Top-5 by default** (rate-limit safe). User-configurable slider later. |
| 11 | 2 | Dedup audio-fingerprint thresholds — how strict? | **duration ±2s, tempo ±2 BPM, energy ±0.03** (from handoff) |
| 12 | 6 | Cluster labels — rule-based or LLM-generated? | **Rule-based to start (no extra Gemini call per scan). LLM labels as v4 enhancement.** |

Bring these back to the user at the start of the relevant phase if the default feels wrong.

---

## Definition of "v3 Done"

v3 is shippable when ALL of the following are true. No exceptions. No "let's be honest" (Global Rule 13).

1. All 8 phases pass their Acceptance Criteria.
2. `npm run build` (in `web/`) zero errors. `npx vitest run` zero failures.
3. Full-flow Playwright (`web/test-full-flow-v3.mjs`) passes. **Run it against a production build [review-11]** — `cd web && npm run build && npm run start &` then run the test. Per-phase component Playwright tests run against `npm run dev` for iteration speed; the v3 smoke test in DoD runs against prod to rule out dev-mode quirks (primer: `allowedDevOrigins` / hydration issues).
4. **Scan-time budget (fix-C6):** a scan of the 171-track ISA ROCK playlist completes end-to-end in ≤60 seconds.
5. Smoke test on real ISA ROCK playlist produces ≥10 results with score ≥ `QUALITY_TIERS.balanced` (calibrated per fix-H5), ≥3 sources represented, no duplicates, no blacklisted tracks.
6. A before/after comparison against v2 on the same playlist is documented with screenshots (v2 baseline from Phase 0 vs v3 smoke). User confirms v3 quality is visibly better.
7. **Two-tab concurrency test (fix-H7)** passes as described in Cross-Cutting Concurrency.
8. **Security scan** — grep for the real Gemini and Last.fm key value prefixes in `.next/static/` and `soundfox-debug.log`: zero matches (fix-H4).
9. `/reality-check` (Global Rule 16) runs clean on a final pass: 5 adversarial questions, all VERIFIED.
10. `docs/handoff/2026-04-22-soundfox-v3-shipped.md` written summarizing what shipped, what's deferred, known issues.

---

## Quick Reference

```bash
# Dev
cd web && npm run dev

# Full flow Playwright (v3)
cd web && node test-full-flow-v3.mjs

# Individual test (example)
cd web && node test-intent-step.mjs

# Unit tests
cd web && npx vitest run

# Build check (mandatory after every batch)
cd web && npm run build

# Intent parse curl
curl -X POST -H "Content-Type: application/json" \
  -d '{"freeText":"workout music, high energy, 120+ BPM","playlistContext":{"name":"ISA ROCK","topArtists":["Foo Fighters","Audioslave"],"topGenres":["rock","grunge"],"trackCount":171}}' \
  http://127.0.0.1:3000/api/intent

# LLM recommendations curl
curl -X POST -H "Content-Type: application/json" \
  -d '{"intent":{...},"tasteVector":{"energy":0.75,"tempo":130},"topArtists":["Foo Fighters"],"count":10,"excludeArtists":[]}' \
  http://127.0.0.1:3000/api/llm-recommend

# Last.fm proxy curl (Phase 7+)
curl -X POST -H "Content-Type: application/json" \
  -d '{"method":"artist.getSimilar","artist":"Foo Fighters","limit":20}' \
  http://127.0.0.1:3000/api/lastfm

# Check env var presence (no value leak) — fix-M3, Node-version-agnostic
cd web
node -e "console.log('.env:', require('fs').existsSync('.env') ? 'FOUND' : 'MISSING')"
grep -c '^GEMINI_API_KEY=' .env     # expect 1
grep -c '^GEMINI_MODEL=' .env       # expect 1
grep -c '^LASTFM_API_KEY=' .env     # expect 0 until Phase 7, 1 after

# Turbopack reset (when behavior is weird)
rm -rf web/.next && cd web && npm run build
```
