"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

export default function SyncTokensPage(): ReactElement {
  const [status, setStatus] = useState<"syncing" | "ok" | "error" | "no-tokens">("syncing");

  useEffect(() => {
    const accessToken = localStorage.getItem("soundfox_access_token");
    const refreshToken = localStorage.getItem("soundfox_refresh_token");
    const expiry = localStorage.getItem("soundfox_token_expiry");
    const clientId = localStorage.getItem("soundfox_client_id");

    if (!accessToken || !clientId) {
      setStatus("no-tokens");
      return;
    }

    fetch("/api/sync-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken, refresh_token: refreshToken, expiry: expiry ?? undefined, client_id: clientId }),
    })
      .then((r) => (r.ok ? setStatus("ok") : setStatus("error")))
      .catch(() => setStatus("error"));
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        {status === "syncing" && (
          <>
            <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-[var(--text-secondary)]">Syncing tokens…</p>
          </>
        )}
        {status === "ok" && (
          <>
            <p className="text-4xl">✓</p>
            <p className="text-green-400 font-semibold">Tokens synced to .env</p>
            <p className="text-[var(--text-secondary)] text-sm">Claude can now run real pipeline tests.</p>
          </>
        )}
        {status === "no-tokens" && (
          <>
            <p className="text-4xl">⚠</p>
            <p className="text-yellow-400 font-semibold">No tokens found</p>
            <p className="text-[var(--text-secondary)] text-sm">Log in to Spotify via the app first, then come back here.</p>
          </>
        )}
        {status === "error" && (
          <>
            <p className="text-4xl">✗</p>
            <p className="text-red-400 font-semibold">Sync failed</p>
          </>
        )}
      </div>
    </main>
  );
}
