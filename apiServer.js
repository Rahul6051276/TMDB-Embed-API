Require('dotenv').config();
Const express = require('express');
Const cors = require('cors');
Const os = require('os');
Const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
Const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
Const path = require('path');
Const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
Const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
Const { resolveImdbId } = require('./utils/tmdb');
Const { applyFilters } = require('./utils/streamFilters');

Const app = express();
app.set('trust proxy', 1);

// Conditionally mount proxy routes early so downstream handlers can use them
If (config.enableProxy) {
  Console.log('[startup] enableProxy flag active: mounting proxy routes');
  createProxyRoutes(app);
} else {
  Console.log('[startup] enableProxy flag disabled: proxy routes not mounted');
}

// --- Simple In-Memory Rate Limiting for /auth/login ---
Const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
Const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
Const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
Const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock

function getClientIp(req){
  Return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  Const now = Date.now();
  Let entry = loginAttempts.get(ip);
  If (!entry) {
    Entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    Return entry;
  }
  // Reset window if outside timeframe and not locked
  If (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    Entry.count = 1;
    Entry.first = now;
  } else {
    Entry.count++;
  }
  Entry.last = now;
  If (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    Const over = entry.count - MAX_ATTEMPTS_WINDOW;
    Const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    Entry.lockedUntil = now + lockMs;
  }
  Return entry;
}

function canAttempt(ip){
  Const entry = loginAttempts.get(ip);
  If (!entry) return { allowed:true };
  Const now = Date.now();
  If (entry.lockedUntil && now < entry.lockedUntil) {
    Return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  If (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    LoginAttempts.delete(ip);
    Return { allowed:true };
  }
  Return { allowed:true };
}

function recordLoginSuccess(ip){
  // On success clear state to avoid lingering count
  LoginAttempts.delete(ip);
}

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
Const realProcessExit = process.exit.bind(process);
Let allowControlledExit = false;
Process.exit = function(code){
  If (allowControlledExit) return realProcessExit(code);
  Console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));
app.use(cors());
app.use(express.json());

