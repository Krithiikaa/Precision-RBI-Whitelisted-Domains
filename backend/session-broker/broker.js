'use strict';
/* ============================================================================
 * Precision RBI — session-broker
 * ----------------------------------------------------------------------------
 * Owns the lifecycle of per-session RBI containers. Each session spawns one
 * isolated Chromium container (512MB / 0.5 CPU) on the internal rbi-net. The
 * container's frame-streamer exposes a WebSocket on an INTERNAL port (never
 * bound to the host). The broker registers the session with render-gateway,
 * which relays frames to the client. No VNC anywhere in this pipeline.
 * ==========================================================================*/

const express  = require('express');
const Docker   = require('dockerode');
const Redis    = require('ioredis');
const axios    = require('axios');
const crypto   = require('crypto');

// ── Config ──────────────────────────────────────────────────────────────
const PORT               = parseInt(process.env.BROKER_PORT       || '3001', 10);
const SERVER_IP          = process.env.SERVER_IP                  || 'localhost';
const MAX_SESSIONS       = parseInt(process.env.MAX_SESSIONS       || '7', 10);
const CONTAINER_MEMORY   = parseInt(process.env.CONTAINER_MEMORY   || String(512 * 1024 * 1024), 10);
const CPU_QUOTA          = parseInt(process.env.CONTAINER_CPU_QUOTA  || '50000', 10);
const CPU_PERIOD         = parseInt(process.env.CONTAINER_CPU_PERIOD || '100000', 10);
const FRAME_PORT_MIN     = parseInt(process.env.FRAME_PORT_MIN     || '7000', 10);
const FRAME_PORT_MAX     = parseInt(process.env.FRAME_PORT_MAX     || '7100', 10);
const JPEG_QUALITY       = parseInt(process.env.JPEG_QUALITY       || '78', 10);
const TARGET_FPS         = parseInt(process.env.TARGET_FPS         || '20', 10);
const DISPLAY_WIDTH      = parseInt(process.env.DISPLAY_WIDTH      || '1280', 10);
const DISPLAY_HEIGHT     = parseInt(process.env.DISPLAY_HEIGHT     || '720', 10);
const RBI_IMAGE          = process.env.RBI_IMAGE                   || 'precision-rbi-container';
const RBI_NETWORK        = process.env.RBI_NETWORK                 || 'rbi-net';
const REDIS_URL          = process.env.REDIS_URL                   || 'redis://redis:6379';
const RENDER_GATEWAY_URL = process.env.RENDER_GATEWAY_URL          || 'http://render-gateway:3003';
const BDR_SERVICE_URL    = process.env.BDR_SERVICE_URL            || 'http://bdr-service:3002';
const HEARTBEAT_TIMEOUT  = parseInt(process.env.HEARTBEAT_TIMEOUT_MS || '30000', 10);
const VERSION            = process.env.SESSION_VERSION            || '2.0.0';
const STARTED_AT         = Date.now();

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const redis  = new Redis(REDIS_URL);
const app    = express();
app.use(express.json());

// ── Internal frame-streamer port pool (rbi-net only, never host-bound) ────
const availablePorts = new Set();
for (let p = FRAME_PORT_MIN; p <= FRAME_PORT_MAX; p++) availablePorts.add(p);
function allocatePort() {
  const it = availablePorts.values().next();
  if (it.done) return null;
  availablePorts.delete(it.value);
  return it.value;
}
function releasePort(port) {
  const p = parseInt(port, 10);
  if (Number.isInteger(p) && p >= FRAME_PORT_MIN && p <= FRAME_PORT_MAX) availablePorts.add(p);
}

