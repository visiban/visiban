#!/bin/sh
# scripts/sonar-open-issues.sh — list open SonarCloud findings on the files a branch touches (#2528).
#
# Why: Sonar-class defects (floating promises, function refs passed to .forEach, click
# handlers on non-interactive elements, ...) reached main because nothing looked for them
# before the push; the nightly `sonar:scan` was the first time anyone saw them.
# `completeness-check` runs this as its Sonar step, so a file the branch touches that
# already carries an open BUG / VULNERABILITY / TO_REVIEW hotspot is reported as a GAP.
#
# Usage:
#   scripts/sonar-open-issues.sh <repo-relative-path>...
#   git diff --name-only origin/main...HEAD | xargs scripts/sonar-open-issues.sh
#   scripts/sonar-open-issues.sh --self-test
#
# Output: one `sonar: <path>:<line> <rule> <TYPE> <message>` line per finding, then a
# summary line. Exit is 0 on every lookup outcome (only a leading-dash misuse exits 2): this is advisory, and an unreachable SonarCloud must not
# block a push. Fail OPEN and LOUDLY — on a network, HTTP, or parse error it prints
# `sonar: lookup unavailable (<reason>)` and exits 0 (same fail-open convention as
# scripts/check-suppression-issues.sh / docs/development/suppressions.md).
#
# Privacy: the project is public, so there is no token. The only things sent are the
# project key and fixed query parameters. The touched-file list is NOT sent at all: the
# project-wide open BUG/VULNERABILITY set is small, so it is fetched in one request
# (paged) and filtered locally. (SonarCloud's `components=` and `files=` filters were
# checked live: `components` needs another scoping param, and `files` silently returned
# the unfiltered set, so server-side filtering was not dependable anyway.)
#
# What this cannot see: findings the branch itself introduces. Those appear only after the
# nightly scan of main; the ESLint mirrors (#2527) and MR-pipeline analysis (#2529) cover
# that side.
#
# POSIX sh + curl + python3. SONAR_FIXTURE_DIR (self-test only) reads issues.json /
# hotspots.json from a directory instead of the network.

set -eu

PROJECT_KEY="visiban_visiban"
API="${SONAR_API_BASE:-https://sonarcloud.io/api}"
MAX_PAGES=5

if [ "${1:-}" = "--self-test" ]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    st_fail=0
    expect() { # expect "<description>" <pattern> <file>
        if grep -q -- "$2" "$3"; then echo "ok: $1"; else echo "FAIL: $1"; st_fail=1; fi
    }
    expect_not() {
        if grep -q -- "$2" "$3"; then echo "FAIL: $1"; st_fail=1; else echo "ok: $1"; fi
    }
    mkdir "$tmp/fx"
    cat > "$tmp/fx/issues.json" <<'JSON'
{"paging":{"pageIndex":1,"pageSize":500,"total":2},"issues":[
 {"rule":"typescript:S7727","type":"BUG","component":"visiban_visiban:frontend/src/A.tsx","line":12,"message":"Do not pass function directly to .forEach"},
 {"rule":"python:S5332","type":"VULNERABILITY","component":"visiban_visiban:scripts/untouched.py","line":3,"message":"http literal"}]}
JSON
    cat > "$tmp/fx/hotspots.json" <<'JSON'
{"paging":{"pageIndex":1,"pageSize":500,"total":1},"hotspots":[
 {"ruleKey":"python:S2068","component":"visiban_visiban:backend/b.py","line":7,"message":"credential-shaped literal","status":"TO_REVIEW"}]}
