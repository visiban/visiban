#!/usr/bin/env bash
# scripts/check-latest-tag-stability.sh — fails when :latest on any
# configured registry does not point at the current newest STABLE release
# tag's digest.
#
# Exists because of a 2026-10 incident: backend-manifest/frontend-manifest
# defaulted :latest onto every release tag, pre-release included, so
# backend:latest/frontend:latest silently tracked v1.2.0-alpha.1 through
# v1.2.0-alpha.3 (on both the GitLab registry and GHCR) for about three days
# before anyone noticed — an unpinned `docker pull` got an in-development
# alpha instead of the last GA. That bug is fixed (STABLE_TAGS gating in
# backend-manifest/frontend-manifest, via classify-release-tag.sh), but a
# fixed CI job going green forever looks exactly like a codebase with no
# regression (cf. check-gate-selftest-parity.sh's whole reason to exist) —
# this is what actually proves it stayed fixed, every tag pipeline, with no
# human running a manual post-release checklist.
#
# "Stable" is whatever scripts/classify-release-tag.sh says it is — this
# script never re-implements that regex itself, so it can't drift out of
# sync with the jobs it's checking the way the original duplicated-regex bug
# happened.
#
# ## Overrides (same shape as check-release-images.sh, for --self-test)
#
# RELEASE_REGISTRIES   space-separated registry image-path prefixes to probe
#                       (default "$CI_REGISTRY_IMAGE ghcr.io/visiban/visiban";
#                       a prefix that resolves empty is dropped).
# RELEASE_IMAGES        space-separated image names under each registry
#                       (default "backend frontend").
# DIGEST_PROBE          command that receives one image reference and prints
#                       its digest to stdout. Defaults to `crane digest`.
#                       Overridable so --self-test runs with no daemon,
#                       network, or registry credentials.
# CLASSIFY_SCRIPT       path to classify-release-tag.sh (default: alongside
#                       this script). Overridable for --self-test.
#
# Usage:
#   scripts/check-latest-tag-stability.sh
#   scripts/check-latest-tag-stability.sh --self-test
#
# Exit codes: 0 = :latest matches the newest stable tag on every configured
#             registry/image, or there is no stable tag yet to check against;
#             1 = a mismatch (or a probe error) was found; 2 = misconfigured
#             (no registry resolvable).

set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY_SCRIPT="${CLASSIFY_SCRIPT:-$SCRIPT_DIR/classify-release-tag.sh}"
RELEASE_IMAGES="${RELEASE_IMAGES:-backend frontend}"

default_registries() {
  local regs=""
  if [ -n "${CI_REGISTRY_IMAGE:-}" ]; then
    regs="${CI_REGISTRY_IMAGE}"
  fi
  if [ -n "$regs" ]; then
    printf '%s ghcr.io/visiban/visiban' "$regs"
  else
    printf 'ghcr.io/visiban/visiban'
  fi
}

is_stable_tag() {
  bash "$CLASSIFY_SCRIPT" "$1" | grep -q '^STABLE=true$'
}

# Highest v* git tag that classify-release-tag.sh calls stable — NOT simply
# the highest v* tag overall (that would pick up a pre-release again, the
# exact mistake this script exists to catch elsewhere). Same versionsort
# suffix registration as check-release-images.sh's resolve_latest_release_tag
# — see its comment for why it's mandatory for correct ordering.
resolve_latest_stable_tag() {
  local tag
  while IFS= read -r tag; do
    [ -z "$tag" ] && continue
    if is_stable_tag "$tag"; then
      printf '%s\n' "$tag"
      return 0
    fi
  done <<TAGS
$(git -c versionsort.suffix=-alpha -c versionsort.suffix=-beta -c versionsort.suffix=-rc \
    for-each-ref --sort=-v:refname --format='%(refname:short)' 'refs/tags/v*' 2>/dev/null)
TAGS
  return 1
}

probe_digest() {
  local ref="$1"
  if [ -n "${DIGEST_PROBE:-}" ]; then
    "$DIGEST_PROBE" "$ref"
  else
    crane digest "$ref"
  fi
}

