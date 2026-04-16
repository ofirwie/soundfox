"""Playlist enricher — adds recommended tracks to playlists."""

import spotipy


def add_tracks_to_playlist(
    sp: spotipy.Spotify,
    playlist_id: str,
    track_ids: list[str],
) -> int:
    """Add tracks to a playlist. Returns number of tracks added."""
    if not track_ids:
        return 0

    uris = [f"spotify:track:{tid}" for tid in track_ids]

    # Spotify allows max 100 tracks per request
    for i in range(0, len(uris), 100):
        batch = uris[i : i + 100]
        sp.playlist_add_items(playlist_id, batch)

    return len(track_ids)
