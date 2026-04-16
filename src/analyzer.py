"""Playlist analysis — extracts artist/genre profiles without audio features."""

from dataclasses import dataclass, field

import spotipy


@dataclass
class PlaylistProfile:
    """Aggregated profile for a playlist based on artists and genres."""

    playlist_id: str
    playlist_name: str
    track_count: int
    seed_tracks: list[str] = field(default_factory=list)
    seed_artists: list[str] = field(default_factory=list)
    seed_genres: list[str] = field(default_factory=list)
    top_artists_names: list[str] = field(default_factory=list)
    top_genres_list: list[str] = field(default_factory=list)
    all_artist_ids: set[str] = field(default_factory=set)
    existing_track_ids: set[str] = field(default_factory=set)


def get_all_playlists(sp: spotipy.Spotify) -> list[dict]:
    """Fetch all playlists for the current user."""
    playlists: list[dict] = []
    results = sp.current_user_playlists(limit=50)
    while results:
        playlists.extend(results["items"])
        results = sp.next(results) if results["next"] else None
    return playlists


def get_playlist_tracks(sp: spotipy.Spotify, playlist_id: str) -> list[dict]:
    """Fetch all tracks from a playlist."""
    tracks: list[dict] = []
    results = sp.playlist_tracks(playlist_id, limit=100)
    while results:
        for item in results["items"]:
            if item["track"] and item["track"]["id"]:
                tracks.append(item["track"])
        results = sp.next(results) if results["next"] else None
    return tracks


def analyze_playlist(sp: spotipy.Spotify, playlist_id: str, playlist_name: str) -> PlaylistProfile:
    """Analyze a playlist based on artists and genres."""
    tracks = get_playlist_tracks(sp, playlist_id)
    if not tracks:
        return PlaylistProfile(
            playlist_id=playlist_id,
            playlist_name=playlist_name,
            track_count=0,
        )

    track_ids = [t["id"] for t in tracks if t["id"]]
    existing_ids = set(track_ids)

    # Count artist appearances
    artist_counts: dict[str, int] = {}
    artist_names: dict[str, str] = {}
    for t in tracks:
        for artist in t.get("artists", []):
            aid = artist["id"]
            if aid:
                artist_counts[aid] = artist_counts.get(aid, 0) + 1
                artist_names[aid] = artist["name"]

    # Top artists by frequency
    top_artist_ids = sorted(artist_counts, key=artist_counts.get, reverse=True)[:10]  # type: ignore[arg-type]
    top_artist_names_list = [artist_names[aid] for aid in top_artist_ids]

    # Get genres from top artists (batch of 50)
    genre_counts: dict[str, int] = {}
    for i in range(0, len(top_artist_ids), 50):
        batch = top_artist_ids[i : i + 50]
        artists_info = sp.artists(batch)
        for a in artists_info["artists"]:
            for genre in a.get("genres", []):
                genre_counts[genre] = genre_counts.get(genre, 0) + 1

    top_genres = sorted(genre_counts, key=genre_counts.get, reverse=True)[:10]  # type: ignore[arg-type]

    # Seeds for recommendations: 2 tracks + 2 artists + 1 genre (max 5 total)
    # Pick tracks from different parts of the playlist for diversity
    step = max(1, len(track_ids) // 3)
    seed_tracks = [track_ids[0], track_ids[min(step, len(track_ids) - 1)]]
    seed_artists = top_artist_ids[:2]
    seed_genres = top_genres[:1]

    return PlaylistProfile(
        playlist_id=playlist_id,
        playlist_name=playlist_name,
        track_count=len(tracks),
        seed_tracks=seed_tracks,
        seed_artists=seed_artists,
        seed_genres=seed_genres,
        top_artists_names=top_artist_names_list,
        top_genres_list=top_genres,
        all_artist_ids=set(artist_counts.keys()),
        existing_track_ids=existing_ids,
    )
