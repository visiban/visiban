#!/usr/bin/env bash
# scripts/attest-image-sbom.sh — sign a released multi-arch image and attest a
# CycloneDX SBOM to EACH of its per-platform digests, on one or more
# registries (#1153).
#
# Why: `helm-publish` cosign-signs the Helm chart, but until #1153 the
# backend/frontend images that chart pulls carried no signature and no SBOM —
# the artifact with almost none of the attack surface was verifiable and the
# two with nearly all of it were not.
#
# For each registry repo `<registry>/<image>` and the release tag:
#   1. Resolve the manifest list `<repo>:<tag>` and its linux/amd64 and
#      linux/arm64 digests (crane). Missing index, missing platform, or an
#      image config whose `architecture` disagrees with the index entry all
#      fail. Attesting only the index or only amd64 is the half-covered
#      release #1084's multi-arch restore makes possible — an index has no
#      filesystem, so an SBOM attached to it verifies while describing
#      nothing.
#   2. `cosign sign --recursive` the index digest (signs the index AND each
#      platform manifest), then `cosign verify` the index and both platform
#      digests.
#   3. Per platform digest: syft a CycloneDX SBOM, named with
#      --source-name <repo> --source-version <tag>-<arch> so
#      metadata.component is the image, not a temp path; assert it names its
#      own repo/version, is non-empty, and that every arch-qualified package
#      purl (`?arch=`) is for THIS architecture.
#   4. `cosign attest --type cyclonedx` it to the platform DIGEST (never a
#      tag — a tag can move, a digest cannot).
#   5. `cosign verify-attestation` with this job's exact certificate identity,
#      decode every returned attestation and re-assert step 3 on what the
#      registry actually serves, plus that the in-toto subject is that digest.
#      "verify-attestation returned nothing" is a hard failure: an attestation
#      step that silently no-ops is the failure mode this is designed against.
#
# Both registries, not one: cosign stores signatures/attestations as
# `sha256-<digest>.sig`/`.att` tags in the SAME repository as the image, so an
# attestation pushed to ghcr.io is invisible to someone verifying
# registry.gitlab.com/visiban/visiban, and vice versa.
#
# Idempotent: a digest that already carries a verifying signature/attestation
# from this project's release or main-branch identity (and, for the SBOM,
# passes the step-3 assertions for this tag) is skipped, so a retried job does
# not stack duplicates. `--force` attests anyway.
#
# Keyless: the certificate identity IS the GitLab job that runs this. It
# refuses to sign or attest unless GITLAB_CI=true and CI_JOB_ID and
# SIGSTORE_ID_TOKEN are set — never run it from a workstation. `--dry-run`
# (step 1 only, read-only) and `--self-test` are safe anywhere.
#
# Usage:
#   scripts/attest-image-sbom.sh --image backend|frontend --tag vX.Y.Z[-pre]
#       [--registry <repo-prefix>]... [--force] [--dry-run]
#   scripts/attest-image-sbom.sh --self-test
#
#   --registry   repo prefix the image lives under; repeatable. Default:
#                "${CI_REGISTRY_IMAGE}" and ghcr.io/visiban/visiban.
#
# Env (attest mode): registry auth in ~/.docker/config.json (read by crane,
# syft and cosign alike), SIGSTORE_ID_TOKEN (id_tokens aud: sigstore),
# CI_SERVER_URL, CI_PROJECT_PATH, CI_COMMIT_TAG / CI_COMMIT_REF_NAME.
# Optional VERIFY_IDENTITY overrides the exact identity step 5 checks.
#
# Tools: bash, jq, crane, base64 (+ syft, cosign outside --dry-run). Portable
# to macOS bash 3.2 and BusyBox (no associative arrays, no GNU-only flags).
set -eu

die() { echo "ERROR: $*" >&2; exit 1; }

# ─── pure helpers (exercised directly by --self-test) ────────────────────────

# arch_aliases <arch> → the purl `arch=` values that mean this architecture.
# deb uses amd64/arm64; apk and rpm use x86_64/aarch64.
arch_aliases() {
  case "$1" in
    amd64) echo "amd64 x86_64" ;;
    arm64) echo "arm64 aarch64" ;;
    *) die "unsupported architecture '$1'" ;;
  esac
}

