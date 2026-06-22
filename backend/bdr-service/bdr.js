'use strict';
/* ============================================================================
 * Precision RBI — bdr-service (Behaviour / Data-loss Reporting + Log store)
 * ----------------------------------------------------------------------------
 * - Collects DLP / behaviour events from the viewer (threats).
 * - Persists SESSION LOGS to a durable file on a volume so history survives
 *   session close AND service/host restarts. Each log row holds: date, time,
 *   device IP, URL visited, browsed time, threats captured, container RAM/CPU,
 *   and container name.
 * - Owns the admin-managed WHITELIST (defaults + custom), also persisted to the
 *   volume, served to the Chrome extension so admin edits reflect on the user.
 * ==========================================================================*/

const express = require('express');
const Redis   = require('ioredis');
const fs      = require('fs');
const path    = require('path');

const PORT      = parseInt(process.env.BDR_PORT || '3002', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const FLAG_THRESHOLD = parseInt(process.env.BDR_FLAG_THRESHOLD || '3', 10);
const DATA_DIR  = process.env.DATA_DIR || '/data';
const LOG_FILE  = path.join(DATA_DIR, 'session-logs.jsonl');
const WL_FILE   = path.join(DATA_DIR, 'whitelist.json');
const MAX_LOGS  = parseInt(process.env.MAX_LOGS || '50000', 10);

// Default whitelist — must mirror the extension's built-in list. Admin additions
// are layered on top and served to the extension via GET /api/whitelist.
const DEFAULT_WHITELIST = [
  'precisionit.co.in', 'www.precisionit.co.in',
  'innait.com', 'www.innait.com', 'prism.precisionit.co.in',
  'mail.google.com', 'drive.google.com', 'www.youtube.com', 'youtube.com',
  'sheets.google.com', 'docs.google.com', 'calendar.google.com',
  'slides.google.com', 'forms.google.com', 'meet.google.com',
  'chat.google.com', 'keep.google.com', 'sites.google.com',
  'jamboard.google.com', 'classroom.google.com', 'contacts.google.com',
  'photos.google.com', 'voice.google.com', 'maps.google.com',
  'news.google.com', 'accounts.google.com', 'workspace.google.com',
  'admin.google.com',
];

const VALID_TYPES = new Set([
  'CLIPBOARD_ATTEMPT', 'SCREENSHOT_ATTEMPT', 'MALICIOUS_EXTENSION',
  'OAUTH_EXFIL', 'KEYSTROKE_HOOK', 'DOWNLOAD_ATTEMPT',
]);

const redis = new Redis(REDIS_URL);
const app   = express();
app.use(express.json({ limit: '256kb' }));
const log = (...a) => console.log(`[BDR ${new Date().toISOString()}]`, ...a);

// ── Durable storage helpers ────────────────────────────────────────────────
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

function appendSessionLog(record) {
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(record) + '\n'); }
  catch (e) { log(`session-log write failed: ${e.message}`); }
}

function readSessionLogs() {
  try {
    const txt = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = txt.split('\n').filter(Boolean);
    // Cap memory: keep the most recent MAX_LOGS lines.
    const tail = lines.slice(-MAX_LOGS);
    return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function loadCustomWhitelist() {
  try { return JSON.parse(fs.readFileSync(WL_FILE, 'utf8')); }
  catch (_) { return []; }
}
function saveCustomWhitelist(list) {
  try { fs.writeFileSync(WL_FILE, JSON.stringify([...new Set(list)], null, 2)); }
  catch (e) { log(`whitelist write failed: ${e.message}`); }
}

// ── POST /api/bdr-event ─────────────────────────────────────────────────────
app.post('/api/bdr-event', async (req, res) => {
  const { type, url, userId, sessionId, details } = req.body || {};
  if (!type || !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: 'invalid_type', valid: [...VALID_TYPES] });
  }
  const uid = String(userId || 'anonymous');
  const sid = String(sessionId || '');
  const event = { type, url: String(url || ''), userId: uid, sessionId: sid, details: details || {}, timestamp: Date.now() };

  log('EVENT', JSON.stringify(event));

  // rolling list (last 1000)
  await redis.lpush('bdr:events', JSON.stringify(event));
  await redis.ltrim('bdr:events', 0, 999);

  // per-session threat counter (survives until the session log is written)
  if (sid) await redis.incr(`bdr:threats:${sid}`);

  // per-user/type counter, 5-minute window → flag threshold
  const counterKey = `bdr:${uid}:${type}`;
  const count = await redis.incr(counterKey);
  if (count === 1) await redis.expire(counterKey, 300);
  if (count >= FLAG_THRESHOLD) {
    await redis.set(`bdr:flagged:${uid}`, 'true', 'EX', 3600);
    log(`User ${uid} FLAGGED (${type} x${count} in 5min)`);
  }

  return res.json({ received: true, count, flagged: count >= FLAG_THRESHOLD });
});

