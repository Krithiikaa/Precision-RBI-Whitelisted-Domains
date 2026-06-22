# backend/rbi-container/Dockerfile
# Spawned per-session by session-broker (NOT in docker-compose).
# Debian base: `chromium` is a real .deb here (Ubuntu 22.04 ships a snap stub
# that does not run inside containers). NO VNC packages are installed.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV NODE_VERSION=20

# System deps: Xvfb + Chromium + Node.js. No x11vnc / websockify / noVNC.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      xauth \
      curl \
      ca-certificates \
      gnupg \
      fonts-liberation \
      libnss3 \
      libxss1 \
      libasound2 \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Non-root chrome user.
RUN useradd -m -s /bin/bash chrome \
    && mkdir -p /home/chrome/.config/chromium \
    && chown -R chrome:chrome /home/chrome

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY frame-streamer.js ./
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R chrome:chrome /app

# Chrome state lives in tmpfs mounted at runtime by the broker.
VOLUME ["/tmp", "/home/chrome"]

# frame-streamer WebSocket port (internal rbi-net only — never host-bound).
EXPOSE 7000
# frame-streamer health HTTP port.
EXPOSE 7001

USER chrome
ENTRYPOINT ["/entrypoint.sh"]
