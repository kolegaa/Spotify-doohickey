var express = require('express');
var request = require('request');
var crypto = require('crypto');
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
const fetch = require('node-fetch').default;
const puppeteer = require('puppeteer');
require('dotenv').config();

var client_id = process.env.CLIENT_ID;
var client_secret = process.env.CLIENT_SECRET;
var redirect_uri = process.env.REDIRECT_URI;

const generateRandomString = (length) => {
  return crypto
    .randomBytes(60)
    .toString('hex')
    .slice(0, length);
}

var stateKey = 'spotify_auth_state';

var app = express();

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

app.get("/image", async function(req, res) {
  try {
    // Determine if we're running locally
    const isLocal = process.env.LOCAL === 'true';
    
    // Configure Puppeteer based on environment
    const browser = await puppeteer.launch({
      args: isLocal 
        ? [] // Default args for local
        : [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage'
          ],
      executablePath: isLocal
        ? undefined // Use default local Chrome
        : process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      headless: isLocal ? 'new' : true // New headless mode for local
    });

    const page = await browser.newPage();
    
    // Determine the URL to use
    const nowPlayingUrl = isLocal
      ? `http://localhost:${PORT}/nowplaying?access_token=${req.query.access_token}`
      : `${process.env.RENDER_EXTERNAL_URL}/nowplaying?access_token=${req.query.access_token}`;

    await page.setViewport({ width: 800, height: 240 });
    await page.goto(nowPlayingUrl, { 
      waitUntil: 'networkidle0',
      timeout: isLocal ? 30000 : 60000 // Longer timeout for Render
    });
    
    // Wait for elements to load
    await page.waitForSelector('.album-art', { timeout: 5000 });
    await page.waitForSelector('.track-name', { timeout: 5000 });

    const screenshot = await page.screenshot({
      type: 'png',
      omitBackground: true,
      fullPage: false
    });

    await browser.close();

    res.set('Content-Type', 'image/png');
    res.send(screenshot);

  } catch (error) {
    console.error('Error generating image:', error);
    res.status(500).send(`Error generating image: ${error.message}`);
  }
});

const PORT = process.env.PORT || 8888;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Using redirect URI: ${redirect_uri}`);
});