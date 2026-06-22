#!/bin/bash
# backend/rbi-container/entrypoint.sh
set -e

TARGET_URL="${TARGET_URL:-about:blank}"
SESSION_ID="${SESSION_ID:-unknown}"
CDP_PORT="${CDP_PORT:-9222}"
FRAME_WS_PORT="${FRAME_WS_PORT:-7000}"
DISPLAY_WIDTH="${DISPLAY_WIDTH:-1280}"
DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-720}"
RESOLUTION="${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24"

# Resolve the chromium binary (Debian: chromium; some images: chromium-browser).
CHROME_BIN="$(command -v chromium || command -v chromium-browser || echo chromium)"

echo "[RBI] Starting container — Session: ${SESSION_ID} — URL: ${TARGET_URL}"
echo "[RBI] Using browser binary: ${CHROME_BIN}"

# Virtual X11 display.
Xvfb :99 -screen 0 "${RESOLUTION}" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1
echo "[RBI] Xvfb started (PID ${XVFB_PID})"

# Chromium with remote debugging against the virtual display (NOT headless).
"${CHROME_BIN}" \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --window-size="${DISPLAY_WIDTH},${DISPLAY_HEIGHT}" \
  --window-position=0,0 \
  --start-maximized \
  --disable-extensions \
  --disable-plugins \
  --disable-background-networking \
  --disable-sync \
  --disable-translate \
  --no-first-run \
  --disable-default-apps \
  --disable-hang-monitor \
  --disable-client-side-phishing-detection \
  --disable-component-update \
  --disable-background-timer-throttling \
  --disable-renderer-backgrounding \
  --disable-features=TranslateUI \
  --disk-cache-dir=/home/chrome/.cache/chromium \
  --disk-cache-size=104857600 \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address=0.0.0.0 \
  "https://${TARGET_URL}" &
CHROMIUM_PID=$!
echo "[RBI] Chromium started (PID ${CHROMIUM_PID})"

# Wait for CDP.
echo "[RBI] Waiting for CDP on port ${CDP_PORT}..."
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
    echo "[RBI] CDP ready after ${i}s"
    break
  fi
  sleep 1
done

# frame-streamer.
node /app/frame-streamer.js &
STREAMER_PID=$!
echo "[RBI] frame-streamer started (PID ${STREAMER_PID})"

# Keep container alive until Chromium exits.
wait "${CHROMIUM_PID}"
echo "[RBI] Chromium exited — shutting down"
kill "${STREAMER_PID}" "${XVFB_PID}" 2>/dev/null || true
