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

# Commit and push branch
git add CHANGELOG.md .env.example docker-compose.yml
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

# Wait for the docs-deploy job to complete on the tag pipeline
echo "Waiting for docs-deploy CI job..."
TAG_PIPELINE_ID=""
for i in $(seq 1 12); do
  TAG_PIPELINE_ID=$(glab api "projects/${CI_PROJECT_ID:-$(glab api projects/visiban%2Fvisiban | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')}/pipelines?ref=${TAG}&order_by=id&sort=desc&per_page=1" 2>/dev/null \
    | python3 -c 'import sys,json; p=json.load(sys.stdin); print(p[0]["id"]) if p else print("")' 2>/dev/null || true)
  if [[ -n "$TAG_PIPELINE_ID" ]]; then
    break
  fi
  sleep 5
done

DOCS_STATUS="unknown"
if [[ -n "$TAG_PIPELINE_ID" ]]; then
  for i in $(seq 1 40); do
    DOCS_STATUS=$(glab api "projects/visiban%2Fvisiban/pipelines/${TAG_PIPELINE_ID}/jobs" 2>/dev/null \
      | python3 -c 'import sys,json; jobs=[j for j in json.load(sys.stdin) if j["name"]=="docs-deploy"]; print(jobs[0]["status"] if jobs else "not_found")' 2>/dev/null || echo "unknown")
    if [[ "$DOCS_STATUS" == "success" ]]; then
      echo "docs-deploy: success — docs.visiban.com will update in ~1 min"
      break
    elif [[ "$DOCS_STATUS" == "failed" || "$DOCS_STATUS" == "canceled" ]]; then
      echo "Warning: docs-deploy job $DOCS_STATUS on pipeline $TAG_PIPELINE_ID" >&2
      echo "To redeploy manually: CI/CD → Run pipeline on main, set DOCS_VERSION=${TAG}" >&2
      break
    fi
    sleep 15
  done
  if [[ "$DOCS_STATUS" != "success" && "$DOCS_STATUS" != "failed" && "$DOCS_STATUS" != "canceled" ]]; then
    echo "Note: docs-deploy still running or not found (pipeline $TAG_PIPELINE_ID). Check CI for status." >&2
    echo "To redeploy manually if needed: CI/CD → Run pipeline on main, set DOCS_VERSION=${TAG}" >&2
  fi
else
  echo "Note: could not find tag pipeline — docs-deploy may still be queued. Check CI." >&2
  echo "To redeploy manually if needed: CI/CD → Run pipeline on main, set DOCS_VERSION=${TAG}" >&2
fi

echo ""
echo "Done. Release $TAG is live."
