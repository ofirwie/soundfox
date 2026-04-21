# Plan QA Report — SoundFox v3 Implementation Plan

**Reviewed:** `docs/plans/2026-04-21-soundfox-v3-intent-learning.md`
**Date:** 2026-04-21
**Reviewer:** plan-qa skill (14 checks + cross-correlations)

## Summary

- **Checks run:** 14 + concurrency + observability callouts
- **Findings:** 6 CRITICAL, 9 HIGH, 8 MEDIUM
- **Consistency (Checks 1–8):** 4 CRITICAL, 3 HIGH, 4 MEDIUM
- **Architecture (Checks 9–14):** 2 CRITICAL, 6 HIGH, 4 MEDIUM
- **Verdict:** **NEEDS FIXES** — the plan contains two foundation-level gaps (no test runner installed; `AudioFeatures` type incompatible with "missing features" negative tests) that will stop Phase 1 on its first test run. Multiple streaming/contract gaps will surface in Phase 3–7. All listed fixes are surgical; no rethink required.

---

## CRITICAL Findings (block implementation)

### [C1] Vitest is not a dependency — every unit test written in the plan will fail to import

- **Check:** 5 (assumption verification), 13 (testability)
- **Document says:** `Phase 1.1` test file `import { describe, it, expect, beforeEach } from "vitest";` — same pattern used in dedup, clustering, scoring, profile tests across Phases 1/2/4/6/8. The "Quick Reference" section runs `npx vitest run`. Phase 1 fallback: *"use `vitest` if present; otherwise `node:test` — check `web/package.json` and use whichever is configured"*.
- **Reality:** `web/package.json` dependencies (verified via Read):
  ```
  @google/generative-ai, next, react, react-dom
  @playwright/test, @tailwindcss/postcss, @types/*, level, playwright, tailwindcss, typescript
  ```
  No `vitest`, no `jest`, no `node:test` runner configured, no `jsdom`/`happy-dom`. The "fallback to node:test" branch is not drop-in compatible — `node:test` uses `test()` + `assert`, not `describe/it/expect`.
- **Impact:** Task 1.1 Step 2 (`Run test → expect FAIL (module not found)`) will fail in the wrong way — `Cannot find module 'vitest'` — and block the TDD Red step for every phase that has unit tests. Additionally, `beforeEach(() => localStorage.clear())` requires a DOM environment, which needs `jsdom` or `happy-dom`.
- **Fix:** Add an explicit "Task 0.1 — Install test runner" to Phase 0:
  ```
  cd web
  npm i -D vitest @vitest/ui jsdom
  # add to package.json scripts: "test": "vitest run --environment jsdom"
  # add web/vitest.config.ts with { test: { environment: "jsdom", globals: false } }
  ```
  Commit as `chore: add vitest + jsdom test runner`. Then proceed with Phase 1. Delete the "otherwise node:test" fallback — it's a trap (tests will need full rewrite).

### [C2] `AudioFeatures` is typed as all-required, but negative tests assume missing features

- **Check:** 3 (algorithm completeness), 8 (existing code alignment)
- **Document says:**
  - Task 4.2 negative test: *"call `scoreCandidateClustered` with a feature set that is missing `energy` and `tempo` — assert it does not NaN"*
  - Task 6.1 negative test: *"candidate with no audio features → `audio: []` (not NaN)"*
- **Reality:** `web/src/lib/reccobeats.ts:10` defines `export type AudioFeatures = Record<FeatureKey, number>` — every `FeatureKey` is **required** and typed `number` (no `undefined`). Strict TypeScript will refuse to construct a "missing energy" `AudioFeatures` literal. Ironically, at runtime `reccobeats.ts:45` casts a `Partial<AudioFeatures>` to `AudioFeatures` via `features as AudioFeatures`, so at runtime the features **can** be partial — but the plan's tests need to either (a) cast explicitly, matching the runtime lie, or (b) change `AudioFeatures` to `Partial<Record<FeatureKey, number>>`.
- **Impact:** Negative tests in Phases 4 and 6 will either not compile (TS strict) or will have to bypass the type with `as unknown as AudioFeatures` hacks that obscure what's being tested. `buildTasteVector` and `cosineSimilarity` already handle `null` via runtime guards (`taste-engine.ts:32-38, 97`) — so the code is correct, but the **type is wrong**.
- **Fix:** Add an early task in Phase 4 (before Task 4.1): tighten `AudioFeatures` to `Partial<Record<FeatureKey, number>>` and update the two callers (`taste-engine.ts` already handles missing values — no change; `reccobeats.ts:40-45` already builds partials — remove the `as AudioFeatures` cast). Then negative tests can literally say `const f: AudioFeatures = { danceability: 0.5, valence: 0.3 }` and compile cleanly.