JSON
    SONAR_FIXTURE_DIR="$tmp/fx" sh "$0" frontend/src/A.tsx ./backend/b.py frontend/src/clean.ts > "$tmp/found.out" 2>&1 || st_fail=1
    expect "issue on a touched file is reported" 'frontend/src/A.tsx:12 typescript:S7727 BUG' "$tmp/found.out"
    expect "hotspot on a touched file is reported (./ prefix normalized)" 'backend/b.py:7 python:S2068 HOTSPOT' "$tmp/found.out"
    expect_not "finding on an untouched file is not reported" 'untouched.py' "$tmp/found.out"
    expect "summary counts 2 findings" '2 open finding' "$tmp/found.out"
    SONAR_FIXTURE_DIR="$tmp/fx" sh "$0" frontend/src/clean.ts > "$tmp/none.out" 2>&1 || st_fail=1
    expect "no findings on a clean file" 'no open BUG' "$tmp/none.out"
    expect_not "clean file prints no finding line" 'sonar: frontend' "$tmp/none.out"
    mkdir "$tmp/empty"
    rc=0; SONAR_FIXTURE_DIR="$tmp/empty" sh "$0" frontend/src/A.tsx > "$tmp/down.out" 2>&1 || rc=$?
    expect "unavailable fails open loudly" 'sonar: lookup unavailable (' "$tmp/down.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: unavailable must exit 0 (got $rc)"; st_fail=1; else echo "ok: unavailable exits 0"; fi
    mkdir "$tmp/bad"; echo 'not json' > "$tmp/bad/issues.json"; echo '{}' > "$tmp/bad/hotspots.json"
    rc=0; SONAR_FIXTURE_DIR="$tmp/bad" sh "$0" frontend/src/A.tsx > "$tmp/bad.out" 2>&1 || rc=$?
    expect "malformed JSON fails open loudly" 'sonar: lookup unavailable (' "$tmp/bad.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: malformed JSON must exit 0 (got $rc)"; st_fail=1; fi
    # No arguments (empty diff): not an error.
    rc=0; sh "$0" > "$tmp/noargs.out" 2>&1 || rc=$?
    expect "no arguments prints 'no touched files'" 'sonar: no touched files' "$tmp/noargs.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: no arguments must exit 0 (got $rc)"; st_fail=1; else echo "ok: no arguments exits 0"; fi
    # Paging cap: a fixture claiming 99 results at 1 per page never ends within MAX_PAGES.
    mkdir "$tmp/cap"
    echo '{"paging":{"pageIndex":1,"pageSize":1,"total":99},"issues":[]}' > "$tmp/cap/issues.json"
    echo '{"paging":{"pageIndex":1,"pageSize":500,"total":0},"hotspots":[]}' > "$tmp/cap/hotspots.json"
    rc=0; SONAR_FIXTURE_DIR="$tmp/cap" sh "$0" frontend/src/A.tsx > "$tmp/cap.out" 2>&1 || rc=$?
    expect "paging cap is reported, not silent" 'lookup unavailable (more than 2500 open issues; list truncated)' "$tmp/cap.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: paging cap must exit 0 (got $rc)"; st_fail=1; fi
    # curl connection failure (nothing listens on port 1).
    rc=0; SONAR_API_BASE=http://127.0.0.1:1 sh "$0" frontend/src/A.tsx > "$tmp/curl.out" 2>&1 || rc=$?
    expect "curl failure fails open loudly" 'sonar: lookup unavailable (curl' "$tmp/curl.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: curl failure must exit 0 (got $rc)"; st_fail=1; fi
    # HTTP non-200: a throwaway local server that answers 404 to everything.
    python3 - "$tmp/port" <<'PYSRV' &
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_port))
srv.serve_forever()
PYSRV
    srv_pid=$!
    n=0; while [ ! -s "$tmp/port" ] && [ "$n" -lt 50 ]; do n=$((n + 1)); python3 -c 'import time; time.sleep(0.1)'; done
    rc=0; SONAR_API_BASE="http://127.0.0.1:$(cat "$tmp/port" 2>/dev/null || echo 1)" sh "$0" frontend/src/A.tsx > "$tmp/http.out" 2>&1 || rc=$?
    kill "$srv_pid" 2>/dev/null || true
    wait "$srv_pid" 2>/dev/null || true
    expect "HTTP non-200 fails open loudly" 'sonar: lookup unavailable (HTTP 404' "$tmp/http.out"
    if [ "$rc" -ne 0 ]; then echo "FAIL: HTTP 404 must exit 0 (got $rc)"; st_fail=1; fi
    if [ "$st_fail" -eq 0 ]; then echo "sonar-open-issues self-test passed"; fi
    exit "$st_fail"
