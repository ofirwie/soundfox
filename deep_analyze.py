"""Deep analysis of Sample Playlist A playlist — understand what makes it tick."""
import sys
import io
from collections import Counter

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

print(f"Deep analysis: {target['name']} ({target['tracks']['total']} tracks)\n")
tracks = get_playlist_tracks(sp, target["id"])
print(f"Loaded {len(tracks)} tracks.\n")

# 1. Artist frequency — who appears most?
artist_counter: Counter = Counter()
artist_names: dict[str, str] = {}
for t in tracks:
    for a in t.get("artists", []):
        if a.get("id"):
            artist_counter[a["id"]] += 1
            artist_names[a["id"]] = a["name"]

print("=" * 80)
print("TOP 30 ARTISTS (by # of tracks in playlist)")
print("=" * 80)
for aid, count in artist_counter.most_common(30):
    print(f"  {count:3d} tracks  |  {artist_names[aid]}")

# 2. Release year distribution
year_counter: Counter = Counter()
for t in tracks:
    album = t.get("album", {})
    release_date = album.get("release_date", "")
    if release_date:
        year = release_date[:4]
        try:
            year_counter[int(year)] += 1
        except ValueError:
            pass

print(f"\n{'=' * 80}")
print("RELEASE YEAR DISTRIBUTION")
print("=" * 80)
decades: dict[str, int] = {}
for year, count in sorted(year_counter.items()):
    decade = f"{(year // 10) * 10}s"
    decades[decade] = decades.get(decade, 0) + count

for decade, count in sorted(decades.items()):
    bar = "#" * (count // 5)
    print(f"  {decade}: {count:4d} tracks  {bar}")

# 3. Sample tracks from different parts of the playlist
print(f"\n{'=' * 80}")
print("TRACK SAMPLES (every 100th track to see the playlist flow)")
print("=" * 80)
for i in range(0, len(tracks), 100):
    t = tracks[i]
    artists_str = ", ".join(a["name"] for a in t.get("artists", []))
    album = t.get("album", {}).get("name", "?")
    year = t.get("album", {}).get("release_date", "?")[:4]
    explicit = "E" if t.get("explicit") else " "
    duration_ms = t.get("duration_ms", 0)
    duration = f"{duration_ms // 60000}:{(duration_ms % 60000) // 1000:02d}"
    print(f"  [{i+1:4d}] {t['name'][:40]:<42} {artists_str[:25]:<27} {year}  {duration}  {explicit}")

# 4. Explicit vs clean ratio
explicit_count = sum(1 for t in tracks if t.get("explicit"))
print(f"\n{'=' * 80}")
print("TRACK CHARACTERISTICS")
print("=" * 80)
print(f"  Total tracks:    {len(tracks)}")
print(f"  Explicit:        {explicit_count} ({100*explicit_count/len(tracks):.0f}%)")
print(f"  Clean:           {len(tracks) - explicit_count} ({100*(len(tracks)-explicit_count)/len(tracks):.0f}%)")

# Duration stats
durations = [t.get("duration_ms", 0) for t in tracks if t.get("duration_ms")]
avg_dur = sum(durations) / len(durations) if durations else 0
min_dur = min(durations) if durations else 0
max_dur = max(durations) if durations else 0
print(f"  Avg duration:    {int(avg_dur) // 60000}:{(int(avg_dur) % 60000) // 1000:02d}")
print(f"  Shortest:        {int(min_dur) // 60000}:{(int(min_dur) % 60000) // 1000:02d}")
print(f"  Longest:         {int(max_dur) // 60000}:{(int(max_dur) % 60000) // 1000:02d}")

# 5. Popularity distribution of tracks in playlist
pop_values = [t.get("popularity", 0) for t in tracks]
avg_pop = sum(pop_values) / len(pop_values) if pop_values else 0
pop_buckets: dict[str, int] = {"0-20": 0, "21-40": 0, "41-60": 0, "61-80": 0, "81-100": 0}
for p in pop_values:
    if p <= 20: pop_buckets["0-20"] += 1
    elif p <= 40: pop_buckets["21-40"] += 1
    elif p <= 60: pop_buckets["41-60"] += 1
    elif p <= 80: pop_buckets["61-80"] += 1
    else: pop_buckets["81-100"] += 1

print(f"  Avg popularity:  {avg_pop:.0f}")
print(f"\n  Popularity distribution:")
for bucket, count in pop_buckets.items():
    bar = "#" * (count // 10)
    print(f"    {bucket}: {count:4d}  {bar}")

# 6. Fetch genres for ALL unique artists (not just top 10)
print(f"\n{'=' * 80}")
print("GENRE ANALYSIS (from all artists in playlist)")
print("=" * 80)

all_artist_ids = list(artist_counter.keys())
genre_counter: Counter = Counter()
artist_genre_map: dict[str, list[str]] = {}

for i in range(0, len(all_artist_ids), 50):
    batch = all_artist_ids[i:i+50]
    try:
        result = sp.artists(batch)
        for a in result["artists"]:
            if a:
                genres = a.get("genres", [])
                artist_genre_map[a["id"]] = genres
                for g in genres:
                    genre_counter[g] += artist_counter[a["id"]]  # weight by track count
    except Exception:
        continue

print("Top 30 genres (weighted by track count):")
for genre, count in genre_counter.most_common(30):
    bar = "#" * (count // 10)
    print(f"  {count:4d}  {genre:<35} {bar}")

# 7. What does "Sample Playlist A" mean? Let's look at track name patterns
print(f"\n{'=' * 80}")
print("TRACK NAME PATTERNS (common words)")
print("=" * 80)
word_counter: Counter = Counter()
stop_words = {"the", "a", "an", "in", "of", "to", "and", "is", "it", "my", "me", "i", "you", "we",
              "for", "on", "with", "at", "by", "from", "or", "no", "not", "but", "be", "this",
              "that", "all", "are", "was", "so", "if", "do", "up", "out", "your", "remastered",
              "remaster", "remix", "live", "version", "deluxe", "bonus", "track", "album", "edit",
              "-", "2011", "2012", "2013", "2014", "2015", "2016", "2017", "2018", "2019", "2020",
              "2021", "2022", "2023", "2024", "2025", "2026"}
for t in tracks:
    words = t["name"].lower().replace("-", " ").replace("(", " ").replace(")", " ").split()
    for w in words:
        w = w.strip(".,!?'\"")
        if len(w) > 2 and w not in stop_words:
            word_counter[w] += 1

for word, count in word_counter.most_common(30):
    print(f"  {count:3d}x  {word}")
