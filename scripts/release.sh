#!/usr/bin/env bash
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.2.0-beta.1
set -euo pipefail

# ─── CHANGELOG rotation ──────────────────────────────────────────────────────
#
# rotate_changelog <file> <version> <date>  — writes the rotated file to stdout.
#
# ONE pass, not a `sed` rename followed by an `awk` prepend. The two-step version
# renamed the `## [Unreleased]` heading in place and then wrote a fresh
# `## [Unreleased]` + `---` above it — but the `---` divider that had been sitting
# UNDER the old Unreleased heading did not move, so it landed between the newly
# released heading and its first entry (or, on an empty Unreleased, immediately
# above the next heading with nothing between). It reproduces itself at every
# subsequent release and is invisible in review because the result is still
# valid markdown — see the cleanup in CHANGELOG.md's 1.0.0 and 1.1.0 sections.
rotate_changelog() {
  awk -v version="$2" -v date="$3" '
    # Rename the Unreleased heading to this version and emit a fresh Unreleased
    # block above it, then swallow the separator that belonged to the OLD
    # Unreleased block: blank lines and at most one `---` immediately after the
    # heading we just renamed.
    /^## \[Unreleased\]/ && !seen {
      print "## [Unreleased]"
      print ""
      print "---"
      print ""
      print "## [" version "] — " date
      seen = 1
      eating = 1
      next
    }
    eating && /^[[:space:]]*$/     { next }
    eating && /^---[[:space:]]*$/  { eating = 0; next }
    eating                         { eating = 0; print "" }
    { print }
  ' "$1"
}

# ─── Already-published guard ─────────────────────────────────────────────────
#
# refuse_if_published <remote> <tag>  — returns 1 (with a message) when the tag
# already exists on <remote>.
#
# The local `git tag` check below only sees tags this clone has fetched. A tag
# another machine or session already pushed is otherwise discovered only when
# the publish job fails after the tag is pushed — which is also the moment the
# milestone was just closed. An unreachable remote fails closed rather than
# silently proceeding as if the tag were absent.
refuse_if_published() {
  local remote="$1" tag="$2" listing
  if ! listing="$(git ls-remote --tags "$remote" "refs/tags/${tag}" 2>/dev/null)"; then
    echo "Error: could not list tags on ${remote} — check connectivity before releasing" >&2
    return 1
  elif [[ -n "$listing" ]]; then
    echo "Error: tag ${tag} already exists on ${remote}" >&2
    return 1
  fi
}

# ─── Helm chart tag pin ──────────────────────────────────────────────────────
#
# pin_helm_tags <file> <tag> — writes the rewritten file to stdout.
#
# Only rewrites a `tag:` line when it is the first one encountered after a
# `repository: ghcr.io/visiban/visiban/backend` or `.../frontend` line — the
# bundled Valkey and the `helm test` curl probe image also have `tag:` lines
# at the same indentation and must never be touched (#1254).
pin_helm_tags() {
  awk -v tag="$2" '
    /repository: ghcr\.io\/visiban\/visiban\/(backend|frontend)/ { pin=1 }
    pin && /^    tag: / { sub(/tag: .*/, "tag: \"" tag "\""); pin=0 }
    { print }
  ' "$1"
}

# bump_chart_app_version <file> <version> — writes the rewritten file to stdout.
#
# Only the top-level `appVersion:` line is rewritten. The chart's own
# `version:` field (its packaging semver) is deliberately untouched here — it
# is bumped independently, on changes to the chart templates themselves, not
# on every app release. Anchored to column 0 so a same-named field nested
# under a `dependencies:` entry (none currently exists, but nothing prevents
# one) can never be mistaken for the top-level field (#1268).
bump_chart_app_version() {
  awk -v version="$2" '
    /^appVersion: / { sub(/appVersion: .*/, "appVersion: \"" version "\"") }
    { print }
  ' "$1"
}

# rc_banner_is_current <file> <version> — true if <file> carries the RC banner
# for exactly <version>, in the bolded, full-version form the script's own
# writer blocks (both the first-RC-of-cycle awk block and the subsequent-RC
# sed, above) actually produce. A bare "rc.N is the current..." substring
# never appears in the real file (#1263) — this function is the single source
# of truth both the live check and its self-test call, so a regression of one
# can't hide behind an out-of-sync copy in the other.
rc_banner_is_current() {
  grep -qF "**${2}** is the current stable release candidate" "$1"
}

# dev_banner_is_current <file> <version> — same role as rc_banner_is_current,
# for the alpha/beta stage's own (more cautious) banner wording (#1265). Kept
# as a separate function/phrase rather than reusing the RC one: an alpha/beta
# is deliberately never called "the current release candidate".
dev_banner_is_current() {
  grep -qF "**${2}** is a pre-release development build" "$1"
}