// ── GET /api/bdr-events ─────────────────────────────────────────────────────
app.get('/api/bdr-events', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '20', 10)));
  const filterUser = req.query.userId || null;
  const filterType = req.query.type || null;

  const raw = await redis.lrange('bdr:events', 0, 999);
  let events = raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  if (filterUser) events = events.filter((e) => e.userId === filterUser);
  if (filterType) events = events.filter((e) => e.type === filterType);

  const total = events.length;
  const start = (page - 1) * limit;
  return res.json({ page, limit, total, totalPages: Math.ceil(total / limit), events: events.slice(start, start + limit) });
});

// ── GET /api/bdr-flagged ────────────────────────────────────────────────────
app.get('/api/bdr-flagged', async (_req, res) => {
  const keys = await redis.keys('bdr:flagged:*');
  const flagged = [];
  for (const k of keys) {
    const ttl = await redis.ttl(k);
    flagged.push({ userId: k.replace('bdr:flagged:', ''), expiresInSec: ttl });
  }
  return res.json({ flagged });
});

// ── POST /api/session-log (called by the broker when a session ends) ────────
// Persists a complete, durable session record. Threat count is taken from this
// service's own per-session counter so it is accurate even after the session.
app.post('/api/session-log', async (req, res) => {
  const b = req.body || {};
  const sid = String(b.sessionId || '');
  if (!sid) return res.status(400).json({ error: 'missing_sessionId' });

  let threats = 0;
  try { threats = parseInt((await redis.get(`bdr:threats:${sid}`)) || '0', 10); } catch (_) {}

  const started = Number(b.startedAt) || Date.now();
  const ended   = Number(b.endedAt)   || Date.now();
  const browsedMs = Math.max(0, ended - started);
  const d = new Date(started);

  const record = {
    sessionId:       sid,
    containerName:   String(b.containerName || ''),
    userId:          String(b.userId || ''),
    deviceIp:        String(b.deviceIp || ''),
    urlVisited:      String(b.urlVisited || ''),
    startedAt:       started,
    endedAt:         ended,
    date:            d.toISOString().slice(0, 10),
    time:            d.toTimeString().slice(0, 8),
    browsedTimeMs:   browsedMs,
    browsedTime:     fmtDur(browsedMs),
    threatsCaptured: threats,
    ramMB:           b.ramMB != null ? Number(b.ramMB) : null,
    cpuPct:          b.cpuPct != null ? Number(b.cpuPct) : null,
  };

  appendSessionLog(record);
  await redis.del(`bdr:threats:${sid}`);
  log(`SESSION-LOG ${sid} ${record.urlVisited} ${record.browsedTime} threats=${threats}`);
  return res.json({ ok: true });
});

// ── GET /api/session-logs (admin reads; filter + paginate) ──────────────────
app.get('/api/session-logs', (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit = Math.min(100000, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const q     = (req.query.q || '').toString().toLowerCase();

  let logs = readSessionLogs().reverse(); // newest first
  if (q) logs = logs.filter((r) =>
    [r.userId, r.deviceIp, r.urlVisited, r.containerName, r.date].join(' ').toLowerCase().includes(q));

  const total = logs.length;
  const start = (page - 1) * limit;
  return res.json({ page, limit, total, totalPages: Math.ceil(total / limit) || 1, logs: logs.slice(start, start + limit) });
});

// ── Whitelist (admin-managed, served to the extension) ──────────────────────
function fullWhitelist() {
  return [...new Set([...DEFAULT_WHITELIST, ...loadCustomWhitelist()])].sort();
}

app.get('/api/whitelist', (_req, res) => {
  res.json({ domains: fullWhitelist(), defaults: DEFAULT_WHITELIST, custom: loadCustomWhitelist() });
});

app.post('/api/whitelist', (req, res) => {
  let domain = String((req.body || {}).domain || '').trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain || !/^[a-z0-9.*-]+\.[a-z]{2,}$/.test(domain)) {
    return res.status(400).json({ error: 'invalid_domain' });
  }
  const custom = loadCustomWhitelist();
  if (!DEFAULT_WHITELIST.includes(domain) && !custom.includes(domain)) {
    custom.push(domain);
    saveCustomWhitelist(custom);
    log(`Whitelist + ${domain}`);
  }
  res.json({ ok: true, domains: fullWhitelist(), custom: loadCustomWhitelist() });
});

app.delete('/api/whitelist', (req, res) => {
  const domain = String((req.body || {}).domain || '').trim().toLowerCase();
  if (DEFAULT_WHITELIST.includes(domain)) {
    return res.status(400).json({ error: 'cannot_remove_default' });
  }
  const custom = loadCustomWhitelist().filter((d) => d !== domain);
  saveCustomWhitelist(custom);
  log(`Whitelist - ${domain}`);
  res.json({ ok: true, domains: fullWhitelist(), custom });
});

// ── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'bdr', logFile: LOG_FILE }));

function fmtDur(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return [h, m, ss].map((x) => String(x).padStart(2, '0')).join(':');
}

app.listen(PORT, () => log(`bdr-service listening on :${PORT} (logs: ${LOG_FILE})`));
