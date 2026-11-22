#!/usr/bin/env bash
# scripts/nginx-spa-cache-check.sh — behavioral check of the SPA cache policy
# (#1633) against a real nginx, for all three configs that carry the SPA
# fallback: the Helm ConfigMap, nginx/app.conf.template (HTTPS prod) and
# nginx/app-http.conf.template.
#
# WHY: the text guards in helm-structure-check.sh and the compose-hygiene member of
# lint-selftests-alpine read config text. A mutation that leaves the words in place but changes
# nginx's behavior (`map $request_uri`, a catch-all `~.* ""` regex ahead of the
# entries, a re-prefixed entry regex) passes them. This script runs `nginx -t`
# and curls the result.
#
# Needs: docker, helm, yq (mikefarah v4), openssl, curl. Local only — CI uses
# kaniko and has no Docker daemon. Run:  bash scripts/nginx-spa-cache-check.sh
#
# Asserts for each config:
#   /            -> 200, Cache-Control: no-cache
#   /boards/1    -> 200 (index.html), Cache-Control: no-cache   (SPA deep link)
#   /theme-init.js, /favicon.ico, /brand/x.png -> no-cache
#   /assets/app-abc.js     -> 200, public, max-age=31536000, immutable
#   /assets/missing.js     -> 404 (nginx's own error page), no Cache-Control
#   /api/x (proxied)       -> no Cache-Control added by nginx
set -u
cd "$(dirname "$0")/.." || exit 1
IMAGE="${NGINX_IMAGE:-nginx:1.30-alpine}"
for c in docker helm yq openssl curl; do
  command -v "$c" >/dev/null || { echo "ERROR: $c not on PATH" >&2; exit 1; }
