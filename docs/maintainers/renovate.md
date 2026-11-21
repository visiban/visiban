# Renovate (automated dependency updates)

Four CI scanners report vulnerable dependencies (`backend-dep-scan`, `frontend-dep-scan`,
`dep-scan-osv`, `trivy-scan`). Renovate opens the bump MR. It runs as the scheduled `renovate`
job in `.gitlab-ci.yml`, configured by `renovate.json` at the repo root.

**Status: the job is inert until the one-time setup below is done.** It needs a token and a
pipeline schedule, and neither can be created from an MR.

## What it does

| Ecosystem | Files |
|---|---|
| pip | `backend/requirements*.txt` |
| npm | `frontend/package.json`, `clients/typescript/package.json` |
| Docker | `Dockerfile*`, `docker-compose*.yml`, image tags in `.gitlab-ci.yml` written as `${DOCKERHUB_MIRROR}/<image>:<tag>` |
| Helm | `helm/visiban/values*.yaml` |

Policy:

- Minor and patch updates are grouped per ecosystem and opened on Monday before 6am ET.
- Major updates are never grouped: one MR per package.
- Vulnerability alerts open immediately, outside the weekly window.
- At most 5 open Renovate MRs (`prConcurrentLimit`).
- Every MR targets `main` and carries the labels `dependencies` and `no-changelog`.
- **Nothing is auto-merged.** A maintainer reviews and merges each MR, after a green pipeline.

### Changelog

Renovate MRs carry the `no-changelog` label, which `changelog-check` honors, so they need no
`changelog.d/` fragment. A bump that changes behavior users see (a major framework upgrade, say)
should get a fragment added by hand on the Renovate branch and the label removed.

### Detection gaps

The `.gitlab-ci.yml` regex manager does not touch the Python `.lock` files or a plain-string
image such as `image: "postgres:17"` in `values.yaml` (the Helm manager reads only
`repository`/`tag` pairs). Those stay manual. CI images pinned to node 20 for the
`clients/typescript` floor (#2374) are exempt from major bumps.

## One-time setup (a maintainer does this by hand)

1. **Bot account.** Create a GitLab user (for example `visiban-renovate-bot`) and add it to
   `visiban/visiban` as **Developer**. Developer is enough to push `renovate/*` branches and open
   MRs; do not grant Maintainer. The project is on GitLab Free, where project access tokens are
   not available, so the token belongs to this user.
2. **Token.** As the bot, create a personal access token with scope **`api`** (Renovate needs
   it to create MRs and comments; `write_repository` alone is not enough) and the longest expiry
   GitLab allows. Note the expiry date.
3. **CI variable.** In Settings, CI/CD, Variables, add `RENOVATE_TOKEN`: type Variable,
   **Masked**, **Protected**, and set Visibility to masked. Protected means it reaches
   only protected refs. A scheduled pipeline on `main` qualifies; MR pipelines and forks do not.
4. **Schedule.** Renovate needs no schedule of its own. The job runs on any scheduled pipeline
   when the token exists, and a scheduled pipeline runs the whole pipeline (see
   [Scheduled pipelines](../development/ci-gates.md#scheduled-pipelines)). Reuse an existing
   schedule such as Nightly rather than adding a fourth full pipeline. Running it several times a
   week is harmless: `renovate.json` limits when new branches are created to Monday before 6am
   ET, and later runs only rebase or refresh existing MRs.
5. **Labels.** Create the project labels `dependencies` and `no-changelog` so their colors are
   yours rather than GitLab's default.
6. **Token row.** Fill in the expiry in the `RENOVATE_TOKEN` row of
   [Tokens and Rotation](tokens-and-rotation.md).

## Checking it works

Run the schedule manually (Build, Pipeline schedules, Run). The `renovate` job appears in the
`deploy` stage; its log lists the packages it found and the branches it created. With no
`RENOVATE_TOKEN` the job does not exist in the pipeline at all.

The job is `allow_failure: true`: a Renovate hiccup (rate limit, registry outage) must not turn
the schedule red. Read the log if no MRs appear for a week.

## Changing the config

- Edit `renovate.json`. The `frontend-lint` job runs `renovate-config-validator --strict` on it
  and fails the MR on any error or warning.
- The Renovate version is pinned twice and must move together: the image tag of the `renovate`
  job and the `renovate@<version>` in the `frontend-lint` validator step. Renovate does not bump
  its own image here; bump both by hand to a release at least a few weeks old.
- Validate locally: `npx --yes --package renovate@<pin> renovate-config-validator --strict`.

## Rotating the token

Create a new token as the bot, replace the `RENOVATE_TOKEN` variable, revoke the old token, and
update the expiry in [Tokens and Rotation](tokens-and-rotation.md).