verify_latest() {
  local stable_tag="$1"
  local registries
  if [ "${RELEASE_REGISTRIES+set}" = "set" ]; then
    registries="$RELEASE_REGISTRIES"
  else
    registries="$(default_registries)"
  fi

  if [ -z "$registries" ]; then
    echo "ERROR: no registry configured — set RELEASE_REGISTRIES, or CI_REGISTRY_IMAGE for the GitLab registry half." >&2
    return 2
  fi

  local mismatches=0 registry image stable_ref latest_ref latest_digest stable_digest rc
  for registry in $registries; do
    for image in $RELEASE_IMAGES; do
      stable_ref="${registry}/${image}:${stable_tag}"
      latest_ref="${registry}/${image}:latest"

      rc=0
      stable_digest="$(probe_digest "$stable_ref" 2>&1)" || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "  PROBE-ERROR ${stable_ref} (could not read the stable release's own digest — cannot verify :latest against it)"
        mismatches=$((mismatches + 1))
        continue
      fi

      rc=0
      latest_digest="$(probe_digest "$latest_ref" 2>&1)" || rc=$?
      if [ "$rc" -ne 0 ]; then
        echo "  PROBE-ERROR ${latest_ref} (could not read its digest)"
        mismatches=$((mismatches + 1))
        continue
      fi

      if [ "$latest_digest" = "$stable_digest" ]; then
        echo "  OK ${latest_ref} == ${stable_ref} (${latest_digest})"
      else
        echo "  MISMATCH ${latest_ref} (${latest_digest}) != ${stable_ref} (${stable_digest})"
        echo "    :latest does not point at the newest stable release. If a pre-release tag was"
        echo "    just published, this is the exact regression class the STABLE_TAGS gating in"
        echo "    backend-manifest/frontend-manifest exists to prevent — check whether"
        echo "    classify-release-tag.sh or its call sites regressed. To restore it manually"
        echo "    (no rebuild needed): docker buildx imagetools create -t ${latest_ref} ${stable_ref}"
        echo "    — see docs/administration/container-image-retention.md."
        mismatches=$((mismatches + 1))
      fi
    done
  done

  [ "$mismatches" -eq 0 ]
}

