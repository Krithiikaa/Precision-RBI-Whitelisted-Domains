#!/usr/bin/env bash
# ============================================================================
# init-certs.sh — generate a self-signed TLS certificate for nginx.
# Run ONCE before the first `docker-compose up`.
# ============================================================================
set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")" && pwd)/nginx/certs"
mkdir -p "$CERT_DIR"

# Pull SERVER_IP from .env if present, else default.
SERVER_IP="10.225.244.10"
if [[ -f "$(dirname "$0")/.env" ]]; then
  ENV_IP="$(grep -E '^SERVER_IP=' "$(dirname "$0")/.env" | head -n1 | cut -d= -f2 | tr -d '[:space:]')"
  [[ -n "${ENV_IP:-}" ]] && SERVER_IP="$ENV_IP"
fi

echo "[certs] Generating self-signed cert for IP/CN: ${SERVER_IP}"

# SAN config so the cert validates against the LAN IP (browsers require SAN).
cat > "${CERT_DIR}/openssl.cnf" <<CNF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
C  = IN
O  = Precision RBI
CN = ${SERVER_IP}
[v3_req]
# CA:TRUE so the self-signed cert can be imported as a trust anchor. Modern
# Chrome rejects a trusted self-signed *leaf* (no CA:TRUE) with
# ERR_CERT_AUTHORITY_INVALID even when it's in the NSS store, so this is
# required for `certutil -A -t "C,,"` trust to actually work.
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, digitalSignature, keyEncipherment, dataEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names
[alt_names]
IP.1  = ${SERVER_IP}
DNS.1 = localhost
IP.2  = 127.0.0.1
CNF

openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout "${CERT_DIR}/server.key" \
  -out    "${CERT_DIR}/server.crt" \
  -config "${CERT_DIR}/openssl.cnf"

chmod 600 "${CERT_DIR}/server.key"
echo "[certs] Certificate generated at nginx/certs/server.crt"
echo "[certs] Key generated at        nginx/certs/server.key"
echo
echo "NOTE: This is a self-signed certificate. Client browsers will warn on"
echo "first connect. For production, import server.crt as a trusted root via"
echo "your MDM, or use a CA-issued certificate."
