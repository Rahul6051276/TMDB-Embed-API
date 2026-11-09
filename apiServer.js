require('dotenv').config();
const express = require('express');
const cors = require('cors');
const os = require('os');
const { config, saveConfigPatch, OVERRIDE_PATH } = require('./utils/config');
const { authenticate, issueSession, requireAuth, getSession, updatePassword } = require('./utils/auth');
const path = require('path');
const { listProviders, getProvider, getCookieStats } = require('./providers/registry');
const { createProxyRoutes, processStreamsForProxy } = require('./proxy/proxyServer');
const { resolveImdbId } = require('./utils/tmdb');
const { applyFilters } = require('./utils/streamFilters');

const app = express();
app.set('trust proxy', 1);

// Conditionally mount proxy routes early so downstream handlers can use them
if (config.enableProxy) {
  console.log('[startup] enableProxy flag active: mounting proxy routes');
  createProxyRoutes(app);
} else {
  console.log('[startup] enableProxy flag disabled: proxy routes not mounted');
}

// --- Simple In-Memory Rate Limiting for /auth/login ---
const loginAttempts = new Map(); // key: ip, value: { count, first, last, lockedUntil }
const MAX_ATTEMPTS_WINDOW = 5; // attempts allowed
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes window
const BASE_LOCK_MS = 5 * 60 * 1000; // 5 minutes base lock

function getClientIp(req){
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function recordLoginFailure(ip){
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry) {
    entry = { count:1, first: now, last: now, lockedUntil:0 };
    loginAttempts.set(ip, entry);
    return entry;
  }
  // Reset window if outside timeframe and not locked
  if (now - entry.first > WINDOW_MS && now > entry.lockedUntil) {
    entry.count = 1;
    entry.first = now;
  } else {
    entry.count++;
  }
  entry.last = now;
  if (entry.count > MAX_ATTEMPTS_WINDOW) {
    // Exponential backoff lock: base * 2^(count - limit)
    const over = entry.count - MAX_ATTEMPTS_WINDOW;
    const lockMs = BASE_LOCK_MS * Math.min(8, Math.pow(2, over-1));
    entry.lockedUntil = now + lockMs;
  }
  return entry;
}

function canAttempt(ip){
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed:true };
  const now = Date.now();
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed:false, retryAfter: Math.ceil((entry.lockedUntil - now)/1000) };
  }
  if (now - entry.first > WINDOW_MS) {
    // Window passed; reset
    loginAttempts.delete(ip);
    return { allowed:true };
  }
  return { allowed:true };
}

function recordLoginSuccess(ip){
  // On success clear state to avoid lingering count
  loginAttempts.delete(ip);
}

// Guard against premature process.exit from imported legacy modules, but allow controlled restarts
const realProcessExit = process.exit.bind(process);
let allowControlledExit = false;
process.exit = function(code){
  if (allowControlledExit) return realProcessExit(code);
  console.warn('[diagnostic] Intercepted process.exit with code', code, new Error('exit trace').stack);
  // keep process alive for debugging
};
setImmediate(()=>console.log('[diagnostic] post-start setImmediate fired'));
app.use(cors());
app.use(express.json());