// --- Auth Routes (login before static serving) ---
app.post('/auth/login', (req,res) => {
  Const { username, password } = req.body || {};
  Const ip = getClientIp(req);
  Const attemptState = canAttempt(ip);
  If (!attemptState.allowed) {
    Res.setHeader('Retry-After', String(attemptState.retryAfter));
    Return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  If (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
  If (!authenticate(username, password)) {
    Const entry = recordLoginFailure(ip);
    If (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      Const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
      Res.setHeader('Retry-After', String(retryAfter));
      Return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
    }
    Return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
  }
  RecordLoginSuccess(ip);
  Const token = issueSession(username);
  Res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12*60*60}`);
  Res.json({ success:true, username });
});

app.post('/auth/logout', (req,res) => {
  Res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  Res.json({ success:true });
});

app.get('/auth/session', (req,res) => {
  Const sess = getSession(req);
  If (!sess) return res.json({ authenticated:false });
  Res.json({ authenticated:true, username: sess.u });
});

app.post('/auth/change-password', requireAuth, (req,res) => {
  Const { oldPassword, newPassword } = req.body || {};
  If (!oldPassword || !newPassword) return res.status(400).json({ success:false, error:'MISSING_FIELDS' });
  Const sess = req.session;
  If (!authenticate(sess.u, oldPassword)) return res.status(401).json({ success:false, error:'INVALID_OLD_PASSWORD' });
  If (newPassword.length < 8) return res.status(400).json({ success:false, error:'PASSWORD_TOO_SHORT' });
  If (!updatePassword(sess.u, newPassword)) return res.status(500).json({ success:false, error:'UPDATE_FAILED' });
  Res.json({ success:true, message:'PASSWORD_UPDATED' });
});

// Protect config panel (HTML) explicitly before static middleware
app.get('/config.html', (req,res,next) => {
  Const sess = getSession(req);
  If (!sess) return res.redirect(302, '/');
  Res.setHeader('Cache-Control','no-store, must-revalidate');
  Res.setHeader('Pragma','no-cache');
  Res.setHeader('Expires','0');
  Res.sendFile(path.join(process.cwd(),'public','config.html'));
});

// Explicit root handler for login page to ensure no-store
app.get('/', (req,res) => {
  Res.setHeader('Cache-Control','no-store, must-revalidate');
  Res.setHeader('Pragma','no-cache');
  Res.setHeader('Expires','0');
  Res.sendFile(path.join(process.cwd(),'public','index.html'));
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  Console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  Console.log('[diagnostic] exit code=', code);
});
process.on('uncaughtException', (err) => {
  Console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  Console.error('[diagnostic] unhandledRejection', reason);
});

// Periodic heartbeat
Let hbCount = 0;
setInterval(()=>{
  HbCount++;
  If (hbCount % 6 === 0) {
    Console.log('[diagnostic] heartbeat 60s elapsed, process alive');
  }
}, 10_000).unref();

// --- Metrics (in-memory) ---
const metrics = {
  startTime: Date.now(),
  requestsTotal: 0,
  streamRequests: 0,
  providerCalls: {},
  lastRequestAt: null,
  lastError: null,
  streamsReturned: 0,
  tmdbToImdbLookups: 0
};

app.use((req,res,next)=>{ metrics.requestsTotal++; metrics.lastRequestAt = Date.now(); next(); });
app.use(express.static(path.join(process.cwd(),'public')));

// Config API
app.get('/api/config', (req,res) => {
  Const fs = require('fs');
  Let override = {};
  Try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH,'utf8')); } catch (e) {}
  Res.json({ success:true, merged: config, override, overridePath: OVERRIDE_PATH });
});

app.post('/api/config', (req,res) => {
  Const patch = req.body || {};
  If (patch.port) {
    Const p = Number(patch.port); if (!Number.isFinite(p) || p<=0 || p>65535) return res.status(400).json({ success:false, error:'INVALID_PORT'});
    Patch.port = p;
  }
  If (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success:false, error:'DEFAULT_PROVIDERS_NOT_ARRAY'});
  Const ok = saveConfigPatch(patch);
  Res.json({ success: ok, merged: config });
});

app.post('/api/restart', (req,res) => {
  Const sess = getSession(req);
  If(!sess) return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  Res.json({ success:true, message:'RESTARTING' });
  SetTimeout(()=>{
    Try {
      Const fs = require('fs');
      Const restartMarker = require('path').join(process.cwd(), 'restart.trigger');
      Fs.writeFileSync(restartMarker, String(Date.now()));
    } catch (e) {}
    AllowControlledExit = true;
    RealProcessExit(0);
  }, 300);
});

app.get('/api/health', (req, res) => {
  Res.json({ ok: true, service: 'tmdb-embed-api', time: new Date().toISOString() });
});

app.get('/api/metrics', (req,res) => {
  Res.json({
    uptimeSeconds: Math.round((Date.now()-metrics.startTime)/1000),
    requestsTotal: metrics.requestsTotal,
    streamRequests: metrics.streamRequests,
    providerCalls: metrics.providerCalls,
    streamsReturned: metrics.streamsReturned,
    tmdbToImdbLookups: metrics.tmdbToImdbLookups,
    lastRequestAt: metrics.lastRequestAt,
    memoryMB: Math.round(process.memoryUsage().rss/1024/1024),
    loadAvg: os.loadavg ? os.loadavg() : [],
    nodeVersion: process.version
  });
});

app.get('/api/status', (req,res) => {
  Const endpoints = [
    'GET /api/health', 'GET /api/metrics', 'GET /api/status',
    'GET /api/providers', 'GET /api/providers/:name',
    'GET /api/streams/:type/:tmdbId', 'GET /api/streams/:provider/:type/:tmdbId'
  ];
  Const cookieRequiredProviders = new Set(['showbox']);
  Const providers = listProviders().map(p => {
    Const cookieRequired = cookieRequiredProviders.has(p.name);
    Const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
    Return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk };
  });
  Res.json({ success:true, providerCheckTmdbId: config.providerCheckTmdbId, metrics, endpoints, providers });
});

app.get('/api/providers', (req,res) => {
  Res.json({ success: true, providers: listProviders() });
});

app.get('/api/debug/env', (req,res) => {
  Const cookieStats = getCookieStats ? getCookieStats() : null;
  Res.json({ port: config.port, febboxCookieCount: config.febboxCookies.length, cookieStats });
});

app.get('/api/providers/:name', (req,res) => {
  Const p = getProvider(req.params.name);
  If (!p) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  Res.json({ success:true, provider:{ name: p.name, enabled: p.enabled } });
});

// 🔥 AUTOMATIC AGGREGATE STREAMS (Loads ALL available providers dynamically)
app.get('/api/streams/:type/:tmdbId', async (req,res) => {
  Const { type, tmdbId } = req.params;
  If (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  Const season = req.query.season ? Number(req.query.season) : null;
  Const episode = req.query.episode ? Number(req.query.episode) : null;
  Try {
    Metrics.streamRequests++;
    Const tmdbType = type === 'movie' ? 'movie' : 'tv';
    Const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    
    // Grab ALL registered providers automatically from the registry
    Const allProviders = listProviders();
    Const selectedProviders = Array.from(new Set(allProviders.map(p => p.name)));

    Const providerTimings = {};
    Const results = await Promise.all(selectedProviders.map(async name => {
      Const prov = getProvider(name);
      If (!prov || !prov.enabled) return [];
      Metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      Try {
        Console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        Const t0 = Date.now();
        Const r = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{ } });
        ProviderTimings[name] = Date.now()-t0;
        Console.log(`[api] provider ${name} returned ${Array.isArray(r)?r.length:0} streams`);
        Return r;
      } catch (e) {
        Console.error(`[api] provider ${name} failed:`, e.message);
        ProviderTimings[name] = null;
        Return [];
      }
    }));
    Let streams = results.flat();
    Streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    Metrics.streamsReturned += streams.length;
    If (config.enableProxy) {
      Const serverUrl = `${req.protocol}://${req.get('host')}`;
      Streams = processStreamsForProxy(streams, serverUrl);
      Streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    Res.json({ success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    Metrics.lastError = e.message;
    Res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Provider-specific streams endpoint
app.get('/api/streams/:provider/:type/:tmdbId', async (req,res) => {
  Const { provider, type, tmdbId } = req.params;
  If (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  Const season = req.query.season ? Number(req.query.season) : null;
  Const episode = req.query.episode ? Number(req.query.episode) : null;
  Const prov = getProvider(provider);
  If (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  If (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  Try {
    Metrics.streamRequests++;
    Metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;
    Const tmdbType = type === 'movie' ? 'movie' : 'tv';
    Const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    Const t0 = Date.now();
    Let streams = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} });
    Const providerTimings = { [prov.name]: Date.now()-t0 };
    Streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    Metrics.streamsReturned += streams.length;
    If (config.enableProxy) {
      Const serverUrl = `${req.protocol}://${req.get('host')}`;
      Streams = processStreamsForProxy(streams, serverUrl);
      Streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    Res.json({ success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    Metrics.lastError = e.message;
    Res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

Const PORT = config.port;
Const HOST = process.env.BIND_HOST || '0.0.0.0';
App.listen(PORT, HOST, () => {
  Console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
});
