"""Analyze specific favorite artists' tracks to find the common DNA."""
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

from dotenv import load_dotenv
load_dotenv()

from src.auth import get_spotify_client
from src.analyzer import get_all_playlists, get_playlist_tracks

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

tracks = get_playlist_tracks(sp, target["id"])
print(f"Sample Playlist A: {len(tracks)} tracks\n")

# Key artists to analyze deeply
key_artists = ["soundgarden", "alice in chains", "temple of the dog",
               "black sabbath", "metallica", "chris cornell"]

print("=" * 100)
print("YOUR FAVORITE ARTISTS - WHAT TRACKS ARE IN THE PLAYLIST")
print("=" * 100)

for key_artist in key_artists:
    artist_tracks = []
    for t in tracks:
        for a in t.get("artists", []):
            if key_artist in a["name"].lower():
                album = t.get("album", {}).get("name", "?")
                year = t.get("album", {}).get("release_date", "?")[:4]
                dur_ms = t.get("duration_ms", 0)
                dur = f"{dur_ms // 60000}:{(dur_ms % 60000) // 1000:02d}"
                artist_tracks.append({
                    "name": t["name"],
                    "album": album,
                    "year": year,
                    "duration": dur,
                    "popularity": t.get("popularity", 0),
                })
                break

    if artist_tracks:
        print(f"\n  {key_artist.upper()} ({len(artist_tracks)} tracks):")
        for at in artist_tracks:
            print(f"    - {at['name'][:50]:<52} | {at['album'][:30]:<32} | {at['year']}  {at['duration']}  pop:{at['popularity']}")

# Now analyze ALL tracks in playlist by looking at the broader artist genres
# to understand the full picture
print(f"\n\n{'=' * 100}")
print("FULL GENRE BREAKDOWN - GROUPED BY CATEGORY")
print("=" * 100)

# Fetch all artist genres
from collections import Counter
artist_ids = list(set(a["id"] for t in tracks for a in t.get("artists", []) if a.get("id")))

genre_counter: Counter = Counter()
artist_genre_map: dict[str, list[str]] = {}
artist_name_map: dict[str, str] = {}

for i in range(0, len(artist_ids), 50):
    batch = artist_ids[i:i+50]
    try:
        result = sp.artists(batch)
        for a in result["artists"]:
            if a:
                artist_genre_map[a["id"]] = a.get("genres", [])
                artist_name_map[a["id"]] = a["name"]
    except Exception:
        continue

# Count genres weighted by track frequency
artist_track_count: Counter = Counter()
for t in tracks:
    for a in t.get("artists", []):
        if a.get("id"):
            artist_track_count[a["id"]] += 1

for aid, count in artist_track_count.items():
    for g in artist_genre_map.get(aid, []):
        genre_counter[g] += count

# Group genres into categories
categories = {
    "GRUNGE/SEATTLE": ["grunge", "seattle sound", "post-grunge"],
    "HARD ROCK": ["hard rock", "classic rock", "arena rock", "rock"],
    "BLUES ROCK": ["blues rock", "modern blues", "blues", "southern rock", "swamp blues", "electric blues", "texas blues"],
    "METAL (melodic)": ["alternative metal", "heavy metal", "metal", "speed metal"],
    "METAL (heavy/dark)": ["doom metal", "stoner metal", "stoner rock", "sludge metal", "thrash metal"],
    "ALT/INDIE ROCK": ["alternative rock", "art rock", "post-punk", "new wave", "indie rock", "shoegaze"],
    "PSYCHEDELIC": ["psychedelic rock", "space rock", "acid rock", "psychedelic blues"],
    "FUNK/RAP ROCK": ["funk rock", "rap metal", "nu metal", "funk metal", "rap rock"],
    "PROG": ["progressive rock", "progressive metal", "symphonic rock"],
}

for cat_name, cat_genres in categories.items():
    total = sum(genre_counter.get(g, 0) for g in cat_genres)
    if total > 0:
        bar = "#" * (total // 8)
        details = ", ".join(f"{g}({genre_counter[g]})" for g in cat_genres if genre_counter.get(g, 0) > 0)
        print(f"\n  {cat_name}: {total} total")
        print(f"    {details}")
        print(f"    {bar}")

# Find the specific DNA - what genre combinations do the KEY artists share?
print(f"\n\n{'=' * 100}")
print("KEY ARTIST GENRE DNA")
print("=" * 100)

for key_artist in key_artists:
    for aid, name in artist_name_map.items():
        if key_artist in name.lower():
            genres = artist_genre_map.get(aid, [])
            print(f"  {name}: {', '.join(genres)}")
            break

# Find artists in playlist that share the MOST genres with the key artists
print(f"\n\n{'=' * 100}")
print("ARTISTS IN YOUR PLAYLIST MOST SIMILAR TO YOUR FAVORITES")
print("=" * 100)

# Collect key artist genres
key_genre_set: set[str] = set()
key_artist_ids: set[str] = set()
for key_artist in key_artists:
    for aid, name in artist_name_map.items():
        if key_artist in name.lower():
            key_genre_set.update(artist_genre_map.get(aid, []))
            key_artist_ids.add(aid)

print(f"\n  Key genres from your favorites: {', '.join(sorted(key_genre_set))}\n")

# Score each other artist
artist_scores: list[tuple[str, str, int, list[str]]] = []
for aid, genres in artist_genre_map.items():
    if aid in key_artist_ids:
        continue
    overlap = set(genres) & key_genre_set
    if len(overlap) >= 2:  # at least 2 genre matches
        name = artist_name_map.get(aid, "?")
        tc = artist_track_count.get(aid, 0)
        artist_scores.append((name, aid, len(overlap), sorted(overlap)))

artist_scores.sort(key=lambda x: x[2], reverse=True)
for name, aid, score, overlap in artist_scores[:20]:
    tc = artist_track_count.get(aid, 0)
    print(f"  {score} matches | {tc:2d} tracks | {name:<30} | {', '.join(overlap)}")
