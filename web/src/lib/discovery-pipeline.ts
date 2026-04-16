import { getAudioFeaturesBatch, type AudioFeatures } from "./reccobeats";
import { buildTasteVector, scoreCandidate, type TasteVector } from "./taste-engine";
import {
  getPlaylistTracks, getArtists, searchArtists, getArtistTopTracks,
  type SpotifyTrack, type SpotifyArtist,
} from "./spotify-client";

export interface PipelineProgress {
  phase: string;
  message: string;
  percent: number;
}

export interface ScoredTrack {
  track: SpotifyTrack;
  score: number;
  artist: SpotifyArtist;
  matchedGenres: string[];
}

export interface PipelineResult {
  tasteVector: TasteVector;
  coreGenres: string[];
  tracksAnalyzed: number;
  tracksWithFeatures: number;
  candidateArtists: number;
  genrePassed: number;
  candidateTracks: number;
  scored: number;
  results: ScoredTrack[];
}

// Genres that are NEVER relevant regardless of playlist
const UNIVERSAL_BANNED = new Set([
  "children's music", "kids", "lullaby", "nursery",
  "asmr", "meditation", "sleep", "white noise",
  "comedy", "stand-up comedy", "spoken word",
]);

function isLatinName(name: string): boolean {
  return /^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-'\.&()\!\?,#+\d]+$/.test(name);
}

// Yield to event loop to keep the browser responsive during heavy loops [v3-F]
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// [C3 FIX] Build genre profile dynamically from playlist
async function buildGenreProfile(
  tracks: SpotifyTrack[],
  onProgress: (msg: string) => void,
): Promise<{ coreGenres: string[]; searchTerms: string[]; allArtistIds: Set<string> }> {
  // Count artist frequency
  const artistCounts = new Map<string, number>();
  for (const track of tracks) {
    for (const artist of track.artists) {
      if (artist.id) artistCounts.set(artist.id, (artistCounts.get(artist.id) ?? 0) + 1);
    }
  }

  const allArtistIds = new Set(artistCounts.keys());

  // Fetch artist details in batches
  const artistIds = [...artistCounts.keys()];
  const genreCounts = new Map<string, number>();

  for (let i = 0; i < artistIds.length; i += 50) {
    const batch = artistIds.slice(i, i + 50);
    try {
      const artists = await getArtists(batch);
      for (const artist of artists) {
        const weight = artistCounts.get(artist.id) ?? 1;
        for (const genre of artist.genres) {
          genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + weight);
        }
      }
    } catch {
      continue;
    }
    onProgress(`Analyzing genres: ${Math.min(i + 50, artistIds.length)}/${artistIds.length} artists`);

    // [v3-F] Yield every batch to keep browser responsive
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  // Sort genres by weighted count
  const sorted = [...genreCounts.entries()].sort((a, b) => b[1] - a[1]);
  const coreGenres = sorted.slice(0, 15).map(([g]) => g);

  // Search terms: skip generic single-word genres, use specific ones
  const genericGenres = new Set(["rock", "pop", "metal", "jazz", "blues", "country", "folk", "soul", "r&b"]);
  const searchTerms = coreGenres.filter((g) => !genericGenres.has(g)).slice(0, 12);

  // If we filtered too many, add back the top ones
  if (searchTerms.length < 5) {
    for (const g of coreGenres) {
      if (!searchTerms.includes(g)) searchTerms.push(g);
      if (searchTerms.length >= 8) break;
    }
  }

  return { coreGenres, searchTerms, allArtistIds };
}