# confirm_release_notes <notes>
#
# Shows the release notes about to ship — verbatim as extracted from
# CHANGELOG.md's [Unreleased] section — and gates on human approval before
# the release branch carries any further edit. Mirrors the release-summary
# gate in TruePPM's scripts/release.sh (release-default-summary.py): getting
# the version number right says nothing about whether the prose describing
# it is still correct — a stale bullet, a fragment filed under the wrong
# category, or an empty [Unreleased] all used to ship silently to
# CHANGELOG.md and the GitLab Release page.
#
# Enter accepts; anything else (including 'q'/'n') aborts. This function only
# reads and prints — the caller owns cleaning up the release branch on abort.
# RELEASE_ASSUME_YES=1 / -y accepts non-interactively (the /release skill
# sets this after the user has already approved the notes in chat); a
# non-TTY run without it fails closed rather than shipping unreviewed notes.
confirm_release_notes() {
  local notes="$1"

  if [[ "$ASSUME_YES" == true ]]; then
    echo "Release notes confirmed via --yes." >&2
    return 0
  fi

  if [[ ! -t 0 ]]; then
    echo "Error: no TTY to confirm release notes. Re-run with -y/--yes (or RELEASE_ASSUME_YES=1) to accept them non-interactively — normally only after showing them to the user and getting approval first." >&2
    return 1
  fi

  {
    echo ""
    echo "Release notes for ${TAG} (ship in CHANGELOG.md's [${VERSION}] section and the GitLab Release page):"
    echo "--------------------------------------------------------------------------------------------------"
    printf '%s\n' "$notes"
    echo "--------------------------------------------------------------------------------------------------"
    echo "To change them, abort here, edit CHANGELOG.md's [Unreleased] section, and re-run."
  } >&2

  local reply
  read -r -p "Enter to accept and continue, anything else to abort: " reply
  [[ -z "$reply" ]]
}

if [[ "${1:-}" == "--self-test" ]]; then
  rc=0; tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  _rot_case() { # <label> <input> <expected>
    printf '%s\n' "$2" > "$tmp/in.md"
    local got; got="$(rotate_changelog "$tmp/in.md" 0.3.0 2026-09-05)"
    if [[ "$got" == "$3" ]]; then
      echo "SELF-TEST OK: $1"
    else
      echo "SELF-TEST FAILED: $1" >&2
      echo "--- got ---"    >&2; printf '%s\n' "$got" >&2
      echo "--- wanted ---" >&2; printf '%s\n' "$3"   >&2
      rc=1
    fi
  }

  # The regression: the divider under Unreleased must NOT follow the heading
  # into the released section.
  _rot_case "a divider under Unreleased stays with Unreleased" \
'## [Unreleased]

---

### Added
- new thing

## [0.2.0] — 2026-08-29' \
'## [Unreleased]

---

## [0.3.0] — 2026-09-05

### Added
- new thing

## [0.2.0] — 2026-08-29'

  _rot_case "no divider under Unreleased still rotates cleanly" \
'## [Unreleased]

### Added
- new thing

## [0.2.0] — 2026-08-29' \
'## [Unreleased]

---

## [0.3.0] — 2026-09-05

### Added
- new thing

## [0.2.0] — 2026-08-29'

  # An empty Unreleased (nothing new since the last RC) must not leave an
  # orphan divider under the newly-released heading — the exact defect fixed
  # in CHANGELOG.md's 1.0.0 and 1.1.0 sections.
  _rot_case "an empty Unreleased rotates with no orphan divider" \
'## [Unreleased]

---

## [0.2.0] — 2026-08-29' \
'## [Unreleased]

---

## [0.3.0] — 2026-09-05

## [0.2.0] — 2026-08-29'

  # refuse_if_published: a tag already on the remote refuses; a clean remote
  # passes; an unreachable remote fails closed.
  git init -q --bare "$tmp/origin.git"
  git -C "$tmp" init -q work && git -C "$tmp/work" -c user.email=t@t -c user.name=t commit -q --allow-empty -m x
  git -C "$tmp/work" tag v9.9.9 && git -C "$tmp/work" push -q "$tmp/origin.git" v9.9.9
  _pub_case() { # <label> <want-rc> <remote> <tag>
    local got=0
    refuse_if_published "$3" "$4" 2>/dev/null || got=1
    if [[ "$got" == "$2" ]]; then echo "SELF-TEST OK: $1"; else echo "SELF-TEST FAILED: $1" >&2; rc=1; fi
  }
  _pub_case "tag already on the remote refuses" 1 "$tmp/origin.git" v9.9.9
  _pub_case "new tag on a clean remote passes" 0 "$tmp/origin.git" v1.0.0
  _pub_case "unreachable remote fails closed" 1 "$tmp/nope.git" v1.0.0

  # pin_helm_tags: only the backend/frontend tag: lines get pinned — the
  # bundled Valkey's tag at the same indentation must survive untouched (#1254).
  printf '%s\n' \
'backend:
  image:
    repository: ghcr.io/visiban/visiban/backend
    pullPolicy: IfNotPresent
    tag: "v1.1.0"

frontend:
  image:
    repository: ghcr.io/visiban/visiban/frontend
    pullPolicy: IfNotPresent
    tag: "v1.1.0"