# index_platform_digest <index-json-file> <arch> → digest of linux/<arch>.
index_platform_digest() {
  local idx="$1" arch="$2" mt d
  mt="$(jq -r '.mediaType // empty' "$idx")"
  case "$mt" in
    application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json) ;;
    *) die "not a multi-arch index (mediaType='${mt}') — attesting a single-arch manifest would leave the other platform uncovered" ;;
  esac
  d="$(jq -r --arg a "$arch" \
    '[.manifests[] | select(.platform.os=="linux" and .platform.architecture==$a) | .digest] | if length==1 then .[0] else "" end' "$idx")"
  case "$d" in
    sha256:*) echo "$d" ;;
    *) die "index has no single linux/${arch} manifest" ;;
  esac
}

# assert_sbom <cyclonedx-json-file> <repo> <version> <arch>
# The SBOM must name its own image and version, list packages, carry at least
# one arch-qualified purl, and every arch-qualified purl must be THIS arch.
assert_sbom() {
  local f="$1" repo="$2" ver="$3" arch="$4" name v n archs bad a ok alias
  [ -s "$f" ] || die "SBOM ${f} is missing or empty"
  name="$(jq -r '.metadata.component.name // empty' "$f")"
  v="$(jq -r '.metadata.component.version // empty' "$f")"
  [ "$name" = "$repo" ] || die "SBOM metadata.component.name is '${name}', expected '${repo}'"
  [ "$v" = "$ver" ] || die "SBOM metadata.component.version is '${v}', expected '${ver}'"
  n="$(jq '[.components[]?] | length' "$f")"
  [ "$n" -gt 0 ] || die "SBOM for ${repo}@${ver} lists no components"
  # Architecture-neutral qualifiers (all/noarch/any) say nothing either way.
  archs="$(jq -r '.components[]?.purl // empty' "$f" \
    | sed -n 's/.*[?&]arch=\([^&#]*\).*/\1/p' \
    | grep -v -E '^(all|noarch|any)$' | sort -u || true)"
  [ -n "$archs" ] || die "SBOM for ${repo}@${ver} has no arch-qualified package purl — cannot prove it describes linux/${arch}"
  bad=""
  for a in $archs; do
    ok=0
    for alias in $(arch_aliases "$arch"); do
      [ "$a" = "$alias" ] && ok=1
    done
    [ "$ok" -eq 1 ] || bad="${bad} ${a}"
  done
  [ -z "$bad" ] || die "SBOM for ${repo}@${ver} (linux/${arch}) lists packages for foreign architecture(s):${bad}"
}

# assert_attestations <verify-attestation-output> <repo> <version> <arch> <digest>
# Every attestation cosign returned must be a CycloneDX predicate about this
# digest that passes assert_sbom. Zero attestations is a failure, not a pass.
assert_attestations() {
  local out="$1" repo="$2" ver="$3" arch="$4" digest="$5" count=0 p tmp pt subj
  tmp="$(mktemp -d)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    p="$(printf '%s' "$line" | jq -r '.payload // empty')"
    [ -n "$p" ] || continue
    count=$((count + 1))
    printf '%s' "$p" | base64 -d > "${tmp}/stmt.json" 2>/dev/null \
      || { rm -rf "$tmp"; die "attestation ${count} on ${repo}@${digest} has an undecodable payload"; }
    pt="$(jq -r '.predicateType // empty' "${tmp}/stmt.json")"
    [ "$pt" = "https://cyclonedx.org/bom" ] \
      || { rm -rf "$tmp"; die "attestation ${count} on ${repo}@${digest} has predicateType '${pt}', expected https://cyclonedx.org/bom"; }
    subj="$(jq -r '[.subject[]?.digest.sha256] | join(",")' "${tmp}/stmt.json")"
    [ "sha256:${subj}" = "$digest" ] \
      || { rm -rf "$tmp"; die "attestation ${count} on ${repo}@${digest} names subject 'sha256:${subj}'"; }
    jq '.predicate' "${tmp}/stmt.json" > "${tmp}/sbom.json"
    ( assert_sbom "${tmp}/sbom.json" "$repo" "$ver" "$arch" ) \
      || { rm -rf "$tmp"; die "attestation ${count} on ${repo}@${digest} failed the SBOM checks above"; }
  done < "$out"
  rm -rf "$tmp"
  [ "$count" -gt 0 ] || die "cosign verify-attestation returned no attestations for ${repo}@${digest} — refusing to report success"
  echo "  verified ${count} CycloneDX attestation(s) on ${repo}@${digest} (linux/${arch})"
}