done
work="$(mktemp -d)"
FAIL=0; CONTAINER=""
cleanup() { [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1; rm -rf "$work"; }
trap cleanup EXIT

dist="$work/dist"; mkdir -p "$dist/assets" "$dist/brand"
echo '<!doctype html><title>spa</title>' > "$dist/index.html"
echo '// theme' > "$dist/theme-init.js"
echo '{}' > "$dist/site.webmanifest"
echo 'ico' > "$dist/favicon.ico"
echo 'png' > "$dist/brand/x.png"
echo 'console.log(1)' > "$dist/assets/app-abc.js"

ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1" >&2; FAIL=1; }

# expect <label> <url> <status> <cache-control regex or NONE>
expect() {
  local label="$1" url="$2" want_status="$3" want_cc="$4" hdr status cc
  hdr="$(curl -sk -o /dev/null -D - -H "Host: $HOSTNAME_UNDER_TEST" "$url")"
  status="$(head -1 <<< "$hdr" | awk '{print $2}')"
  cc="$(grep -i '^cache-control:' <<< "$hdr" | tr -d '\r' | sed 's/^[^:]*: *//')"
 
  if [ "$status" != "$want_status" ]; then bad "$label: status $status, want $want_status"; return; fi
  if [ "$want_cc" = NONE ]; then
    [ -z "$cc" ] && ok "$label: $status, no Cache-Control" || bad "$label: unexpected Cache-Control '$cc'"
  else
    grep -qE "^${want_cc}\$" <<< "$cc" && ok "$label: $status, Cache-Control: $cc" || bad "$label: Cache-Control '$cc', want /$want_cc/"
  fi
}

# run_config <name> <conf-file> <host-port-scheme> <container-port> [certdir]
run_config() {
  local name="$1" conf="$2" scheme="$3" cport="$4" certdir="${5:-}" port=18080
  echo "── $name"
  local args=(-d -p "127.0.0.1:${port}:${cport}"
    -v "$conf:/etc/nginx/conf.d/default.conf:ro" -v "$dist:/usr/share/nginx/html:ro")
  # Every proxy_pass upstream must resolve for nginx -t / startup.
  local h
  for h in $(grep -oE 'proxy_pass[[:space:]]+http://[^:;/]+' "$conf" | awk '{print $2}' | sed 's|http://||' | sort -u); do
    args+=(--add-host "$h:127.0.0.1")
  done
  [ -n "$certdir" ] && args+=(-v "$certdir:/etc/letsencrypt:ro")
  CONTAINER="$(docker run "${args[@]}" "$IMAGE" 2>&1)" || { bad "$name: docker run failed: $CONTAINER"; CONTAINER=""; return; }
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sk -o /dev/null "$scheme://127.0.0.1:$port/" && break; sleep 1
  done
  if ! docker exec "$CONTAINER" nginx -t >/dev/null 2>&1; then
    bad "$name: nginx -t failed"; docker exec "$CONTAINER" nginx -t >&2 2>&1
  else ok "$name: nginx -t"; fi
  local b="$scheme://127.0.0.1:$port"
  expect "/"                "$b/"                   200 'no-cache'
  expect "/boards/1"        "$b/boards/1"           200 'no-cache'
  expect "/theme-init.js"   "$b/theme-init.js"      200 'no-cache'
  expect "/favicon.ico"     "$b/favicon.ico"        200 'no-cache'
  expect "/brand/x.png"     "$b/brand/x.png"        200 'no-cache'
  expect "/assets/app-abc.js" "$b/assets/app-abc.js" 200 'public, max-age=31536000, immutable'
  expect "/assets/missing.js" "$b/assets/missing.js" 404 NONE
  expect "/api/x (proxied)" "$b/api/x"              502 NONE
  docker rm -f "$CONTAINER" >/dev/null 2>&1; CONTAINER=""
}

HOSTNAME_UNDER_TEST="spa-check.visiban.test"

# 1. Helm ConfigMap (listens on 8080)
helm template t helm/visiban --set-string secret.djangoSecretKey=structure-check-not-a-real-secret --set-string postgresql.auth.password=structure-check-not-a-real-password \
  --set backend.settings.allowedHosts=structure-check.visiban.local --set backend.email.backend=smtp \
  --set backend.email.host=smtp.visiban.local --set backend.email.fromAddress=noreply@visiban.local \
  > "$work/helm.yaml" 2>"$work/helm.err" || { cat "$work/helm.err" >&2; echo "helm template failed" >&2; exit 1; }
yq 'select(.kind == "ConfigMap" and (.metadata.name | test("nginx$"))) | .data."nginx.conf"' "$work/helm.yaml" > "$work/helm.conf"
run_config "helm ConfigMap" "$work/helm.conf" http 8080

# 2. Compose HTTP-only template
DOMAIN="$HOSTNAME_UNDER_TEST" envsubst '${DOMAIN}' < nginx/app-http.conf.template > "$work/http.conf" 2>/dev/null \
  || sed "s/\${DOMAIN}/$HOSTNAME_UNDER_TEST/g" nginx/app-http.conf.template > "$work/http.conf"
run_config "compose HTTP template" "$work/http.conf" http 80

# 3. Compose HTTPS template (letsencrypt HSTS rendering, throwaway cert)
cp nginx/app.conf.template "$work/app.template"
bash scripts/render-nginx-hsts.sh "$work/app.template" letsencrypt >/dev/null || { bad "render-nginx-hsts failed"; }
sed "s/\${DOMAIN}/$HOSTNAME_UNDER_TEST/g" "$work/app.template" > "$work/https.conf"
certdir="$work/le"; mkdir -p "$certdir/live/$HOSTNAME_UNDER_TEST"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$HOSTNAME_UNDER_TEST" \
  -keyout "$certdir/live/$HOSTNAME_UNDER_TEST/privkey.pem" \
  -out "$certdir/live/$HOSTNAME_UNDER_TEST/fullchain.pem" >/dev/null 2>&1
run_config "compose HTTPS template" "$work/https.conf" https 443 "$certdir"

echo
[ "$FAIL" -eq 0 ] && { echo "PASSED: SPA cache policy holds on all three nginx configs"; exit 0; }
echo "FAILED: SPA cache policy violated" >&2; exit 1
