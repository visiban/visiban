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

echo "Updated .env.example, docker-compose.yml, frontend/package.json, CHANGELOG.md"

# Commit and push branch
git add CHANGELOG.md .env.example docker-compose.yml frontend/package.json
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

# Create GitLab release
if [[ -z "$RELEASE_NOTES" ]]; then
  RELEASE_NOTES="See CHANGELOG.md for details."
fi

glab release create "$TAG" --name "$TAG" --notes "$RELEASE_NOTES"

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
