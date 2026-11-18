#!/usr/bin/env bash
# scripts/check-nginx-security-headers.sh — the bundled nginx templates send the
# full security-header set on every path, and nothing can silently drop it
# (#1073).
#
# WHY THIS EXISTS. nginx inherits `add_header` from the enclosing block ONLY IF
# the current block declares no `add_header` of its own. So one innocent line
# inside a `location` (a cache header, a CORS header, anything) removes HSTS,
# CSP, X-Frame-Options and X-Content-Type-Options from every response that
# location serves: no error, no warning, green pipeline. Today no location in
# nginx/app.conf.template or nginx/app-http.conf.template declares one, so the
# trap is latent; this gate keeps it that way, and also stops the two templates
# from drifting apart.
#
# Modes:
#
#   (no argument)  Static check of nginx/app.conf.template (TLS) and
#                  nginx/app-http.conf.template (plain HTTP):
#     A. The server block that serves the SPA (the one with a
#        `try_files ... /index.html` fallback) declares, at server level:
#          X-Frame-Options "DENY" always
#          X-Content-Type-Options "nosniff" always
#          Referrer-Policy ... always
#          Content-Security-Policy "..." always, containing default-src 'self'
#            and frame-ancestors 'none'
#        and, when it terminates TLS (`listen ... ssl`), Strict-Transport-Security
#        (the __HSTS_HEADER_PLACEHOLDER__ that scripts/render-nginx-hsts.sh
#        renders counts).
#     B. A `location` that declares any `add_header` must re-declare every
#        security header its server declares. In the TLS template that is
#        impossible in practice (HSTS is a single rendered placeholder,
#        render-nginx-hsts.sh --check allows exactly one), which is the point:
#        put per-path headers in a `map` + one server-level add_header, as the
#        Cache-Control map already does.
#     C. The two templates' server-level header sets are identical, apart from
#        HSTS (HTTPS-only by design) and the ws:// vs wss:// scheme in the CSP
#        connect-src.
#
#   --runtime      Boots nginx (run it where an `nginx` binary exists: the CI job
#                  runs in nginx:1.27-alpine, the frontend image's base) against a
#                  stub upstream, once per config, and asserts the headers on the
#                  real responses for /, an SPA deep link, a static asset, a
#                  missing asset (404), /api/, /accounts/, /admin/, /static/,
#                  /media/ and /mcp. Also boots frontend/nginx.default.conf (the
#                  image's own default config, #1994). Then runs a NEGATIVE
#                  CONTROL: a copy of the plain-HTTP template with an
#                  `add_header X-Test` in `location /api/` must fail, so a
#                  runtime check that can no longer fail is caught. Needs bash,
#                  curl, openssl, envsubst.
#
#   --self-test    Replays the static check against mutated copies of the real
#                  templates (a location add_header in either template, the
#                  one-line `location { add_header ...; }` form, a removed CSP,
#                  a dropped `always`, a weakened X-Frame-Options, CSP drift
#                  between the templates) and asserts each fails, and that a
#                  location re-declaring the full set passes. A gate observed
#                  only on a clean tree is indistinguishable from one that
#                  always passes (#1093).
#
# THE HELM PATH. The chart's frontend ConfigMap is a separate nginx config.
# scripts/helm-structure-check.sh (check_frontend_security_headers, #1952)
# asserts it sends the same CSP as nginx/app.conf.template, X-Frame-Options DENY,
# the Referrer-Policy map, and no location-level add_header; it runs in the
# helm-template job whenever these templates or the chart change. The frontend
# image's own default config is compared to the plain-HTTP template there too
# (check_frontend_image_headers, #1994), and booted by --runtime here.
#
# Usage:  scripts/check-nginx-security-headers.sh [--self-test | --runtime]
# Exit:   0 pass · 1 a violation (or, for --self-test, a fixture the check missed)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_TEMPLATE="$ROOT/nginx/app.conf.template"
HTTP_TEMPLATE="$ROOT/nginx/app-http.conf.template"
IMAGE_CONF="$ROOT/frontend/nginx.default.conf"

# Security headers a location must re-declare if it declares any add_header.
SECURITY_HEADERS="X-Frame-Options X-Content-Type-Options Referrer-Policy Content-Security-Policy Strict-Transport-Security"

