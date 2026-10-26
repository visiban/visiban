---
name: release
description: Create a Visiban release with version bumps, changelog rotation, and docs deployment.
disable-model-invocation: true
argument-hint: "[version string, e.g. 1.2.0]"
---

# Release

You are creating a release for Visiban. Follow these steps exactly — the release script handles the git, MR, pipeline, tagging, and docs deployment automatically. Do not attempt to replicate what the script does manually.

## Step 0 — Get the version string

If not provided in `$ARGUMENTS`, determine it:

1. Read `CHANGELOG.md [Unreleased]` and the git log since the last tag
2. Apply these rules:
   - **PATCH** — only `### Fixed` entries → e.g. `0.1.1`
   - **MINOR** — any `### Added` entries → e.g. `0.2.0`
   - **MAJOR** — any breaking change (removed/renamed API endpoints, changed auth flows, destructive migrations, incompatible config changes) → e.g. `1.0.0`
   - **Pre-release** — keep the same base version, increment suffix → e.g. `0.2.0-beta.1` → `0.2.0-beta.2`
   - When in doubt between MINOR and MAJOR, prefer MINOR and call it out explicitly
3. Present the suggestion with a one-line rationale and ask the user to confirm before proceeding

### Valid version format
- Stable: `MAJOR.MINOR.PATCH` (e.g. `1.2.3`)
- Pre-release: `MAJOR.MINOR.PATCH-<stage>.N` (e.g. `1.2.3-rc.1`)
- Valid stages in ascending order: `alpha` → `beta` → `rc`
- Pre-release suffix must include a numeric component (`rc.1` not `rc`)

### Stage definitions

The ordering above has existed since the version regex was written, but no
release ever used `beta` — 1.0 and 1.1 both went straight from nothing to
`rc.1`. 1.2 is the first cycle to use `alpha`. Each stage has a specific entry
gate and meaning; don't advance a build to the next stage name without it
meeting the gate:

| Stage | Entry gate | Meaning |
|---|---|---|
| `alpha` | (none — this is where active development lives) | Active development. The milestone's `release::committed` issue tracker is still open and/or its named GA-blocker features are still being built. Breaking changes are possible between alphas. "Expect bugs." |
| `beta` | All `release::committed` issues for the milestone are closed **and** every feature named as a GA blocker in the milestone description is merged to `main` | Feature-complete for the milestone's committed scope. No new scope lands in a beta — only bugfixes against what's already there. Safe-ish for self-hosters to trial on non-production instances. |
| `rc` | The beta build has been run through `/pre-release full` with every 🔴 blocking finding resolved | Release candidate. Only regression fixes from here; the next green build ships as GA. |
| GA (stable) | `rc` pipeline green, no new 🔴 finding since the last `/pre-release full`, and (GA tags only) no open `security::deferred` issue in any milestone without a valid accepted-risk note — re-checked by `release.sh` right before the tag | Stable release. |

A milestone can skip `alpha` and/or `beta` and cut straight to `rc` if the
committed tracker and GA-blocker list are already clean when cutting the first
pre-release build — that's what 1.0 and 1.1 did. Don't skip a stage's gate
retroactively just because a build already shipped under that label; fix the
label on the next cut instead.

## Step 1 — Pre-flight checks

Before running the script:
- [ ] Confirm all open MRs intended for this release are merged into `main`
- [ ] Confirm `CHANGELOG.md [Unreleased]` is up to date — if not, stop and update it first
- [ ] Confirm the working tree is clean (`git status`) and on `main` with latest pulled
- [ ] Run `make memory-check` (`scripts/check-memory-index.sh`) from the primary checkout to
      budget-check the local Claude Code memory store — fails if `MEMORY.md` exceeds its byte
      budget or an index entry (`[[wikilink]]`, `[text](file.md)`, bare `[file.md]`) points at a
      missing file; warns on files with no `description:` frontmatter or over the size-warning
      threshold. This is per-machine developer tooling, not a CI gate — see `CLAUDE.md`'s
      "Memory discipline" section for why it matters at a release boundary. If it fails, fix the
      index (restore or remove the dangling entry; trim `MEMORY.md` toward the archive) before
      proceeding — do not tag a release on top of a broken index.