### [C3] `Intent` interface is duplicated in two files — plan's glossary says "do not redefine", but it's already redefined

- **Check:** 1 (name consistency), 2 (contract completeness), 8 (existing code alignment)
- **Document says:** Glossary: *"`Intent` exists in `lib/llm-source.ts` (do not redefine)"*. All new code imports `Intent` from `@/lib/llm-source`.
- **Reality:**
  - `web/src/lib/gemini-server.ts:12-32` — defines `Intent` (server-side)
  - `web/src/lib/llm-source.ts:6-23` — defines `Intent` again (client-side)
  - The two definitions are **subtly different**: server says `era?: string`, client says `era?: string | null`. `requirements` is identical. They will drift further.
- **Impact:** When `/api/intent` returns a `{ intent }` payload and the client parses it as `Intent` (client type), `era: null` is accepted client-side but not server-typed — works today by coincidence. Any future field added to only one side causes silent runtime failure on the other. Plan Phase 3 adds `buildLLMCandidates` which consumes `Intent` — if the client version drifts, the server schema mismatch will cause `/api/llm-recommend` to reject or silently drop fields.
- **Fix:** Before Phase 3 Task 3.1, extract a single shared `Intent` interface:
  - Create `web/src/lib/intent-types.ts` with the canonical `Intent` + `LLMRecommendation` types (no `"use client"` — pure types).
  - Re-export from both `gemini-server.ts` and `llm-source.ts`.
  - Add a Vitest contract test: `expect JSON round-trip of a known Intent to deep-equal itself` to catch future drift.

### [C4] `buildLLMCandidates` has a missing artist-name ↔ artist-id mapping

- **Check:** 2 (contract completeness), 3 (algorithm completeness)
- **Document says:** Task 3.4: `buildLLMCandidates` flow step 1 — *"Call `getLLMRecommendations({ ..., excludeArtists: [...topArtists, ...blacklist.artistIds] })"*.
- **Reality:**
  - `topArtists` in the existing codebase is a list of artist **names** (`gemini-server.ts:48`: `topArtists.slice(0, 10).join(", ")`).
  - `blacklist.artistIds` per the profile schema is a list of **Spotify artist IDs** (e.g., `"4Z8W4fKeB5YxbusRsdQVPb"`).
  - Passing IDs to Gemini as "excluded artists" is useless — Gemini recommends by name and has no idea what `"4Z8W4fKeB5YxbusRsdQVPb"` refers to. Gemini will happily return that artist again.
- **Impact:** Blacklisted artists (the core v3 feature) **will reappear** via the LLM source, even though they're filtered later via `isArtistBlacklisted`. The symptom is wasted Gemini quota + user sees blacklisted artists briefly before they're dropped + if the later filter also fails (C5), they leak through.
- **Fix:** Profile must store `blacklist.artistNames` alongside `blacklist.artistIds`. Update `blacklistTrack` / `blacklistArtist` signatures to accept the name, persist both. Then `buildLLMCandidates` passes `[...topArtistNames, ...blacklist.artistNames]` to Gemini. Add this to Phase 1 Task 1.1 schema so Phase 3 doesn't have to retrofit.

### [C5] Streaming fan-out contract is not defined — Phase 3 breaks the v2 streaming UX