valkey:
  image:
    repository: valkey/valkey
    tag: "8-alpine"
    pullPolicy: IfNotPresent' > "$tmp/values.yaml"
  got="$(pin_helm_tags "$tmp/values.yaml" v1.2.0-rc.1)"
  if [[ "$got" == *'repository: ghcr.io/visiban/visiban/backend'$'\n''    pullPolicy: IfNotPresent'$'\n''    tag: "v1.2.0-rc.1"'* ]] \
     && [[ "$got" == *'repository: ghcr.io/visiban/visiban/frontend'$'\n''    pullPolicy: IfNotPresent'$'\n''    tag: "v1.2.0-rc.1"'* ]] \
     && [[ "$got" == *'repository: valkey/valkey'$'\n''    tag: "8-alpine"'* ]]; then
    echo "SELF-TEST OK: pin_helm_tags pins backend/frontend, leaves valkey untouched"
  else
    echo "SELF-TEST FAILED: pin_helm_tags pins backend/frontend, leaves valkey untouched" >&2
    echo "--- got ---" >&2; printf '%s\n' "$got" >&2
    rc=1
  fi

  # bump_chart_app_version: only the top-level appVersion: line changes; the
  # chart's own `version:` field and a same-indentation dependency line must
  # survive untouched (#1268).
  printf '%s\n' \
'apiVersion: v2
name: visiban
description: Self-hosted Kanban board with customer swimlanes and card movement audit trail
type: application
version: 0.6.0
appVersion: "1.1.0"

dependencies:
  - name: postgresql
    version: "16.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.subchartEnabled' > "$tmp/Chart.yaml"
  got="$(bump_chart_app_version "$tmp/Chart.yaml" 1.2.0-rc.1)"
  if [[ "$got" == *$'\n''appVersion: "1.2.0-rc.1"'$'\n'* ]] \
     && [[ "$got" == *$'\n''version: 0.6.0'$'\n'* ]] \
     && [[ "$got" == *'version: "16.x.x"'* ]]; then
    echo "SELF-TEST OK: bump_chart_app_version rewrites appVersion, leaves chart version and dependency version untouched"
  else
    echo "SELF-TEST FAILED: bump_chart_app_version rewrites appVersion, leaves chart version and dependency version untouched" >&2
    echo "--- got ---" >&2; printf '%s\n' "$got" >&2
    rc=1
  fi

  # rc_banner_is_current: exercises the actual function the live check calls
  # (not a hardcoded copy of its pattern), against the exact bolded-full-
  # version text the script's writer blocks produce (#1263).
  printf '%s\n' '    **1.2.0-rc.1** is the current stable release candidate for the upcoming release.' > "$tmp/index.md"
  if rc_banner_is_current "$tmp/index.md" "1.2.0-rc.1"; then
    echo "SELF-TEST OK: rc_banner_is_current matches the script's actual banner text"
  else
    echo "SELF-TEST FAILED: rc_banner_is_current matches the script's actual banner text" >&2
    rc=1
  fi
  if rc_banner_is_current "$tmp/index.md" "1.2.0-rc.2"; then
    echo "SELF-TEST FAILED: rc_banner_is_current wrongly matches a different RC version" >&2
    rc=1
  else
    echo "SELF-TEST OK: rc_banner_is_current does not match a different RC version"
  fi

  # dev_banner_is_current: same coverage as rc_banner_is_current, for the
  # alpha/beta stage's own banner wording (#1265).
  printf '%s\n' '    **1.2.0-alpha.1** is a pre-release development build of the upcoming release — expect bugs and breaking changes.' > "$tmp/index.md"
  if dev_banner_is_current "$tmp/index.md" "1.2.0-alpha.1"; then
    echo "SELF-TEST OK: dev_banner_is_current matches the script's actual banner text"
  else
    echo "SELF-TEST FAILED: dev_banner_is_current matches the script's actual banner text" >&2
    rc=1
  fi
  if dev_banner_is_current "$tmp/index.md" "1.2.0-beta.1"; then
    echo "SELF-TEST FAILED: dev_banner_is_current wrongly matches a different pre-release version" >&2
    rc=1
  else
    echo "SELF-TEST OK: dev_banner_is_current does not match a different pre-release version"
  fi
  if rc_banner_is_current "$tmp/index.md" "1.2.0-alpha.1"; then
    echo "SELF-TEST FAILED: rc_banner_is_current wrongly matches an alpha/beta banner" >&2
    rc=1
  else
    echo "SELF-TEST OK: rc_banner_is_current does not match an alpha/beta banner"
  fi

  # confirm_release_notes: ASSUME_YES=true accepts without touching stdin;
  # a non-TTY run without it fails closed instead of shipping unreviewed
  # notes. Both exercised with stdin redirected from /dev/null (never a TTY
  # under CI or this self-test harness) so the fail-closed path is the one
  # actually reached rather than assumed.
  TAG="v9.9.9"; VERSION="9.9.9"
  ASSUME_YES=true
  if confirm_release_notes "- fake note" < /dev/null; then
    echo "SELF-TEST OK: confirm_release_notes accepts via ASSUME_YES without reading stdin"
  else
    echo "SELF-TEST FAILED: confirm_release_notes accepts via ASSUME_YES without reading stdin" >&2
    rc=1
  fi
  ASSUME_YES=false
  if confirm_release_notes "- fake note" < /dev/null; then
    echo "SELF-TEST FAILED: confirm_release_notes wrongly accepted with no TTY and no ASSUME_YES" >&2
    rc=1
  else
    echo "SELF-TEST OK: confirm_release_notes fails closed with no TTY and no ASSUME_YES"
  fi

  [[ $rc -eq 0 ]] && echo "release: self-test passed."
  exit $rc
