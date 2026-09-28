#!/usr/bin/env bash
# scripts/check-release-images.sh — fail when the newest v* release's backend
# or frontend image is no longer pullable from a registry Visiban publishes
# to (#1074).
#
# Ported from TruePPM's scripts/check-release-images.sh (their beta-readiness
# audit item #0, 🔴 URGENT): a GitLab container-registry cleanup policy
# (`keep_n=1`, `name_regex=".*"`, no keep-regex) matched every tag and
# protected none, so its daily sweep deleted the released `v0.3.0-alpha.3`
# api/web images along with the commit-SHA tags it was meant to reap. The
# publish jobs had succeeded; the images vanished weeks later, from a project
# setting that lives outside the repo and that no pipeline asserts.
#
# That is the failure this gate exists for. A release image disappearing is
# not a diff event — there is no commit to review, no job to go red, and the
# tag pipeline that produced it stays green forever. The only way to notice
# is to go and look, on a schedule.
#
# Visiban publishes to TWO registries (see
# docs/administration/container-image-retention.md for the retention setting
# recorded on each), so this checks both by default, unlike TruePPM's
# single-registry original.
#
# Deliberately NOT allow_failure in CI: a self-hoster who cannot pull the
# version we told them to run has no working install, so this is a release
# defect and must read red.
#
# ## Overrides
#
# RELEASE_REGISTRIES    space-separated registry image-path prefixes to probe
#                        (default "$CI_REGISTRY_IMAGE ghcr.io/visiban/visiban";
#                        a prefix that resolves empty, e.g. CI_REGISTRY_IMAGE
#                        unset outside CI, is dropped rather than probed as
#                        "/backend:vX").
# RELEASE_IMAGES         space-separated image names under each registry
#                        (default "backend frontend")
# RELEASE_IMAGE_PROBE    command that receives one image reference and exits 0
#                        when it exists. Defaults to `crane manifest`.
#                        Overridable so the probe decision logic can be unit
#                        tested (see --self-test below) without a daemon or a
#                        registry — the part that was actually wrong in
#                        TruePPM's incident is what the check concludes, and a
#                        gate only ever observed against a healthy registry is
#                        indistinguishable from one that always passes.
# RELEASE_REQUIRED_ARCHES space-separated platform architectures a release
#                        tag's manifest must cover (default "amd64 arm64",
#                        #1197). A ref that resolves to a plain single-
#                        platform manifest (no `.manifests[]` entries at all)
#                        is reported ARCH-MISSING for every required arch —
#                        this is exactly what a manifest-assembly bug that
#                        silently dropped the arm64 leg would look like, and
#                        it must fail this gate the same as an absent image.
# RELEASE_ARCH_PROBE     command that receives one image reference and
#                        prints one architecture per line found in its
#                        manifest list to stdout (empty output for a
#                        single-platform manifest). Defaults to
#                        `crane manifest | jq -r '.manifests[]?.platform.architecture // empty'`.
#                        A non-zero exit is reported PROBE-ERROR, not
#                        ARCH-MISSING, so a transient registry failure never
#                        points the operator at the manifest jobs.
#                        Overridable for --self-test, same reasoning as
#                        RELEASE_IMAGE_PROBE above.
# ACCEPTED_GAPS          space-separated "<registry>/<image>:<tag>" full
#                        references to report as SKIP instead of MISSING.
#                        Empty by default — this gate exists to fail on
#                        absence, so silence is opt-in only, set per-entry by
#                        the CI job with a comment naming the decision issue,
#                        never defaulted here. Each entry must be a
#                        documented, permanent, single-reference exception —
#                        not a way to quiet the gate for an image that is
#                        expected to come back.
#
# Usage:
#   scripts/check-release-images.sh [tag]
#   scripts/check-release-images.sh --self-test
#
# With no argument the tag is resolved from the repository as the highest
# `v*` tag by version sort.
#
# Exit codes:
#   0  every image exists at that tag
#   1  at least one image is missing
#   2  invocation error (no registry configured, or no v* tag to check)

set -euo pipefail

# RELEASE_REGISTRIES is read with `${VAR+set}` below rather than defaulted
# here with `:-`, so an explicit empty override (`RELEASE_REGISTRIES=""`) is
# distinguishable from "not set at all" — the former must produce the
# invocation error, the latter must fall back to default_registries().
RELEASE_IMAGES="${RELEASE_IMAGES:-backend frontend}"
RELEASE_IMAGE_PROBE="${RELEASE_IMAGE_PROBE:-}"
RELEASE_REQUIRED_ARCHES="${RELEASE_REQUIRED_ARCHES:-amd64 arm64}"
RELEASE_ARCH_PROBE="${RELEASE_ARCH_PROBE:-}"
ACCEPTED_GAPS="${ACCEPTED_GAPS:-}"

