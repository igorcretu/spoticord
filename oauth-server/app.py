"""
Spoticord OAuth Server
──────────────────────
Handles the Spotify OAuth2 redirect after a user logs in.
Spotify sends:  GET /callback?code=<AUTH_CODE>&state=<DISCORD_USER_ID>
We exchange the code for tokens and save them to /data/tokens/<discord_id>.json
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)

CLIENT_ID     = os.environ["SPOTIFY_CLIENT_ID"]
CLIENT_SECRET = os.environ["SPOTIFY_CLIENT_SECRET"]
REDIRECT_URI  = os.environ["SPOTIFY_REDIRECT_URI"]
TOKEN_DIR     = Path("/data/tokens")
TOKEN_DIR.mkdir(parents=True, exist_ok=True)

SUCCESS_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Spoticord – Connected!</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #121212;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #fff;
    }
    .card {
      text-align: center;
      padding: 3rem 2rem;
      max-width: 420px;
    }
    .icon { font-size: 4rem; margin-bottom: 1.5rem; }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.75rem; color: #1DB954; }
    p  { color: #b3b3b3; line-height: 1.6; }
    .pill {
      display: inline-block;
      margin-top: 2rem;
      padding: 0.5rem 1.25rem;
      background: #1DB954;
      color: #000;
      border-radius: 999px;
      font-weight: 600;
      font-size: 0.875rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎵</div>
    <h1>You're connected!</h1>
    <p>Your Spotify account is now linked to Spoticord.<br>
       Return to Discord and run <strong>!start</strong> to begin your session.</p>
    <div class="pill">You can close this tab</div>
  </div>
</body>
</html>"""

ERROR_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Spoticord – Error</title>
  <style>
    body {{ min-height:100vh;display:flex;align-items:center;justify-content:center;
           background:#121212;font-family:sans-serif;color:#fff;text-align:center; }}
    h1 {{ color:#e74c3c;margin-bottom:1rem; }}
    p  {{ color:#b3b3b3; }}
  </style>
</head>
<body>
  <div>
    <h1>❌ Something went wrong</h1>
    <p>{message}</p>
    <p style="margin-top:1rem;font-size:.875rem">Return to Discord and try <strong>!start</strong> again.</p>
  </div>
</body>
</html>"""


@app.get("/callback")
def callback():
    # Spotify sends an error param if the user denied access
    if error := request.args.get("error"):
        return ERROR_HTML.format(message=f"Spotify returned: {error}"), 400

    code       = request.args.get("code")
    discord_id = request.args.get("state")

    if not code or not discord_id:
        return ERROR_HTML.format(message="Missing code or state parameter."), 400

    # Exchange the auth code for access + refresh tokens
    try:
        resp = requests.post(
            "https://accounts.spotify.com/api/token",
            data={
                "grant_type":   "authorization_code",
                "code":          code,
                "redirect_uri":  REDIRECT_URI,
            },
            auth=(CLIENT_ID, CLIENT_SECRET),
            timeout=10,
        )
        resp.raise_for_status()
    except requests.RequestException as exc:
        return ERROR_HTML.format(message=f"Token exchange failed: {exc}"), 502

    token_data = resp.json()

    # Attach an expires_at timestamp so the bot can check expiry without
    # having to call Spotify — standard OAuth pattern
    token_data["expires_at"] = time.time() + token_data.get("expires_in", 3600)

    # Persist token keyed by Discord user ID
    token_path = TOKEN_DIR / f"{discord_id}.json"
    token_path.write_text(json.dumps(token_data, indent=2))

    return SUCCESS_HTML, 200


@app.get("/has-token/<int:discord_id>")
def has_token(discord_id: int):
    """Called by the Discord bot to check if a user has already linked Spotify."""
    exists = (TOKEN_DIR / f"{discord_id}.json").exists()
    return jsonify({"linked": exists})


@app.delete("/token/<int:discord_id>")
def delete_token(discord_id: int):
    """Called by the bot on !unlink to remove a user's stored token."""
    path = TOKEN_DIR / f"{discord_id}.json"
    if path.exists():
        path.unlink()
        return jsonify({"deleted": True})
    return jsonify({"deleted": False}), 404


@app.get("/health")
def health():
    return jsonify({"status": "ok"})