fi

# -y/--yes (also RELEASE_ASSUME_YES=1) skips the release-notes confirmation
# gate below (confirm_release_notes). Stripped from "$@" before the
# positional VERSION arg is read so it can appear in either position:
# `release.sh -y 1.2.0` or `release.sh 1.2.0 -y`.
ASSUME_YES=false
[[ "${RELEASE_ASSUME_YES:-0}" == "1" ]] && ASSUME_YES=true
REST=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=true ;;
    *) REST="$REST $arg" ;;
  esac
done
# shellcheck disable=SC2086
set -- $REST

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 [-y|--yes] <version>  (e.g. 0.2.0-beta.1)" >&2
  exit 1
fi

TAG="v${VERSION}"
TODAY=$(date +%Y-%m-%d)

# Validate semver: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-label.N
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-z]+\.[0-9]+)?$'; then
  echo "Error: '$VERSION' is not valid semver (e.g. 1.2.3 or 1.2.3-beta.1)" >&2
  exit 1
fi

# Clean working tree required
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

# Check tag doesn't already exist.
#
# A here-string, not `git tag | grep -q`: under `set -o pipefail`, `grep -q`
# exits at its first match and SIGPIPEs `git tag`, the pipeline reports 141,
# and an EXISTING tag reads as absent — a race on how much `git` flushed
# before the pipe closed, so it passes on a repo with few tags and fails once
# there are enough that `grep` matches before `git tag` finishes writing.
if grep -qxF "$TAG" <<<"$(git tag)"; then
  echo "Error: tag $TAG already exists" >&2
  exit 1
fi
refuse_if_published "${RELEASE_REMOTE:-origin}" "$TAG" || exit 1

# Create release branch from latest main
git checkout main
git pull origin main
RELEASE_BRANCH="chore/release-${VERSION}"
git checkout -b "$RELEASE_BRANCH"

# ─── Release notes — resolved and confirmed before any manifest is touched ──
#
# Assemble pending changelog.d/ fragments into CHANGELOG.md's [Unreleased]
# section and extract the notes that will both open the new dated CHANGELOG
# section and become the GitLab Release page body (glab release create
# --notes-file, further down). Doing this immediately after the branch
# checkout — before .env.example, the frontend/README/docs seds below, and
# the CHANGELOG rotation itself — means an empty or unconfirmed summary
# aborts a tree that has had nothing but a branch checkout done to it, not
# one with a half-finished set of file edits already applied. Mirrors why
# TruePPM's release.sh resolves its own release summary before bumping
# anything (release-default-summary.py).
abort_release_branch() {
  git reset --hard HEAD
  git checkout main
  git branch -D "$RELEASE_BRANCH"
}

if [[ -d changelog.d ]]; then
  scripts/assemble-changelog.sh || { echo "Error: changelog assembly failed" >&2; abort_release_branch; exit 1; }
fi

if ! grep -q "## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no [Unreleased] section" >&2
  abort_release_branch
  exit 1
fi

# Extract the unreleased notes (everything between [Unreleased] header and next ## heading)
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md \
  | sed '/^[[:space:]]*$/d' | sed '/^---[[:space:]]*$/d')

if [[ -z "$(echo "$RELEASE_NOTES" | tr -d '[:space:]')" ]]; then
  echo "Error: CHANGELOG.md [Unreleased] section is empty — add release notes before releasing." >&2
  abort_release_branch
  exit 1
fi

confirm_release_notes "$RELEASE_NOTES" || {
  echo "Aborted by operator — no release cut." >&2
  abort_release_branch
  exit 1
}

# Rotate CHANGELOG: rename [Unreleased] → [v{VERSION}] and prepend a fresh
# [Unreleased] — single pass; see rotate_changelog above for why a
# rename-then-prepend two-step leaves a self-perpetuating orphan divider.
TMP=$(mktemp)
rotate_changelog CHANGELOG.md "$VERSION" "$TODAY" > "$TMP" && mv "$TMP" CHANGELOG.md

if ! grep -q "^## \[${VERSION}\] — ${TODAY}$" CHANGELOG.md; then
  echo "Error: CHANGELOG rotation did not produce a [${VERSION}] section" >&2
  abort_release_branch
  exit 1
