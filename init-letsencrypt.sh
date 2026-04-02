#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# init-letsencrypt.sh — one-time setup: obtain a Let's Encrypt certificate
# and start the production stack.
#
# Usage:
#   cp .env.example .env   # fill in DOMAIN, CERTBOT_EMAIL, DJANGO_SECRET_KEY
#   chmod +x init-letsencrypt.sh
#   ./init-letsencrypt.sh
# ---------------------------------------------------------------------------
set -euo pipefail

# Load .env so DOMAIN and CERTBOT_EMAIL are available
if [[ ! -f .env ]]; then
  echo "ERROR: .env file not found. Copy .env.example and fill in the required values."
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${DOMAIN:?Set DOMAIN=yourdomain.com in .env}"
: "${CERTBOT_EMAIL:?Set CERTBOT_EMAIL=admin@yourdomain.com in .env}"

echo "==> Generating nginx config for ${DOMAIN}..."
DOMAIN="${DOMAIN}" envsubst '${DOMAIN}' < nginx/app.conf.template > nginx/app.conf

echo "==> Building application images..."
docker compose -f docker-compose.prod.yml build

if [[ -d "certbot/conf/live/${DOMAIN}" ]]; then
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

echo "==> Starting Visiban..."
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "  Visiban is live at https://${DOMAIN}"
echo ""
echo "  Logs:    docker compose -f docker-compose.prod.yml logs -f"
echo "  Stop:    docker compose -f docker-compose.prod.yml down"
