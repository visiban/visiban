# Upgrade drills and the PostgreSQL matrix

Two CI drills install the **last GA release**, put data in it, upgrade it to HEAD and check that the data survived. One drill covers Compose and one covers Helm. Two more jobs run the backend against every supported PostgreSQL major: a rotating-group job on MRs and `main`, and a full-suite job on schedules. All four come from #2463.

**Why it matters:** backward compatibility has been the contract since 1.0, but every other drill starts from an empty database at HEAD. A migration that works on an empty schema but breaks on a populated 1.2 one would ship unnoticed. So would a chart change that breaks `helm upgrade` but not `helm install`.

**Watch out:** the "from" side is the **published** release: the GHCR images and the OCI chart. The resolver only picks a release whose backend image, frontend image and OCI chart are all published, and falls back to the previous GA with a warning otherwise. The upgrade itself is then a real upgrade from what operators actually pull.

## What each job proves

| Job | From | To | Asserts |
|---|---|---|---|
| `compose-upgrade-drill` | That tag's `docker-compose.prod.yml` and `.env.example`, with `ghcr.io/visiban/visiban/backend:<tag>` | HEAD `docker-compose.prod.yml`, with a backend image built from `backend/Dockerfile` | `backend-init` (migrate) exits 0 on the HEAD image, `migrate --check` is clean, board/card/movement/user counts unchanged, readiness `ok`, the drill user can log in |
| `helm-upgrade-drill` | `oci://ghcr.io/visiban/charts/visiban` at that tag's chart version, with the tag's images | HEAD `helm/visiban`, with images built from `backend/Dockerfile` and `frontend/Dockerfile` | The same checks, plus the new backend pod's `migrate` init container exit code. Both releases use the same values file, the way an operator runs `helm upgrade` |
| `backend-test-pg-matrix` | — | PostgreSQL 15, 16 and 18 (17 is covered by `backend-test` and `migration-check`) | The service is the expected major, every migration applies from zero, `makemigrations --check`, and one pytest-split group |

