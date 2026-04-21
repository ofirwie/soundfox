# Project Rules — Spotify Recommendation / SoundFox

## Stack Warning
- `web/` is **Next.js 16 + React 19.2** — APIs and conventions differ significantly from training data
- **Read `web/AGENTS.md` before making any code changes** — it contains critical breaking-change notices
- Check `node_modules/next/dist/docs/` for current API documentation

## Mandatory Build Check
- Run `npm run build` (inside `web/`) after **every batch of changes**
- Do NOT claim a fix is done until the build passes with zero errors
- TypeScript errors are errors — treat them as failures

## Verification Standard
- Do NOT claim "done" without visual browser verification
- Passing build alone is not sufficient — the real flow must work in a browser
- Screenshots of actual rendered output are required before declaring completion

## Browser API Isolation
- All `lib/` files that use browser-only APIs (`localStorage`, `window`, `document`, `navigator`) **MUST** have `"use client";` as their first line
- This includes `src/lib/storage.ts` and any future browser-only utilities

## React Type Imports
- All React type annotations must use **named imports** from `"react"`:
  ```ts
  import type { ReactElement, ReactNode } from "react";
  ```
- **Never** use `React.ReactElement` or `React.ReactNode` via the namespace — this requires a `React` import that isn't needed in React 19 JSX transform
- Wrong: `React.ReactElement` / `React.ReactNode`
- Right: `ReactElement` / `ReactNode`

## Hydration Safety
- Never read browser-only APIs (`localStorage`, `window`) at the top level of a component body or as a direct `useState` initializer expression
- Use lazy initializers with SSR guards: `useState(() => { if (typeof window === "undefined") return default; return ... })`
- For values that only affect UI banners/display (not initial state), use `useState(null)` + `useEffect(() => { setState(loadValue()) }, [])` to avoid hydration mismatch

## Rate-Limited Features
- Spotify API calls may hit rate limits in serverless/cold-start environments
- Acknowledge cold-start reality when designing API features — don't assume persistent in-memory state
- All Spotify API interactions happen client-side (no server state)

## Dev Server Gotchas (Next 16)
- **Cross-origin HMR blocked by default** — accessing app at `127.0.0.1` while Next defaults HMR to `localhost` causes "Blocked cross-origin request to /_next/webpack-hmr" warning. This silently **breaks client hydration** on dev (prod is fine).
- **Fix:** Add `allowedDevOrigins: ["127.0.0.1", "localhost"]` to `next.config.ts`.
- **Symptom:** SSR renders the page but client JS never hydrates. `useEffect` never runs. `console.log` never fires. Only SSR DOM is visible.
- Production build (`npm run build && npm run start`) does NOT have this issue.

## Playwright Verification Pattern
- Use `test-full-flow.mjs` pattern: mock Spotify API with `context.route()`, inject auth state via `addInitScript`, assert on `bodyText` substrings.
- This is the ONLY way to verify dev-mode hydration and interactive flows.
- **Playwright LIFO route ordering:** routes are checked last-registered-first. When mocking multiple paths, register a single catch-all `api/**` handler rather than registering overlapping routes.
- **`postDataJSON()` is NOT a Promise** in this Playwright version — use `route.request().postData()` + `JSON.parse()` wrapped in try/catch.

## Phase 3 — Intent + Multi-Source Pipeline (COMPLETE — 2026-04-21)

### What Was Done
- **Task 3.0:** `gemini-server.ts` `parseIntent` now retries twice (2nd attempt at temperature=0) then falls back to `defaultIntent()` with `intentParseFailed: true`. Unit tests: `parse-intent-retry.test.ts` (3 cases pass).
- **Task 3.1/3.2:** `IntentStep.tsx` (new) — free-text → Parse → IntentEditor → Continue. Returning user (profile has intent) shows Run again / Change intent. `IntentEditor.tsx` (new) — form with purpose, tempo, energy, genre chips, era, requirements, quality tier. Validation: tempoMin > tempoMax shows `role="alert"`, blocks Apply.
- **Task 3.3:** `wizard/page.tsx` updated to 7 steps (Setup, Connect, Choose Playlist, **Intent**, Scan Options, Analyze, Results). `handleIntentConfirmed` calls `setIntent(playlistId, intent, intentText)` then advances.
- **Task 3.4:** `buildLLMCandidates` (async generator, bounded parallelism cap=5) in `llm-source.ts`. `mergeAsyncGenerators` (streaming fan-out) in `merge-generators.ts`. `discovery-pipeline.ts` starts LLM collection concurrently, drains buffer into each Spotify batch, logs `source_error` (sourceIndex:1) on failure. **`getLLMRecommendations` throws on non-OK responses** so errors propagate to the catch block.
- **Task 3.5:** `setIntent` in `profile.ts` — strips `intentParseFailed` transport flag before persisting. `AnalysisStep.tsx` now passes `intent: profile.intent ?? undefined` to pipeline.
- **Task 3.6:** Persistent dedup in `merge-and-emit.ts` (`emittedIds` + `emittedKeys` across all chunks). `buildDedupKey` normalizes artist+track, strips remaster/live/remix suffixes. `data-source` DOM attribute on `TrackRow` for E2E verification.

