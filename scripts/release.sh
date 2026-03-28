#!/usr/bin/env bash
# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 0.2.0-beta.1
set -euo pipefail

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

# Check tag doesn't already exist
if git tag | grep -q "^${TAG}$"; then
  echo "Error: tag $TAG already exists" >&2
  exit 1
fi

# Create release branch from latest main
git checkout main
git pull origin main
RELEASE_BRANCH="chore/release-${VERSION}"
git checkout -b "$RELEASE_BRANCH"

# Update .env.example
sed -i '' "s/^APP_VERSION=.*/APP_VERSION=${VERSION}/" .env.example

# Update docker-compose.yml (hardcoded value, not the :-dev fallback line)
# Only replace if there's already a hardcoded value; skip if it's the ${APP_VERSION:-dev} form
if grep -q "APP_VERSION: [^$]" docker-compose.yml; then
  sed -i '' "s/APP_VERSION: .*/APP_VERSION: ${VERSION}/" docker-compose.yml
fi

# Update frontend/package.json — Vite injects this as __APP_VERSION__ at build time
# so the Settings → About page reads the version from here.
sed -i '' "s/\"version\": \".*\"/\"version\": \"${VERSION}\"/" frontend/package.json

# Update README.md release badge — shields.io encodes hyphens as double-hyphens
# e.g. v1.0.0-rc.9 → v1.0.0--rc.9 in the badge URL
BADGE_VER=$(echo "$TAG" | sed 's/-/--/g')
sed -i '' "s|^\[!\[release\].*$|[![release](https://img.shields.io/badge/release-${BADGE_VER}-blue)](https://gitlab.com/visiban/visiban/-/releases/${TAG})|" README.md

# Update docs/index.md release candidate banner
# Matches lines like "**rc.8 is the current stable release candidate.**"
# and "Earlier release candidates (rc.1–rc.7) are superseded..."
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$'; then
  RC_NUM=$(echo "$VERSION" | grep -oE 'rc\.[0-9]+')
  PREV_RC_NUM=$(( $(echo "$RC_NUM" | grep -oE '[0-9]+$') - 1 ))
  sed -i '' "s|**rc\.[0-9]* is the current stable release candidate\.\*\*|**${RC_NUM} is the current stable release candidate.**|" docs/index.md
  sed -i '' "s|Earlier release candidates (rc\.1–rc\.[0-9]*)|Earlier release candidates (rc.1–rc.${PREV_RC_NUM})|" docs/index.md
fi

# Rotate CHANGELOG: rename [Unreleased] → [v{VERSION}] and prepend a fresh [Unreleased]
if ! grep -q "## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no [Unreleased] section" >&2
  exit 1
fi

# Extract the unreleased notes (everything between [Unreleased] header and next ## heading)
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md \
  | sed '/^[[:space:]]*$/d' | sed '/^---[[:space:]]*$/d')

sed -i '' "s/## \[Unreleased\]/## [${VERSION}] — ${TODAY}/" CHANGELOG.md

# Prepend fresh [Unreleased] block
TMP=$(mktemp)
awk -v version="$VERSION" -v date="$TODAY" '
  /^## \[[0-9]/ && !done {
    print "## [Unreleased]\n"
    print "---\n"
    done=1
  }
  { print }
' CHANGELOG.md > "$TMP" && mv "$TMP" CHANGELOG.md

echo "Updated .env.example, docker-compose.yml, frontend/package.json, CHANGELOG.md, README.md, docs/index.md"

# Verify version consistency across key files
echo "Verifying version consistency..."
ERRORS=0

# .env.example must contain the version
if ! grep -q "APP_VERSION=${VERSION}" .env.example; then
  echo "  WARN: .env.example does not contain APP_VERSION=${VERSION}" >&2
  ERRORS=$((ERRORS + 1))
fi

# frontend/package.json must contain the version
if ! grep -q "\"version\": \"${VERSION}\"" frontend/package.json; then
  echo "  WARN: frontend/package.json does not contain version ${VERSION}" >&2
  ERRORS=$((ERRORS + 1))
fi

# README.md badge must reference the tag
if ! grep -q "${TAG}" README.md; then
  echo "  WARN: README.md release badge does not reference ${TAG}" >&2
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

if [[ "$ERRORS" -gt 0 ]]; then
  echo "  ${ERRORS} version consistency warning(s) — review before committing" >&2
fi

# Commit and push branch
git add CHANGELOG.md .env.example docker-compose.yml frontend/package.json README.md docs/index.md
git commit -m "chore: release ${TAG}"
git push -u origin "$RELEASE_BRANCH"

echo "Pushed branch $RELEASE_BRANCH"

# Create MR and merge
echo "Creating merge request..."
MR_URL=$(glab mr create --title "chore: release ${TAG}" \
  --description "Bump APP_VERSION to ${VERSION} and rotate CHANGELOG." \
  --target-branch main --yes 2>&1 | grep -oE 'https://[^ ]+')

echo "Waiting for pipeline..."
sleep 5

MR_NUM=$(echo "$MR_URL" | grep -oE '[0-9]+$')
glab mr merge "$MR_NUM" --yes --when-pipeline-succeeds 2>&1 || true

# Wait for merge to complete
echo "Waiting for merge..."
for i in $(seq 1 60); do
  STATE=$(glab mr view "$MR_NUM" 2>&1 | grep '^state:' | awk '{print $2}')
  if [[ "$STATE" == "merged" ]]; then
    break
  fi
  sleep 10
done

if [[ "$STATE" != "merged" ]]; then
  echo "Error: MR !${MR_NUM} did not merge in time. Merge manually, then tag." >&2
  exit 1
fi

# Tag the merged result
git checkout main
git pull origin main
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

# Deploy docs with mike
echo "Deploying docs..."
pip install --quiet -r docs/requirements.txt
git fetch origin gh-pages --depth=1 && git branch gh-pages origin/gh-pages 2>/dev/null || true
if echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  mike deploy --push --update-aliases "$TAG" latest
  mike set-default --push latest
  echo "docs.visiban.com updated — $TAG published as 'latest'"
else
  mike deploy --push --update-aliases "$TAG" next
  mike set-default --push next
  echo "docs.visiban.com updated — $TAG published as 'next'"
fi

echo ""
echo "Done. Release $TAG is live."
