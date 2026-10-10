#!/usr/bin/env bash
# scripts/check-release-attestations.sh — fail when a recent release's images
# no longer carry their cosign signatures and CycloneDX SBOM attestations
# (#1542, follow-up from #1153).
#
# `check-release-images.sh` (#1074) proves the image exists. It does not look
# at the `sha256-<digest>.sig` / `.att` tags cosign stores in the SAME
# repository, so a registry cleanup sweep (the GitLab registry's current
# policy can delete them ~90 days after a release, #1541) or a manual delete
# removes every signature and SBOM while that job and the release pipeline
# stay green. Nothing else notices. This is the same failure shape as #1074
# one layer up, and the same answer: look, on a schedule.
#
# For each of the newest ATTEST_CHECK_COUNT `v*` tags, on BOTH registries, for
# BOTH images:
#   1. Read the manifest list and resolve each required platform digest
#      (linux/amd64, linux/arm64). No index, or a platform missing from it, is
#      a failure.
#   2. `cosign verify` the index digest and each platform digest.
#   3. `cosign verify-attestation --type cyclonedx` each platform digest, and
#      require at least one attestation back whose in-toto subject is that
#      digest. "Verified, returned nothing" is a failure, never a pass.
# Identity is the documented tag-only regexp
# (docs/administration/image-verification.md). A tag listed in
# ATTEST_BACKFILLED_TAGS (releases signed later by the manual
# `image-attest-backfill` job on main) uses the documented main-or-tag regexp
# instead. The wider regexp is never a silent fallback for any other tag: that
# would let a backfill signature quietly stand in for a missing release one.
#
# Every failure is collected and printed naming registry/image/tag/digest, then
# the script exits non-zero. There is no `|| true` anywhere: this gate's whole
# job is to make absence read red, and some GitLab components exit 0 on
# findings (see the repo's CI notes), so the exit status is computed here.
#
# ## Overrides
#
# ATTEST_CHECK_COUNT      how many of the newest `v*` tags to check (default 3).
# RELEASE_REGISTRIES      space-separated registry image-path prefixes (default
#                         "$CI_REGISTRY_IMAGE ghcr.io/visiban/visiban"; an
#                         explicit empty value is exit 2).
# RELEASE_IMAGES          image names under each registry (default
#                         "backend frontend").
# ATTEST_ARCHES           required platform architectures (default
#                         "amd64 arm64").
# ATTEST_BACKFILLED_TAGS  space-separated tags documented as backfilled from
#                         main. Empty by default; a maintainer adds a tag here
#                         (in .gitlab-ci.yml, naming the issue) after running
#                         `image-attest-backfill` for it.
# ATTEST_ACCEPTED_GAPS    space-separated exact "<registry>/<image>:<tag>"
#                         references reported SKIP instead of FAIL. Empty by
#                         default; for documented, permanent exceptions only
#                         (for example a pre-#1153 release that was never
#                         signed and will not be backfilled).
# ATTEST_TAGS             space-separated tags to check instead of resolving
#                         them from git (used by --self-test and by a
#                         maintainer running one release on demand).
# CRANE, COSIGN           the crane / cosign commands (default `crane`,
#                         `cosign`); overridable so --self-test can drive the
#                         decision logic with stubs and no registry.
#
# Usage:
#   scripts/check-release-attestations.sh
#   scripts/check-release-attestations.sh --self-test
#
# Exit codes: 0 = every checked digest verified; 1 = at least one missing or
# failing signature/attestation; 2 = invocation error (no registry, no tag).
#
# Tools: bash, git, jq, crane, cosign. Portable to bash 3.2 (no associative
# arrays).

set -euo pipefail

ISSUER="https://gitlab.com"
# Keep these two byte-identical to docs/administration/image-verification.md;
# --self-test fails if the doc drifts from them.
IDENTITY_TAG='^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*$'
IDENTITY_BACKFILL='^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/(tags/v[0-9][^/]*|heads/main)$'