- **Check:** 2 (contract completeness), 4 (integration point verification), 10 (scale/perf), 13 (testability)
- **Document says:** Phase 3 Task 3.4: *"fan out in parallel: `[buildSpotifyCandidates(...), buildLLMCandidates(...)]` ... `Promise.allSettled` (don't let LLM failure kill Spotify path). Merge → dedup → genre gate → scoring → emit"*. Phase 7 Task 7.3: same, with Last.fm.
- **Reality:** `web/src/lib/discovery-pipeline.ts` is an `AsyncGenerator` that **yields** `BatchUpdate`s as they become available (confirmed by reading the file — `runPipelineStreaming` is the streaming pipeline). The current UX in v2 is "results appear as they're scored" — a key usability property. `Promise.allSettled([...])` collapses the three sources into a barrier: nothing emits until all three resolve. That turns a streaming UX into a blocking UX.
- **Impact:** The user stares at a spinner for potentially 30+ seconds while Gemini + Last.fm + Spotify all finish, when today they'd see results accumulate. This regresses a UX property that was called out in handoff section 3 (streaming discovery pipeline).
- **Fix:** Convert the fan-out to a merged async generator. Sketch:
  ```ts
  async function* mergeStreams(...gens: AsyncGenerator<Candidate>[]) {
    const readers = gens.map(g => g[Symbol.asyncIterator]());
    const pending = readers.map((r, i) => r.next().then(v => ({ i, v })));
    while (pending.some(p => p !== null)) {
      const { i, v } = await Promise.race(pending.filter(p => p !== null));
      if (v.done) pending[i] = null;
      else { yield v.value; pending[i] = readers[i].next().then(v => ({ i, v })); }
    }
  }
  ```
  Pipeline emits a candidate the moment **any** source produces one. Dedup maintains a persistent Set across the merged stream. Add this design to Phase 3 Task 3.4 explicitly — a two-line "Promise.allSettled" is wrong.

### [C6] Deep sampling + multi-source fan-out will blow past the 30/min ReccoBeats rate limit

- **Check:** 10 (scale & performance), 9 (failure & recovery)
- **Document says:** Phase 5 Task 5.1: *"Call `getArtistTopTracks(artistId, market="US")` → up to 10 tracks / Fetch audio features for ALL of them (batched via `/api/reccobeats`) ... cap deep sampling to top-5 per artist"*. Cross-cutting: *"ReccoBeats: 30/min/IP current. Deep sampling increases load — default to top-5 per artist"*.
- **Reality:** ReccoBeats batch size is `BATCH_SIZE = 40` (`reccobeats.ts:1`). A scan with 12 search terms × 50 artists/term = ~600 candidate artists. Deep sampling with top-5 = 3000 candidate tracks. At batch size 40, that's 75 batches = **75 calls**. Rate limit is **30 calls / 60s**. Even with the `RATE_LIMIT_MS = 2000` internal throttle (= 30/min), a single scan takes 150 seconds just for features. Add LLM candidates (another ~40) and Last.fm (~200 more artists × 5 tracks = 1000 tracks → 25 more batches) and a scan is ~4-6 minutes bottlenecked on rate limit, with 429s if the user has other tabs.
- **Impact:** User sits through multi-minute scans. "Local-only, no cost" turns into "local-only but painfully slow." The plan's "update the proxy to ≥60/min" is mentioned but not prescribed; it's the only real fix.
- **Fix:** In Phase 0 add a task: raise the proxy rate limit to **120/min per IP** in `web/src/app/api/reccobeats/route.ts:14`. The limit exists to prevent abuse of a single dev-server instance; we're the only client. Document the new limit in the file comment. Additionally: add a measured budget in Phase 5 — *"Scan must complete in ≤60s for a 171-track source. If not, investigate; do not accept a 3-minute scan."*

---

## HIGH Findings (likely runtime bug or production issue)

### [H1] `web/__tests__/` directory does not exist yet, and plan assumes a vitest config picks it up

- **Check:** 4 (integration point)
- **Document says:** All unit tests written to `web/__tests__/<name>.test.ts`.
- **Reality:** Verified via `ls` — `web/__tests__/` does not exist. No `vitest.config.ts`. Vitest default pattern is `**/*.test.ts` anywhere under the project root.
- **Fix:** In the Phase 0 vitest install task, create `web/vitest.config.ts` with `test: { include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"] }` so tests co-located OR under `__tests__/` both work. Commit the config with the install task.

### [H2] `blacklistTrack` throws when profile missing — but `AnalysisStep` uses auto-create

