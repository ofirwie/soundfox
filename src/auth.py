"""Spotify OAuth authentication."""

import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import spotipy
from spotipy.oauth2 import SpotifyOAuth

SCOPES = [
    "user-library-read",
    "playlist-read-private",
    "playlist-read-collaborative",
    "playlist-modify-private",
    "playlist-modify-public",
    "user-top-read",
]

REDIRECT_URI = "http://127.0.0.1:8888/callback"


def get_spotify_client() -> spotipy.Spotify:
    """Create an authenticated Spotify client with local callback server."""
    cache_path = str(Path(__file__).parent.parent / ".cache")

    auth_manager = SpotifyOAuth(
        scope=" ".join(SCOPES),
        redirect_uri=REDIRECT_URI,
        cache_path=cache_path,
        open_browser=False,
    )

    # If we already have a cached token, use it
    token_info = auth_manager.cache_handler.get_cached_token()
    if token_info and not auth_manager.is_token_expired(token_info):
        return spotipy.Spotify(auth_manager=auth_manager)

    # Get the auth URL and open it
    auth_url = auth_manager.get_authorize_url()
    print(f"\nOpening browser for Spotify login...")
    print(f"If it doesn't open, visit this URL:\n{auth_url}\n")
    if sys.platform == "win32":
        os.startfile(auth_url)
    else:
        subprocess.Popen(["open", auth_url])

    # Start a local server to catch the callback
    auth_code: str | None = None

    class CallbackHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            nonlocal auth_code
            query = parse_qs(urlparse(self.path).query)
            if "code" in query:
                auth_code = query["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<html><body><h2>Success! You can close this tab.</h2></body></html>")
            else:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"Authorization failed.")

        def log_message(self, format: str, *args: object) -> None:
            pass  # Suppress server logs

    server = HTTPServer(("127.0.0.1", 8888), CallbackHandler)
    print("Waiting for authorization...")
    server.handle_request()  # Handle one request (the callback)
    server.server_close()

    if not auth_code:
        raise RuntimeError("Failed to get authorization code from Spotify")

    # Exchange code for token
    auth_manager.get_access_token(auth_code, as_dict=False)
    return spotipy.Spotify(auth_manager=auth_manager)