// ── Startup concurrency limiter ───────────────────────────────────────────
// Booting Chromium + CDP is CPU/RAM/IO-heavy. Starting many containers at the
// same instant starves them all, so some miss the readiness timeout and 504.
// This semaphore caps how many containers boot at once; the rest queue briefly
// and start as slots free up (a settled container is cheap, so this is fast).
const MAX_CONCURRENT_STARTS = parseInt(process.env.MAX_CONCURRENT_STARTS || '2', 10);
let activeStarts = 0;
const startWaiters = [];
async function acquireStartSlot() {
  if (activeStarts >= MAX_CONCURRENT_STARTS) {
    await new Promise((resolve) => startWaiters.push(resolve));
  }
  activeStarts++;
}
function releaseStartSlot() {
  activeStarts--;
  const next = startWaiters.shift();
  if (next) next();
}

// ── Helpers ───────────────────────────────────────────────────────────────
const log = (...a) => console.log(`[Broker ${new Date().toISOString()}]`, ...a);
const sessionKey   = (id) => `session:${id}`;
const heartbeatKey = (id) => `session:${id}:heartbeat`;
const userIndexKey = (uid) => `user:${uid}:session`;

async function countActiveSessions() {
  const keys = await redis.keys('session:*');
  // Exclude :heartbeat companion keys
  return keys.filter((k) => !k.endsWith(':heartbeat')).length;
}

function newSessionId() {
  return crypto.randomBytes(9).toString('hex'); // 18 hex chars
}

// 45s (not 20s): when several containers start at once on a busy host, Chromium
// + CDP can take >20s to come up. A tight timeout tore the container down and
// returned 504 → the extension showed "Security server error" even though the
// session would have been fine a few seconds later.
async function waitForStreamerReady(containerIp, port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      // frame-streamer health server is on FRAME_WS_PORT+1 (HEALTH_PORT).
      const r = await axios.get(`http://${containerIp}:${port + 1}/health`, { timeout: 600 });
      if (r.data && r.data.ready === true) return true;
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (lastError) log(`waitForStreamerReady failed. Last error: ${lastError}`);
  return false;
}

// Sample a container's live RAM (MB) and CPU (%) via the Docker stats API.
async function sampleStats(containerId) {
  try {
    const s = await docker.getContainer(containerId).stats({ stream: false });
    const ramMB = s.memory_stats && s.memory_stats.usage ? Math.round(s.memory_stats.usage / 1048576) : null;
    let cpuPct = null;
    const cd = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sd = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
    const cpus = s.cpu_stats.online_cpus ||
      (s.cpu_stats.cpu_usage.percpu_usage ? s.cpu_stats.cpu_usage.percpu_usage.length : 1);
    if (sd > 0 && cd > 0) cpuPct = +((cd / sd) * cpus * 100).toFixed(1);
    return { ramMB, cpuPct };
  } catch (_) { return { ramMB: null, cpuPct: null }; }
}

// Write a durable session log to bdr-service (date, time, device IP, URL,
// browsed time, threats, RAM/CPU, container name). Best-effort.
async function writeSessionLog(sessionId, session) {
  try {
    await axios.post(`${BDR_SERVICE_URL}/api/session-log`, {
      sessionId,
      containerName: `rbi-${sessionId}`,
      userId:        session.userId || '',
      deviceIp:      session.userIp || '',
      urlVisited:    session.targetUrl || '',
      startedAt:     Number(session.startedAt) || Date.now(),
      endedAt:       Date.now(),
      ramMB:         session.ramMB != null && session.ramMB !== '' ? Number(session.ramMB) : null,
      cpuPct:        session.cpuPct != null && session.cpuPct !== '' ? Number(session.cpuPct) : null,
    }, { timeout: 3000 });
  } catch (e) { log(`session-log post failed for ${sessionId}: ${e.message}`); }
}

