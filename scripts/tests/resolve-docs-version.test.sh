#!/usr/bin/env bash
# scripts/tests/resolve-docs-version.test.sh
#
# Tests for scripts/resolve-docs-version.sh — the VERSION resolution +
# normalization logic behind docs-deploy (#1270). Covers all three
# resolution sources (DOCS_VERSION, CI_COMMIT_TAG, .env.example fallback)
# crossed with prefixed/unprefixed and release/pre-release inputs, plus the
# "nothing to deploy" case.
#
# Run: bash scripts/tests/resolve-docs-version.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/resolve-docs-version.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
# run <env-file> — sets RC and OUT; DOCS_VERSION/CI_COMMIT_TAG come from the
# caller's environment (unset via env -u when a case needs them absent).
run() { RC=0; OUT=$(bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
expect() { # <desc> <expected-rc> [expected-stdout]
  if [[ "$RC" -ne "$2" ]] || { [[ $# -ge 3 ]] && [[ "$OUT" != "$3" ]]; }; then
    echo "  FAIL: $1 (rc=$RC out=$OUT)"; fail=$((fail + 1))
  else
    pass=$((pass + 1))
  fi
}

NO_ENV_FILE="$TMP/does-not-exist"

# --- DOCS_VERSION takes priority, is normalized whether prefixed or not ---
run() { RC=0; OUT=$(env -u CI_COMMIT_TAG DOCS_VERSION="$2" bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$NO_ENV_FILE" "v1.1.0"
expect "DOCS_VERSION already prefixed, full release: no change" 0 "v1.1.0"
run "$NO_ENV_FILE" "1.1.0"
expect "DOCS_VERSION unprefixed, full release: gets v-prefixed" 0 "v1.1.0"
run "$NO_ENV_FILE" "1.1.0-rc.1"
expect "DOCS_VERSION unprefixed, pre-release: gets v-prefixed (the exact #1270 repro)" 0 "v1.1.0-rc.1"
run "$NO_ENV_FILE" "v1.2.0-alpha.1"
expect "DOCS_VERSION already prefixed, pre-release: no change" 0 "v1.2.0-alpha.1"

# --- CI_COMMIT_TAG used only when DOCS_VERSION is unset ---
run() { RC=0; OUT=$(env -u DOCS_VERSION CI_COMMIT_TAG="$2" bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$NO_ENV_FILE" "1.1.0"
expect "CI_COMMIT_TAG unprefixed: gets v-prefixed" 0 "v1.1.0"

run() { RC=0; OUT=$(env DOCS_VERSION="v9.9.9" CI_COMMIT_TAG="v1.1.0" bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$NO_ENV_FILE"
expect "DOCS_VERSION wins over CI_COMMIT_TAG when both are set" 0 "v9.9.9"

# --- .env.example fallback, only reached when both env vars are unset ---
ENV_PREFIXED="$TMP/env-prefixed"
echo "APP_VERSION=v1.1.0" > "$ENV_PREFIXED"
ENV_UNPREFIXED="$TMP/env-unprefixed"
echo "APP_VERSION=1.1.0" > "$ENV_UNPREFIXED"

run() { RC=0; OUT=$(env -u DOCS_VERSION -u CI_COMMIT_TAG bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$ENV_PREFIXED"
expect ".env.example already prefixed: no double-prefix (not vv1.1.0)" 0 "v1.1.0"
run "$ENV_UNPREFIXED"
expect ".env.example unprefixed (old-tree fallback): gets v-prefixed" 0 "v1.1.0"

# --- Nothing resolvable: exit 1, no stdout, caller treats as "nothing to deploy" ---
run "$NO_ENV_FILE"
expect "no DOCS_VERSION, no CI_COMMIT_TAG, no .env.example: exits 1 with empty stdout" 1 ""

# --- Edge cases: garbage/empty sources (completeness-check on #1270) ---
run() { RC=0; OUT=$(env -u CI_COMMIT_TAG DOCS_VERSION="$2" bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$NO_ENV_FILE" "banana"
expect "non-version garbage DOCS_VERSION is still just v-prefixed, not rejected (pre-existing behavior)" 0 "vbanana"

ENV_NO_APP_VERSION="$TMP/env-no-app-version"
echo "OTHER_VAR=1" > "$ENV_NO_APP_VERSION"
run() { RC=0; OUT=$(env -u DOCS_VERSION -u CI_COMMIT_TAG bash "$GATE" --env-file "$1" 2>&1) || RC=$?; }
run "$ENV_NO_APP_VERSION"
expect ".env.example with no APP_VERSION= line: exits 1, not an empty-string crash" 1 ""

ENV_EMPTY_APP_VERSION="$TMP/env-empty-app-version"
echo "APP_VERSION=" > "$ENV_EMPTY_APP_VERSION"
run "$ENV_EMPTY_APP_VERSION"
expect ".env.example with APP_VERSION= (empty value): exits 1, not \"v\"" 1 ""

# --- --require-tag (#1997, #2398): main must not publish a version before its tag
# exists AND its tag pipeline's release-main-pipeline-guard passed. The test hooks
# (TAG_LOOKUP_CMD, GUARD_STATUS_CMD) are honored only inside --self-test, so the
# CLI cases here use a real local git remote and a local fake GitLab API. runrt
# scrubs the caller's GitLab API env: a protected CI token on main otherwise turns
# the no-token cases into real lookups (#2412); API cases pass it back explicitly.
REMOTE="$TMP/remote.git"; git init -q --bare "$REMOTE"
WORK="$TMP/work"; git init -q "$WORK"
git -C "$WORK" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$WORK" tag v1.3.0
git -C "$WORK" remote add origin "$REMOTE"; git -C "$WORK" push -q origin v1.3.0
runrt() { RC=0; OUT=$(cd "$WORK" && env -u DOCS_VERSION -u CI_COMMIT_TAG -u GITLAB_API_TOKEN -u CI_API_V4_URL -u CI_PROJECT_ID "$@" bash "$GATE" --require-tag --env-file "$ENV_REL" 2>/dev/null) || RC=$?; }
ENV_REL="$TMP/env-release"; echo "APP_VERSION=v1.4.0" > "$ENV_REL"
runrt
expect "main, APP_VERSION tag not on origin: exit 3, nothing on stdout" 3 ""
ENV_REL="$TMP/env-tagged"; echo "APP_VERSION=v1.3.0" > "$ENV_REL"
runrt
expect "main, tag on origin but no API token: exit 4 (fail closed), nothing on stdout (#2398)" 4 ""
STUB="$TMP/guard-success"; printf '#!/bin/sh\necho success\n' > "$STUB"; chmod +x "$STUB"
runrt env GUARD_STATUS_CMD="$STUB" TAG_LOOKUP_CMD="$STUB"
expect "an exported GUARD_STATUS_CMD/TAG_LOOKUP_CMD stub is ignored outside --self-test (#2398)" 4 ""

# Real HTTP path against a local fake GitLab API (python3 http.server on loopback).
API_DIR="$TMP/api"; mkdir -p "$API_DIR"
PORT_FILE="$TMP/port"
python3 -I - "$API_DIR" "$PORT_FILE" >/dev/null 2>&1 <<'PY' &
import http.server, os, sys, socketserver
root, portfile = sys.argv[1], sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.headers.get("PRIVATE-TOKEN") != "fake-token-for-test":
            self.send_response(401); self.end_headers(); return
        mode = open(os.path.join(root, "mode")).read().strip()
        path = self.path.split("?")[0]
        if mode == "error":
            self.send_response(500); self.end_headers(); return
        if path.endswith("/pipelines"):
            body = "[]" if mode == "nopipe" else '[{"id": 77}]'
        else:
            body = '[{"id": 1, "name": "release-main-pipeline-guard", "status": "%s"}, {"id": 2, "name": "other", "status": "success"}]' % mode
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
for _ in $(seq 1 50); do [[ -s "$PORT_FILE" ]] && break; sleep 0.1; done
API="http://127.0.0.1:$(cat "$PORT_FILE")/api/v4"
apimode() { echo "$1" > "$API_DIR/mode"; }
runapi() { runrt env CI_API_V4_URL="$API" CI_PROJECT_ID=1 GITLAB_API_TOKEN=fake-token-for-test; }
apimode success; runapi
expect "tag on origin, guard job success on the tag pipeline: deploys" 0 "v1.3.0"
apimode failed; runapi
expect "guard job failed (refused release): exit 5, nothing on stdout (#2398)" 5 ""
apimode running; runapi
expect "guard job still running: exit 5" 5 ""
apimode nopipe; runapi
expect "no pipeline for the tag: exit 5" 5 ""
apimode error; runapi
expect "API error: exit 4 (fail closed)" 4 ""
apimode success
runrt env CI_API_V4_URL="$API" CI_PROJECT_ID=1 GITLAB_API_TOKEN=wrong-token
expect "rejected token: exit 4 (fail closed)" 4 ""
ENV_REL="$TMP/env-release"
runrt env CI_COMMIT_TAG=v1.4.0
expect "tag pipeline deploys its tag with no lookup" 0 "v1.4.0"
runrt env DOCS_VERSION=v1.4.0
expect "manual DOCS_VERSION recovery deploys with no lookup" 0 "v1.4.0"

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "resolve-docs-version.test.sh: all $pass checks passed"
  exit 0
else
  echo "resolve-docs-version.test.sh: $fail failed, $pass passed"
  exit 1
fi
