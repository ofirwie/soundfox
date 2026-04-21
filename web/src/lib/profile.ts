"use client";

import type { TasteVector } from "./taste-engine";
import type { TasteClusters } from "./clustering";
import type { Intent } from "./intent-types";
import type { AudioFeatures } from "./reccobeats";

export interface BlacklistEntry {
  trackIds: string[];
  artistIds: string[];
  /** fix-C4: Gemini recommends by NAME, not Spotify ID — we must pass names as excludeArtists */
  artistNames: string[];
  genres: string[];
  rejectionsByArtist: Record<string, number>;
  /** Phase 8: genre-level rejection counts for re-weighting */
  rejectionsByGenre: Record<string, number>;
  /** Phase 8: genre-level acceptance counts for weight calc */
  acceptancesByGenre: Record<string, number>;
}

export interface PlaylistProfile {
  playlistId: string;
  intent: Intent | null;
  intentText: string;
  blacklist: BlacklistEntry;
  accepted: { trackIds: string[]; refinedTasteVector: TasteVector | null };
  stats: { runsCount: number; acceptedCount: number; rejectedCount: number; lastRunAt: string | null };
  schemaVersion: 1;
}

const KEY_PREFIX = "soundfox_profile_";
const AUTO_BLACKLIST_ARTIST_THRESHOLD = 2;
const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyProfile(playlistId: string): PlaylistProfile {
  return {
    playlistId, intent: null, intentText: "",
    blacklist: { trackIds: [], artistIds: [], artistNames: [], genres: [], rejectionsByArtist: {}, rejectionsByGenre: {}, acceptancesByGenre: {} },
    accepted: { trackIds: [], refinedTasteVector: null },
    stats: { runsCount: 0, acceptedCount: 0, rejectedCount: 0, lastRunAt: null },
    schemaVersion: 1,
  };
}

function ensureGenreFields(profile: PlaylistProfile): void {
  if (!profile.blacklist.rejectionsByGenre) profile.blacklist.rejectionsByGenre = {};
  if (!profile.blacklist.acceptancesByGenre) profile.blacklist.acceptancesByGenre = {};
}

/** fix-M7: future schema bumps add transforms here. Today it only validates. */
export function migrateProfile(raw: unknown): PlaylistProfile | null {
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<PlaylistProfile>;
  if (r.schemaVersion !== CURRENT_SCHEMA_VERSION) return null;
  if (typeof r.playlistId !== "string") return null;
  return r as PlaylistProfile;
}

export function loadProfile(playlistId: string): PlaylistProfile | null {
  const raw = localStorage.getItem(KEY_PREFIX + playlistId);
  if (!raw) return null;
  return migrateProfile(raw);
}

export function saveProfile(profile: PlaylistProfile): void {
  try { localStorage.setItem(KEY_PREFIX + profile.playlistId, JSON.stringify(profile)); }
  catch { /* fix-H3: quota — silently skip. UI layer handles visible feedback. */ }
}

/** fix-H2: auto-creates a profile if one doesn't exist. Never throws. */
export function blacklistTrack(
  playlistId: string,
  trackId: string,
  opts?: { artistId?: string; artistName?: string; genres?: string[] },
): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  ensureGenreFields(profile);
  if (!profile.blacklist.trackIds.includes(trackId)) profile.blacklist.trackIds.push(trackId);
  if (opts?.artistId) {
    const count = (profile.blacklist.rejectionsByArtist[opts.artistId] ?? 0) + 1;
    profile.blacklist.rejectionsByArtist[opts.artistId] = count;
    if (count >= AUTO_BLACKLIST_ARTIST_THRESHOLD && !profile.blacklist.artistIds.includes(opts.artistId)) {
      profile.blacklist.artistIds.push(opts.artistId);
      if (opts.artistName && !profile.blacklist.artistNames.includes(opts.artistName)) {
        profile.blacklist.artistNames.push(opts.artistName);
      }
    }
  }
  for (const genre of opts?.genres ?? []) {
    profile.blacklist.rejectionsByGenre[genre] = (profile.blacklist.rejectionsByGenre[genre] ?? 0) + 1;
  }
  profile.stats.rejectedCount += 1;
  saveProfile(profile);
}

export function blacklistArtist(playlistId: string, artistId: string, artistName?: string): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  if (!profile.blacklist.artistIds.includes(artistId)) profile.blacklist.artistIds.push(artistId);
  if (artistName && !profile.blacklist.artistNames.includes(artistName)) {
    profile.blacklist.artistNames.push(artistName);
  }
  saveProfile(profile);
}

export function markAccepted(playlistId: string, trackId: string, genres?: string[]): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  ensureGenreFields(profile);
  if (!profile.accepted.trackIds.includes(trackId)) {
    profile.accepted.trackIds.push(trackId);
    profile.stats.acceptedCount += 1;
    for (const genre of genres ?? []) {
      profile.blacklist.acceptancesByGenre[genre] = (profile.blacklist.acceptancesByGenre[genre] ?? 0) + 1;
    }
    saveProfile(profile);
  }
}

export function isTrackBlacklisted(playlistId: string, trackId: string): boolean {
  return !!loadProfile(playlistId)?.blacklist.trackIds.includes(trackId);
}

export function isArtistBlacklisted(playlistId: string, artistId: string): boolean {
  return !!loadProfile(playlistId)?.blacklist.artistIds.includes(artistId);
}

// ─── Phase 8: Learning loop ───────────────────────────────────────────────────

const REFINED_VECTOR_MIN_ACCEPTED = 20;

/**
 * Build taste clusters from accepted tracks only (≥20 required).
 * Returns null if insufficient data.
 */
export async function computeRefinedTasteClusters(
  profile: PlaylistProfile,
  getFeatures: (trackIds: string[]) => Promise<Map<string, AudioFeatures>>,
): Promise<TasteClusters | null> {
  const accepted = profile.accepted.trackIds;
  if (accepted.length < REFINED_VECTOR_MIN_ACCEPTED) return null;
  try {
    const featureMap = await getFeatures(accepted);
    if (featureMap.size === 0) return null;
    const { buildTasteClusters } = await import("./clustering");
    return buildTasteClusters(featureMap, { autoK: true });
  } catch {
    return null;
  }
}

/**
 * Compute genre weights from rejection/acceptance history.
 * Returns a weight per genre (1.0 = neutral, 0.3 = min for heavily rejected genres).
 */
export function getGenreWeights(profile: PlaylistProfile): Record<string, number> {
  ensureGenreFields(profile);
  const weights: Record<string, number> = {};
  const allGenres = new Set([
    ...Object.keys(profile.blacklist.rejectionsByGenre),
    ...Object.keys(profile.blacklist.acceptancesByGenre),
  ]);
  for (const genre of allGenres) {
    const rejections = profile.blacklist.rejectionsByGenre[genre] ?? 0;
    const acceptances = profile.blacklist.acceptancesByGenre[genre] ?? 0;
    const total = rejections + acceptances;
    if (total === 0) { weights[genre] = 1.0; continue; }
    const rejectionRate = rejections / total;
    weights[genre] = Math.max(0.3, 1 - rejectionRate * 0.7);
  }
  return weights;
}

/** review-6: strip intentParseFailed before persisting — it's transport metadata, not content */
export function setIntent(playlistId: string, intent: Intent, intentText: string): void {
  const profile = loadProfile(playlistId) ?? createEmptyProfile(playlistId);
  const { intentParseFailed, ...cleanIntent } = intent;
  void intentParseFailed;
  profile.intent = cleanIntent as Intent;
  profile.intentText = intentText;
  saveProfile(profile);
}
