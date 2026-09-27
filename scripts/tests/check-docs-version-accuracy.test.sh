#!/usr/bin/env bash
# scripts/tests/check-docs-version-accuracy.test.sh
#
# Tests for scripts/check-docs-version-accuracy.sh (#1083), driven through the
# public --root interface against small fixture trees. Covers the issue's
# acceptance criteria directly:
#   - "Coming in 1.1" fails once 1.1.0 is released; "Coming in 1.2" passes
#   - a GA tree carrying the RC banner fails
#   - README.md is inside the scan root
#   - the real repository passes as it stands
#
# Run: bash scripts/tests/check-docs-version-accuracy.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$REPO_ROOT/scripts/check-docs-version-accuracy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
pass=0
# run_gate <root> — sets RC and OUT
run_gate() { RC=0; OUT=$(env -u CI_COMMIT_TAG bash "$GATE" --root "$1" 2>&1) || RC=$?; }
expect() { # <desc> <expected-rc> [needle]
  if [[ "$RC" -ne "$2" ]] || { [[ -n "${3:-}" ]] && ! grep -qF "$3" <<<"$OUT"; }; then
    echo "  FAIL: $1 (rc=$RC)"; echo "    ${OUT//$'\n'/$'\n'    }"; fail=$((fail + 1))
  else
    pass=$((pass + 1))
  fi
}

new_tree() { # <dir> <version>
  mkdir -p "$1/frontend" "$1/docs/getting-started"
  printf '{ "version": "%s" }\n' "$2" > "$1/frontend/package.json"
  printf '!!! note "Latest release"\n    **%s** is the current stable release.\n' "$2" > "$1/docs/index.md"
  printf 'docker pull ghcr.io/visiban/visiban/backend:v%s\n' "$2" > "$1/README.md"
  # v-prefixed: APP_VERSION is the image tag operators pin (matches the
  # tags CI actually publishes to GHCR — #1174), not a bare version string.
  printf 'APP_VERSION=v%s\n' "$2" > "$1/docs/getting-started/installation.md"
  : > "$1/VISIBAN_FEATURES.md"
}

new_tree "$TMP/a" 1.1.0
echo "Coming in 1.2" >> "$TMP/a/docs/getting-started/why-visiban.md"
run_gate "$TMP/a"; expect "Coming in 1.2 passes when 1.2 is unreleased" 0

new_tree "$TMP/b" 1.1.0
echo "Coming in 1.1" >> "$TMP/b/docs/getting-started/why-visiban.md"
run_gate "$TMP/b"; expect "Coming in 1.1 fails once 1.1.0 is released" 1 "why-visiban.md:1"

new_tree "$TMP/c" 1.1.0
echo "This ships in 1.0.5" >> "$TMP/c/VISIBAN_FEATURES.md"
run_gate "$TMP/c"; expect "VISIBAN_FEATURES.md is scanned" 1 "VISIBAN_FEATURES.md:1"

new_tree "$TMP/d" 1.1.0
echo "Planned for 1.1" >> "$TMP/d/README.md"
run_gate "$TMP/d"; expect "README.md is scanned" 1 "README.md:2"

new_tree "$TMP/e" 1.1.0
printf '!!! warning "Release candidate"\n    **1.1.0-rc.3** is the current stable release candidate.\n' > "$TMP/e/docs/index.md"
run_gate "$TMP/e"; expect "RC banner on a GA tree fails" 1 "docs/index.md"

new_tree "$TMP/f" 1.1.0
echo "Added in 1.1 (new in 1.1)" >> "$TMP/f/docs/feature.md"
run_gate "$TMP/f"; expect "'new in X' provenance labels are not flagged" 0

new_tree "$TMP/g" 1.2.0-rc.1
printf '!!! warning "Release candidate"\n    **1.2.0-rc.1** is the current stable release candidate.\n' > "$TMP/g/docs/index.md"
echo "Coming in 1.2" >> "$TMP/g/docs/feature.md"
run_gate "$TMP/g"; expect "RC tree: Coming in 1.2 passes" 0

# #1174 — a bare APP_VERSION naming the current version names a tag that
# does not exist on GHCR; it must fail, not pass.
new_tree "$TMP/h" 1.1.0
printf 'APP_VERSION=1.1.0\n' > "$TMP/h/docs/getting-started/installation.md"
run_gate "$TMP/h"; expect "bare APP_VERSION pin fails (no v prefix)" 1 "v prefix"

# The real repository must be clean as it stands.
run_gate "$REPO_ROOT"; expect "real repository passes" 0

bash "$GATE" --self-test >/dev/null || { echo "  FAIL: --self-test"; fail=$((fail + 1)); }

echo "check-docs-version-accuracy tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