// Fully tear down a session: write its log, stop the gateway relay, stop the
// container, free the frame port and all redis keys (incl. the reuse index).
// Idempotent — safe from the API route, the watchdog, and the reuse path.
async function teardownSession(sessionId) {
  const session = await redis.hgetall(sessionKey(sessionId));
  if (!session || !session.containerId) {
    await redis.del(sessionKey(sessionId), heartbeatKey(sessionId));
    return false;
  }
  // Capture the log BEFORE we delete state. Sample stats one last time if we
  // never got a reading.
  if (session.ramMB == null || session.ramMB === '') {
    const st = await sampleStats(session.containerId);
    session.ramMB = st.ramMB; session.cpuPct = st.cpuPct;
  }
  await writeSessionLog(sessionId, session);

  try { await axios.delete(`${RENDER_GATEWAY_URL}/internal/session/${sessionId}`, { timeout: 2000 }); }
  catch (_) { /* gateway may already have dropped it */ }
  try { await docker.getContainer(session.containerId).stop({ t: 5 }); }
  catch (e) { if (e.statusCode !== 304 && e.statusCode !== 404) log(`stop error for ${sessionId}: ${e.message}`); }
  releasePort(session.frameStreamerPort);
  await redis.del(sessionKey(sessionId), heartbeatKey(sessionId));
  const idxKey = session.clientId || session.userId;
  if (idxKey) await redis.del(userIndexKey(idxKey));
  return true;
}