- **Check:** 6 (severity consistency), 9 (failure & recovery)
- **Document says:**
  - Task 1.1: *"`blacklistTrack` on missing profile throws (negative test)"* — hard throw `Error('profile not found')`.
  - Task 1.4: *"In `AnalysisStep`, ... call `loadProfile(sourcePlaylistId)` and feed `profile.blacklist` into the scan options. If no profile exists, call `createEmptyProfile` and save it."*
  - Task 1.3 Reject button: `blacklistTrack(playlistId, track.id, {...})` — called from `ResultsStep`, which assumes a profile exists because analysis just ran.
- **Reality:** Across Phases 1–8, some code paths `loadProfile → null → handle` (graceful) and other paths call `blacklistTrack` directly (throws). If a race condition or bug causes the profile to be wiped between `AnalysisStep` and a reject click, the user sees a raw error. The plan's try/catch + toast (Task 1.3 Step 3) saves the UX but muddies the contract.
- **Fix:** Pick one behavior. Recommended: `blacklistTrack` should auto-create an empty profile if missing (matches the `AnalysisStep` behavior), not throw. Delete the "throws on missing" negative test and replace it with *"blacklistTrack on missing profile creates the profile and applies the blacklist"*. Update the Task 1.1 test accordingly.

### [H3] Playwright cannot trivially mock `saveProfile` from inside the browser bundle

- **Check:** 13 (testability)
- **Document says:** Task 1.3 negative test: *"mock `saveProfile` to throw. Click ✗. Assert the UI shows an error toast"*.
- **Reality:** `saveProfile` lives in `web/src/lib/profile.ts` and is imported directly by the component. Playwright `context.route()` mocks **network**, not module-level functions. To mock `saveProfile` you'd need:
  - `addInitScript` that fills `localStorage` to quota before the test (realistic trigger); OR
  - A test-only feature flag in `profile.ts` that reads `window.__TEST_FAIL_SAVE__`; OR
  - A Vitest component test (renders component + mocks module).
- **Fix:** Change the negative test strategy: *"pre-fill localStorage to ~5MB quota. Click ✗. Browser throws `QuotaExceededError`, caught by `saveProfile`, caught again by the button's try/catch, UI shows toast."* Exercises the **real** failure path. Document the quota fill helper in the test file.

### [H4] Phase 7 proxy grep misses the actual secret value

- **Check:** 11 (security surface)
- **Document says:** *"`grep -r \"LASTFM_API_KEY\\|last.fm\" .next/static/ | grep -v \\.map | head`"*.
- **Reality:** The **name** `LASTFM_API_KEY` being in the bundle is harmless — only the **value** leaking matters. "last.fm" will match any string that mentions the domain (likely false positives from source URLs). Last.fm keys are 32-char hex — the grep should match the value pattern.
- **Fix:** Replace with:
  ```bash
  # Grep the .next/static output for any 32-char hex string that matches the actual key prefix
  node -e "const k=process.env.LASTFM_API_KEY; if(!k) process.exit(0); const p=k.slice(0,8); require('child_process').execSync(\"grep -r '\"+p+\"' .next/static/\",{stdio:'inherit'});" --env-file=.env
  # Expected: no matches (exits non-zero = grep found the key = LEAK)
  ```
  Also grep for the key value in `web/soundfox-debug.log` and the Playwright stdout logs. Never pipe the key to a shell argument — pass via env.

### [H5] Scoring scale changes silently between v2 and v3

- **Check:** 6 (severity consistency), 7 (count/metric consistency), 8 (existing code alignment)
- **Document says:**
  - Phase 4: `scoreCandidateClustered` returns `1 / (1 + distance)` — range [0, 1], **non-linear**.
  - Phase 5 `qualityThreshold` tiers: 0.40 / 0.60 / 0.75.
  - v2 `scoreCandidate` (`taste-engine.ts:112-134`) returns `0.7 * cosine + 0.3 * rangeScore` — range ≈ [0, 1] but centered near 0.5 for typical data.
- **Reality:** The same numeric threshold of 0.60 means different things in the two formulas:
  - v2 formula: 0.60 = "decent cosine match + at least moderate range fit"
  - v3 cluster formula: 0.60 = `1/(1+d) > 0.6` → `d < 0.667` in normalized Euclidean space → typically a very close centroid match. Far stricter than v2.
