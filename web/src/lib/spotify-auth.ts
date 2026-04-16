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
