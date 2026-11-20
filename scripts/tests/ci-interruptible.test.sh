#!/usr/bin/env bash
# Guards the auto-cancel policy in .gitlab-ci.yml (#2419, #2421).
#
# `default: interruptible: true` lets a newer commit cancel a superseded
# pipeline's read-only jobs. A job with an external side effect (registry,
# chart, docs, GitHub release, branch deletion, issue filing, SonarCloud
# upload, demo seeding) must never be canceled mid-run, so it has to override
# that default with `interruptible: false`. This test fails when:
#   1. `default:` stops being interruptible (the policy silently reverts), or
#   2. a known side-effecting or scheduled-only long job resolves to
#      interruptible (its override was dropped or its template changed), or
#   3. any job whose script pushes/publishes (heuristic markers below) resolves
#      to interruptible, which catches a new publishing job added without the
#      override.
# `interruptible` is resolved the way GitLab does: the job's own key, then its
# `extends:` templates (later entries win) and `<<: *anchor` merges, then
# `default:`. Plain python3 (no PyYAML) so it runs in the alpine script-tests job.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CI="${ROOT}/.gitlab-ci.yml"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/check.py" <<'PY'
import re
import sys

REQUIRED_FALSE = [
    # publish / external side effect
    "backend-docker-push", "frontend-docker-push",
    "backend-docker-push-arm64", "frontend-docker-push-arm64",
    "backend-manifest", "frontend-manifest",
    "backend-image-attest", "frontend-image-attest", "image-attest-backfill",
    "helm-publish", "github-release", "docs-deploy", "pages",
    "cleanup-merged-branches", "seed-demo-data", "kaizen-yield-watch", "sonar:scan",
    # docs-deploy's only need on main; must not be canceled out from under it
    "release-main-pipeline-guard",
    # scheduled-only long jobs a merge must not cancel
    "backend-mutation", "backend-mutation-report", "nightly-load-test",
    "backend-schema-fuzz-deep",
    # kind/dind drills: a canceled job would leak a half-provisioned cluster
    "helm-install", "helm-netpol", "compose-prod-drill",
]
# Script markers of an external write. Comment lines are ignored.
PUBLISH_MARKERS = re.compile(
    r"--destination[= ]|helm push|git push|cosign (sign|attest)|--file-issues|"
    r"sonar-scanner|manifest-tool .*push|crane (copy|cp|tag)|"
    r"gh release|mike deploy|glab (api|release|issue|mr)|"
    r"curl\b.*(-X|--request)[ =]*(POST|PUT|PATCH|DELETE)|release-cli|kubectl (apply|delete)"
)

text = open(sys.argv[1]).read().split("\n")
blocks, anchors, order = {}, {}, []
cur = None
for line in text:
    m = re.match(r"^([A-Za-z0-9_.:\"-]+):(?:\s*&(\S+))?\s*(#.*)?$", line)
    if m:
        cur = m.group(1).strip('"')
        blocks[cur] = []
        order.append(cur)
        if m.group(2):
            anchors[m.group(2)] = cur
        continue
    if cur is not None and line and not line.startswith((" ", "#")):
        cur = None  # a non-key top-level line ends the block
    if cur is not None:
        blocks[cur].append(line)


def own(name):
    for line in blocks.get(name, []):
        m = re.match(r"^  interruptible:\s*(true|false)\b", line)
        if m:
            return m.group(1) == "true"
    return None


def parents(name):
    out = []
    for line in blocks.get(name, []):
        m = re.match(r"^  <<:\s*\*(\S+)", line)
        if m and m.group(1) in anchors:
            out.append(anchors[m.group(1)])
        m = re.match(r"^  extends:\s*(.+?)\s*(#.*)?$", line)
        if m:
            val = m.group(1).strip("[]")
            out.extend(p.strip().strip("'\"") for p in val.split(",") if p.strip())
    return out


def resolve(name, seen=()):
    v = own(name)
    if v is not None:
        return v
    for parent in reversed(parents(name)):  # later extends entries win
        if parent in seen:
            continue
        r = resolve(parent, seen + (name,))
        if r is not None:
            return r
    return None


