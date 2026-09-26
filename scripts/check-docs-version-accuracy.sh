#!/usr/bin/env bash
# scripts/check-docs-version-accuracy.sh — CI gate for issue #1083.
#
# Stale version claims in the docs are silent misinformation: a page that says
# "Coming in 1.1" after 1.1 shipped tells an evaluator a shipped feature is
# missing, and a GA docs site that still carries the release-candidate banner
# tells them the product is unfinished. Both have happened here (release.sh
# used to rewrite the docs/index.md banner for RC tags but not for GA), and
# both were only ever fixed by hand. This gate makes them fail CI instead.
#
# The "current version" is read from frontend/package.json, the same file
# scripts/release.sh rewrites on every release, so the gate and the release
# script cross-check each other from a single source of truth. A pre-release
# version (1.2.0-rc.1) means 1.2.0 is NOT yet released; only a plain X.Y.Z
# counts as shipped.
#
# Checks (scan set = README.md, VISIBAN_FEATURES.md, docs/**/*.md):
#   1. Future-tense claims — "Coming in X", "Ships in X", "Lands in X",
#      "Arrives in X", "Planned for X", "Scheduled/Slated/Targeted for X",
#      "Expected in X", "Will ship/land in X" — where X is at or below the
#      current released version. "New in X" is deliberately NOT flagged: it is
#      a provenance label that stays true forever ("New in 1.1" is correct
#      after 1.1 ships).
#   2. Front-door state — docs/index.md must carry the current version
#      (**X.Y.Z**) and, on a GA version, no release-candidate/beta/alpha
#      wording; README.md pinned image tags, docs/getting-started
#      APP_VERSION= lines and image.tag= values must equal the current version.
#   3. Tag pipelines — when CI_COMMIT_TAG is set it must equal v<current>, so
#      a tag cut from a tree whose release rewrite was skipped fails at tag time.
#
# There is no allowlist. Fix the page.
#
# Usage:
#   scripts/check-docs-version-accuracy.sh [--root <dir>]
#   scripts/check-docs-version-accuracy.sh --self-test
#
# Exit codes: 0 = clean, 1 = violation (or --self-test failure).
#
# Portable bash 3.2 / BusyBox: no associative arrays, no grep -P, no mapfile,
# bare `set -eu` (see docs/development/ci-gates.md).

set -eu

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$REPO_ROOT"
SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) SELF_TEST=1; shift ;;
    --root) ROOT="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Future-tense phrases followed by a version. Case-insensitive at grep time.
PHRASE_RE='(coming|ships?|lands?|arrives?|planned|scheduled|slated|targeted|expected|will (ship|land|arrive))( in| for) v?[0-9]+\.[0-9]+(\.[0-9]+)?'

# ver_key <X.Y[.Z]> — numeric sort key; missing patch counts as 0.
ver_key() {
  echo "$1" | awk -F. '{ printf "%d", $1 * 1000000 + $2 * 1000 + ($3 == "" ? 0 : $3) }'
}

