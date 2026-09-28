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
#   scripts/render-nginx-hsts.sh --check <template-file>
#     Read-only. Asserts three things against the TRACKED template (does not
#     modify it): (1) exactly one __HSTS_HEADER_PLACEHOLDER__ line and no
#     literal, hardcoded `add_header Strict-Transport-Security` directive
#     anywhere else — the negative control this closes is the old bug
#     reappearing verbatim, which --self-test's synthetic fixtures cannot
#     catch because they never touch the real file; (2) every `location`
#     block containing `proxy_pass` also contains
#     `proxy_hide_header Strict-Transport-Security`, so Django's own copy of
#     the header never doubles up with nginx's; (3) dry-renders scratch
#     copies for TLS_MODE=letsencrypt and TLS_MODE=selfsigned with
#     SECURE_HSTS_SECONDS unset (the default path every fresh install takes)
#     and checks the rendered output — exactly one HSTS line for
#     letsencrypt, none for selfsigned, no placeholder left in either.
#
#   scripts/render-nginx-hsts.sh --self-test
#     Exercises the rendering logic AND --check against synthetic templates
#     in a temp directory. Touches nothing in this repository, needs no
#     network.
#
# Exit codes: 0 success · 1 invalid SECURE_HSTS_SECONDS, missing placeholder,
#             a --check violation, or usage error.

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

# A real, uncommented add_header directive for the header — as opposed to the
# `__HSTS_HEADER_PLACEHOLDER__` token, or prose in a comment that merely
# mentions "Strict-Transport-Security" (e.g. this script's own header, or the
# explanatory comment above the placeholder in the template).
_HARDCODED_HSTS_RE='^[[:space:]]*add_header[[:space:]]+Strict-Transport-Security'

# check_template <template-file>
#
# Read-only. Prints violations to stderr and returns 1 if any are found; does
# not modify <template-file>. See the --check usage note above for what each
# of the three checks covers and why --self-test's synthetic fixtures cannot
# substitute for running this against the real, tracked template.
check_template() {
  local file="$1" violations=0

  if [[ ! -f "$file" ]]; then
    echo "ERROR: $file not found." >&2
    return 1
  fi

  # 1. Exactly one placeholder, and no hardcoded HSTS add_header anywhere —
  # this is the negative control: re-introducing the original bug verbatim
  # (a bare `add_header Strict-Transport-Security "max-age=63072000..."`
  # line back in the template) must fail this check even though it would
  # still pass --self-test, since --self-test never reads this file.
  local placeholder_count hardcoded
  placeholder_count="$(grep -c '__HSTS_HEADER_PLACEHOLDER__' "$file" || true)"
  if [[ "$placeholder_count" -ne 1 ]]; then
    echo "VIOLATION: $file has ${placeholder_count} __HSTS_HEADER_PLACEHOLDER__ line(s); expected exactly 1." >&2
    violations=$((violations + 1))
  fi
  hardcoded="$(grep -nE "$_HARDCODED_HSTS_RE" "$file" || true)"
  if [[ -n "$hardcoded" ]]; then
    echo "VIOLATION: $file has a literal, hardcoded Strict-Transport-Security add_header line — it must be rendered via __HSTS_HEADER_PLACEHOLDER__ instead:" >&2
    echo "$hardcoded" >&2
    violations=$((violations + 1))
  fi

  # 2. Every location block that proxy_passes to the backend must hide
  # Django's own independently-computed copy of the header — otherwise the
  # client gets two Strict-Transport-Security headers on that response,
  # which RFC 6797 §8.1 says browsers must then ignore entirely.
  # NOTE: matches on "location" followed by whitespace, not a `\b` word
  # boundary — `\b` is a GNU-awk extension (it means a literal backspace to
  # POSIX/BSD awk, including the busybox awk these CI jobs actually run
  # under), so a `\b`-based pattern here silently matches nothing.
  local block_violations
  block_violations="$(awk '
    /^[[:space:]]*location[[:space:]]/ { in_loc=1; depth=0; has_pass=0; has_hide=0; name=$0 }
    in_loc {
      if ($0 ~ /proxy_pass/) has_pass=1
      if ($0 ~ /proxy_hide_header[ \t]+Strict-Transport-Security/) has_hide=1
      depth += gsub(/\{/, "{")
      depth -= gsub(/\}/, "}")
      if (depth == 0) {
        if (has_pass && !has_hide) print name
        in_loc=0
      }
    }
  ' "$file")"
  if [[ -n "$block_violations" ]]; then
    echo "VIOLATION: location block(s) proxy_pass to the backend without a proxy_hide_header Strict-Transport-Security line:" >&2
    echo "$block_violations" >&2
    violations=$((violations + 1))
  fi

  # 3. Dry-render scratch copies for the two TLS modes that actually render
  # this header, with SECURE_HSTS_SECONDS unset (the default path every
  # fresh install takes), and check the output. Copies only — the tracked
  # file itself is never modified by --check.
  local tmp_le tmp_ss le_count ss_count
  tmp_le="$(mktemp)"
  tmp_ss="$(mktemp)"
  cp "$file" "$tmp_le"
  cp "$file" "$tmp_ss"

  if ! ( unset SECURE_HSTS_SECONDS 2>/dev/null; render_into_file "$tmp_le" "letsencrypt" ); then
    echo "VIOLATION: dry-render of $file for TLS_MODE=letsencrypt (SECURE_HSTS_SECONDS unset) failed." >&2
    violations=$((violations + 1))
  else
    le_count="$(grep -cE "${_HARDCODED_HSTS_RE}.*max-age=63072000" "$tmp_le" || true)"
    if [[ "$le_count" -ne 1 ]]; then
      echo "VIOLATION: letsencrypt default dry-render produced ${le_count} HSTS line(s) with max-age=63072000; expected exactly 1." >&2
      violations=$((violations + 1))
    fi
    if grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp_le"; then
      echo "VIOLATION: letsencrypt default dry-render left the placeholder unrendered." >&2
      violations=$((violations + 1))
    fi
  fi

  if ! ( unset SECURE_HSTS_SECONDS 2>/dev/null; render_into_file "$tmp_ss" "selfsigned" ); then
    echo "VIOLATION: dry-render of $file for TLS_MODE=selfsigned (SECURE_HSTS_SECONDS unset) failed." >&2
    violations=$((violations + 1))
  else
    ss_count="$(grep -cE "$_HARDCODED_HSTS_RE" "$tmp_ss" || true)"
    if [[ "$ss_count" -ne 0 ]]; then
      echo "VIOLATION: selfsigned default dry-render sent ${ss_count} HSTS line(s); expected 0 (no HSTS by default)." >&2
      violations=$((violations + 1))
    fi
    if grep -q '__HSTS_HEADER_PLACEHOLDER__' "$tmp_ss"; then
      echo "VIOLATION: selfsigned default dry-render left the placeholder unrendered." >&2
      violations=$((violations + 1))
    fi
  fi

  rm -f "$tmp_le" "$tmp_ss"

  if [[ "$violations" -gt 0 ]]; then
    return 1
  fi
  echo "OK: $file — one placeholder, no hardcoded HSTS line, every proxy_pass location hides Django's copy, and both TLS-mode dry-renders match the documented defaults."
}