ATTEST_CHECK_COUNT="${ATTEST_CHECK_COUNT:-3}"
RELEASE_IMAGES="${RELEASE_IMAGES:-backend frontend}"
ATTEST_ARCHES="${ATTEST_ARCHES:-amd64 arm64}"
ATTEST_BACKFILLED_TAGS="${ATTEST_BACKFILLED_TAGS:-}"
ATTEST_ACCEPTED_GAPS="${ATTEST_ACCEPTED_GAPS:-}"
ATTEST_TAGS="${ATTEST_TAGS:-}"
CRANE="${CRANE:-crane}"
COSIGN="${COSIGN:-cosign}"

FAILURES=0
CHECKED_ATTESTATIONS=0

fail() { echo "  FAIL    $*" >&2; FAILURES=$((FAILURES + 1)); }

# Same version-sort rules as check-release-images.sh: without the suffix
# config git sorts v1.1.0-rc.3 AFTER v1.1.0. --count (not `| head`) avoids a
# SIGPIPE under pipefail.
resolve_release_tags() {
  git -c versionsort.suffix=-alpha -c versionsort.suffix=-beta -c versionsort.suffix=-rc \
    for-each-ref --count="$ATTEST_CHECK_COUNT" --sort=-v:refname \
    --format='%(refname:short)' 'refs/tags/v*' 2>/dev/null
}

default_registries() {
  if [ -n "${CI_REGISTRY_IMAGE:-}" ]; then
    printf '%s ghcr.io/visiban/visiban' "$CI_REGISTRY_IMAGE"
  else
    printf 'ghcr.io/visiban/visiban'
  fi
}

in_list() { # in_list <needle> <space-separated haystack> — exact match only
  local n="$1" e
  for e in $2; do [ "$e" = "$n" ] && return 0; done
  return 1
}

# platform_digest <manifest-json> <arch> → digest, or empty unless exactly one.
platform_digest() {
  printf '%s' "$1" | jq -r --arg a "$2" \
    '[.manifests[]? | select(.platform.os=="linux" and .platform.architecture==$a) | .digest]
     | if length==1 then .[0] else "" end'
}

verify_sig() { # verify_sig <ref> <identity-regexp>
  "$COSIGN" verify "$1" \
    --certificate-identity-regexp "$2" \
    --certificate-oidc-issuer "$ISSUER" >/dev/null 2>&1
}

