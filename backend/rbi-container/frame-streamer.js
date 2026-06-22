// backend/rbi-container/frame-streamer.js
// CDP-based frame capture + input injection. NO VNC.
'use strict';

const CDP       = require('chrome-remote-interface');
const WebSocket = require('ws');
const http      = require('http');

const CDP_PORT       = parseInt(process.env.CDP_PORT       || '9222', 10);
const FRAME_WS_PORT  = parseInt(process.env.FRAME_WS_PORT  || '7000', 10);
const HEALTH_PORT    = parseInt(process.env.HEALTH_PORT    || String(FRAME_WS_PORT + 1), 10);
const JPEG_QUALITY   = parseInt(process.env.JPEG_QUALITY   || '78', 10);
const TARGET_FPS     = parseInt(process.env.TARGET_FPS     || '20', 10);
const DISPLAY_WIDTH  = parseInt(process.env.DISPLAY_WIDTH  || '1280', 10);
const DISPLAY_HEIGHT = parseInt(process.env.DISPLAY_HEIGHT || '720', 10);
const SESSION_ID     = process.env.SESSION_ID || 'unknown';

let cdpClient     = null;
let isReady       = false;
let activeClients = new Set();
let frameCount    = 0;
let lastFpsLog    = Date.now();

// ── Health HTTP server (GET /health) ───────────────────────────────────────
const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: isReady, sessionId: SESSION_ID, frameCount }));
  } else {
    res.writeHead(404).end();
  }
});
healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`[Streamer] Health server listening on :${HEALTH_PORT}`);
});

// ── WebSocket server for render-gateway connections ─────────────────────────
const wss = new WebSocket.Server({ port: FRAME_WS_PORT, host: '0.0.0.0' });
console.log(`[Streamer] WebSocket server listening on :${FRAME_WS_PORT}`);

wss.on('connection', (ws) => {
  console.log(`[Streamer] render-gateway connected (total: ${activeClients.size + 1})`);
  activeClients.add(ws);

  ws.send(JSON.stringify({
    type: 'meta',
    width: DISPLAY_WIDTH,
    height: DISPLAY_HEIGHT,
    fps: TARGET_FPS,
    sessionId: SESSION_ID,
  }));

  ws.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (!cdpClient) return;

    const { Input } = cdpClient;
    try {
      switch (event.type) {
        case 'mousemove':
          await Input.dispatchMouseEvent({
            type: 'mouseMoved',
            x: Math.round(event.x), y: Math.round(event.y),
            modifiers: event.modifiers || 0,
          });
          break;
        case 'mousedown':
          await Input.dispatchMouseEvent({
            type: 'mousePressed',
            x: Math.round(event.x), y: Math.round(event.y),
            button: ['left', 'middle', 'right'][event.button] || 'left',
            clickCount: event.clickCount || 1,
            modifiers: event.modifiers || 0,
          });
          break;
        case 'mouseup':
          await Input.dispatchMouseEvent({
            type: 'mouseReleased',
            x: Math.round(event.x), y: Math.round(event.y),
            button: ['left', 'middle', 'right'][event.button] || 'left',
            clickCount: event.clickCount || 1,
            modifiers: event.modifiers || 0,
          });
          break;
        case 'wheel':
          await Input.dispatchMouseEvent({
            type: 'mouseWheel',
            x: Math.round(event.x), y: Math.round(event.y),
            deltaX: event.deltaX || 0, deltaY: event.deltaY || 0,
            modifiers: event.modifiers || 0,
          });
          break;
        case 'keydown':
          await Input.dispatchKeyEvent({
            type: 'keyDown',
            key: event.key, code: event.code,
            windowsVirtualKeyCode: event.keyCode || 0,
            modifiers: buildModifiers(event),
          });
          break;
        case 'keyup':
          await Input.dispatchKeyEvent({
            type: 'keyUp',
            key: event.key, code: event.code,
            windowsVirtualKeyCode: event.keyCode || 0,
            modifiers: buildModifiers(event),
          });
          break;
        case 'char':
          await Input.dispatchKeyEvent({
            type: 'char',
            text: event.char, unmodifiedText: event.char,
          });
          break;
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', ts: event.ts, serverTs: Date.now() }));
          break;
        case 'disconnect':
          console.log('[Streamer] Client requested disconnect');
          ws.close(1000, 'client disconnect');
          break;
      }
    } catch (err) {
      console.error(`[Streamer] Input dispatch error: ${err.message}`);
    }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    console.log(`[Streamer] render-gateway disconnected (total: ${activeClients.size})`);
  });
  ws.on('error', (err) => {
    console.error(`[Streamer] WS error: ${err.message}`);
    activeClients.delete(ws);
  });
});

// ── CDP connection + screencast ─────────────────────────────────────────────
async function connectCDP(retryCount = 0) {
  try {
    console.log(`[Streamer] Connecting to CDP on port ${CDP_PORT}...`);
    const client = await CDP({ port: CDP_PORT });
    const { Page, Runtime, Network } = client;

    await Network.enable();
    await Page.enable();
    await Runtime.enable();

    await Page.startScreencast({
      format: 'jpeg',
      quality: JPEG_QUALITY,
      maxWidth: DISPLAY_WIDTH,
      maxHeight: DISPLAY_HEIGHT,
      everyNthFrame: Math.max(1, Math.round(30 / TARGET_FPS)),
    });

    Page.screencastFrame(async ({ data, sessionId: cdpSessionId }) => {
      Page.screencastFrameAck({ sessionId: cdpSessionId }).catch(() => {});
      frameCount++;

      const now = Date.now();
      if (now - lastFpsLog > 10000) {
        const elapsed = (now - lastFpsLog) / 1000;
        console.log(`[Streamer] FPS: ${(frameCount / elapsed).toFixed(1)} | clients: ${activeClients.size}`);
        frameCount = 0;
        lastFpsLog = now;
      }

      if (activeClients.size === 0) return;
      const frameBuffer = Buffer.from(data, 'base64');
      for (const ws of activeClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(frameBuffer, { binary: true }, (err) => {
            if (err) console.error(`[Streamer] Frame send error: ${err.message}`);
          });
        }
      }
    });

    cdpClient = client;
    isReady   = true;
    console.log(`[Streamer] CDP connected. Screencast active at ${TARGET_FPS}fps, JPEG quality ${JPEG_QUALITY}`);

    client.on('disconnect', () => {
      console.warn('[Streamer] CDP disconnected — will retry');
      cdpClient = null;
      isReady   = false;
      setTimeout(() => connectCDP(0), 2000);
    });
  } catch (err) {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
    console.warn(`[Streamer] CDP connect failed (${err.message}) — retry in ${delay}ms`);
    setTimeout(() => connectCDP(retryCount + 1), delay);
  }
}

function buildModifiers(event) {
  let mod = 0;
  if (event.altKey)   mod |= 1;
  if (event.ctrlKey)  mod |= 2;
  if (event.metaKey)  mod |= 4;
  if (event.shiftKey) mod |= 8;
  return mod;
}

connectCDP();
