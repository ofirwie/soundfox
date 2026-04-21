# SoundFox v3 — Full Context Handoff

**Purpose:** Complete context dump for a new session to write the implementation plan for SoundFox v3.
**Date:** 2026-04-21
**Status:** v2 shipped. v3 designed, partial backend (Gemini) started.

---

## 1. Project Context

**Location:** `C:\Users\fires\OneDrive\Git\spotify-recommendation`
**GitHub:** https://github.com/ofirwie/soundfox (public)
**Stack:**
- `web/` — Next.js **16.2.4** + React **19.2.4** + TypeScript (strict) + Tailwind CSS v4
- **CRITICAL**: Next 16 + React 19.2 have breaking changes from training data. Read `web/AGENTS.md` + `node_modules/next/dist/docs/` before writing code.
- Runs **locally only** (127.0.0.1:3000). User wants no hosted/shared service.
- Original Python prototype in `src/` (kept for history, not actively used)

**Project rules:** `.claude/primer.md` contains all lessons learned.

---

## 2. User Profile & Preferences

- **Owner:** Ofir Wienerman (GitHub owner — personal info now scrubbed from git history)
- **Communication:** User writes Hebrew, I respond English (code/commits English).
- **Personality:** Direct, impatient with inefficiency, angry when I ask for info I could fetch myself, values working tools over promises.
- **Listening habits:** 10,000+ songs/year — won't accept mainstream/cliché recommendations.
- **Test playlists:** ISA ROCK (~171 tracks, rock genre), Night rock (1367 tracks, rock/grunge/metal).

### Lessons from user feedback (MUST FOLLOW):
1. **Never ask user to do work I can do myself** (read DevTools, copy logs, paste JSON) — I have Playwright, I have file access, I have Gemini API.
2. **Verify visually before claiming done** — Playwright screenshots are mandatory for UI claims.
3. **Reality-check before every "done" claim** — run /reality-check skill, answer adversarial questions honestly.
4. **Respect per-playlist context** — a workout playlist is fundamentally different from a discovery playlist.
5. **Stop recommending rejected tracks** — persistent blacklist across runs (not just per session).
6. **Tool must be generic** — handle workout, cover band, wedding, memorial, focus — not hardcoded purposes.
7. **Use multiple sources** — one-source recommender is blind.

---

## 3. Current State (what exists in v2)

### Working features
- Next.js wizard UI (6 steps: Setup → Connect → Choose → Scan Options → Analyze → Results)
- `/go` dashboard (direct-access page for returning users)
- Spotify OAuth PKCE flow with refresh token support
- `allowedDevOrigins: ["127.0.0.1", "localhost"]` in next.config.ts (CRITICAL — without this, React never hydrates in dev)
- ReccoBeats audio features via local API proxy (`/api/reccobeats`)
- Streaming discovery pipeline (AsyncGenerator yielding BatchUpdates)
- Dual-gate scoring: genre overlap + cosine similarity on audio features
- 1000 result capacity with pagination, sort, filter
- Bidirectional checkbox (✓ add to Spotify / uncheck = remove)
- Destination toggle: new playlist / add to source playlist
- Resume support via localStorage scan state
- Recently-analyzed playlists shown first on picker
- Dynamic genre extraction from playlist (not hardcoded)
- `Gemini` backend endpoints (v3 partial): `/api/intent` + `/api/llm-recommend`

### Critical bugs fixed in v2
- React Strict Mode abort killing pipeline (removed useEffect cleanup abort)
- CORS proxy for ReccoBeats
- Spotify rate limit throttle + 429 retry with exponential backoff
- Token refresh race condition (refresh lock singleton)
- Hydration mismatches in SetupStep/ScanOptionsStep (localStorage reads moved to useEffect)
- `"use client"` added to `storage.ts`
- React type imports (`ReactElement`, `ReactNode` named — not `React.*`)
- `images: null` crash in PlaylistStep (Spotify returns null, not empty array)
- Next.js 16 Suspense boundary required for `useSearchParams`