The upgrade order follows [Upgrading](../administration/upgrade.md#standard-upgrade-steps). The Compose drill swaps in HEAD's compose file, sets `APP_VERSION` and runs `docker compose up -d`. The Helm drill runs `helm upgrade` with the operator's values file.

### Details that are easy to get wrong

- **The last GA tag is resolved, never hardcoded.** `scripts/resolve-last-ga-tag.sh` lists tags with `git ls-remote` because CI clones are shallow and have no tags. It keeps only `vX.Y.Z`, skipping `-alpha`, `-beta` and `-rc`, and sorts numerically. It then fetches just that tag. `--self-test` covers the exclusions and the ordering.
- **The HEAD images come from the release Dockerfiles** (`Dockerfile`, not `Dockerfile.prod`). The release job publishes from those, so a fix made only in `Dockerfile.prod` never ships. In CI they are this commit's per-commit kaniko images from `backend-docker-build` (both drills) and `frontend-docker-build` (Helm drill), pulled by digest and checked against the commit by `scripts/drill-image.sh` rather than rebuilt in dind; see [Per-commit drill images](../maintainers/ci-runners.md#per-commit-drill-images-2492). Run by hand, the drills build HEAD from the working tree.
- **The chart pull is strict in CI.** With `CI=true`, an OCI chart pull failure fails the helm drill. Local runs fall back to the tag's `helm/visiban` source with a warning.
- **The newest GA may not be published yet.** The tag pipeline publishes the images first and the chart last (`helm-publish`), so the resolver checks GHCR for `backend:<tag>`, `frontend:<tag>` and the OCI chart `charts/visiban:<version>` (the version comes from the tag's `helm/visiban/Chart.yaml`), using anonymous manifest requests. If any is missing it falls back to the previous GA with a warning naming the missing artifact. It fails if no GA has all three. In a fork MR pipeline `origin` is the fork, so the resolver lists and fetches tags from `CI_MERGE_REQUEST_PROJECT_URL` instead. `--no-image-check` skips this, for offline use.
- **The seed is deterministic.** `seed_demo_data --wipe --force` runs on a fresh database, and the drill fails if any count comes out zero. Plain `--force` silently skips an existing board.
- **The Compose drill boots only `db`, `valkey`, `backend-init` and `backend`.** The frontend and nginx hold no data, and `compose-prod-drill` already boots them at HEAD.
- **Helm keeps PostgreSQL persistence on.** `helm-install` turns it off. This drill needs it on, because the upgrade may recreate the database pod.
- **A change to the shipped PostgreSQL major fails both drills.** The new major will not start on the old data directory. That is a real upgrade break: the release needs a documented dump and restore.
- **The MR and `main` PG matrix legs are advisory (`allow_failure: true`) for now.** Only one eighth of the suite has ever run on PostgreSQL 15, 16 and 18, so a blocking leg could surface PG-specific failures as random reds. [#2481](https://gitlab.com/visiban/visiban/-/issues/2481) tracks making them blocking after the first all-green nightly matrix run. A failed `backend-test-pg-matrix` main leg on a release commit still refuses the release tag, though: `release-main-pipeline-guard` treats any failed job on that pipeline as blocking, and that is intentional while 15–18 is the documented support range.
- **The PG matrix rotates through the suite.** Each leg runs pytest-split group `(CI_PIPELINE_IID mod 8) + 1`, so a single pipeline covers one eighth of the suite on each major, and MR and `main` pipelines together do not cover the whole suite. The full suite takes about 110 minutes, too long to run three times per pipeline. The log names the group. Full coverage comes from `backend-test-pg-matrix-nightly`, which runs on schedules only (every schedule except the Sonar one): every group (1 to 8) on every major (15, 16, 18), 24 jobs, advisory.

## When they run

| Job | MR pipelines | `main` | Schedules (all except the Sonar one) |
|---|---|---|---|
| Both upgrade drills | Changes to `.gitlab-ci.yml`, `backend/**/migrations/**`, `helm/**`, `docker-compose*.yml`, `backend/Dockerfile*`, `frontend/Dockerfile*`, `backend/requirements*`, or the drill scripts | Also any `backend/**` change (and `.gitlab-ci.yml`) | Advisory (`allow_failure`) |
| `backend-test-pg-matrix` (one rotating group, advisory, [#2481](https://gitlab.com/visiban/visiban/-/issues/2481)) | Changes to `.gitlab-ci.yml`, migrations, `backend/requirements*`, or `scripts/pg-matrix-check.sh` | Any `.gitlab-ci.yml` or `backend/**` change | Does not run |
| `backend-test-pg-matrix-nightly` (all 8 groups) | Does not run | Does not run | Advisory |

The `main` trigger is narrowed: a push to `main` runs the drills only when it changes `.gitlab-ci.yml` or a shipped path (`backend/**`, `helm/**`, `docker-compose*.yml`, `frontend/Dockerfile*` or the drill scripts), not on every push. None of them run on a docs-only MR. The two upgrade drills and `backend-test-pg-matrix-nightly` run on every schedule except the Sonar one (the schedule that sets `SONAR_SCHEDULED=true`, titled "Nightly (CVE/OSV, Sonar, deep fuzz, kaizen)"): the "Nightly load test (#1082)" and "Weekly mutation testing (#1384)" schedules run them, as advisory jobs. They skip the Sonar schedule with an explicit first rule on `SONAR_SCHEDULED`, because `changes:` always evaluates true on a schedule. `backend-test-pg-matrix` skips every schedule with `schedule` then `when: never`. The older compose and helm drills still run on the Sonar schedule; that is tracked in #2471.

## Run one locally

You need Docker. The Helm drill also needs `kind`, `kubectl` and `helm`. Each drill takes 10 to 25 minutes.

```bash
bash scripts/compose-upgrade-drill.sh                          # last GA -> working tree
UPGRADE_FROM_TAG=v1.1.0 bash scripts/compose-upgrade-drill.sh  # a specific release
KEEP_STACK=1 bash scripts/compose-upgrade-drill.sh             # leave the stack up after a failure

bash scripts/helm-upgrade-drill.sh
KEEP_CLUSTER=1 bash scripts/helm-upgrade-drill.sh              # leave the kind cluster up
```

The Compose drill keeps its `.env` and compose file in a temporary project directory, so it never touches your checkout's `.env`. It uses the `visiban-upgrade-drill` Compose project, which keeps it apart from a dev stack.

To check one PostgreSQL major, start that major, point `DATABASE_URL` at it, and pick a group:

```bash
docker run -d --name pg16 -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:16-alpine
DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres \
  PG_MAJOR=16 PG_TEST_GROUP=3 bash scripts/pg-matrix-check.sh
```

## Related

- [Upgrading](../administration/upgrade.md#supported-postgresql-versions): the supported PostgreSQL range
- [CI Gate Self-Tests](ci-gates.md): why the drills are `gate-selftest-exempt` and the helpers are not
- [Database Migrations](database-migrations.md): the zero-downtime rules these drills back up

## Known gap in released images: `/app/staticfiles` ownership

Backend images up to and including v1.2.0 were built from `backend/Dockerfile`,
which did not create `/app/staticfiles`. On a fresh Compose install the named
volume therefore mounts root-owned and `backend-init`'s `collectstatic` fails
with `PermissionError`. `backend/Dockerfile` now creates both `/app/media` and
`/app/staticfiles` (as `backend/Dockerfile.prod` already did). The Compose drill
cannot change the published older image, so it chowns the `staticfiles` and
`mediafiles` volumes to uid 1001 before booting the last release; once the last
GA release contains the fix that step is a harmless no-op.