fi

# Update .env.example
# APP_VERSION is the v-prefixed image tag (matches the tags CI actually
# publishes to GHCR), not the bare VERSION -- #1174. The backend strips the
# "v" itself before serving GET /api/v1/version/ (visiban/utils.py).
sed -i '' "s/^APP_VERSION=.*/APP_VERSION=${TAG}/" .env.example

# Update frontend/package.json — Vite injects this as __APP_VERSION__ at build time
# so the Settings → About page reads the version from here.
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" frontend/package.json

# Update README.md Docker image version examples
# The release badge is now a dynamic shields.io/github badge — no sed needed.
# Matches lines like: docker pull ghcr.io/visiban/visiban/backend:v1.0.0-rc.10
sed -i '' "s|ghcr.io/visiban/visiban/backend:v[^ ]*|ghcr.io/visiban/visiban/backend:${TAG}|g" README.md
sed -i '' "s|ghcr.io/visiban/visiban/frontend:v[^ ]*|ghcr.io/visiban/visiban/frontend:${TAG}|g" README.md

# Update docs/getting-started/installation.md APP_VERSION example
# Same v-prefixed tag form as .env.example above -- #1174.
sed -i '' "s|^APP_VERSION=.*|APP_VERSION=${TAG}|" docs/getting-started/installation.md

# Update docs/getting-started/kubernetes.md `helm upgrade --set ...image.tag=`
# examples -- same v-prefixed tag form, and the same drift #1174 fixed for
# installation.md. Anchored on `backend.image.tag=`/`frontend.image.tag=`
# specifically so this does not touch the unrelated prose mention of
# `backend.image.tag`/`frontend.image.tag` a few lines below the example.
sed -i '' "s|backend\.image\.tag=v[^ ]*|backend.image.tag=${TAG}|" docs/getting-started/kubernetes.md
sed -i '' "s|frontend\.image\.tag=v[^ ]*|frontend.image.tag=${TAG}|" docs/getting-started/kubernetes.md

# Update docs/index.md's pre-release/stable banner.
#
# All three banner-rewrite blocks below (rc, alpha/beta, GA) match the same
# widened header set `(Release candidate|Pre-release|Latest release)` — not
# just their own stage's header — because a version can transition through
# any stage boundary (alpha -> beta, beta -> rc, or straight to GA) and the
# awk fallback has to recognize whatever banner the *previous* release left
# behind, not just the one its own stage normally writes (#1265).
#
# Matches "**MAJOR.MINOR.PATCH-rc.N**" (just the version bolded, not the whole phrase)
# and "Earlier release candidates (rc.1–rc.N) are superseded..."
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  RC_NUM=$(echo "$VERSION" | grep -oE 'rc\.[0-9]+')
  PREV_RC_NUM=$(( $(echo "$RC_NUM" | grep -oE '[0-9]+$') - 1 ))
  sed -i '' "s|\*\*[0-9][0-9.]*-rc\.[0-9]*\*\*|**${VERSION}**|g" docs/index.md
  sed -i '' "s|Earlier release candidates (rc\.1–rc\.[0-9]*)|Earlier release candidates (rc.1–rc.${PREV_RC_NUM})|" docs/index.md
  # First RC of a cycle: docs/index.md still holds the previous cycle's GA
  # "Latest release" banner (or, now that alpha/beta are wired up, that
  # cycle's own "Pre-release" banner), so the seds above find nothing to
  # rewrite. Convert it into the release-candidate banner (mirror of the GA
  # branch below) so the RC verification and the docs gate both pass.
  if ! rc_banner_is_current docs/index.md "$VERSION"; then
    TMP_INDEX=$(mktemp)
    awk -v ver="$VERSION" '
      /^!!! (warning|note) "(Release candidate|Pre-release|Latest release)"/ {
        print "!!! warning \"Release candidate\""
        print "    **" ver "** is the current stable release candidate for the upcoming release. Help test it and [report issues](https://gitlab.com/visiban/visiban/-/issues) before the stable release. See the [installation guide](getting-started/installation.md) to get started."
        skip = 1
        next
      }
      skip && /^    / { next }
      { skip = 0; print }
    ' docs/index.md > "$TMP_INDEX" && mv "$TMP_INDEX" docs/index.md
  fi
elif echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta)\.[0-9]+$'; then
  # alpha/beta: same two-path structure as rc above (bump-in-place sed, then
  # a first-of-cycle awk fallback), but deliberately its own, more cautious
  # wording -- an alpha/beta is not "the current release candidate" (#1265).
  # No "Earlier release candidates" bookkeeping either; that list is
  # rc-cycle-specific and alpha/beta don't have an equivalent convention yet.
  sed -i '' "s|\*\*[0-9][0-9.]*-\(alpha\|beta\)\.[0-9]*\*\* is a pre-release development build|**${VERSION}** is a pre-release development build|" docs/index.md
  if ! dev_banner_is_current docs/index.md "$VERSION"; then
    TMP_INDEX=$(mktemp)
    awk -v ver="$VERSION" '
      /^!!! (warning|note) "(Release candidate|Pre-release|Latest release)"/ {
        print "!!! warning \"Pre-release\""
        print "    **" ver "** is a pre-release development build of the upcoming release — expect bugs and breaking changes. [Report issues](https://gitlab.com/visiban/visiban/-/issues) or see the [installation guide](getting-started/installation.md) if you want to try it early."
        skip = 1
        next
      }
      skip && /^    / { next }
      { skip = 0; print }
    ' docs/index.md > "$TMP_INDEX" && mv "$TMP_INDEX" docs/index.md
  fi
