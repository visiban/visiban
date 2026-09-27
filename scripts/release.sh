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

  [[ $rc -eq 0 ]] && echo "release: self-test passed."
  exit $rc
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>  (e.g. 0.2.0-beta.1)" >&2
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

# Update .env.example
# APP_VERSION is the v-prefixed image tag (matches the tags CI actually
# publishes to GHCR), not the bare VERSION -- #1174. The backend strips the
# "v" itself before serving GET /api/v1/version/ (visiban/utils.py).
sed -i '' "s/^APP_VERSION=.*/APP_VERSION=${TAG}/" .env.example

# Update docker-compose.yml (hardcoded value, not the :-dev fallback line)
# Only replace if there's already a hardcoded value; skip if it's the ${APP_VERSION:-dev} form
if grep -q "APP_VERSION: [^$]" docker-compose.yml; then
  sed -i '' "s/APP_VERSION: .*/APP_VERSION: ${VERSION}/" docker-compose.yml
fi

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

# Update docs/index.md release candidate banner
# Matches "**MAJOR.MINOR.PATCH-rc.N**" (just the version bolded, not the whole phrase)
# and "Earlier release candidates (rc.1–rc.N) are superseded..."
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  RC_NUM=$(echo "$VERSION" | grep -oE 'rc\.[0-9]+')
  PREV_RC_NUM=$(( $(echo "$RC_NUM" | grep -oE '[0-9]+$') - 1 ))
  sed -i '' "s|\*\*[0-9][0-9.]*-rc\.[0-9]*\*\*|**${VERSION}**|g" docs/index.md
  sed -i '' "s|Earlier release candidates (rc\.1–rc\.[0-9]*)|Earlier release candidates (rc.1–rc.${PREV_RC_NUM})|" docs/index.md
  # First RC of a cycle: docs/index.md still holds the GA "Latest release"
  # banner from the previous release, so the seds above find nothing to
  # rewrite. Convert it into the release-candidate banner (mirror of the GA
  # branch below) so the RC verification and the docs gate both pass.
  if ! grep -q 'is the current stable release candidate' docs/index.md; then
    TMP_INDEX=$(mktemp)
    awk -v ver="$VERSION" '
      /^!!! (warning|note) "(Release candidate|Latest release)"/ {
        print "!!! warning \"Release candidate\""
        print "    **" ver "** is the current stable release candidate for the upcoming release. Help test it and [report issues](https://gitlab.com/visiban/visiban/-/issues) before the stable release. See the [installation guide](getting-started/installation.md) to get started."
        skip = 1
        next
      }
      skip && /^    / { next }
      { skip = 0; print }
    ' docs/index.md > "$TMP_INDEX" && mv "$TMP_INDEX" docs/index.md
  fi
elif echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  # GA: replace the release-candidate admonition (header + indented body) with
  # the stable "Latest release" banner. Without this the GA docs shipped
  # carrying the RC banner and it was fixed by hand every release (#1083).
  # Also matches an existing "Latest release" banner so re-running is a no-op
  # apart from the version. scripts/check-docs-version-accuracy.sh asserts the
  # result in CI and on the tag pipeline.
  TMP_INDEX=$(mktemp)
  awk -v ver="$VERSION" -v tag="$TAG" '
    /^!!! (warning|note) "(Release candidate|Latest release)"/ {
      print "!!! note \"Latest release\""
      print "    **" ver "** is the current stable release. See the [release notes](https://gitlab.com/visiban/visiban/-/releases/" tag ") for what'"'"'s new, and the [installation guide](getting-started/installation.md) to get started."
      skip = 1
      next
    }
    skip && /^    / { next }
    { skip = 0; print }
  ' docs/index.md > "$TMP_INDEX" && mv "$TMP_INDEX" docs/index.md
fi

# Assemble any pending changelog fragments into CHANGELOG.md before rotating
if [[ -d changelog.d ]]; then
  scripts/assemble-changelog.sh || { echo "Error: changelog assembly failed" >&2; exit 1; }
fi

# Rotate CHANGELOG: rename [Unreleased] → [v{VERSION}] and prepend a fresh [Unreleased]
if ! grep -q "## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no [Unreleased] section" >&2
  exit 1
fi

# Extract the unreleased notes (everything between [Unreleased] header and next ## heading)
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md \
  | sed '/^[[:space:]]*$/d' | sed '/^---[[:space:]]*$/d')

# Single pass — see rotate_changelog above for why a rename-then-prepend
# two-step leaves a self-perpetuating orphan divider.
TMP=$(mktemp)
rotate_changelog CHANGELOG.md "$VERSION" "$TODAY" > "$TMP" && mv "$TMP" CHANGELOG.md

if ! grep -q "^## \[${VERSION}\] — ${TODAY}$" CHANGELOG.md; then
  echo "Error: CHANGELOG rotation did not produce a [${VERSION}] section" >&2
  exit 1
fi

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
sed -i '' "s|^  tag: .*|  tag: \"${TAG}\"|" helm/visiban/values.yaml

echo "Updated .env.example, docker-compose.yml, helm/visiban/values.yaml, frontend/package.json, CHANGELOG.md, README.md, docs/index.md, docs/getting-started/installation.md"

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

# docs/index.md must reference the RC number (for RC releases)
if echo "$VERSION" | grep -qE 'rc\.[0-9]+'; then
  RC_NUM=$(echo "$VERSION" | grep -oE 'rc\.[0-9]+')
  if ! grep -q "${RC_NUM} is the current stable release candidate" docs/index.md; then
    echo "  WARN: docs/index.md does not reference ${RC_NUM} as current RC" >&2
    ERRORS=$((ERRORS + 1))
  fi
fi

# docs/index.md must carry the stable banner for a GA release
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  if ! grep -qF "**${VERSION}** is the current stable release." docs/index.md \
     || grep -qi 'release candidate' docs/index.md; then
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

if [[ "$ERRORS" -gt 0 ]]; then
  echo "  ${ERRORS} version consistency warning(s) — review before committing" >&2
fi

# Commit and push branch
# Include changelog.d/ so that fragment deletions from assemble-changelog.sh
# are committed — without this, deleted fragments are left as unstaged changes
# and re-accumulate on main after the next pull.
git add CHANGELOG.md .env.example docker-compose.yml docker-compose.prod.yml \
        frontend/package.json README.md docs/index.md docs/getting-started/installation.md \
        helm/visiban/values.yaml changelog.d/
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
