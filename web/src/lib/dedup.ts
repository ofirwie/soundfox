import type { ScoredTrack } from "./pipeline/types";

const NOISE_PATTERNS = [
  /\s*-\s*remaster(ed)?(\s*\d{4})?$/i,
  /\s*-\s*\d{4}\s*remaster(ed)?$/i,
  /\s*\(remaster(ed)?(\s*\d{4})?\)/i,
  /\s*\(live(\s+at[^)]*)?\)/i,
  /\s*-\s*live(\s+at.*)?$/i,
  /\s*\(\d{4}\s*remix\)/i,
  /\s*\(feat\.?[^)]*\)/i,
  /\s*\(.*version[^)]*\)/i,
  /\s*\(deluxe[^)]*\)/i,
  /\s*\(radio edit\)/i,
];

export function normalizeTrackName(name: string): string {
  let n = name.trim();
  for (const pat of NOISE_PATTERNS) {
    n = n.replace(pat, "");
  }
  return n.trim().toLowerCase();
}

/** Layer-2 key: `<normalized artist>|||<normalized track>` */
export function buildDedupKey(artistName: string, trackName: string): string {
  return `${artistName.trim().toLowerCase()}|||${normalizeTrackName(trackName)}`;
}

/**
 * Three-layer dedup:
 * 1. Same Spotify ID → exact duplicate
 * 2. Same normalized (track name + primary artist) → remaster/live/version variants
 *    (only deduplicates if the primary artist is the same; different artists are NOT collapsed)
 * 3. (layer 3 — audio fingerprint) deferred to Phase 6 when audio features are available
 *
 * When two entries collapse, the one with higher popularity wins.
 */
export function dedupCandidates(candidates: ScoredTrack[]): ScoredTrack[] {
  const byId = new Map<string, ScoredTrack>();
  const byKey = new Map<string, ScoredTrack>();

  for (const item of candidates) {
    const id = item.track.id;
    const primaryArtist = item.track.artists[0]?.name ?? "";
    const key = buildDedupKey(primaryArtist, item.track.name);

    // Layer 1: same Spotify ID
    if (byId.has(id)) {
      const existing = byId.get(id)!;
      if (item.track.popularity > existing.track.popularity) {
        byId.set(id, item);
        if (byKey.has(key)) byKey.set(key, item);
      }
      continue;
    }

    // Layer 2: same normalized name + primary artist
    if (byKey.has(key)) {
      const existing = byKey.get(key)!;
      if (item.track.popularity > existing.track.popularity) {
        // Replace the lower-popularity duplicate; remove old ID entry
        byId.delete(existing.track.id);
        byId.set(id, item);
        byKey.set(key, item);
      }
      continue;
    }

    byId.set(id, item);
    byKey.set(key, item);
  }

  return [...byKey.values()];
}
