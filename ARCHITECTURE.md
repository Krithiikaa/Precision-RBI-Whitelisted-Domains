# Precision RBI — Architecture

This document describes the complete system architecture: how URLs are intercepted,
how pixels are streamed without VNC, how sessions live and die, the security trust
boundaries, honest capacity math for the dev machine, and production scaling.

---

## 1. System Architecture Diagram

```
User Types URL in Chrome
        │
        ▼
chrome.webNavigation.onBeforeNavigate (Extension)
        │
        ├─── Domain NOT in whitelist ──→ Normal Chrome navigation (nothing happens)
        │
        └─── Domain IN whitelist
                │
                ▼
        Extension → POST /api/start-session → nginx:443 → session-broker:3001
                │                                                │
                │                               ┌───────────────┘
                │                               ▼
                │              Dockerode: docker run precision-rbi-container
                │              (512MB RAM, 0.5 CPU, rbi-net isolated Docker network)
                │                               │
                │                    ┌──────────┴──────────────────────┐
                │                    │  RBI Container (internal only)   │
                │                    │                                  │
                │                    │  Xvfb :99  (virtual display)     │
                │                    │     │                            │
                │                    │  Chromium ──→ TARGET URL         │
                │                    │  (--remote-debugging-port=9222)  │
                │                    │     │                            │
                │                    │  frame-streamer.js               │
                │                    │  ├── CDP Page.startScreencast    │
                │                    │  │   → JPEG frames               │
                │                    │  ├── WebSocket server :7000      │
                │                    │  └── CDP Input.dispatch*         │
                │                    └──────────────────────────────────┘
                │                               │
                │                    ws://containerIp:7000  (Docker internal)
                │                               │
                │                    ┌──────────┴──────────┐
                │                    │   render-gateway      │
                │                    │   (port 3003)         │
                │                    │   WS relay service    │
                │                    └──────────────────────┘
                │                               │
                │         wss://SERVER_IP/render/{sessionId}  (via nginx TLS)
                │                               │
                ▼                               ▼
        viewer.html tab ←── Binary WebSocket ──┘
        HTML5 Canvas renders JPEG frames
        (pixel data only — no JS/HTML from target site reaches client)
                │
                │  Mouse/keyboard events (JSON) sent back via same WebSocket
                ▼
        render-gateway → frame-streamer → CDP Input → Chromium

Parallel Security Services:
  content-script.js → POST /api/bdr-event → bdr-service:3002
  Admin: browser → admin-console:3000 → session-broker / bdr-service / render-gateway
```

**Why no proxy is needed:** interception happens *inside the browser* via the
`webNavigation` API. There is no PAC file, no system proxy, no DNS change, and no
certificate to import on the client. The extension is the only component that can
see a URL before Chrome commits to loading it, and it redirects the tab to
`loading.html` synchronously, then to `viewer.html` once the session is ready.

---

## 2. Rendering Protocol Detail

```
CDP Page.startScreencast produces JPEG frames at configurable quality + FPS.

Frame journey:
  Container (Chromium CDP) → frame-streamer.js (Buffer.from(data, 'base64'))
    → WebSocket binary message → render-gateway (zero-copy passthrough)
    → nginx (WebSocket proxy, buffering off)
    → User's Chrome (ws.onmessage ArrayBuffer)
    → createImageBitmap(new Blob([buffer], {type:'image/jpeg'}))
    → ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

Input journey (reverse):
  Canvas mousemove → scale to remote coords → JSON WS message
    → nginx → render-gateway (passthrough)
    → frame-streamer.js (JSON.parse)
    → CDP Input.dispatchMouseEvent({ type:'mouseMoved', x, y })
    → Chromium moves cursor in virtual display

Typical performance on LAN:
  Frame size:  50–150 KB/frame (JPEG quality 78, 1280×720)
  Target FPS:  20fps
  Bandwidth:   1–3 MB/s per session
  Latency:     20–80ms on local LAN
  7 sessions:  7–21 MB/s total → well within 1Gbps LAN capacity
```

**Message discrimination on the client:** the viewer sets
`ws.binaryType = 'arraybuffer'`. In `onmessage`, `typeof event.data === 'string'`
means a JSON control message (`meta` / `ping` / `pong` / `error`); otherwise it is
a raw JPEG `ArrayBuffer`. The `meta` frame carries `{width, height, fps}` and is
used to set the logical canvas resolution and the coordinate-scaling factors.

**Coordinate scaling (input correctness at any window size):**

```
scaleX = remoteWidth  / canvas.clientWidth
scaleY = remoteHeight / canvas.clientHeight
remoteX = round((event.clientX - rect.left) * scaleX)
remoteY = round((event.clientY - rect.top)  * scaleY)
```

`mousemove` is throttled to one event per animation frame (~60/s ceiling, coalesced)
to avoid flooding the relay; clicks, wheel, keydown/keyup, and printable `char`
events are sent immediately.

