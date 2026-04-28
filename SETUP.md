# DistroFind Setup

## 1. Get Spotify API credentials (free, 2 minutes)

1. Go to https://developer.spotify.com/dashboard
2. Log in with your Spotify account
3. Click **Create app**
4. Name it anything (e.g. "DistroFind"), set Redirect URI to `http://localhost:3000`
5. Copy your **Client ID** and **Client Secret**

## 2. Add credentials

Copy `.env.example` to `.env` and fill it in:

```
SPOTIFY_CLIENT_ID=paste_your_client_id
SPOTIFY_CLIENT_SECRET=paste_your_client_secret
PORT=3000
```

## 3. Install and run

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser.

## How it works

1. Paste any Spotify track or album link
2. The server fetches the **ISRC code** from Spotify's API
3. It queries **ISRCFinder** and **MusicBrainz** to find the distributor/label
4. Results show distributor name, ISRC, country of registration, and registrant code
