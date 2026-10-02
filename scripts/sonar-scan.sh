#!/bin/sh
# Prepare coverage reports for SonarCloud and (optionally) run a local scan (#1370).
#
# SonarCloud does not run tests, it imports coverage reports. Two of the reports
# need a rewrite before the scanner (which runs from the repo root) can resolve
# their file paths; without it the scanner reads the report, resolves zero files
# and reports 0.0% coverage. This script is the single home of those rewrites:
# the `sonar:scan` CI job calls `sh scripts/sonar-scan.sh --prep-only`, and a
# developer runs it without the flag to reproduce the CI scan.
#
# POSIX sh on purpose: the sonar-scanner-cli CI image is Alpine and has no bash.
#
# Usage:
#   SONAR_TOKEN=xxxxxxxx scripts/sonar-scan.sh   # prep + scan
#   scripts/sonar-scan.sh --prep-only            # only write the rewritten reports
#   scripts/sonar-scan.sh --self-test            # prove both rewrites on fixtures
#
# Inputs (generate first; a missing one is a warning, not a failure, so a
# partial scan still works):
#   backend/coverage.xml            Cobertura. cd backend && pytest --cov --cov-report=xml
#   frontend/coverage/lcov.info     LCOV. cd frontend && npm test -- --coverage
# Outputs, pointed at by sonar-project.properties:
#   backend/coverage.sonar.xml
#   frontend/coverage/lcov.sonar.info

set -eu

# --self-test: build a fixture tree in a temp dir, run --prep-only against it
# (via SONAR_SCAN_ROOT, which exists only for this) and assert both rewrites.
# If a rewrite regresses, SonarCloud silently resolves zero files and reports
# 0.0% coverage again with nothing going red (#1370).
if [ "${1:-}" = "--self-test" ]; then
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    mkdir -p "$tmp/backend" "$tmp/frontend/coverage"
    printf '<coverage><sources><source></source></sources><class filename="boards/models.py"/></coverage>\n' > "$tmp/backend/coverage.xml"
    printf 'TN:\nSF:src/App.tsx\nDA:1,1\nend_of_record\n' > "$tmp/frontend/coverage/lcov.info"
    st_fail=0
    expect() { # expect "<description>" <command...>
        desc="$1"; shift
        if "$@" >/dev/null 2>&1; then echo "ok: $desc"; else echo "FAIL: $desc"; st_fail=1; fi
    }
    SONAR_SCAN_ROOT="$tmp" sh "$0" --prep-only >"$tmp/out.log" 2>&1 || st_fail=1
    expect "backend <source> points at <root>/backend" grep -q "<source>$tmp/backend</source>" "$tmp/backend/coverage.sonar.xml"
    expect "backend filenames untouched" grep -q 'filename="boards/models.py"' "$tmp/backend/coverage.sonar.xml"
    expect "frontend SF: prefixed with frontend/" grep -q '^SF:frontend/src/App.tsx$' "$tmp/frontend/coverage/lcov.sonar.info"
    expect "no un-prefixed SF:src/ remains" test "$(grep -c '^SF:src/' "$tmp/frontend/coverage/lcov.sonar.info")" = 0
    expect "original lcov.info unmodified" grep -q '^SF:src/App.tsx$' "$tmp/frontend/coverage/lcov.info"
    expect "sanity line counts 1 class entry" grep -q 'resolved: 1 class entries' "$tmp/out.log"
    expect "sanity line counts 1 SF file" grep -q 'resolved: 1 SF files' "$tmp/out.log"
    # A non-empty <source> must pass through unchanged.
    printf '<coverage><sources><source>/abs</source></sources></coverage>\n' > "$tmp/backend/coverage.xml"
    SONAR_SCAN_ROOT="$tmp" sh "$0" --prep-only >/dev/null 2>&1 || st_fail=1
    expect "non-empty <source> is a no-op" grep -q '<source>/abs</source>' "$tmp/backend/coverage.sonar.xml"
    # Missing inputs warn but must not fail.
    rm "$tmp/backend/coverage.xml" "$tmp/frontend/coverage/lcov.info"
    expect "missing reports do not fail prep-only" env SONAR_SCAN_ROOT="$tmp" sh "$0" --prep-only
    if [ "$st_fail" -eq 0 ]; then echo "sonar-scan self-test passed"; fi
    exit "$st_fail"
fi

REPO_ROOT="${SONAR_SCAN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "${REPO_ROOT}"

PREP_ONLY=0
if [ "${1:-}" = "--prep-only" ]; then
    PREP_ONLY=1
fi

# backend/.coveragerc sets `relative_files = true` (so the parallel backend-test
# shards combine across runners), which makes coverage.xml emit an EMPTY
# `<source></source>` and filenames relative to backend/. From the repo root the
# scanner would resolve them against the root and drop every file (TruePPM #2113:
# 0 of 328 files resolved). Inject the real package root. The substitution is a
# no-op on a report that already carries a non-empty <source>.
if [ -f backend/coverage.xml ]; then
    sed "s#<source></source>#<source>${REPO_ROOT}/backend</source>#" backend/coverage.xml > backend/coverage.sonar.xml
    echo "wrote backend/coverage.sonar.xml (resolvable <source> root)"
else
    echo "! backend/coverage.xml not found: backend coverage will not import." >&2
    echo "  Run: cd backend && pytest --cov --cov-report=xml" >&2
fi

# vitest records `SF:src/...` relative to frontend/. Rewrite to
# `SF:frontend/src/...` so the paths resolve from the repo root.
if [ -f frontend/coverage/lcov.info ]; then
    sed 's|^SF:src/|SF:frontend/src/|' frontend/coverage/lcov.info > frontend/coverage/lcov.sonar.info
    echo "wrote frontend/coverage/lcov.sonar.info (repo-root-relative SF paths)"
else
    echo "! frontend/coverage/lcov.info not found: frontend coverage will not import." >&2
    echo "  Run: cd frontend && npm test -- --coverage" >&2
fi

# Sanity line for the nightly log: how many files each rewritten report lists.
# Zero means the scanner will import nothing from that report.
if [ -f backend/coverage.sonar.xml ]; then
    n_class="$(grep -c '<class ' backend/coverage.sonar.xml || true)"
    echo "backend/coverage.sonar.xml resolved: ${n_class} class entries"
    [ "${n_class}" -gt 0 ] || echo "! backend/coverage.sonar.xml lists 0 classes: no backend coverage will import." >&2
fi
if [ -f frontend/coverage/lcov.sonar.info ]; then
    n_sf="$(grep -c '^SF:' frontend/coverage/lcov.sonar.info || true)"
    echo "frontend/coverage/lcov.sonar.info resolved: ${n_sf} SF files"
    [ "${n_sf}" -gt 0 ] || echo "! frontend/coverage/lcov.sonar.info lists 0 files: no frontend coverage will import." >&2
fi

if [ "${PREP_ONLY}" = "1" ]; then
    echo "prep-only: skipping sonar-scanner."
    exit 0
fi

if ! command -v sonar-scanner >/dev/null 2>&1; then
    echo "sonar-scanner not on PATH. Install it (brew install sonar-scanner) or run the docker image." >&2
    exit 1
fi
if [ -z "${SONAR_TOKEN:-}" ]; then
    echo "SONAR_TOKEN is not set. Export a SonarCloud token before scanning." >&2
    exit 1
fi

exec sonar-scanner