### E2E Tests (all pass)
- `test-intent-step.mjs` — Parse flow + safe-default yellow banner (4 pass)
- `test-intent-returning-user.mjs` — Returning vs new user UI (5 pass)
- `test-intent-editor.mjs` — Apply valid + tempoMin>tempoMax negative (3 pass)
- `test-dedup.mjs` — Duplicate track deduplication (3 pass)
- `test-llm-fallback.mjs` — LLM 500 → Spotify-only + source_error logged (3 pass)
- `test-llm-happy.mjs` — LLM happy path → llm row in UI (2 pass)

### Key Gotchas
- `getLLMRecommendations` now throws `Error("LLM source error: N")` on non-2xx — callers that want silent fallback should handle the specific error prefix.
- React StrictMode double-mount: E2E assertions use `count() <= 2` not `=== 1` for track rows.
- `options.intent` undefined → LLM path entirely skipped (no impact on Spotify-only scans).

## Phases 4-8 — Clustering, Deep Sampling, WhyPanel, Last.fm, Learning Loop (COMPLETE — 2026-04-21)

### What Was Done

**Phase 4: k-means clustering** (`clustering.ts`, `taste-engine.ts`)
- kmeans++ init, Lloyd's algorithm (50 iter max), autoK elbow method (biggest WSS deceleration)
- Seeded PRNG (mulberry32) for determinism; features normalized before clustering
- `scoreCandidateClustered()` in `taste-engine.ts`: nearest centroid, score = 1/(1+distance)
- Labels: heavy / upbeat / mellow / angsty / cluster N

**Phase 5: Deep sampling + quality threshold** (`merge-and-emit.ts`)
- Collect up to 5 valid tracks per artist, score all, keep best-scoring per artist (`scoredByArtist` Map)
- `qualityThreshold` filter post-scoring; `genreWeights` applied: `score *= avgGenreWeight`
- `qualityThresholdApplied` propagated to ResultsStep for appropriate empty-state message

**Phase 6: WhyBreakdown + WhyPanel** (`scoring.ts`, `WhyPanel.tsx`, `TrackRow.tsx`)
- `buildWhyBreakdown()` called at score time in both Spotify and LLM/Last.fm paths
- Stored as `breakdown` field on `ScoredTrack`, travels through pipeline to UI
- `WhyPanel` expandable from "Why?" button in `TrackRow`; shows cluster, audio features, genres, LLM rationale

**Phase 7: Last.fm source** (`lastfm.ts`, `lastfm-source.ts`, `api/lastfm/route.ts`)
- Server-side proxy keeps API key hidden; allowlist: `artist.getSimilar` + `artist.getTopTracks` only
- 5 seed artists × 10 similar × 3 tracks = 150 candidates max; rate-limited 60 req/min
- Merged with LLM via `mergeAsyncGenerators` into shared `nonSpotifyBuffer`

**Phase 8: Learning loop** (`profile.ts`, `AnalysisStep.tsx`, `ResultsStep.tsx`)
- `rejectionsByGenre` + `acceptancesByGenre` added to `BlacklistEntry`; `ensureGenreFields()` for backward compat
- `computeRefinedTasteClusters(profile, getFeatures)`: needs ≥20 accepted tracks, returns `TasteClusters | null`
- `getGenreWeights(profile)`: `weight = max(0.3, 1 - rejectionRate * 0.7)`
- Both passed to pipeline before scan starts in `AnalysisStep.tsx`
- Learning banner in `ResultsStep` when ≥20 accepted tracks

**Fix: go/page.tsx UX** — playlist selection now routes through `IntentStep` before scan (was bypassing it)

### Tests
- 59/59 unit tests pass (10 files): clustering (13 tests), learning (5 tests), plus Phase 3 suite
- Committed: `695df78` | Pushed to `master` | Vercel deploy triggered

### Key Gotchas (Phases 4-8)
- Feature normalization: loudness (-60..0 → 0-1), tempo (60-200 → 0-1), others identity — centroid in normalized space
- `refinedClusters: null ?? undefined` = undefined → pipeline falls back to auto-built clusters (null from failed `computeRefinedTasteClusters` is handled gracefully)
- `LASTFM_API_KEY` lives only in `process.env` on server — not in client bundle (verified by bundle grep)
- `options.intent` undefined → LLM path skipped; Last.fm always runs (discovery doesn't require intent)
