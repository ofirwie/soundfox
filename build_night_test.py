"""Build Sample Discovery — dual gate: genre validation + audio feature scoring."""
import re
import sys
import io
import random

def is_latin_name(name: str) -> bool:
    """Check if name uses only Latin characters (English/European)."""
    return bool(re.match(r'^[\x00-\x7F\xC0-\xFF\u0100-\u024F\s\-\'\.&\(\)\!\?\,\#\+\d]+$', name))

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from dotenv import load_dotenv
load_dotenv()

from src.auth import get_spotify_client
from src.analyzer import get_all_playlists, get_playlist_tracks, analyze_playlist
from src.reccobeats import get_audio_features_batch, FEATURE_KEYS
from src.taste_engine import build_taste_vector, score_candidate

sp = get_spotify_client()
playlists = get_all_playlists(sp)

target = None
for pl in playlists:
    if pl["name"].lower() == "night rock":
        target = pl
        break

if not target:
    print("Sample Playlist A playlist not found.")
    raise SystemExit(1)

# === GENRE GATES ===
CORE_GENRES = {
    "grunge", "post-grunge", "hard rock", "blues rock",
    "alternative metal", "alternative rock", "stoner rock",
    "stoner metal", "sludge metal", "psychedelic rock",
    "southern rock", "modern blues", "doom metal",
    "heavy metal", "metal", "classic rock",
}

BANNED_GENRES = {
    "pop", "pop rock", "dance pop", "electropop", "synth-pop",
    "k-pop", "j-pop", "latin", "reggaeton", "hip hop", "rap",
    "country", "folk", "indie pop", "bedroom pop",
    "edm", "electronic", "house", "techno", "dubstep",
    "r&b", "soul", "jazz", "classical", "ambient",
    "punk", "pop punk", "emo", "screamo",
    "power metal", "symphonic metal", "folk metal", "viking metal",
    "glam metal", "glam rock", "new romantic",
    "ska", "ska punk", "reggae",
    "christian rock", "worship", "ccm",
    "children's music", "kids",
}

MIN_ARTIST_FOLLOWERS = 5_000
MAX_ARTIST_FOLLOWERS = 500_000

# ============================================================
# STEP 1: Build taste vector
# ============================================================
print(f"=== STEP 1: Building taste vector from Sample Playlist A ({target['tracks']['total']} tracks) ===\n")

tracks = get_playlist_tracks(sp, target["id"])
track_ids = [t["id"] for t in tracks if t.get("id")]
existing_ids = set(track_ids)
print(f"  Loaded {len(track_ids)} tracks. Fetching audio features...")

features = get_audio_features_batch(track_ids)
print(f"  ReccoBeats: {len(features)}/{len(track_ids)} tracks profiled.\n")

taste = build_taste_vector(features)
print(f"  Taste vector ({taste.sample_count} tracks):")
for k in FEATURE_KEYS:
    if k in taste.mean:
        print(f"    {k:<20s} mean={taste.mean[k]:.3f}  std={taste.std[k]:.3f}")

# ============================================================
# STEP 2: Find candidates via artist search + genre gate
# ============================================================
print(f"\n=== STEP 2: Finding candidates (artist search + genre gate) ===\n")

profile = analyze_playlist(sp, target["id"], target["name"])
existing_artist_ids = profile.all_artist_ids

search_terms = [
    "post-grunge", "grunge", "hard rock", "blues rock",
    "alternative metal", "stoner rock", "alternative rock",
    "sludge", "psychedelic rock", "southern rock",
    "dark rock", "heavy rock", "melodic rock",
    "doom rock", "desert rock", "noise rock",
    "heavy blues", "acid rock",
]

# Search for ARTISTS, validate genre, then get their tracks
candidate_artists: dict[str, dict] = {}
print(f"  Searching for artists across {len(search_terms)} terms...")

for term in search_terms:
    for offset in range(0, 1000, 50):
        try:
            results = sp.search(q=term, type="artist", limit=50, offset=offset, market="US")
            items = results.get("artists", {}).get("items", [])
            if not items:
                break
            for artist in items:
                aid = artist["id"]
                if aid in existing_artist_ids or aid in candidate_artists:
                    continue
                if not is_latin_name(artist.get("name", "")):
                    continue
                candidate_artists[aid] = artist
        except Exception:
            continue

print(f"  Found {len(candidate_artists)} unique new artists.")

# Genre gate: validate each artist
genre_passed: list[dict] = []
genre_failed = 0

for aid, artist in candidate_artists.items():
    followers = artist.get("followers", {}).get("total", 0)
    artist_genres = set(artist.get("genres", []))

    # Follower range
    if followers < MIN_ARTIST_FOLLOWERS or followers > MAX_ARTIST_FOLLOWERS:
        genre_failed += 1
        continue

    # Must have at least 2 core genre overlaps
    core_overlap = artist_genres & CORE_GENRES
    if len(core_overlap) < 2:
        genre_failed += 1
        continue

    # Must NOT have majority banned genres
    banned_overlap = artist_genres & BANNED_GENRES
    if len(banned_overlap) > len(artist_genres) / 2:
        genre_failed += 1
        continue

    artist["_core_overlap"] = core_overlap
    genre_passed.append(artist)