### Key files
| File | Purpose |
|---|---|
| `web/src/lib/discovery-pipeline.ts` | Main streaming pipeline, `runPipelineStreaming` async generator |
| `web/src/lib/spotify-client.ts` | Spotify API client with throttle/retry (includes `getPlaylistTracksDetailed` that reports local/unavailable/episode counts) |
| `web/src/lib/reccobeats.ts` | ReccoBeats audio features client (via /api/reccobeats proxy) |
| `web/src/lib/taste-engine.ts` | TasteVector, buildTasteVector, cosineSimilarity, scoreCandidate |
| `web/src/lib/storage.ts` | localStorage for Client ID, tokens, scan state, history, target playlist, last options |
| `web/src/lib/spotify-auth.ts` | PKCE flow + refresh lock |
| `web/src/lib/gemini-server.ts` | **v3** — server-side Gemini integration (parseIntent, generateRecommendations) |
| `web/src/lib/llm-source.ts` | **v3** — client wrapper + Spotify resolver for LLM recs |
| `web/src/components/AnalysisStep.tsx` | Streaming analysis UI, `/api/log` diagnostics writer |
| `web/src/components/ResultsStep.tsx` | 1000-row pagination, sort, filter, live add/remove, destination toggle |
| `web/src/components/PlaylistStep.tsx` | Grid with "Recently analyzed" section |
| `web/src/components/ScanOptionsStep.tsx` | allowKnownArtists, minYear, resultCount sliders, Quick Start button |
| `web/src/app/api/reccobeats/route.ts` | CORS proxy with in-memory rate limit (30/min/IP) |
| `web/src/app/api/log/route.ts` | Debug log writer (appends to `web/soundfox-debug.log`) |
| `web/src/app/api/intent/route.ts` | **v3** — Gemini intent parser endpoint |
| `web/src/app/api/llm-recommend/route.ts` | **v3** — Gemini recommendation endpoint |
| `web/src/app/go/page.tsx` | Dashboard for returning users (skip wizard) |
| `web/src/app/wizard/page.tsx` | 6-step wizard |

### Environment
- `web/.env` (gitignored) contains:
  - `SPOTIPY_CLIENT_ID` (used for Python — not used by web yet)
  - `GEMINI_API_KEY` (v3 — server-side only)
  - `GEMINI_MODEL` (e.g., `gemini-3.1-pro-preview`)
- Spotify Client ID is entered by user in wizard UI, stored in localStorage.
- **CRITICAL:** User rotated Spotify Client ID. Must use `127.0.0.1:3000/callback` redirect URI (Spotify rejects `localhost`).

---

## 4. Known Remaining Issues (v2 → v3 gaps)

### User-reported pain points (from Apr 21 session)
1. **Recommendations are bad** — user dipped 10 tracks from ISA ROCK, all garbage.
2. **Duplicates in results** — same song appears twice (single/album/remaster versions).
3. **No purpose awareness** — can't tell system "this is workout" vs "this is discovery".
4. **Rejected tracks come back** — no memory across runs (worse than Spotify algorithm).
5. **No explanation** — user can't see why a track was recommended.
6. **Single-source blind spot** — only Spotify search, ignoring LLM knowledge, Last.fm similarity, YouTube Music.
7. **Generic tool needed** — not just workout preset, must handle ANY use (gigs, weddings, memorial, cover band, focus, etc.).

### Algorithm problems diagnosed (but not yet fixed)
1. **Averaged taste vector** over 171 tracks is meaningless (energy avg 0.65 = mushy middle, any bland song scores high).
2. **Generic search terms** ("rock") return thousands of wrong-genre artists.
3. **Weak genre gate** — only 2 overlaps required, allows pop artists tagged "rock".
4. **Top-track bias** — always picks artist's most popular song (usually the commercial hit).
5. **Audio features don't encode style** — Bruno Mars & Foo Fighters can have similar energy/valence.
6. **No quality threshold** — returns Top 50 even if scores are all <50%.

---

## 5. v3 Design — Finalized Decisions

### 5.1 Multi-source architecture
Pipeline accepts candidates from MULTIPLE sources in parallel:

