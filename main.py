"""Spotify Recommendation Engine — discover new music based on your playlists."""

from pathlib import Path

from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, IntPrompt
from rich.table import Table

from src.analyzer import PlaylistProfile, analyze_playlist, get_all_playlists
from src.auth import get_spotify_client
from src.enricher import add_tracks_to_playlist
from src.recommender import get_recommendations

load_dotenv(Path(__file__).parent / ".env")

console = Console()


def display_playlists(playlists: list[dict]) -> None:
    """Display playlists in a table."""
    table = Table(title="Your Playlists", show_lines=True)
    table.add_column("#", style="cyan", width=4)
    table.add_column("Name", style="bold white")
    table.add_column("Tracks", style="green", justify="right")
    table.add_column("Owner", style="dim")

    for i, pl in enumerate(playlists, 1):
        table.add_row(
            str(i),
            pl["name"],
            str(pl["tracks"]["total"]),
            pl["owner"]["display_name"] or pl["owner"]["id"],
        )

    console.print(table)


def display_profile(profile: PlaylistProfile) -> None:
    """Display playlist audio profile."""
    console.print(
        Panel(
            f"[bold]{profile.playlist_name}[/bold] — {profile.track_count} tracks\n\n"
            f"  Energy:           [{'green' if profile.avg_energy > 0.6 else 'yellow'}]"
            f"{'█' * int(profile.avg_energy * 20):<20}[/] {profile.avg_energy:.2f}\n"
            f"  Danceability:     [{'green' if profile.avg_danceability > 0.6 else 'yellow'}]"
            f"{'█' * int(profile.avg_danceability * 20):<20}[/] {profile.avg_danceability:.2f}\n"
            f"  Mood (valence):   [{'green' if profile.avg_valence > 0.5 else 'blue'}]"
            f"{'█' * int(profile.avg_valence * 20):<20}[/] {profile.avg_valence:.2f}\n"
            f"  Acousticness:     [cyan]"
            f"{'█' * int(profile.avg_acousticness * 20):<20}[/] {profile.avg_acousticness:.2f}\n"
            f"  Instrumentalness: [magenta]"
            f"{'█' * int(profile.avg_instrumentalness * 20):<20}[/] {profile.avg_instrumentalness:.2f}\n"
            f"  Avg Tempo:        [white]{profile.avg_tempo:.0f} BPM[/]\n\n"
            f"  Top genres: {', '.join(profile.seed_genres) or 'N/A'}",
            title="Playlist Profile",
        )
    )


def display_recommendations(tracks: list[dict]) -> None:
    """Display recommended tracks."""
    table = Table(title="Recommended Tracks", show_lines=True)
    table.add_column("#", style="cyan", width=4)
    table.add_column("Track", style="bold white")
    table.add_column("Artist", style="green")
    table.add_column("Album", style="dim")
    table.add_column("Preview", style="blue")

    for i, track in enumerate(tracks, 1):
        artists = ", ".join(a["name"] for a in track["artists"])
        preview = "Yes" if track.get("preview_url") else "-"
        table.add_row(str(i), track["name"], artists, track["album"]["name"], preview)

    console.print(table)


def run() -> None:
    """Main interactive loop."""
    console.print(Panel("[bold green]Spotify Recommendation Engine[/bold green]\n"
                        "Discover new music based on your playlists"))

    console.print("[dim]Connecting to Spotify...[/dim]")
    sp = get_spotify_client()

    user = sp.current_user()
    console.print(f"[green]Logged in as:[/green] [bold]{user['display_name']}[/bold]\n")

    playlists = get_all_playlists(sp)
    if not playlists:
        console.print("[red]No playlists found.[/red]")
        return

    while True:
        display_playlists(playlists)

        choice = IntPrompt.ask(
            "\nSelect a playlist to analyze (0 to quit)",
            default=0,
        )
        if choice == 0:
            break
        if choice < 1 or choice > len(playlists):
            console.print("[red]Invalid choice.[/red]")
            continue

        selected = playlists[choice - 1]
        console.print(f"\n[dim]Analyzing [bold]{selected['name']}[/bold]...[/dim]")

        profile = analyze_playlist(sp, selected["id"], selected["name"])
        if profile.track_count == 0:
            console.print("[yellow]Playlist is empty, skipping.[/yellow]\n")
            continue

        display_profile(profile)

        num_recs = IntPrompt.ask("How many recommendations?", default=20)
        console.print("[dim]Finding new music...[/dim]")

        recommendations = get_recommendations(sp, profile, limit=min(num_recs, 100))
        if not recommendations:
            console.print("[yellow]No new recommendations found.[/yellow]\n")
            continue

        display_recommendations(recommendations)

        if Confirm.ask(f"\nAdd these {len(recommendations)} tracks to [bold]{selected['name']}[/bold]?"):
            track_ids = [t["id"] for t in recommendations]
            added = add_tracks_to_playlist(sp, selected["id"], track_ids)
            console.print(f"[green]Added {added} tracks to {selected['name']}![/green]\n")
        else:
            console.print("[dim]Skipped.[/dim]\n")

    console.print("[bold green]Done! Enjoy your new music.[/bold green]")


if __name__ == "__main__":
    run()