# verify_att <repo-ref-with-digest> <digest> <identity-regexp>
# Succeeds only if cosign verified AND returned at least one attestation whose
# in-toto subject is <digest>.
verify_att() {
  local ref="$1" digest="$2" idre="$3" out n
  out="$("$COSIGN" verify-attestation --type cyclonedx \
    --certificate-identity-regexp "$idre" \
    --certificate-oidc-issuer "$ISSUER" "$ref" 2>/dev/null)" || return 1
  n="$(printf '%s\n' "$out" | jq -r --arg d "${digest#sha256:}" \
    'select(.payload != null) | .payload | @base64d | fromjson
     | select([.subject[]?.digest.sha256] | index($d)) | 1' 2>/dev/null | wc -l | tr -d ' ')"
  [ "${n:-0}" -gt 0 ] || return 2
  CHECKED_ATTESTATIONS=$((CHECKED_ATTESTATIONS + n))
  return 0
}

check_image() { # check_image <registry> <image> <tag> <identity-regexp>
  local reg="$1" img="$2" tag="$3" idre="$4"
  local repo="${reg}/${img}" ref manifest arch digest rc
  ref="${repo}:${tag}"

  if in_list "$ref" "$ATTEST_ACCEPTED_GAPS"; then
    echo "  SKIP    ${ref} (ATTEST_ACCEPTED_GAPS)"
    return 0
  fi

  if ! manifest="$("$CRANE" manifest "$ref" 2>/dev/null)" || [ -z "$manifest" ]; then
    fail "${ref}: manifest not readable (image missing, or registry error) — run check-release-images first"
    return 0
  fi

  # The index itself: signed with `cosign sign --recursive`.
  digest="$("$CRANE" digest "$ref" 2>/dev/null)" || digest=""
  if [ -z "$digest" ]; then
    fail "${ref}: cannot resolve the index digest"
  elif verify_sig "${repo}@${digest}" "$idre"; then
    echo "  ok      ${repo}@${digest} (index) signature"
  else
    fail "${repo}@${digest} (index of ${tag}): no verifying signature for identity ${idre}"
  fi

  for arch in $ATTEST_ARCHES; do
    digest="$(platform_digest "$manifest" "$arch")"
    case "$digest" in
      sha256:*) ;;
      *) fail "${ref}: index has no single linux/${arch} manifest"; continue ;;
    esac
    if verify_sig "${repo}@${digest}" "$idre"; then
      echo "  ok      ${repo}@${digest} (${arch}) signature"
    else
      fail "${repo}@${digest} (${arch} of ${tag}): no verifying signature for identity ${idre}"
    fi
    rc=0
    verify_att "${repo}@${digest}" "$digest" "$idre" || rc=$?
    case "$rc" in
      0) echo "  ok      ${repo}@${digest} (${arch}) SBOM attestation" ;;
      2) fail "${repo}@${digest} (${arch} of ${tag}): cosign verified but returned ZERO cyclonedx attestations for this digest" ;;
      *) fail "${repo}@${digest} (${arch} of ${tag}): no verifying cyclonedx attestation for identity ${idre}" ;;
    esac
  done
}

# run_checks → prints a report, returns 0/1/2. Never exits (self-test calls it).
run_checks() {
  local registries tags tag reg img idre
  FAILURES=0
  CHECKED_ATTESTATIONS=0

  if [ "${RELEASE_REGISTRIES+set}" = "set" ]; then
    registries="$RELEASE_REGISTRIES"
  else
    registries="$(default_registries)"
  fi
  if [ -z "$registries" ]; then
    echo "ERROR: no registry configured — set RELEASE_REGISTRIES, or CI_REGISTRY_IMAGE." >&2
    return 2
  fi

  if [ -n "$ATTEST_TAGS" ]; then tags="$ATTEST_TAGS"; else tags="$(resolve_release_tags)"; fi
  if [ -z "$tags" ]; then
    echo "ERROR: no v* release tag found to check — a gate that checks nothing must not pass." >&2
    return 2
  fi

  for tag in $tags; do
    if in_list "$tag" "$ATTEST_BACKFILLED_TAGS"; then
      idre="$IDENTITY_BACKFILL"
      echo "== ${tag} (documented backfill: main-or-tag identity)"
    else
      idre="$IDENTITY_TAG"
      echo "== ${tag}"
    fi
    for reg in $registries; do
      for img in $RELEASE_IMAGES; do
        check_image "$reg" "$img" "$tag" "$idre"
      done
    done
  done

  if [ "$FAILURES" -eq 0 ] && [ "$CHECKED_ATTESTATIONS" -eq 0 ]; then
    echo "ERROR: zero attestations were verified across ${tags} — every image skipped or nothing was checked." >&2
    return 1
  fi
  if [ "$FAILURES" -gt 0 ]; then
    echo >&2
    echo "check-release-attestations: ${FAILURES} failure(s). A missing .sig/.att tag usually means a registry" >&2
    echo "cleanup sweep or manual delete (#1541); see docs/development/ci-gates.md for the runbook." >&2
    return 1
  fi
  echo "check-release-attestations: ${CHECKED_ATTESTATIONS} attestation(s) verified"
  return 0
}