- [ ] **Every credential the tag-triggered publish jobs need already exists.** Check
      `glab variable list` for `GHCR_USER`, `GHCR_TOKEN`, and `GH_TOKEN` (a masked value will
      not print, its existence will). A missing one fails **after** the tag is pushed, which is
      the one moment in this process when nothing can be un-done cheaply. If any is missing or
      its expiry is unknown, check `docs/maintainers/tokens-and-rotation.md` before proceeding.
- [ ] **`:latest` has not drifted off the newest stable release.** `scripts/release.sh` now runs
      `check-latest-tag-stability.sh` read-only before it branches (`check_latest_not_drifted`) and
      stops on a `MISMATCH`, printing the `docker buildx imagetools create` repair commands. Those
      commands write to the shared registry — get the user's explicit go-ahead before running them.
      `RELEASE_SKIP_LATEST_CHECK=1` bypasses the guard; note it inline if used.
- [ ] **No open `security::deferred` issue, in any milestone, lacks an accepted-risk note.**
      `scripts/release.sh` runs `scripts/check-security-deferred.sh` before it branches
      (`check_security_deferred_clear`) **for GA tags only — pre-releases (alpha/beta/rc) are not gated
      (a one-line note is printed) and `/pre-release full` still runs it** — the same query as `/pre-release` Step 1.5, so a deferral
      filed after the last `/pre-release full` is still caught. It scans all milestones (the gap
      ships from `main` whatever milestone the issue sits on) and fails closed: an API error is a
      blocker, not "0 issues". Fix or close the issue, or have a maintainer add an accepted-risk
      note (`docs/maintainers/security-deferred-label.md`). `RELEASE_SKIP_SECURITY_DEFERRED_CHECK=1`
      bypasses it; note it inline if used. Never quote a confidential issue's title in release text.
- [ ] **Inventory every tag-only job that changed since the last tag.** A tag pipeline runs the
      CI config as it stood at the tag commit, and jobs gated on `$CI_COMMIT_TAG` (the kaniko
      image push, the GitHub release job, the docs deploy) run nowhere else — a job edited since
      the previous `v*` tag has never run in its current form. List them:
      ```bash
      git diff "$(git describe --tags --abbrev=0 --match 'v*')"..HEAD -- .gitlab-ci.yml
      ```
      and read the hunks for anything whose `rules:` matches `$CI_COMMIT_TAG`. Report each
      changed one as **unproven until the tag** and watch it first in Step 3's verification.
- [ ] **Days and commits since the last `v*` tag.** If about four weeks, or several hundred
      non-merge commits, have passed without a tag, say so in the pre-flight summary — a cut
      that large carries untested publish-path changes and a large diff surface at once.
      Informational only; it does not block the cut.

## Step 1b — Documentation audit

For every entry in `CHANGELOG.md [Unreleased]`, verify documentation is in sync:

- **New features (`### Added`)** — each must have a corresponding page or section in `docs/features/` (or `docs/getting-started/` / `docs/administration/` where appropriate), with the correct version callout (`> **Added in X.Y**`) and enterprise callout if applicable — run `/docs` if anything is missing
- **API surface changes** — any new or modified endpoint must be reflected in `docs/api/` — run `/api-docs` if anything is missing
- **Changed behaviour (`### Changed`)** — existing doc pages must reflect the new behaviour; stale screenshots or descriptions must be updated
- **Breaking changes** — if any exist, ensure a migration or upgrade note is present in `docs/getting-started/` or a dedicated upgrade guide

Do not proceed to Step 2 until the docs audit is complete. A release with stale documentation is worse than no documentation — users will follow the wrong instructions.

## Step 1c — Show the release notes and get approval (the one pause the script itself enforces)

`scripts/release.sh` assembles `changelog.d/` and extracts the notes under `CHANGELOG.md`'s
`[Unreleased]` section — the text that becomes both the new dated CHANGELOG entry and the
GitLab Release page body — immediately after branching, before touching any other file. It
then gates on human approval (`confirm_release_notes`) before doing anything else, mirroring
TruePPM's release-summary gate: getting the version number right says nothing about whether
the prose describing it is still accurate.

### Step 1c-i — Classify the target and choose the baseline (before drafting anything)

