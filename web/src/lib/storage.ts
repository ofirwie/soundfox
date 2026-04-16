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