# require_ci — keyless identity must come from a CI job, never a workstation.
require_ci() {
  [ "${GITLAB_CI:-}" = "true" ] || die "refusing to sign/attest outside GitLab CI (GITLAB_CI != true). Keyless identity must be the CI job, not a workstation. Use --dry-run locally."
  [ -n "${CI_JOB_ID:-}" ] || die "refusing to sign/attest: CI_JOB_ID is not set"
  [ -n "${SIGSTORE_ID_TOKEN:-}" ] || die "refusing to sign/attest: SIGSTORE_ID_TOKEN is not set (the job needs id_tokens: SIGSTORE_ID_TOKEN: aud: sigstore)"
}

# this_identity — the exact certificate SAN this job's keyless cert carries.
this_identity() {
  if [ -n "${VERIFY_IDENTITY:-}" ]; then
    echo "$VERIFY_IDENTITY"
  elif [ -n "${CI_COMMIT_TAG:-}" ]; then
    echo "${CI_SERVER_URL}/${CI_PROJECT_PATH}//.gitlab-ci.yml@refs/tags/${CI_COMMIT_TAG}"
  else
    echo "${CI_SERVER_URL}/${CI_PROJECT_PATH}//.gitlab-ci.yml@refs/heads/${CI_COMMIT_REF_NAME}"
  fi
}

# project_identity_regexp — any release-tag or main-branch run of this
# project (the identities a pre-existing attestation may legitimately carry).
project_identity_regexp() {
  local base
  base="$(printf '%s' "${CI_SERVER_URL}/${CI_PROJECT_PATH}" | sed 's/[.]/\\./g')"
  echo "^${base}//\\.gitlab-ci\\.yml@refs/(tags/v[0-9][^/]*|heads/${CI_DEFAULT_BRANCH:-main})\$"
}

# ─── main flow ───────────────────────────────────────────────────────────────

