/* ============================================================================
 * Precision RBI — viewer client.
 *
 * Renders the server-side isolated browser using the HTML5 Canvas + binary
 * WebSocket pipeline. NO noVNC, NO VNC protocol of any kind.
 *
 *   server → client : binary ArrayBuffer (raw JPEG frame) | text JSON (meta/ping)
 *   client → server : text JSON (mouse / keyboard / wheel / disconnect)
 *
 * A WebRTC upgrade path is stubbed for streamMode === 'webrtc'; Canvas mode is
 * the complete, always-available implementation.
 * ==========================================================================*/
'use strict';

// ── URL params (provided by the background service worker) ───────────────────
const params      = new URLSearchParams(location.search);
const renderWsUrl  = params.get('renderWsUrl');
const sessionId    = params.get('sessionId');
const targetUrl    = params.get('url') || '';
const streamMode   = (params.get('streamMode') || 'canvas').toLowerCase();

// ── DOM ──────────────────────────────────────────────────────────────────────
const canvas       = document.getElementById('screen');
const ctx          = canvas.getContext('2d', { alpha: false, desynchronized: true });
const remoteVideo  = document.getElementById('remoteVideo');
const domainEl     = document.getElementById('domain');
const timerEl      = document.getElementById('timer');
const fpsEl        = document.getElementById('fps');
const latencyEl    = document.getElementById('latency');
const modePill     = document.getElementById('modePill');
const disconnectBtn = document.getElementById('disconnectBtn');
const overlay      = document.getElementById('overlay');
const ovTitle      = document.getElementById('ovTitle');
const ovSub        = document.getElementById('ovSub');
const ovCountdown  = document.getElementById('ovCountdown');

// ── State ──────────────────────────────────────────────────────────────────
let ws            = null;
let remoteWidth   = 1280;
let remoteHeight  = 720;
let connected     = false;
let manualClose   = false;
let reconnectDelay = 1000;     // exponential backoff 1s → 30s
let reconnectTimer = null;

let frameTimestamps = [];      // for FPS calc
let latencyMs      = null;
const startedAt    = Date.now();

let serverBase     = null;     // https origin for end-session beacon
let dlpPolicy      = { clipboard: true, downloads: true, watermark: true, screenshot: true };
let userName       = 'user';

// ── Init ─────────────────────────────────────────────────────────────────────
function init() {
  try {
    const u = new URL(renderWsUrl);
    serverBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch (_) { serverBase = null; }

  try { domainEl.textContent = new URL(targetUrl).hostname || targetUrl; }
  catch (_) { domainEl.textContent = targetUrl || 'isolated session'; }

  modePill.className = 'pill ' + (streamMode === 'webrtc' ? 'webrtc' : 'canvas');
  modePill.textContent = streamMode === 'webrtc' ? 'WebRTC' : 'Canvas';

  // Logical canvas resolution (updated by the meta frame).
  canvas.width  = remoteWidth;
  canvas.height = remoteHeight;
  paintIdle();

  loadPolicyThenStart();
  startClocks();
  installInputHandlers();
  installTeardownHandlers();
}

function loadPolicyThenStart() {
  // Read DLP policy + username from extension storage, then connect + apply DLP.
  try {
    chrome.storage.sync.get(['dlp', 'userId'], (cfg) => {
      if (cfg && cfg.dlp) dlpPolicy = { ...dlpPolicy, ...cfg.dlp };
      if (cfg && cfg.userId) userName = cfg.userId;
      applyDlp();
      connect();
    });
  } catch (_) {
    applyDlp();
    connect();
  }
}

// ── DLP / watermark enforcement (via window.PrecisionRBI) ────────────────────
function applyDlp() {
  const RBI = window.PrecisionRBI;
  if (!RBI) return;
  const report = (type, details) => reportBdr(type, details);

  if (dlpPolicy.watermark)  RBI.injectWatermark(userName);
  if (dlpPolicy.clipboard)  RBI.installClipboardBlock(report);
  // Exempt the live stream canvas so frame rendering still works.
  if (dlpPolicy.screenshot) RBI.installScreenshotBlock(report, canvas);
  RBI.installKeystrokeHookDetection(report);
  RBI.startExtensionScan(report);

  if (dlpPolicy.downloads) {
    window.addEventListener('beforeunload', () => {}, false);
    // Block obvious download triggers inside the viewer chrome itself.
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[download]');
      if (a) { e.preventDefault(); reportBdr('DOWNLOAD_ATTEMPT', { href: a.href }); }
    }, true);
  }
}

