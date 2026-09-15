# Tokens and Rotation

Every credential this project depends on operationally: what it's for, its scope, who owns
it, where it's stored, and its expiry. **Names and metadata only** — this page must never
contain an actual token, key, or secret value. If you're updating this page and about to
paste a credential, stop and describe where it lives instead.

## Inventory

| Credential | Type / scope | Owner | Stored | Used by | Expiry |
|---|---|---|---|---|---|
| Mirror bot PAT | GitLab PAT, Maintainer role on `visiban/visiban-enterprise` | `visiban-mirror-bot` service account | GitLab → Settings → Repository → Mirroring (push mirror URL for the OSS→enterprise mirror) | Automatic push-mirror of every branch/tag from OSS to enterprise on every push | **2027-03-10** |
| GitHub push-mirror PAT (`visiban-gitlab-mirror`) | GitHub PAT, scope `repo` | TBD — confirm current owner before rotating | GitLab → Settings → Repository → Mirroring (push mirror URL for OSS→GitHub); **also** stored as the `GH_TOKEN` GitLab CI/CD variable (protected, masked) | Push-mirrors OSS to `github.com/visiban/visiban`; `github-release` CI job (`gh release create`, which reads `GH_TOKEN` automatically — see correction below) | **UNKNOWN** — see below |
| GHCR push PAT (`visiban-ghcr-push`) | GitHub PAT, scope `write:packages` | TBD — confirm current owner before rotating | GitLab CI/CD variable `GHCR_TOKEN` (masked), paired with `GHCR_USER` (masked) | `.kaniko-push-common` / `backend-docker-push`, `frontend-docker-push`, `ghcr-push-backend`, `ghcr-push-frontend` — pushes images to `ghcr.io/visiban/visiban/*` | **UNKNOWN** — see below |
| `DOCS_DEPLOY_TOKEN` | GitLab token, `write_repository` scope | TBD | GitLab CI/CD variable (protected, masked) | `docs-deploy` job — `mike` pushes the versioned docs site to the `gh-pages` branch | Not tracked here — see note below |
| MinIO `AccessKey` / `SecretKey` | S3-compatible object storage credentials | Runner infra owner | Each self-hosted runner's local `config.toml` (`[runners.cache.s3]`), referenced via env interpolation; also present as GitLab CI/CD variables `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` (masked, protected) alongside `MINIO_ENDPOINT` / `MINIO_BUCKET` | Distributed CI cache shared across runners (`.npm-cache`, pip cache templates in `.gitlab-ci.yml`) | Not tracked here — internal-only MinIO instance, not internet-exposed (per issue #141) |

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
      - `GHCR_TOKEN` / `GHCR_USER`: trigger the manual `ghcr-push-backend` or
        `ghcr-push-frontend` job (CI/CD → Pipelines → play button on the deploy stage).
      - `DOCS_DEPLOY_TOKEN`: run the `docs-deploy` job manually on `main` with a
        `DOCS_VERSION` set (see the job's comment block in `.gitlab-ci.yml`).
      - Mirror bot PAT: push any commit to `main` and confirm it appears on
        `visiban/visiban-enterprise` shortly after.
4. Record the new expiry in this page's inventory table in the same MR that rotates the
   credential — do not leave the row stale.
5. If a rotation fails partway, GitLab emails project maintainers after 3 consecutive mirror
   failures; ensure at least one maintainer has notifications enabled so a missed rotation
   doesn't go unnoticed for months.
