// ─── Key registry ─────────────────────────────────────────────────────────────

const KEYS = {
  CLIENT_ID: "soundfox_client_id",
  ACCESS_TOKEN: "soundfox_access_token",
  REFRESH_TOKEN: "soundfox_refresh_token",
  TOKEN_EXPIRY: "soundfox_token_expiry",
  CODE_VERIFIER: "soundfox_code_verifier",
  HISTORY: "soundfox_history",
  SCAN_STATE: "soundfox_scan_state",         // v2: resume support
  TARGET_PLAYLIST: "soundfox_target_pl",     // v2: last-used destination playlist
  LAST_SCAN_OPTIONS: "soundfox_last_options", // v2: remember last options for quick re-run
} as const;

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function getClientId(): string | null {
  return localStorage.getItem(KEYS.CLIENT_ID);
}

export function setClientId(id: string): void {
  localStorage.setItem(KEYS.CLIENT_ID, id);
}

export function getAccessToken(): string | null {
  const expiry = localStorage.getItem(KEYS.TOKEN_EXPIRY);
  if (expiry && Date.now() > parseInt(expiry, 10)) return null;
  return localStorage.getItem(KEYS.ACCESS_TOKEN);
}

export function setTokens(accessToken: string, expiresIn: number, refreshToken?: string): void {
  localStorage.setItem(KEYS.ACCESS_TOKEN, accessToken);
  localStorage.setItem(KEYS.TOKEN_EXPIRY, String(Date.now() + expiresIn * 1000));
  if (refreshToken) localStorage.setItem(KEYS.REFRESH_TOKEN, refreshToken);
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

// ─── Analysis history ─────────────────────────────────────────────────────────

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
  return raw ? (JSON.parse(raw) as AnalysisRecord[]) : [];
}

export function saveAnalysis(record: AnalysisRecord): void {
  const history = getHistory();
  history.unshift(record);
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(history.slice(0, 20)));
}

// ─── Scan state (v2 resume support) ──────────────────────────────────────────

import type { ScoredTrack, ScanOptions } from "./discovery-pipeline";

export interface ScanState {
  /** Source playlist being analyzed — named sourcePlaylist* to distinguish from target [C2] */
  sourcePlaylistId: string;
  sourcePlaylistName: string;
  /** Options used for this scan */
  scanOptions: ScanOptions;
  /** All scored tracks accumulated so far */
  allResults: ScoredTrack[];
  /** Destination playlist if one was created/selected during this scan */
  targetPlaylistId: string | null;
  targetPlaylistName: string | null;
  /** ISO timestamp — used to show "X minutes ago" in resume prompt */
  savedAt: string;
}

export function saveScanState(state: ScanState): void {
  try {
    localStorage.setItem(KEYS.SCAN_STATE, JSON.stringify(state));
  } catch {
    // Quota exceeded — silently skip (scan still works, just no resume)
  }
}

export function loadScanState(): ScanState | null {
  const raw = localStorage.getItem(KEYS.SCAN_STATE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanState;
  } catch {
    return null;
  }
}

export function clearScanState(): void {
  localStorage.removeItem(KEYS.SCAN_STATE);
}

// ─── Target playlist memory (v2) ─────────────────────────────────────────────

export interface SavedTargetPlaylist {
  id: string;
  name: string;
}

export function saveTargetPlaylist(id: string, name: string): void {
  localStorage.setItem(KEYS.TARGET_PLAYLIST, JSON.stringify({ id, name }));
}

export function loadTargetPlaylist(): SavedTargetPlaylist | null {
  const raw = localStorage.getItem(KEYS.TARGET_PLAYLIST);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedTargetPlaylist;
  } catch {
    return null;
  }
}

// ─── Last scan options memory (v2) — skip scan options step on re-run ────────

export function saveLastScanOptions(options: ScanOptions): void {
  try {
    localStorage.setItem(KEYS.LAST_SCAN_OPTIONS, JSON.stringify(options));
  } catch {
    // Quota exceeded — silently skip
  }
}

export function loadLastScanOptions(): ScanOptions | null {
  const raw = localStorage.getItem(KEYS.LAST_SCAN_OPTIONS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ScanOptions;
  } catch {
    return null;
  }
}

// ─── Recent playlists — quick re-select last analyzed ────────────────────────

export function getRecentPlaylistIds(): string[] {
  const history = getHistory();
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const record of history) {
    if (!seen.has(record.playlistId)) {
      seen.add(record.playlistId);
      ids.push(record.playlistId);
    }
    if (ids.length >= 5) break;
  }
  return ids;
}
