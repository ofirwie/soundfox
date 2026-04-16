import Link from "next/link";

export default function Home(): React.ReactElement {
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