function reportBdr(type, details) {
  if (!serverBase) return;
  try {
    fetch(`${serverBase}/api/bdr-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type, url: targetUrl, userId: userName, sessionId,
        details: details || {}, timestamp: Date.now(),
      }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

// ── WebSocket connect (Canvas mode primary) ──────────────────────────────────
function connect() {
  if (streamMode === 'webrtc' && window.RTCPeerConnection) {
    connectWebRtc();
    return;
  }
  connectCanvas();
}

function connectCanvas() {
  showOverlay('Connecting to isolated session…', 'Establishing secure pixel stream');
  try {
    ws = new WebSocket(renderWsUrl);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    connected = true;
    reconnectDelay = 1000;
    hideOverlay();
    canvas.focus();
    startPingLoop();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      handleControlMessage(event.data);
      return;
    }
    // Binary JPEG frame.
    renderFrame(event.data);
  };

  ws.onclose = () => {
    connected = false;
    stopPingLoop();
    if (manualClose) return;
    endSession();              // teardown PATH (viewer side)
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will follow; nothing extra needed.
  };
}

function handleControlMessage(text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return; }
  switch (msg.type) {
    case 'meta':
      remoteWidth  = msg.width  || remoteWidth;
      remoteHeight = msg.height || remoteHeight;
      canvas.width  = remoteWidth;
      canvas.height = remoteHeight;
      break;
    case 'ping':
      send({ type: 'pong', ts: msg.ts });
      break;
    case 'pong':
      if (typeof msg.ts === 'number') latencyMs = Date.now() - msg.ts;
      break;
    case 'error':
      showOverlay('Session unavailable',
        msg.code === 'CONTAINER_UNAVAILABLE'
          ? 'The isolated browser is not reachable. Retrying…'
          : 'A streaming error occurred. Retrying…');
      break;
  }
}

// ── Frame rendering ──────────────────────────────────────────────────────────
async function renderFrame(arrayBuffer) {
  try {
    const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close && bitmap.close();
    recordFrame();
  } catch (_) {
    // Drop malformed frame silently.
  }
}

function recordFrame() {
  const now = performance.now();
  frameTimestamps.push(now);
  // Keep only the last second of timestamps.
  while (frameTimestamps.length && now - frameTimestamps[0] > 1000) {
    frameTimestamps.shift();
  }
}

function paintIdle() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ── Input handlers (coordinate-scaled) ───────────────────────────────────────
let pendingMove = null;   // throttled mousemove via rAF

function scaleCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const sx = remoteWidth  / (canvas.clientWidth  || rect.width);
  const sy = remoteHeight / (canvas.clientHeight || rect.height);
  const x = (e.clientX - rect.left) * sx;
  const y = (e.clientY - rect.top)  * sy;
  return { x: Math.round(x), y: Math.round(y) };
}

function modifiersOf(e) {
  return {
    ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey,
    altKey: !!e.altKey, metaKey: !!e.metaKey,
  };
}

function installInputHandlers() {
  canvas.addEventListener('mousemove', (e) => {
    const { x, y } = scaleCoords(e);
    pendingMove = { type: 'mousemove', x, y };
    requestMoveFlush();
  });

  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    const { x, y } = scaleCoords(e);
    send({ type: 'mousedown', x, y, button: e.button, clickCount: e.detail || 1, ...modifiersOf(e) });
  });

  canvas.addEventListener('mouseup', (e) => {
    const { x, y } = scaleCoords(e);
    send({ type: 'mouseup', x, y, button: e.button, clickCount: e.detail || 1, ...modifiersOf(e) });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e);
    send({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY });
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e);
    send({ type: 'contextmenu', x, y });
  });

  // Keyboard — capture while the canvas is focused.
  canvas.addEventListener('keydown', (e) => {
    // Let Ctrl+W close the browser tab intentionally.
    if (e.ctrlKey && (e.key === 'w' || e.key === 'W')) return;
    // Swallow keys the browser would otherwise act on, so they reach the remote.
    if (shouldPreventDefault(e)) e.preventDefault();
    send({ type: 'keydown', key: e.key, code: e.code, keyCode: e.keyCode, ...modifiersOf(e) });
    // Printable single characters → char event for reliable text insertion.
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      send({ type: 'char', char: e.key });
    }
  });

  canvas.addEventListener('keyup', (e) => {
    if (shouldPreventDefault(e)) e.preventDefault();
    send({ type: 'keyup', key: e.key, code: e.code, keyCode: e.keyCode, ...modifiersOf(e) });
  });
}

function shouldPreventDefault(e) {
  if (e.key === 'Tab') return true;
  if (e.key.startsWith('Arrow')) return true;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return true;
  return false;
}

function requestMoveFlush() {
  if (requestMoveFlush._scheduled) return;
  requestMoveFlush._scheduled = true;
  requestAnimationFrame(() => {
    requestMoveFlush._scheduled = false;
    if (pendingMove) { send(pendingMove); pendingMove = null; }
  });
}

// ── Ping loop (latency measurement) ──────────────────────────────────────────
let pingTimer = null;
function startPingLoop() {
  stopPingLoop();
  pingTimer = setInterval(() => send({ type: 'ping', ts: Date.now() }), 2000);
}
function stopPingLoop() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ── Clocks (timer / fps / latency display) ───────────────────────────────────
function startClocks() {
  setInterval(() => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const h = String(Math.floor(secs / 3600)).padStart(2, '0');
    const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
    const s = String(secs % 60).padStart(2, '0');
    timerEl.textContent = `${h}:${m}:${s}`;
    fpsEl.textContent = `${frameTimestamps.length} fps`;
    latencyEl.textContent = latencyMs == null ? '-- ms' : `${latencyMs} ms`;
  }, 1000);
}

// ── Send helper ──────────────────────────────────────────────────────────────
function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

// ── Reconnect ────────────────────────────────────────────────────────────────
function scheduleReconnect() {
  if (manualClose) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  let remaining = Math.ceil(delay / 1000);
  showOverlay('Connection lost', 'Reconnecting to isolated session…');
  ovCountdown.textContent = `Retry in ${remaining}s`;
  const countdown = setInterval(() => {
    remaining -= 1;
    ovCountdown.textContent = remaining > 0 ? `Retry in ${remaining}s` : 'Reconnecting…';
    if (remaining <= 0) clearInterval(countdown);
  }, 1000);
  reconnectTimer = setTimeout(() => { ovCountdown.textContent = ''; connectCanvas(); }, delay);
}

// ── Overlay helpers ──────────────────────────────────────────────────────────
function showOverlay(title, sub) {
  ovTitle.textContent = title;
  ovSub.textContent = sub || '';
  overlay.classList.remove('hidden');
}
function hideOverlay() {
  overlay.classList.add('hidden');
  ovCountdown.textContent = '';
}

// ── Teardown (PATH 3: viewer side) ───────────────────────────────────────────
function endSession() {
  if (!serverBase || !sessionId) return;
  const payload = JSON.stringify({ sessionId });
  // sendBeacon survives tab close where fetch would be cancelled.
  try {
    const blob = new Blob([payload], { type: 'application/json' });
    if (navigator.sendBeacon(`${serverBase}/api/end-session`, blob)) return;
  } catch (_) {}
  // Fallback for in-page disconnect (tab stays open).
  try {
    fetch(`${serverBase}/api/end-session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: payload, keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

function installTeardownHandlers() {
  disconnectBtn.addEventListener('click', () => {
    manualClose = true;
    send({ type: 'disconnect' });
    endSession();
    try { ws && ws.close(1000, 'user disconnect'); } catch (_) {}
    // Notify background to drop the session record, then close the tab.
    try { chrome.runtime.sendMessage({ type: 'CLOSE_SESSION', sessionId }, () => {}); } catch (_) {}
    setTimeout(() => { try { window.close(); } catch (_) {} }, 150);
  });

  window.addEventListener('beforeunload', () => {
    manualClose = true;
    endSession();
  });
}

// ── WebRTC upgrade path (stub — documented, falls back to Canvas) ────────────
function connectWebRtc() {
  showOverlay('Negotiating WebRTC stream…', 'Falling back to Canvas if unavailable');
  let pc, signalWs, settled = false;

  const fallback = (reason) => {
    if (settled) return;
    settled = true;
    try { pc && pc.close(); } catch (_) {}
    try { signalWs && signalWs.close(); } catch (_) {}
    // Canvas mode is always the complete implementation.
    modePill.className = 'pill canvas';
    modePill.textContent = 'Canvas';
    connectCanvas();
  };

  try {
    signalWs = new WebSocket(renderWsUrl + '/signal');
    signalWs.onerror = () => fallback('signal-error');
    signalWs.onclose = () => { if (!settled) fallback('signal-closed'); };

    pc = new RTCPeerConnection({ iceServers: [] }); // LAN: host candidates only
    pc.onicecandidate = (e) => {
      if (e.candidate && signalWs.readyState === WebSocket.OPEN) {
        signalWs.send(JSON.stringify({ type: 'ice', candidate: e.candidate }));
      }
    };
    pc.ontrack = (e) => {
      settled = true;
      remoteVideo.srcObject = e.streams[0];
      hideOverlay();
      pumpVideoToCanvas();
    };

    signalWs.onmessage = async (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.type === 'offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        signalWs.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
      } else if (msg.type === 'ice' && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (_) {}
      }
    };

    // If the gateway has no WebRTC publisher yet, fall back quickly.
    setTimeout(() => { if (!settled) fallback('timeout'); }, 6000);

    // Input still travels over a parallel Canvas WebSocket.
    connectInputOnlySocket();
  } catch (_) {
    fallback('exception');
  }
}

// Copies the WebRTC <video> frames onto the canvas so the watermark overlay
// (and screenshot poisoning) continue to apply uniformly.
function pumpVideoToCanvas() {
  const draw = () => {
    if (remoteVideo.readyState >= 2) {
      if (remoteVideo.videoWidth) {
        if (canvas.width !== remoteVideo.videoWidth) {
          canvas.width = remoteVideo.videoWidth;
          canvas.height = remoteVideo.videoHeight;
          remoteWidth = canvas.width; remoteHeight = canvas.height;
        }
        ctx.drawImage(remoteVideo, 0, 0, canvas.width, canvas.height);
        recordFrame();
      }
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

// In WebRTC mode, video arrives on the peer connection but input still uses the
// binary WebSocket relay (same protocol as Canvas mode).
function connectInputOnlySocket() {
  try {
    ws = new WebSocket(renderWsUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { connected = true; canvas.focus(); startPingLoop(); };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') handleControlMessage(event.data);
      // Binary frames ignored in WebRTC mode (video carries the picture).
    };
    ws.onclose = () => { connected = false; stopPingLoop(); };
  } catch (_) {}
}

// ── Go ───────────────────────────────────────────────────────────────────────
if (!renderWsUrl || !sessionId) {
  showOverlay('Invalid session', 'Missing connection parameters.');
} else {
  init();
}