---

## 3. Why Not VNC?

```
VNC Stack (what we do NOT use):
  Xvfb → x11vnc → VNC protocol → websockify (VNC→WS bridge) → noVNC (JS library)
  Components: 4 extra processes per container, ~80MB extra RAM per session
  Protocol: RFB (Remote Framebuffer) from 1998
  Encoding: Various (ZRLE, Tight, Hextile) — browser must decode in noVNC JS
  Overhead: Base64 encoding round-trip in noVNC, JS decoder in browser

CDP Canvas Stack (what we USE — industry standard):
  Xvfb → Chromium (built-in CDP) → JPEG frame → WebSocket binary → Canvas API
  Components: 0 extra processes (CDP is built into Chromium)
  Protocol: CDP + binary WebSocket + HTML5 Canvas drawImage
  Encoding: JPEG (hardware-accelerated on modern GPUs, quality configurable)
  Overhead: None — native browser APIs decode JPEG and draw to Canvas

Zscaler / Menlo Security use the equivalent of our CDP approach:
  "The browser receives only a stream of pixels. No DOM, no JS, no cookies
   from the target site ever reach the endpoint."
```

The single most important consequence: removing x11vnc + websockify saves roughly
80 MB of RAM **per session**. On the 7.21 GB dev box that is the difference between
~5 and ~7 concurrent sessions.

---

## 4. Session Lifecycle

### 4.1 Startup path (numbered)

1. User navigates to a whitelisted domain.
2. `webNavigation.onBeforeNavigate` (frame 0) fires in the service worker.
3. Service worker redirects the tab to `loading/loading.html?domain=…`
   (synchronous — the original URL never commits in the local browser).
4. Service worker `POST /api/start-session { userId, targetUrl }`.
5. Broker checks capacity; if `active ≥ 7` → returns `503 capacity_exceeded`
   and the loading page shows the capacity message.
6. Broker checks for an existing session for this `userId` (multi-tab reuse). If
   found, it returns that session immediately (no new container).
7. Otherwise the broker allocates an internal frame port (7000–7100),
   `docker.createContainer(...)` with 512 MB / 0.5 CPU / tmpfs / no-new-privileges,
   starts it, resolves its `rbi-net` IP, and polls `http://ip:port+1/health`
   until `ready:true` (max 20s).
8. Broker stores the session in Redis and `POST /internal/register-session` to the
   render-gateway.
9. Broker returns `{ sessionId, renderWsUrl, streamMode:'canvas' }`.
10. Service worker redirects the tab to
    `viewer.html?renderWsUrl=…&sessionId=…&url=…&streamMode=canvas`.
11. `viewer.js` opens `wss://SERVER_IP/render/{id}` → nginx → render-gateway →
    `ws://containerIp:7000` (frame-streamer). Frames begin; the overlay hides.

### 4.2 Teardown paths (all three independent, all idempotent)

- **PATH 1 — tab closed:** `chrome.tabs.onRemoved` → `POST /api/end-session`
  (only if no other tab is still using the session).
- **PATH 2 — heartbeat watchdog:** the service worker pings `POST /api/heartbeat`
  on a `chrome.alarms` timer (~24s). The broker's 10s watchdog kills any session
  whose heartbeat is missing or older than `HEARTBEAT_TIMEOUT_MS` (30s).
- **PATH 3 — viewer WS close / tab unload:** `viewer.js` sends `navigator.sendBeacon`
  to `POST /api/end-session` (a beacon survives tab close where `fetch` is cancelled).

`end-session` is idempotent: if the session is already gone it returns
`{ success:true, alreadyGone:true }`; Docker `stop` swallows 304/404; the gateway
delete is a no-op if the session is unknown. Three concurrent calls for the same
`sessionId` are therefore safe.

---

## 5. Security Model

**Trust boundary:** the user's machine is treated as untrusted with respect to the
isolated site, and the isolated site is treated as untrusted with respect to the
user's machine. The render-gateway is the only bridge, and it carries only opaque
bytes (JPEG out, JSON input in).

**What never reaches the client:**
- Target-site JavaScript, HTML, or DOM
- Target-site cookies, localStorage, or tokens
- Any file downloaded by the target site (DLP-blocked by policy)

**What the client receives:** JPEG pixel frames only. The page cannot be scraped
from the DOM because there is no DOM on the client — only a `<canvas>` with drawn
pixels. The content-script/watermark module additionally poisons `getImageData`,
`toDataURL`, and `toBlob` on non-exempt canvases, injects a confidential watermark,
blocks clipboard copy/cut/paste, and reports violation attempts to the bdr-service.

**Network exposure:** frame-streamer ports 7000–7100 are bound only on the internal
`rbi-net` Docker network — never on the host interface. The only externally
reachable endpoints are nginx :80/:443. TLS terminates at nginx.