A stable release's notes say what changed since the last *real* release, not just since the
last tag. After an alpha/beta/rc series, `[Unreleased]` holds only what merged since the final
rc, so a 1.1 operator would otherwise have to read every pre-release section to learn what the
new minor is (#1995). Classify the target from Step 0's version and state the result, with the
reason, to the user **before** drafting:

| Class | Test | Notes |
|---|---|---|
| Pre-release | version has `-alpha.N` / `-beta.N` / `-rc.N` | No roll-up. Notes cover what is new since the previous tag, exactly as before. Do not pass a summary file (the script refuses one). |
| Bug-fix-only patch | stable `X.Y.Z`, `Z > 0`, every change since the previous stable is `### Fixed` / `### Security` | No roll-up. Normal notes, exactly as before. |
| Feature release | stable and anything else: any minor/major (`X.Y.0`), or a patch that shipped `### Added` / `### Changed` features | Roll-up summary required. |

**Baseline** (feature release only): the most recent earlier *stable* release that was not
bug-fix-only. Read `git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname` (stable tags
only; skip anything with a `-` suffix) and each candidate's CHANGELOG section. Examples:
`1.2.0` after `1.1.0` and a bug-fix-only `1.1.1` has baseline `1.1.0`; `1.2.0` after a `1.1.1`
that shipped features has baseline `1.1.1`. Every CHANGELOG section between the baseline and
the target (`alpha.1` ... `rc.N`) is an input. Say which baseline you chose and why.

**Ask the user, never guess, when:**
1. you cannot tell whether this is a feature release that needs a roll-up (for example a patch
   with a mix of fixes and small additions);
2. the baseline is ambiguous (a stable tag whose CHANGELOG section is missing or whose type you
   cannot classify, or tags that do not line up with the CHANGELOG);
3. you are unsure whether an item is a major change or minutiae. Show the draft with each
   borderline item marked `[keep?]` or `[drop?]` and let the user move items.

### Step 1c-ii — Draft the roll-up summary (feature release only)

Build it from every CHANGELOG section between the baseline and the target, plus the
milestone or roadmap headline (`glab api` the milestone description; for 1.2 the themes are
replace the spreadsheet, see the work, ask your own agent, on the record). It contains only:

1. **Headline features**, grouped by the release's theme or roadmap headline.
2. **Action required**: every change an upgrader must act on (renamed config, refused values,
   behavior that stops working, required manual steps). Point at the release's section in
   `docs/administration/upgrade.md` (for 1.2: `docs/administration/upgrade.md#upgrading-to-12x`;
   use the equivalent anchor for other releases and verify it exists before linking).
3. **Upgrade urgency**: one line, for example "Recommended: no data migration risk" or
   "Urgent: fixes a security issue; upgrade soon". Base it on the sections you read, and ask if
   unsure.
4. A link to the full CHANGELOG sections for detail rather than restating them.

Leave out the minutiae: per-endpoint contract tweaks, schema component renames, test and
mutation work, CI and harness changes, small UI fixes, and anything only seen in a pre-release.
Never name a confidential issue.
Never start a summary line with `## [` (it would end the CHANGELOG section extraction early); use `## Highlights`-style headings.

Write the approved text to a file outside the repo tree (scratchpad), for example
`$TMPDIR/release-summary-{version}.md`. It becomes the opening of the dated `CHANGELOG.md`
section and of the GitLab and GitHub Release bodies, ahead of the assembled fragment notes.

### Step 1c-iii — Show the notes and get approval

The script's own prompt reads from a TTY, which the agent driving it does not have. So:

1. Run `scripts/assemble-changelog.sh --dry-run` (or read `changelog.d/*.md` plus the current
   `[Unreleased]` section) and show the resulting notes to the user in chat. For a feature
   release, show the roll-up summary first, then these notes, exactly as they will ship.
2. Wait for explicit approval. If the notes are wrong (a stale bullet, a fragment under the
   wrong category, something missing), stop here — fix `CHANGELOG.md`/`changelog.d/` first,
   then re-show the notes. Do not paper over a wrong note by editing only what ships on the
   Release page; the same text goes to both places.
3. Only once approved, invoke the script with `-y` (or `RELEASE_ASSUME_YES=1`) in Step 2 so
   its own confirmation gate doesn't block on a TTY it doesn't have. This is correct *only*
   because you just got the approval it exists to collect — never pass `-y` to skip getting
   that approval, and never pass it before the notes have actually been shown.

If the user is running the script themselves interactively (not via the agent), skip this
step — the script's own prompt is the gate.

## Step 2 — Run the release script

```bash
RELEASE_ASSUME_YES=1 ./scripts/release.sh {version}
# feature release: pass the approved roll-up summary (Step 1c-ii)
RELEASE_ASSUME_YES=1 ./scripts/release.sh --summary-file "$TMPDIR/release-summary-{version}.md" {version}
```

`--summary-file <path>` (or `RELEASE_SUMMARY_FILE`) is refused for a pre-release, and refused
when the file is missing or blank. A stable `X.Y.0` with no summary file is refused before the
script branches; `RELEASE_SKIP_SUMMARY=1` bypasses that deliberately (note it inline if used).
A bug-fix patch or pre-release with no file behaves exactly as it always did.

The script will automatically:
1. Refuse if the tag already exists locally, on the remote (`git ls-remote`, `origin` unless
   `RELEASE_REMOTE` overrides it), or the local tag-listing check itself was ambiguous —
   fails closed rather than proceeding as if the tag were absent
2. Create a `chore/release-{version}` branch from `main`
3. Assemble `changelog.d/` fragments, extract the release notes, prepend the roll-up summary
   (if one was given), and gate on approval
   (`confirm_release_notes` — see Step 1c) before touching any other file. On abort, it
   leaves the tree exactly as it was: `git reset --hard`, checkout `main`, delete the release
   branch.
4. Rotate `CHANGELOG.md` — moves `[Unreleased]` to `[vX.Y.Z] — YYYY-MM-DD`, prepends a fresh
   `[Unreleased]` block, in a single pass (no intermediate state that could leave a stray
   `---` divider behind)
5. Update `.env.example`, `frontend/package.json`, `README.md`, the docs pages, and
   `helm/visiban/Chart.yaml`'s top-level `appVersion` (bare version, no `v`; the helm-publish
   job hard-fails at tag time if it differs from the tag) with the new version. The chart's own
   `version:` is **not** touched — it is the chart packaging version, bumped by hand only when
   the chart's templates/values change (#1194)