- **Impact:** A "Balanced" tier in v3 will produce dramatically fewer results than v2 with "balanced" setting, possibly empty. User will perceive v3 as worse unless the tiers are recalibrated.
- **Fix:** Add an explicit Phase 4 task: *"Calibrate qualityThreshold tiers against a real distribution. Run the pipeline on ISA ROCK, collect 100 candidate scores, pick percentiles: premium = 90th, balanced = 70th, inclusive = 40th. Document the calibration with a screenshot of the score histogram."* Store the calibrated values in `intent-types.ts`.

### [H6] No correlation ID — debug log is unusable at the scale v3 produces

- **Check:** Observability callout
- **Document says:** Multiple events logged to `/api/log`: `blacklist_skip`, `dedup_collapse`, `intent_parsed`, `llm_candidates`, `llm_resolved`, `deep_sampling`, `refined_vector_active`.
- **Reality:** `web/src/app/api/log/route.ts` writes each POST as a line in `web/soundfox-debug.log`. No session ID, no run ID, no playlist ID on every event (only on some). Two parallel scans (`/go` dashboard + wizard tab) produce interleaved events. After Phase 5's `deep_sampling` event fires once per artist (~600 times per scan), the log is tens of thousands of lines for a single session.
- **Fix:** Add `scanId` (a `crypto.randomUUID()`) at the start of `runPipelineStreaming` and include it on **every** log event. Add size-based truncation in `/api/log`: when `soundfox-debug.log` exceeds 10 MB, rotate to `soundfox-debug.1.log` and truncate. Document the rotation rule in the Cross-Cutting Observability section.

### [H7] Concurrency: two tabs open = profile data loss

- **Check:** Concurrency callout
- **Document says:** (nothing)
- **Reality:** `localStorage` is per-origin, not per-tab. If the user has `/wizard` open in one tab and `/go` in another and both hit the same playlist profile, last-write-wins silently loses the earlier tab's accepted/rejected changes.
- **Fix:** Add a Cross-Cutting section "Concurrency" noting: *"PlaylistProfile writes are vulnerable to multi-tab races. Mitigation: on every write, `loadProfile → modify → save`, never hold a stale in-memory profile in React state for more than one interaction. For v3 this is acceptable — user typically has one tab — but the Definition of Done includes a manual test with two tabs to confirm no corruption."*

### [H8] Deep sampling inside Last.fm source causes an audio-features explosion

- **Check:** 10 (scale), 14 (dependency coupling)
- **Document says:** Task 7.2 step 4: *"For each [similar artist], `getArtistTopTracks(id)` + apply deep sampling (Phase 5)"*.
- **Reality:** 10 seed artists × 20 similar each = 200 similar artists × 5 tracks (top-5 deep sample) = **1000 extra audio-features calls** on top of the Spotify-search 3000. Combined: ~4000 candidate tracks per scan, all needing ReccoBeats features.
- **Fix:** Cap Last.fm similar to **top-3 deep sample** (not top-5) or limit to **5 seed artists** (not 10) and **10 similar each** (not 20). Document the budget in Phase 7.2 explicitly. Link back to the ReccoBeats 120/min proxy limit from [C6].

### [H9] Intent parse is not idempotent / retriable

- **Check:** 9 (failure & recovery), 14 (idempotency)
- **Document says:** Phase 3 Task 3.1 — *"Mock `/api/intent` to 500. Assert the UI shows an error state + fallback option"*.
- **Reality:** The existing route (`web/src/app/api/intent/route.ts`) catches errors and returns 500 with `{error: msg}`. But Gemini occasionally returns malformed JSON (the code already strips markdown fences at line 80, but unknown fields / extra keys can still break `JSON.parse`). The plan's error UX is binary "error / no error" — no retry, no partial parse, no "Gemini returned garbage, try again".
- **Fix:** Wrap `parseIntent` with a two-attempt retry inside the route (regenerate with temperature=0 on second attempt). If both fail, return a **default Intent** (`purpose="general", qualityThreshold=0.6, allowKnownArtists=true`) with an `intentParseFailed: true` flag so the client can show "we couldn't parse — here's a safe default, click to edit". This preserves flow under flaky Gemini conditions without bouncing the user back to a free-text box.

