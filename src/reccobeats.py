"""ReccoBeats API client — audio features using Spotify track IDs."""

import time

import requests

BASE_URL = "https://api.reccobeats.com/v1"
BATCH_SIZE = 40
RATE_LIMIT_DELAY = 2.0

FEATURE_KEYS = [
    "acousticness", "danceability", "energy", "instrumentalness",
    "liveness", "loudness", "speechiness", "tempo", "valence",
]


def _extract_spotify_id(href: str) -> str:
    """Extract Spotify track ID from href like https://open.spotify.com/track/XXX."""
    if "/track/" in href:
        return href.split("/track/")[-1].split("?")[0]
    return ""


def get_audio_features_batch(track_ids: list[str]) -> dict[str, dict[str, float]]:
    """Fetch audio features for tracks by Spotify ID.

    Returns dict: spotify_track_id -> {acousticness, danceability, energy, ...}
    """
    results: dict[str, dict[str, float]] = {}

    for i in range(0, len(track_ids), BATCH_SIZE):
        batch = track_ids[i:i + BATCH_SIZE]
        ids_param = ",".join(batch)
        url = f"{BASE_URL}/audio-features?ids={ids_param}"

        try:
            resp = requests.get(url, headers={"Accept": "application/json"}, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("content", data if isinstance(data, list) else [])
                for item in items:
                    if not item:
                        continue
                    href = item.get("href", "")
                    spotify_id = _extract_spotify_id(href)
                    if spotify_id:
                        features = {k: float(item[k]) for k in FEATURE_KEYS if item.get(k) is not None}
                        if features:
                            results[spotify_id] = features
        except Exception as e:
            print(f"  ReccoBeats batch {i // BATCH_SIZE + 1} error: {e}")

        if i + BATCH_SIZE < len(track_ids):
            time.sleep(RATE_LIMIT_DELAY)

    return results
