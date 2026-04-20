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