# ─── self-test ───────────────────────────────────────────────────────────────
self_test() {
  local tmp pass=0 fail_n=0 rc out here doc
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  check() { # check <desc> <0|1>
    if [ "$2" -eq 0 ]; then echo "  PASS  $1"; pass=$((pass + 1)); else echo "  FAIL  $1"; fail_n=$((fail_n + 1)); fi
  }

  # Stub registry: manifests/digests from fixtures, behavior from marker files.
  local AMD="sha256:aaaa" ARM="sha256:bbbb" IDX="sha256:cccc"
  # shellcheck disable=SC2016  # the generated stub must keep a literal $1
  write_crane() {
    {
      echo '#!/usr/bin/env bash'
      echo "[ -e '$tmp/no-image' ] && exit 1"
      echo 'case "$1" in'
      if [ -e "$tmp/no-arm" ]; then
        echo "  manifest) echo '{\"manifests\":[{\"digest\":\"$AMD\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}}]}' ;;"
      else
        echo "  manifest) echo '{\"manifests\":[{\"digest\":\"$AMD\",\"platform\":{\"os\":\"linux\",\"architecture\":\"amd64\"}},{\"digest\":\"$ARM\",\"platform\":{\"os\":\"linux\",\"architecture\":\"arm64\"}}]}' ;;"
      fi
      if [ -e "$tmp/no-digest" ]; then echo "  digest) exit 1 ;;"; else echo "  digest) echo '$IDX' ;;"; fi
      echo 'esac'
    } > "$tmp/crane"
    chmod +x "$tmp/crane"
  }
  # Stub cosign: `verify` fails if no-sig exists; `verify-attestation` fails
  # on no-att, prints nothing on empty-att, wrong subject on bad-subject,
  # and logs the identity regexp it was given to identity.log.
  cat > "$tmp/cosign" <<STUB
#!/usr/bin/env bash
sub="\$1"; shift
idre=""; ref=""; issuer=""; typ=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    --certificate-identity-regexp) idre="\$2"; shift 2 ;;
    --certificate-oidc-issuer) issuer="\$2"; shift 2 ;;
    --type) typ="\$2"; shift 2 ;;
    *) ref="\$1"; shift ;;
  esac
done
echo "\$idre" >> "$tmp/identity.log"
# The documented issuer, and the SBOM predicate type, are part of the contract.
[ "\$issuer" = "https://gitlab.com" ] || { echo "stub: wrong issuer '\$issuer'" >&2; exit 1; }
case "\$sub" in
  verify) [ -e "$tmp/no-sig" ] && exit 1
          if [ -e "$tmp/no-platform-sig" ]; then case "\$ref" in *@$AMD|*@$ARM) exit 1 ;; esac; fi
          exit 0 ;;
  verify-attestation)
    [ "\$typ" = "cyclonedx" ] || { echo "stub: wrong --type '\$typ'" >&2; exit 1; }
    [ -e "$tmp/no-att" ] && exit 1
    [ -e "$tmp/empty-att" ] && exit 0
    d="\${ref#*@sha256:}"
    [ -e "$tmp/bad-subject" ] && d="ffff"
    payload="\$(printf '{"subject":[{"digest":{"sha256":"%s"}}]}' "\$d" | base64 | tr -d '\n')"
    printf '{"payload":"%s"}\n' "\$payload" ;;
