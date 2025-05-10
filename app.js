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
  try {
    const store = fs.existsSync(TOKEN_STORE_PATH) 
      ? JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'))
      : {};
    store[id] = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000
    };
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (error) {
    console.error('Error storing token:', error);
  }
}

function getTokenData(id) {
  try {
    if (!fs.existsSync(TOKEN_STORE_PATH)) return null;
    const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
    return store[id] || null;
  } catch (error) {
    console.error('Error reading token store:', error);
    return null;
  }
}

function deleteToken(id) {
  try {
    const store = JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
    delete store[id];
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
  } catch (error) {
    console.error('Error deleting token:', error);
  }
}

// Token refresh logic
async function refreshAccessToken(refreshToken, requestId) {
  try {
    if (DEBUG) console.log(`[${requestId}] Refreshing access token`);
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${client_id}:${client_secret}`).toString('base64')
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    if (!response.ok) {
      const errorBody = await response.json();
      throw new Error(`Refresh failed: ${errorBody.error || response.status}`);
    }

    const body = await response.json();
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token || refreshToken,
      expires_in: body.expires_in || 3600
    };
  } catch (error) {
    if (DEBUG) console.log(`[${requestId}] Error in refreshAccessToken:`, error.message);
    throw error;
  }
}

// Scheduled jobs
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
          expires_at: Date.now() + (newTokens.expires_in || 3600) * 1000
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

setInterval(() => {
  try {
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
  } catch (error) {
    console.error('Error in cleanup job:', error);
  }
}, 3600 * 1000);

var stateKey = 'spotify_auth_state';
var app = express();

if (DEBUG) {
  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} from ${req.ip}`);
    next();
  });
}

app.use(express.static(__dirname + '/public'))
   .use(cors())
   .use(cookieParser());

app.get('/', function(req, res) {
  var state = generateRandomString(16);
  res.cookie(stateKey, state);
  res.redirect('https://accounts.spotify.com/authorize?' +
    querystring.stringify({
      response_type: 'code',
      client_id: client_id,
      scope: 'user-read-currently-playing user-read-playback-state',
      redirect_uri: redirect_uri,
      state: state
    }));
});

app.get('/callback', function(req, res) {
  const code = req.query.code;
  const state = req.query.state;
  const storedState = req.cookies[stateKey];

  if (!state || state !== storedState) {
    res.redirect('/#error=state_mismatch');
    return;
  }

  res.clearCookie(stateKey);
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code'
    },
    headers: {
      'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
    },
    json: true
  };

  request.post(authOptions, (error, response, body) => {
    if (error || response.statusCode !== 200) {
      res.redirect('/#error=invalid_token');
      return;
    }

    const id = crypto.randomBytes(8).toString('hex');
    storeToken(id, {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_in: body.expires_in
    });
    res.redirect(`/image?id=${id}`);
  });
});

// Image rendering functions
async function registerFonts() {
  try {
    const [regularFont, boldFont] = await Promise.all([
      fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif.woff'),
      fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif_bold.woff')
    ]);

    GlobalFonts.register(Buffer.from(await regularFont.arrayBuffer()), 'Pixelated MS Sans Serif');
    GlobalFonts.register(Buffer.from(await boldFont.arrayBuffer()), 'Pixelated MS Sans Serif', { weight: 'bold' });
  } catch (error) {
    console.error('Font loading failed:', error);
  }
}
registerFonts();

app.get("/image", async (req, res) => {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  if (DEBUG) console.log(`[${requestId}] Starting request`);

  try {
    const id = req.query.id;
    if (!id) return res.status(400).send('Missing ID');

    let tokenData = getTokenData(id);
    if (!tokenData) return res.status(404).send('Invalid session');

    // Debug logging
    if (DEBUG) {
      console.log(`[${requestId}] Token expires at: ${new Date(tokenData.expires_at).toISOString()}`);
    }

    // Refresh if within 5 minutes of expiration
    if (tokenData.expires_at < Date.now() + 300000) {
      if (DEBUG) console.log(`[${requestId}] Refreshing token...`);
      try {
        const newTokens = await refreshAccessToken(tokenData.refresh_token, requestId);
        tokenData = {
          access_token: newTokens.access_token,
          refresh_token: newTokens.refresh_token || tokenData.refresh_token,
          expires_at: Date.now() + (newTokens.expires_in || 3600) * 1000
        };
        storeToken(id, tokenData);
      } catch (error) {
        deleteToken(id);
        return res.status(401).send('Session expired');
      }
    }

    // Get playback state
    const playbackState = await getPlaybackState(tokenData.access_token, requestId);
    const canvas = createCanvas(800, 240);
    const ctx = canvas.getContext('2d');
    
    // Render canvas content
    ctx.fillStyle = '#C0C0C0';
    ctx.fillRect(0, 0, 800, 240);

    if (playbackState.error || !playbackState.is_playing) {
      renderNoSongScreen(ctx, playbackState.error ? "API Error" : "No song playing");
    } else {
      try {
        const albumArt = await loadImage(playbackState.item.album.images[0].url);
        ctx.drawImage(albumArt, 20, 20, 200, 200);
      } catch (e) {
        ctx.fillStyle = '#121212';
        ctx.fillRect(20, 20, 200, 200);
      }
      drawTrackInfo(ctx, playbackState.item);
    }

    addTimestamp(ctx);
    res.type('png').send(canvas.toBuffer('image/png'));

  } catch (error) {
    console.error(`[${requestId}] Error:`, error);
    const canvas = createCanvas(800, 240);
    renderNoSongScreen(canvas.getContext('2d'), "System Error");
    res.type('png').send(canvas.toBuffer('image/png'));
  } finally {
    if (DEBUG) {
      console.log(`[${requestId}] Completed in ${Date.now() - startTime}ms`);
    }
  }
});

// Helper functions
async function getPlaybackState(token, requestId) {
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.status === 204) return { is_playing: false };
    if (!response.ok) return { error: true };
    return await response.json();
  } catch (error) {
    return { error: true };
  }
}

function renderNoSongScreen(ctx, message) {
  ctx.fillStyle = '#C0C0C0';
  ctx.fillRect(0, 0, 800, 240);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 16px "Pixelated MS Sans Serif"';
  ctx.fillText(message, 400 - ctx.measureText(message).width/2, 120);
}

function addTimestamp(ctx) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.font = '10px "Pixelated MS Sans Serif"';
  ctx.fillText(`Last updated: ${new Date().toISOString().slice(11, 19)} UTC`, 10, 230);
}

// Start server
const PORT = process.env.PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Redirect URI: ${redirect_uri}`);
});