attest_repo() {
  local repo="$1" tag="$2" force="$3" dry="$4" work="$5"
  local idx="${work}/index.json" index_digest arch d cfg_arch sbom ver
  local identity regexp issuer DIGEST_amd64="" DIGEST_arm64=""
  echo "== ${repo}:${tag}"
  crane manifest "${repo}:${tag}" > "$idx" || die "cannot read ${repo}:${tag}"
  index_digest="$(crane digest "${repo}:${tag}")" || die "cannot resolve the digest of ${repo}:${tag}"
  case "$index_digest" in sha256:*) ;; *) die "bad index digest '${index_digest}' for ${repo}:${tag}" ;; esac
  for arch in amd64 arm64; do
    d="$(index_platform_digest "$idx" "$arch")"
    cfg_arch="$(crane config "${repo}@${d}" | jq -r '.architecture // empty')"
    [ "$cfg_arch" = "$arch" ] || die "${repo}@${d} is listed as linux/${arch} but its image config says '${cfg_arch}'"
    case "$arch" in amd64) DIGEST_amd64="$d" ;; arm64) DIGEST_arm64="$d" ;; esac
    echo "  linux/${arch}: ${repo}@${d}"
  done
  echo "  index: ${repo}@${index_digest}"
  if [ "$dry" -eq 1 ]; then
    echo "  dry-run: no signing or attestation performed."
    return 0
  fi

  identity="$(this_identity)"
  regexp="$(project_identity_regexp)"
  issuer="${CI_SERVER_URL}"

  # Signature: index + each platform manifest (--recursive).
  if [ "$force" -eq 0 ] \
    && cosign verify --certificate-identity-regexp "$regexp" --certificate-oidc-issuer "$issuer" "${repo}@${index_digest}" >/dev/null 2>&1 \
    && cosign verify --certificate-identity-regexp "$regexp" --certificate-oidc-issuer "$issuer" "${repo}@${DIGEST_amd64}" >/dev/null 2>&1 \
    && cosign verify --certificate-identity-regexp "$regexp" --certificate-oidc-issuer "$issuer" "${repo}@${DIGEST_arm64}" >/dev/null 2>&1; then
    echo "  already signed by this project; not re-signing (use --force)"
  else
    cosign sign --yes --recursive "${repo}@${index_digest}"
    for d in "$index_digest" "$DIGEST_amd64" "$DIGEST_arm64"; do
      cosign verify --certificate-identity "$identity" --certificate-oidc-issuer "$issuer" "${repo}@${d}" > "${work}/sig.json" \
        || die "cosign verify failed for ${repo}@${d} right after signing"
      [ "$(jq -s 'flatten | length' "${work}/sig.json")" -gt 0 ] \
        || die "cosign verify returned no signatures for ${repo}@${d}"
    done
    echo "  signed + verified index and both platform manifests"
  fi

  for arch in amd64 arm64; do
    case "$arch" in amd64) d="$DIGEST_amd64" ;; arm64) d="$DIGEST_arm64" ;; esac
    ver="${tag}-${arch}"
    if [ "$force" -eq 0 ] \
      && cosign verify-attestation --type cyclonedx --certificate-identity-regexp "$regexp" \
           --certificate-oidc-issuer "$issuer" "${repo}@${d}" > "${work}/existing.json" 2>/dev/null \
      && ( assert_attestations "${work}/existing.json" "$repo" "$ver" "$arch" "$d" ) >/dev/null 2>&1; then
      echo "  linux/${arch} already carries a verifying SBOM attestation for ${ver}; skipping (use --force)"
      continue
    fi
    sbom="${work}/sbom-${arch}.cdx.json"
    syft "registry:${repo}@${d}" --source-name "$repo" --source-version "$ver" -o "cyclonedx-json=${sbom}"
    assert_sbom "$sbom" "$repo" "$ver" "$arch"
    cosign attest --yes --type cyclonedx --predicate "$sbom" "${repo}@${d}"
    cosign verify-attestation --type cyclonedx --certificate-identity "$identity" \
      --certificate-oidc-issuer "$issuer" "${repo}@${d}" > "${work}/att-${arch}.json" \
      || die "cosign verify-attestation failed for ${repo}@${d} right after attesting"
    assert_attestations "${work}/att-${arch}.json" "$repo" "$ver" "$arch" "$d"
  done
}

main() {
  local image="" tag="" force=0 dry=0 registries="" r work
  while [ $# -gt 0 ]; do
    case "$1" in
      --image) image="${2:-}"; shift 2 ;;
      --tag) tag="${2:-}"; shift 2 ;;
      --registry) registries="${registries} ${2:-}"; shift 2 ;;
      --force) force=1; shift ;;
      --dry-run) dry=1; shift ;;
      --self-test) _self_test; return $? ;;
      -h|--help) sed -n '2,/^set -eu/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; return 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
  case "$image" in backend|frontend) ;; *) die "--image must be backend or frontend (got '${image}')" ;; esac
  printf '%s' "$tag" | grep -E -q '^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$' \
    || die "--tag must be a release tag like v1.2.0 or v1.2.0-rc.1 (got '${tag}')"
  if [ -z "$registries" ]; then
    [ -n "${CI_REGISTRY_IMAGE:-}" ] || die "CI_REGISTRY_IMAGE is not set; pass --registry explicitly"
    registries="${CI_REGISTRY_IMAGE} ghcr.io/visiban/visiban"
  fi
  for t in jq crane base64; do command -v "$t" >/dev/null || die "$t not found"; done
  if [ "$dry" -eq 0 ]; then
    require_ci
    for t in syft cosign; do command -v "$t" >/dev/null || die "$t not found"; done
  fi
  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand now: `work` is local and gone by EXIT.
  trap "rm -rf '${work}'" EXIT
  for r in $registries; do
    attest_repo "${r}/${image}" "$tag" "$force" "$dry" "$work"
  done
  if [ "$dry" -eq 1 ]; then
    echo "OK (dry-run): ${image}:${tag} resolves to a linux/amd64 + linux/arm64 index on:${registries}"
  else
    echo "OK: ${image}:${tag} — signed, and an SBOM attested + verified on every platform digest, on:${registries}"
  fi
}

