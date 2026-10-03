#!/usr/bin/env sh
# Unit tests for scripts/npm-audit-gate.mjs (#1415).
set -eu
cd "$(dirname "$0")/../.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { # name expected-exit actual-exit
  if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 (want $2, got $3)"; fi
}
run() { node scripts/npm-audit-gate.mjs "$@" >/dev/null 2>&1 && echo 0 || echo $?; }

cat > "$T/braces.json" <<'J'
{"vulnerabilities":{
 "braces":{"via":[{"source":1,"title":"braces DoS","url":"https://github.com/advisories/GHSA-vfj7-8cjw-p6xm","severity":"high"}]},
 "chokidar":{"via":["braces"]}}}
J
cat > "$T/other.json" <<'J'
{"vulnerabilities":{"foo":{"via":[{"source":2,"title":"foo RCE","url":"https://github.com/advisories/GHSA-aaaa-bbbb-cccc","severity":"critical"}]}}}
J
echo '{"vulnerabilities":{"x":{"via":[{"source":3,"title":"m","url":"https://github.com/advisories/GHSA-low","severity":"moderate"}]}}}' > "$T/mod.json"
cat > "$T/ok.toml" <<'J'
[[IgnoredVulns]]
id = "GHSA-vfj7-8cjw-p6xm"
ignoreUntil = 2026-11-30
J
echo 'not json' > "$T/bad.json"

check "accepted advisory passes"        0 "$(run "$T/braces.json" "$T/ok.toml" 2026-10-03)"
check "expired ignore blocks"           1 "$(run "$T/braces.json" "$T/ok.toml" 2026-12-01)"
check "no toml blocks"                  1 "$(run "$T/braces.json" "$T/missing.toml" 2026-10-03)"
check "unaccepted critical blocks"      1 "$(run "$T/other.json" "$T/ok.toml" 2026-10-03)"
check "moderate does not block"         0 "$(run "$T/mod.json" "$T/ok.toml" 2026-10-03)"
check "unparseable input fails safe"    1 "$(run "$T/bad.json" "$T/ok.toml" 2026-10-03)"
check "missing arg is usage error"      3 "$(run)"

echo "npm-audit-gate: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