esac
STUB
  chmod +x "$tmp/cosign"

  reset() { rm -f "$tmp"/no-digest "$tmp"/no-platform-sig "$tmp"/no-image "$tmp"/no-arm "$tmp"/no-sig "$tmp"/no-att "$tmp"/empty-att "$tmp"/bad-subject "$tmp"/identity.log; write_crane; }
  run() { rc=0; out="$(run_checks 2>&1)" || rc=$?; }

  CRANE="$tmp/crane"; COSIGN="$tmp/cosign"
  RELEASE_REGISTRIES="reg.example.com/v/v ghcr.example/v/v"
  RELEASE_IMAGES="backend frontend"
  ATTEST_TAGS="v1.2.0"
  ATTEST_BACKFILLED_TAGS=""
  ATTEST_ACCEPTED_GAPS=""

  echo "case: everything signed and attested"
  reset; run
  check "exits 0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
  check "counts 8 attestations (2 registries x 2 images x 2 arches)" \
    "$(echo "$out" | grep -q '8 attestation(s) verified' && echo 0 || echo 1)"
  check "uses the tag-only identity" \
    "$(grep -qF "$IDENTITY_TAG" "$tmp/identity.log" && ! grep -qF "$IDENTITY_BACKFILL" "$tmp/identity.log" && echo 0 || echo 1)"

  echo "case: zero attestations returned by cosign"
  reset; : > "$tmp/empty-att"; run
  check "exits 1 (never a silent pass)" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "names ZERO attestations and the digest" \
    "$(echo "$out" | grep -q "reg.example.com/v/v/backend@$AMD (amd64 of v1.2.0).*ZERO" && echo 0 || echo 1)"

  echo "case: attestation for the wrong subject"
  reset; : > "$tmp/bad-subject"; run
  check "exits 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"

  echo "case: attestation tag deleted"
  reset; : > "$tmp/no-att"; run
  check "exits 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "names the registry, image and digest" \
    "$(echo "$out" | grep -q "ghcr.example/v/v/frontend@$ARM (arm64 of v1.2.0)" && echo 0 || echo 1)"

  echo "case: signature tag deleted"
  reset; : > "$tmp/no-sig"; run
  check "exits 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "reports the index signature too" \
    "$(echo "$out" | grep -q "(index of v1.2.0): no verifying signature" && echo 0 || echo 1)"

  echo "case: release image missing"
  reset; : > "$tmp/no-image"; run
  check "exits 1" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  check "names the missing reference" \
    "$(echo "$out" | grep -q 'reg.example.com/v/v/backend:v1.2.0: manifest not readable' && echo 0 || echo 1)"

  echo "case: platform missing from the index"
  reset; : > "$tmp/no-arm"; write_crane; run
  check "exits 1 and names linux/arm64" \
    "$([ "$rc" -eq 1 ] && echo "$out" | grep -q 'no single linux/arm64 manifest' && echo 0 || echo 1)"

  echo "case: backfilled tag uses the main-or-tag identity, others do not"
  reset; ATTEST_BACKFILLED_TAGS="v1.2.0"; run
  check "exits 0" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
  check "used the backfill identity, not the tag-only one" \
    "$(grep -qF "$IDENTITY_BACKFILL" "$tmp/identity.log" && ! grep -qF "$IDENTITY_TAG" "$tmp/identity.log" && echo 0 || echo 1)"
  ATTEST_BACKFILLED_TAGS="v9.9.9"; reset; run
  check "an unrelated backfilled tag does not widen v1.2.0" \
    "$(grep -qF "$IDENTITY_TAG" "$tmp/identity.log" && ! grep -qF "$IDENTITY_BACKFILL" "$tmp/identity.log" && echo 0 || echo 1)"
  ATTEST_BACKFILLED_TAGS=""

  echo "case: everything accepted as a gap leaves nothing verified"
  reset
  ATTEST_ACCEPTED_GAPS="reg.example.com/v/v/backend:v1.2.0 reg.example.com/v/v/frontend:v1.2.0 ghcr.example/v/v/backend:v1.2.0 ghcr.example/v/v/frontend:v1.2.0"
  run
  check "exits 1 (zero attestations verified)" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  ATTEST_ACCEPTED_GAPS=""

  echo "case: nothing to check"
  reset; ATTEST_TAGS=""
  rc=0
  ( cd "$tmp" && git init -q . && run_checks >/dev/null 2>&1 ) || rc=$?
  check "exits 2 when no v* tag resolves" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"
  ATTEST_TAGS="v1.2.0"
  RELEASE_REGISTRIES=""; run
  check "exits 2 when no registry is configured" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

  RELEASE_REGISTRIES="reg.example.com/v/v ghcr.example/v/v"  # restore after the empty-registry case
  echo "case: only a platform-digest signature is missing"
  reset; : > "$tmp/no-platform-sig"; run
  check "exits 1 even though the index signature verifies" \
    "$([ "$rc" -eq 1 ] && echo "$out" | grep -q "(amd64 of v1.2.0): no verifying signature" && ! echo "$out" | grep -q '(index of' && echo 0 || echo 1)"

  echo "case: index digest cannot be resolved"
  reset; : > "$tmp/no-digest"; write_crane; run
  check "exits 1 and says so" \
    "$([ "$rc" -eq 1 ] && echo "$out" | grep -q 'cannot resolve the index digest' && echo 0 || echo 1)"

  echo "case: ATTEST_CHECK_COUNT bounds the releases checked"
  reset
  mkdir "$tmp/repo"
  ( cd "$tmp/repo" && git init -q . \
    && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m c \
    && git tag v1.0.0 && git tag v1.1.0 && git tag v1.2.0 )
  rc=0
  out="$( cd "$tmp/repo" && ATTEST_TAGS="" && ATTEST_CHECK_COUNT=2 && run_checks 2>&1 )" || rc=$?
  check "exactly 2 releases are checked, the newest 2" \
    "$([ "$(echo "$out" | grep -c '^== ')" -eq 2 ] && echo "$out" | grep -q '^== v1.2.0' && echo "$out" | grep -q '^== v1.1.0' && ! echo "$out" | grep -q '^== v1.0.0' && echo 0 || echo 1)"

  echo "case: the real entry point's exit status (subprocess, stubs on PATH)"
  mkdir "$tmp/bin"; ln -s "$tmp/crane" "$tmp/bin/crane"; ln -s "$tmp/cosign" "$tmp/bin/cosign"
  entry() { # entry <env assignments...> — runs the script itself, not run_checks
    rc=0
    out="$(cd "$tmp/repo" && env -u CRANE -u COSIGN PATH="$tmp/bin:$PATH" "$@" bash "$here/check-release-attestations.sh" 2>&1)" || rc=$?
  }
  reset; entry RELEASE_REGISTRIES="reg.example.com/v/v" ATTEST_TAGS="v1.2.0"
  check "exits 0 when everything verifies" "$([ "$rc" -eq 0 ] && echo 0 || echo 1)"
  : > "$tmp/no-att"; entry RELEASE_REGISTRIES="reg.example.com/v/v" ATTEST_TAGS="v1.2.0"
  check "exits 1 on a verify failure" "$([ "$rc" -eq 1 ] && echo 0 || echo 1)"
  reset; entry RELEASE_REGISTRIES="" ATTEST_TAGS="v1.2.0"
  check "exits 2 with no registry" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"
  mkdir "$tmp/empty" && ( cd "$tmp/empty" && git init -q . )
  rc=0
  out="$(cd "$tmp/empty" && env -u ATTEST_TAGS -u CRANE -u COSIGN PATH="$tmp/bin:$PATH" RELEASE_REGISTRIES="reg.example.com/v/v" bash "$here/check-release-attestations.sh" 2>&1)" || rc=$?
  check "exits 2 with no tag" "$([ "$rc" -eq 2 ] && echo 0 || echo 1)"

  echo "case: regexps match the documented ones"
  doc="$here/../docs/administration/image-verification.md"
  check "tag-only identity is in image-verification.md" "$(grep -qF "IDENTITY='$IDENTITY_TAG'" "$doc" && echo 0 || echo 1)"
  check "backfill identity is in image-verification.md" "$(grep -qF "IDENTITY='$IDENTITY_BACKFILL'" "$doc" && echo 0 || echo 1)"

  echo
  if [ "$fail_n" -gt 0 ]; then
    echo "check-release-attestations.sh --self-test: $pass passed, $fail_n FAILED" >&2
    return 1
  fi
  echo "check-release-attestations.sh --self-test: $pass passed"
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    exit $?
  fi
  local rc=0
  run_checks || rc=$?
  exit "$rc"
}

main "$@"
