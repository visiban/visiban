#!/usr/bin/env bash
# scripts/check-compose-project-names.sh — every standalone root compose file
# pins its own, distinct top-level `name:`.
#
# Why this exists. docker-compose.prod.yml pinned no project name, so it was
# derived from the CHECKOUT DIRECTORY — `visiban` on a default `git clone`.
# docker-compose.yml defaulted to `${COMPOSE_PROJECT_NAME:-visiban}`. Both
# therefore resolved to the same project, and two consequences follow, both
# reachable by following the docs as written:
#
#   1. dev and prod both declare a bare `pgdata:` volume, so they shared
#      `visiban_pgdata`. Postgres applies POSTGRES_PASSWORD only on first init,
#      so whichever stack came second met the other's password — or, in the
#      other order, `docker compose up` landed on production data guarded only
#      by the hardcoded dev SECRET_KEY.
#   2. dev and prod share the service names `db`, `valkey` and `backend`, and
#      two files in one project that share a service name RECREATE each other's
#      containers in place on `up`.
#
# SCOPE. "Standalone" files are the ones an operator runs on their own:
# docker-compose.yml and docker-compose.prod.yml. docker-compose.oidc.yml is an
# OVERLAY, always combined with docker-compose.yml
# (`-f docker-compose.yml -f docker-compose.oidc.yml`). It must NOT declare a
# `name:` — a second file's `name:` overrides the first, which would silently
# rename the dev stack the overlay is meant to extend. The gate asserts that too.
#
# DEFAULTED NAMES. Visiban parameterizes the dev name as
# `${COMPOSE_PROJECT_NAME:-visiban-dev}` so scripts/wt can share one stack across
# worktrees. Uniqueness is therefore compared on the DEFAULT inside `${VAR:-…}`,
# not the literal string: two files whose defaults collide collide in practice on
# any checkout where the variable is unset.
#
# What this cannot see: COMPOSE_PROJECT_NAME in the environment. Compose
# precedence is `-p` > COMPOSE_PROJECT_NAME > `name:` > directory basename, so an
# exported variable defeats every pin here. scripts/wt exports `visiban-dev` for
# that reason; see docs/getting-started/parallel-worktrees.md.
#
# Usage:  scripts/check-compose-project-names.sh [--self-test]
# Exit:   0 every standalone file pins a distinct name · 1 otherwise

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STANDALONE_FILES=(
  docker-compose.yml
  docker-compose.prod.yml
)
OVERLAY_FILES=(
  docker-compose.oidc.yml
)

# Print the value of the top-level `name:` key (empty if none). Not a YAML
# parse: the key must be at column 0, which is where Compose requires it.
project_name_of() {
  local file="$1"
  sed -n -e 's/^name:[[:space:]]*//p' "$file" \
    | sed -e 's/[[:space:]]*#.*$//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//" \
    | sed -n '1p'
}

# Reduce `${VAR:-default}` to `default`; anything else passes through. This is
# what an operator with the variable unset actually gets, which is the case the
# collision above was reachable in.
effective_name_of() {
  local raw="$1"
  if [[ "$raw" =~ ^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
  else
    printf '%s\n' "$raw"
  fi
}

run_check() {
  local root="$1" violations=0 scanned=0 f raw name seen=""
  cd "$root"
  for f in "${STANDALONE_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    scanned=$((scanned + 1))
    raw="$(project_name_of "$f")"
    if [[ -z "$raw" ]]; then
      printf '  %-28s no top-level `name:` — project name falls back to the checkout directory\n' "$f"
      violations=$((violations + 1))
      continue
    fi
    name="$(effective_name_of "$raw")"
    if grep -qxF "$name" <<<"$seen"; then
      printf '  %-28s effective name `%s` is already used by another compose file\n' "$f" "$name"
      violations=$((violations + 1))
    fi
    seen+="$name"$'\n'
    if [[ "$raw" == "$name" ]]; then
      printf '  %-28s name: %s\n' "$f" "$raw"
    else
      printf '  %-28s name: %s  (effective: %s)\n' "$f" "$raw" "$name"
    fi
  done
  for f in "${OVERLAY_FILES[@]}"; do
    [[ -f "$f" ]] || continue
    raw="$(project_name_of "$f")"
    if [[ -n "$raw" ]]; then
      printf '  %-28s overlay declares `name: %s` — it would rename the stack it extends\n' "$f" "$raw"
      violations=$((violations + 1))
    fi
  done
  if (( scanned == 0 )); then
    echo "ERROR: no compose files found under $root — the gate scanned nothing." >&2
    return 1
  fi
  printf '\n  scanned %d standalone compose file(s)\n' "$scanned"
  return $(( violations > 0 ? 1 : 0 ))
}

# --self-test: plant each violation in a throwaway copy and assert the gate
# reports it. A gate observed only on a clean tree is indistinguishable from one
# that always passes (#1093).
if [[ "${1:-}" == "--self-test" ]]; then
  echo "self-test: planted missing, duplicate and overlay names must be caught"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp "$REPO_ROOT"/docker-compose*.yml "$tmp/"

  reset() { cp "$REPO_ROOT"/docker-compose*.yml "$tmp/"; }

  # Case 1: clean tree passes.
  if ! run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: the unmodified tree should pass but did not." >&2
    exit 1
  fi

  # Case 2: a missing pin is caught.
  sed -i.bak '/^name:/d' "$tmp/docker-compose.prod.yml" && rm -f "$tmp/docker-compose.prod.yml.bak"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a compose file with no name: was not reported." >&2
    exit 1
  fi

  # Case 3: two files sharing a name is caught.
  reset
  sed -i.bak 's/^name:.*/name: visiban/' "$tmp/docker-compose.yml" && rm -f "$tmp/docker-compose.yml.bak"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a duplicate project name was not reported." >&2
    exit 1
  fi

  # Case 4: a ${VAR:-default} whose DEFAULT collides is caught — this is the
  # exact shape the original defect had.
  reset
  sed -i.bak 's/^name:.*/name: ${COMPOSE_PROJECT_NAME:-visiban}/' "$tmp/docker-compose.yml" \
    && rm -f "$tmp/docker-compose.yml.bak"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: a \${VAR:-default} colliding on its default was not reported." >&2
    exit 1
  fi

  # Case 5: an overlay that declares a name is caught.
  reset
  printf 'name: visiban-oidc\n' >> "$tmp/docker-compose.oidc.yml"
  if run_check "$tmp" >/dev/null 2>&1; then
    echo "SELF-TEST FAILED: an overlay declaring name: was not reported." >&2
    exit 1
  fi

  echo "self-test OK: catches a missing name, a duplicate name, a colliding \${VAR:-default} and an overlay name."
  exit 0
fi

echo "compose project names — every standalone compose file pins a distinct name"
echo
if run_check "$REPO_ROOT"; then
  echo "OK: every standalone compose file pins its own project name."
else
  cat >&2 <<'MSG'

FAIL: see the file(s) above.

Two compose files in one project share volumes (same bare volume name) and
recreate each other's containers in place (same service name). The project name
is what keeps them apart, and unpinned it comes from the checkout directory —
`visiban` on a default clone, which is exactly what prod pins.

Give each standalone file its own top-level `name:` (dev:
${COMPOSE_PROJECT_NAME:-visiban-dev}, prod: visiban), and keep overlays such as
docker-compose.oidc.yml free of one.
MSG
  exit 1
fi