# ─── --self-test ─────────────────────────────────────────────────────────────
#
# Two layers. (1) The pure helpers against fixture JSON, known-good and
# known-bad. (2) The whole main flow against stub crane/syft/cosign on PATH —
# including the silent-no-op shapes this script exists to refuse: a
# verify-attestation that exits 0 with nothing, an SBOM for the wrong arch, a
# missing arm64 entry. The stubs are reachable only through PATH inside this
# function's subshells, never from a CI variable.
_self_test() {
  local T fails=0 SELF="$0"
  T="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${T}'" EXIT

  pass() { echo "  ok   - $1"; }
  fail() { echo "  FAIL - $1"; fails=$((fails + 1)); }
  expect_ok() { local n="$1"; shift; if ( "$@" ) >"${T}/o" 2>&1; then pass "$n"; else fail "$n"; sed 's/^/         /' "${T}/o"; fi; }
  expect_err() { local n="$1" pat="$2"; shift 2
    if ( "$@" ) >"${T}/o" 2>&1; then fail "$n (unexpectedly succeeded)"; sed 's/^/         /' "${T}/o"
    elif grep -q -- "$pat" "${T}/o"; then pass "$n"
    else fail "$n (wrong error)"; sed 's/^/         /' "${T}/o"; fi; }

  local A=sha256:aaaa000000000000000000000000000000000000000000000000000000000000
  local B=sha256:bbbb000000000000000000000000000000000000000000000000000000000000
  local R=reg.example/visiban/backend

  # Fixtures — indexes.
  printf '{"mediaType":"application/vnd.docker.distribution.manifest.list.v2+json","manifests":[{"digest":"%s","platform":{"os":"linux","architecture":"amd64"}},{"digest":"%s","platform":{"os":"linux","architecture":"arm64"}}]}' "$A" "$B" > "${T}/idx-good.json"
  printf '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"digest":"%s","platform":{"os":"linux","architecture":"amd64"}}]}' "$A" > "${T}/idx-noarm.json"
  printf '{"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{}}' > "${T}/idx-single.json"

  # Fixtures — SBOMs. mk_sbom <file> <name> <version> <purl-arch...>
  mk_sbom() { local f="$1" n="$2" v="$3"; shift 3; local comps="" a
    for a in "$@"; do comps="${comps}${comps:+,}{\"type\":\"library\",\"name\":\"p-${a}\",\"purl\":\"pkg:deb/debian/p@1?arch=${a}&distro=debian-12\"}"; done
    printf '{"bomFormat":"CycloneDX","metadata":{"component":{"type":"container","name":"%s","version":"%s"}},"components":[%s]}' "$n" "$v" "$comps" > "$f"; }
  mk_sbom "${T}/s-good.json" "$R" v1.2.0-arm64 arm64 aarch64 all
  mk_sbom "${T}/s-name.json" /tmp/build v1.2.0-arm64 arm64
  mk_sbom "${T}/s-ver.json" "$R" v1.2.0-amd64 arm64
  mk_sbom "${T}/s-foreign.json" "$R" v1.2.0-arm64 arm64 x86_64
  mk_sbom "${T}/s-noarch.json" "$R" v1.2.0-arm64 all noarch
  mk_sbom "${T}/s-empty.json" "$R" v1.2.0-arm64
  : > "${T}/s-zero.json"

  # Fixtures — verify-attestation output. mk_att <sbom> <digest-hex>
  mk_att() { jq -c -n --slurpfile p "$1" --arg d "$2" \
      '{_type:"https://in-toto.io/Statement/v0.1",predicateType:"https://cyclonedx.org/bom",subject:[{name:"x",digest:{sha256:$d}}],predicate:$p[0]}' \
      | base64 | tr -d '\n' | jq -R -c '{payloadType:"application/vnd.in-toto+json",payload:.,signatures:[{sig:"x"}]}'; }
  mk_att "${T}/s-good.json" "${B#sha256:}" > "${T}/att-good.json"
  { mk_att "${T}/s-good.json" "${B#sha256:}"; mk_att "${T}/s-foreign.json" "${B#sha256:}"; } > "${T}/att-mixed.json"
  mk_att "${T}/s-good.json" "${A#sha256:}" > "${T}/att-subject.json"
  : > "${T}/att-none.json"

  expect_eq() { local n="$1" want="$2" got; shift 2
    got="$( "$@" 2>&1 )" || true
    if [ "$got" = "$want" ]; then pass "$n"; else fail "$n (got '${got}', want '${want}')"; fi; }
  matches() { printf '%s' "$2" | grep -E -q "$1"; }

  echo "attest-image-sbom.sh --self-test"
  echo " helpers:"
  expect_eq  "index: amd64 digest resolved"            "$A" index_platform_digest "${T}/idx-good.json" amd64
  expect_eq  "index: arm64 digest resolved"            "$B" index_platform_digest "${T}/idx-good.json" arm64
  expect_err "index: missing arm64 refused"            "no single linux/arm64" index_platform_digest "${T}/idx-noarm.json" arm64
  expect_err "index: single-arch manifest refused"     "not a multi-arch index" index_platform_digest "${T}/idx-single.json" amd64
  expect_ok  "sbom: good arm64 SBOM accepted"          assert_sbom "${T}/s-good.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: temp-path component name refused"  "component.name" assert_sbom "${T}/s-name.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: other arch's version refused"      "component.version" assert_sbom "${T}/s-ver.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: foreign-arch package refused"      "foreign architecture" assert_sbom "${T}/s-foreign.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: no arch-qualified purl refused"    "no arch-qualified" assert_sbom "${T}/s-noarch.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: zero components refused"           "no components" assert_sbom "${T}/s-empty.json" "$R" v1.2.0-arm64 arm64
  expect_err "sbom: empty file refused"                "missing or empty" assert_sbom "${T}/s-zero.json" "$R" v1.2.0-arm64 arm64
  expect_ok  "att: good attestation accepted"          assert_attestations "${T}/att-good.json" "$R" v1.2.0-arm64 arm64 "$B"
  expect_err "att: empty verify output refused"        "returned no attestations" assert_attestations "${T}/att-none.json" "$R" v1.2.0-arm64 arm64 "$B"
  expect_err "att: one wrong-arch among many refused"  "failed the SBOM checks" assert_attestations "${T}/att-mixed.json" "$R" v1.2.0-arm64 arm64 "$B"
  expect_err "att: subject on another digest refused"  "names subject" assert_attestations "${T}/att-subject.json" "$R" v1.2.0-arm64 arm64 "$B"
  expect_err "ci: refuses without GITLAB_CI"           "outside GitLab CI" env -u GITLAB_CI CI_JOB_ID=1 SIGSTORE_ID_TOKEN=x bash "$SELF" _t require_ci
  expect_err "ci: refuses without CI_JOB_ID"           "CI_JOB_ID" env -u CI_JOB_ID GITLAB_CI=true SIGSTORE_ID_TOKEN=x bash "$SELF" _t require_ci
  expect_err "ci: refuses without SIGSTORE_ID_TOKEN"   "SIGSTORE_ID_TOKEN" env -u SIGSTORE_ID_TOKEN GITLAB_CI=true CI_JOB_ID=1 bash "$SELF" _t require_ci
  expect_err "ci: refuses an empty SIGSTORE_ID_TOKEN"  "SIGSTORE_ID_TOKEN" env GITLAB_CI=true CI_JOB_ID=1 SIGSTORE_ID_TOKEN= bash "$SELF" _t require_ci
  expect_eq  "id: tag pipeline identity" "https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/tags/v1.2.0" \
    env -u VERIFY_IDENTITY CI_SERVER_URL=https://gitlab.com CI_PROJECT_PATH=visiban/visiban CI_COMMIT_TAG=v1.2.0 bash "$SELF" _t this_identity
  expect_eq  "id: main-branch (backfill) identity" "https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/heads/main" \
    env -u VERIFY_IDENTITY -u CI_COMMIT_TAG CI_SERVER_URL=https://gitlab.com CI_PROJECT_PATH=visiban/visiban CI_COMMIT_REF_NAME=main bash "$SELF" _t this_identity
  local re
  re="$(env CI_SERVER_URL=https://gitlab.com CI_PROJECT_PATH=visiban/visiban CI_DEFAULT_BRANCH=main bash "$SELF" _t project_identity_regexp)"
  if matches "$re" "https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/tags/v1.2.0" \
    && matches "$re" "https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/heads/main" \
    && ! matches "$re" "https://gitlab.com/visiban/visiban-enterprise//.gitlab-ci.yml@refs/tags/v1.2.0" \
    && ! matches "$re" "https://gitlab.com/visiban/visiban//.gitlab-ci.yml@refs/heads/feature" \
    && ! matches "$re" "https://gitlabXcom/visiban/visiban//.gitlab-ci.yml@refs/tags/v1.2.0"; then
    pass "id: project regexp accepts tag/main, rejects sibling repo, branch, unescaped dot"
  else fail "id: project regexp '${re}'"; fi
  expect_err "_t: refuses a non-helper"                "not a self-test helper" bash "$SELF" _t attest_repo reg.a/backend v1.2.0 1 0 /tmp

  # Layer 2: whole flow against stubs.
  local S="${T}/stub"
  mkdir -p "${S}/bin" "${S}/state"
  cp "${T}/idx-good.json" "${S}/index.json"
  cat > "${S}/bin/crane" <<'STUB'
#!/usr/bin/env bash
set -eu
case "$1" in
  manifest) cat "${STUB}/index.json" ;;
  digest) echo "sha256:1111000000000000000000000000000000000000000000000000000000000000" ;;
  config)
    case "$2" in
      *@sha256:aaaa*) echo "{\"architecture\":\"${STUB_AMD64_CFG:-amd64}\"}" ;;
      *@sha256:bbbb*) echo '{"architecture":"arm64"}' ;;
    esac ;;