| Source | Purpose | Status |
|---|---|---|
| Spotify search (existing) | Catalog fallback | ✓ in v2 |
| Last.fm similar-artists API | Similarity based on real listening patterns | Planned |
| **LLM (Gemini)** | Semantic understanding, generate specific track recs | Backend done, not integrated |
| YouTube Music (via `ytmusicapi`) | User has account, different catalog | Optional v4 |
| Purpose-specific sources | Workout: Peloton/Strava public playlists, BPM charts; Cover: Billboard rock history | TBD |

### 5.2 Intent-driven design (NOT hardcoded purposes)
- User types free text: *"רוצה שירים לאימון כושר בוקר, BPM גבוה, חדש לי"*
- `/api/intent` (Gemini) parses to structured Intent:
  ```ts
  {
    purpose: "workout",
    audioConstraints: { tempoMin, tempoMax, energyMin, energyMax, valenceMin, valenceMax, popularityHint },
    genres: { include: [...], exclude: [...] },
    era: "1990-2010" | null,
    requirements: ["singable chorus", "driving beat"],
    allowKnownArtists: boolean,
    qualityThreshold: 0-1,
    notes: string
  }
  ```
- User can tweak parsed Intent before scan.
- Intent saved **per-playlist** in localStorage so re-runs don't re-ask.

### 5.3 Per-playlist profile (ask once, remember)
Stored in localStorage keyed by `playlistId`:
```ts
{
  intent: Intent,                  // last parsed intent
  intentText: string,              // original free text
  blacklist: {
    trackIds: Set<string>,         // never show again
    artistIds: Set<string>,        // reject artist if 2+ tracks rejected
    genres: Set<string>,           // low priority if 3+ rejected
  },
  accepted: {
    trackIds: Set<string>,
    refinedTasteVector: TasteVector | null,  // computed from accepted only (once ≥20)
  },
  stats: {
    runsCount, acceptedCount, rejectedCount, lastRunAt,
  }
}
```

### 5.4 Feedback loop — 3 actions per track
On every result row:
- **✓ Add** → Spotify add + mark accepted
- **✗ Reject** → Permanent blacklist for this playlist
- **Skip** (no action) → neutral

### 5.5 Cross-run learning
Each scan:
1. Apply blacklist BEFORE search (skip blacklisted artists/genres)
2. Use refined taste vector (from accepted) if ≥20 accepted tracks, else averaged
3. Reduce weight of genres with high rejection rate
4. Spotify never learns — SoundFox does.

### 5.6 Multi-cluster taste vector (solves mushy-middle problem)
- Run k-means on the 9 audio features across all playlist tracks (k=3-5 auto)
- Each candidate scored against NEAREST cluster, not averaged mean
- Example: playlist has mellow cluster (low energy + acoustic) + heavy cluster (high energy). A heavy candidate scores against heavy cluster; a mellow candidate scores against mellow cluster. Neither fights the mid-point.

### 5.7 Per-track "Why this" panel
Expandable on each row:
```
Score: 78%
├─ Audio match: 82% (closest to "heavy" cluster)
│  ├─ Energy 0.81 (cluster avg 0.85) ✓
│  ├─ Valence 0.29 (cluster avg 0.32) ✓
│  └─ Tempo 128 (cluster avg 130) ✓
├─ Genre match: 3/5 (grunge, post-grunge, hard rock)
├─ LLM reason: "Audioslave Cochise has Chris Cornell vocals..."
├─ Not blacklisted ✓
└─ Source: Gemini + Spotify search
```

### 5.8 Strong dedup
Dedupe by layered keys:
1. Spotify track ID
2. Normalized `track_name + first_artist_name` (lowercase, strip "remastered", "live", "version", "feat.", etc.)
3. Audio fingerprint (duration+tempo+energy within ε) — last resort
Keep the most popular variant when duplicates detected.

### 5.9 Quality threshold
Configurable per intent (`intent.qualityThreshold`):
- Premium (>75%): strict — fewer but great matches
- Balanced (>60%): default
- Inclusive (>40%): broad exploration
Results below threshold are filtered OUT, not shown.