# --self-test: covers every scenario the #1201 gate batch and completeness-
# check named, plus the leading-zero / octal footgun the batch actually
# found. Touches nothing in this repository — all fixtures live under a
# throwaway temp directory. Cases 1-9 exercise render_into_file; cases 10-12
# exercise check_template, including the negative controls proving it catches
# what synthetic fixtures alone cannot (the old hardcoded header reappearing
# in, and a proxy_pass location missing proxy_hide_header in, the ACTUAL
# tracked template — see the compose-hygiene CI job, which runs
# `--check nginx/app.conf.template` right after this self-test for exactly
# that reason).
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

  # Fixtures for check_template — these add proxied `location` blocks, which
  # the plain `fixture` above deliberately omits (it only exercises
  # render_into_file, not the location-block scan).
  fixture_good() {
    printf '%s\n' \
      'server {' \
      '    listen 443 ssl;' \
      '    __HSTS_HEADER_PLACEHOLDER__' \
      '    add_header X-Frame-Options "DENY" always;' \
      '' \
      '    location /api/ {' \
      '        proxy_pass http://backend:8000;' \
      '        proxy_hide_header  Strict-Transport-Security;' \
      '    }' \
      '' \
      '    location /admin/ {' \
      '        proxy_pass http://backend:8000;' \
      '        proxy_hide_header Strict-Transport-Security;' \
      '    }' \
      '}' \
      > "$1"
  }

  # The exact regression check_template exists to catch: the old hardcoded
  # header reappears verbatim in place of the placeholder — something
  # render_into_file's own tests above can never exercise, since they run
  # against synthetic fixtures, never the tracked template.
  fixture_hardcoded() {
    printf '%s\n' \
      'server {' \
      '    listen 443 ssl;' \
      '    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;' \
      '    add_header X-Frame-Options "DENY" always;' \
      '' \
      '    location /api/ {' \
      '        proxy_pass http://backend:8000;' \
      '        proxy_hide_header  Strict-Transport-Security;' \
      '    }' \
      '}' \
      > "$1"
  }

  # A proxied location that forgot proxy_hide_header — Django's own HSTS
  # header would then double up with nginx's on that path.
  fixture_missing_hide() {
    printf '%s\n' \
      'server {' \
      '    listen 443 ssl;' \
      '    __HSTS_HEADER_PLACEHOLDER__' \
      '    add_header X-Frame-Options "DENY" always;' \
      '' \
      '    location /api/ {' \
      '        proxy_pass http://backend:8000;' \
      '    }' \
      '}' \
      > "$1"
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

  # 10. check_template positive control: a well-formed template (one
  # placeholder, every proxy_pass location hides the header, both dry-render
  # defaults come out as documented) passes clean.
  fixture_good "$tmp/case10.conf"
  rc=0
  check_template "$tmp/case10.conf" >/dev/null 2>&1 || rc=$?
  check "check_template passes a well-formed template (positive control)" \
    "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"

  # 11. check_template negative control #1 — the actual completeness-check
  # finding: --self-test's synthetic fixtures never read nginx/app.conf.template,
  # so re-hardcoding the old 2-year header directly in that file would pass
  # --self-test cleanly while shipping the original bug. check_template must
  # catch this by reading the real file, which is what --check is for.
  fixture_hardcoded "$tmp/case11.conf"
  rc=0
  check_template "$tmp/case11.conf" >/dev/null 2>&1 || rc=$?
  check "check_template fails when the old hardcoded HSTS line reappears" \
    "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"

  # 12. check_template negative control #2 — a proxied location missing
  # proxy_hide_header would double up nginx's and Django's HSTS headers.
  fixture_missing_hide "$tmp/case12.conf"
  rc=0
  check_template "$tmp/case12.conf" >/dev/null 2>&1 || rc=$?
  check "check_template fails when a proxy_pass location is missing proxy_hide_header" \
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
  --check)
    if [[ $# -ne 2 ]]; then
      echo "Usage: $0 --check <template-file>" >&2
      exit 1
    fi
    check_template "$2"
    ;;
  -h|--help)
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    echo "Usage: $0 <template-file> <tls-mode>" >&2
    echo "       $0 --check <template-file>" >&2
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
