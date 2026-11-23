# Renovate (automated dependency updates)

Four CI scanners report vulnerable dependencies (`backend-dep-scan`, `frontend-dep-scan`,
`dep-scan-osv`, `trivy-scan`). Renovate opens the bump MR. It runs as the scheduled `renovate`
job in `.gitlab-ci.yml`, configured by `renovate.json` at the repo root.

**Status: the job is inert until the one-time setup below is done.** It needs a token, which
cannot be created from an MR. It reuses the existing Nightly schedule.

## What it does

| Ecosystem | Files |
|---|---|
| pip | `backend/requirements.txt`, `backend/requirements-test.txt` |
| npm | `frontend/package.json`, `clients/typescript/package.json` |
| Docker | `backend/Dockerfile*`, `frontend/Dockerfile*`, `docker-compose*.yml`; in `.gitlab-ci.yml`, image tags written as `${DOCKERHUB_MIRROR}/<image>:<tag>` plus the `mcr.microsoft.com/playwright` image |
| Helm | `helm/visiban/values.yaml`, including the plain-string `postgresql.image` (`postgres:17`) |

Only the managers in `enabledManagers` run (`pip_requirements`, `npm`, `dockerfile`,
`docker-compose`, `helm-values` and the regex manager). Renovate's own defaults would also pick
up `.nvmrc`, GitHub workflows, `pyproject.toml` and every image through its `gitlabci` manager,
so those are off. `ignorePaths` keeps `scripts/`, `docs/`, `docs-site/`, `.github/` and
`clients/python/` out of the enabled managers' default file patterns. In particular
`scripts/uv-requirements.txt` (hash-pinned, tied to `UV_VERSION` in
`scripts/lock-backend-requirements.sh`) and `scripts/pip-requirements.txt` (the pip floor many
CI jobs install) are bumped by hand. To check what Renovate would manage after a config change,
run an extract against a clean copy of the repo:

```bash
git archive HEAD | tar -x -C /path/to/copy && cd /path/to/copy && git init -q && git add -A && git commit -qm copy
docker run --rm -v "$PWD":/w -w /w -e LOG_LEVEL=debug -e LOG_FORMAT=json node:24-alpine \
  sh -c 'apk add -q git && git config --global --add safe.directory /w && \
         npx --yes --package renovate@<pin> renovate --platform=local --dry-run=extract'
```

The `packageFiles` log line lists every file and dependency.

Policy:

- Minor and patch updates are grouped per ecosystem and opened on Monday before 6am ET.
- Major updates are never grouped: one MR per package.
- **Playwright moves as a pair.** `@playwright/test` (npm) and the `mcr.microsoft.com/playwright`
  image of the `playwright-e2e` job share one `playwright` group, majors included: the client
  refuses browsers from another release, so bumping one without the other turns the e2e job red.
- **PostgreSQL majors are never proposed**, in any file (Compose, Dockerfiles, CI images, Helm
  values). A major changes the on-disk format and needs `pg_upgrade` or a dump and restore, so it is
  a planned upgrade, not a weekly bump. Minor and patch tags are still proposed.
- **eslint-plugin-unicorn majors are disabled**: 66+ needs ESLint 10; re-enable together with the
  ESLint major.
- Vulnerability alerts open immediately, outside the weekly window.
- At most 5 open Renovate MRs (`prConcurrentLimit`).
- Every MR targets `main` and carries the labels `dependencies` and `no-changelog`, except
  security MRs (see below).
- **Nothing is auto-merged.** A maintainer reviews and merges each MR, after a green pipeline.

### Changelog

Routine Renovate MRs carry the `no-changelog` label, which `changelog-check` honors, so they need
no `changelog.d/` fragment. A bump that changes behavior users see (a major framework upgrade, say)
should get a fragment added by hand on the Renovate branch and the label removed.

**Security bumps need a fragment.** MRs from a vulnerability alert carry `dependencies` and
`security` but not `no-changelog`, so `changelog-check` fails until the reviewer adds a
`changelog.d/<slug>.security.md` fragment to the Renovate branch (for example
`changelog.d/django-cve-2026-1234.security.md`, no dots in the slug). Operators read the
changelog to decide how urgently to upgrade, so a security fix must appear there.

### Detection gaps

