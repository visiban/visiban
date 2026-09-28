# Known CI Failures

Failure signature → root cause → fix. Grep this page before re-deriving a diagnosis that's
already been done once.

## `oidc-smoke`: "did not become ready within 240s"

**Signature:** `oidc-smoke` job fails with `Keycloak master realm ... did not become ready
within 240s` (or whatever the current wait-timeout value is).

**Root cause:** this is **not** a slow boot, and raising the timeout will not fix it. GitLab's
CI service DNS returns both an A record and an IPv6 ULA (`fd76::/8`) for the `keycloak`
service alias, and glibc prefers IPv6. Reached over IPv6, Keycloak classifies the client as
*external* — `SslRequired.EXTERNAL` only recognizes IPv4 private ranges as local — so the
master realm's default `sslRequired=external` immediately refuses plain HTTP with:

```
403 {"error":"invalid_request","error_description":"HTTPS required"}
```

Keycloak's own service log shows `started in 17s`-ish *before* polling even begins — always
check the service log (`CI_DEBUG_SERVICES: "true"` is already enabled on this job) before
trusting a "timeout" at face value. Pinning `/etc/hosts` does not help; the resolver still
returns both records.

**Fix:** address Keycloak by its resolved **IPv4 literal** (`getent ahostsv4 keycloak`),
substituted into both `KEYCLOAK_BASE` and `OIDC_SERVER_URL` so the provisioner and Django
agree on the issuer. This is already implemented in `scripts/oidc_provision.py` and
`.gitlab-ci.yml`'s `oidc-smoke` job (see the `before_script` comment there) as of **!853**
— `oidc-smoke` went from a ~5 minute failure to green in 1m36s. If this regresses, check
that the IPv4-literal substitution wasn't reverted.

**What hid this for six weeks:** `_wait_for_url` in `scripts/oidc_provision.py` had a bare
`except Exception: pass`, so every failure mode looked identical, and someone had already
raised the timeout 120→240s on the (wrong) slow-boot assumption before the real cause was
found.

## Docker push: `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`

**Signature:** `backend-docker-push` or `frontend-docker-push` fails with this Docker daemon
connection error.

**Root cause (historical, pre-**!852**):** these jobs ran `docker buildx` against a Docker
socket mounted only by a specific self-hosted runner's `config.toml`. The jobs carried no
`tags:`, so once that runner went stale (2026-07-18), the jobs silently scheduled onto a
GitLab SaaS runner with no Docker socket at all.

**Fix:** the jobs were converted to **kaniko** in !852, which needs no Docker daemon and runs
on any runner — this failure mode should no longer occur for amd64 pushes. If you see this
error again, something has regressed the job definition back toward `docker buildx`; check
`.gitlab-ci.yml`'s `.kaniko-push-common` template first. See
[CI Runners](ci-runners.md#docker-image-push-amd64-via-kaniko-arm64-via-a-dedicated-runner)
for the full history, including how the arm64 gap this conversion left open was closed in
**#1084**.

## arm64 Docker push jobs pending forever with no runner picking them up

**Signature:** `backend-docker-push-arm64` / `frontend-docker-push-arm64` sit `pending`
indefinitely on a release tag pipeline, with no error — or `arm64-runner-preflight` fails
with "no online runner tagged 'arm64' found".

**Root cause:** the dedicated Apple Silicon runner (`Max1-Runner-Visiban`, id `56802474`,
see [CI Runners](ci-runners.md#inventory)) is offline or its `arm64` tag was removed. GitLab
has no native "pending too long" job failure — a job `timeout:` only covers execution time
once a runner has picked up the job, not queue time — so without a preflight check, this
looks identical to a slow pipeline rather than an infrastructure problem. This is the same
`no_matching_runner` shape that caused `saas-linux-medium-arm64` to hang before !852 dropped
arm64 from the kaniko conversion (verified on pipeline `2845582400`).

**Fix:** `arm64-runner-preflight` (added in **#1084**) queries the Runners API before either
arm64 leg is scheduled and fails within seconds with a clear message if no runner tagged
`arm64` is online, instead of letting the pipeline hang. If it fires, bring the runner back
online (check the host's power/network and that the `gitlab-runner` service is running) and
re-run the pipeline — do not raise a job `timeout:` to work around this, it will not help.
If the preflight job itself fails with a `RUNNER_STATUS_TOKEN`-related error, see
[Tokens and Rotation](tokens-and-rotation.md#runner_status_token).

**Do not misread the runner's reported architecture:** GitLab's Runners API reports
`architecture: amd64` for this runner (the `gitlab-runner` binary runs under Rosetta) even
though the host and every image it builds are genuinely native arm64 — this is a red herring,
not evidence the wrong runner picked up the job.

## Self-hosted runner job aborted: "Possibly zombie container ... disconnected from network bridge"

**Signature:** a job scheduled on a self-hosted NUC runner (e.g. `backend-test-git-lens`) is
aborted before any script line runs, with a GitLab Runner message resembling `Possibly zombie
container ... disconnected from network bridge` in the job trace.

**Root cause:** a transient Docker networking fault on the runner host itself — the
container's network bridge connection was lost between container creation and script start.
Not caused by the job's own script or test code.

**Fix:** retry the job. Observed once during the review of the change that added
`backend-test-git-lens` to every backend MR pipeline (rather than only `git_lens`-touching
ones) — it passed cleanly on retry with no code change. If this recurs frequently rather than
as an isolated event, check the runner's health (`glab api
"projects/visiban%2Fvisiban/runners?type=group_type"`, or a specific runner's
`glab api "runners/<id>"`) before assuming it's a code regression — see
[CI Runners](ci-runners.md#inventory).

**Why this matters more now:** `backend-test-git-lens` moved from running only on `git_lens`
changes to running on every `backend-test-coverage` run, so the self-hosted runner is drawn
on roughly 3x more often than before. A previously-rare transient failure mode becomes a
more visible source of pipeline noise.

## `backend-schema-fuzz` failing intermittently — this is NOT a known flake

**Signature:** `backend-schema-fuzz` is red on one pipeline and green on the next, on an
endpoint the MR never touched, e.g. `Undocumented HTTP status code` on a `POST`/`PUT`, or a
`500` on `POST /api/v1/groups/`.

**Root cause:** a real defect (or an undocumented response) that only some random seeds reach.
The job draws a fresh seed each run; a failing case is deterministic for its input, so a green
re-run means a different seed did not hit it — not that the code is fine. On 2026-09-26 three
main pipelines were red for exactly this reason (#1165).

**Fix:** do **not** retry it and do not add a `schemathesis-baseline.json` entry. Read the job's
`FAILURES` section (operation, status, `Test Case ID`) and the `seed=` line the job prints. A
5xx is an endpoint bug; an undocumented 4xx needs the response declared; a schema mismatch needs
the serializer or annotation fixed. Replay with the pipeline variable `FUZZ_SEED=<n>` or
`st replay <id>`. Full triage steps: [`docs/api/openapi.md`](../api/openapi.md#a-red-backend-schema-fuzz-job-is-never-a-flake).
Known still-open defects it can hit: #1166.
