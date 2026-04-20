"""Discovery engine — finds hidden gems matching the playlist's core DNA."""

import random

import spotipy

from .analyzer import PlaylistProfile

MIN_ARTIST_FOLLOWERS = 5_000
MAX_ARTIST_FOLLOWERS = 500_000

# Genres that are noise — they match tags but not the actual vibe
EXCLUDED_PRIMARY_GENRES = {
    "glam metal", "glam rock", "rock and roll", "doo-wop", "rockabilly",
    "hardcore punk", "ska punk", "pop rock", "pop", "dance rock",
    "new romantic", "synth-pop", "britpop", "emo", "screamo",
    "punk", "pop punk", "k-pop", "j-pop", "latin",
    "power metal", "death metal", "black metal", "grindcore",
    "speed metal", "melodic death metal", "metalcore", "deathcore",
    "viking metal", "folk metal", "symphonic metal", "war metal",
    "thrash metal",
}

# The CORE genres that matter — artist must have at least one
CORE_GENRES = {
    "grunge", "post-grunge", "hard rock", "blues rock",
    "alternative metal", "alternative rock", "stoner rock",
    "stoner metal", "sludge metal", "psychedelic rock",
    "southern rock", "modern blues",
}


def get_recommendations(
    sp: spotipy.Spotify,
    profile: PlaylistProfile,
    limit: int = 50,
    min_year: int = 2000,
) -> list[dict]:
    """Find hidden gems matching the playlist's core DNA.

    Key rules:
    - Artist must have at least 1 CORE genre (grunge, post-grunge, hard rock, etc.)
    - Artist's primary genre must NOT be an excluded genre
    - Track must be released after min_year
    - Max 1 track per artist
    """
    existing_artist_ids = profile.all_artist_ids

    # Search terms — focus on the core
    search_terms = [
        "post-grunge", "grunge", "hard rock", "blues rock",
        "alternative metal", "stoner rock", "alternative rock",
        "sludge metal", "psychedelic rock", "southern rock",
    ]

    # Build search plan — top terms get more rounds
    genre_search_plan: list[tuple[str, list[int]]] = []
    for i, term in enumerate(search_terms):
        if i < 3:
            offsets = [0, 50, 100, 200, 400, 600, 800, 950]
        elif i < 6:
            offsets = [0, 100, 300, 600]
        else:
            offsets = [0, 200, 500]
        genre_search_plan.append((term, offsets))

    # Step 1: Search for artists
    candidate_artists: dict[str, dict] = {}

    for term, offsets in genre_search_plan:
        for offset in offsets:
            try:
                results = sp.search(q=term, type="artist", limit=50, offset=offset)
                for artist in results.get("artists", {}).get("items", []):
                    aid = artist["id"]
                    if aid not in existing_artist_ids and aid not in candidate_artists:
                        candidate_artists[aid] = artist
            except Exception:
                continue

    # Combo searches for crossover artists
    combos = [
        "grunge hard rock", "post-grunge blues", "alternative metal grunge",
        "stoner rock blues", "grunge blues rock", "post-grunge alternative metal",
        "sludge stoner", "psychedelic hard rock",
    ]
    for combo in combos:
        for offset in [0, 100, 300]:
            try:
                results = sp.search(q=combo, type="artist", limit=50, offset=offset)
                for artist in results.get("artists", {}).get("items", []):
                    aid = artist["id"]
                    if aid not in existing_artist_ids and aid not in candidate_artists:
                        candidate_artists[aid] = artist
            except Exception:
                continue

    # Step 2: Validate
    validated: list[dict] = []
    for aid, artist in candidate_artists.items():
        followers = artist.get("followers", {}).get("total", 0)
        artist_genres = set(artist.get("genres", []))

        if followers < MIN_ARTIST_FOLLOWERS or followers > MAX_ARTIST_FOLLOWERS:
            continue

        # Must have at least 1 core genre
        core_overlap = artist_genres & CORE_GENRES
        if not core_overlap:
            continue

        # Primary genre (first listed) must not be excluded
        if artist_genres and artist_genres.issubset(EXCLUDED_PRIMARY_GENRES):
            continue

        # Bonus: penalize if majority of genres are excluded
        good_genres = artist_genres - EXCLUDED_PRIMARY_GENRES
        if len(good_genres) < len(artist_genres) / 2:
            continue

        artist["_genre_overlap"] = core_overlap
        validated.append(artist)

    # Sort by core overlap count, shuffle for diversity
    validated.sort(key=lambda a: len(a.get("_genre_overlap", set())), reverse=True)
    pool = validated[:limit * 4]
    random.shuffle(pool)

    # Step 3: Get top tracks
    result_tracks: list[dict] = []

    for artist in pool:
        if len(result_tracks) >= limit:
            break

        try:
            top = sp.artist_top_tracks(artist["id"], country="US")
        except Exception:
            continue

        tracks = top.get("tracks", [])
        if not tracks:
            continue

        for track in sorted(tracks, key=lambda t: t.get("popularity", 0), reverse=True):
            if track["id"] in profile.existing_track_ids:
                continue
            release_date = track.get("album", {}).get("release_date", "")
            try:
                year = int(release_date[:4]) if release_date else 0
            except ValueError:
                year = 0
            if year < min_year:
                continue

            track["_artist_info"] = artist
            track["_genre_overlap"] = artist.get("_genre_overlap", set())
            track["_year"] = year
            result_tracks.append(track)
            break

    return result_tracks[:limit]
