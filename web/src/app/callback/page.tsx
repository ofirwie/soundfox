"use client";

import { Suspense, useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { handleCallback } from "@/lib/spotify-auth";

function CallbackHandler(): ReactElement {
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

export default function CallbackPage(): ReactElement {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center"><p>Loading...</p></main>}>
      <CallbackHandler />
    </Suspense>
  );
}
