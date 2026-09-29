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

## Step 2 — Run the release script

```bash
./scripts/release.sh {version}
```

The script will automatically:
1. Refuse if the tag already exists locally, on the remote (`git ls-remote`, `origin` unless
   `RELEASE_REMOTE` overrides it), or the local tag-listing check itself was ambiguous —
   fails closed rather than proceeding as if the tag were absent
2. Create a `chore/release-{version}` branch from `main`
3. Update `.env.example` and `docker-compose.yml` with the new version
4. Rotate `CHANGELOG.md` — moves `[Unreleased]` to `[vX.Y.Z] — YYYY-MM-DD`, prepends a fresh
   `[Unreleased]` block, in a single pass (no intermediate state that could leave a stray
   `---` divider behind)
5. Commit and push the branch
6. Create an MR targeting `main`, then **poll the MR's own pipeline status directly** until
   it reaches `success` (not `glab mr merge --when-pipeline-succeeds`, which asks GitLab to
   watch for us and has 405'd when fired before GitLab had created the pipeline object yet).
   **Write the poll loop as `while true; do …; if [ "$s" = success ] || [ "$s" = failed ]; then
   break; fi; sleep N; done`, never `until …; case $s in …esac; do sleep N; done`** — a `case`
   statement is the last command of the loop body, and `case` returns 0 whether or not a
   branch matched, so an `until` gated on it exits after the very first iteration. The loop
   then "completes" immediately regardless of the pipeline's real state, and a background
   watcher's "finished" notification carries no information. Read the pipeline's actual
   status after the loop returns; don't trust that it returned.
7. Merge the MR only once that pipeline is confirmed green
8. **Confirm the pipeline at the merge commit itself** — on `main`, at that exact SHA — is
   also green before tagging. A merge-request pipeline going green is not the same promise
   as the subsequent `push` pipeline on `main`, which can run a different job set
9. Tag the merge commit and push the tag
10. Create a GitLab release with notes from the CHANGELOG

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