# check_tree <root> <commit-tag-or-empty> — prints violations to stderr,
# returns 1 if any.
check_tree() {
  local root="$1" tag="$2" pkg current base pre cur_key v=0
  pkg="$root/frontend/package.json"
  if [ ! -f "$pkg" ]; then
    echo "check-docs-version-accuracy: $pkg not found — cannot determine the current version." >&2
    return 1
  fi
  current=$(grep -m1 '"version"' "$pkg" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?' | head -1 || true)
  if [ -z "$current" ]; then
    echo "check-docs-version-accuracy: no version found in $pkg." >&2
    return 1
  fi
  base="${current%%-*}"
  pre=""
  if [ "$base" != "$current" ]; then pre="${current#*-}"; fi
  cur_key=$(ver_key "$base")
  if [ -n "$pre" ]; then
    echo "check-docs-version-accuracy: current version $current (pre-release)"
  else
    echo "check-docs-version-accuracy: current version $current (GA)"
  fi

  # --- 1. future-tense claims about released versions -----------------------
  local files f hit line ver key stale
  files=$( (cd "$root" && { [ -f README.md ] && echo README.md; [ -f VISIBAN_FEATURES.md ] && echo VISIBAN_FEATURES.md; [ -d docs ] && find docs -name '*.md' | sort; true; }) )
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      line="${hit%%:*}"
      ver=$(echo "${hit#*:}" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)
      key=$(ver_key "$ver")
      stale=0
      if [ -z "$pre" ]; then
        if [ "$key" -le "$cur_key" ]; then stale=1; fi
      else
        if [ "$key" -lt "$cur_key" ]; then stale=1; fi
      fi
      if [ "$stale" -eq 1 ]; then
        echo "VIOLATION: $f:$line — \"${hit#*:}\" refers to $ver, already released (current: $current)." >&2
        v=$((v + 1))
      fi
    done <<EOH
$(grep -noiE "$PHRASE_RE" "$root/$f" || true)
EOH
  done <<EOF
$files
EOF

  # --- 2. front-door state --------------------------------------------------
  local idx="$root/docs/index.md"
  if [ -f "$idx" ]; then
    if ! grep -qF "**${current}**" "$idx"; then
      echo "VIOLATION: docs/index.md — banner does not name the current version **${current}** (release.sh should have rewritten it)." >&2
      v=$((v + 1))
    fi
    if [ -z "$pre" ] && grep -qiE 'release candidate|\*\*[0-9.]+-(rc|beta|alpha)\.[0-9]+\*\*' "$idx"; then
      echo "VIOLATION: docs/index.md — GA version $current but the page still carries release-candidate/pre-release banner text." >&2
      v=$((v + 1))
    fi
  else
    echo "VIOLATION: docs/index.md not found." >&2
    v=$((v + 1))
  fi

  if [ -f "$root/README.md" ]; then
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      if [ "${hit#*:}" != "v${current}" ]; then
        echo "VIOLATION: README.md:${hit%%:*} — pinned image tag ${hit#*:} does not match v${current}." >&2
        v=$((v + 1))
      fi
    done <<EOH
$(grep -noE 'visiban/(backend|frontend):v[0-9][0-9A-Za-z.+-]*' "$root/README.md" | sed -E 's/^([0-9]+):.*:(v.*)$/\1:\2/' || true)
EOH
  fi

  if [ -d "$root/docs/getting-started" ]; then
    local hf hl hv
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      # hit = file:line:APP_VERSION=X or file:line:image.tag=vX
      hf="${hit%%:*}"; hl="${hit#*:}"; hl="${hl%%:*}"; hv="${hit##*=}"
      case "$hit" in
        *APP_VERSION=*)
          if [ "$hv" != "$current" ]; then
            echo "VIOLATION: ${hf#"$root"/}:$hl — APP_VERSION=$hv does not match $current." >&2
            v=$((v + 1))
          fi ;;
        *)
          if [ "$hv" != "v${current}" ]; then
            echo "VIOLATION: ${hf#"$root"/}:$hl — image tag $hv does not match v${current}." >&2
            v=$((v + 1))
          fi ;;
      esac
    done <<EOH
$(grep -rnoE '(APP_VERSION=[0-9][0-9A-Za-z.+-]*|image\.tag=v[0-9][0-9A-Za-z.+-]*)' "$root/docs/getting-started" || true)
EOH
  fi

  # --- 3. tag pipelines -----------------------------------------------------
  if [ -n "$tag" ] && [ "$tag" != "v${current}" ]; then
    echo "VIOLATION: tag $tag does not match frontend/package.json version v${current} — the release rewrite was skipped or the tag is on the wrong commit." >&2
    v=$((v + 1))
  fi

  if [ "$v" -gt 0 ]; then
    echo "check-docs-version-accuracy: $v violation(s)." >&2
    return 1
  fi
  echo "check-docs-version-accuracy: clean."
}

# mk_tree <dir> <version> — a minimal known-good tree for <version>.
mk_tree() {
  local d="$1" ver="$2" tag="v$2"
  mkdir -p "$d/frontend" "$d/docs/getting-started"
  printf '{\n  "version": "%s"\n}\n' "$ver" > "$d/frontend/package.json"
  printf '# Visiban\n\n!!! note "Latest release"\n    **%s** is the current stable release.\n' "$ver" > "$d/docs/index.md"
  printf 'docker pull ghcr.io/visiban/visiban/backend:%s\nCall it Coming in 9.9 someday.\n' "$tag" > "$d/README.md"
  printf 'APP_VERSION=%s\n' "$ver" > "$d/docs/getting-started/installation.md"
  printf 'Something *new in 1.0* is fine, and Ships in 9.9 is future.\n' > "$d/docs/feature.md"
}