# Resolve the newest release tag. `--sort=-v:refname` orders by version rather
# than lexically, so v0.10.0 sorts above v0.9.0.
#
# `-c versionsort.suffix=-alpha/-beta/-rc` is NOT optional here. Without it,
# git's version-sort treats ANY non-numeric suffix as sorting AFTER the bare
# tag it modifies — the opposite of both semver and TruePPM's own comment
# claiming the reverse — so `v1.1.0-rc.3` sorts as "newer" than `v1.1.0`
# itself. Verified empirically against this repo's real tags while writing
# this script: `v1.1.0-rc.3` outranked `v1.1.0` under a bare
# `--sort=-v:refname` and only sorted correctly once these three suffixes
# were registered. Every pre-release suffix this repo's release tooling
# produces (scripts/release.sh) must be listed here or a stale RC would be
# reported as the release operators are told to pull.
#
# `--count=1` rather than `git tag --list | head -n 1`: under `set -o pipefail`
# the piped form dies with exit 141 once the tag list outgrows the pipe buffer,
# because `head` closes the read end while `git` is still writing and the
# resulting SIGPIPE becomes the pipeline's status. That failure is silent — it
# aborts before the first echo, so the job reports no reason at all, and it is
# indistinguishable from a registry outage. A gate whose whole purpose is to
# make absence read red must not have a failure mode that reads like absence.
resolve_latest_release_tag() {
  git -c versionsort.suffix=-alpha -c versionsort.suffix=-beta -c versionsort.suffix=-rc \
    for-each-ref --count=1 --sort=-v:refname \
    --format='%(refname:short)' 'refs/tags/v*' 2>/dev/null
}

# The default set of registries: the GitLab registry this pipeline pushes to,
# plus GHCR. Either half is dropped if its variable resolves empty (e.g.
# CI_REGISTRY_IMAGE is unset when run outside CI) rather than probing a
# reference with a blank prefix.
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

# Exact full-reference match against ACCEPTED_GAPS — no globbing, so an
# accepted gap can never widen to cover an image, tag or registry nobody
# reviewed.
is_accepted_gap() {
  local ref="$1" entry
  for entry in $ACCEPTED_GAPS; do
    if [ "$entry" = "$ref" ]; then
      return 0
    fi
  done
  return 1
}

# Default probe: ask the registry for the manifest via `crane` (part of
# go-containerregistry) — no daemon, no `docker manifest inspect`, kaniko-free
# like the rest of this repo's registry tooling. Reads registry auth the same
# way `docker login`/kaniko do: from the docker config JSON at
# $DOCKER_CONFIG/config.json (or ~/.docker/config.json). Requires a prior
# `crane auth login` / docker config in CI.
probe_image() {
  local ref="$1"
  if [ -n "$RELEASE_IMAGE_PROBE" ]; then
    "$RELEASE_IMAGE_PROBE" "$ref" >/dev/null 2>&1
  else
    crane manifest "$ref" >/dev/null 2>&1
  fi
}

# probe_arches <ref> — prints one architecture per line found in the ref's
# manifest list. Empty output means a plain single-platform manifest (no
# `.manifests[]` index at all) — exactly what a manifest-assembly bug that
# silently dropped a platform leg would produce (#1197: the
# manifest-assembly job could go green while quietly shipping amd64-only).
probe_arches() {
  local ref="$1"
  if [ -n "$RELEASE_ARCH_PROBE" ]; then
    "$RELEASE_ARCH_PROBE" "$ref"
  else
    crane manifest "$ref" 2>/dev/null | jq -r '.manifests[]?.platform.architecture // empty'
  fi
}

