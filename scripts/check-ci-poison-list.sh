#!/usr/bin/env bash
# scripts/check-ci-poison-list.sh — fail when .gitlab-ci.yml or a script under
# scripts/ uses a `*_TOKEN` variable that scripts/ci-poison-env.sh neither
# poisons nor exempts (#2461). Scripts count because several tokens (GH_TOKEN,
# KAIZEN_API_TOKEN, ...) are read only inside a script, never named in the CI
# file. Skipped: scripts/tests/ (fixtures), the poison/canary files, and this
# script (its self-test fixtures).
# A forgotten token would stay visible to script-tests on main only, which is
# exactly the #2412 class (green MR, red main).
#
# Usage: scripts/check-ci-poison-list.sh [--ci-file F] [--poison-file F] [--scripts-dir D]
#        scripts/check-ci-poison-list.sh --self-test
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check() {
  local ci_file="$1" poison_file="$2" scripts_dir="${3:-}" known="" tok src rc=0 seen=""
  [ -f "$ci_file" ] && [ -f "$poison_file" ] || { echo "ERROR: missing input file" >&2; return 3; }
  # Subshell: sourcing exports sentinels we do not want in this shell.
  # Source under POSIX `sh` (the file must load in busybox) in a child process so the
  # exported sentinels never reach this shell.
  known="$(sh -c '. "$1" >/dev/null 2>&1
    for v in $CI_POISON_VARS; do echo "$v"; done
    printf "%s\n" "$CI_POISON_EXEMPT" | while IFS= read -r e; do
      [ -n "$e" ] && echo "${e%%:*}"
    done' sh "$poison_file")"
  # Non-comment lines; a trailing _FILE (VISIBAN_FUZZ_TOKEN_FILE) is a path, not a secret.
  while IFS= read -r src; do
    [ -f "$src" ] || continue
    while IFS= read -r tok; do
      [ -n "$tok" ] || continue
      grep -qxF "$tok" <<<"$known" && continue
      grep -qxF "$tok" <<<"$seen" && continue
      seen="$seen"$'\n'"$tok"
      echo "FAIL: $tok is referenced in ${src#"$ROOT"/} but is not in CI_POISON_VARS or CI_POISON_EXEMPT" >&2
      echo "      Add it to scripts/ci-poison-env.sh (poison it, or exempt it with a reason)." >&2
      rc=1
    done < <(grep -vE '^[[:space:]]*#' "$src" | grep -oE '(^|[^A-Z0-9_])[A-Z][A-Z0-9_]*_TOKEN([^A-Z0-9_]|$)' \
              | grep -oE '[A-Z][A-Z0-9_]*_TOKEN' | sort -u)
  done < <(echo "$ci_file"
           [ -z "$scripts_dir" ] || find "$scripts_dir" -type f ! -path "$scripts_dir/tests/*" \
             ! -name ci-poison-env.sh ! -name ci-api-canary.py ! -name check-ci-poison-list.sh | sort)
  [ $rc -eq 0 ] && echo "OK: every *_TOKEN variable in $(basename "$ci_file")${scripts_dir:+ and $(basename "$scripts_dir")/} is poisoned or exempted."
  return $rc
}

# shellcheck disable=SC2016  # single quotes are deliberate: literal YAML fixtures
self_test() {
  local tmp rc=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  printf 'CI_POISON_VARS="A_TOKEN"\nCI_POISON_EXEMPT="\nB_TOKEN:why\n"\n' >"$tmp/p.sh"
  printf 'j:\n  script:\n    - echo "$A_TOKEN" "${B_TOKEN}"\n  variables:\n    X_TOKEN_FILE: f\n' >"$tmp/ok.yml"
  check "$tmp/ok.yml" "$tmp/p.sh" >/dev/null 2>&1 || { echo "self-test FAILED: listed tokens rejected" >&2; rc=1; }
  printf 'j:\n  script:\n    - curl -H "T: $NEW_SECRET_TOKEN"\n' >"$tmp/bad.yml"
  check "$tmp/bad.yml" "$tmp/p.sh" >/dev/null 2>&1 && { echo "self-test FAILED: new token not detected" >&2; rc=1; }
  printf 'j:\n  # uses $NEW_SECRET_TOKEN\n  script: [true]\n' >"$tmp/cmt.yml"
  check "$tmp/cmt.yml" "$tmp/p.sh" >/dev/null 2>&1 || { echo "self-test FAILED: comment mention flagged" >&2; rc=1; }
  # Scripts: a token named only inside a script must be listed too.
  mkdir -p "$tmp/s/tests" "$tmp/s2/tests"
  printf '#!/bin/sh\n# GH_ONLY_TOKEN in a comment is fine\ncurl -H "T: $A_TOKEN"\n' >"$tmp/s/ok.sh"
  printf 'X_FIXTURE_TOKEN=1\n' >"$tmp/s/tests/fixture.test.sh"
  printf 'FAKE_POISON_TOKEN=1\n' >"$tmp/s/ci-poison-env.sh"
  check "$tmp/ok.yml" "$tmp/p.sh" "$tmp/s" >/dev/null 2>&1 || { echo "self-test FAILED: listed script token, tests/ fixture or skipped file flagged" >&2; rc=1; }
  printf 'import os\nos.environ["GH_ONLY_TOKEN"]\n' >"$tmp/s2/filer.py"
  check "$tmp/ok.yml" "$tmp/p.sh" "$tmp/s2" >/dev/null 2>&1 && { echo "self-test FAILED: token named only in a script not detected" >&2; rc=1; }
  [ $rc -eq 0 ] && echo "self-test OK"
  return $rc
}

CI_FILE="$ROOT/.gitlab-ci.yml"; POISON="$ROOT/scripts/ci-poison-env.sh"; SCRIPTS="$ROOT/scripts"
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) self_test; exit $? ;;
    --ci-file) CI_FILE="$2"; shift 2 ;;
    --poison-file) POISON="$2"; shift 2 ;;
    --scripts-dir) SCRIPTS="$2"; shift 2 ;;
    *) echo "usage: $0 [--ci-file F] [--poison-file F] [--scripts-dir D] | --self-test" >&2; exit 3 ;;
  esac
done
check "$CI_FILE" "$POISON" "$SCRIPTS"
