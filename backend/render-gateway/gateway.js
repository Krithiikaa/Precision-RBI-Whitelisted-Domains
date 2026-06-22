'use strict';
/* ============================================================================
 * Precision RBI — render-gateway
 * ----------------------------------------------------------------------------
 * The single relay between the user's browser and an isolated RBI container.
 *
 *   client browser  ──wss──▶  nginx  ──ws──▶  render-gateway  ──ws──▶  frame-streamer
 *
 * Frames (binary JPEG) flow container ▶ client with ZERO re-encoding [HC-12].
 * Input events (JSON) flow client ▶ container. The client NEVER learns the
 * container's IP or internal port — those stay on rbi-net [HC-13].
 * ==========================================================================*/

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { URL }   = require('url');

const PORT    = parseInt(process.env.GATEWAY_PORT || '3003', 10);
const STARTED = Date.now();
const log     = (...a) => console.log(`[Gateway ${new Date().toISOString()}]`, ...a);

// sessionId -> { containerIp, frameStreamerPort }
const sessionRegistry = new Map();
// sessionId -> { clientWs, containerWs }  (one active relay per session)
const activeRelays = new Map();

const app = express();
app.use(express.json());

// ── Internal HTTP API (called by session-broker / admin-console) ────────────
app.post('/internal/register-session', (req, res) => {
  const { sessionId, containerIp, frameStreamerPort } = req.body || {};
  if (!sessionId || !containerIp || !frameStreamerPort) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  sessionRegistry.set(sessionId, { containerIp, frameStreamerPort: Number(frameStreamerPort) });
  log(`Registered session ${sessionId} -> ${containerIp}:${frameStreamerPort}`);
  return res.json({ ok: true });
});

app.delete('/internal/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  teardownRelay(sessionId, 'broker requested teardown');
  sessionRegistry.delete(sessionId);
  log(`Deregistered session ${sessionId}`);
  return res.json({ ok: true });
});

app.get('/internal/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - STARTED) / 1000),
    activeSessions: sessionRegistry.size,
    activeRelays: activeRelays.size,
  });
});

