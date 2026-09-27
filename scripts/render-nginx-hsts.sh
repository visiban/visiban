#!/usr/bin/env bash
# scripts/render-nginx-hsts.sh — render (or omit) the Strict-Transport-Security
# `add_header` line in the production nginx template, from SECURE_HSTS_SECONDS
# and TLS_MODE (#1201).
#
# WHY THIS EXISTS. nginx/app.conf.template used to hardcode
# `add_header Strict-Transport-Security "max-age=63072000; includeSubDomains"
# always;` unconditionally for both TLS_MODE=letsencrypt and
# TLS_MODE=selfsigned, contradicting installation.md (selfsigned promises no
# HSTS by default) and ignoring an operator-set SECURE_HSTS_SECONDS. This
# script renders the header into the template's `__HSTS_HEADER_PLACEHOLDER__`
# line instead, so init-prod.sh, this script's --self-test, and a human
# reading the diff all agree on one place the logic lives.
#
# TLS_MODE=letsencrypt defaults to the historical 63072000 (2 years) when
# SECURE_HSTS_SECONDS is unset, preserving existing installs' behavior.
# TLS_MODE=selfsigned (or anything else) defaults to no header at all,
# matching the docs; an operator opts back in by setting SECURE_HSTS_SECONDS
# explicitly.
#
# VALIDATION. SECURE_HSTS_SECONDS must be "0" or a run of digits with no
# leading zero, at most 10 digits. This is deliberately tighter than what
# Django's env.int() accepts, and deliberately NOT checked with bash
# arithmetic (`[[ -gt 0 ]]` / `(( ))`). A gate-batch review on #1201 found
# that the first version of this logic used `[[ "$HSTS_MAX_AGE" -gt 0 ]]`,
# which bash evaluates as an arithmetic expression: `SECURE_HSTS_SECONDS=008`
# passes a naive `^[0-9]+$` check but is invalid octal to `-gt`, which raises
# an error under `set -e` and made the *whole script* exit 0 having rendered
# NO HSTS header — a silent downgrade to no HSTS on a letsencrypt install
# over what looked like a harmless zero-padded value. This script instead
# rejects a leading-zero (or overlong) value outright with a clear error, and
# once a value is known to match the pattern below, decides "is it zero"
# with a plain string comparison (`!= "0"`) that never goes through bash
# arithmetic at all.
#
# Usage:
#   scripts/render-nginx-hsts.sh <template-file> <tls-mode>
#     Rewrites <template-file> IN PLACE: the __HSTS_HEADER_PLACEHOLDER__ line
#     is replaced with a rendered `add_header Strict-Transport-Security ...`
#     directive, or removed entirely when no header should be sent. Reads
#     SECURE_HSTS_SECONDS from the environment (the same var Django's
#     SecurityMiddleware reads — see backend/visiban/settings.py).
#
#   scripts/render-nginx-hsts.sh --self-test
#     Exercises the rendering logic against synthetic templates in a temp
#     directory. Touches nothing in this repository, needs no network.
#
# Exit codes: 0 success · 1 invalid SECURE_HSTS_SECONDS, missing placeholder,
#             or usage error.

set -euo pipefail

# "0", or a positive integer with no leading zero, capped at 10 digits
# (~9.9B seconds / ~317 years — already an absurd HSTS value, and short
# enough to always be safely representable as plain text with no arithmetic
# performed on it anywhere in this script).
_HSTS_SECONDS_RE='^(0|[1-9][0-9]{0,9})$'

# render_hsts_line <tls-mode> <secure-hsts-seconds>
#
# Prints the add_header directive to render on stdout, or nothing (valid: it
# means "send no header"). Returns 1 and prints an error to stderr if
# <secure-hsts-seconds> is non-empty and does not match $_HSTS_SECONDS_RE.
render_hsts_line() {
  local tls_mode="$1" hsts_seconds="${2:-}"

  if [[ -n "$hsts_seconds" ]] && ! [[ "$hsts_seconds" =~ $_HSTS_SECONDS_RE ]]; then
    echo "ERROR: SECURE_HSTS_SECONDS must be '0' or a positive integer with no leading zero, at most 10 digits (got '${hsts_seconds}')." >&2
    return 1
  fi

  local max_age
  if [[ "$tls_mode" == "letsencrypt" ]]; then
    # Preserve the historical 2-year default for existing letsencrypt
    # installs that don't set SECURE_HSTS_SECONDS explicitly (#1201) — this
    # fix is about the header ignoring an operator's value and leaking into
    # selfsigned, not about changing what letsencrypt sends out of the box.
    max_age="${hsts_seconds:-63072000}"
  else
    # selfsigned (and any other non-letsencrypt mode): no HSTS by default,
    # matching installation.md. An operator who explicitly sets
    # SECURE_HSTS_SECONDS in .env opts back in.
    max_age="${hsts_seconds:-0}"
  fi

  # String comparison, not arithmetic — see VALIDATION above. $max_age is
  # already known to match $_HSTS_SECONDS_RE at this point (either validated
  # above, or one of the two literal defaults), so "is it zero" is exactly
  # "is the string '0'".
  if [[ "$max_age" != "0" ]]; then
    printf '    add_header Strict-Transport-Security "max-age=%s; includeSubDomains" always;\n' "$max_age"
  fi
}