esac
STUB
  cat > "${S}/bin/syft" <<'STUB'
#!/usr/bin/env bash
set -eu
name="" ver="" out=""
while [ $# -gt 0 ]; do case "$1" in
  --source-name) name="$2"; shift 2 ;; --source-version) ver="$2"; shift 2 ;;
  -o) out="${2#cyclonedx-json=}"; shift 2 ;; *) shift ;; esac; done
arch="${ver##*-}"; [ -n "${STUB_SYFT_ARCH:-}" ] && arch="$STUB_SYFT_ARCH"
printf '{"metadata":{"component":{"name":"%s","version":"%s"}},"components":[{"purl":"pkg:deb/debian/p@1?arch=%s"}]}' "$name" "$ver" "$arch" > "$out"
STUB
  cat > "${S}/bin/cosign" <<'STUB'
#!/usr/bin/env bash
set -eu
cmd="$1"; shift
ref=""; pred=""
for a in "$@"; do case "$a" in *@sha256:*) ref="$a" ;; esac; done
while [ $# -gt 0 ]; do [ "$1" = "--predicate" ] && pred="$2"; shift; done
key="$(printf '%s' "$ref" | tr '/@:' '___')"
echo "$cmd $ref" >> "${STUB}/calls.log"
case "$cmd" in
  sign) repo="$(printf '%s' "${ref%@*}" | tr '/' '_')"
    for d in aaaa bbbb 1111; do touch "${STUB}/state/sig-${repo}-${d}"; done ;;
  verify)
    repo="$(printf '%s' "${ref%@*}" | tr '/' '_')"
    case "$ref" in *sha256:aaaa*) d=aaaa ;; *sha256:bbbb*) d=bbbb ;; *) d=1111 ;; esac
    [ -f "${STUB}/state/sig-${repo}-${d}" ] || exit 1
    echo '[{"critical":{}}]' ;;
  attest) cp "$pred" "${STUB}/state/att-${key}" ;;
  verify-attestation)
    [ "${STUB_VERIFY_EMPTY:-0}" = 1 ] && exit 0
    [ -f "${STUB}/state/att-${key}" ] || exit 1
    hex="${ref##*sha256:}"
    jq -c -n --slurpfile p "${STUB}/state/att-${key}" --arg d "$hex" \
      '{predicateType:"https://cyclonedx.org/bom",subject:[{digest:{sha256:$d}}],predicate:$p[0]}' \
      | base64 | tr -d '\n' | jq -R -c '{payload:.}' ;;
