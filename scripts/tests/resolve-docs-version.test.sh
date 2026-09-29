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

echo ""
if [[ "$fail" -eq 0 ]]; then
  echo "resolve-docs-version.test.sh: all $pass checks passed"
  exit 0
else
  echo "resolve-docs-version.test.sh: $fail failed, $pass passed"
  exit 1
fi