elif echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  # GA: replace whatever pre-release admonition (header + indented body) is
  # currently there with the stable "Latest release" banner. Without this the
  # GA docs shipped carrying the previous banner and it was fixed by hand
  # every release (#1083). Also matches an existing "Latest release" banner
  # so re-running is a no-op apart from the version.
  # scripts/check-docs-version-accuracy.sh asserts the result in CI and on
  # the tag pipeline.
  TMP_INDEX=$(mktemp)
  awk -v ver="$VERSION" -v tag="$TAG" '
    /^!!! (warning|note) "(Release candidate|Pre-release|Latest release)"/ {
      print "!!! note \"Latest release\""
      print "    **" ver "** is the current stable release. See the [release notes](https://gitlab.com/visiban/visiban/-/releases/" tag ") for what'"'"'s new, and the [installation guide](getting-started/installation.md) to get started."
      skip = 1
      next
    }
    skip && /^    / { next }
    { skip = 0; print }
  ' docs/index.md > "$TMP_INDEX" && mv "$TMP_INDEX" docs/index.md
fi

# CHANGELOG.md was already assembled, extracted (into $RELEASE_NOTES),
# confirmed, and rotated to [${VERSION}] — ${TODAY} right after the branch
# checkout above, before this or any other file was touched.

# Pin the Helm chart to the release version so users deploying the chart get
# the exact matching image, not a moving tag.
#
# docker-compose.prod.yml is deliberately NOT rewritten here (#1074).  It used
# to be a candidate for the same treatment — two `sed` lines used to try to
# replace the backend/frontend image references with a literal ${TAG}, but
# they matched a quoted `"...:${APP_VERSION:-...}"` form this file has not
# used since before `${APP_VERSION:-latest}` templating was introduced, so
# they had been silently no-op-ing every release (the WARN check below caught
# the resulting drift, but only as a review-time warning, never a blocker).
# Rewriting the compose file's image line per release would also remove the
# operator's ability to select a version via `.env` — the deliberate design
# check-compose-image-pins.sh documents ("an operator selects the release
# through .env"). The fix for the mutable-`latest` default is instead
# fail-closed `${APP_VERSION:?...}` in docker-compose.prod.yml itself; see the
# consistency check below, which now guards THAT instead of a release-tag pin
# that was never actually happening.
TMP=$(mktemp)
pin_helm_tags helm/visiban/values.yaml "$TAG" > "$TMP" && mv "$TMP" helm/visiban/values.yaml

# Bump the chart's appVersion to match this release. The bare VERSION (no
# "v" prefix), matching frontend/package.json's version field and what the
# helm-publish CI job's hard-fail check compares against (#1268).
TMP=$(mktemp)
bump_chart_app_version helm/visiban/Chart.yaml "$VERSION" > "$TMP" && mv "$TMP" helm/visiban/Chart.yaml

echo "Updated .env.example, helm/visiban/values.yaml, helm/visiban/Chart.yaml, frontend/package.json, CHANGELOG.md, README.md, docs/index.md, docs/getting-started/installation.md, docs/getting-started/kubernetes.md"

# Verify version consistency across key files
echo "Verifying version consistency..."
ERRORS=0

# .env.example must contain the v-prefixed image tag, not the bare version
if ! grep -q "APP_VERSION=${TAG}" .env.example; then
  echo "  WARN: .env.example does not contain APP_VERSION=${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi

# frontend/package.json must contain the version
if ! grep -q "\"version\": \"${VERSION}\"" frontend/package.json; then
  echo "  WARN: frontend/package.json does not contain version ${VERSION}" >&2
  ERRORS=$((ERRORS + 1))
fi

# README.md docker pull examples must reference the tag
if ! grep -q "ghcr.io/visiban/visiban/backend:${TAG}" README.md; then
  echo "  WARN: README.md docker pull example does not reference ${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi

# docs/getting-started/installation.md must reference the v-prefixed tag
if ! grep -q "APP_VERSION=${TAG}" docs/getting-started/installation.md; then
  echo "  WARN: docs/getting-started/installation.md does not reference APP_VERSION=${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi

# docs/getting-started/kubernetes.md `helm upgrade --set ...image.tag=` examples
# must reference the v-prefixed tag too (#1174)
if ! grep -q "backend.image.tag=${TAG}" docs/getting-started/kubernetes.md; then
  echo "  WARN: docs/getting-started/kubernetes.md does not reference backend.image.tag=${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi
