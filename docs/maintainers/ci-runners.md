# CI Runners

Inventory and behavior of the GitLab Runners that execute Visiban's pipelines, and the traps
that follow from how they're configured.

## Inventory

As of 2026-09-27, five GitLab group runners are registered against `visiban/visiban`
(`glab api "groups/visiban/runners?type=group_type"`):

| Runner ID | Description | Status | Tags | `run_untagged` |
|---|---|---|---|---|
| 52215741 | (none set) | offline | none | true |
| 56277672 | `Runner-03-NUC` | online | none | true |
| 56277916 | `runner-04-NUC` | offline | none | true |
| 56787877 | `gitlab-runner-nuc-2-visiban` | online | none | true |
| 56802474 | `Max1-Runner-Visiban` | online | `arm, arm64, apple, macosx, mac, ios` | **false** |

The first four are self-hosted Linux (NUC) boxes carrying **no tags** and accepting
untagged jobs, same as the original three. **`Max1-Runner-Visiban` (56802474) is different
on purpose** — added 2026-09-27 specifically to restore native arm64 image publishing
(#1084), it's a persistent Apple Silicon (M1 Max / T6000) Mac running Docker Desktop, tagged
so only jobs that explicitly select it (`tags: [arm64]`) land there, and `run_untagged:
false` so it never silently picks up unrelated work. Re-run the query above before trusting
this table — runner health and identity have changed multiple times in this project's
history (see below) and nothing keeps this page in sync automatically.

!!! warning "GitLab's runner-metadata `architecture` field is wrong for `Max1-Runner-Visiban`"
    `GET /runners/56802474` reports `"platform":"darwin","architecture":"amd64"` — that is
    the installed `gitlab-runner` binary being the amd64 build running under Rosetta 2 on
    Apple Silicon hardware, not a statement about what the runner can build. Verified
    2026-09-27 with a throwaway probe job (`ci:arm64-runner-probe`, MR !960, closed
    unmerged): Docker Desktop's engine on that host is genuinely native `linux/arm64` — a
    `docker build` + `docker image inspect --format '{{.Architecture}}'` returned `arm64`,
    no QEMU. **Don't use the API's `architecture` field to sanity-check this runner** — build
    something and inspect it instead, the same way `scripts/check-arm64-runner.sh` and the
    `arm64-runner-check` CI job check it's *online* rather than trusting metadata.

!!! warning "Only one job family uses `tags:` — everything else still doesn't"
    Before #1084, no job in `.gitlab-ci.yml` used `tags:` at all: every job queued for *any*
    available runner, self-hosted or GitLab SaaS. When a self-hosted runner went offline,
    jobs that depended on something only it provides didn't fail loudly with "no runner
    available" — they got scheduled onto a SaaS runner instead and failed with a confusing
    error from deep inside the job script. This happened once already (see "Docker push"
    below). #1084's `backend-docker-push-arm64` / `frontend-docker-push-arm64` (and their
    shared `.docker-publish-arm64-base`) are the **first** jobs to use `tags: [arm64]` — and
    because a `tags:`-selected job with no online match doesn't fail, it just queues forever,
    they're gated behind `arm64-runner-check`, which calls the GitLab Runners API to fail the
    pipeline fast instead. Every other job in this file is still untagged and still subject to
    the original warning above.

## Docker image push — amd64 (kaniko) + arm64 (native, #1084)

`backend-docker-push` / `frontend-docker-push` (`.kaniko-push-common` in `.gitlab-ci.yml`)
build and push the **amd64** leg with **kaniko**, which needs no Docker daemon and runs on
any runner.

This wasn't always true. Before the kaniko conversion (merged in **!852**, 2026-09-14), these
jobs ran `docker buildx` against a Docker socket mounted by a self-hosted runner's
`config.toml` (`volumes = ["/var/run/docker.sock:/var/run/docker.sock"]`). That runner (the
"nuc runner", group runner id `53511568`) went stale on **2026-07-18**. Because the jobs
carried no `tags:`, every push after that date silently fell through to a GitLab SaaS runner
and failed with `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`. The
last successful push before the conversion was **2026-06-26**. kaniko removed that single
point of failure for amd64, but — being unable to cross-build — dropped arm64 entirely
(tracked in **#1084**) rather than leave a job that would hang on `saas-linux-medium-arm64`
resolving to `no_matching_runner` on this project's plan (verified on pipeline `2845582400`).

**arm64 is restored as of #1084**, on the group runner `Max1-Runner-Visiban` (56802474, tag
`arm64`) documented in the Inventory above — native `docker build` against that runner's own
Docker Desktop, gated by `arm64-runner-check` (fails the pipeline fast if the runner isn't
online, rather than letting a `tags:`-selected job queue forever), assembled into multi-arch
manifest lists by `docker buildx imagetools create`. See the "Docker push" comment block in
`.gitlab-ci.yml` (immediately above `.kaniko-push-common`) for the full per-arch + manifest
job design — this page summarizes it, the CI file is the source of truth.

Scoped to **release tags only** — ordinary main-branch merges still push amd64-only
`:latest`/`:<short-sha>` directly, same as before #1084 (running the native arm64 leg on
every merge would be expensive and isn't required by anything). One residual quirk this
implies: the GitLab-registry `:latest` tag is multi-arch immediately after a release tag,
then reverts to amd64-only on the next ordinary main merge until the next release. GHCR's
`:latest` isn't touched by main merges at all, so it stays multi-arch persistently between
releases.

The runner IDs in the Inventory table (`56277672`, `56277916`, `56787877`) are **not** the
same runner as the stale `53511568` — they were (re-)registered starting 2026-09-14. Do not
assume the old "Runner-03-NUC" staleness note still describes the current runner with that
name.

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

- **#1084** (milestone 1.2) — native arm64 image publishing restored (see "Docker image
  push" above). The manual `ghcr-push-backend`/`ghcr-push-frontend` on-demand jobs were
  removed as part of this, rather than left to silently overwrite the new multi-arch
  `:latest` with a single-arch amd64 image — see `.gitlab-ci.yml`'s "GHCR manual push —
  REMOVED" comment if an on-demand equivalent is needed again.