# ---------------------------------------------------------------------------
# Parser. Emits one tab-separated record per fact, for the bash checks below:
#   S <srv> <line> <name> <value>   add_header directly in server <srv>
#   L <srv> <locline> <line> <name> add_header inside a location of <srv>
#   P <srv>                         <srv> serves the SPA (try_files .../index.html)
#   T <srv>                         <srv> terminates TLS (listen ... ssl)
# Tracks braces and quotes, so the one-line `location / { add_header X 1; }`
# form and a quoted CSP full of `;` are both read correctly. Comments are
# dropped first (no quoted value in these configs contains `#`).
# ---------------------------------------------------------------------------
parse_conf() {
  awk '
    function flush(   s, n, t, name, val, i) {
      s = stmt; stmt = ""
      gsub(/^[ \t]+|[ \t]+$/, "", s)
      if (s == "" || srv_depth == 0) return
      n = split(s, t, /[ \t]+/)
      if (t[1] == "add_header") {
        name = t[2]; val = ""
        for (i = 3; i <= n; i++) val = val (i > 3 ? " " : "") t[i]
        if (depth == srv_depth) {
          printf "S\t%d\t%d\t%s\t%s\n", srv, stmt_line, name, val
        } else if (loc_line > 0) {
          printf "L\t%d\t%d\t%d\t%s\n", srv, loc_line, stmt_line, name
        }
      } else if (t[1] == "try_files" && s ~ /\/index\.html/) {
        printf "P\t%d\n", srv
      } else if (t[1] == "listen" && s ~ /[ \t]ssl([ \t]|$)/) {
        printf "T\t%d\n", srv
      }
    }
    BEGIN { depth = 0; srv = 0; srv_depth = 0; loc_line = 0; loc_depth = 0; stmt = ""; inq = 0 }
    {
      line = $0
      trimmed = line; gsub(/^[ \t]+|[ \t]+$/, "", trimmed)
      if (trimmed == "__HSTS_HEADER_PLACEHOLDER__") {
        if (srv_depth > 0 && depth == srv_depth)
          printf "S\t%d\t%d\tStrict-Transport-Security\t__HSTS_HEADER_PLACEHOLDER__\n", srv, NR
        next
      }
      if (!inq) sub(/#.*/, "", line)
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (c == "\"") { inq = !inq; stmt = stmt c; continue }
        if (inq) { stmt = stmt c; continue }
        if (stmt ~ /^[ \t]*$/ && c != " " && c != "\t") stmt_line = NR
        if (c == ";") { flush(); continue }
        if (c == "{") {
          hdr = stmt; stmt = ""
          gsub(/^[ \t]+|[ \t]+$/, "", hdr)
          depth++
          if (hdr ~ /^server([ \t]|$)/ && srv_depth == 0) { srv++; srv_depth = depth }
          else if (hdr ~ /^location([ \t]|$)/ && loc_line == 0) { loc_line = NR; loc_depth = depth }
          continue
        }
        if (c == "}") {
          flush()
          if (depth == loc_depth) { loc_line = 0; loc_depth = 0 }
          if (depth == srv_depth) { srv_depth = 0 }
          depth--
          continue
        }
        stmt = stmt c
      }
      stmt = stmt " "
    }
  ' "$1"
}

# The SPA-serving server number in a parsed record stream, or empty.
spa_server() { awk -F'\t' '$1 == "P" { print $2; exit }' <<< "$1"; }

# Server-level value of header $3 in server $2 of records $1, or empty.
server_header() {
  awk -F'\t' -v s="$2" -v n="$3" '$1 == "S" && $2 == s && tolower($4) == tolower(n) { print $5; exit }' <<< "$1"
}