// ── HTTP + WS server ────────────────────────────────────────────────────────
const server = http.createServer(app);
// noServer mode: we route upgrades manually so we can validate the path.
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch (_) { socket.destroy(); return; }

  // Expect /render/{sessionId}  (signalling path /render/{id}/signal is WebRTC upgrade)
  const m = pathname.match(/^\/render\/([A-Za-z0-9_-]+)(\/signal)?$/);
  if (!m) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }

  const sessionId = m[1];
  const isSignal  = Boolean(m[2]);

  if (!sessionRegistry.has(sessionId)) {
    log(`Upgrade rejected: unknown session ${sessionId}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (clientWs) => {
    if (isSignal) {
      // WebRTC signalling relay (upgrade path). Canvas mode does not use this.
      handleSignalling(clientWs, sessionId);
    } else {
      handleCanvasRelay(clientWs, sessionId);
    }
  });
});

// ── Canvas relay: client <-> frame-streamer ─────────────────────────────────
function handleCanvasRelay(clientWs, sessionId) {
  const target = sessionRegistry.get(sessionId);
  if (!target) {
    safeSend(clientWs, JSON.stringify({ type: 'error', code: 'SESSION_NOT_REGISTERED' }));
    clientWs.close(1011, 'session not registered');
    return;
  }

  // [HC] Only one external client per session. Replace any prior one.
  teardownRelay(sessionId, 'replaced by new client');

  const containerUrl = `ws://${target.containerIp}:${target.frameStreamerPort}`;
  log(`Session ${sessionId}: opening relay to ${containerUrl}`);

  const containerWs = new WebSocket(containerUrl, { handshakeTimeout: 5000 });
  activeRelays.set(sessionId, { clientWs, containerWs, bytesToClient: 0, bytesToContainer: 0 });

  containerWs.on('open', () => {
    log(`Session ${sessionId}: relay established`);
  });

  // container -> client : binary JPEG frames (zero-copy) + JSON control [HC-12]
  containerWs.on('message', (data, isBinary) => {
    const relay = activeRelays.get(sessionId);
    if (relay) relay.bytesToClient += data.length || 0;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // client -> container : JSON input events
  clientWs.on('message', (data, isBinary) => {
    const relay = activeRelays.get(sessionId);
    if (relay) relay.bytesToContainer += data.length || 0;
    if (containerWs.readyState === WebSocket.OPEN) {
      containerWs.send(data, { binary: isBinary });
    }
  });

  containerWs.on('close', (code) => {
    log(`Session ${sessionId}: container WS closed (${code})`);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1001, 'container closed');
    activeRelays.delete(sessionId);
  });

  clientWs.on('close', (code) => {
    log(`Session ${sessionId}: client WS closed (${code})`);
    if (containerWs.readyState === WebSocket.OPEN) containerWs.close(1000, 'viewer closed');
    activeRelays.delete(sessionId);
  });

  containerWs.on('error', (err) => {
    log(`Session ${sessionId}: container WS error ${err.message}`);
    safeSend(clientWs, JSON.stringify({ type: 'error', code: 'CONTAINER_UNAVAILABLE', detail: err.message }));
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'container unavailable');
    activeRelays.delete(sessionId);
  });

  clientWs.on('error', (err) => {
    log(`Session ${sessionId}: client WS error ${err.message}`);
    if (containerWs.readyState === WebSocket.OPEN) containerWs.close(1011, 'client error');
    activeRelays.delete(sessionId);
  });
}

// ── WebRTC signalling relay (documented upgrade path; canvas is the default) ─
function handleSignalling(clientWs, sessionId) {
  const target = sessionRegistry.get(sessionId);
  if (!target) { clientWs.close(1011, 'session not registered'); return; }
  // The container's frame-streamer would publish a GStreamer WebRTC stream and
  // exchange SDP/ICE over this channel. In this build the Canvas path is the
  // complete implementation; signalling simply relays JSON to the container's
  // frame port, where a WebRTC publisher can be enabled in a future revision.
  const containerWs = new WebSocket(`ws://${target.containerIp}:${target.frameStreamerPort}`);
  containerWs.on('open', () => safeSend(clientWs, JSON.stringify({ type: 'signal-ready' })));
  clientWs.on('message', (d) => { if (containerWs.readyState === WebSocket.OPEN) containerWs.send(d); });
  containerWs.on('message', (d) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(d); });
  const closeBoth = () => { try { clientWs.close(); } catch (_) {} try { containerWs.close(); } catch (_) {} };
  clientWs.on('close', closeBoth);
  containerWs.on('close', closeBoth);
  containerWs.on('error', closeBoth);
}

function teardownRelay(sessionId, reason) {
  const relay = activeRelays.get(sessionId);
  if (!relay) return;
  try { if (relay.clientWs.readyState === WebSocket.OPEN) relay.clientWs.close(1012, reason); } catch (_) {}
  try { if (relay.containerWs.readyState === WebSocket.OPEN) relay.containerWs.close(1012, reason); } catch (_) {}
  activeRelays.delete(sessionId);
}

function safeSend(ws, payload) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(payload); } catch (_) {}
}

// ── Throughput sampling (every 30s) ─────────────────────────────────────────
setInterval(() => {
  if (activeRelays.size === 0) return;
  for (const [id, r] of activeRelays.entries()) {
    const kbDown = (r.bytesToClient / 1024 / 30).toFixed(1);
    const kbUp   = (r.bytesToContainer / 1024 / 30).toFixed(1);
    log(`throughput session ${id}: ${kbDown} KB/s down, ${kbUp} KB/s up`);
    r.bytesToClient = 0;
    r.bytesToContainer = 0;
  }
}, 30000);

server.listen(PORT, () => log(`render-gateway listening on :${PORT}`));
