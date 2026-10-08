#!/usr/bin/env sh
# scripts/check-trivyignore-expiry.sh — expiry gate for .trivyignore.yaml (#1072).
#
# Trivy honors `expired_at` by silently IGNORING an expired suppression, which
# is not a failure signal on its own. This gate makes the policy explicit: it
# FAILS (exit 1) when any entry in the file
#   - has no `expired_at`,
#   - has an `expired_at` that is not YYYY-MM-DD or is before today, or
#   - has no `#NNNN` issue reference in its `statement`.
# Exit 3 = usage error. Runs in the (alpine) trivy image: POSIX sh + awk only.
#
# Entries are recognized by a line starting with `  - id:` (the layout used in
# .trivyignore.yaml); everything up to the next such line belongs to the entry.
# TODAY=YYYY-MM-DD overrides the clock (used by --self-test and the unit test).
#
# Usage: sh scripts/check-trivyignore-expiry.sh [file]   (default .trivyignore.yaml)
#        sh scripts/check-trivyignore-expiry.sh --self-test
set -eu

check_file() {
  _file="$1"
  _today="${TODAY:-$(date +%Y-%m-%d)}"
  [ -f "$_file" ] || { echo "check-trivyignore-expiry: $_file not found" >&2; return 1; }
  awk -v today="$_today" -v file="$_file" '
    function flush() {
      if (id == "") return
      n++
      if (expd == "") { print file ": " id ": missing expired_at"; bad++ }
      else if (expd !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) { print file ": " id ": expired_at \"" expd "\" is not YYYY-MM-DD"; bad++ }
      else if (expd < today) { print file ": " id ": EXPIRED on " expd " (today " today ")"; bad++ }
      if (stmt !~ /#[0-9]+/) { print file ": " id ": statement has no #NNNN issue reference"; bad++ }
    }
    /^[[:space:]]*-[[:space:]]+id:/ { flush(); id = $0; sub(/^[^:]*:[[:space:]]*/, "", id); expd = ""; stmt = ""; instmt = 0; next }
    id == "" { next }
    /^[[:space:]]+expired_at:/ { expd = $0; sub(/^[^:]*:[[:space:]]*/, "", expd); gsub(/["\047 ]/, "", expd); instmt = 0; next }
    /^[[:space:]]+statement:/ { stmt = $0; instmt = 1; next }
    /^[[:space:]]+[a-z_]+:/ { instmt = 0; next }
    instmt { stmt = stmt " " $0 }
    END { flush(); if (bad > 0) exit 1; print "check-trivyignore-expiry: " n+0 " entr" (n==1?"y":"ies") " OK (none expired)" }
  ' "$_file"
}

self_test() {
  _d="$(mktemp -d)"; trap 'rm -rf "$_d"' EXIT
  printf 'misconfigurations:\n  - id: X-1\n    statement: ok #12\n    expired_at: 2030-01-01\n' > "$_d/good.yaml"
  printf 'misconfigurations:\n  - id: X-1\n    statement: ok #12\n    expired_at: 2020-01-01\n' > "$_d/expired.yaml"
  printf 'misconfigurations:\n  - id: X-1\n    statement: ok #12\n' > "$_d/noexp.yaml"
  printf 'misconfigurations:\n  - id: X-1\n    statement: no link\n    expired_at: 2030-01-01\n' > "$_d/nolink.yaml"
  echo "=== check-trivyignore-expiry.sh --self-test ==="
  TODAY=2026-10-08 check_file "$_d/good.yaml" >/dev/null || { echo "FAIL: good file rejected" >&2; exit 1; }
  for f in expired noexp nolink; do
    if TODAY=2026-10-08 check_file "$_d/$f.yaml" >/dev/null 2>&1; then
      echo "FAIL: $f.yaml was accepted" >&2; exit 1
    fi
  done
  echo "=== check-trivyignore-expiry.sh --self-test: PASSED ==="
}

case "${1:-}" in
  --self-test) self_test ;;
  -*) echo "usage: $0 [file|--self-test]" >&2; exit 3 ;;
  *) check_file "${1:-.trivyignore.yaml}" ;;
esac