// ── POST /api/start-session ────────────────────────────────────────────────
app.post('/api/start-session', async (req, res) => {
  const { userId, userIp, targetUrl, clientId } = req.body || {};
  if (!userId || !targetUrl) {
    return res.status(400).json({ error: 'missing_fields', need: ['userId', 'targetUrl'] });
  }
  // [HC-11] Reuse is keyed per CLIENT (one browser tab), not per user, so each
  // tab gets its own isolated container instead of sharing one. This also stops
  // the render-gateway's one-viewer-per-session rule from making tabs fight over
  // a single stream. Falls back to userId if an older extension omits clientId.
  const idxKey = String(clientId || userId);

  // Normalise target up-front (store host only; container prepends https://).
  let host = String(targetUrl).trim();
  try { host = new URL(/^https?:\/\//i.test(host) ? host : `https://${host}`).hostname; }
  catch (_) { /* keep raw */ }

  try {
    // Reuse this tab's container only if it's already on the SAME domain.
    const existingId = await redis.get(userIndexKey(idxKey));
    if (existingId) {
      const exists = await redis.exists(sessionKey(existingId));
      if (exists) {
        const sess = await redis.hgetall(sessionKey(existingId));
        if (sess.targetUrl === host) {
          log(`Reusing session ${existingId} for client ${idxKey}`);
          await redis.set(heartbeatKey(existingId), Date.now(), 'EX', 60);
          return res.json({
            sessionId:   existingId,
            renderWsUrl: `wss://${SERVER_IP}/render/${existingId}`,
            streamMode:  'canvas',
            reused:      true,
          });
        }
        // Tab navigated to a different domain → replace its container.
        log(`Client ${idxKey} switched ${sess.targetUrl} -> ${host}; replacing ${existingId}`);
        await teardownSession(existingId);
      } else {
        // Stale index — clean it up.
        await redis.del(userIndexKey(idxKey));
      }
    }

    // [SEC-04 / HC-09] Capacity enforcement.
    const active = await countActiveSessions();
    if (active >= MAX_SESSIONS) {
      log(`Capacity exceeded (${active}/${MAX_SESSIONS}) — rejecting user ${userId}`);
      return res.status(503).json({ error: 'capacity_exceeded', active, max: MAX_SESSIONS });
    }

    const sessionId = newSessionId();

    // Stagger the resource-heavy boot so concurrent starts don't starve each
    // other into readiness timeouts. Released in the finally below.
    await acquireStartSlot();
    try {
    const framePort = allocatePort();
    if (framePort === null) {
      return res.status(503).json({ error: 'no_ports_available' });
    }

    log(`Spawning container for client=${idxKey} host=${host} session=${sessionId} framePort=${framePort}`);

    let container;
    try {
      container = await docker.createContainer({
        Image: RBI_IMAGE,
        name: `rbi-${sessionId}`,
        Env: [
          `TARGET_URL=${host}`,
          `SESSION_ID=${sessionId}`,
          `FRAME_WS_PORT=${framePort}`,
          `HEALTH_PORT=${framePort + 1}`,
          `CDP_PORT=9222`,
          `JPEG_QUALITY=${JPEG_QUALITY}`,
          `TARGET_FPS=${TARGET_FPS}`,
          `DISPLAY_WIDTH=${DISPLAY_WIDTH}`,
          `DISPLAY_HEIGHT=${DISPLAY_HEIGHT}`,
        ],
        HostConfig: {
          NetworkMode: RBI_NETWORK,
          AutoRemove: true,            // self-cleanup on stop
          Memory: CONTAINER_MEMORY,    // [HC-09] 512MB hard cap
          CpuQuota: CPU_QUOTA,         // [HC-09] 0.5 core
          CpuPeriod: CPU_PERIOD,
          // No PortBindings: frame port is rbi-net internal only [HC-13].
          // The image runs as non-root user `chrome` (uid/gid 1000). A tmpfs is
          // root-owned by default, so mounting it at /home/chrome makes the dir
          // unwritable for Chromium's profile/crashpad DB — Chromium dies with a
          // SIGTRAP (core dumped) before CDP comes up, the streamer never turns
          // ready, and start-session 504s after 20s (page spins forever). Mount
          // /home/chrome with uid/gid 1000 so the chrome user owns it.
          // /home/chrome holds the profile + a 100MB Chromium disk cache (see
          // entrypoint.sh) which speeds up repeat loads; size it to fit both.
          // tmpfs is RAM-backed and counts against Memory above, so keep totals
          // well under CONTAINER_MEMORY.
          Tmpfs: { '/tmp': 'size=256m,mode=1777', '/home/chrome': 'size=400m,uid=1000,gid=1000' },
          SecurityOpt: ['no-new-privileges'],
        },
      });
    } catch (e) {
      releasePort(framePort);
      log(`createContainer failed: ${e.message}`);
      return res.status(500).json({ error: 'container_create_failed', detail: e.message });
    }

    await container.start();

    // Resolve the container's IP on rbi-net.
    const info = await container.inspect();
    const netInfo = info.NetworkSettings.Networks[RBI_NETWORK];
    const containerIp = netInfo && netInfo.IPAddress;
    if (!containerIp) {
      await safeStop(container);
      releasePort(framePort);
      return res.status(500).json({ error: 'no_container_ip' });
    }

    // Wait for frame-streamer to confirm CDP is connected.
    const ready = await waitForStreamerReady(containerIp, framePort);
    if (!ready) {
      log(`frame-streamer never became ready for ${sessionId} — tearing down`);
      await safeStop(container);
      releasePort(framePort);
      return res.status(504).json({ error: 'streamer_not_ready' });
    }

    // Persist session.
    await redis.hset(sessionKey(sessionId), {
      containerId: info.Id,
      containerIp,
      frameStreamerPort: String(framePort),
      userId: String(userId),
      clientId: idxKey,
      userIp: String(userIp || ''),
      targetUrl: host,
      startedAt: String(Date.now()),
    });
    await redis.set(userIndexKey(idxKey), sessionId);
    await redis.set(heartbeatKey(sessionId), Date.now(), 'EX', 60);

    // Register relay with render-gateway.
    try {
      await axios.post(`${RENDER_GATEWAY_URL}/internal/register-session`, {
        sessionId, containerIp, frameStreamerPort: framePort,
      }, { timeout: 3000 });
    } catch (e) {
      log(`gateway register failed: ${e.message} — tearing down`);
      await safeStop(container);
      await redis.del(sessionKey(sessionId), userIndexKey(idxKey), heartbeatKey(sessionId));
      releasePort(framePort);
      return res.status(502).json({ error: 'gateway_register_failed' });
    }

    log(`Session ${sessionId} ready (container ${containerIp}:${framePort})`);
    return res.json({
      sessionId,
      renderWsUrl: `wss://${SERVER_IP}/render/${sessionId}`,
      streamMode:  'canvas',
      reused:      false,
    });
    } finally {
      releaseStartSlot();
    }
  } catch (e) {
    log(`start-session error: ${e.stack || e.message}`);
    return res.status(500).json({ error: 'internal_error', detail: e.message });
  }
});

// ── POST /api/end-session (idempotent — safe for all 3 teardown paths) ──────
app.post('/api/end-session', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'missing_sessionId' });

  try {
    const existed = await teardownSession(sessionId);
    if (existed) log(`Session ${sessionId} ended`);
    return res.json({ success: true, alreadyGone: !existed });
  } catch (e) {
    log(`end-session error: ${e.message}`);
    return res.status(500).json({ error: 'internal_error', detail: e.message });
  }
});