# verify_images <tag> — does the real work and RETURNS (never exits), so
# --self-test can call it in-process and inspect the result without spawning
# a subshell per case.
verify_images() {
  local tag="$1"
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

  if [ -z "$tag" ]; then
    tag="$(resolve_latest_release_tag)"
  fi
  if [ -z "$tag" ]; then
    echo "ERROR: no v* release tag found — cannot verify release images." >&2
    echo "       In CI this usually means the clone has no tags; fetch them first." >&2
    return 2
  fi

  echo "Verifying release images for tag: $tag"

  local missing="" registry image ref
  for registry in $registries; do
    for image in $RELEASE_IMAGES; do
      ref="${registry}/${image}:${tag}"
      if is_accepted_gap "$ref"; then
        echo "  SKIP    $ref (accepted gap, see ACCEPTED_GAPS)"
      elif probe_image "$ref"; then
        local arches want missing_arch="" arch_rc=0
        arches="$(probe_arches "$ref" 2>/dev/null)" || arch_rc=$?
        if [ "$arch_rc" -ne 0 ]; then
          echo "  PROBE-ERROR $ref (could not read its manifest's platform list)"
          missing="${missing} ${ref}(probe-error)"
          continue
        fi
        for want in $RELEASE_REQUIRED_ARCHES; do
          if ! printf '%s\n' "$arches" | grep -qx "$want"; then
            missing_arch="${missing_arch} ${want}"
          fi
        done
        if [ -n "$missing_arch" ]; then
          echo "  ARCH-MISSING $ref (missing:${missing_arch})"
          missing="${missing} ${ref}(missing-arch:${missing_arch# })"
        else
          echo "  OK      $ref (${RELEASE_REQUIRED_ARCHES})"
        fi
      else
        echo "  MISSING $ref"
        missing="${missing} ${ref}"
      fi
    done
  done

  if [ -n "$missing" ]; then
    echo
    echo "ERROR: released image(s) missing or arch-incomplete on a container registry:" >&2
    local ref_out
    for ref_out in $missing; do
      echo "  - $ref_out" >&2
    done
    echo >&2
    echo "A published release tag must stay pullable AND cover every required" >&2
    echo "architecture (${RELEASE_REQUIRED_ARCHES}). For a MISSING image, check" >&2
    echo "each registry's cleanup/retention policy — see" >&2
    echo "docs/administration/container-image-retention.md — its keep-regex" >&2
    echo "must protect release tags (^v.*\$|^latest\$), or a scheduled sweep" >&2
    echo "will delete them again. For an ARCH-MISSING image, the manifest-" >&2
    echo "assembly job (backend-manifest / frontend-manifest) silently" >&2
    echo "dropped a platform leg — re-run it, or the whole tag pipeline's" >&2
    echo "publish chain, to restore. backend-docker-push/frontend-docker-push" >&2
    echo "alone only push amd64-suffixed intermediate tags on a release tag;" >&2
    echo "the real names come back only once backend-manifest/frontend-manifest" >&2
    echo "(and the arm64 legs they need) also complete. See #1084. A" >&2
    echo "PROBE-ERROR means the image exists but its manifest could not be" >&2
    echo "read — re-run this job before touching any publish job." >&2
    return 1
  fi

  echo
  echo "OK: all release images present for $tag"
  return 0
}