def body(name, seen=()):
    lines = [l for l in blocks.get(name, []) if not l.lstrip().startswith("#")]
    for parent in parents(name):
        if parent not in seen:
            lines += body(parent, seen + (name,))
    return lines


problems = []
default = own("default")
if default is not True:
    problems.append(f"default: interruptible must be true (got {default})")

def effective(name):
    v = resolve(name)
    return default if v is None else v

for job in REQUIRED_FALSE:
    if job not in blocks:
        problems.append(f"{job}: listed as side-effecting but not found in the CI file; update this test")
    elif effective(job):
        problems.append(f"{job}: has an external side effect but resolves to interruptible: true")

for job in order:
    if job.startswith(".") or job in ("default", "workflow", "variables", "stages", "include"):
        continue
    hit = next((l.strip() for l in body(job) if PUBLISH_MARKERS.search(l)), None)
    if hit and effective(job):
        problems.append(f"{job}: script publishes ({hit[:80]!r}) but resolves to interruptible: true")

for p in problems:
    print(f"FAIL: {p}")
sys.exit(1 if problems else 0)
PY

fail=0
pass_case() { if python3 "$WORK/check.py" "$2" >"$WORK/out" 2>&1; then echo "ok - $1"; else echo "not ok - $1"; cat "$WORK/out"; fail=1; fi; }
fail_case() {
  if python3 "$WORK/check.py" "$2" >"$WORK/out" 2>&1; then echo "not ok - $1 (expected a failure)"; fail=1
  elif grep -q -- "$3" "$WORK/out"; then echo "ok - $1"
  else echo "not ok - $1 (wrong failure)"; cat "$WORK/out"; fail=1; fi
}

pass_case "repository .gitlab-ci.yml keeps every side-effecting job non-interruptible" "$CI"

# docs-deploy loses its override.
awk 'p && /^  interruptible: false/ {p=0; next} /^docs-deploy:/ {p=1} {print}' "$CI" > "$WORK/no-docs.yml"
fail_case "dropped override on docs-deploy is caught" "$WORK/no-docs.yml" "docs-deploy: has an external side effect"

# A template override dropped: the push jobs inherit from .kaniko-push-common.
awk 'p && /^  interruptible: false/ {p=0; next} /^\.kaniko-push-common:/ {p=1} {print}' "$CI" > "$WORK/no-kaniko.yml"
fail_case "dropped override on an extends: template is caught" "$WORK/no-kaniko.yml" "backend-docker-push: has an external side effect"

# The policy reverts at the default.
sed 's/^  interruptible: true$/  interruptible: false/' "$CI" > "$WORK/default-false.yml"
fail_case "default: interruptible: false is caught" "$WORK/default-false.yml" "default: interruptible must be true"

# A new publishing job added without the override.
{ cat "$CI"; printf '\nnew-publisher:\n  stage: deploy\n  script:\n    - /kaniko/executor --destination=registry.example/x:y\n'; } > "$WORK/new-job.yml"
fail_case "new publishing job without the override is caught" "$WORK/new-job.yml" "new-publisher: script publishes"

# ...and passes once it opts out.
{ cat "$CI"; printf '\nnew-publisher:\n  stage: deploy\n  interruptible: false\n  script:\n    - /kaniko/executor --destination=registry.example/x:y\n'; } > "$WORK/new-job-ok.yml"
pass_case "new publishing job with interruptible: false passes" "$WORK/new-job-ok.yml"

# A job using a newer publish shape (gh release) without the override.
{ cat "$CI"; printf '\nnew-releaser:\n  stage: deploy\n  script:\n    - gh release create v0 --notes x\n'; } > "$WORK/new-gh.yml"
fail_case "new gh release job without the override is caught" "$WORK/new-gh.yml" "new-releaser: script publishes"

{ cat "$CI"; printf '\nnew-releaser:\n  stage: deploy\n  interruptible: false\n  script:\n    - gh release create v0 --notes x\n'; } > "$WORK/new-gh-ok.yml"
pass_case "new gh release job with interruptible: false passes" "$WORK/new-gh-ok.yml"

exit "$fail"