# ---------------------------------------------------------------------------
# Static check of one TLS and one plain-HTTP template. Prints every violation;
# returns 1 if there was any.
# ---------------------------------------------------------------------------
check_static() {
  local tls="$1" http="$2" bad=0 f recs srv val names loc name
  local -a sets=()
  for f in "$tls" "$http"; do
    recs="$(parse_conf "$f")"
    srv="$(spa_server "$recs")"
    if [ -z "$srv" ]; then
      echo "FAIL $f: no server block serves the SPA (no 'try_files ... /index.html')"
      bad=1; sets+=(""); continue
    fi

    # A. Required server-level headers.
    val="$(server_header "$recs" "$srv" X-Frame-Options)"
    [ "$val" = '"DENY" always' ] || { echo "FAIL $f: server must send 'add_header X-Frame-Options \"DENY\" always;' (got: ${val:-none})"; bad=1; }
    val="$(server_header "$recs" "$srv" X-Content-Type-Options)"
    [ "$val" = '"nosniff" always' ] || { echo "FAIL $f: server must send 'add_header X-Content-Type-Options \"nosniff\" always;' (got: ${val:-none})"; bad=1; }
    val="$(server_header "$recs" "$srv" Referrer-Policy)"
    case "$val" in *" always") ;; *) echo "FAIL $f: server must send Referrer-Policy with 'always' (got: ${val:-none})"; bad=1 ;; esac
    val="$(server_header "$recs" "$srv" Content-Security-Policy)"
    if [ -z "$val" ]; then
      echo "FAIL $f: server sends no Content-Security-Policy"; bad=1
    else
      case "$val" in *'" always') ;; *) echo "FAIL $f: Content-Security-Policy is not sent with 'always'"; bad=1 ;; esac
      grep -qF "default-src 'self'" <<< "$val" || { echo "FAIL $f: Content-Security-Policy lacks default-src 'self'"; bad=1; }
      grep -qF "frame-ancestors 'none'" <<< "$val" || { echo "FAIL $f: Content-Security-Policy lacks frame-ancestors 'none'"; bad=1; }
    fi
    if awk -F'\t' -v s="$srv" '$1 == "T" && $2 == s { found = 1 } END { exit !found }' <<< "$recs"; then
      [ -n "$(server_header "$recs" "$srv" Strict-Transport-Security)" ] \
        || { echo "FAIL $f: TLS server sends no Strict-Transport-Security (or its __HSTS_HEADER_PLACEHOLDER__)"; bad=1; }
    fi

    # B. A location with any add_header re-declares every server-level
    # security header (nginx drops the inherited ones otherwise).
    names="$(awk -F'\t' '$1 == "S" { print $2 "\t" $4 }' <<< "$recs")"
    while IFS=$'\t' read -r s loc; do
      [ -n "$s" ] || continue
      for name in $SECURITY_HEADERS; do
        grep -qiF "$(printf '%s\t%s' "$s" "$name")" <<< "$names" || continue
        if ! awk -F'\t' -v s="$s" -v l="$loc" -v n="$name" \
             '$1 == "L" && $2 == s && $3 == l && tolower($5) == tolower(n) { found = 1 } END { exit !found }' <<< "$recs"; then
          echo "FAIL $f:$loc: this location declares its own add_header, so nginx drops every server-level one; it does not re-declare $name. Use a map + one server-level add_header instead (see the Cache-Control map)."
          bad=1
        fi
      done
    done < <(awk -F'\t' '$1 == "L" { print $2 "\t" $3 }' <<< "$recs" | sort -u)

    # C. The comparable header set: every server-level add_header but HSTS,
    # with the CSP's wss:// written as ws://.
    sets+=("$(awk -F'\t' -v s="$srv" '$1 == "S" && $2 == s && tolower($4) != "strict-transport-security" { print $4 " " $5 }' <<< "$recs" \
      | sed 's#wss://#ws://#g' | sort)")
  done

  if [ "${#sets[@]}" -eq 2 ] && [ -n "${sets[0]}" ] && [ -n "${sets[1]}" ] && [ "${sets[0]}" != "${sets[1]}" ]; then
    echo "FAIL the two templates' server-level headers differ (beyond HSTS and ws/wss):"
    diff <(printf '%s\n' "${sets[0]}") <(printf '%s\n' "${sets[1]}") | sed 's/^/    /' || true
    bad=1
  fi
  return "$bad"
}

