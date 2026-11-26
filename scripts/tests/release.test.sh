#!/usr/bin/env bash
# scripts/tests/release.test.sh
#
# Unit test for scripts/release.sh — specifically the CHANGELOG rotation and
# already-published guard, which are pure functions the script exposes via
# `--self-test` (see scripts/release.sh's own self-test cases for the
# regression coverage: the orphan `---` divider left by the old two-step
# sed-rename + awk-prepend rotation, cleaned up in CHANGELOG.md's 1.0.0 and
# 1.1.0 sections — #<see MR>).
#
# This file covers what `--self-test` cannot: the command-line surface (usage
# error, invalid semver rejection) that a `bash -n` syntax check alone would
# miss, the version-consistency rollback, and an end-to-end run through the
# merge and tag steps against stubbed `glab` and a local bare origin (#1822).
#
# Run: bash scripts/tests/release.test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/release.sh"
[ -f "$SCRIPT" ] || { echo "FAIL: $SCRIPT not found"; exit 1; }

fail=0
pass=0
check() { # <desc> <rc>
  if [ "$2" -eq 0 ]; then pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# The script's own --self-test proves rotate_changelog and refuse_if_published
# against their known regression cases.
set +e
OUT="$(bash "$SCRIPT" --self-test 2>&1)"
RC=$?
set -e
check "release.sh --self-test passes" "$RC"
if ! grep -q "release: self-test passed." <<<"$OUT"; then
  echo "  FAIL: self-test did not report success"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
else
  pass=$((pass + 1))
fi

# No version argument → usage error, not a bare crash.
set +e
OUT="$(bash "$SCRIPT" 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -qi "usage" <<<"$OUT"; then pass=$((pass + 1)); else
  echo "  FAIL: missing version argument should print usage and exit non-zero (rc=$RC)"
  fail=$((fail + 1))
fi

# --summary-file with no path is a usage error before anything mutates (#1995).
set +e
OUT="$(cd "$REPO_ROOT" && bash "$SCRIPT" 1.2.0 --summary-file 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -q "needs a path" <<<"$OUT"; then pass=$((pass + 1)); else
  echo "  FAIL: --summary-file without a path should be rejected (rc=$RC)"
  fail=$((fail + 1))
fi

# Invalid semver is rejected before anything mutates the working tree.
set +e
OUT="$(cd "$REPO_ROOT" && bash "$SCRIPT" not-a-version 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -qi "not valid semver" <<<"$OUT"; then pass=$((pass + 1)); else
  echo "  FAIL: invalid semver should be rejected (rc=$RC)"
  fail=$((fail + 1))
fi


# Version-consistency checks must fail closed (#1269): a broken check must
# exit non-zero BEFORE any commit/push/tag, and must leave the working tree
# fully rolled back (git reset --hard / checkout main / release branch
# deleted) rather than partially mutated. Exercised against an isolated local
# clone of this repo so the real branch/commit/rollback machinery runs for
# real without touching this checkout or any real remote — `origin` on the
# clone is this on-disk repo, not GitLab, so nothing here reaches the network.
# Hermetic fixture repos. release.sh runs `git checkout main` and `git pull origin main`, so
# every fixture needs a local `main` AND an origin that has one. CI checks out a detached HEAD
# with no local `main`, so cloning REPO_ROOT directly only worked where a developer had one.
# FIXTURE_SRC is a private copy of the checked-out commit with `main` pointing at it; each
# fixture clones that, never the real checkout.
FIXTURE_SRC="$(mktemp -d)"
git clone --quiet "$REPO_ROOT" "$FIXTURE_SRC/src"
git -C "$FIXTURE_SRC/src" checkout --quiet -B main "$(git -C "$REPO_ROOT" rev-parse HEAD)"
make_fixture() { # <dest-parent>
  git clone --quiet --branch main "$FIXTURE_SRC/src" "$1/repo"
}

TMPCLONE="$(mktemp -d)"
make_fixture "$TMPCLONE"
(
  cd "$TMPCLONE/repo"
  # Simulate bump_chart_app_version's anchor (`^appVersion: `) silently no
  # longer matching a future Chart.yaml reformat — the exact failure mode
  # #1269 is guarding against — by quoting the key so the line no longer
  # starts with `appVersion: `.
  sed -i.bak 's/^appVersion: /"appVersion": /' helm/visiban/Chart.yaml
  rm -f helm/visiban/Chart.yaml.bak
  # Hermetic changelog state (#1640): the fixture inherits the real repo's
  # changelog.d/ and CHANGELOG.md, and right after a release main has no
  # fragments and an empty [Unreleased]. release.sh then dies at its
  # empty-[Unreleased] guard before ever reaching the version-consistency
  # check, so this test passed or failed depending on whether anyone had
  # merged a fragment since the last release. Seed one so [Unreleased]
  # assembles non-empty regardless. No dots in the slug (assembly rejects them).
  #
  # Start from the exact post-release state first (no fragments, empty
  # [Unreleased]) so CI exercises the zero-fragment case on every run; without
  # this, the seed below could be removed and the test would still pass
  # whenever the real repo happens to carry fragments.
  for f in changelog.d/*.md; do
    [ -e "$f" ] || continue
    [ "$(basename "$f")" = "README.md" ] && continue
    git rm -q "$f"
  done
  awk '/^## \[Unreleased\]/{print; print ""; print "---"; print ""; skip=1; next}
       skip && /^## \[/{skip=0}
       !skip{print}' CHANGELOG.md > CHANGELOG.md.new && mv CHANGELOG.md.new CHANGELOG.md
  mkdir -p changelog.d
  echo "Release self-test fixture entry." > changelog.d/release-test-fixture.fixed.md
  git add changelog.d/release-test-fixture.fixed.md
  git -c user.email=t@t -c user.name=t commit -aqm "test: break appVersion anchor"
)
set +e
OUT="$(cd "$TMPCLONE/repo" && RELEASE_SKIP_LATEST_CHECK=1 RELEASE_SKIP_CHART_VERSION_CHECK=1 RELEASE_ASSUME_YES=1 bash scripts/release.sh 9.9.9-test.1 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -q "version consistency check(s) failed" <<<"$OUT"; then
  pass=$((pass + 1))
else
  echo "  FAIL: a broken version-consistency check should exit non-zero and report why (rc=$RC)"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
fi

# No commit was made and the release branch was rolled back: back on main,
# the release branch is gone, and the working tree is clean — not left with
# the file rewrites this run made (Chart.yaml, .env.example, etc.) sitting
# uncommitted for the operator to clean up by hand.
STRAY_BRANCH=$(cd "$TMPCLONE/repo" && git branch --list "chore/release-9.9.9-test.1")
CURRENT_BRANCH=$(cd "$TMPCLONE/repo" && git branch --show-current)
DIRTY=$(cd "$TMPCLONE/repo" && git status --porcelain)
if [ -z "$STRAY_BRANCH" ] && [ "$CURRENT_BRANCH" = "main" ] && [ -z "$DIRTY" ]; then
  pass=$((pass + 1))
else
  echo "  FAIL: a failed version-consistency check should roll the release branch back completely (stray branch='${STRAY_BRANCH}' current branch='${CURRENT_BRANCH}' dirty='${DIRTY}')"
  fail=$((fail + 1))
fi
rm -rf "$TMPCLONE"

# Pre-tag :latest-intent announcement (classify-release-tag.sh wiring, added
# after the 2026-10 backend:latest/frontend:latest-tracking-a-pre-release
# incident): printed before anything is tagged or pushed, so it must appear
# before even the "tag already exists" guard. Using a tag that already
# exists stops the script immediately afterward with no network calls.
TMPCLONE2="$(mktemp -d)"
make_fixture "$TMPCLONE2"
(
  cd "$TMPCLONE2/repo"
  git -c user.email=t@t -c user.name=t tag v9.9.9
  git -c user.email=t@t -c user.name=t tag v9.9.9-rc.1
)

set +e
OUT="$(cd "$TMPCLONE2/repo" && bash scripts/release.sh 9.9.9 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -q "This is a STABLE release" <<<"$OUT" && grep -q "tag v9.9.9 already exists" <<<"$OUT"; then
  pass=$((pass + 1))
else
  echo "  FAIL: a stable version should print the STABLE pre-tag announcement before the tag-exists guard stops it"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
fi

set +e
OUT="$(cd "$TMPCLONE2/repo" && bash scripts/release.sh 9.9.9-rc.1 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ] && grep -q "This is a PRE-RELEASE" <<<"$OUT" && grep -q "tag v9.9.9-rc.1 already exists" <<<"$OUT"; then
  pass=$((pass + 1))
else
  echo "  FAIL: a pre-release version should print the PRE-RELEASE pre-tag announcement before the tag-exists guard stops it"
  echo "${OUT}" | sed 's/^/    /'
  fail=$((fail + 1))
fi
rm -rf "$TMPCLONE2"

# ─── End to end through the merge and tag steps (#1822) ──────────────────────
#
# release.sh pushes, merges, tags and publishes, so each run here is sealed off:
#   - `origin` is a local bare repo, and GIT_ALLOW_PROTOCOL=file makes git itself
#     refuse any other transport;
#   - `env -i` drops tokens, RELEASE_* leftovers and the operator's git/glab config;
#   - glab/gh/curl/... are stubs first on PATH that record any unexpected call;
#   - `sleep` is a no-op stub, so a broken poll loop runs out at once instead of
#     taking 30 minutes, and release.sh needs no interval hook for the test's sake.
E2E_VERSION="9.9.9-rc.1"
E2E_TAG="v${E2E_VERSION}"
E2E_BRANCH="chore/release-${E2E_VERSION}"

# make_e2e <scenario> <release.sh to run>  — builds $E2E (stubs, bare origin, clone).
#   merged        MR already merged; another commit landed on main after it
#   merge-fails   `glab mr merge` fails and the MR stays open
#   bad-sha       MR reports a merge commit that is not in main's history
make_e2e() {
  E2E="$(mktemp -d)"
  mkdir -p "$E2E/bin" "$E2E/home" "$E2E/state"
  echo "$1" > "$E2E/state/scenario"

  cat > "$E2E/bin/glab" <<'STUB'
#!/usr/bin/env bash
st="$E2E_STATE"; origin="$E2E_ORIGIN"
scenario="$(cat "$st/scenario")"
echo "glab $*" >> "$st/calls"
case "$1 ${2:-}" in
  "mr create")
    # What GitLab would do: merge the pushed branch, then let another merge land on
    # top, so the merge commit and the post-pull HEAD differ.
    g() { git --git-dir="$origin" -c user.email=t@t -c user.name=t "$@"; }
    if [[ "$scenario" != "merge-fails" ]]; then
      rel="$(g rev-parse "refs/heads/$E2E_BRANCH")" || exit 1
      base="$(g rev-parse refs/heads/main)"
      merge="$(g commit-tree "$rel^{tree}" -p "$base" -p "$rel" -m merge)"
      later="$(g commit-tree "$merge^{tree}" -p "$merge" -m "another merge")"
      g update-ref refs/heads/main "$later"
      echo "$merge" > "$st/merge_sha"
      echo "$later" > "$st/later_sha"
    fi
    echo "https://gitlab.invalid/x/y/-/merge_requests/4242"
    ;;
  "api projects/:id/merge_requests/4242")
    case "$scenario" in
      merged)      state=merged; sha="\"$(cat "$st/merge_sha")\"" ;;
      bad-sha)     state=merged; sha='"0123456789012345678901234567890123456789"' ;;
      merge-fails) state=opened; sha=null ;;
    esac
    printf '{"state":"%s","merge_commit_sha":%s,"head_pipeline":{"status":"success"}}\n' "$state" "$sha"
    ;;
  "api projects/:id/pipelines?sha="*)
    # Only the merge commit has a green pipeline; asking about any other commit fails.
    if [[ "$2" == "projects/:id/pipelines?sha=$(cat "$st/merge_sha" 2>/dev/null)&per_page=1" ]]; then
      echo '[{"status":"success"}]'
    else
      echo '[{"status":"failed"}]'
    fi
    ;;
  "mr merge") exit 1 ;;
  "mr view")
    if [[ "$scenario" == "merge-fails" ]]; then printf 'state:\topen\n'; else printf 'state:\tmerged\n'; fi
    ;;
  "release create") : ;;
  *) echo "glab $*" >> "$st/unexpected"; exit 97 ;;
esac
STUB
  local tool
  for tool in gh curl wget docker crane helm kubectl ssh cosign; do
    printf '%s\n' '#!/usr/bin/env bash' "echo \"$tool \$*\" >> \"\$E2E_STATE/unexpected\"" 'exit 97' > "$E2E/bin/$tool"
  done
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$E2E/bin/sleep"
  chmod +x "$E2E"/bin/*

  git clone --quiet --bare "$FIXTURE_SRC/src" "$E2E/origin.git"
  git clone --quiet --branch main "$E2E/origin.git" "$E2E/repo"
  (
    cd "$E2E/repo"
    git config user.email t@t
    git config user.name t
    git config commit.gpgsign false
    # The script under test is the working-tree one (or a mutated copy), not HEAD's.
    cp "$2" scripts/release.sh
    # Doc-content drift is check-docs-version-accuracy's own job; not under test here.
    printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > scripts/check-docs-version-accuracy.sh
    # One fragment so [Unreleased] is never empty, whatever the real repo carries (#1640).
    mkdir -p changelog.d
    echo "Release end-to-end fixture entry." > changelog.d/release-test-fixture.fixed.md
    git add scripts changelog.d
    git commit -qm "test: end-to-end fixture"
    git push -q origin main
  )
}

# run_e2e — runs release.sh in $E2E; sets E2E_RC and E2E_OUT. Refuses to start unless
# every networked tool resolves to a stub and origin is the local bare repo.
run_e2e() {
  local path="$E2E/bin:$PATH" tool
  for tool in glab gh curl wget docker crane helm kubectl ssh cosign sleep; do
    if [ "$(PATH="$path" bash -c "command -v $tool")" != "$E2E/bin/$tool" ]; then
      echo "FAIL: $tool does not resolve to its stub; refusing to run release.sh"; exit 1
    fi
  done
  if [ "$(git -C "$E2E/repo" remote)" != "origin" ] \
     || [ "$(git -C "$E2E/repo" remote get-url --push origin)" != "$E2E/origin.git" ]; then
    echo "FAIL: fixture origin is not the local bare repo; refusing to run release.sh"; exit 1
  fi
  set +e
  E2E_OUT="$(cd "$E2E/repo" && env -i PATH="$path" HOME="$E2E/home" TMPDIR="${TMPDIR:-/tmp}" \
    GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 \
    E2E_STATE="$E2E/state" E2E_ORIGIN="$E2E/origin.git" E2E_BRANCH="$E2E_BRANCH" \
    RELEASE_ASSUME_YES=1 RELEASE_SKIP_LATEST_CHECK=1 RELEASE_SKIP_CHART_VERSION_CHECK=1 \
    bash scripts/release.sh "$E2E_VERSION" 2>&1)"
  E2E_RC=$?
  set -e
}

origin_tag() { git --git-dir="$E2E/origin.git" rev-parse -q --verify "refs/tags/${E2E_TAG}" || true; }

e2e_fail() { # <desc>
  echo "  FAIL: $1 (rc=$E2E_RC)"
  echo "${E2E_OUT}" | sed 's/^/    /'
  sed 's/^/    call: /' "$E2E/state/calls" 2>/dev/null | head -20 || true
  sed 's/^/    unexpected: /' "$E2E/state/unexpected" 2>/dev/null | head -20 || true
  fail=$((fail + 1))
}

# Already merged, HEAD has moved on: exit 0, and the tag is the MR's merge commit.
make_e2e merged "$SCRIPT"
run_e2e
MERGE="$(cat "$E2E/state/merge_sha" 2>/dev/null || true)"
HEAD_AFTER="$(git -C "$E2E/repo" rev-parse HEAD)"
if [ "$E2E_RC" -eq 0 ] && [ -n "$MERGE" ] && [ "$MERGE" != "$HEAD_AFTER" ] \
   && [ "$HEAD_AFTER" = "$(cat "$E2E/state/later_sha")" ] \
   && [ "$(origin_tag)" = "$MERGE" ] \
   && grep -q "^glab release create ${E2E_TAG} " "$E2E/state/calls" \
   && ! grep -q "^glab mr merge" "$E2E/state/calls" \
   && [ ! -e "$E2E/state/unexpected" ]; then
  pass=$((pass + 1))
else
  e2e_fail "an already-merged MR should release, tagging merge_commit_sha ${MERGE} not HEAD ${HEAD_AFTER} (tag='$(origin_tag)')"
fi
rm -rf "$E2E"

# The merge fails and the MR stays open: stop at the merge step, publish nothing.
make_e2e merge-fails "$SCRIPT"
run_e2e
if [ "$E2E_RC" -ne 0 ] && grep -q "'glab mr merge 4242' failed" <<<"$E2E_OUT" \
   && ! grep -q "Waiting for merge to complete" <<<"$E2E_OUT" \
   && [ -z "$(origin_tag)" ] && ! grep -q "^glab release" "$E2E/state/calls" \
   && [ ! -e "$E2E/state/unexpected" ]; then
  pass=$((pass + 1))
else
  e2e_fail "a failed merge should stop the release at the merge step with no tag"
fi
rm -rf "$E2E"

# The merge commit is not on main: stop before the main-pipeline gate, publish nothing.
make_e2e bad-sha "$SCRIPT"
run_e2e
if [ "$E2E_RC" -ne 0 ] && grep -q "is not in local main's history" <<<"$E2E_OUT" \
   && ! grep -q "Confirming main's own pipeline" <<<"$E2E_OUT" \
   && [ -z "$(origin_tag)" ] && ! grep -q "^glab release" "$E2E/state/calls" \
   && [ ! -e "$E2E/state/unexpected" ]; then
  pass=$((pass + 1))
else
  e2e_fail "an unverifiable merge commit should stop the release with no tag"
fi
rm -rf "$E2E"

# ─── Mutations: the cases above must be able to fail (#1822) ─────────────────
MUT="$(mktemp -d)"

# mutate <exact line> <replacement> <out> — mutates $SCRIPT into <out>; fails unless exactly one line changed,
# so a reworded release.sh cannot leave a mutation case passing vacuously.
mutate() {
  OLD="$1" NEW="$2" awk '$0 == ENVIRON["OLD"] { print ENVIRON["NEW"]; n++; next } { print } END { exit n != 1 }' \
    "$SCRIPT" > "$3"
}

# Tagging HEAD instead of the merge commit must move the tag, which the first case asserts.
if mutate 'git tag "$TAG" "$MERGE_SHA"' 'git tag "$TAG"' "$MUT/tag-head.sh"; then
  make_e2e merged "$MUT/tag-head.sh"
  run_e2e
  if [ "$E2E_RC" -eq 0 ] && [ "$(origin_tag)" = "$(cat "$E2E/state/later_sha")" ]; then
    pass=$((pass + 1))
  else
    e2e_fail "tagging HEAD should be visible as a tag on the later commit (tag='$(origin_tag)')"
  fi
  rm -rf "$E2E"
else
  echo "  FAIL: tag-HEAD mutation did not apply; update it to match release.sh"; fail=$((fail + 1))
fi

# Dropping either `|| exit 1` changes no behavior under errexit, so --self-test's
# wiring check is what has to catch it. One run with both removed: each has its own
# failure line. It runs from a fixture clone, where its sibling scripts and
# .gitlab-ci.yml resolve; the no-op `sleep` skips the self-test's retry back-off.
git clone --quiet --branch main "$FIXTURE_SRC/src" "$MUT/repo"
cp "$REPO_ROOT"/scripts/*.sh "$MUT/repo/scripts/"
cp "$REPO_ROOT/.gitlab-ci.yml" "$MUT/repo/"
mkdir -p "$MUT/bin"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$MUT/bin/sleep"
chmod +x "$MUT/bin/sleep"
if mutate 'merge_release_mr "$MR_NUM" || exit 1' 'merge_release_mr "$MR_NUM"' "$MUT/m1.sh" \
   && SCRIPT="$MUT/m1.sh" mutate 'MERGE_SHA=$(resolve_mr_merge_sha "$MR_NUM") || exit 1' \
        'MERGE_SHA=$(resolve_mr_merge_sha "$MR_NUM")' "$MUT/repo/scripts/release.sh"; then
  set +e
  OUT="$(cd "$MUT/repo" && PATH="$MUT/bin:$PATH" bash scripts/release.sh --self-test 2>&1)"
  RC=$?
  set -e
  for label in "a failed release-MR merge stops the release" "an unresolved merge commit stops the release"; do
    if [ "$RC" -ne 0 ] && grep -qF "SELF-TEST FAILED: wiring: $label" <<<"$OUT"; then
      pass=$((pass + 1))
    else
      echo "  FAIL: --self-test should report 'wiring: $label' with that '|| exit 1' removed (rc=$RC)"
      grep 'SELF-TEST FAILED' <<<"$OUT" | sed 's/^/    /' || true
      fail=$((fail + 1))
    fi
  done
else
  echo "  FAIL: '|| exit 1' mutations did not apply; update them to match release.sh"; fail=$((fail + 1))
fi
rm -rf "$MUT" "$FIXTURE_SRC"

echo "release.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