esac
STUB
  chmod +x "${S}/bin/"*

  run_flow() { # run_flow <extra-env...> -- <args...>
    local envs=()
    while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
    env PATH="${S}/bin:${PATH}" STUB="$S" GITLAB_CI=true CI_JOB_ID=1 SIGSTORE_ID_TOKEN=x \
      CI_SERVER_URL=https://gitlab.com CI_PROJECT_PATH=visiban/visiban CI_COMMIT_TAG=v1.2.0 \
      ${envs[@]+"${envs[@]}"} bash "$SELF" "$@"
  }
  reset_stub() { rm -f "${S}/state/"* "${S}/calls.log"; cp "${T}/idx-good.json" "${S}/index.json"; }
  count_calls() { if [ -f "${S}/calls.log" ]; then grep -c "^$1 " "${S}/calls.log" || true; else echo 0; fi; }
  check() { local n="$1"; shift; if "$@"; then pass "$n"; else fail "$n"; fi; }

  echo " flow (stubbed crane/syft/cosign):"
  reset_stub
  expect_ok  "flow: happy path, two registries"        run_flow -- --image backend --tag v1.2.0 --registry reg.a --registry reg.b
  check "flow: attested 2 arches x 2 registries" [ "$(count_calls attest)" = 4 ]
  check "flow: attests each platform digest on each registry, never the index" sh -c \
    "grep -q '^attest reg.a/backend@sha256:aaaa' '$S/calls.log' && grep -q '^attest reg.a/backend@sha256:bbbb' '$S/calls.log' \
     && grep -q '^attest reg.b/backend@sha256:aaaa' '$S/calls.log' && grep -q '^attest reg.b/backend@sha256:bbbb' '$S/calls.log' \
     && ! grep -q '^attest .*sha256:1111' '$S/calls.log'"
  expect_ok  "flow: re-run is idempotent"              run_flow -- --image backend --tag v1.2.0 --registry reg.a --registry reg.b
  check "flow: re-run added no attestation or signature" [ "$(count_calls attest)/$(count_calls sign)" = 4/2 ]
  expect_ok  "flow: --force re-attests"                run_flow -- --image backend --tag v1.2.0 --registry reg.a --force
  check "flow: --force attested both arches again" [ "$(count_calls attest)" = 6 ]
  reset_stub
  expect_err "flow: verify-attestation silent no-op"   "returned no attestations" run_flow STUB_VERIFY_EMPTY=1 -- --image backend --tag v1.2.0 --registry reg.a
  reset_stub
  expect_err "flow: SBOM for the wrong arch"           "foreign architecture" run_flow STUB_SYFT_ARCH=x86_64 -- --image backend --tag v1.2.0 --registry reg.a
  reset_stub; cp "${T}/idx-noarm.json" "${S}/index.json"
  expect_err "flow: index missing arm64"               "no single linux/arm64" run_flow -- --image backend --tag v1.2.0 --registry reg.a
  check "flow: nothing signed when arm64 is missing" [ "$(count_calls sign)" = 0 ]
  reset_stub
  expect_err "flow: index entry vs config arch mismatch" "image config says" run_flow STUB_AMD64_CFG=arm64 -- --image backend --tag v1.2.0 --registry reg.a
  reset_stub
  expect_err "flow: refuses outside CI"                "outside GitLab CI" run_flow GITLAB_CI= -- --image backend --tag v1.2.0 --registry reg.a
  check "flow: no cosign call outside CI" [ ! -s "${S}/calls.log" ]
  expect_ok  "flow: --dry-run works outside CI"        run_flow GITLAB_CI= SIGSTORE_ID_TOKEN= -- --image frontend --tag v1.2.0 --registry reg.a --dry-run
  expect_err "args: bad image refused"                 "--image must be" run_flow -- --image web --tag v1.2.0 --registry reg.a
  expect_err "args: bare version tag refused"          "--tag must be" run_flow -- --image backend --tag 1.2.0 --registry reg.a

  if [ "$fails" -gt 0 ]; then
    echo "SELF-TEST FAILED: ${fails} case(s)"
    return 1
  fi
  echo "SELF-TEST PASSED"
}

# `_t <helper> args...` — invoke one helper in a fresh process. Used only by
# --self-test (env -u needs a real process to drop variables from).
# Whitelisted to the pure/read-only helpers, so it can never reach a code path
# that signs or attests without going through main()'s require_ci.
if [ "${1:-}" = "_t" ]; then
  shift
  case "${1:-}" in
    index_platform_digest|assert_sbom|assert_attestations|require_ci|this_identity|project_identity_regexp|arch_aliases) ;;
    *) die "'${1:-}' is not a self-test helper" ;;
  esac
  "$@"
  exit $?
fi

main "$@"