# ---------------------------------------------------------------------------
# --self-test
# ---------------------------------------------------------------------------
self_test() {
  local tmp pass=0 fail=0
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN

  # expect <pass|fail> <description> <tls-file> <http-file>
  expect() {
    local want="$1" desc="$2" out rc=0
    out="$(check_static "$3" "$4" 2>&1)" || rc=$?
    if { [ "$want" = pass ] && [ "$rc" -eq 0 ]; } || { [ "$want" = fail ] && [ "$rc" -ne 0 ]; }; then
      echo "  ok   $desc"; pass=$((pass + 1))
    else
      echo "  MISS $desc (wanted $want, rc=$rc)"; printf '%s\n' "$out" | sed 's/^/       /'; fail=$((fail + 1))
    fi
  }
  # mutate <src> <dst> <awk program>: write a mutated copy of a template.
  mutate() { awk "$3" "$1" > "$2"; }

  cp "$TLS_TEMPLATE" "$tmp/tls.conf"; cp "$HTTP_TEMPLATE" "$tmp/http.conf"
  echo "=== check-nginx-security-headers.sh --self-test ==="
  expect pass "the real templates pass" "$tmp/tls.conf" "$tmp/http.conf"

  mutate "$TLS_TEMPLATE" "$tmp/tls-loc.conf" '{ print } /^[ \t]*location \/api\/ \{/ { print "        add_header X-Test \"1\";" }'
  expect fail "add_header in a TLS-template location" "$tmp/tls-loc.conf" "$tmp/http.conf"

  mutate "$HTTP_TEMPLATE" "$tmp/http-loc.conf" '{ print } /^[ \t]*location \/assets\/ \{/ { print "        add_header X-Test \"1\";" }'
  expect fail "add_header in a plain-HTTP-template location" "$tmp/tls.conf" "$tmp/http-loc.conf"

  mutate "$HTTP_TEMPLATE" "$tmp/http-oneline.conf" '/^[ \t]*location \/ \{/ { print "    location /x { add_header X-Test \"1\"; }" } { print }'
  expect fail "one-line 'location /x { add_header ...; }'" "$tmp/tls.conf" "$tmp/http-oneline.conf"

  mutate "$TLS_TEMPLATE" "$tmp/tls-nocsp.conf" '!/add_header[ \t]+Content-Security-Policy/'
  expect fail "CSP removed from the TLS template" "$tmp/tls-nocsp.conf" "$tmp/http.conf"

  mutate "$HTTP_TEMPLATE" "$tmp/http-nocsp.conf" '!/add_header[ \t]+Content-Security-Policy/'
  expect fail "CSP removed from the plain-HTTP template" "$tmp/tls.conf" "$tmp/http-nocsp.conf"

  mutate "$HTTP_TEMPLATE" "$tmp/http-noalways.conf" '{ if ($0 ~ /X-Content-Type-Options/) sub(/ always;/, ";"); print }'
  expect fail "'always' dropped from X-Content-Type-Options" "$tmp/tls.conf" "$tmp/http-noalways.conf"

  mutate "$HTTP_TEMPLATE" "$tmp/http-xfo.conf" '{ if ($0 ~ /X-Frame-Options/) sub(/"DENY"/, "\"SAMEORIGIN\""); print }'
  expect fail "X-Frame-Options weakened in one template" "$tmp/tls.conf" "$tmp/http-xfo.conf"

  mutate "$TLS_TEMPLATE" "$tmp/tls-drift.conf" '{ if ($0 ~ /add_header[ \t]+Content-Security-Policy/) sub(/img-src '\''self'\''/, "img-src *"); print }'
  expect fail "CSP drift between the templates" "$tmp/tls-drift.conf" "$tmp/http.conf"

  mutate "$TLS_TEMPLATE" "$tmp/tls-nohsts.conf" '!/__HSTS_HEADER_PLACEHOLDER__/'
  expect fail "HSTS placeholder removed from the TLS template" "$tmp/tls-nohsts.conf" "$tmp/http.conf"

  # A location that re-declares the whole set is allowed (plain-HTTP template:
  # no HSTS to re-declare).
  mutate "$HTTP_TEMPLATE" "$tmp/http-full.conf" '
    { print }
    /^[ \t]*location \/assets\/ \{/ {
      print "        add_header X-Test \"1\";"
      print "        add_header X-Frame-Options \"DENY\" always;"
      print "        add_header X-Content-Type-Options \"nosniff\" always;"
      print "        add_header Referrer-Policy $visiban_referrer_policy always;"
      print "        add_header Content-Security-Policy \"default-src '\''self'\''; frame-ancestors '\''none'\''\" always;"
    }'
  expect pass "a location re-declaring the full set" "$tmp/tls.conf" "$tmp/http-full.conf"

  echo "check-nginx-security-headers.sh --self-test: ${pass} passed, ${fail} failed."
  [ "$fail" -eq 0 ] || { echo "=== --self-test: FAILED ==="; return 1; }
  echo "=== --self-test: PASSED ==="
}

