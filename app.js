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
if (DEBUG) {
  console.log('Debug mode is enabled');
}

const generateRandomString = (length) => {
  return crypto
    .randomBytes(60)
    .toString('hex')
    .slice(0, length);
}

var stateKey = 'spotify_auth_state';

var app = express();

if (process.env.DEBUG === 'true') {
  app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    const method = req.method;
    const path = req.path;
    const clientIP = req.ip || 
                    req.headers['x-forwarded-for']?.split(',')[0] || 
                    req.socket.remoteAddress ||
                    req.connection.remoteAddress;
    
    console.log(`[${timestamp}] ${method} ${path} from ${clientIP}`);
    console.log(`  User-Agent: ${req.headers['user-agent']}`);
    console.log(`  Referrer: ${req.headers['referer'] || 'none'}`);
    
    // Log the start time
    const start = Date.now();
    
    // Log when the response finishes
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`[${timestamp}] ${method} ${path} completed in ${duration}ms with status ${res.statusCode}`);
    });
    
    next();
  });
};

app.use(express.static(__dirname + '/public'))
   .use(cors())
   .use(cookieParser());

   app.get('/', function(req, res) {
    var state = generateRandomString(16);
    res.cookie(stateKey, state);
  
    // Added user-read-currently-playing scope
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
      res.redirect('/#' +
        querystring.stringify({
          error: 'state_mismatch'
        }));
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
          var access_token = body.access_token;
          res.redirect('/image?' + 
            querystring.stringify({
              access_token: access_token
            }));
        } else {
          res.redirect('/#' +
            querystring.stringify({
              error: 'invalid_token'
            }));
        }
      });
    }
  });
  
  app.get('/refresh_token', function(req, res) {
    var refresh_token = req.query.refresh_token;
    var authOptions = {
      url: 'https://accounts.spotify.com/api/token',
      headers: { 
        'content-type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + (new Buffer.from(client_id + ':' + client_secret).toString('base64')) 
      },
      form: {
        grant_type: 'refresh_token',
        refresh_token: refresh_token
      },
      json: true
    };
  
    request.post(authOptions, function(error, response, body) {
      if (!error && response.statusCode === 200) {
        var access_token = body.access_token,
            refresh_token = body.refresh_token;
        res.send({
          'access_token': access_token,
          'refresh_token': refresh_token
        });
      }
    });
  });
  
app.get("/nowplaying", async function(req, res) {
  const token = req.query.access_token;
  
  if (!token) {
    return res.status(401).send('Access token missing');
  }

  async function fetchWebApi(endpoint, method) {
    try {
      const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        method
      });
      
      if (response.status === 204) {
        return { is_playing: false };
      }
      
      if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      throw error;
    }
  }
  
  try {
    const currentlyPlaying = await fetchWebApi('me/player/currently-playing', 'GET');
    
    if (!currentlyPlaying.is_playing || !currentlyPlaying.item) {
      return res.send('<div style="background:#121212;color:white;padding:20px;">No song playing</div>');
    }

    const track = currentlyPlaying.item;
    res.send(`
      <html>

<head>
    <style>
            @font-face{font-family:"Pixelated MS Sans Serif";font-style:normal;font-weight:400;src:url(https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif.woff) format("woff");src:url(https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif.woff2) format("woff2")}
            @font-face{font-family:"Pixelated MS Sans Serif";font-style:normal;font-weight:700;src:url(https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif_bold.woff) format("woff");src:url(https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif_bold.woff2) format("woff2")}

            .container {
                color: black;
                font-family: "Pixelated MS Sans Serif", sans-serif;
                font-size: 12px;
            }

            body {
              margin: 0;
              padding: 20px;
              background: silver;
              color: black;
              width: 800px;
              height: 240px;
              display: flex;
              align-items: center;
            
            }
            .container {
              display: flex;
              align-items: center;
              gap: 30px;
              width: 100%;
              padding: 20px;
            }
            img.album-art {
              width: 200px;
              height: 200px;
              flex-shrink: 0;
            }
            .track-info {
              flex-grow: 1;
            }
            .track-name {
              font-size: 24px;
              margin: 0 0 15px 0;
              font-weight: bold;
            }
            .artists {
              font-size: 18px;
              color:rgba(0, 0, 0, 0.7), 0);
              margin-bottom: 25px;
            }
            .meta {
              font-size: 14px;
              color:rgba(0, 0, 0, 0.7), 0);
            }
    </style>
</head>

<body>
    <div class="container">
        <img src="${track.album.images[0].url}" class="album-art">
        <div class="track-info">
            <div class="track-name">${track.name}</div>
            <div class="artists">
                ${track.artists.map(artist => artist.name).join(', ')}
            </div>
            <div class="meta">
                Album: ${track.album.name}<br> Duration: ${Math.floor(track.duration_ms / 60000)}:${(Math.floor(track.duration_ms / 1000) % 60).toString().padStart(2, '0')}
            </div>
        </div>
    </div>
</body>

</html>
    `);
    
  } catch (error) {
    res.send('<div style="background:#121212;color:white;padding:20px;">Error loading track info</div>');
  }
});