# render_into_file <template-file> <tls-mode>
#
# Rewrites <template-file> in place: the __HSTS_HEADER_PLACEHOLDER__ line is
# replaced by render_hsts_line's output, or removed entirely if that output
# is empty. Leaves <template-file> untouched and returns 1 if the placeholder
# line is missing or render_hsts_line rejects SECURE_HSTS_SECONDS.
render_into_file() {
  local template_file="$1" tls_mode="$2"
  local hsts_line rc=0

  hsts_line="$(render_hsts_line "$tls_mode" "${SECURE_HSTS_SECONDS:-}")" || rc=$?
  if [[ $rc -ne 0 ]]; then
    return 1
  fi

  if ! grep -q '__HSTS_HEADER_PLACEHOLDER__' "$template_file"; then
    echo "ERROR: $template_file has no __HSTS_HEADER_PLACEHOLDER__ line to render into." >&2
    return 1
  fi

  local tmp
  tmp="$(mktemp)"
  awk -v repl="$hsts_line" '
    /__HSTS_HEADER_PLACEHOLDER__/ { if (repl != "") print repl; next }
    { print }
  ' "$template_file" > "$tmp"
  mv "$tmp" "$template_file"
}

# --self-test: covers every scenario the #1201 gate batch named, plus the
# leading-zero / octal footgun the batch actually found. Touches nothing in
# this repository — all fixtures live under a throwaway temp directory.
self_test() {
  # Deliberately not `local` — the EXIT trap below still needs to read $tmp
  # after this function returns (bash removes `local`s from scope on
  # return, which would otherwise make the trap's own `rm -rf "$tmp"` fail
  # with "unbound variable" under `set -u` once the script actually exits).
  local fail=0 pass=0 rc=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  check() { # check "<description>" <0-if-true>
    local desc="$1" rc="$2"
    if [[ "$rc" -eq 0 ]]; then
      pass=$((pass + 1))
    else
      echo "  FAIL: $desc"
      fail=$((fail + 1))
    fi
  }

  fixture() {
    # A minimal stand-in for nginx/app.conf.template: just enough surrounding
    # content that "the placeholder line is gone afterward" is a meaningful
    # assertion, not trivially true of an empty file.
    printf 'server {\n    listen 443 ssl;\n    __HSTS_HEADER_PLACEHOLDER__\n    add_header X-Frame-Options "DENY" always;\n}\n' > "$1"
  }

  echo "=== render-nginx-hsts.sh --self-test ==="

  # 1. letsencrypt, SECURE_HSTS_SECONDS unset -> 2-year default line.
  fixture "$tmp/case1.conf"
  ( unset SECURE_HSTS_SECONDS 2>/dev/null; render_into_file "$tmp/case1.conf" "letsencrypt" )
  check "letsencrypt default renders max-age=63072000" \
    "$(grep -q 'max-age=63072000; includeSubDomains' "$tmp/case1.conf" && echo 0 || echo 1)"
  check "letsencrypt default leaves no placeholder behind" \
    "$(grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp/case1.conf" && echo 1 || echo 0)"

  # 2. letsencrypt, SECURE_HSTS_SECONDS=300 -> honors the operator's value.
  fixture "$tmp/case2.conf"
  ( export SECURE_HSTS_SECONDS=300; render_into_file "$tmp/case2.conf" "letsencrypt" )
  check "letsencrypt honors SECURE_HSTS_SECONDS=300" \
    "$(grep -q 'max-age=300; includeSubDomains' "$tmp/case2.conf" && echo 0 || echo 1)"

  # 3. selfsigned, SECURE_HSTS_SECONDS unset -> no header, no placeholder left.
  fixture "$tmp/case3.conf"
  ( unset SECURE_HSTS_SECONDS 2>/dev/null; render_into_file "$tmp/case3.conf" "selfsigned" )
  check "selfsigned default sends no Strict-Transport-Security header" \
    "$(grep -q 'Strict-Transport-Security' "$tmp/case3.conf" && echo 1 || echo 0)"
  check "selfsigned default leaves no placeholder behind" \
    "$(grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp/case3.conf" && echo 1 || echo 0)"

  # 4. selfsigned, SECURE_HSTS_SECONDS=300 -> explicit opt-in is honored.
  fixture "$tmp/case4.conf"
  ( export SECURE_HSTS_SECONDS=300; render_into_file "$tmp/case4.conf" "selfsigned" )
  check "selfsigned opt-in (300) sends the header" \
    "$(grep -q 'max-age=300; includeSubDomains' "$tmp/case4.conf" && echo 0 || echo 1)"

  # 5. letsencrypt, SECURE_HSTS_SECONDS=0 -> operator explicitly disabled it.
  fixture "$tmp/case5.conf"
  ( export SECURE_HSTS_SECONDS=0; render_into_file "$tmp/case5.conf" "letsencrypt" )
  check "letsencrypt with SECURE_HSTS_SECONDS=0 sends no header" \
    "$(grep -q 'Strict-Transport-Security' "$tmp/case5.conf" && echo 1 || echo 0)"

  # 6. Invalid non-numeric value must fail loudly, not fall through silently.
  fixture "$tmp/case6.conf"
  rc=0
  ( export SECURE_HSTS_SECONDS=abc; render_into_file "$tmp/case6.conf" "letsencrypt" ) >/dev/null 2>&1 || rc=$?
  check "non-numeric SECURE_HSTS_SECONDS ('abc') is rejected with a nonzero exit" \
    "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
  check "rejected input leaves the template file untouched" \
    "$(grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp/case6.conf" && echo 0 || echo 1)"

  # 7. The exact regression this script exists to close: a leading-zero
  # value must be rejected explicitly, never silently mis-evaluated as
  # invalid octal by a downstream arithmetic comparison.
  fixture "$tmp/case7.conf"
  rc=0
  ( export SECURE_HSTS_SECONDS=008; render_into_file "$tmp/case7.conf" "letsencrypt" ) >/dev/null 2>&1 || rc=$?
  check "leading-zero SECURE_HSTS_SECONDS ('008') is rejected with a nonzero exit" \
    "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"
  check "rejected leading-zero input leaves the template file untouched" \
    "$(grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp/case7.conf" && echo 0 || echo 1)"

  # 8. Overlong value (11 digits) is rejected the same way.
  fixture "$tmp/case8.conf"
  rc=0
  ( export SECURE_HSTS_SECONDS=123456789012; render_into_file "$tmp/case8.conf" "letsencrypt" ) >/dev/null 2>&1 || rc=$?
  check "overlong SECURE_HSTS_SECONDS is rejected with a nonzero exit" \
    "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"

  # 9. A template missing the placeholder entirely must fail loudly rather
  # than silently leaving the header out.
  printf 'server {\n    listen 443 ssl;\n}\n' > "$tmp/case9.conf"
  rc=0
  ( unset SECURE_HSTS_SECONDS 2>/dev/null; render_into_file "$tmp/case9.conf" "letsencrypt" ) >/dev/null 2>&1 || rc=$?
  check "a template with no placeholder line is rejected with a nonzero exit" \
    "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"

  echo ""
  echo "render-nginx-hsts.sh --self-test: ${pass} passed, ${fail} failed."
  if [[ "$fail" -gt 0 ]]; then
    echo "=== render-nginx-hsts.sh --self-test: FAILED ==="
    return 1
  fi
  echo "=== render-nginx-hsts.sh --self-test: PASSED ==="
}

case "${1:-}" in
  --self-test)
    self_test
    exit 0
    ;;
  -h|--help)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    echo "Usage: $0 <template-file> <tls-mode>" >&2
    echo "       $0 --self-test" >&2
    exit 1
    ;;
  *)
    if [[ $# -ne 2 ]]; then
      echo "Usage: $0 <template-file> <tls-mode>" >&2
      exit 1
    fi
    render_into_file "$1" "$2"
    ;;
esac