6. Verify version consistency across those files, `docker-compose.prod.yml`, and the Helm
   chart, and **abort the release if any check fails** — `git reset --hard`, checkout `main`,
   delete the release branch, same cleanup as step 3's abort path. Nothing is committed yet at
   this point, so the abort leaves no partial state and no file for you to `git checkout`
   by hand. If this happens, the printed `WARN` lines name which file drifted; fix the
   underlying cause (e.g. an anchor in `scripts/release.sh` no longer matching) rather than
   re-running the script hoping it passes (#1269)
7. Commit and push the branch
8. Create an MR targeting `main`, then **poll the MR's own pipeline status directly** until
   it reaches `success` (not `glab mr merge --when-pipeline-succeeds`, which asks GitLab to
   watch for us and has 405'd when fired before GitLab had created the pipeline object yet).
   **Write the poll loop as `while true; do …; if [ "$s" = success ] || [ "$s" = failed ]; then
   break; fi; sleep N; done`, never `until …; case $s in …esac; do sleep N; done`** — a `case`
   statement is the last command of the loop body, and `case` returns 0 whether or not a
   branch matched, so an `until` gated on it exits after the very first iteration. The loop
   then "completes" immediately regardless of the pipeline's real state, and a background
   watcher's "finished" notification carries no information. Read the pipeline's actual
   status after the loop returns; don't trust that it returned.
9. Merge the MR only once that pipeline is confirmed green. If the MR is already merged
   (most often GitLab auto-merge fired the moment the pipeline went green), the script logs
   "already merged" and continues; so does a merge that lands between its state check and its
   `glab mr merge` call. Any other `glab mr merge` failure on a not-merged MR still aborts (#1821)
10. **Confirm the pipeline at the merge commit itself** — on `main`, at that exact SHA — is
   also green before tagging. A merge-request pipeline going green is not the same promise
   as the subsequent `push` pipeline on `main`, which can run a different job set
11. Tag the MR's merge commit (its `merge_commit_sha`, falling back to `squash_commit_sha`;
   the script fails closed if neither is set or the commit is not in local `main`) and push
   the tag — not whatever `HEAD` is after the pull
12. Create a GitLab release with notes from the CHANGELOG (the same summary and notes approved in
   Step 1c). The tag pipeline's `github-release` job reads the same dated CHANGELOG section, so
   the GitHub Release carries the identical body

Do not interrupt the script. If it fails, read the error output before taking any action —
each failure mode above prints what to check or do manually. The tag pipeline itself (not
this script) then deploys docs via `mike deploy --push --update-aliases` once the tag lands;
that is the tag-only job flagged in Step 1's pre-flight inventory if it changed recently.

## Step 3 — Post-release verification

- [ ] Confirm `APP_VERSION` in the running stack matches the new version
- [ ] Confirm docs.visiban.com shows the new version:
  - Stable releases publish under the `latest` alias
  - Pre-releases publish under the `next` alias
- [ ] **A default, unpinned install actually resolves to this release** — not merely "the
      publish job succeeded". Registries rank by semver, and a plain `X.Y.Z` outranks every
      `X.Y.Z-rc.N`/`X.Y.Z-beta.N` **forever**, so one bad stable artifact keeps winning
      against every pre-release published after it — republishing under a new version does
      not fix what an unpinned consumer already gets. Check what actually resolves:
      - `docker pull ghcr.io/visiban/visiban/backend` with no tag (defaults to `latest`) —
        confirm it is this version
      - `helm show chart oci://ghcr.io/visiban/charts/visiban` with no `--version` — confirm
        the chart's default `appVersion`/image tag is this version and that image exists
      If either resolves to something else or broken, say so in the release notes rather than
      leaving a consumer to discover it — the bad artifact usually needs a permission no
      pipeline has to delete.
- [ ] **The published chart verifies** — `helm-publish` signs with the cosign pinned in
      `.cosign-pin` in `.gitlab-ci.yml` (shared with the image-attest jobs, #1543). Run, with
      `<chart-version>` from `helm show chart oci://ghcr.io/visiban/charts/visiban`:
      `cosign verify ghcr.io/visiban/charts/visiban:<chart-version> --certificate-identity-regexp '^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*$' --certificate-oidc-issuer https://gitlab.com`
      It must print the verified claims and exit 0. If it fails, the documented command in
      `docs/administration/image-verification.md` has drifted from what the job signs.

- [ ] **Roll the API compatibility baseline forward (GA tags only; needs the tag, so it runs
      here, after Step 2).** Regenerate `scripts/compat-baseline/<tag>/` from the tag and
      repoint `BASELINE_SCHEMA` / `BASELINE_ENV` in `scripts/check-api-compat.py`, per
      `docs/development/api-compat-gate.md`, so the next cycle's `api-compat-check` diffs
      against this release. Before regenerating, review `scripts/compat-baseline/experimental.json`
      and remove entries for operations that should freeze, since `--normalize` strips listed
      operations silently. Land it as a branch and MR, never on `main`.
- [ ] **Clear the API allow-list (v1.2.0 roll only).** Every entry is a diff against the v1.1.0
      baseline, so against the freshly rolled baseline all of them go stale and fail
      `api-compat-check`. Run `python3 scripts/check-api-compat.py`, delete every entry it
      reports as stale from `scripts/compat-baseline/allowlist.json` (expected: the whole list,
      leaving `{"allow": []}`), and re-run until it prints OK with no stale entries. Safety net
      for the temporary entries (reason starts with `temporary:`; issues #1783, #1788, #1789,
      #1792); after deleting, it must print nothing:
      `python3 -c "import json;[print(e['issue'],e.get('operation') or e['key']) for e in json.load(open('scripts/compat-baseline/allowlist.json'))['allow'] if e['reason'].startswith('temporary:') or e['issue'] in ('#1783','#1788','#1789','#1792')]"`
- [ ] **Remove the temporary-entry prose (v1.2.0 roll only).** In
      `docs/development/api-compat-gate.md`, delete every sentence or paragraph that describes
      temporary entries or counts exceptions to the "never added" rule (including any added
      for #1789 or #1792); keep the existing "never added" sentence as is.
- [ ] **Revise the baseline-drift prose (v1.2.0 roll only).** Revise the doc prose that
      describes the v1.1.0 baseline drift and allow-list burn-down (the section "Frozen
      snapshot of the v1.1.0 baseline drift", the #1080 catch-all mentions, the `v1.1.0/`
      paths, and the allow-list paragraph in "Regenerating the baseline") to the new baseline.
- [ ] **Delete the v1.2.0-only items above from this skill** (or generalize them) so v1.3.0
      does not inherit stale issue numbers.