async function registerFonts() {
  try {
    // Load regular font
    const regularFontResponse = await fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif.woff');
    const regularFontBuffer = Buffer.from(await regularFontResponse.arrayBuffer());
    GlobalFonts.register(regularFontBuffer, 'Pixelated MS Sans Serif', { 
      weight: 'normal',
      style: 'normal'
    });
    
    // Load bold font
    const boldFontResponse = await fetch('https://unpkg.com/98.css@0.1.20/dist/ms_sans_serif_bold.woff');
    const boldFontBuffer = Buffer.from(await boldFontResponse.arrayBuffer());
    GlobalFonts.register(boldFontBuffer, 'Pixelated MS Sans Serif', {
      weight: 'bold',
      style: 'normal'
    });
    if  (DEBUG) {
      console.log('Fonts registered with extended character support');
    };
  } catch (error) {
    console.error('Font registration error:', error);
  }
}

// Call this when your app starts
registerFonts().catch(console.error);

app.get("/image", async function(req, res) {
  const startTime = Date.now();
  const requestId = crypto.randomBytes(4).toString('hex');
  
  if (DEBUG) {
    console.log(`[${new Date().toISOString()}] [${requestId}] Starting /image request`);
    console.log(`[${new Date().toISOString()}] [${requestId}] Client IP: ${req.ip}`);
    console.log(`[${new Date().toISOString()}] [${requestId}] User-Agent: ${req.headers['user-agent']}`);
  }

  try {
    let token = req.query.access_token;
    
    if (!token) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Error: Access token missing`);
      }
      return res.status(401).send('Access token missing');
    }

    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Attempting initial playback state fetch`);
    }

    // First try with the current token
    let playbackState = await getPlaybackState(token, requestId);
    
    // If we get a 401, try refreshing the token
    if (playbackState.error && playbackState.error.status === 401) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Token expired (401), attempting to refresh...`);
      }
      
      const refreshToken = req.query.refresh_token;
      if (!refreshToken) {
        if (DEBUG) {
          console.log(`[${new Date().toISOString()}] [${requestId}] Error: No refresh token available`);
        }
        const canvas = createCanvas(800, 240);
        const ctx = canvas.getContext('2d');
        renderNoSongScreen(ctx, "Session expired, please reauthenticate");
        res.set('Content-Type', 'image/png');
        return res.send(canvas.toBuffer('image/png'));
      }
      
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Refreshing token...`);
      }
      
      // Refresh the token
      const newTokens = await refreshAccessToken(refreshToken, requestId);
      if (newTokens.access_token) {
        token = newTokens.access_token;
        if (DEBUG) {
          console.log(`[${new Date().toISOString()}] [${requestId}] Token refreshed successfully`);
          console.log(`[${new Date().toISOString()}] [${requestId}] New access token: ${token.substring(0, 10)}...`);
        }
        // Try again with the new token
        playbackState = await getPlaybackState(token, requestId);
      } else {
        if (DEBUG) {
          console.log(`[${new Date().toISOString()}] [${requestId}] Error: Failed to refresh token`);
          if (newTokens.error) {
            console.log(`[${new Date().toISOString()}] [${requestId}] Refresh error:`, newTokens.error);
          }
        }
        const canvas = createCanvas(800, 240);
        const ctx = canvas.getContext('2d');
        renderNoSongScreen(ctx, "Session expired, please reauthenticate");
        res.set('Content-Type', 'image/png');
        return res.send(canvas.toBuffer('image/png'));
      }
    }

    // Create canvas
    const canvas = createCanvas(800, 240);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#C0C0C0';
    ctx.fillRect(0, 0, 800, 240);

    // Handle playback state
    if (playbackState.error) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Playback state error:`, playbackState.error);
      }
      renderNoSongScreen(ctx, "Error fetching playback data");
      res.set('Content-Type', 'image/png');
      return res.send(canvas.toBuffer('image/png'));
    }

    // Check if playback is active
    if (!playbackState?.is_playing || !playbackState.item) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] No active playback`);
      }
      renderNoSongScreen(ctx, "No song currently playing");
      res.set('Content-Type', 'image/png');
      return res.send(canvas.toBuffer('image/png'));
    }

    // If we get here, we have a track to display
    const track = playbackState.item;
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Track data received`);
      console.log(`[${new Date().toISOString()}] [${requestId}] Track: ${track.name}`);
      console.log(`[${new Date().toISOString()}] [${requestId}] Artists: ${track.artists.map(a => a.name).join(', ')}`);
      console.log(`[${new Date().toISOString()}] [${requestId}] Album: ${track.album.name}`);
    }

    // Load album art with error handling
    let albumArt;
    try {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Loading album art from: ${track.album.images[0]?.url}`);
      }
      albumArt = await loadImage(track.album.images[0]?.url);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [${requestId}] Error loading album art:`, e.message);
      // Fallback rectangle
      ctx.fillStyle = '#121212';
      ctx.fillRect(20, 20, 200, 200);
    }

    // Draw album art if loaded
    if (albumArt) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Drawing album art`);
      }
      ctx.drawImage(albumArt, 20, 20, 200, 200);
    }

    // Draw track info
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Rendering track info`);
    }
    drawTrackInfo(ctx, track);

    // Send the image
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Sending image response`);
    }
    res.set('Content-Type', 'image/png');
    return res.send(canvas.toBuffer('image/png'));

  } catch (error) {
    console.error(`[${new Date().toISOString()}] [${requestId}] Unexpected error:`, error);
    const canvas = createCanvas(800, 240);
    const ctx = canvas.getContext('2d');
    renderNoSongScreen(ctx, "System error");
    res.set('Content-Type', 'image/png');
    return res.send(canvas.toBuffer('image/png'));
  } finally {
    if (DEBUG) {
      const duration = Date.now() - startTime;
      console.log(`[${new Date().toISOString()}] [${requestId}] Request completed in ${duration}ms`);
    }
  }
});