---

## MEDIUM Findings (confusing but workable)

### [M1] Glossary mislabels `qualityTier` — it's `qualityThreshold` in the existing `Intent`

- **Check:** 1 (name consistency)
- **Document:** Glossary: `qualityTier: field of Intent`. Phase 5.3: `premium → 0.75, balanced → 0.60, inclusive → 0.40`.
- **Reality:** `Intent.qualityThreshold: number` in both `gemini-server.ts` and `llm-source.ts`. No `qualityTier` field.
- **Fix:** Glossary: *"`qualityTier` is a UI concept (`premium` | `balanced` | `inclusive`). It maps 1:1 to the existing `Intent.qualityThreshold: number`. The tier lives in the IntentEditor UI only; the stored value is the numeric threshold."*

### [M2] `SourceTag` — string union or array?

- **Check:** 1 (name consistency)
- **Document:** Glossary: `SourceTag | string union "spotify" | "llm" | "lastfm"`. Candidate interface: `sourceTags` (plural, array). Task 3.4: `sourceTags: ["llm"]`.
- **Fix:** Clarify the type: `sourceTags: SourceTag[]` — the plural name + array literal are consistent; the glossary should say *"`SourceTag` is a string union. Candidates carry `sourceTags: SourceTag[]` (array) because a single track can be sourced from multiple fan-out paths simultaneously (e.g., Spotify search + LLM both surface it — we preserve both tags for transparency)."*

### [M3] Node `--env-file` flag assumes Node ≥ 20.6

- **Check:** 5 (assumption verification), 14 (dependency)
- **Document:** Phase 0 Step 2 and Quick Reference use `node --env-file=.env`.
- **Reality:** Node `--env-file` landed in 20.6 (stable in 20.12 LTS). User's environment uses Node from the CLAUDE.md-referenced project paths — version not pinned.
- **Fix:** Change the presence-check one-liner to: `node -e "require('fs').existsSync('.env') ? console.log('.env SET') : process.exit(1)"` then `grep -c '^GEMINI_API_KEY=' web/.env` (compares count, not value). Avoids the Node version dependency entirely.

### [M4] Cluster labels rely on features that the public `TasteClusters` interface doesn't surface

- **Check:** 2 (contract completeness), 3 (algorithm completeness)
- **Document:** Phase 6.3: labels based on `energy`, `valence`, `acousticness`, `speechiness`. Glossary: `Cluster = { id, centroid, memberCount, label? }`. Phase 4 implementation: `Cluster = { id, centroid: Record<string, number>, memberCount }` — no label.
- **Fix:** Unify. Add `label: string` to `Cluster` in Phase 4 (not Phase 6) so the scoring/breakdown pipeline can carry it without retrofitting. Assign the label inside `buildTasteClusters`.

### [M5] Dedup timing: two-pass (pre-score + post-score) may re-emit already-emitted tracks

- **Check:** 3 (algorithm completeness), 9 (failure & recovery)
- **Document:** Phase 2 Task 2.3: *"Call `dedupCandidates` after candidates are collected from all sources and before genre gate. Call `dedupByFingerprint` after final scoring, before emit."* But with [C5] streaming, "after scoring" is per-batch, not per-scan.
- **Fix:** Maintain a persistent `emittedKeys: Set<string>` across the scan. Every yielded batch passes through `dedupCandidates` AND checks against `emittedKeys`. Add keys to `emittedKeys` as tracks are yielded. Layer-3 fingerprint dedup runs on each batch but against the persistent emitted set too.

### [M6] Phase 0 Step 4 `rm -rf web/.next` fails on Windows if dev server is running

- **Check:** 14 (side effects)
- **Fix:** Add a pre-step: *"Kill any running `next dev` process before running `rm -rf web/.next`. On Windows with EBUSY, retry after 2s or kill the locked node process via Task Manager."* Minor but a real papercut.

### [M7] Profile `schemaVersion: 1` — migration shim not placed anywhere

- **Check:** 13 (rollback)
- **Fix:** In Phase 1 Task 1.1 add one line: *"Add `migrateProfile(raw: unknown): PlaylistProfile | null` to `profile.ts`. For schemaVersion 1 it's a no-op; future bumps add transforms here. Call it from `loadProfile` right after `JSON.parse`."*