export async function runPipeline(
  playlistId: string,
  onProgress: (progress: PipelineProgress) => void,
  resultCount: number = 50,
  minYear: number = 2000,
): Promise<PipelineResult> {
  // Phase 1: Load tracks
  onProgress({ phase: "analyze", message: "Loading playlist tracks...", percent: 5 });
  const tracks = await getPlaylistTracks(playlistId);
  const trackIds = tracks.map((t) => t.id).filter(Boolean);
  const existingTrackIds = new Set(trackIds);

  // Phase 2: Build genre profile dynamically [C3 FIX]
  onProgress({ phase: "analyze", message: "Analyzing genre DNA...", percent: 8 });
  const { coreGenres, searchTerms, allArtistIds } = await buildGenreProfile(
    tracks,
    (msg) => onProgress({ phase: "analyze", message: msg, percent: 12 }),
  );
  const coreGenreSet = new Set(coreGenres);

  // Phase 3: Audio features
  onProgress({ phase: "analyze", message: "Analyzing audio DNA...", percent: 15 });
  const features = await getAudioFeaturesBatch(trackIds, (done, total) => {
    onProgress({ phase: "analyze", message: `Audio features: ${done}/${total}`, percent: 15 + (done / total) * 15 });
  });
  const tasteVector = buildTasteVector(features);

  // Phase 4: Search for candidate artists
  onProgress({ phase: "discover", message: "Searching for new artists...", percent: 35 });
  const candidateArtists = new Map<string, SpotifyArtist>();
  const MIN_FOLLOWERS = 5_000;
  const MAX_FOLLOWERS = 500_000;

  for (let ti = 0; ti < searchTerms.length; ti++) {
    const term = searchTerms[ti];
    for (let offset = 0; offset < 1000; offset += 50) {
      try {
        const artists = await searchArtists(term, offset);
        if (artists.length === 0) break;
        for (const artist of artists) {
          if (allArtistIds.has(artist.id) || candidateArtists.has(artist.id)) continue;
          if (!isLatinName(artist.name)) continue;
          candidateArtists.set(artist.id, artist);
        }
      } catch { continue; }
    }
    onProgress({
      phase: "discover",
      message: `Searched "${term}" (${candidateArtists.size} found)`,
      percent: 35 + (ti / searchTerms.length) * 15,
    });
  }

  // Phase 5: Genre gate (dynamic)
  onProgress({ phase: "discover", message: "Validating genres...", percent: 50 });
  const genrePassed: SpotifyArtist[] = [];
  let genreLoopCount = 0;
  for (const artist of candidateArtists.values()) {
    genreLoopCount++;
    const followers = artist.followers.total;
    if (followers < MIN_FOLLOWERS || followers > MAX_FOLLOWERS) continue;

    const genres = new Set(artist.genres);
    const coreOverlap = [...genres].filter((g) => coreGenreSet.has(g));
    if (coreOverlap.length < 2) continue;

    if ([...genres].every((g) => UNIVERSAL_BANNED.has(g))) continue;

    genrePassed.push(artist);

    // [v3-F] Yield every 200 iterations in CPU-bound genre loop
    if (genreLoopCount % 200 === 0) await yieldToEventLoop();
  }

  // Phase 6: Get top tracks
  const shuffled = [...genrePassed].sort(() => Math.random() - 0.5);
  const candidateTracks: Array<{ track: SpotifyTrack; artist: SpotifyArtist }> = [];

  for (let i = 0; i < shuffled.length; i++) {
    const artist = shuffled[i];
    try {
      const topTracks = await getArtistTopTracks(artist.id);
      for (const track of topTracks.sort((a, b) => b.popularity - a.popularity)) {
        if (existingTrackIds.has(track.id)) continue;
        if (!isLatinName(track.name)) continue;
        if (track.duration_ms < 180_000 || track.duration_ms > 600_000) continue;
        const year = parseInt(track.album.release_date?.slice(0, 4) ?? "0", 10);
        if (year < minYear) continue;
        candidateTracks.push({ track, artist });
        break;
      }
    } catch { continue; }

    if (i % 10 === 0) {
      onProgress({ phase: "discover", message: `Checking artists: ${i}/${shuffled.length}`, percent: 55 + (i / shuffled.length) * 15 });
    }
  }

  // Phase 7: Score ALL candidates
  onProgress({ phase: "score", message: "Scoring all candidates...", percent: 75 });
  const candidateIds = candidateTracks.map((c) => c.track.id);
  const candidateFeatures = await getAudioFeaturesBatch(candidateIds, (done, total) => {
    onProgress({ phase: "score", message: `Audio scoring: ${done}/${total}`, percent: 75 + (done / total) * 20 });
  });

  const scored: ScoredTrack[] = [];
  for (let i = 0; i < candidateTracks.length; i++) {
    const { track, artist } = candidateTracks[i];
    const feats = candidateFeatures.get(track.id);
    if (!feats) continue;
    const score = scoreCandidate(feats, tasteVector);
    const matchedGenres = artist.genres.filter((g) => coreGenreSet.has(g));
    scored.push({ track, score, artist, matchedGenres });

    // [v3-F] Yield every 200 iterations in scoring loop
    if (i % 200 === 0 && i > 0) await yieldToEventLoop();
  }

  scored.sort((a, b) => b.score - a.score);
  onProgress({ phase: "done", message: "Complete!", percent: 100 });

  return {
    tasteVector,
    coreGenres,
    tracksAnalyzed: trackIds.length,
    tracksWithFeatures: features.size,
    candidateArtists: candidateArtists.size,
    genrePassed: genrePassed.length,
    candidateTracks: candidateTracks.length,
    scored: scored.length,
    results: scored.slice(0, resultCount),
  };
}
