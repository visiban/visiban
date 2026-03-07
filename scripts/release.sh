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

# Must be on main, clean working tree
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main (currently on $BRANCH)" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree is not clean" >&2
  exit 1
fi

git pull origin main

# Check tag doesn't already exist
if git tag | grep -q "^${TAG}$"; then
  echo "Error: tag $TAG already exists" >&2
  exit 1
fi

# Update .env.example
sed -i '' "s/^APP_VERSION=.*/APP_VERSION=${VERSION}/" .env.example

# Update docker-compose.yml (hardcoded value, not the :-dev fallback line)
# Only replace if there's already a hardcoded value; skip if it's the ${APP_VERSION:-dev} form
if grep -q "APP_VERSION: [^$]" docker-compose.yml; then
  sed -i '' "s/APP_VERSION: .*/APP_VERSION: ${VERSION}/" docker-compose.yml
fi

# Rotate CHANGELOG: rename [Unreleased] → [v{VERSION}] and prepend a fresh [Unreleased]
if ! grep -q "## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no [Unreleased] section" >&2
  exit 1
fi

# Extract the unreleased notes (everything between [Unreleased] header and next ## heading)
RELEASE_NOTES=$(awk '/^## \[Unreleased\]/{found=1; next} found && /^## \[/{exit} found{print}' CHANGELOG.md \
  | sed '/^[[:space:]]*$/d' | sed '/^---[[:space:]]*$/d')

sed -i '' "s/## \[Unreleased\]/## [${TAG}] — ${TODAY}/" CHANGELOG.md

# Prepend fresh [Unreleased] block
TMP=$(mktemp)
awk -v tag="$TAG" -v date="$TODAY" '
  /^## \[v/ && !done {
    print "## [Unreleased]\n"
    print "---\n"
    done=1
  }
  { print }
' CHANGELOG.md > "$TMP" && mv "$TMP" CHANGELOG.md

echo "Updated .env.example, docker-compose.yml, CHANGELOG.md"

# Commit and tag
git add CHANGELOG.md .env.example docker-compose.yml
git commit -m "chore: release ${TAG}"
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo "Pushed commit and tag $TAG"

# Create GitLab release
if [[ -z "$RELEASE_NOTES" ]]; then
  RELEASE_NOTES="See CHANGELOG.md for details."
fi

glab release create "$TAG" --name "$TAG" --notes "$RELEASE_NOTES"

echo ""
echo "Done. Release $TAG is live."