**Python lock file (regenerated automatically, #2482).** Renovate's pip manager edits
`backend/requirements.txt` only, but the Dockerfiles install the hash-pinned
`backend/requirements.lock`, and `backend-lock-check` fails when it is stale. A
`postUpgradeTasks` rule in `renovate.json` therefore runs `scripts/lock-backend-requirements.sh`
on every pip branch and commits `backend/requirements.lock` and `backend/requirements-build.lock`
with the bump. Three pieces must stay in step:

- the command in `renovate.json` (`postUpgradeTasks`);
- `RENOVATE_ALLOWED_COMMANDS` on the `renovate` job, one anchored regex for exactly that command
  (post-upgrade tasks run arbitrary repo code inside the job, so never widen it to a wildcard);
- the `renovate` job's script, which installs Python (containerbase `install-tool`) and then uv from
  `scripts/uv-requirements.txt` with `--require-hashes`, so the lock is generated by the same uv
  that `backend-lock-check` uses. When you bump uv, update `scripts/uv-requirements.txt` and
  `UV_VERSION` in the lock script as before; the job follows automatically. The Python version
  (`install-tool python 3.12.12`) is pinned by hand in that script; Renovate does not bump it.
  The bootstrap is non-fatal, so if it fails the job logs a WARNING and only pip MRs lose their lock.

If a pip MR still arrives with a red `backend-lock-check` (the task failed; read the `renovate`
job log), check out the branch, run `scripts/lock-backend-requirements.sh` and commit the result.

**Other manual pins.** Anything under `scripts/`, `docs/`, `docs-site/`, `.github/` and
`clients/python/`, `frontend/.nvmrc`, and any `.gitlab-ci.yml` image that is neither behind
`${DOCKERHUB_MIRROR}` nor the Playwright image stay manual. The Helm `postgres:17` image is
managed, but only for minor and patch tags (see the PostgreSQL rule above). CI images pinned to
node 20 for the `clients/typescript` floor (#2374) are exempt from major bumps.

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
4. **Schedule: nothing to create.** The job runs only on the existing Nightly schedule (the one
   that sets `CVE_SCAN=true`; see
   [Scheduled pipelines](../development/ci-gates.md#scheduled-pipelines)), never on the load-test
   or mutation schedules, so adding the `RENOVATE_TOKEN` variable in step 3 is all it needs. Do not
   add a schedule for it: every schedule runs the whole pipeline. Running nightly is harmless:
   `renovate.json` limits when new branches are created to Monday before 6am ET, and the other
   nights only rebase or refresh existing MRs.
5. **Labels.** Create the project labels `dependencies`, `security` and `no-changelog` so their colors are
   yours rather than GitLab's default.
6. **Token row.** Fill in the expiry in the `RENOVATE_TOKEN` row of
   [Tokens and Rotation](tokens-and-rotation.md).

## Checking it works

Run the Nightly schedule manually (Build, Pipeline schedules, Run). The `renovate` job appears in the
`deploy` stage; its log lists the packages it found and the branches it created. With no
`RENOVATE_TOKEN` the job does not exist in the pipeline at all.

After the first run with a token, open a pip MR and confirm its diff includes
`backend/requirements.lock` and that `backend-lock-check` is green. That path could not be
exercised before the token existed (#2482). Do not close #2482 until the first pip MR carries
the regenerated lock. If the post-upgrade task fails with "uv is required", Renovate's subprocess
did not inherit the job's PATH: point the `renovate.json` command at an absolute uv path and update
`RENOVATE_ALLOWED_COMMANDS` to match, in the same change.

The job is `allow_failure: true`: a Renovate hiccup (rate limit, registry outage) must not turn
the schedule red. Read the log if no MRs appear for a week.

## Changing the config

- Edit `renovate.json`. The `renovate-config-check` job runs `renovate-config-validator --strict` on it
  (when `renovate.json` or `.gitlab-ci.yml` changes) and fails the MR on any error or warning.
- The Renovate version is pinned twice and must move together: the image tag of the `renovate`
  job and the `renovate@<version>` in the `renovate-config-check` job. Renovate does not bump
  either pin: `renovate.json` disables the `renovate/renovate` dependency (the regex manager
  would otherwise match the image tag), and the `npx` pin is not matched by any manager. Bump
  both by hand, in one MR, to a release at least a few weeks old. The validator needs Node 24
  (`engines.node ^24.11.0`), which is why that job runs on `node:24-alpine`.
- Validate locally: `npx --yes --package renovate@<pin> renovate-config-validator --strict`.

## Rotating the token

Create a new token as the bot, replace the `RENOVATE_TOKEN` variable, revoke the old token, and
update the expiry in [Tokens and Rotation](tokens-and-rotation.md).

## Deviations from #2464

Two points differ from the issue as written:

- **No token, no job.** The issue asked for the job to skip with a message when `RENOVATE_TOKEN`
  is missing. The job is instead not created at all (the token is part of its `rules:`), so a
  fork or fresh install sees no `renovate` job rather than a skipped one. This avoids a pipeline
  job that spins up a container only to print a message.
- **Validation has its own job.** The issue suggested validating `renovate.json` in an existing
  lint job. `renovate-config-check` is separate because the validator needs Node 24 and
  `frontend-lint` runs on Node 22.
- **Nightly only.** The issue asked for the job on schedules in general. It runs only on the
  Nightly schedule (`CVE_SCAN=true`), so the noise-sensitive load-test schedule and the weekly
  mutation schedule never carry it, and no new schedule is needed.