if ! grep -q "frontend.image.tag=${TAG}" docs/getting-started/kubernetes.md; then
  echo "  WARN: docs/getting-started/kubernetes.md does not reference frontend.image.tag=${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi

# docs/index.md must reference the RC number (for RC releases)
if echo "$VERSION" | grep -qE 'rc\.[0-9]+'; then
  RC_NUM=$(echo "$VERSION" | grep -oE 'rc\.[0-9]+')
  if ! rc_banner_is_current docs/index.md "$VERSION"; then
    echo "  WARN: docs/index.md does not reference ${RC_NUM} as current RC" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# docs/index.md must reference the pre-release version (for alpha/beta releases)
if echo "$VERSION" | grep -qE '\-(alpha|beta)\.[0-9]+$'; then
  if ! dev_banner_is_current docs/index.md "$VERSION"; then
    echo "  WARN: docs/index.md does not reference ${VERSION} as the current pre-release" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# docs/index.md must carry the stable banner for a GA release
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  if ! grep -qF "**${VERSION}** is the current stable release." docs/index.md \
     || grep -qiE 'release candidate|pre-release development build' docs/index.md; then
    echo "  WARN: docs/index.md does not carry the GA banner for ${VERSION}" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# Cross-check with the same gate CI runs on main and on the tag pipeline
# (stale "Coming in X" callouts, RC banner on GA, stale install pins).
if ! scripts/check-docs-version-accuracy.sh >&2; then
  echo "  WARN: scripts/check-docs-version-accuracy.sh reported violations (see above)" >&2
  ERRORS=$((ERRORS + 1))
fi

# docker-compose.prod.yml must still fail closed on a missing APP_VERSION —
# not have drifted back to a silent `:-latest`/`:-` default (#1074). This
# replaces a release-tag-pin check that had been silently passing/warning on
# a rewrite (see the comment above the Helm pin, above) that was not actually
# happening; check-compose-image-pins.sh deliberately does not cover this
# (first-party ${APP_VERSION} references are out of its scope), so this is
# the only gate that would catch that regression.
if [[ "$(grep -c 'APP_VERSION:?' docker-compose.prod.yml)" -lt 4 ]]; then
  echo "  WARN: docker-compose.prod.yml no longer fail-closes on APP_VERSION in all 4 places (backend-init/backend/scheduler/frontend-build) — check it has not reverted to a silent 'latest' default" >&2
  ERRORS=$((ERRORS + 1))
fi

# helm/visiban/values.yaml must reference the release tag
if ! grep -q "tag: \"${TAG}\"" helm/visiban/values.yaml; then
  echo "  WARN: helm/visiban/values.yaml does not reference image tag ${TAG}" >&2
  ERRORS=$((ERRORS + 1))
fi

# helm/visiban/Chart.yaml's appVersion must match the release version — the
# helm-publish CI job hard-fails on this at tag time (#1268), so catching it
# here fails fast instead of after every other tag-pipeline job (images,
# manifests, GitHub release, docs deploy) has already published.
if ! grep -q "^appVersion: \"${VERSION}\"" helm/visiban/Chart.yaml; then
  echo "  WARN: helm/visiban/Chart.yaml appVersion does not match ${VERSION}" >&2
  ERRORS=$((ERRORS + 1))
fi

if [[ "$ERRORS" -gt 0 ]]; then
  echo "  ${ERRORS} version consistency warning(s) — review before committing" >&2
fi

# Commit and push branch
# Include changelog.d/ so that fragment deletions from assemble-changelog.sh
# are committed — without this, deleted fragments are left as unstaged changes
# and re-accumulate on main after the next pull.
git add CHANGELOG.md .env.example docker-compose.prod.yml \
        frontend/package.json README.md docs/index.md docs/getting-started/installation.md \
        docs/getting-started/kubernetes.md helm/visiban/values.yaml helm/visiban/Chart.yaml changelog.d/
git commit -m "chore: release ${TAG}"
git push -u origin "$RELEASE_BRANCH"

echo "Pushed branch $RELEASE_BRANCH"

# Create MR
echo "Creating merge request..."
MR_URL=$(glab mr create --title "chore: release ${TAG}" \
  --description "Bump APP_VERSION to ${VERSION} and rotate CHANGELOG." \
  --target-branch main --yes 2>&1 | grep -oE 'https://[^ ]+')
MR_NUM=$(echo "$MR_URL" | grep -oE '[0-9]+$')

