#!/usr/bin/env bash
# scripts/tests/refresh_test_durations.test.sh
#
# Unit test for scripts/refresh_test_durations.py (#2422), which rebuilds
# backend/.test_durations (pytest-split's shard-balancing data) from CI's JUnit
# times. A wrong mapping here does not fail any build: it silently unbalances
# the 8 backend-test shards, which is how the file went 5x stale unnoticed.
#
# Covers: class, nested-class, module-level and parametrized node ids; repeated
# rows summed; rows whose test no longer collects dropped; a JUnit pair that two
# collected ids share dropped rather than guessed; collected-but-untimed ids left
# out; other test-report suites ignored; JUnit XML input; sorted, 4-space output;
# a missing suite and an out-of-tree --output refused.
#
# Run: bash scripts/tests/refresh_test_durations.test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${ROOT}/scripts/refresh_test_durations.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail=0
ok() { echo "ok - $1"; }
bad() { echo "not ok - $1"; fail=1; }

cat > "$WORK/collected.txt" <<'EOF'
boards/tests/test_a.py::ATests::test_one
boards/tests/test_a.py::ATests::Inner::test_nested
boards/tests/test_a.py::test_module_level
boards/tests/test_a.py::test_param[x-1]
boards/tests/test_a.py::test_never_timed
pkg/mod.py::B::test_amb
pkg/mod/B.py::test_amb

-- Docs: https://docs.pytest.org/en/stable/how-to/capture-warnings.html
7 tests collected in 0.10s
EOF

cat > "$WORK/report.json" <<'EOF'
{"test_suites": [
  {"name": "backend-test", "test_cases": [
    {"classname": "boards.tests.test_a.ATests", "name": "test_one", "execution_time": 1.5},
    {"classname": "boards.tests.test_a.ATests", "name": "test_one", "execution_time": 0.5},
    {"classname": "boards.tests.test_a.ATests.Inner", "name": "test_nested", "execution_time": 2.0},
    {"classname": "boards.tests.test_a", "name": "test_module_level", "execution_time": 3.0},
    {"classname": "boards.tests.test_a", "name": "test_param[x-1]", "execution_time": 4.0},
    {"classname": "boards.tests.test_gone.GoneTests", "name": "test_removed", "execution_time": 9.0},
    {"classname": "git_lens.tests.test_api", "name": "", "execution_time": 0.0},
    {"classname": "pkg.mod.B", "name": "test_amb", "execution_time": 5.0}
  ]},
  {"name": "frontend-test", "test_cases": [
    {"classname": "boards.tests.test_a.ATests", "name": "test_one", "execution_time": 99.0}
  ]}
]}
EOF

if python3 "$SCRIPT" --test-report "$WORK/report.json" --collected "$WORK/collected.txt" \
     --output "$WORK/out.json" 2>"$WORK/err.txt"; then ok "test-report run exits 0"; else bad "test-report run exits 0"; cat "$WORK/err.txt"; fi

if python3 - "$WORK/out.json" <<'PY'
import json, sys
text = open(sys.argv[1]).read()
got = json.loads(text)
want = {
    "boards/tests/test_a.py::ATests::Inner::test_nested": 2.0,
    "boards/tests/test_a.py::ATests::test_one": 2.0,
    "boards/tests/test_a.py::test_module_level": 3.0,
    "boards/tests/test_a.py::test_param[x-1]": 4.0,
}
assert got == want, got
assert list(got) == sorted(got), "keys not sorted"
assert text.startswith('{\n    "'), "not 4-space indented"
PY
then ok "maps class/nested/module/param ids, sums repeats, drops vanished/ambiguous/other-suite rows"; else bad "mapping"; fi

grep -q "4 entries (11 s) from 8 rows; 7 collected, 3 untimed; dropped 2 unknown and 1 ambiguous rows; summed 1 repeated rows" "$WORK/err.txt" \
  && ok "summary line counts every outcome" || { bad "summary line"; cat "$WORK/err.txt"; }

cat > "$WORK/junit-1.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest">
  <testcase classname="boards.tests.test_a.ATests" name="test_one" time="0.25"/>
  <testcase classname="boards.tests.test_a" name="test_param[x-1]" time="0.75"><skipped/></testcase>
</testsuite></testsuites>
EOF
if python3 "$SCRIPT" --junit "$WORK/junit-1.xml" --collected "$WORK/collected.txt" 2>/dev/null \
   | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d == {"boards/tests/test_a.py::ATests::test_one": 0.25, "boards/tests/test_a.py::test_param[x-1]": 0.75}, d'; then
  ok "reads JUnit XML"; else bad "reads JUnit XML"; fi

if python3 "$SCRIPT" --test-report "$WORK/report.json" --suite no-such-suite --collected "$WORK/collected.txt" >/dev/null 2>&1; then
  bad "missing suite is refused"; else ok "missing suite is refused"; fi

if python3 "$SCRIPT" --test-report "$WORK/report.json" --collected "$WORK/collected.txt" --output /etc/visiban-2422.json >/dev/null 2>&1; then
  bad "out-of-tree --output is refused"; else ok "out-of-tree --output is refused"; fi

if python3 "$SCRIPT" --collected "$WORK/collected.txt" >/dev/null 2>&1; then
  bad "no timing input is refused"; else ok "no timing input is refused"; fi

# #2503: the collection interpreter is a fixed repo path, not an argv value.
err=$(python3 "$SCRIPT" --test-report "$WORK/report.json" --collect --python /bin/sh 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "unrecognized arguments" <<<"$err"; then
  ok "--python is no longer accepted"; else bad "--python is no longer accepted"; fi
err=$(python3 "$SCRIPT" --test-report "$WORK/report.json" --collect --python /no/such/python 2>&1 >/dev/null) && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "unrecognized arguments" <<<"$err"; then
  ok "--python with a nonexistent path is rejected by argparse"; else bad "--python with a nonexistent path is rejected by argparse"; fi

# #2503: collect() fails with a clear message when the backend venv interpreter is missing.
err=$(python3 - "$SCRIPT" <<'PY' 2>&1 >/dev/null
import importlib.util, pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location("rtd", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.BACKEND_PYTHON = pathlib.Path("/no/such/venv/bin/python")
mod.collect()
PY
) && rc=0 || rc=$?
if [ "$rc" -ne 0 ] && grep -q "/no/such/venv/bin/python not found" <<<"$err"; then
  ok "collect() refuses a missing backend venv interpreter"; else bad "collect() refuses a missing backend venv interpreter"; fi

exit "$fail"