### [M8] Keyboard accessibility for ✗ Reject is noted as a "follow-up" in the reality check

- **Check:** 13 (testability)
- **Document:** Phase 1 reality check Q2: *"Is the ✗ button reachable by keyboard (tab + enter)? If not, note as UNKNOWN."*
- **Fix:** Upgrade to a requirement: the Playwright reject test must also exercise the keyboard path (`await page.keyboard.press('Tab')` to the button, `press('Enter')`). 10 seconds of test writing, avoids an a11y follow-up.

---

## Verified Claims (spot checks that passed)

| Claim | Verified by | Result |
|---|---|---|
| `allowedDevOrigins: ["127.0.0.1", "localhost"]` already set | `web/next.config.ts:4` | ✓ correct, do not duplicate |
| `/api/intent` route exists and takes `freeText + playlistContext` | `web/src/app/api/intent/route.ts` | ✓ matches plan |
| `getArtistTopTracks(id)` returns up to 10, `market=US` hardcoded | `spotify-client.ts:168-172` | ✓ matches plan assumption |
| `SpotifyTrack.popularity: number` (not nullable) | `spotify-client.ts:71-77` | ✓ dedup popularity tiebreaker works |
| Discovery pipeline is an AsyncGenerator yielding `BatchUpdate` | `discovery-pipeline.ts:56-87` | ✓ — matches plan context |
| ReccoBeats proxy rate limit = 30/min/IP | `web/src/app/api/reccobeats/route.ts:13` | ✓ — and see [C6] for scaling fix |
| `storage.ts` already has `"use client"` at the top | `storage.ts:1` | ✓ — primer rule already applied |

## Architecture Health Scorecard

| Area | Status | Notes |
|---|---|---|
| Failure handling | **GAPS** — [H2], [H9]. Some paths throw, others auto-create. Intent parse has no retry. |
| Scale readiness | **RISK at current scale** — [C6], [H8]. Without the proxy lift, v3 scans will be 3–5 minutes. |
| Security surface | **MOSTLY CLEAN** — [H4] is a grep fix only. Primary surface (no secret leaks, server-only API keys) is correct. |
| Antipatterns found | `Promise.allSettled` used as a streaming fan-out ([C5]) — a barrier where a merge stream is needed. No God Function. No Silent Swallow (all errors toasted). |
| Rollback plan | **WORKABLE** — [M7] adds the single missing piece (migration shim location). `localStorage` persists across reverts is called out. |
| Idempotency | **SAFE for writes** (profile writes are CRUD-style). **UNSAFE for intent parse** ([H9]) — fix with retry. |
| Observability | **NEEDS [H6]** — add scanId + log rotation. |
| Concurrency | **DOCUMENTED RISK** ([H7]) — single-user local app is fine; multi-tab is user error with soft consequences. |

## Cross-Check Correlations Applied

- [C5] (streaming fan-out antipattern) × Check 10 → [C6] (scale impact): confirmed — `Promise.allSettled` both breaks UX AND exceeds rate limits simultaneously.
- [C4] (missing name↔id mapping) × Check 9 (failure): confirmed — blacklist leak is a silent data-integrity bug, not a loud error.
- [H9] (no retry on intent parse) × Check 14 (idempotency): idempotent retry is safe because Gemini intent parse is a pure function over `(freeText, context)` — add retry.
- [C1] (no vitest) × Check 13 (testability): gates the entire Phase 1 TDD workflow — must fix in Phase 0.

## Verdict

- [ ] **READY**
- [x] **NEEDS FIXES** — 6 CRITICAL + 9 HIGH. All fixes are additive (test-runner install, type tightening, interface consolidation, streaming-merge rewrite in Phase 3, proxy rate-limit lift, calibration task, name↔id mapping, retry logic, observability tweaks). Estimated 30–60 minutes of plan editing. **No architecture rethink required** — the multi-source + per-playlist-profile + multi-cluster design is sound; the plan just under-specifies the edges.
- [ ] **NEEDS RETHINK**

**Recommended next step:** apply the fixes listed under CRITICAL and HIGH to the plan, then re-run `plan-qa` once more as a regression check, then run `review-plan` for a second-opinion pass.
