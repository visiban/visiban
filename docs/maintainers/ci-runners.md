# CI Runners

Inventory and behavior of the GitLab Runners that execute Visiban's pipelines, and the traps
that follow from how they're configured.

## Inventory

As of 2026-09-14, three GitLab group runners are registered against `visiban/visiban`
(`glab api "projects/visiban%2Fvisiban/runners?type=group_type"`):

| Runner ID | Description | Status | Tags | `run_untagged` |
|---|---|---|---|---|
| 52215741 | (none set) | online | none | true |
| 56277672 | `Runner-03-NUC` | online | none | true |
| 56277916 | `runner-04-NUC` | online | none | true |
| 56802474 | `Max1-Runner-Visiban` | online | `arm, arm64, apple, macosx, mac, ios` | false |

All four are self-hosted. Re-run the query above before trusting this table — runner health
and identity have changed multiple times in this project's history (see below) and nothing
keeps this page in sync automatically.

`Max1-Runner-Visiban` is the exception to "no tags" and to the warning immediately below: it's
a dedicated Apple Silicon (M1 Max) macOS host running the **shell executor** against its own
already-installed Docker Desktop, whose engine is itself native `linux/arm64` — no QEMU. Jobs
that need it request it explicitly with `tags: [arm64]` (`.arm64-docker-push-base` in
`.gitlab-ci.yml`, #1084). Do **not** use this runner's own API-reported `architecture` field
or a job's `uname -m` to sanity-check anything: the GitLab API reports `architecture: amd64`
here (the `gitlab-runner` binary itself runs under Rosetta) and `uname -m` on the host prints
`x86_64`, despite the runner and every image it builds being genuinely native arm64. Assert
`docker image inspect --format '{{.Architecture}}'` on a built image instead — that's what
`backend-docker-push-arm64` / `frontend-docker-push-arm64` do.

!!! warning "No job in `.gitlab-ci.yml` uses `tags:`"
    Every job — including ones that need a specific runner's local resources — queues for
    *any* available runner, self-hosted or GitLab SaaS. When a self-hosted runner goes
    offline, jobs that depended on something only it provides don't fail loudly with "no
    runner available" — they get scheduled onto a SaaS runner instead and fail with a
    confusing error from deep inside the job script. This has already happened once (see
    "Docker push" below). If a job needs the self-hosted runner specifically, add a `tags:`
    selector to make the dependency explicit rather than relying on the untagged runners
    happening to be healthy.

## Docker image push — amd64 via kaniko, arm64 via a dedicated runner

`backend-docker-push` / `frontend-docker-push` (`.kaniko-push-common` in `.gitlab-ci.yml`)
build and push **amd64** with **kaniko**, which needs no Docker daemon and runs on any runner.

This wasn't always true. Before the kaniko conversion (merged in **!852**, 2026-09-14), these
jobs ran `docker buildx` against a Docker socket mounted by a self-hosted runner's
`config.toml` (`volumes = ["/var/run/docker.sock:/var/run/docker.sock"]`). That runner (the
"nuc runner", group runner id `53511568`) went stale on **2026-07-18**. Because the jobs
carried no `tags:`, every push after that date silently fell through to a GitLab SaaS runner
and failed with `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`. The
last successful push before the conversion was **2026-06-26**. kaniko removes that single
point of failure for amd64.

**arm64 is published again as of #1084.** kaniko cannot cross-build, and
`saas-linux-medium-arm64` resolves to `no_matching_runner` on this project's GitLab plan
(verified on pipeline `2845582400`) — there is no usable GitLab SaaS arm64 runner on this
plan. `backend-docker-push-arm64` / `frontend-docker-push-arm64` (`.arm64-docker-push-base`)
instead run natively on `Max1-Runner-Visiban` (see Inventory above), on release tags only.
`backend-manifest` / `frontend-manifest` then assemble the amd64 and arm64 single-arch images
into real multi-arch manifest lists under `:<tag>`, `:latest`, and (stable releases)
`:MAJOR.MINOR`, via `manifest-tool`, on both the GitLab registry and GHCR.

`arm64-runner-preflight` runs before either arm64 leg and fails the pipeline within seconds if
no runner tagged `arm64` is online — see "Fail-loud, not hang" below. This is deliberately
*not* the same "add `no_matching_runner` and hang" trap the amd64/kaniko conversion avoided by
leaving arm64 out: the preflight makes an absent runner an explicit, fast pipeline failure
instead of an indefinite pending job.

The runner IDs in the table above for the NUC runners (`56277672`, `56277916`) are **not**
the same runner as the stale `53511568` — they were (re-)registered on 2026-09-14. Do not
assume the old "Runner-03-NUC" staleness note still describes the current runner with that
name.

Because this runner is persistent and shared, the arm64 legs log in with `--password-stdin`
(a password passed with `-p` sits in `ps` output for anything else on the host) and push
through `scripts/docker-push-retry.sh`, which retries the transient cross-repo blob-mount
failure a long-lived Docker daemon can hit (#1205).

See `.gitlab-ci.yml` around the `.kaniko-push-common`, `.arm64-docker-push-base`, and
`.manifest-tool-common` templates for the full history in comments — this page summarizes it,
the CI file is the source of truth for the current job definitions.

### Fail-loud, not hang: why a preflight job instead of a `timeout:`

A job's `timeout:` only bounds execution time *after* a runner has picked it up — it does
nothing for a job stuck `pending` because no runner matches its `tags:`. GitLab has no native
"pending too long" job failure. `arm64-runner-preflight` queries the **group** Runners API
(`GET /groups/visiban/runners?scope=online&tag_list=arm64` — a different read from the
project-scoped `glab api "projects/visiban%2Fvisiban/runners?type=group_type"` performed by
hand above, though both surface the same group runner) and fails immediately if it finds no
online `arm64`-tagged runner, before `backend-docker-push-arm64` /
`frontend-docker-push-arm64` are even scheduled. This needs `RUNNER_STATUS_TOKEN`, a
fine-grained PAT with the `read_runner` permission scoped to the `visiban` group — the Runners
API is not part of GitLab's CI_JOB_TOKEN-allowed endpoint set, so a job token can't make this
call. See [Tokens and Rotation](tokens-and-rotation.md#runner_status_token).

## Distributed CI cache (MinIO)

The `.npm-cache` / pip cache templates use a MinIO S3-compatible backend so all runners share
a warm cache (`.gitlab-ci.yml`, "Cache templates" section). This requires both:

1. `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` as GitLab CI/CD
   project variables (masked + protected) — see
   [Tokens and Rotation](tokens-and-rotation.md).
2. Each self-hosted runner's own `config.toml` configured with a matching
   `[runners.cache.s3]` block that *references* those variables, not literal values.

Runner `config.toml` lives on the runner VM's disk, outside GitLab's variable masking. It
previously had the MinIO access key and secret key hardcoded directly in that file
(confidential issue **#141**, closed) instead of interpolated from environment variables.
The current `.gitlab-ci.yml` comments show the fixed form (`AccessKey = "<MINIO_ACCESS_KEY>"`
placeholders resolved via env interpolation), and the corresponding `MINIO_*` CI variables
are now present and masked — consistent with the issue's recommended fix having been applied.
If you provision a new runner, confirm its `config.toml` interpolates these variables rather
than hardcoding credentials again.

## Keycloak / OIDC smoke test

`oidc-smoke` doesn't depend on the self-hosted runner, but its failure mode is easy to
misdiagnose as one — see [Known CI Failures](known-ci-failures.md#oidc-smoke-did-not-become-ready-within-240s)
for the actual root cause (an IPv6/HTTPS-required mismatch, not a slow boot or a runner
problem).

## Dependency Proxy

Every Docker Hub `image:`/`services:` reference in `.gitlab-ci.yml`
(and the kaniko `FROM` pulls, via each Dockerfile's `BASE_REGISTRY` build arg) resolves through
`${DOCKERHUB_MIRROR}` rather than pulling `docker.io` anonymously — see
[Known CI Failures](known-ci-failures.md#docker-hub-429-too-many-requests-on-image-pulls)
(#1198) for why. This requires:

1. **The Dependency Proxy enabled for the `visiban` group** — Settings → Packages and
   Registries → Dependency Proxy. This is a one-time, human-applied group setting; nothing in
   this repo can turn it on, and a fresh group (or a self-hosted GitLab instance forking this
   project) needs it enabled before CI will go green.
2. **No runner configuration change for `image:`/`services:` pulls** — the runner
   authenticates to `${DOCKERHUB_MIRROR}` (which resolves to
   `${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}` by default — see below) automatically using the
   predefined `CI_DEPENDENCY_PROXY_*` variables GitLab injects into every job; there is nothing
   to add to a runner's `config.toml` for this.
3. **A job that pulls images itself, rather than via `image:`/`services:`, must log in
   explicitly.** kaniko's `/kaniko/.docker/config.json` and the helm-drill `docker:dind`
   daemon (`.helm-drill-base` before_script:
   `echo "$CI_DEPENDENCY_PROXY_PASSWORD" | docker login "$CI_DEPENDENCY_PROXY_SERVER" -u
   "$CI_DEPENDENCY_PROXY_USER" --password-stdin` — `--password-stdin`, never `-p`, which leaves
   the token readable in the container's own process list) both do this, guarded on
   `CI_DEPENDENCY_PROXY_SERVER` being non-empty (see point 4). A new job added later that shells
   out to `docker pull`/`docker build` against a Docker Hub image needs the same treatment, or
   it will silently fall back to an anonymous pull.
4. **Forks and self-hosted instances with no working group Dependency Proxy need a project
   variable.** The Dependency Proxy is a **group-level-only** GitLab feature — it does not exist
   for personal namespaces at all — so `CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX` (and
   `CI_DEPENDENCY_PROXY_SERVER`/`_USER`/`_PASSWORD`) are empty on, most notably, an external
   contributor's personal-namespace fork pipeline. `.gitlab-ci.yml`'s top-level `variables:`
   defines `DOCKERHUB_MIRROR: ${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}`; a `script:`/
   `before_script:` usage of it (the kaniko jobs' `--build-arg BASE_REGISTRY`,
   `scripts/helm-install-drill.sh`, `scripts/helm-netpol-drill.sh`) falls back automatically with
   real shell syntax (`${DOCKERHUB_MIRROR:-docker.io/library}`), because those run in an actual
   shell. The bare `image:`/`services:`/`name:` keyword usages **cannot** self-heal this way —
   GitLab's variable expansion for those keywords is plain substitution, with no equivalent of
   bash's `:-` fallback operator — so with an empty `DOCKERHUB_MIRROR` they'd resolve to a
   leading-slash `/python:3.12-slim` and fail outright. A fork or self-hosted project without a
   working group Dependency Proxy **must** set its own project CI/CD variable
   `DOCKERHUB_MIRROR` (Settings → CI/CD → Variables) — e.g. `docker.io` to pull Docker Hub
   directly (project variables take precedence over the `.gitlab-ci.yml` default), or its own
   pull-through mirror.

Third-party registries (`quay.io`'s Keycloak image, `ghcr.io`/`gcr.io` for trivy/kaniko,
`mcr.microsoft.com`'s Playwright image) are out of scope — GitLab's Dependency Proxy only
mirrors Docker Hub, so these keep pulling directly regardless of `DOCKERHUB_MIRROR`.

**arm64 release jobs covered as of #1204.** `.arm64-docker-push-base`,
`backend-docker-push-arm64`, and `frontend-docker-push-arm64` (#1084, see "Docker image push"
above) were left out of #1198's initial rollout: they were being rewritten by the separate
**!964** (arm64 release-token and push-safety hardening), and applying the mirror there first
would have conflicted with that work. !964 has since merged, so #1204 wires these jobs up the
same way as everything else in this section — both `docker build` calls now pass
`--build-arg BASE_REGISTRY="${DOCKERHUB_MIRROR:-docker.io/library}"`, same as the amd64 kaniko
legs.

Because these jobs run on `Max1-Runner-Visiban`'s **shell executor** against a real, persistent
Docker daemon rather than kaniko's disposable `/kaniko/.docker/config.json`, they can't rely on
a build-time credential file the way kaniko does — they authenticate the same way they already
authenticate to `$CI_REGISTRY` and `ghcr.io`: `.arm64-docker-push-base`'s `before_script` runs
`docker login "$CI_DEPENDENCY_PROXY_SERVER" -u "$CI_DEPENDENCY_PROXY_USER" --password-stdin`
before either build, guarded on `CI_DEPENDENCY_PROXY_SERVER` being non-empty (empty on a fork
with no working group Dependency Proxy, where the `${DOCKERHUB_MIRROR:-docker.io/library}`
shell fallback already routes the build to Docker Hub directly and needs no login). If the
variable is set but the login itself fails, the job fails loud (`set -eu`) rather than quietly
falling back to an anonymous pull mid-release. `backend-docker-push-arm64` /
`frontend-docker-push-arm64`'s `after_script` blocks each log back out of the proxy
(`docker logout "$CI_DEPENDENCY_PROXY_SERVER" || true`, guarded the same way and tolerant of
never having logged in), alongside the existing `$CI_REGISTRY`/`ghcr.io` logouts — this
persistent shared host must not accumulate registry credentials between releases.

## Related open items

- **#1084** — resolved: native arm64 image publishing restored via `Max1-Runner-Visiban` +
  `manifest-tool`. Acceptance criteria (multi-arch `:<tag>`/`:latest`/`:MAJOR.MINOR` on both
  registries) are verified at the next release tag pipeline, not by this change alone.
- **#1204** — resolved: the arm64 release jobs' base-image pulls now route through
  `${DOCKERHUB_MIRROR}` like every other Docker Hub pull in this file (see "Dependency Proxy"
  above). Like #1084, full verification (a clean release-tag pipeline with no anonymous Docker
  Hub pulls from the arm64 runner) only happens at the next release tag — these jobs don't run
  on MR pipelines.
