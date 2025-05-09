var express = require('express');
var request = require('request');
var crypto = require('crypto');
var cors = require('cors');
var querystring = require('querystring');
var cookieParser = require('cookie-parser');
const fetch = require('node-fetch').default;

var client_id = '78f32c1e9f56420ca1369b2e5f0b3c6e';
var client_secret = 'e68b0b7522e44f2486f59a35e6ed4919';
var redirect_uri = 'http://127.0.0.1:8888/callback';

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

app.get('/login', function(req, res) {
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

app.get("/image", async function(req, res) {
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
      
      if (response.status === 204) { // No content
        return { is_playing: false };
      }
      
      if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
      }
      
      return await response.json();
    } catch (error) {
      console.error('Error in fetchWebApi:', error);
      throw error;
    }
  }
  
  try {
    const currentlyPlaying = await fetchWebApi('me/player/currently-playing', 'GET');
    
    let htmlContent;
    if (!currentlyPlaying.is_playing || !currentlyPlaying.item) {
      htmlContent = `
        <html>
          <body>
            <h1>No song currently playing</h1>
            <p>Start playing something on Spotify!</p>
          </body>
        </html>
      `;
    } else {
      const track = currentlyPlaying.item;
      const progress = currentlyPlaying.progress_ms;
      
      htmlContent = `
        <html>
          <head>
            <title>Now Playing</title>
            <style>
              body { 
                font-family: Arial, sans-serif; 
                margin: 0;
                padding: 20px;
                background-color: #121212;
                color: white;
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
              }
              .container {
                display: flex;
                align-items: center;
                gap: 30px;
                max-width: 800px;
                width: 100%;
              }
              img.album-art {
                width: 200px;
                height: 200px;
                border-radius: 10px;
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
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
                color: #b3b3b3;
                margin-bottom: 25px;
              }
              .meta {
                font-size: 14px;
                color: #b3b3b3;
              }
              @media (max-width: 600px) {
                .container {
                  flex-direction: column;
                  text-align: center;
                }
                img.album-art {
                  width: 150px;
                  height: 150px;
                }
              }
            </style>
            <meta http-equiv="refresh" content="5">
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
                  Album: ${track.album.name}<br>
                  Duration: ${Math.floor(track.duration_ms / 60000)}:${(Math.floor(track.duration_ms / 1000) % 60).toString().padStart(2, '0')}
                </div>
              </div>
            </div>
          </body>
        </html>
      `;
    }
    
    res.send(htmlContent);
    
  } catch (error) {
    console.error('Error in /image route:', error);
    res.status(500).send(`
      <html>
        <body style="color: white; background-color: #121212">
          <h1>Error</h1>
          <p>${error.message}</p>
          <p>Please try again or check the console for more details.</p>
        </body>
      </html>
    `);
  }
});

console.log('Listening on http://127.0.0.1:8888/callback');
app.listen(8888);