// ── POST /api/heartbeat ─────────────────────────────────────────────────────
app.post('/api/heartbeat', async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'missing_sessionId' });
  await redis.set(heartbeatKey(sessionId), Date.now(), 'EX', 60);
  return res.json({ ok: true });
});

// ── GET /api/sessions ───────────────────────────────────────────────────────
app.get('/api/sessions', async (_req, res) => {
  const keys = (await redis.keys('session:*')).filter((k) => !k.endsWith(':heartbeat'));
  const out = [];
  for (const k of keys) {
    const s = await redis.hgetall(k);
    const id = k.split(':')[1];
    const hb = await redis.get(heartbeatKey(id));
    out.push({
      sessionId: id,
      userId: s.userId,
      deviceIp: s.userIp || '',
      containerName: `rbi-${id}`,
      targetUrl: s.targetUrl,
      startedAt: Number(s.startedAt),
      durationMs: Date.now() - Number(s.startedAt || Date.now()),
      ramMB: s.ramMB != null && s.ramMB !== '' ? Number(s.ramMB) : null,
      cpuPct: s.cpuPct != null && s.cpuPct !== '' ? Number(s.cpuPct) : null,
      lastHeartbeat: hb ? Number(hb) : null,
      streamMode: 'canvas',
    });
  }
  return res.json({ sessions: out });
});

// ── GET /api/sessions/count ─────────────────────────────────────────────────
app.get('/api/sessions/count', async (_req, res) => {
  const count = await countActiveSessions();
  return res.json({ count, max: MAX_SESSIONS, available: Math.max(0, MAX_SESSIONS - count) });
});

// ── GET /api/health ─────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const count = await countActiveSessions();
  return res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    version: VERSION,
    activeContainers: count,
    maxSessions: MAX_SESSIONS,
  });
});

// ── Watchdog — kills sessions with no heartbeat for > HEARTBEAT_TIMEOUT ──────
async function safeStop(container) {
  try { await container.stop({ t: 5 }); }
  catch (e) { if (e.statusCode !== 304 && e.statusCode !== 404) log(`safeStop: ${e.message}`); }
}

setInterval(async () => {
  try {
    const keys = (await redis.keys('session:*')).filter((k) => !k.endsWith(':heartbeat'));
    for (const k of keys) {
      const id = k.split(':')[1];
      const hb = await redis.get(heartbeatKey(id));
      const age = hb ? Date.now() - Number(hb) : Infinity;
      if (age > HEARTBEAT_TIMEOUT) {
        log(`Watchdog: session ${id} stale (${age}ms) — cleaning up`);
        await teardownSession(id);
        continue;
      }
      // Live session → refresh its RAM/CPU sample for the admin view + final log.
      const s = await redis.hgetall(k);
      if (s.containerId) {
        const st = await sampleStats(s.containerId);
        if (st.ramMB != null) await redis.hset(k, { ramMB: String(st.ramMB), cpuPct: String(st.cpuPct ?? '') });
      }
    }
  } catch (e) {
    log(`Watchdog error: ${e.message}`);
  }
}, 10000);

app.listen(PORT, () => log(`session-broker v${VERSION} listening on :${PORT} (max ${MAX_SESSIONS} sessions)`));