// --- Auth Routes (login before static serving) ---
app.post('/auth/login', (req,res) => {
  const { username, password } = req.body || {};
  const ip = getClientIp(req);
  const attemptState = canAttempt(ip);
  if (!attemptState.allowed) {
    res.setHeader('Retry-After', String(attemptState.retryAfter));
    return res.status(429).json({ success:false, error:'TOO_MANY_ATTEMPTS', retryAfter: attemptState.retryAfter });
  }
  if (!username || !password) return res.status(400).json({ success:false, error:'MISSING_CREDENTIALS' });
  if (!authenticate(username, password)) {
    const entry = recordLoginFailure(ip);
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfter = Math.ceil((entry.lockedUntil - Date.now())/1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success:false, error:'LOCKED', retryAfter });
    }
    return res.status(401).json({ success:false, error:'INVALID_CREDENTIALS', remaining: Math.max(0, MAX_ATTEMPTS_WINDOW - entry.count) });
  }
  recordLoginSuccess(ip);
  const token = issueSession(username);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${12*60*60}`);
  res.json({ success:true, username });
});

app.post('/auth/logout', (req,res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ success:true });
});

app.get('/auth/session', (req,res) => {
  const sess = getSession(req);
  if (!sess) return res.json({ authenticated:false });
  res.json({ authenticated:true, username: sess.u });
});

app.post('/auth/change-password', requireAuth, (req,res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ success:false, error:'MISSING_FIELDS' });
  const sess = req.session;
  if (!authenticate(sess.u, oldPassword)) return res.status(401).json({ success:false, error:'INVALID_OLD_PASSWORD' });
  if (newPassword.length < 8) return res.status(400).json({ success:false, error:'PASSWORD_TOO_SHORT' });
  if (!updatePassword(sess.u, newPassword)) return res.status(500).json({ success:false, error:'UPDATE_FAILED' });
  res.json({ success:true, message:'PASSWORD_UPDATED' });
});

// Protect config panel (HTML) explicitly before static middleware
app.get('/config.html', (req,res,next) => {
  const sess = getSession(req);
  if (!sess) return res.redirect(302, '/');
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','config.html'));
});

// Explicit root handler for login page to ensure no-store
app.get('/', (req,res) => {
  res.setHeader('Cache-Control','no-store, must-revalidate');
  res.setHeader('Pragma','no-cache');
  res.setHeader('Expires','0');
  res.sendFile(path.join(process.cwd(),'public','index.html'));
});

// Diagnostics for unexpected exits
process.on('beforeExit', (code) => {
  console.log('[diagnostic] beforeExit code=', code);
});
process.on('exit', (code) => {
  console.log('[diagnostic] exit code=', code);
});
process.on('uncaughtException', (err) => {
  console.error('[diagnostic] uncaughtException', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[diagnostic] unhandledRejection', reason);
});

// Periodic heartbeat
let hbCount = 0;
setInterval(()=>{
  hbCount++;
  if (hbCount % 6 === 0) {
    console.log('[diagnostic] heartbeat 60s elapsed, process alive');
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
  const fs = require('fs');
  let override = {};
  try { if (fs.existsSync(OVERRIDE_PATH)) override = JSON.parse(fs.readFileSync(OVERRIDE_PATH,'utf8')); } catch (e) {}
  res.json({ success:true, merged: config, override, overridePath: OVERRIDE_PATH });
});

app.post('/api/config', (req,res) => {
  const patch = req.body || {};
  if (patch.port) {
    const p = Number(patch.port); if (!Number.isFinite(p) || p<=0 || p>65535) return res.status(400).json({ success:false, error:'INVALID_PORT'});
    patch.port = p;
  }
  if (patch.defaultProviders && !Array.isArray(patch.defaultProviders)) return res.status(400).json({ success:false, error:'DEFAULT_PROVIDERS_NOT_ARRAY'});
  const ok = saveConfigPatch(patch);
  res.json({ success: ok, merged: config });
});

app.post('/api/restart', (req,res) => {
  const sess = getSession(req);
  if(!sess) return res.status(401).json({ success:false, error:'UNAUTHORIZED' });
  res.json({ success:true, message:'RESTARTING' });
  setTimeout(()=>{
    try {
      const fs = require('fs');
      const restartMarker = require('path').join(process.cwd(), 'restart.trigger');
      fs.writeFileSync(restartMarker, String(Date.now()));
    } catch (e) {}
    allowControlledExit = true;
    realProcessExit(0);
  }, 300);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'tmdb-embed-api', time: new Date().toISOString() });
});

app.get('/api/metrics', (req,res) => {
  res.json({
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
  const endpoints = [
    'GET /api/health', 'GET /api/metrics', 'GET /api/status',
    'GET /api/providers', 'GET /api/providers/:name',
    'GET /api/streams/:type/:tmdbId', 'GET /api/streams/:provider/:type/:tmdbId'
  ];
  const cookieRequiredProviders = new Set(['showbox']);
  const providers = listProviders().map(p => {
    const cookieRequired = cookieRequiredProviders.has(p.name);
    const cookieOk = !cookieRequired || (config.febboxCookies && config.febboxCookies.length > 0);
    return { name: p.name, enabled: p.enabled, cookieRequired, cookieOk };
  });
  res.json({ success:true, providerCheckTmdbId: config.providerCheckTmdbId, metrics, endpoints, providers });
});

app.get('/api/providers', (req,res) => {
  res.json({ success: true, providers: listProviders() });
});

app.get('/api/debug/env', (req,res) => {
  const cookieStats = getCookieStats ? getCookieStats() : null;
  res.json({ port: config.port, febboxCookieCount: config.febboxCookies.length, cookieStats });
});

app.get('/api/providers/:name', (req,res) => {
  const p = getProvider(req.params.name);
  if (!p) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  res.json({ success:true, provider:{ name: p.name, enabled: p.enabled } });
});

// 🔥 AUTOMATIC AGGREGATE STREAMS (Loads ALL available providers dynamically)
app.get('/api/streams/:type/:tmdbId', async (req,res) => {
  const { type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  try {
    metrics.streamRequests++;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    
    // Grab ALL registered providers automatically from the registry
    const allProviders = listProviders();
    const selectedProviders = Array.from(new Set(allProviders.map(p => p.name)));

    const providerTimings = {};
    const results = await Promise.all(selectedProviders.map(async name => {
      const prov = getProvider(name);
      if (!prov || !prov.enabled) return [];
      metrics.providerCalls[name] = (metrics.providerCalls[name]||0)+1;
      try {
        console.log(`[api] invoking provider ${name} for tmdbId=${tmdbId}`);
        const t0 = Date.now();
        const r = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{ } });
        providerTimings[name] = Date.now()-t0;
        console.log(`[api] provider ${name} returned ${Array.isArray(r)?r.length:0} streams`);
        return r;
      } catch (e) {
        console.error(`[api] provider ${name} failed:`, e.message);
        providerTimings[name] = null;
        return [];
      }
    }));
    let streams = results.flat();
    streams = applyFilters(streams, 'aggregate', config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    res.json({ success:true, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

// Provider-specific streams endpoint
app.get('/api/streams/:provider/:type/:tmdbId', async (req,res) => {
  const { provider, type, tmdbId } = req.params;
  if (!['movie','series'].includes(type)) return res.status(400).json({ success:false, error:'INVALID_TYPE' });
  const season = req.query.season ? Number(req.query.season) : null;
  const episode = req.query.episode ? Number(req.query.episode) : null;
  const prov = getProvider(provider);
  if (!prov) return res.status(404).json({ success:false, error:'PROVIDER_NOT_FOUND' });
  if (!prov.enabled) return res.status(503).json({ success:false, error:'PROVIDER_DISABLED' });
  try {
    metrics.streamRequests++;
    metrics.providerCalls[prov.name] = (metrics.providerCalls[prov.name]||0)+1;
    const tmdbType = type === 'movie' ? 'movie' : 'tv';
    const imdbId = await resolveImdbId(tmdbType, tmdbId); if (imdbId) metrics.tmdbToImdbLookups++;
    const t0 = Date.now();
    let streams = await prov.fetch({ tmdbId, type, season, episode, imdbId, filters:{} });
    const providerTimings = { [prov.name]: Date.now()-t0 };
    streams = applyFilters(streams, prov.name, config.minQualities, config.excludeCodecs);
    metrics.streamsReturned += streams.length;
    if (config.enableProxy) {
      const serverUrl = `${req.protocol}://${req.get('host')}`;
      streams = processStreamsForProxy(streams, serverUrl);
      streams = streams.map(s => { if (s && typeof s === 'object') { const { headers, ...rest } = s; return rest; } return s; });
    }
    res.json({ success:true, provider: prov.name, tmdbId, imdbId, count: streams.length, providerTimings, streams });
  } catch (e) {
    metrics.lastError = e.message;
    res.status(500).json({ success:false, error:'INTERNAL_ERROR', message:e.message });
  }
});

const PORT = config.port;
const HOST = process.env.BIND_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`TMDB Embed REST API listening on http://${HOST}:${PORT}`);
});