self_test() {
  local tmp out rc
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT
  echo "=== check-docs-version-accuracy.sh --self-test ==="

  expect_fail() { # <label> <root> <needle> [tag]
    rc=0; out=$(check_tree "$2" "${4:-}" 2>&1) || rc=$?
    if [ "$rc" -eq 0 ] || ! echo "$out" | grep -qF "$3"; then
      echo "SELF-TEST FAILED: $1 — expected violation containing '$3'." >&2
      echo "$out" >&2
      exit 1
    fi
    echo "OK: $1"
  }

  # Known-good GA tree (future versions and "new in" must pass).
  mk_tree "$tmp/good" 1.1.0
  rc=0; out=$(check_tree "$tmp/good" "v1.1.0" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SELF-TEST FAILED: known-good GA tree was rejected." >&2; echo "$out" >&2; exit 1
  fi
  echo "OK: known-good GA tree passes (future 'Coming in 9.9' and 'new in 1.0' spared)"

  # Stale "Coming in 1.1" on a 1.1.0 tree — the issue's headline case.
  mk_tree "$tmp/stale" 1.1.0
  echo 'Task import: Coming in 1.1' >> "$tmp/stale/docs/feature.md"
  expect_fail "stale 'Coming in 1.1' after 1.1.0 GA" "$tmp/stale" "docs/feature.md"

  # Stale claim in README.md (outside docs/ — TruePPM's blind spot).
  mk_tree "$tmp/readme" 1.1.0
  echo 'Lands in 1.0.' >> "$tmp/readme/README.md"
  expect_fail "stale claim in README.md is in scope" "$tmp/readme" "README.md"

  # RC banner surviving a GA version.
  mk_tree "$tmp/rcbanner" 1.1.0
  printf '# Visiban\n\n!!! warning "Release candidate"\n    **1.1.0** is the current stable release candidate.\n' > "$tmp/rcbanner/docs/index.md"
  expect_fail "RC banner on a GA version" "$tmp/rcbanner" "release-candidate"

  # Banner naming an old version.
  mk_tree "$tmp/oldbanner" 1.1.0
  printf '# Visiban\n\n!!! note "Latest release"\n    **1.0.0** is the current stable release.\n' > "$tmp/oldbanner/docs/index.md"
  expect_fail "banner names the wrong version" "$tmp/oldbanner" "does not name the current version"

  # Stale install pins.
  mk_tree "$tmp/pins" 1.1.0
  printf 'APP_VERSION=1.0.0\n' > "$tmp/pins/docs/getting-started/installation.md"
  expect_fail "stale APP_VERSION in getting-started" "$tmp/pins" "APP_VERSION=1.0.0"
  mk_tree "$tmp/readmepin" 1.1.0
  printf 'docker pull ghcr.io/visiban/visiban/backend:v1.0.0\n' > "$tmp/readmepin/README.md"
  expect_fail "stale README image tag" "$tmp/readmepin" "pinned image tag"

  # Tag mismatch.
  expect_fail "tag pipeline on a tree that was not rewritten" "$tmp/good" "does not match frontend/package.json" "v1.2.0"

  # Pre-release tree: 1.2.0-rc.1 — 1.2 not yet released, so "Coming in 1.2"
  # passes and "Planned for 1.1" still fails.
  mk_tree "$tmp/rc" 1.2.0-rc.1
  printf '# Visiban\n\n!!! warning "Release candidate"\n    **1.2.0-rc.1** is the current stable release candidate.\n' > "$tmp/rc/docs/index.md"
  echo 'Feature X: Coming in 1.2' >> "$tmp/rc/docs/feature.md"
  rc=0; out=$(check_tree "$tmp/rc" "" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "SELF-TEST FAILED: RC tree with 'Coming in 1.2' should pass." >&2; echo "$out" >&2; exit 1
  fi
  echo "OK: RC tree accepts 'Coming in 1.2' (1.2.0 unreleased)"
  echo 'Feature Y: Planned for 1.1' >> "$tmp/rc/docs/feature.md"
  expect_fail "RC tree still rejects 'Planned for 1.1'" "$tmp/rc" "docs/feature.md"

  echo "=== check-docs-version-accuracy.sh --self-test: PASSED ==="
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit 0
fi

check_tree "$ROOT" "${CI_COMMIT_TAG:-}"
