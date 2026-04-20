"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getClientId, getAccessToken } from "@/lib/storage";

export default function Home(): ReactElement {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Returning user with valid auth → skip straight to app
    if (getClientId() && getAccessToken()) {
      router.replace("/go");
      return;
    }
    setChecking(false);
  }, [router]);

  if (checking) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8 gap-8">
      <div className="text-center">
        <h1 className="text-6xl font-bold mb-4">SoundFox</h1>
        <p className="text-[var(--text-secondary)] text-xl max-w-lg">
          Discover new music based on what you actually listen to.
          Analyzes your playlist&apos;s audio DNA and finds hidden gems that match.
        </p>
      </div>
      <Link
        href="/wizard"
        className="px-8 py-4 bg-[var(--accent)] hover:bg-[var(--accent-hover)]
                   rounded-full font-semibold text-lg transition-colors"
      >
        Get Started
      </Link>
      <p className="text-[var(--text-secondary)] text-sm">
        Open source &middot; No server &middot; Your data stays local
      </p>
    </main>
  );
}
