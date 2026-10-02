# Tokens and Rotation

Every credential this project depends on operationally: scope, owner, storage location, and
expiry. **Why it matters:** an expired credential fails silently until it breaks a release.
**Names and metadata only** — never paste an actual token, key, or secret value here;
describe where it lives instead.

## Inventory

| Credential | Type / scope | Owner | Stored | Used by | Expiry |
|---|---|---|---|---|---|
| Mirror bot PAT | GitLab PAT, Maintainer role on `visiban/visiban-enterprise` | `visiban-mirror-bot` service account | GitLab → Settings → Repository → Mirroring (push mirror URL for the OSS→enterprise mirror) | Automatic push-mirror of every branch/tag from OSS to enterprise on every push | **2027-03-10** |
| GitHub push-mirror PAT (`visiban-gitlab-mirror`) | GitHub PAT, scope `repo` | TBD — confirm current owner before rotating | GitLab → Settings → Repository → Mirroring (push mirror URL for OSS→GitHub); **also** stored as the `GH_TOKEN` GitLab CI/CD variable (protected, masked) | Push-mirrors OSS to `github.com/visiban/visiban`; `github-release` CI job (`gh release create`, which reads `GH_TOKEN` automatically — see correction below) | **UNKNOWN** — see below |
| GHCR push PAT (`visiban-ghcr-push`) | GitHub PAT, scope `write:packages` | TBD — confirm current owner before rotating | GitLab CI/CD variable `GHCR_TOKEN` (masked), paired with `GHCR_USER` (masked) | `.kaniko-push-common` / `backend-docker-push`, `frontend-docker-push`, `.arm64-docker-push-base` / `backend-docker-push-arm64`, `frontend-docker-push-arm64`, `.manifest-tool-common` / `backend-manifest`, `frontend-manifest` — pushes images and multi-arch manifests to `ghcr.io/visiban/visiban/*` | **UNKNOWN** — see below |
| `DOCS_DEPLOY_TOKEN` | GitLab token, `write_repository` scope | TBD | GitLab CI/CD variable (protected, masked) | `docs-deploy` job — `mike` pushes the versioned docs site to the `gh-pages` branch | Not tracked here — see note below |
| MinIO `AccessKey` / `SecretKey` | S3-compatible object storage credentials | Runner infra owner | Each self-hosted runner's local `config.toml` (`[runners.cache.s3]`), referenced via env interpolation; also present as GitLab CI/CD variables `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` (masked, protected) alongside `MINIO_ENDPOINT` / `MINIO_BUCKET` | Distributed CI cache shared across runners (`.npm-cache`, pip cache templates in `.gitlab-ci.yml`) | Not tracked here — internal-only MinIO instance, not internet-exposed (per issue #141) |
| `RUNNER_STATUS_TOKEN` | GitLab fine-grained PAT, `read_runner` permission, scoped to the `visiban` group (id 126306686) | `kellyhair` | GitLab CI/CD variable (masked, protected, description "ARM64") | `arm64-runner-preflight` job (#1084) — queries `GET /groups/visiban/runners?scope=online&tag_list=arm64` to fail loud before scheduling the arm64 Docker push legs, instead of letting them hang `pending` with no matching runner | **2027-09-26** |
| Docker Hub PAT (`DOCKERHUB_TOKEN`) | Docker Hub personal access token, "Public Repo Read-only" scope (view/search/pull public images only — no push access) | TBD — confirm current owner before rotating | GitLab CI/CD variables `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` (masked, protected — only injected on `main` and `v*` tag pipelines) | `backend-docker-build` / `frontend-docker-build` (MR-time, `--no-push` build verification) and `.kaniko-push-common` / `backend-docker-push`, `frontend-docker-push` (main/tag pushes) — populates kaniko's `/kaniko/.docker/config.json` so Docker Hub `FROM` base-image pulls (`python:3.12-slim`, `node:20-alpine`, `nginx:1.27-alpine`) use the authenticated 200-pulls/hour tier instead of the 100/hour anonymous tier shared across the runner's IP (#1198). Being `protected`, it does **not** reach MR pipelines from unprotected branches — those still pull anonymously. | TBD — confirm expiry set on Docker Hub |
| `GITLAB_API_TOKEN` (optional — **not yet created**) | GitLab project access token, Reporter role, `read_api` scope | TBD | GitLab CI/CD variable (protected, masked) | `schedule-config-check` (reads pipeline schedules; `CI_JOB_TOKEN` cannot) and `suppressions-check` / `kaizen-yield-watch` as a read fallback. Without it, `schedule-config-check` warns and passes — see [Scheduled pipelines](../development/ci-gates.md#scheduled-pipelines) | n/a until created |
| `FUZZ_DEEP_API_TOKEN` (optional — **not yet created**) | GitLab project access token, Reporter role, `api` scope (Reporter is enough to create issues and comment) | TBD | GitLab CI/CD variable (protected, masked) | `backend-schema-fuzz-deep` `after_script` (`scripts/fuzz_deep_file_issue.py`) — files or comments on the deep-fuzz tracking issue. Falls back to `KAIZEN_API_TOKEN`; see [below](#deep-fuzz-and-kaizen-issue-filing-tokens) | n/a until created |
| `KAIZEN_API_TOKEN` (optional — **not yet created**) | GitLab project access token, Reporter role, `api` scope | TBD | GitLab CI/CD variable (protected, masked) | `kaizen-yield-watch` issue filing (only with `KAIZEN_FILE_ISSUES=true`); also the fallback filer token for `backend-schema-fuzz-deep` | n/a until created |

## `RUNNER_STATUS_TOKEN`

Added in **#1084** for `arm64-runner-preflight`. The GitLab Runners API is not part of the
CI_JOB_TOKEN-allowed endpoint set, so this job cannot authenticate with the ambient
`CI_JOB_TOKEN` the way most other jobs in this file do for registry pushes — it needs an
actual PAT. It is a **fine-grained** PAT with the `read_runner` permission, scoped to the
`visiban` **group** — not a classic `read_api`/Reporter-role PAT, and not project-scoped. The
job queries the group Runners endpoint (`/groups/visiban/runners`) to match.

**Corrected 2026-09-28:** three separate mistakes found in the same #1084 re-audit:

1. This page and `.gitlab-ci.yml` both originally called this variable `RUNNERS_READ_TOKEN`
   and described it as still needing to be created. It was, in fact, already created — just
   as `RUNNER_STATUS_TOKEN` (confirmed present via the project variables API: masked,
   protected, description "ARM64") — and the name never got reconciled between the variable
   that was actually set up and the code/docs that expected a different one. Because a
   missing variable and a wrong variable name both fail the same way (`... not set`), this
   went unnoticed through #1084's original review. No release tag had actually been cut since
   that merge, so this had not yet failed a real pipeline — but the next one would have,
   skipping both arm64 legs and the manifest jobs silently.
2. The scope/type description above was also wrong (originally "`read_api`-scope PAT, at
   least Reporter on the group") — the token's own metadata (personal access tokens API)
   shows it is actually a fine-grained PAT with `read_runner`, scoped to the `visiban` group,
   not a classic PAT with `read_api`.
3. The job queried `/projects/${CI_PROJECT_ID}/runners`, a project-scoped endpoint, while the
   token's grant is group-scoped. Verified directly (`glab api
   "groups/visiban/runners?tag_list=arm64"` returns `Max1-Runner-Visiban`) that the group
   endpoint is what this token can actually authenticate against — `.gitlab-ci.yml` now
   queries that endpoint instead.

`.gitlab-ci.yml` now references `RUNNER_STATUS_TOKEN` against `/groups/visiban/runners`, to
match what's actually configured and granted. If this variable is ever rotated or recreated,
keep the name as `RUNNER_STATUS_TOKEN`, the `read_runner` group-scoped permission, and the
group endpoint — do not reintroduce `RUNNERS_READ_TOKEN` or point it back at the project
endpoint.

## Correction: the GitHub-release CI variable is `GH_TOKEN`, not `GITHUB_TOKEN`

Some earlier notes (including this page's source issue) refer to the GitHub release token as
`GITHUB_TOKEN`. That name is wrong for this repo. Verified directly against
`.gitlab-ci.yml`: the `github-release` job calls `gh release create` with no explicit
`--token` flag, so the `gh` CLI picks up `GH_TOKEN` from the environment automatically. The
GitLab CI/CD variable is named `GH_TOKEN` — confirmed present (`protected: true, masked:
true`) via the project variables API, and there are zero references to `GITHUB_TOKEN`
anywhere in `.gitlab-ci.yml`. If `github-release` ever fails with "set the `GH_TOKEN`
environment variable", the variable *name* is correct — check instead whether the tag is
protected (protected variables are only injected on protected branches/tags).

## Unresolved: two PAT expiries are unknown

The `visiban-gitlab-mirror` and `visiban-ghcr-push` GitHub PATs have no recorded expiry date
anywhere in this project's documentation or memory. This is exactly the "credential with an
unknown expiry is an outage with a start date nobody has written down" problem this page
exists to close — and it is **not closed yet**. GitHub PAT expiry is only visible via GitHub's
own token settings (`github.com/settings/tokens` for a classic PAT, or the fine-grained
equivalent), which is not something obtainable from GitLab's API or this repository.

**Action needed (human, on GitHub):** whoever holds `visiban-gitlab-mirror` and
`visiban-ghcr-push` must open GitHub → Settings → Developer settings → Personal access
tokens, find both tokens, and record their expiry dates here. Until that happens, treat both
as **could expire at any time** — a sudden `github-release` or GHCR push failure with an auth
error is the first symptom, and by then it's already an incident. Do not let this line sit as
long as the two memory notes below did (~5 months pending).

## Deep-fuzz and kaizen issue-filing tokens

`scripts/fuzz_deep_file_issue.py` (#1383) uses `FUZZ_DEEP_API_TOKEN` and falls back to
`KAIZEN_API_TOKEN` when that is unset, so a project can run on one issue-filing token.
A project access token with **Reporter** role and `api` scope is enough: Reporter can create
issues and comment, and nothing here needs a higher role. Neither token exists yet. Until one
does, both jobs only report what they would have filed.

The fallback **ties the two tokens' rotation together**. If only `KAIZEN_API_TOKEN` is
configured, it is also the deep-fuzz filer, so revoking or rotating it silently stops deep-fuzz
filing too. Rotate or revoke it as a deep-fuzz credential as well as a kaizen one. To separate
them, create `FUZZ_DEEP_API_TOKEN`, which takes precedence.

## `DOCS_DEPLOY_TOKEN` — historical note and current status

A memory note dated 2026-04-07 recorded `DOCS_DEPLOY_TOKEN` as mistakenly set to a GitHub
PAT (`ghp_...`), which GitLab's git auth would reject when `mike` tries to push to
`gh-pages`. As of this writing (2026-09-14), that is **not** the current failure mode: the
`gh-pages` pipeline has completed successfully multiple times today, which requires
`docs-deploy`'s `git remote set-url` + push step to have authenticated successfully — so
whatever token is currently stored works for GitLab git auth. The project's
`access_tokens` API returns no project access tokens for `visiban/visiban`, which means the
current `DOCS_DEPLOY_TOKEN` is not a project access token registered on this project (it may
be a personal or group access token instead). Its expiry is not visible from this project's
API and is not currently recorded anywhere — worth doing the same GitHub-style expiry
capture for it as a follow-up, since "working today" says nothing about "working next
quarter."

## MinIO credentials (issue #141)

Issue **#141** ("MinIO creds hardcoded in runner `config.toml`") is **closed**. The current
`.gitlab-ci.yml` cache-template comments document the fixed form: `config.toml` should
reference `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_ENDPOINT` / `MINIO_BUCKET` via env
interpolation rather than hardcoding values, and those four variables are now present as
masked, protected GitLab CI/CD variables. This matches the issue's recommended fix. The
MinIO instance is internal-only and the group runners are not internet-exposed, which is why
this was tracked as low-priority rather than urgent. If you provision a new runner, confirm
its `config.toml` follows the interpolated form — do not hardcode the values again.

## Rotation procedure (general)

1. Generate the replacement credential at its source (GitHub token settings, GitLab access
   token settings, or the MinIO admin console) — never reuse or extend an expiring token.
2. Update the GitLab CI/CD variable (Settings → CI/CD → Variables) or the mirroring URL
   (Settings → Repository → Mirroring), matching the "Stored" column above.
3. Trigger the smallest job that exercises the credential to confirm it works before the old
   one expires:
      - `GH_TOKEN` / `github-release`: only runs on a version-tag pipeline, so test via a
        pre-release tag or by re-running a past `github-release` job with the new variable
        value.
      - `GHCR_TOKEN` / `GHCR_USER`: there is no on-demand job for this anymore
        (`ghcr-push-backend` / `ghcr-push-frontend` were removed 2026-09-28 — they had no
        `rules:` restricting them to a specific pipeline and could overwrite the multi-arch
        GHCR `:latest` manifest with a single-arch amd64 image from any pipeline's deploy
        stage). Test via a pre-release tag (e.g. `v1.2.0-rc.1`) instead — it exercises
        `backend-docker-push` / `frontend-docker-push` (kaniko, pushes `-amd64`-suffixed GHCR
        tags) and, if the arm64 leg and preflight also pass, `backend-manifest` /
        `frontend-manifest` (assembles the real GHCR `:<tag>`/`:latest`). **Caveat, pre-existing
        and not specific to this token:** a pre-release tag's `TAGS_ARG` includes `latest`
        (`.gitlab-ci.yml` `backend-manifest`/`frontend-manifest`), so this test moves the real
        `:latest` reference to the rc build on both registries — expected for an actual rc
        release, but worth knowing before using it purely as a credential smoke test.
      - `DOCS_DEPLOY_TOKEN`: run the `docs-deploy` job manually on `main` with a
        `DOCS_VERSION` set (see the job's comment block in `.gitlab-ci.yml`).
      - Mirror bot PAT: push any commit to `main` and confirm it appears on
        `visiban/visiban-enterprise` shortly after.
      - `RUNNER_STATUS_TOKEN`: re-run a past `arm64-runner-preflight` job (CI/CD → Pipelines →
        find a release-tag pipeline → retry that job), or trigger a new pipeline on a
        pre-release tag; it should log "OK: N online runner(s) tagged arm64" rather than the
        "RUNNER_STATUS_TOKEN not set" or Runners-API-error message.
4. Record the new expiry in this page's inventory table in the same MR that rotates the
   credential — do not leave the row stale.
5. If a rotation fails partway, GitLab emails project maintainers after 3 consecutive mirror
   failures; ensure at least one maintainer has notifications enabled so a missed rotation
   doesn't go unnoticed for months.
