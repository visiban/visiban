#!/usr/bin/env bash
# scripts/check-compose-image-pins.sh — every third-party image in a shipped
# compose file carries an explicit version tag.
#
# Why this exists. `certbot/certbot` shipped in docker-compose.prod.yml with no
# tag at all, so Docker resolved `:latest` on every `compose pull`. It was the
# only unpinned image in the production stack — postgres, valkey and nginx all
# carried floors — and it was the one component that owns TLS issuance and
# renewal. An image line with no tag looks exactly like an image line with one
# until you go looking for the colon, which is why a human reading the file does
# not catch it and a gate does.
#
# SCOPE: third-party images only — a reference with no `${` in it. First-party
# images are deliberately `${APP_VERSION:-latest}` so an operator selects the
# release through .env, and whether that default should be `latest` is a
# separate question. This gate takes no position on it and must not be widened
# to, or it will re-open a settled decision as a pipeline failure.
#
# Usage:  scripts/check-compose-image-pins.sh [--self-test]
# Exit:   0 all third-party images pinned · 1 at least one unpinned

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

COMPOSE_FILES=(
  docker-compose.yml
  docker-compose.prod.yml
  docker-compose.oidc.yml
)

# Scan one compose file. Emits one "<file>:<line>\t<image>\t<reason>" per
# violation on stdout. Returns 0 always — the caller counts lines, so a file
# with no `image:` keys is not mistaken for a pass that never ran.
scan_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  # `image:` values only, comments stripped. Not a YAML parse: these files are
  # hand-written with one image per line, and a parser would need the .env the
  # gate deliberately does not have.
  grep -n '^[[:space:]]*image:[[:space:]]*' "$file" 2>/dev/null | while IFS= read -r hit; do
    local lineno ref
    lineno="${hit%%:*}"
    ref="$(printf '%s' "${hit#*:}" | sed -e 's/^[[:space:]]*image:[[:space:]]*//' -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//')"
    [[ -n "$ref" ]] || continue
    # First-party, operator-selected via .env — out of scope, see SCOPE above.
    case "$ref" in *'${'*) continue ;; esac
    # Strip a registry host[:port] prefix before looking for the tag separator,
    # or `registry.example.com:5000/img` reads as tagged when it is not.
    local after_host="${ref##*/}"
    case "$after_host" in
      *:*)
        local tag="${after_host##*:}"
        if [[ "$tag" == "latest" ]]; then
          printf '%s:%s\t%s\t%s\n' "$file" "$lineno" "$ref" "pinned to the floating 'latest' tag"
        fi
        ;;
      *)
        printf '%s:%s\t%s\t%s\n' "$file" "$lineno" "$ref" "no tag — Docker resolves this to 'latest'"
        ;;
    esac
  done
  return 0
}

run_check() {
  local root="$1" violations=0 scanned=0 f found
  cd "$root"
  for f in "${COMPOSE_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    scanned=$((scanned + 1))
    found="$(scan_file "$f")"
    if [[ -n "$found" ]]; then
      while IFS=$'\t' read -r loc ref reason; do
        [[ -n "$loc" ]] || continue
        printf '  %-34s %-38s %s\n' "$loc" "$ref" "$reason"
        violations=$((violations + 1))
      done <<< "$found"
    fi
  done
  if (( scanned == 0 )); then
    echo "ERROR: no compose files found under $root — the gate scanned nothing." >&2
    return 1
  fi
  printf '\n  scanned %d compose file(s)\n' "$scanned"
  return $(( violations > 0 ? 1 : 0 ))
}

# --self-test: plant a known-unpinned image in a throwaway copy and assert the
# gate reports it. A gate observed only on a clean tree is indistinguishable
# from one that always passes (#1093).
if [[ "${1:-}" == "--self-test" ]]; then
  echo "self-test: a planted unpinned image must be caught"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp "$REPO_ROOT"/docker-compose*.yml "$tmp/" 2>/dev/null || true

  # Case 1: clean tree passes.
  if ! run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: the unmodified tree should pass but did not." >&2
    exit 1
  fi

  # Case 2: no tag at all is caught.
  printf '\n  probe:\n    image: example/unpinned\n' >> "$tmp/docker-compose.prod.yml"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an untagged image was not reported." >&2
    exit 1
  fi

  # Case 3: an explicit `latest` is caught too.
  cp "$REPO_ROOT"/docker-compose.prod.yml "$tmp/docker-compose.prod.yml"
  printf '\n  probe:\n    image: example/floating:latest\n' >> "$tmp/docker-compose.prod.yml"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an image tagged 'latest' was not reported." >&2
    exit 1
  fi

  # Case 4: a ${VAR} first-party reference is NOT reported (scope guard).
  cp "$REPO_ROOT"/docker-compose.prod.yml "$tmp/docker-compose.prod.yml"
  printf '\n  probe:\n    image: ghcr.io/visiban/visiban/backend:${APP_VERSION:-latest}\n' >> "$tmp/docker-compose.prod.yml"
  if ! run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a first-party \${APP_VERSION} reference was reported; it is out of scope." >&2
    exit 1
  fi

  # Case 5: a registry host with a PORT and no tag is still caught — the colon
  # in `host:5000` must not read as a tag separator.
  cp "$REPO_ROOT"/docker-compose.prod.yml "$tmp/docker-compose.prod.yml"
  printf '\n  probe:\n    image: registry.example.com:5000/thing\n' >> "$tmp/docker-compose.prod.yml"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a ported-registry reference with no tag was not reported." >&2
    exit 1
  fi

  echo "self-test OK: catches untagged, ':latest' and ported-registry refs; ignores \${VAR} first-party refs."
  exit 0
fi

echo "compose image pins — every third-party image carries an explicit tag"
echo
if run_check "$REPO_ROOT"; then
  echo "OK: all third-party compose images are pinned."
else
  cat >&2 <<'MSG'

FAIL: the image(s) above carry no explicit version.

An untagged image resolves to `latest`, so the version changes under the stack
on any `docker compose pull` with no diff and no pipeline event. Pin it to a
released tag, matching the sibling services in the same file.

First-party images are intentionally `${APP_VERSION:-latest}` and are not
checked here — see the SCOPE note at the top of this script.
MSG
  exit 1
fi
