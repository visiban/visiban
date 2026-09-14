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

All three are self-hosted, carry **no tags**, and accept untagged jobs. Re-run the query
above before trusting this table — runner health and identity have changed multiple times
in this project's history (see below) and nothing keeps this page in sync automatically.

!!! warning "No job in `.gitlab-ci.yml` uses `tags:`"
    Every job — including ones that need a specific runner's local resources — queues for
    *any* available runner, self-hosted or GitLab SaaS. When a self-hosted runner goes
    offline, jobs that depended on something only it provides don't fail loudly with "no
    runner available" — they get scheduled onto a SaaS runner instead and fail with a
    confusing error from deep inside the job script. This has already happened once (see
    "Docker push" below). If a job needs the self-hosted runner specifically, add a `tags:`
    selector to make the dependency explicit rather than relying on the untagged runners
    happening to be healthy.

## Docker image push — no longer needs a self-hosted runner

`backend-docker-push` / `frontend-docker-push` (`.kaniko-push-common` in `.gitlab-ci.yml`)
build and push with **kaniko**, which needs no Docker daemon and runs on any runner.

This wasn't always true. Before the kaniko conversion (merged in **!852**, 2026-09-14), these
jobs ran `docker buildx` against a Docker socket mounted by a self-hosted runner's
`config.toml` (`volumes = ["/var/run/docker.sock:/var/run/docker.sock"]`). That runner (the
"nuc runner", group runner id `53511568`) went stale on **2026-07-18**. Because the jobs
carried no `tags:`, every push after that date silently fell through to a GitLab SaaS runner
and failed with `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`. The
last successful push before the conversion was **2026-06-26**.

kaniko removes this single point of failure for **amd64**. It does not fix everything:

- **arm64 is currently not published.** kaniko cannot cross-build, and
  `saas-linux-medium-arm64` resolves to `no_matching_runner` on this project's GitLab plan
  (verified on pipeline `2845582400`). The buildx path being replaced emitted `linux/arm64`
  via QEMU emulation on the self-hosted runner; that capability is gone until a native arm64
  runner exists. Tracked in **#1084**, milestone 1.2 — deliberately not re-added as a job
  here, since that would just hang release pipelines on `no_matching_runner` again.
- The runner IDs in the table above (`56277672`, `56277916`) are **not** the same runner as
  the stale `53511568` — they were (re-)registered on 2026-09-14. Do not assume the old
  "Runner-03-NUC" staleness note still describes the current runner with that name.

See `.gitlab-ci.yml` around the `.kaniko-push-common` and `backend-docker-push` /
`frontend-docker-push` jobs for the full history in comments — this page summarizes it, the
CI file is the source of truth for the current job definitions.

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

## Related open items

- **#1084** (milestone 1.2) — restore native arm64 image publishing once an arm64-capable
  runner exists.
