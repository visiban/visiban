#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# init-prod.sh — one-time production setup: configure TLS mode, obtain
# certificates if needed, and start the production stack.
#
# TLS_MODE (set in .env):
#   letsencrypt  — (default) obtain a Let's Encrypt certificate via ACME
#   selfsigned   — generate a self-signed certificate for staging / internal use
#   none         — serve over plain HTTP (no TLS)
#
# Usage:
#   cp .env.example .env   # fill in DOMAIN, TLS_MODE, DJANGO_SECRET_KEY, etc.
#   chmod +x init-prod.sh
#   ./init-prod.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Load .env so DOMAIN, TLS_MODE, etc. are available
if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in the required values."
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DOMAIN:?Set DOMAIN=yourdomain.com in .env}"

TLS_MODE="${TLS_MODE:-letsencrypt}"

# ---------------------------------------------------------------------------
# Validate TLS_MODE
# ---------------------------------------------------------------------------
case "${TLS_MODE}" in
  letsencrypt|selfsigned|none) ;;
  *)
    echo "ERROR: Invalid TLS_MODE='${TLS_MODE}'. Must be one of: letsencrypt, selfsigned, none."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Select the nginx config template
# ---------------------------------------------------------------------------
if [[ "${TLS_MODE}" == "none" ]]; then
  echo ""
  echo "  ============================================================"
  echo "  WARNING: TLS_MODE=none — Visiban will serve over plain HTTP."
  echo "  Session cookies and API traffic will NOT be encrypted."
  echo "  Do NOT use this for deployments reachable from the public internet."
  echo "  ============================================================"
  echo ""
  cp nginx/app-http.conf.template nginx/active.conf.template
else
  cp nginx/app.conf.template nginx/active.conf.template
fi

# ---------------------------------------------------------------------------
# Certificate handling
# ---------------------------------------------------------------------------
CERT_DIR="certbot/conf/live/${DOMAIN}"

case "${TLS_MODE}" in
  letsencrypt)
    : "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL=admin@yourdomain.com in .env (required for TLS_MODE=letsencrypt)}"
    if [[ -d "${CERT_DIR}" ]]; then
      echo "==> Certificate already exists — skipping issuance."
    else
      echo "==> Requesting Let's Encrypt certificate for ${DOMAIN}..."
      echo "    (certbot will briefly bind port 80 to complete the ACME challenge)"
      mkdir -p certbot/conf certbot/www
      docker run --rm \
        -p 80:80 \
        -v "$(pwd)/certbot/conf:/etc/letsencrypt" \
        certbot/certbot certonly --standalone \
        --email "${CERTBOT_EMAIL}" \
        --agree-tos \
        --no-eff-email \
        -d "${DOMAIN}"
      echo "==> Certificate obtained."
    fi
    ;;

  selfsigned)
    echo ""
    echo "  ============================================================"
    echo "  WARNING: TLS_MODE=selfsigned — using a self-signed certificate."
    echo "  Browsers will show a security warning. This is intended for"
    echo "  staging, internal, or development environments only."
    echo "  ============================================================"
    echo ""
    if [[ -f "${CERT_DIR}/fullchain.pem" && -f "${CERT_DIR}/privkey.pem" ]]; then
      echo "==> Self-signed certificate already exists — skipping generation."
    else
      echo "==> Generating self-signed certificate for ${DOMAIN}..."
      mkdir -p "${CERT_DIR}"
      openssl req -x509 -nodes -newkey rsa:2048 \
        -days 365 \
        -keyout "${CERT_DIR}/privkey.pem" \
        -out "${CERT_DIR}/fullchain.pem" \
        -subj "/CN=${DOMAIN}" \
        -addext "subjectAltName=DNS:${DOMAIN}" \
        2>/dev/null
      echo "==> Self-signed certificate generated (valid for 365 days)."
    fi
    ;;

  none)
    # No certificates needed — ensure the certbot dirs exist so the nginx
    # volume mount does not fail (the dirs are mounted read-only but the
    # mount point must exist).
    mkdir -p certbot/conf certbot/www
    ;;
esac

# ---------------------------------------------------------------------------
# Set FORCE_INSECURE_COOKIES for plain-HTTP mode
# ---------------------------------------------------------------------------
if [[ "${TLS_MODE}" == "none" ]]; then
  # Append FORCE_INSECURE_COOKIES to .env if not already present, so Django
  # disables secure cookie flags for this deployment.
  if ! grep -q '^FORCE_INSECURE_COOKIES=' .env; then
    echo "" >> .env
    echo "# Auto-set by init-prod.sh for TLS_MODE=none" >> .env
    echo "FORCE_INSECURE_COOKIES=true" >> .env
    echo "==> Set FORCE_INSECURE_COOKIES=true in .env (required for plain-HTTP mode)."
  fi
fi

# ---------------------------------------------------------------------------
# Start the stack
# ---------------------------------------------------------------------------
echo "==> Starting Visiban..."

COMPOSE_ARGS="-f docker-compose.prod.yml"

if [[ "${TLS_MODE}" == "letsencrypt" ]]; then
  # Start the certbot renewal service alongside the main stack
  docker compose ${COMPOSE_ARGS} --profile letsencrypt up -d
else
  docker compose ${COMPOSE_ARGS} up -d
fi

echo ""
case "${TLS_MODE}" in
  letsencrypt)
    echo "  Visiban is live at https://${DOMAIN}"
    ;;
  selfsigned)
    echo "  Visiban is live at https://${DOMAIN}"
    echo "  (browser will show a certificate warning — this is expected with self-signed certs)"
    ;;
  none)
    echo "  Visiban is live at http://${DOMAIN}"
    ;;
esac
echo ""
echo "  Logs:    docker compose -f docker-compose.prod.yml logs -f"
echo "  Stop:    docker compose -f docker-compose.prod.yml down"
