@echo off
cd /d "%~dp0"
echo === Spotify Auth + Night Rock Pipeline ===
echo.
echo Step 1: Authenticating with Spotify...
venv\Scripts\python -c "from dotenv import load_dotenv; load_dotenv(); from src.auth import get_spotify_client; sp = get_spotify_client(); print('Logged in as: ' + sp.current_user()['display_name'])"
if errorlevel 1 (
    echo AUTH FAILED
    pause
    exit /b 1
)
echo.
echo Step 2: Running pipeline (this takes several minutes)...
echo.
venv\Scripts\python build_night_test.py
pause