### 5.10 Strict genre match
Require ≥3 genre overlaps AND at least one specific sub-genre (not generic "rock"/"metal"/"pop").

### 5.11 Deep track sampling
Instead of always taking artist's top track:
- Get artist's top 10 tracks
- Score ALL 10 against taste vector
- Pick the best-matching one

### 5.12 UX flow
```
1. Pick playlist (show recently analyzed first)
   ↓
2. [If first time for this playlist] Ask intent (free text box)
   [If returning] Show last intent, offer "Run again" or "Change intent"
   ↓
3. Parsed Intent displayed — user can tweak filters before scan
   ↓
4. Analysis screen (streaming progress, 'Stop' button)
   ↓
5. Results:
   - Pagination: 50/page
   - Sort: Score | Popularity | Year | Random
   - Filter: text search, genre chips, follower range
   - Per-track "Why" expandable
   - 3 actions: ✓ ✗ Skip
   - Destination toggle: New playlist | Add to source
   - Live persistent badge: "47 added to [name]"
```

---

## 6. Critical Technical Details

### Tools I have available
- **Playwright** with chromium — can drive the UI, capture screenshots, mock APIs, read localStorage
- **`level` npm package** — can read Chrome/Edge leveldb for localStorage values (when browser isn't locking it)
- **`@google/generative-ai`** — Gemini SDK, in `web/` dependencies
- **Gemini API** (via server-side only in /api/intent and /api/llm-recommend)
- **`/api/log`** — writes to `web/soundfox-debug.log`, which I can read for diagnostics

### Testing pattern proven to work
```js
// web/test-*.mjs — Playwright test with:
// 1. addInitScript to inject localStorage tokens
// 2. context.route to mock Spotify API responses
// 3. Click through UI, take screenshot
// 4. Assert on bodyText contents + check /api/log file after
```

### Security rules (MANDATORY)
1. **NEVER print token/key values** in conversation — transcripts persist
2. **All secrets in `.env`** (web/.env and root .env, both gitignored)
3. **Never hardcode** client IDs or keys in source files (use placeholders in tests)
4. **Verify .env is gitignored** with `git check-ignore` before adding secrets
5. **Git history scrubbing**: if a secret leaks, use `git filter-repo --replace-text` + force-push
6. **Commit author**: all commits anonymized to `SoundFox Dev <dev@soundfox.local>`

### Spotify API reality (BOTH deprecated for new apps)
- `/audio-features/{id}` — **deprecated** for new apps → use **ReccoBeats** as replacement
- `/recommendations` — **deprecated** for new apps → build our own via search + LLM
- `/related-artists` — **deprecated** for new apps → use Last.fm or LLM instead
- What still works: `/search` (type=artist with market=US, no `genre:` prefix), `/artists`, `/artists/{id}/top-tracks?market=US`, `/playlists/{id}/tracks`, playlist CRUD, `/me`
- Spotify rejects `localhost` redirect URIs; use `127.0.0.1`

### Build constraints
- `npm run build` MUST pass cleanly (zero TS errors) after every batch
- In dev mode (Turbopack), clean `.next/` when behavior is mysterious
- Build in prod (`npm run build && npm run start`) to rule out dev-mode quirks

---

## 7. What's NOT decided yet (for next session)

1. **Last.fm API key** — needs registration (free). Who does it?
2. **YouTube Music** — worth the complexity of `ytmusicapi` or skip?
3. **Learning mechanism timing**: re-weight after every run? Continuous? Manual "apply learnings"?
4. **Refined taste vector trigger**: 20 accepted tracks? 10? User-configurable?
5. **Cluster count (k for k-means)**: auto-detect via elbow method? Fixed at 3?
6. **Intent editing UI**: raw JSON textbox? Structured form? Chips for genres?
7. **Sources priority**: when Spotify search + LLM + Last.fm all return candidates, how to merge/de-dup?
8. **Rate limit budgets**: Gemini free tier is limited. Cache intent parses?
9. **LLM model version**: currently using `gemini-3.1-pro-preview`. Too expensive for production? Use 1.5 flash for intent, pro for recommendations?
10. **Migration path**: existing users have no per-playlist profile. Auto-create on first run? Ask on next run?

---

## 8. Plan Writing Prompt (for next session)

```
Write an implementation plan for SoundFox v3 at:
C:\Users\fires\OneDrive\Git\spotify-recommendation\docs\plans\2026-04-21-soundfox-v3-intent-learning.md

Context:
- Read docs/handoff/2026-04-21-soundfox-v3-full-context.md completely.
- Read .claude/primer.md for project rules.
- Read web/AGENTS.md for Next.js 16 warnings.

Constraints:
- 100% local (no hosted services).
- User is 10,000-songs/year listener, won't accept mediocre recommendations.
- Secrets only in web/.env (gitignored). Never print values.
- Every claim of "done" requires Playwright verification + screenshot.
- Use Gemini via existing /api/intent and /api/llm-recommend endpoints.

Must include:
- Multi-source candidate pipeline (Spotify + LLM + Last.fm + maybe purpose-specific)
- Intent-driven architecture (free text → structured Intent via Gemini)
- Per-playlist profile in localStorage (intent, blacklist, accepted, stats)
- Blacklist applied BEFORE search (never show rejected)
- Refined taste vector from accepted tracks (once ≥20)
- Multi-cluster taste vector (k-means on 9 audio features)
- Strong dedup (ID + normalized name + fingerprint)
- Quality threshold (configurable)
- Deep track sampling (score multiple tracks per artist, pick best)
- Per-track "Why" expandable panel
- Three-action feedback (✓/✗/Skip) per track
- UI flow: Pick playlist → Intent (if first time) → Intent edit → Scan → Results

Plan structure:
- Phase 1: Per-playlist profile storage + blacklist enforcement
- Phase 2: Strong dedup
- Phase 3: Intent UI + Gemini integration into pipeline
- Phase 4: Multi-cluster taste vector
- Phase 5: Deep track sampling + quality threshold
- Phase 6: "Why this" panel per track
- Phase 7: Last.fm source
- Phase 8: Learning (refined taste vector + genre re-weighting)

Run plan-qa + review-plan skills after writing.
```

---

## 9. Quick Reference — Current test/debug tools

```bash
# Run dev
cd web && npm run dev

# Run Playwright E2E test
cd web && node test-full-flow.mjs

# Test Gemini intent parser
curl -X POST -H "Content-Type: application/json" \
  -d '{"freeText":"...","playlistContext":{"name":"X","topArtists":[...],"topGenres":[...],"trackCount":100}}' \
  http://127.0.0.1:3000/api/intent

# Test Gemini recommendations
curl -X POST -H "Content-Type: application/json" \
  -d '{"intent":{...},"tasteVector":{...},"topArtists":[...],"count":10,"excludeArtists":[...]}' \
  http://127.0.0.1:3000/api/llm-recommend

# Read pipeline debug log
cat web/soundfox-debug.log

# Extract user's real Spotify tokens from Edge (if needed for Playwright tests)
# Edge profile: C:/Users/fires/AppData/Local/Microsoft/Edge/User Data/Default/Local Storage/leveldb
# Use `level` npm package; LOCK file must be removed from copy.
```

---

## 10. Open blockers / gotchas

- **Gemini API key rotation**: user was warned the key was accidentally printed to transcript once. If they haven't rotated, transcript leakage risk.
- **User's OLD Spotify Client ID** (`e17b3b51...`) was revoked when they rotated. Must use current one.
- **Turbopack cache**: if behavior is weird, `rm -rf web/.next` and restart.
- **React Strict Mode**: double-mount behavior in dev. Never `abort()` on useEffect cleanup unless you use local closure (not ref).
- **`images: null`** from Spotify: always defensive-check array. Type is `Array<{url}> | null`.
- **`allowedDevOrigins`** in next.config.ts is MANDATORY for 127.0.0.1 access (otherwise hydration silently fails).
- **Commit warning**: leftover debug files (screenshots, test logs) — clean before committing. `web/soundfox-debug.log` is now gitignored.
