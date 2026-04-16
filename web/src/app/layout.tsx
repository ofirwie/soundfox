import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoundFox - Discover Music Your Way",
  description: "Open source playlist analyzer and music discovery engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] antialiased">
        {children}
      </body>
    </html>
  );
}