print(f"  Genre gate: {len(genre_passed)} passed, {genre_failed} failed.")

# Shuffle and get top tracks for each artist
random.shuffle(genre_passed)

candidate_tracks: dict[str, dict] = {}
artist_info_map: dict[str, dict] = {}  # track_id -> artist info

print(f"  Fetching top tracks for {len(genre_passed)} artists...")

for artist in genre_passed:
    try:
        top = sp.artist_top_tracks(artist["id"], country="US")
    except Exception:
        continue

    for track in sorted(top.get("tracks", []), key=lambda t: t.get("popularity", 0), reverse=True):
        tid = track["id"]
        if tid in existing_ids or tid in candidate_tracks:
            continue
        if not is_latin_name(track.get("name", "")):
            continue

        # Duration 3-10 min
        dur = track.get("duration_ms", 0)
        if dur < 180_000 or dur > 600_000:
            continue

        # Post-2000
        rd = track.get("album", {}).get("release_date", "")
        try:
            year = int(rd[:4]) if rd else 0
        except ValueError:
            year = 0
        if year < 2000:
            continue

        candidate_tracks[tid] = track
        artist_info_map[tid] = artist
        break  # 1 track per artist

print(f"  Candidate tracks (genre-validated, post-2000, 1/artist): {len(candidate_tracks)}")

# ============================================================
# STEP 3: Audio feature scoring for ALL candidates
# ============================================================
print(f"\n=== STEP 3: Scoring ALL {len(candidate_tracks)} candidates ===\n")

all_candidate_ids = list(candidate_tracks.keys())
print(f"  Fetching audio features for ALL candidates...")
candidate_features = get_audio_features_batch(all_candidate_ids)
print(f"  ReccoBeats: {len(candidate_features)}/{len(all_candidate_ids)} profiled.")

scored: list[tuple[str, float, dict, dict]] = []
no_features = 0
for tid, track in candidate_tracks.items():
    if tid in candidate_features:
        score = score_candidate(candidate_features[tid], taste)
        scored.append((tid, score, track, artist_info_map.get(tid, {})))
    else:
        no_features += 1

scored.sort(key=lambda x: x[1], reverse=True)
print(f"  Scored: {len(scored)} | No features: {no_features}")

# ============================================================
# STEP 4: Results
# ============================================================
print(f"\n=== STEP 4: Top 50 ===\n")

top_50 = scored[:50]

print(f"{'#':<4} {'Score':<7} {'Track':<35} {'Artist':<22} {'Year':<6} "
      f"{'Core Genres':<30} {'Followers':<10}")
print("-" * 125)

for i, (tid, score, track, artist) in enumerate(top_50, 1):
    track_name = track["name"][:33]
    artist_name = track["artists"][0]["name"][:20] if track.get("artists") else "?"
    year = track.get("album", {}).get("release_date", "?")[:4]
    core = ", ".join(sorted(artist.get("_core_overlap", set())))[:28]
    followers = artist.get("followers", {}).get("total", 0)
    if followers >= 1_000_000:
        f_str = f"{followers / 1_000_000:.1f}M"
    elif followers >= 1_000:
        f_str = f"{followers / 1_000:.0f}K"
    else:
        f_str = str(followers)
    feats = candidate_features.get(tid, {})

    print(f"{i:<4} {score:<7.3f} {track_name:<35} {artist_name:<22} {year:<6} "
          f"{core:<30} {f_str:<10}")

print("-" * 125)
print(f"\nTaste: energy={taste.mean.get('energy', 0):.2f}  "
      f"valence={taste.mean.get('valence', 0):.2f}  "
      f"tempo={taste.mean.get('tempo', 0):.0f}  "
      f"loudness={taste.mean.get('loudness', 0):.1f}")
print(f"Pipeline: {len(track_ids)} tracks -> {taste.sample_count} profiled -> "
      f"{len(candidate_artists)} artists found -> {len(genre_passed)} genre pass -> "
      f"{len(candidate_tracks)} candidates -> {len(scored)} scored -> top 50")

# Create/update Sample Discovery
user = sp.current_user()
discovery_name = "Sample Discovery"

existing_discovery = None
all_playlists = get_all_playlists(sp)
for pl in all_playlists:
    if pl["name"] == discovery_name:
        existing_discovery = pl
        break

if existing_discovery:
    sp.playlist_replace_items(existing_discovery["id"], [])
    discovery_id = existing_discovery["id"]
    print(f"\nUpdated playlist: {discovery_name}")
else:
    new_pl = sp.user_playlist_create(user["id"], discovery_name, public=False,
        description="AI discovery - genre gate + audio feature cosine similarity")
    discovery_id = new_pl["id"]
    print(f"\nCreated playlist: {discovery_name}")

track_uris = [f"spotify:track:{tid}" for tid, _, _, _ in top_50]
for i in range(0, len(track_uris), 100):
    sp.playlist_add_items(discovery_id, track_uris[i:i + 100])

print(f"Added {len(top_50)} tracks to '{discovery_name}'. Go listen!")