// Updated helper functions with logging
async function getPlaybackState(token, requestId) {
  try {
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Fetching playback state`);
    }
    
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: { 
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Spotify API response status: ${response.status}`);
    }

    // Handle 204 (No Content) response
    if (response.status === 204) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] No content response (204) - no playback`);
      }
      return { is_playing: false };
    }

    // Handle other non-200 responses
    if (!response.ok) {
      const errorBody = await response.json();
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Spotify API error: ${response.status}`, errorBody);
      }
      return { error: { status: response.status, message: errorBody } };
    }

    const data = await response.json();
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Successfully fetched playback state`);
    }
    return data;
  } catch (error) {
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Error in getPlaybackState:`, error.message);
    }
    return { error: { status: 500, message: error.message } };
  }
}

async function refreshAccessToken(refreshToken, requestId) {
  try {
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Refreshing access token`);
    }
    
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

    const response = await request.post(authOptions);
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Token refresh response status: ${response.statusCode}`);
    }

    if (response.statusCode === 200) {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Token refresh successful`);
      }
      return {
        access_token: response.body.access_token,
        refresh_token: response.body.refresh_token || refreshToken
      };
    } else {
      if (DEBUG) {
        console.log(`[${new Date().toISOString()}] [${requestId}] Token refresh failed:`, response.body);
      }
      return { error: response.body };
    }
  } catch (error) {
    if (DEBUG) {
      console.log(`[${new Date().toISOString()}] [${requestId}] Error in refreshAccessToken:`, error.message);
    }
    return { error: error.message };
  }
}
// Track info drawing function
function drawTrackInfo(ctx, track) {
  const cleanTrackName = track.name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~]/g, '');

  ctx.fillStyle = '#000000';
  const maxWidth = 550;
  const lineHeight = 30;
  let y = 40;

  // Track name
  ctx.font = 'bold 24px "Pixelated MS Sans Serif"';
  wrapText(ctx, cleanTrackName, 240, y, maxWidth, lineHeight);

  // Artists
  y += lineHeight + 10;
  ctx.font = '18px "Pixelated MS Sans Serif"';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  const artists = track.artists.map(artist => artist.name).join(', ');
  wrapText(ctx, artists, 240, y, maxWidth, lineHeight);

  // Album and duration
  y += lineHeight + 20;
  ctx.font = '14px "Pixelated MS Sans Serif"';
  const albumInfo = `Album: ${track.album.name}`;
  const duration = `Duration: ${Math.floor(track.duration_ms / 60000)}:${(Math.floor(track.duration_ms / 1000) % 60).toString().padStart(2, '0')}`;
  ctx.fillText(albumInfo, 240, y);
  ctx.fillText(duration, 240, y + 20);
}

// Improved no song screen renderer
function renderNoSongScreen(ctx, width, height, message = "No song currently playing") {
  // Draw background
  ctx.fillStyle = '#C0C0C0';
  ctx.fillRect(0, 0, width, height);
  // Title text
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 16px "Pixelated MS Sans Serif"';
  ctx.fillText('No song playing', 350, 130);
}

// Helper function for text wrapping
function wrapText(context, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = context.measureText(testLine);
    const testWidth = metrics.width;
    
    if (testWidth > maxWidth && n > 0) {
      context.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  context.fillText(line, x, y);
}

const PORT = process.env.PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using redirect URI: ${redirect_uri}`);
});