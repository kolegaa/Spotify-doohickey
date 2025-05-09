var express = require('express');
var request = require('request');
var crypto = require('crypto');
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
const fetch = require('node-fetch').default;
require('dotenv').config();
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

var client_id = process.env.CLIENT_ID;
var client_secret = process.env.CLIENT_SECRET;
var redirect_uri = process.env.REDIRECT_URI;
const DEBUG = process.env.DEBUG === 'true';

// Token store setup
const TOKEN_STORE_PATH = path.join(__dirname, 'token_store.json');
if (!fs.existsSync(TOKEN_STORE_PATH)) {
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify({}), 'utf8');
}

// Helper functions
const generateRandomString = (length) => {
  return crypto.randomBytes(60).toString('hex').slice(0, length);
};

// Token management
function storeToken(id, tokenData) {
  const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  store[id] = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_at: Date.now() + 3600 * 1000 // 1 hour expiration
  };
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function getTokenData(id) {
  const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  return store[id] || null;
}

function deleteToken(id) {
  const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  delete store[id];
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

// Token refresh job
setInterval(async () => {
  if (DEBUG) console.log('[Token Refresh] Starting token refresh job');
  try {
    const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
    for (const [id, tokenData] of Object.entries(store)) {
      try {
        const newTokens = await refreshAccessToken(tokenData.refresh_token, 'refresh-job');
        store[id] = {
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token || tokenData.refresh_token,
          expires_at: Date.now() + 3600 * 1000
        };
        if (DEBUG) console.log(`[Token Refresh] Refreshed token for ID: ${id}`);
      } catch (error) {
        console.error(`[Token Refresh] Failed to refresh token for ID: ${id}`, error);
        delete store[id];
      }
    }
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (error) {
    console.error('[Token Refresh] Error in refresh job:', error);
  }
}, 3600 * 1000);

// Cleanup job for old tokens
setInterval(() => {
  const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  const now = Date.now();
  let changed = false;
  
  for (const [id, tokenData] of Object.entries(store)) {
    if (tokenData.expires_at < now - 86400 * 1000) {
      delete store[id];
      changed = true;
    }
  }
  
  if (changed) {
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  }
}, 3600 * 1000);

var stateKey = 'spotify_auth_state';
var app = express();

if (DEBUG) {
  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const path = req.path;
    const clientIP = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    
    console.log(`[${timestamp}] ${method} ${path} from ${clientIP}`);
    console.log(`  User-Agent: ${req.headers['user-agent']}`);
    console.log(`  Referrer: ${req.headers['referer'] || 'none'}`);
    
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${timestamp}] ${method} ${path} completed in ${duration}ms with status ${res.statusCode}`);
    });
    
    next();
  });
}

app.use(express.static(__dirname + '/public'))
   .use(cors())
   .use(cookieParser());

app.get('/', function(req, res) {
  var state = generateRandomString(16);
  res.cookie(stateKey, state);
  var scope = 'user-read-currently-playing user-read-playback-state';
  
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: scope,
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', function(req, res) {
  var code = req.query.code || null;
  var state = req.query.state || null;
  var storedState = req.cookies ? req.cookies[stateKey] : null;

  if (state === null || state !== storedState) {
    res.redirect('/#' + querystring.stringify({ error: 'state_mismatch' }));
  } else {
    res.clearCookie(stateKey);
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      form: {
        code: code,
        redirect_uri: redirect_uri,
        grant_type: 'authorization_code'
      },
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64'))
      },
      json: true
    };

    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {
        const id = crypto.randomBytes(8).toString('hex');
        storeToken(id, {
          access_token: body.access_token,
          refresh_token: body.refresh_token
        });
        res.redirect(301, `/image?id=${id}`);
      } else {
        res.redirect('/#' + querystring.stringify({ error: 'invalid_token' }));
      }
    });
  }
});

// Helper functions for Spotify API
async function getPlaybackState(token, requestId) {
  try {
    if (DEBUG) console.log(`[${requestId}] Fetching playback state`);
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    if (DEBUG) console.log(`[${requestId}] Spotify API response status: ${response.status}`);
    if (response.status === 204) return { is_playing: false };
    if (!response.ok) {
      const errorBody = await response.json();
      if (DEBUG) console.log(`[${requestId}] Spotify API error: ${response.status}`, errorBody);
      return { error: { status: response.status, message: errorBody } };
    }
    return await response.json();
  } catch (error) {
    if (DEBUG) console.log(`[${requestId}] Error in getPlaybackState:`, error.message);
    return { error: { status: 500, message: error.message } };
  }
}

async function refreshAccessToken(refreshToken, requestId) {
  try {
    if (DEBUG) console.log(`[${requestId}] Refreshing access token`);
    const authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      headers: { 
        'content-type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64')) 
      },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      },
      json: true
    };

    return new Promise((resolve, reject) => {
      request.post(authOptions, (error, response, body) => {
        if (error) return reject(error);
        if (response.statusCode !== 200) return reject(body);
        resolve({
          access_token: body.access_token,
          refresh_token: body.refresh_token
        });
      });
    });
  } catch (error) {
    if (DEBUG) console.log(`[${requestId}] Error in refreshAccessToken:`, error.message);
    throw error;
  }
}

// Image rendering functions
function addTimestamp(ctx) {
  const now = new Date();
  const timestamp = `Last updated at ${now.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.font = '10px "Pixelated MS Sans Serif"';
  ctx.fillText(timestamp, 10, 230);
}

function renderNoSongScreen(ctx, message) {
  ctx.fillStyle = '#C0C0C0';
  ctx.fillRect(0, 0, 800, 240);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 16px "Pixelated MS Sans Serif"';
  const textWidth = ctx.measureText(message).width;
  ctx.fillText(message, (800 - textWidth) / 2, 120);
}

function drawTrackInfo(ctx, track) {
  const cleanTrackName = track.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g, '');

  ctx.fillStyle = '#000000';
  const maxWidth = 550;
  const lineHeight = 30;
  let y = 40;

  ctx.font = 'bold 24px "Pixelated MS Sans Serif"';
  wrapText(ctx, cleanTrackName, 240, y, maxWidth, lineHeight);

  y += lineHeight + 10;
  ctx.font = '18px "Pixelated MS Sans Serif"';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  const artists = track.artists.map(artist => artist.name).join(', ');
  wrapText(ctx, artists, 240, y, maxWidth, lineHeight);

  y += lineHeight + 20;
  ctx.font = '14px "Pixelated MS Sans Serif"';
  const albumInfo = `Album: ${track.album.name}`;
  const duration = `Duration: ${Math.floor(track.duration_ms / 60000)}:${(Math.floor(track.duration_ms / 1000) % 60).toString().padStart(2, '0')}`;
  ctx.fillText(albumInfo, 240, y);
  ctx.fillText(duration, 240, y + 20);
}

function wrapText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = context.measureText(testLine);
    if (metrics.width > maxWidth && n > 0) {
      context.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  context.fillText(line, x, y);
}

// Register fonts
async function registerFonts() {
  try {
    const regularFontResponse = await fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif.woff');
    const regularFontBuffer = Buffer.from(await regularFontResponse.arrayBuffer());
    GlobalFonts.register(regularFontBuffer, 'Pixelated MS Sans Serif', { 
      weight: 'normal',
      style: 'normal'
    });
    
    const boldFontResponse = await fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif_bold.woff');
    const boldFontBuffer = Buffer.from(await boldFontResponse.arrayBuffer());
    GlobalFonts.register(boldFontBuffer, 'Pixelated MS Sans Serif', {
      weight: 'bold',
      style: 'normal'
    });
    if (DEBUG) console.log('Fonts registered with extended character support');
  } catch (error) {
    console.error('Font registration error:', error);
  }
}

registerFonts().catch(console.error);

// Main image endpoint
app.get("/image", async function(req, res) {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  
  if (DEBUG) console.log(`[${new Date().toISOString()}] [${requestId}] Starting /image request`);

  try {
    const id = req.query.id;
    if (!id) return res.status(400).send('Missing ID parameter');

    let tokenData = getTokenData(id);
    if (!tokenData) return res.status(404).send('Invalid or expired session');

    if (tokenData.expires_at < Date.now()) {
      if (DEBUG) console.log(`[${requestId}] Token expired, refreshing...`);
      const newTokens = await refreshAccessToken(tokenData.refresh_token, requestId);
      tokenData = {
        access_token: newTokens.access_token,
        refresh_token: newTokens.refresh_token || tokenData.refresh_token,
        expires_at: Date.now() + 3600 * 1000
      };
      storeToken(id, tokenData);
    }

    const playbackState = await getPlaybackState(tokenData.access_token, requestId);
    const canvas = createCanvas(800, 240);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#C0C0C0';
    ctx.fillRect(0, 0, 800, 240);

    if (playbackState.error) {
      renderNoSongScreen(ctx, "Error fetching playback data");
      addTimestamp(ctx);
      return res.type('png').send(canvas.toBuffer('image/png'));
    }

    if (!playbackState?.is_playing || !playbackState.item) {
      renderNoSongScreen(ctx, "No song currently playing");
      addTimestamp(ctx);
      return res.type('png').send(canvas.toBuffer('image/png'));
    }

    const track = playbackState.item;
    let albumArt;
    try {
      albumArt = await loadImage(track.album.images[0]?.url);
    } catch (e) {
      ctx.fillStyle = '#121212';
      ctx.fillRect(20, 20, 200, 200);
    }

    if (albumArt) ctx.drawImage(albumArt, 20, 20, 200, 200);
    drawTrackInfo(ctx, track);
    addTimestamp(ctx);

    return res.type('png').send(canvas.toBuffer('image/png'));
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Error:`, error);
    const canvas = createCanvas(800, 240);
    const ctx = canvas.getContext('2d');
    renderNoSongScreen(ctx, "System error");
    addTimestamp(ctx);
    return res.type('png').send(canvas.toBuffer('image/png'));
  } finally {
    if (DEBUG) {
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] [${requestId}] Request completed in ${duration}ms`);
    }
  }
});

const PORT = process.env.PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using redirect URI: ${redirect_uri}`);
});