fi

# An empty diff (`git diff --name-only | xargs` under GNU xargs still runs us once with no
# arguments) is not an error: nothing is touched, so nothing can be reported.
if [ "$#" -eq 0 ]; then
    echo "sonar: no touched files"
    exit 0
fi
case "$1" in
    -*) echo "usage: $0 <repo-relative-path>... | --self-test" >&2; exit 2 ;;
esac

unavailable() { echo "sonar: lookup unavailable ($1)"; exit 0; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$@" > "$work/touched.txt"

# fetch <kind> <page> <url>  -> $work/<kind>.<page>.json, or exits via unavailable.
fetch() {
    kind="$1"; page="$2"; url="$3"
    if [ -n "${SONAR_FIXTURE_DIR:-}" ]; then
        [ -f "$SONAR_FIXTURE_DIR/$kind.json" ] || unavailable "no fixture for $kind"
        cp "$SONAR_FIXTURE_DIR/$kind.json" "$work/$kind.$page.json"
        return 0
    fi
    code="$(curl -sS --max-time 20 --retry 1 -o "$work/$kind.$page.json" -w '%{http_code}' "$url" 2>"$work/curl.err")" \
        || unavailable "$(tr -d '\n' < "$work/curl.err" | cut -c1-120)"
    [ "$code" = "200" ] || unavailable "HTTP $code from $kind"
}

# more <file>: prints "1" when another page remains.
more() {
    python3 -c '
import json, sys
try:
    p = json.load(open(sys.argv[1])).get("paging", {})
    print(1 if p.get("pageIndex", 1) * p.get("pageSize", 1) < p.get("total", 0) else 0)
except Exception:
    print(0)' "$1"
}

for kind in issues hotspots; do
    page=1
    while [ "$page" -le "$MAX_PAGES" ]; do
        if [ "$kind" = issues ]; then
            url="$API/issues/search?componentKeys=$PROJECT_KEY&issueStatuses=OPEN,CONFIRMED&types=BUG,VULNERABILITY&ps=500&p=$page"
        else
            url="$API/hotspots/search?projectKey=$PROJECT_KEY&status=TO_REVIEW&ps=500&p=$page"
        fi
        fetch "$kind" "$page" "$url"
        [ "$(more "$work/$kind.$page.json")" = 1 ] || break
        page=$((page + 1))
    done
    # Falling out of the loop (rather than breaking) means another page remained: a silent
    # cap would read as "no findings", so say so instead.
    [ "$page" -le "$MAX_PAGES" ] || unavailable "more than $((MAX_PAGES * 500)) open $kind; list truncated"
done

python3 - "$work" 2>/dev/null <<'PY' || unavailable "unparseable response"
import glob, json, os, sys
work = sys.argv[1]
prefix = "visiban_visiban:"
touched = {l.strip().removeprefix("./") for l in open(os.path.join(work, "touched.txt")) if l.strip()}
rows = []
for f in sorted(glob.glob(os.path.join(work, "issues.*.json"))):
    for i in json.load(open(f))["issues"]:
        rows.append((i["component"], i.get("line", 0), i["rule"], i["type"], i["message"]))
for f in sorted(glob.glob(os.path.join(work, "hotspots.*.json"))):
    for h in json.load(open(f))["hotspots"]:
        rows.append((h["component"], h.get("line", 0), h["ruleKey"], "HOTSPOT", h["message"]))
hits = sorted(r for r in rows if r[0].removeprefix(prefix) in touched)
for comp, line, rule, typ, msg in hits:
    print(f"sonar: {comp.removeprefix(prefix)}:{line} {rule} {typ} {msg}")
if hits:
    print(f"sonar: {len(hits)} open finding(s) on touched files (report as GAP: fix on the branch or defer it to an open issue named in the MR)")
else:
    print("sonar: no open BUG/VULNERABILITY/hotspot findings on touched files")
PY