# --self-test: proves the decision logic above actually fires when an image
# is gone, using a stub RELEASE_IMAGE_PROBE — no daemon, no network, no
# registry credentials. Weighted toward the missing-image path per the
# TruePPM incident: a check only ever observed passing against a healthy
# registry would reproduce exactly the failure it exists to catch.
self_test() {
  local tmp fail=0 pass=0
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  check() { # check "<description>" <0-if-ok>
    if [ "$2" -eq 0 ]; then
      pass=$((pass + 1))
    else
      echo "  SELF-TEST FAIL: $1" >&2
      fail=$((fail + 1))
    fi
  }

  # Stub probe: exits 0 for any reference listed in $tmp/present, else 1.
  cat > "$tmp/probe.sh" <<'SH'
#!/usr/bin/env bash
grep -Fxq "$1" "$PRESENT_FILE"
SH
  chmod +x "$tmp/probe.sh"
  export RELEASE_IMAGE_PROBE="$tmp/probe.sh"
  export PRESENT_FILE="$tmp/present"

  present() { : > "$PRESENT_FILE"; local ref; for ref in "$@"; do echo "$ref" >> "$PRESENT_FILE"; done; }

  # Stub arch probe: prints whatever architectures $tmp/arches lists,
  # regardless of which ref is asked about (the presence-only cases below
  # don't care about arch — default to full coverage so they're unaffected;
  # the dedicated arch-missing cases further down flip this).
  cat > "$tmp/arch_probe.sh" <<'SH'
#!/usr/bin/env bash
[ -e "$ARCH_PROBE_FAIL" ] && exit 1
cat "$ARCHES_FILE" 2>/dev/null || true
SH
  chmod +x "$tmp/arch_probe.sh"
  export RELEASE_ARCH_PROBE="$tmp/arch_probe.sh"
  export ARCHES_FILE="$tmp/arches"
  export ARCH_PROBE_FAIL="$tmp/arch_probe_fail"

  arches() { : > "$ARCHES_FILE"; local a; for a in "$@"; do echo "$a" >> "$ARCHES_FILE"; done; }
  arches amd64 arm64

  echo "=== check-release-images.sh --self-test ==="

  echo "case: both registries missing the release image"
  RELEASE_REGISTRIES="registry.example.com/visiban/visiban ghcr.io/visiban/visiban"
  present  # nothing survives
  local out rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "exits 1 when every image is gone" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "names the missing GitLab-registry backend ref" \
    "$(echo "$out" | grep -q 'registry.example.com/visiban/visiban/backend:v1.2.0' && echo 0 || echo 1)"
  check "names the missing GHCR frontend ref" \
    "$(echo "$out" | grep -q 'ghcr.io/visiban/visiban/frontend:v1.2.0' && echo 0 || echo 1)"
  check "points at the retention doc as the next step" \
    "$(echo "$out" | grep -qi 'container-image-retention.md' && echo 0 || echo 1)"

  echo "case: one registry healthy, the other reaped"
  present "registry.example.com/visiban/visiban/backend:v1.2.0" \
          "registry.example.com/visiban/visiban/frontend:v1.2.0"
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "still exits 1 — a healthy registry does not mask the other" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "does not report the surviving GitLab backend as missing" \
    "$(echo "$out" | grep -q 'MISSING registry.example.com/visiban/visiban/backend:v1.2.0' && echo 1 || echo 0)"
  check "reports the missing GHCR backend" \
    "$(echo "$out" | grep -q 'MISSING ghcr.io/visiban/visiban/backend:v1.2.0' && echo 0 || echo 1)"

  echo "case: both registries healthy"
  present "registry.example.com/visiban/visiban/backend:v1.2.0" \
          "registry.example.com/visiban/visiban/frontend:v1.2.0" \
          "ghcr.io/visiban/visiban/backend:v1.2.0" \
          "ghcr.io/visiban/visiban/frontend:v1.2.0"
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "exits 0 when every image exists on every registry" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"

  echo "case: image exists but the arm64 leg was silently dropped (#1197)"
  # present() already covers every ref from the prior case; only arches()
  # changes — this is exactly what a manifest-assembly bug that dropped the
  # arm64 leg would produce: the tag still resolves, just to amd64 only.
  arches amd64
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "exits 1 (not 0) when a present image is missing a required arch" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports ARCH-MISSING, not a plain OK" \
    "$(echo "$out" | grep -q 'ARCH-MISSING' && echo 0 || echo 1)"
  check "names arm64 as the missing arch" \
    "$(echo "$out" | grep -q 'ARCH-MISSING .*missing: *arm64' && echo 0 || echo 1)"
  check "points at the manifest-assembly job as the next step" \
    "$(echo "$out" | grep -qi 'backend-manifest' && echo 0 || echo 1)"
  arches amd64 arm64  # restore full coverage for the remaining cases

  echo "case: image exists but its manifest can't be read (transient registry error)"
  : > "$ARCH_PROBE_FAIL"
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "exits 1 when the arch probe itself fails" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports PROBE-ERROR, not ARCH-MISSING" \
    "$(echo "$out" | grep -q '  PROBE-ERROR ' && ! echo "$out" | grep -q '  ARCH-MISSING ' && echo 0 || echo 1)"
  rm -f "$ARCH_PROBE_FAIL"

  echo "case: no registry configured (explicit empty override)"
  RELEASE_REGISTRIES=""
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "exits 2 (not 1) when RELEASE_REGISTRIES is explicitly empty" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"
  unset RELEASE_REGISTRIES

  echo "case: no v* tag resolvable"
  # The subshell call is chained with `||` rather than followed by a bare
  # `rc=$?` on the next line: under `set -e`, a standalone `( ... )` command
  # that exits non-zero trips the OUTER script's errexit immediately (the
  # subshell's exit status is just this simple command's status), before
  # `rc=$?` is ever reached. Chaining `|| rc=$?` puts the subshell inside an
  # OR-list, which `set -e` exempts, same as guarding any other command.
  rc=0
  ( cd "$tmp"
    git init -q .
    export RELEASE_REGISTRIES="registry.example.com/visiban/visiban"
    inner_rc=0
    out="$(verify_images "" 2>&1)" || inner_rc=$?
    exit "$inner_rc"
  ) || rc=$?
  check "exits 2 (not 1) when no v* tag exists to check" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

  echo "case: ACCEPTED_GAPS skips only the named reference"
  RELEASE_REGISTRIES="registry.example.com/visiban/visiban"
  ACCEPTED_GAPS="registry.example.com/visiban/visiban/backend:v1.2.0"
  present  # nothing survives — backend accepted, frontend must still fail
  rc=0
  out="$(verify_images "v1.2.0" 2>&1)" || rc=$?
  check "still exits 1 — accepting one gap does not mask the other" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports the accepted image as SKIP, not MISSING" \
    "$(echo "$out" | grep -q 'SKIP    registry.example.com/visiban/visiban/backend:v1.2.0' && echo 0 || echo 1)"
  check "still lists the non-accepted missing image" \
    "$(echo "$out" | grep -q 'MISSING registry.example.com/visiban/visiban/frontend:v1.2.0' && echo 0 || echo 1)"
  unset ACCEPTED_GAPS

  echo
  if [ "$fail" -gt 0 ]; then
    echo "check-release-images.sh --self-test: $pass passed, $fail FAILED" >&2
    return 1
  fi
  echo "check-release-images.sh --self-test: $pass passed"
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi
  verify_images "${1:-}"
  exit $?
}

main "$@"
