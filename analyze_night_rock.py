"""Analyze Sample Playlist A playlist — 50 recommendations, post-2000 only."""
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from dotenv import load_dotenv
load_dotenv()

from src.auth import get_spotify_client
from src.analyzer import get_all_playlists, analyze_playlist
from src.recommender import get_recommendations

sp = get_spotify_client()
playlists = get_all_playlists(sp)

target = None
for pl in playlists:
    if pl["name"].lower() == "night rock":
        target = pl
        break

if not target:
    print("Playlist not found.")
    raise SystemExit(1)

print(f"Analyzing: {target['name']} ({target['tracks']['total']} tracks)\n")
profile = analyze_playlist(sp, target["id"], target["name"])
genres = ", ".join(profile.top_genres_list) if profile.top_genres_list else "N/A"
artists = ", ".join(profile.top_artists_names) if profile.top_artists_names else "N/A"

print(f"  Your top artists: {artists}")
print(f"  Your top genres:  {genres}")
print(f"\n--- Finding 50 hidden gems (2000+, weighted by genre DNA) ---\n")

recs = get_recommendations(sp, profile, limit=50, min_year=2000)
if not recs:
    print("  No recommendations found.")
    raise SystemExit(1)

# Print detailed report
print(f"{'#':<4} {'Track':<35} {'Artist':<22} {'Year':<6} {'Why (genre match)':<30} {'Followers':<12} {'All Artist Genres'}")
print("-" * 150)

for i, track in enumerate(recs, 1):
    track_name = track["name"][:33]
    first_artist = track["artists"][0] if track.get("artists") else {}
    artist_name = first_artist.get("name", "?")[:20]
    year = track.get("_year", "?")

    info = track.get("_artist_info", {})
    followers = info.get("followers", {}).get("total", 0)
    all_genres = info.get("genres", [])
    genre_overlap = track.get("_genre_overlap", set())

    match_str = ", ".join(sorted(genre_overlap))[:28]
    all_genres_str = ", ".join(all_genres[:5])

    if followers >= 1_000_000:
        followers_str = f"{followers / 1_000_000:.1f}M"
    elif followers >= 1_000:
        followers_str = f"{followers / 1_000:.0f}K"
    else:
        followers_str = str(followers)

    print(f"{i:<4} {track_name:<35} {artist_name:<22} {year:<6} {match_str:<30} {followers_str:<12} {all_genres_str}")

print("-" * 150)
print(f"\nFilter: 2+ genre overlaps | 5K-3M followers | post-2000 | not in playlist | 1 per artist")

# Create Sample Discovery playlist
user = sp.current_user()
discovery_name = "Sample Discovery"

existing_discovery = None
for pl in playlists:
    if pl["name"] == discovery_name:
        existing_discovery = pl
        break

if existing_discovery:
    sp.playlist_replace_items(existing_discovery["id"], [])
    discovery_id = existing_discovery["id"]
    print(f"\nUpdated playlist: {discovery_name}")
else:
    new_pl = sp.user_playlist_create(user["id"], discovery_name, public=False,
        description="AI discovery for Sample Playlist A - listen and pick your favorites")
    discovery_id = new_pl["id"]
    print(f"\nCreated playlist: {discovery_name}")

# Add in batches of 100
track_uris = [f"spotify:track:{t['id']}" for t in recs]
for i in range(0, len(track_uris), 100):
    sp.playlist_add_items(discovery_id, track_uris[i:i+100])

print(f"Added {len(recs)} tracks to '{discovery_name}'. Go listen!")