# ---------------------------------------------------------------------------
# --runtime
# ---------------------------------------------------------------------------
STUB_PORT=18000

# Render config $1 (kind $2: tls | http | image) into work dir $3, start nginx,
# curl every path, stop nginx. Prints violations; returns the count as status
# (capped at 1 for set -e friendliness: callers read $? explicitly).
run_config() {
  local src="$1" kind="$2" w="$3" bad=0 base hdrs path code
  mkdir -p "$w/conf.d" "$w/html/assets" "$w/certs" "$w/tmp"
  printf '<!doctype html><title>t</title>\n' > "$w/html/index.html"
  printf 'console.log(1)\n' > "$w/html/assets/app-1073.js"
  # mktemp -d is 0700; the nginx worker runs as the unprivileged `nginx` user
  # and must be able to read the document root.
  chmod 755 "$(dirname "$w")" "$w" "$w/html" "$w/html/assets"
  chmod 644 "$w/html/index.html" "$w/html/assets/app-1073.js"

  local rendered="$w/conf.d/site.conf"
  if [ "$kind" = image ]; then
    cp "$src" "$rendered"
  else
    cp "$src" "$w/tpl.conf"
    if [ "$kind" = tls ]; then
      # Same rendering init-prod.sh does: TLS_MODE=letsencrypt with
      # SECURE_HSTS_SECONDS unset emits the HSTS header.
      env -u SECURE_HSTS_SECONDS bash "$ROOT/scripts/render-nginx-hsts.sh" "$w/tpl.conf" letsencrypt >/dev/null
      openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
        -keyout "$w/certs/privkey.pem" -out "$w/certs/fullchain.pem" >/dev/null 2>&1
    fi
    # Only ${DOMAIN} is a template variable; every nginx $var must survive.
    DOMAIN=localhost envsubst '${DOMAIN}' < "$w/tpl.conf" > "$rendered"
  fi
  # Point the config at the work dir and the stub upstream.
  sed -i \
    -e "s#http://backend:8000#http://127.0.0.1:$STUB_PORT#g" \
    -e "s#/usr/share/nginx/html#$w/html#g" \
    -e "s#/etc/letsencrypt/live/localhost/#$w/certs/#g" \
    "$rendered"
  # The stub upstream: answers every proxied path with 200 and no headers of
  # its own, so whatever security header reaches the client came from nginx.
  cat > "$w/conf.d/stub.conf" <<EOF
server {
    listen 127.0.0.1:$STUB_PORT;
    location / { default_type text/plain; return 200 "stub\n"; }
}
EOF
  cat > "$w/nginx.conf" <<EOF
pid $w/nginx.pid;
error_log $w/error.log warn;
events {}
http {
    include /etc/nginx/mime.types;
    access_log off;
    client_body_temp_path $w/tmp/body;
    proxy_temp_path $w/tmp/proxy;
    fastcgi_temp_path $w/tmp/fastcgi;
    uwsgi_temp_path $w/tmp/uwsgi;
    scgi_temp_path $w/tmp/scgi;
    include $w/conf.d/*.conf;
}
EOF
  if ! nginx -t -c "$w/nginx.conf" >"$w/t.log" 2>&1; then
    echo "FAIL $src: nginx -t rejected the rendered config:"; sed 's/^/    /' "$w/t.log"
    return 1
  fi
  nginx -c "$w/nginx.conf"

  # Each entry is <path>=<expected status>. The status is asserted too, so a
  # broken harness (an unreadable root answering 403/500 everywhere, which
  # still carries the `always` headers) cannot pass vacuously.
  local -a paths curl_args
  local app_paths=(/=200 /boards/1=200 /assets/app-1073.js=200 /assets/missing-1073.js=404
    /api/v1/health/=200 /accounts/login/=200 /admin/=200 /static/admin/x.css=200 /media/x=200 /mcp=200)
  case "$kind" in
    tls)
      base="https://localhost"
      curl_args=(-k --resolve "localhost:443:127.0.0.1")
      paths=("${app_paths[@]}") ;;
    http)
      base="http://127.0.0.1"; curl_args=()
      paths=("${app_paths[@]}") ;;
    image)
      base="http://127.0.0.1:8080"; curl_args=()
      paths=(/=200 /index.html=200 /missing-1073=404) ;;
  esac

  local seen="" entry expect
  for entry in "${paths[@]}"; do
    path="${entry%=*}"; expect="${entry##*=}"
    hdrs="$(curl -sS -o /dev/null -D - --max-time 5 "${curl_args[@]+"${curl_args[@]}"}" "$base$path" | tr -d '\r')" || {
      echo "FAIL $src $path: request failed"; bad=1; continue; }
    code="$(head -1 <<< "$hdrs" | awk '{ print $2 }')"
    seen="$seen $path=$code"
    [ "$code" = "$expect" ] || { echo "FAIL $src $path: status $code, expected $expect (harness or routing broken)"; bad=1; }
    want() { grep -qiE "^$1:[[:space:]]*$2" <<< "$hdrs" || { echo "FAIL $src $path ($code): missing or wrong '$1'"; bad=1; }; }
    want X-Frame-Options 'DENY$'
    want X-Content-Type-Options 'nosniff$'
    want Referrer-Policy '[a-z-]+$'
    want Content-Security-Policy ".*default-src 'self'.*frame-ancestors 'none'"
    [ "$kind" = tls ] && want Strict-Transport-Security 'max-age=[0-9]+'
  done

  [ "$bad" -eq 0 ] && echo "  ok   ${src#"$ROOT"/} ($kind):$seen"
  nginx -c "$w/nginx.conf" -s quit 2>/dev/null || true
  # Wait for the old master to release the ports before the next config binds them.
  local i=0
  while [ -f "$w/nginx.pid" ] && [ "$i" -lt 50 ]; do i=$((i + 1)); sleep 0.1; done
  return "$bad"
}

runtime() {
  local w bad=0 rc
  command -v nginx >/dev/null || { echo "--runtime needs an nginx binary (run it in nginx:1.27-alpine)"; return 1; }
  w="$(mktemp -d)"; trap 'rm -rf "$w"' RETURN

  echo "=== check-nginx-security-headers.sh --runtime ==="
  run_config "$TLS_TEMPLATE" tls "$w/tls" || bad=1
  run_config "$HTTP_TEMPLATE" http "$w/http" || bad=1
  run_config "$IMAGE_CONF" image "$w/image" || bad=1

  # Negative control: the check must still be able to fail.
  awk '{ print } /^[ \t]*location \/api\/ \{/ { print "        add_header X-Test \"1\";" }' "$HTTP_TEMPLATE" > "$w/neg.conf"
  rc=0; run_config "$w/neg.conf" http "$w/neg" > "$w/neg.log" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] || ! grep -q '/api/v1/health/' "$w/neg.log"; then
    echo "FAIL negative control: a location add_header in /api/ was NOT detected at runtime"
    sed 's/^/    /' "$w/neg.log"
    bad=1
  else
    echo "  ok   negative control: a location add_header in /api/ drops the headers and is detected"
  fi

  [ "$bad" -eq 0 ] && echo "=== --runtime: PASSED (every path of every config sends the full set) ===" \
                   || echo "=== --runtime: FAILED ==="
  return "$bad"
}

case "${1:-}" in
  --self-test) self_test ;;
  --runtime) runtime ;;
  "")
    if check_static "$TLS_TEMPLATE" "$HTTP_TEMPLATE"; then
      echo "PASS nginx templates: full security-header set at server level, no location drops it, templates agree"
    else
      exit 1
    fi ;;
  -h|--help) sed -n '2,70p' "$0" ;;
  *) echo "Usage: $0 [--self-test | --runtime]" >&2; exit 1 ;;
esac
