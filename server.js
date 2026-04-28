require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const session = require('express-session');

const USERS = {
  Tenacity: 'admin55',
  blade: 'admin99',
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'blade-distrofinder-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.redirect('/login');
}

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (USERS[username] && USERS[username] === password) {
    req.session.user = username;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// --- Spotify token cache ---
let spotifyToken = null;
let tokenExpiry = 0;

async function getSpotifyToken() {
  if (spotifyToken && Date.now() < tokenExpiry) return spotifyToken;
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in .env');

  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      },
    }
  );
  spotifyToken = res.data.access_token;
  tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return spotifyToken;
}

// --- URL parsing ---
function parseSpotifyUrl(input) {
  input = input.trim();
  const patterns = [
    { type: 'track', re: /spotify\.com\/(?:intl-[^/]+\/)?track\/([A-Za-z0-9]+)/ },
    { type: 'album', re: /spotify\.com\/(?:intl-[^/]+\/)?album\/([A-Za-z0-9]+)/ },
    { type: 'track', re: /spotify:track:([A-Za-z0-9]+)/ },
    { type: 'album', re: /spotify:album:([A-Za-z0-9]+)/ },
  ];
  for (const { type, re } of patterns) {
    const m = input.match(re);
    if (m) return { type, id: m[1] };
  }
  return null;
}

// --- Spotify data fetch ---
async function fetchTracksFromSpotify(type, id, token) {
  const headers = { Authorization: `Bearer ${token}` };

  if (type === 'track') {
    const { data } = await axios.get(`https://api.spotify.com/v1/tracks/${id}`, { headers });
    const albumRes = await axios.get(`https://api.spotify.com/v1/albums/${data.album.id}`, { headers });
    return [{
      trackName: data.name,
      artist: data.artists.map(a => a.name).join(', '),
      albumName: data.album.name,
      albumArt: data.album.images?.[0]?.url || null,
      isrc: data.external_ids?.isrc || null,
      releaseDate: data.album.release_date,
      spotifyLabel: albumRes.data.label || null,
    }];
  }

  // Album: get all tracks in batches
  const albumRes = await axios.get(`https://api.spotify.com/v1/albums/${id}`, { headers });
  const albumData = albumRes.data;

  let trackItems = albumData.tracks.items;
  // Handle pagination
  let next = albumData.tracks.next;
  while (next) {
    const page = await axios.get(next, { headers });
    trackItems = trackItems.concat(page.data.items);
    next = page.data.next;
  }

  // Batch full track info (max 50 per request)
  const ids = trackItems.map(t => t.id);
  const fullTracks = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await axios.get(`https://api.spotify.com/v1/tracks?ids=${chunk.join(',')}`, { headers });
    fullTracks.push(...res.data.tracks);
  }

  return fullTracks.map(t => ({
    trackName: t.name,
    artist: t.artists.map(a => a.name).join(', '),
    albumName: albumData.name,
    albumArt: albumData.images?.[0]?.url || null,
    isrc: t.external_ids?.isrc || null,
    releaseDate: albumData.release_date,
    spotifyLabel: albumData.label || null,
  }));
}

// --- Soundcharts ISRC lookup ---
async function lookupSoundcharts(isrc) {
  try {
    const appId = process.env.SOUNDCHARTS_APP_ID || 'soundcharts';
    const apiKey = process.env.SOUNDCHARTS_API_KEY || 'soundcharts';
    const { data } = await axios.get(
      `https://customer.api.soundcharts.com/api/v2.25/song/by-isrc/${encodeURIComponent(isrc)}`,
      {
        headers: { 'x-app-id': appId, 'x-api-key': apiKey },
        timeout: 10000,
      }
    );
    const song = data.object;
    if (!song) return null;
    return {
      label: song.distributor || (song.labels?.[0]?.name) || null,
      source: 'Soundcharts',
    };
  } catch {
    return null;
  }
}

// --- ISRC prefix decode ---
const ISRC_REGISTRANT_HINTS = {
  // Country code → common distributors (informational)
  US: 'United States',
  GB: 'United Kingdom',
  DE: 'Germany',
  FR: 'France',
  CA: 'Canada',
  AU: 'Australia',
  NL: 'Netherlands',
  SE: 'Sweden',
  NO: 'Norway',
  JP: 'Japan',
  BR: 'Brazil',
  MX: 'Mexico',
  ES: 'Spain',
  IT: 'Italy',
};

function decodeISRC(isrc) {
  if (!isrc || isrc.length < 12) return null;
  const clean = isrc.replace(/-/g, '').toUpperCase();
  const country = clean.slice(0, 2);
  const registrant = clean.slice(2, 5);
  const year = clean.slice(5, 7);
  const designation = clean.slice(7);
  return {
    country: ISRC_REGISTRANT_HINTS[country] || country,
    countryCode: country,
    registrantCode: registrant,
    year: `20${year}`,
    designation,
    formatted: `${clean.slice(0,2)}-${clean.slice(2,5)}-${clean.slice(5,7)}-${clean.slice(7)}`,
  };
}

// --- Main API endpoint ---
app.post('/api/lookup', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'Spotify URL is required.' });

    const parsed = parseSpotifyUrl(url);
    if (!parsed) return res.status(400).json({ error: 'Invalid Spotify URL. Paste a track or album link.' });

    const token = await getSpotifyToken();
    const tracks = await fetchTracksFromSpotify(parsed.type, parsed.id, token);

    if (!tracks.length) return res.status(404).json({ error: 'No tracks found.' });

    // For albums, only do deep ISRC lookup for first 10 tracks to stay fast
    const lookupTracks = tracks.slice(0, 10);

    const results = await Promise.all(
      lookupTracks.map(async (track) => {
        if (!track.isrc) {
          return { ...track, isrcDecoded: null, distributorInfo: null };
        }

        const isrcDecoded = decodeISRC(track.isrc);

        // Try Soundcharts first, then fall back to Spotify label
        let distributorInfo = await lookupSoundcharts(track.isrc);
        if ((!distributorInfo || !distributorInfo.label) && track.spotifyLabel) {
          distributorInfo = { label: track.spotifyLabel, source: 'Spotify' };
        }

        return { ...track, isrcDecoded, distributorInfo };
      })
    );

    const remaining = tracks.length - lookupTracks.length;

    res.json({
      type: parsed.type,
      totalTracks: tracks.length,
      lookedUp: lookupTracks.length,
      remainingNotLookedUp: remaining,
      results,
    });
  } catch (err) {
    console.error(err.message);
    if (err.response?.status === 401) {
      return res.status(401).json({ error: 'Spotify credentials invalid or expired. Check your .env file.' });
    }
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Spotify track/album not found. Check the URL.' });
    }
    res.status(500).json({ error: err.message || 'Server error.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DistroFind running → http://localhost:${PORT}`);
});