**BDR (Behavioral Detection & Response):** repeated violation attempts (≥3 of the
same type within a 5-minute window) flag the user for one hour; flagged users are
highlighted in the admin console.

---

## 6. Dev Machine Capacity Analysis

Host: Dell DC15255 · AMD Ryzen 3 7320U (8 threads) · 7.21 GiB RAM · Kali rolling.

| Component | RAM (approx) |
|-----------|-------------:|
| OS + Xfce desktop baseline | ~1.0 GB |
| redis | ~30 MB |
| session-broker (Node) | ~80 MB |
| render-gateway (Node) | ~80 MB |
| bdr-service (Node) | ~60 MB |
| admin-console (Node + static) | ~90 MB |
| nginx | ~20 MB |
| **Backend + OS overhead subtotal** | **~1.7 GB** |
| Free for RBI containers | ~3.75 GB |
| Per RBI container (hard cap) | 0.512 GB |
| **Max concurrent sessions** | **⌊3.75 / 0.512⌋ = 7** |

CPU: each container is capped at 0.5 core (`CpuQuota 50000 / CpuPeriod 100000`).
Seven containers request 3.5 cores of the 8 available threads, leaving headroom for
the backend and OS. The hard cap is enforced in the broker (`503` on the 8th), and
the admin console warns at 5 active sessions (`CAPACITY_WARN_AT`).

---

## 7. Production Scaling

| Tier | Concurrent users | CPU / RAM / Disk | Example instance | Est. cost/mo |
|------|-----------------:|------------------|------------------|-------------:|
| Small | up to 20 | 8c / 16 GB / 100 GB SSD | AWS c5.2xlarge · Azure D4s v3 | ~$120–130 |
| Medium | up to 50 | 16c / 32 GB / 200 GB SSD | AWS c5.4xlarge | ~$280–300 |
| Large | up to 100 | 32c / 64 GB / 500 GB SSD | AWS c5.9xlarge class | ~$550–580 |

Capacity scales linearly with RAM (≈0.512 GB/session) until CPU or network becomes
the bottleneck. For multi-host scale-out, the broker and render-gateway are
stateless apart from Redis; run several render-gateway replicas behind nginx and
shard containers across worker hosts, with Redis as the shared session registry.

**Network is usually the real ceiling:** at ~1 MB/s per session, 100 sessions is
~100 MB/s (0.8 Gbps) of egress — provision accordingly and keep users on the same
LAN / region as the server to keep latency under ~80 ms.

---

## 8. Feature Parity vs Zscaler Cloud Browser Isolation

| Capability | Precision RBI | Zscaler CBI |
|------------|:-------------:|:-----------:|
| Server-side pixel rendering (no client JS) | ✅ | ✅ |
| CDP / Canvas streaming (no VNC) | ✅ | ✅ |
| Per-user container isolation | ✅ | ✅ |
| Selective domain isolation (whitelist) | ✅ | ✅ |
| Clipboard / download DLP | ✅ (policy) | ✅ |
| Watermarking | ✅ | ✅ |
| Multi-tab reuse per user | ✅ | ✅ |
| Behavioral detection / flagging | ✅ (basic) | ✅ (advanced) |
| Audio streaming | ❌ (see §9) | ✅ |
| File upload to isolated site | ❌ (see §9) | ✅ |
| GPU-accelerated rendering | ❌ (software) | ✅ |
| Global SFU / multi-region edge | ❌ (single host) | ✅ |
| WebRTC video transport | ⚠️ stubbed | ✅ |

---

## 9. Known Limitations vs Production Zscaler

```
Known Limitations vs Production Zscaler:
  1. Audio: CDP Page.startScreencast captures only video. No audio streaming.
     Production fix: add WebRTC audio track via GStreamer pipeline.
  2. File upload to isolated site: CDP does not support file picker events natively.
     Production fix: intercept CDP file chooser dialog, proxy file through gateway.
  3. Copy FROM isolated session: blocked by DLP policy in this build (by design).
     Production alternative: clipboard broker service with policy engine.
  4. Print: Not supported. Production fix: PDF printer driver in container.
  5. WebGL performance: Software WebGL in Xvfb, no GPU acceleration in container.
     Production fix: NVIDIA GPU passthrough with --gpus flag in Docker.
  6. Resolution: Fixed 1280×720. Production fix: dynamic resize via CDP
     Emulation.setVisibleSize() based on client viewport size.
```

The WebRTC transport path is documented and stubbed in `viewer.js`
(`streamMode === 'webrtc'`): the viewer negotiates an SDP offer/answer over a
`/signal` WebSocket and renders the resulting MediaStream by copying video frames
onto the same canvas (so watermark + screenshot poisoning still apply). When no
WebRTC publisher is available it falls back to Canvas mode, which is the complete,
always-available implementation.