# Wait for the MR pipeline to reach a terminal state, THEN merge — a plain
# `glab mr merge`, not `--when-pipeline-succeeds`. The latter asks GitLab to
# watch for us and fired at least once before GitLab had created the pipeline
# object yet (nothing was there to watch), which 405s and nothing retries it —
# the release then sits merged-looking in the terminal but not actually merged.
# Polling for the pipeline's own status ourselves removes that race.
echo "Waiting for MR !${MR_NUM}'s pipeline..."
PIPELINE_STATUS=""
for _ in $(seq 1 180); do  # up to 30 minutes at 10s intervals
  PIPELINE_STATUS=$(glab api "projects/:id/merge_requests/${MR_NUM}" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print((d.get('head_pipeline') or {}).get('status') or '')" 2>/dev/null || true)
  case "$PIPELINE_STATUS" in
    success) break ;;
    failed|canceled)
      echo "Error: MR !${MR_NUM} pipeline ${PIPELINE_STATUS}. Fix on the branch and re-run, or merge manually once green." >&2
      exit 1
      ;;
  esac
  sleep 10
done

if [[ "$PIPELINE_STATUS" != "success" ]]; then
  echo "Error: MR !${MR_NUM} pipeline did not reach success within 30 minutes (last seen: '${PIPELINE_STATUS}'). Check manually: glab mr view ${MR_NUM}" >&2
  exit 1
fi

echo "Pipeline green. Merging MR !${MR_NUM}..."
glab mr merge "$MR_NUM" --yes

# Wait for the merge to actually land.
echo "Waiting for merge to complete..."
STATE=""
for _ in $(seq 1 30); do
  STATE=$(glab mr view "$MR_NUM" 2>&1 | grep '^state:' | awk '{print $2}')
  [[ "$STATE" == "merged" ]] && break
  sleep 5
done

if [[ "$STATE" != "merged" ]]; then
  echo "Error: MR !${MR_NUM} did not merge. Merge manually, then tag." >&2
  exit 1
fi

git checkout main
git pull origin main

# The MR pipeline going green is not the same promise as the branch pipeline
# at this commit going green — pipelines trigger per ref, so a `push` pipeline
# on `main` can run a different job set (via `rules:`) than the
# `merge_request_event` pipeline that just passed. Tagging from a commit whose
# own branch pipeline never ran, or failed, publishes from an unproven state —
# confirm the pipeline AT THIS COMMIT, not merely the newest one on the branch.
MERGE_SHA=$(git rev-parse HEAD)
echo "Confirming main's own pipeline at ${MERGE_SHA:0:8}..."
MAIN_PIPELINE_STATUS=""
for _ in $(seq 1 90); do  # up to 15 minutes
  MAIN_PIPELINE_STATUS=$(glab api "projects/:id/pipelines?sha=${MERGE_SHA}&per_page=1" 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print((d[0]['status'] if d else ''))" 2>/dev/null || true)
  case "$MAIN_PIPELINE_STATUS" in
    success) break ;;
    failed|canceled)
      echo "Error: main's pipeline at ${MERGE_SHA:0:8} ${MAIN_PIPELINE_STATUS}. Do not tag a commit whose own pipeline failed — fix forward and re-run." >&2
      exit 1
      ;;
  esac
  sleep 10
done

if [[ "$MAIN_PIPELINE_STATUS" != "success" ]]; then
  echo "Error: main's pipeline at ${MERGE_SHA:0:8} did not reach success within 15 minutes (last seen: '${MAIN_PIPELINE_STATUS}'). Check manually before tagging: glab ci list --ref main" >&2
  exit 1
fi

# Tag the merged result
git tag "$TAG"
git push origin "$TAG"

echo "Pushed tag $TAG"

# Create GitLab release — use --notes-file to avoid shell escaping issues
NOTES_FILE=$(mktemp)
if [[ -z "$RELEASE_NOTES" ]]; then
  echo "See CHANGELOG.md for details." > "$NOTES_FILE"
else
  echo "$RELEASE_NOTES" > "$NOTES_FILE"
fi

glab release create "$TAG" --name "$TAG" --notes-file "$NOTES_FILE"
rm -f "$NOTES_FILE"

# Close any remaining open issues in the milestone so the milestone ends clean.
# Issues closed by MR auto-close are already handled at merge time; this catches
# any audit-generated or manually-created issues that were fixed without an
# explicit "Closes #N" reference in the MR description.
#
# Only for a stable release. A pre-release (alpha/beta/rc) tags a milestone that
# is still open by definition — closing every remaining issue in it would mark
# the GA blockers as done the moment the first alpha ships. The milestone is
# closed by the stable tag that ends it.
if echo "$VERSION" | grep -qE '\-[a-z]+\.[0-9]+$'; then
  echo "Pre-release ${VERSION}: leaving milestone issues open."
else
  MILESTONE_TITLE="${VERSION%.*}.x"  # e.g. "1.0" from "1.0.3", "1.x" from "1.2.0"
  # For a major.minor.patch version, derive the milestone as major.minor.
  if [[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+ ]]; then
    MILESTONE_TITLE="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
  fi
  echo "Closing open milestone issues for '${MILESTONE_TITLE}'..."
  "$(dirname "$0")/close-milestone-issues.sh" "$MILESTONE_TITLE" || true
fi

echo ""
echo "Done. Release $TAG is live. The CI tag pipeline will deploy docs.visiban.com."