# --self-test: proves both the resolver (picks the newest STABLE tag, not
# merely the newest tag) and the verifier (match / mismatch / probe-error)
# fire correctly, with no daemon, network, or registry credentials.
self_test() {
  local tmp fail=0 pass=0
  tmp="$(mktemp -d)"
  # Not a RETURN trap: a trap set inside this function is not cleared when
  # it returns, so it would fire again — with $tmp now out of scope — when
  # `main` (which calls self_test and returns its exit code) itself returns,
  # tripping `set -u`. Clean up explicitly at both exits below instead.

  check() { # check "<description>" <0-if-ok>
    if [ "$2" -eq 0 ]; then
      pass=$((pass + 1))
    else
      echo "  SELF-TEST FAIL: $1" >&2
      fail=$((fail + 1))
    fi
  }

  echo "=== check-latest-tag-stability.sh --self-test ==="

  echo "case: resolve_latest_stable_tag picks the newest STABLE tag, not the newest tag overall"
  (
    cd "$tmp"
    git init -q .
    git config user.email test@example.com
    git config user.name test
    git commit -q --allow-empty -m init
    git tag v1.1.0
    git tag v1.2.0-alpha.1
    git tag v1.2.0-alpha.2
    git tag v1.2.0-alpha.3
    out="$(resolve_latest_stable_tag)"
    [ "$out" = "v1.1.0" ]
  )
  check "ignores the newer-but-pre-release v1.2.0-alpha.3, resolves v1.1.0" "$?"

  echo "case: no stable tag exists yet"
  rc=0
  (
    cd "$tmp"
    rm -rf repo2 && mkdir repo2 && cd repo2
    git init -q .
    git config user.email test@example.com
    git config user.name test
    git commit -q --allow-empty -m init
    git tag v1.2.0-alpha.1
    resolve_latest_stable_tag
  ) || rc=$?
  check "exits non-zero when only pre-release tags exist" "$([ "$rc" -ne 0 ] && echo 0 || echo 1)"

  # Stub digest probe: looks up "$1" in a ref->digest map file; missing ref
  # exits 1 (probe error), matching a real registry 404.
  cat > "$tmp/probe.sh" <<'SH'
#!/usr/bin/env bash
awk -F'\t' -v ref="$1" '$1 == ref { print $2; found=1 } END { exit found ? 0 : 1 }' "$DIGESTS_FILE"
SH
  chmod +x "$tmp/probe.sh"
  export DIGEST_PROBE="$tmp/probe.sh"
  export DIGESTS_FILE="$tmp/digests"
  export CLASSIFY_SCRIPT="$SCRIPT_DIR/classify-release-tag.sh"

  digests() { : > "$DIGESTS_FILE"; local ref dig; while [ $# -ge 2 ]; do ref="$1"; dig="$2"; shift 2; printf '%s\t%s\n' "$ref" "$dig" >> "$DIGESTS_FILE"; done; }

  echo "case: :latest correctly matches the stable tag on both registries"
  RELEASE_REGISTRIES="registry.example.com/visiban/visiban ghcr.io/visiban/visiban"
  digests \
    "registry.example.com/visiban/visiban/backend:v1.1.0" "sha256:aaa" \
    "registry.example.com/visiban/visiban/backend:latest" "sha256:aaa" \
    "registry.example.com/visiban/visiban/frontend:v1.1.0" "sha256:bbb" \
    "registry.example.com/visiban/visiban/frontend:latest" "sha256:bbb" \
    "ghcr.io/visiban/visiban/backend:v1.1.0" "sha256:aaa" \
    "ghcr.io/visiban/visiban/backend:latest" "sha256:aaa" \
    "ghcr.io/visiban/visiban/frontend:v1.1.0" "sha256:bbb" \
    "ghcr.io/visiban/visiban/frontend:latest" "sha256:bbb"
  rc=0
  out="$(verify_latest "v1.1.0" 2>&1)" || rc=$?
  check "exits 0 when every :latest matches the stable tag" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"

  echo "case: :latest drifted to a pre-release build (the actual 2026-10 incident shape)"
  digests \
    "registry.example.com/visiban/visiban/backend:v1.1.0" "sha256:aaa" \
    "registry.example.com/visiban/visiban/backend:latest" "sha256:ZZZ-alpha-build" \
    "registry.example.com/visiban/visiban/frontend:v1.1.0" "sha256:bbb" \
    "registry.example.com/visiban/visiban/frontend:latest" "sha256:bbb" \
    "ghcr.io/visiban/visiban/backend:v1.1.0" "sha256:aaa" \
    "ghcr.io/visiban/visiban/backend:latest" "sha256:aaa" \
    "ghcr.io/visiban/visiban/frontend:v1.1.0" "sha256:bbb" \
    "ghcr.io/visiban/visiban/frontend:latest" "sha256:bbb"
  rc=0
  out="$(verify_latest "v1.1.0" 2>&1)" || rc=$?
  check "exits 1 when one registry's :latest has drifted" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports the specific drifted ref as MISMATCH" \
    "$(echo "$out" | grep -q 'MISMATCH registry.example.com/visiban/visiban/backend:latest' && echo 0 || echo 1)"
  check "does not report the healthy GHCR backend ref" \
    "$(echo "$out" | grep -q 'MISMATCH ghcr.io/visiban/visiban/backend:latest' && echo 1 || echo 0)"
  check "suggests the manual imagetools-create fix" \
    "$(echo "$out" | grep -q 'docker buildx imagetools create' && echo 0 || echo 1)"

  echo "case: the stable tag's own digest can't be read (transient registry error)"
  digests  # empty map — every probe misses
  rc=0
  out="$(verify_latest "v1.1.0" 2>&1)" || rc=$?
  check "exits 1 (not a false pass) when the stable ref itself can't be probed" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports PROBE-ERROR, not a silent pass" \
    "$(echo "$out" | grep -q 'PROBE-ERROR' && echo 0 || echo 1)"

  echo "case: no registry configured (explicit empty override)"
  RELEASE_REGISTRIES=""
  rc=0
  out="$(verify_latest "v1.1.0" 2>&1)" || rc=$?
  check "exits 2 (not 1) when RELEASE_REGISTRIES is explicitly empty" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"
  unset RELEASE_REGISTRIES

  echo
  if [ "$fail" -gt 0 ]; then
    echo "check-latest-tag-stability.sh --self-test: $pass passed, $fail FAILED" >&2
    rm -rf "$tmp"
    return 1
  fi
  echo "check-latest-tag-stability.sh --self-test: $pass passed"
  rm -rf "$tmp"
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi

  local stable_tag rc=0
  stable_tag="$(resolve_latest_stable_tag)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -z "$stable_tag" ]; then
    echo "No stable v* release tag found yet — nothing to verify :latest against."
    return 0
  fi

  echo "Verifying :latest tracks the newest stable release: $stable_tag"
  verify_latest "$stable_tag"
}

main "$@"
