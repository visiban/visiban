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

**Where the Django server output is:** `oidc-smoke` redirects `runserver` output to the
`oidc-smoke-server.log` job artifact (developer-only, 1 week) rather than the job log, and
prints the last 200 lines of it on failure (#1611). Check the artifact if the smoke test
reports a callback or session error that the job log does not explain.

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
the serializer or annotation fixed. Replay on an MR with a `Fuzz-Seed: <n>` trailer on an empty head commit
(or the pipeline variable `FUZZ_SEED=<n>` off MRs), or with `st replay <id>`. Full triage steps: [`docs/api/openapi.md`](../api/openapi.md#a-red-backend-schema-fuzz-job-is-never-a-flake).
Known still-open defects it can hit: #1166.

## Docker Hub `429 Too Many Requests` on image pulls

**Signature:** a job fails resolving a Docker Hub image, e.g.

```
ERROR: failed to solve: python:3.12-slim: failed to resolve source metadata for
docker.io/library/python:3.12-slim: unexpected status from HEAD request to
https://registry-1.docker.io/v2/library/python/manifests/3.12-slim: 429 Too Many Requests
```

Observed on `helm-install` and `helm-netpol` (job 16766757152/153, 2026-09-27), but the same
signature can surface on any job that pulls a Docker Hub image — a runner `image:`/`services:`
entry, a kaniko `FROM`, or a live pull inside a `helm-install`/`helm-netpol` kind cluster.

**Root cause:** self-hosted runners pull Docker Hub images **anonymously** from a shared IP,
which hits Docker Hub's anonymous-pull rate limit. The helm drills are the worst offender:
each one boots a fresh `docker:dind` daemon with no credentials and no image cache, then pulls
the full base-image + `kindest/node` + in-cluster (postgres/valkey) set again from the runner's
IP.

**Fix (#1198):** every `image:`/`services:` entry in `.gitlab-ci.yml` that points at Docker Hub
now resolves through `${DOCKERHUB_MIRROR}/<image>`, which defaults to the GitLab Dependency
Proxy prefix
(`${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}`) and which the runner authenticates to
automatically, provided the runner host has no stale `gitlab.com` Docker credentials of its own
(see the Access denied section below). The Dockerfiles take a `BASE_REGISTRY` build arg (default
`docker.io/library`, unchanged for local/contributor builds) that CI's kaniko jobs point at the
same mirror. The
`.helm-drill-base` before_script logs the dind daemon itself in to
`$CI_DEPENDENCY_PROXY_SERVER` (skipped when that's empty — see below), and
`scripts/helm-install-drill.sh` / `scripts/helm-netpol-drill.sh` pull `kindest/node` and the
in-cluster postgres/valkey/busybox images through the mirror before side-loading them with
`kind load docker-image`, so nothing inside the kind cluster does a live Docker Hub pull either.

**Requires:** the Dependency Proxy enabled for the `visiban` group (Settings → Packages and
Registries → Dependency Proxy) — a one-time, human-applied group setting, not something a
pipeline can turn on. If this signature reappears, check that setting first before assuming the
proxy rewrite regressed. Third-party registries (`quay.io`, `ghcr.io`, `gcr.io`,
`mcr.microsoft.com`) are **not** routed through the proxy — GitLab's Dependency Proxy only
mirrors Docker Hub — so a 429 from one of those is a different problem. See
[CI Runners](ci-runners.md#dependency-proxy) for the runner-side requirement.

**On a fork or self-hosted instance:** the Dependency Proxy is a group-level-only GitLab
feature — it doesn't exist for personal namespaces — so a personal-namespace fork pipeline gets
`CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX` (and therefore `DOCKERHUB_MIRROR`) empty. `image:`/
`services:`/`name:` YAML keyword usages of `DOCKERHUB_MIRROR` cannot fall back on their own (no
shell, no `:-` operator); set a project CI/CD variable `DOCKERHUB_MIRROR=docker.io` (or your own
mirror) to fix those. `BASE_REGISTRY`/script usages fall back to `docker.io/library`
automatically with no configuration needed. See
[CI Runners](ci-runners.md#dependency-proxy) point 4 for the full explanation.

**arm64 release jobs (#1204):** the arm64 release jobs (`.arm64-docker-push-base`,
`backend-docker-push-arm64`, `frontend-docker-push-arm64`, #1084) were deliberately left out of
the initial #1198 rollout — they were being rewritten by the separate !964, and !964 has since
merged. Both jobs' `docker build` calls now pass the same
`--build-arg BASE_REGISTRY="${DOCKERHUB_MIRROR:-docker.io/library}"` the amd64 kaniko legs use.
Because these run on a real Docker daemon (shell executor) rather than kaniko, they need their
own `docker login "$CI_DEPENDENCY_PROXY_SERVER"` in `before_script` (guarded on that variable
being non-empty) and a matching `docker logout` in `after_script` — see
[CI Runners](ci-runners.md#dependency-proxy) for the full detail.

## Image pull `HTTP Basic: Access denied` from the Dependency Proxy on one runner

**Signature:** jobs fail with `failure_reason: runner_system_failure` in `prepare_executor`,
before any script runs, and the log shows the runner using host credentials rather than the
job's:

```
Authenticating with credentials from /root/.docker/config.json
Pulling docker image gitlab.com:443/visiban/dependency_proxy/containers/node:22-alpine ...
WARNING: Failed to pull image ... HTTP Basic: Access denied
ERROR: Job failed: failed to pull image ...
```

Observed 2026-11-19 on `gitlab-runner-nuc-2-visiban` (runner id 56787877): about 35 jobs failed
and reddened !1950, !1951 and !1952 (#2406). The same jobs passed on retry on another runner.

Recurred 2026-11-20 on the same runner, reddening `frontend-lint` on !1961 and
`frontend-license-check` on !1958. The host's `/root/.docker/config.json` held exactly one
`auths` key, `gitlab.com:443`. After the runner was paused and that key removed, the runner was
unpaused and a `node:22-alpine` job (`frontend-license-check`) started on it and got past the
image pull. The recurrence means the stale entry is re-created by something on the host (a manual
`docker login gitlab.com:443`, for example); if it returns, find what writes it rather than
deleting it again.

**Confirm it is one runner:** the identical job passes when it lands on a different runner, and
the failures cluster on one `runner.description`:

```bash
glab api "projects/:id/jobs?scope[]=failed&per_page=60" \
  | jq -r '.[] | select(.failure_reason=="runner_system_failure") | .runner.description' \
  | sort | uniq -c
```

**Root cause:** the runner host's `/root/.docker/config.json` holds a stale `gitlab.com:443`
(or `gitlab.com`) auth entry. GitLab Runner prefers credentials found there over the job-scoped
`CI_DEPENDENCY_PROXY_*` credentials, so every Dependency Proxy pull uses the dead credential.
This cannot be fixed in `.gitlab-ci.yml`, and a runner that shares a tag with healthy runners
cannot be routed around.

**Fix:**

1. Pause the runner so jobs stop landing on it:
   `glab api --method PUT runners/<id> -f paused=true`.
2. On the host, inspect which registries have entries by listing the `auths` keys only
   (`jq '.auths | keys' /root/.docker/config.json`). Never print the values; they are
   credentials. Remove the stale `gitlab.com:443`/`gitlab.com` entry, or delete the file if
   nothing else uses it.
3. Unpause (`-f paused=false`) and confirm a `node:22-alpine` job such as `frontend-test`
   passes on that runner.

Retrying without the host fix only works when the job happens to land on a different runner; it
re-fails every time the broken runner picks it up. See
[CI Runners](ci-runners.md#dependency-proxy) point 2 for the runner-side precondition.

## `helm-publish`: `cosign sign` fails with `UNAUTHORIZED: authentication required`

**Signature:** `helm-publish` job fails after `helm push` has already succeeded — the chart is
visible in the registry, but the job still fails at the `cosign sign` step:

```
Pushed: ghcr.io/visiban/charts/visiban:0.6.0
Digest: sha256:...
Error: signing [ghcr.io/visiban/charts/visiban@sha256:...]: accessing image: GET
https://ghcr.io/token?...: UNAUTHORIZED: authentication required
```

**Root cause:** the job runs `helm registry login ghcr.io` before `helm push`, but never logs
cosign in separately. `helm registry login` only populates Helm's own registry config; cosign
resolves registry auth through go-containerregistry's default keychain (the Docker/OCI
credential store), which `helm registry login` never touches. The two tools simply don't share
a credential store, so `cosign sign` fails closed even though `helm push` — authenticated via a
completely separate path — succeeds moments earlier. This was invisible until `v1.2.0-alpha.2`'s
tag pipeline, the first one where the `appVersion` check (#1268) let execution reach this far.

**Fix:** add `printf '%s' "$GHCR_TOKEN" | cosign login ghcr.io -u "$GHCR_USER" --password-stdin`
alongside the existing `helm registry login` line, before `helm package`/`helm push`/`cosign
sign` (#1284, `.gitlab-ci.yml`'s `helm-publish` job).

**Note:** every chart published before this fix (including `v1.2.0-alpha.2`'s
`ghcr.io/visiban/charts/visiban:0.6.0`) is unsigned — the fix does not retroactively sign an
already-pushed chart. If this signature reappears, check that the `cosign login` step wasn't
dropped in a later edit to the job.

## `backend-image-attest` / `frontend-image-attest` fails on a release tag

**Signature:** one of the `*-image-attest` jobs (#1153) fails after `*-manifest` succeeded.
The multi-arch images are already live under their real tags on both registries. What is
missing is some or all of their signatures and SBOM attestations. `helm-publish` needs both
attest jobs, so **the chart is not published** for this release until they pass.
`github-release` needs only the guard and the push and manifest jobs, not the attest jobs, so
the GitHub Release is **not** blocked and may already exist.

**Read the log first.** `scripts/attest-image-sbom.sh` names the failing registry, digest and
check. Common causes:

- `refusing to sign/attest ... SIGSTORE_ID_TOKEN is not set`: the job lost its
  `id_tokens:` block (inherited from `.image-attest-common`).
- `UNAUTHORIZED` from cosign or syft: `GHCR_USER`/`GHCR_TOKEN` missing or expired, or the
  Docker config written in `before_script` was dropped. crane, syft and cosign all read
  `~/.docker/config.json`. This is the same class as the `helm-publish` entry above.
- `not a multi-arch index` / `no single linux/arm64`: the manifest job published something
  other than a two-platform list. Fix that first. Do not attest a half-covered release.
- `lists packages for foreign architecture(s)` or `image config says ...`: a platform
  entry in the index points at the wrong image. Treat this as a release defect, not a flake.
- `returned no attestations` right after `cosign attest`: the registry accepted the push
  but serves nothing back. Usually transient (registry or Rekor). Retry once.
- Sigstore (Fulcio/Rekor) outage: wait and retry.

**First run after merge.** The self-test stubs syft, cosign and crane, so their real
contracts are first exercised on the first release tag cut after #1153 merges. A failure
there most likely means one of these four assumptions was wrong:

1. syft's `--source-name`/`--source-version` set `metadata.component.name`/`.version` in
   the CycloneDX output. These were confirmed with syft 1.51.1 against `v1.2.0-alpha.4`, but
   only from a workstation.
2. Package purls carry an `arch=` qualifier (`?arch=amd64`/`aarch64`/...), which the
   foreign-arch check depends on.
3. `cosign attest --type cyclonedx` embeds the SBOM as a JSON **object** in the in-toto
   statement's `predicate`, not as a string.
4. `cosign verify-attestation` prints one DSSE envelope per line on stdout, each with a
   base64 `payload`.

Recovery: fix forward on a branch, then re-run the failed `*-image-attest` job on the tag
pipeline. Its skips make a re-run safe. The images are already live under their real tags,
so nothing is rolled back. `helm-publish` stays blocked until both attest jobs are green, so
the chart ships late rather than pointing at unverifiable images. If the tag pipeline can no
longer be re-run, use the backfill job (below).

**Retrying is safe.** On a tag pipeline the script skips any digest that already carries a
verifying signature or SBOM from a **release tag** identity, and logs which identity matched.
A retry therefore finishes only what is missing and stacks no duplicates. A signature left
by the backfill job (`@refs/heads/main`) does not count, so the tag job signs over it and
the release still verifies with the tag-only regexp. The backfill job accepts either
identity. The script's `--force`
flag re-attests digests that already verify, for example after a bad SBOM was attached. No CI
job passes it, so using it takes a deliberate one-off change on a branch. It is never a
routine retry.

**If the tag pipeline can't be retried** (e.g. it was canceled or its jobs expired), run the
manual `image-attest-backfill` job on `main` with `BACKFILL_TAG=<tag>`. Its identity ends in
`@refs/heads/main`, so that release must then be verified with the backfill regexp in
`docs/administration/image-verification.md`. Backfill is trust-on-first-use: before running
it, compare the tag's current digests (`scripts/attest-image-sbom.sh --image <img> --tag <tag>
--dry-run`) with the release pipeline's `*-manifest` log. Then publish the chart by retrying
`helm-publish`.

## `release-main-pipeline-guard` refuses to publish a release tag

**Signature:** on a `v*` tag pipeline, `release-main-pipeline-guard` (#1154) fails with
`REFUSED: ...`, and every publish job (`*-docker-push`, `*-docker-push-arm64`,
`*-manifest`, `*-image-attest`, `helm-publish`, `github-release`, `docs-deploy`) is
`skipped`.

**What already happened, and what did not.** The guard gates only the tag pipeline's own
jobs. For a tag cut by `scripts/release.sh`, these happened before or beside the tag pipeline
and are **not** undone by a refusal:

- The git tag exists on GitLab, and the push mirrors have already copied it to GitHub and to
  the enterprise repository.
- `release.sh` created the **GitLab Release** for the tag, with its notes, right after pushing
  the tag.
- For a stable (non-pre-release) tag, `release.sh` closed the milestone's remaining open
  issues.
- `release.sh` printed `Release <tag> is live`. That message only means it finished. It does
  not wait for the tag pipeline.
- **The versioned docs are not live.** `release.sh` sets `APP_VERSION=<tag>` in `.env.example`
  and edits `docs/`, so the release merge's own `main` pipeline runs `docs-deploy`, but that
  run skips a version whose tag is not on origin yet (`resolve-docs-version.sh --require-tag`,
  #1997) and deploys nothing. Only the tag pipeline's `docs-deploy`, which waits for the
  guard, publishes the versioned docs, so a refusal leaves them unpublished. The refused tag stays
  on origin, but `--require-tag` also requires the tag pipeline's `release-main-pipeline-guard`
  job to be `success`, so a later `docs/**` or `mkdocs.yml` push to `main` skips that version
  (#2398). It fails closed: a failed or unreadable status lookup fails the `main` `docs-deploy`
  job rather than deploying. A docs edit pushed to `main` while the guard is still pending is skipped, and the tag pipeline then deploys from the tag commit, so re-run `docs-deploy` on `main` after the tag pipeline finishes.

What the refusal **did** stop, one tag-pipeline job each:

| Job | What it would have published |
|---|---|
| `backend-docker-push`, `frontend-docker-push` | `<tag>-amd64` images on the GitLab registry and GHCR (intermediate tags) |
| `backend-docker-push-arm64`, `frontend-docker-push-arm64` | `<tag>-arm64` images on both registries (intermediate tags) |
| `backend-manifest`, `frontend-manifest` | the real `:<tag>` multi-arch images on both registries, plus `:latest` and `:MAJOR.MINOR` for a stable tag |
| `backend-image-attest`, `frontend-image-attest` | the cosign signatures and SBOM attestations |
| `helm-publish` | the signed Helm chart |
| `github-release` | the **GitHub** Release |
| `docs-deploy` | the versioned docs: `<tag> v<MAJOR.MINOR> latest` plus `set-default` for a stable tag, or `<tag> next` for a pre-release |

So the GitLab Release page names a version whose images cannot be pulled yet.
Treat the refusal as an open incident, not a quiet failure.

**What to do:** fix the cause from the table below, then retry the guard job in the same tag
pipeline. GitLab re-runs the publish jobs it skipped, under the same tag, and nothing needs
re-tagging. If the release has to be abandoned instead:

1. Delete the GitLab Release and the tag. The mirrors carry the deletion.
2. Reopen the milestone if it was closed.
3. Nothing to roll back in the docs: the versioned docs are published only by the tag
   pipeline after the guard (#1997), so a refused release never reached `gh-pages`, unless a
   manual deploy ran (a docs push to `main` after the refusal skips the version, because the
   tag's guard job is not `success`; #2398). If a docs deploy for the tag ran anyway (for example a manual `DOCS_VERSION=<tag>` run on
   `main`), remove it with `mike delete --push <tag>` from a checkout with
   `docs/requirements.txt` installed and push access to `gh-pages`. For a stable tag, also
   point the aliases back at the previous stable version with
   `mike alias --push --update-aliases <previous-tag> latest v<previous MAJOR.MINOR>`, then
   `mike set-default --push v<previous MAJOR.MINOR>`. Docs versions and aliases are always
   `v`-prefixed (for example `v1.1.0` and `v1.1`); an unprefixed alias creates a stray
   duplicate entry (#1270).
4. Cut a new version once `main` is green.

**What the guard checks:** it finds the newest `main` pipeline at the tagged commit (source
`push` or `web`; nightly `schedule` pipelines at the same commit are ignored, they run a
different job set) and reads its jobs, not its top-level status. Every job must be
`success` unless `scripts/wait-for-main-pipeline.py` lists it in `EXEMPT_JOBS` (cache
warmers, the `main` image pushes, `docs-deploy`, and the manual on-demand tools). A failed
`allow_failure: true` job counts as a failure here: a release does not ship over a red
`backend-lint`, `oidc-smoke` or SAST analyzer. The one tolerated failure is
`dep-scan-osv` exiting 2 (its MEDIUM/LOW warn tier). The jobs in `ALWAYS_REQUIRED` run on
every `main` pipeline, so a missing one refuses too. A change-conditional job (most lint and
drill jobs, #1266) may be absent when the merge did not touch its paths.

**Read the refusal line; each has one cause:**

| Refusal | Cause | Fix |
|---|---|---|
| `main pipeline N at <sha> is not green:` then a list of jobs | Those jobs failed, were canceled or skipped, or are still `manual` | Retry the failed job in that `main` pipeline (or fix forward and cut a new tag). Once it is green, retry `release-main-pipeline-guard` in the tag pipeline. GitLab re-runs the publish jobs it had skipped. |
| `main pipeline N at <sha> is not green:` and the jobs read `canceled` | A newer merge to `main` landed while that pipeline ran and auto-canceled its interruptible jobs (#2421; see [Superseded pipelines end `canceled`](#superseded-pipelines-end-canceled)). The guard still judges the tagged commit, never a newer one | Select **Retry** on that `main` pipeline, which re-runs its canceled jobs at the tagged commit. Once it is green, retry `release-main-pipeline-guard` in the tag pipeline. |
| `<job>: not in the main pipeline, but it runs on every main pipeline` | An `ALWAYS_REQUIRED` job was renamed or removed, or its `rules:` were narrowed in a way `--check-ci-file` could not detect | Fix the list in `scripts/wait-for-main-pipeline.py` on a branch, and **cut a new tag** once it merges. The guard reads its lists from the tagged commit, so retrying it on the old tag can never pass. The same applies to a refusal over a new `manual` job missing from `EXEMPT_JOBS`. On an MR, `--check-ci-file` catches both drifts: a renamed `ALWAYS_REQUIRED` job, or one whose main rule gained `changes:` or `when: manual`, and a job that can be `manual` on main without being exempt. |
| `no main pipeline for <sha> after Ns` | The tag points at a commit that never had a `main` pipeline, usually a tag on a feature branch or an unmerged commit | Tag the merge commit on `main`. `scripts/release.sh` does this for you. |
| `still waiting after Ns` | `main`'s pipeline did not finish within `MAIN_PIPELINE_GUARD_TIMEOUT_SECONDS` (default 2700) | Let `main` finish, then retry the guard job. |
| `asked to check <sha>, but the commit checked out here is <other>` | `CI_COMMIT_SHA` (or `--sha`) was overridden, for example by a pipeline variable, to point at a different commit. The guard only vouches for the commit the job checked out | Run the tag pipeline without overriding `CI_COMMIT_SHA`. A missing `.git` (`GIT_STRATEGY: none`) refuses the same way. |
| `GITLAB_API_TOKEN is not set` | The variable is missing (in this project; the enterprise mirror needs its own), or the tag is not protected, so the protected variable was not injected | Create it (see [Tokens and Rotation](tokens-and-rotation.md#gitlab_api_token-and-the-release-guard)), or protect the `v*` tag pattern. Then retry the guard job. |
| `could not read the main pipeline ... (a definitive API error)` | A 401/403/404 (any 4xx but 408/429): `GITLAB_API_TOKEN` expired, was revoked, or lacks `read_api`/Reporter. It refuses at once, since retrying cannot change it | Rotate the token (see [Tokens and Rotation](tokens-and-rotation.md#gitlab_api_token-and-the-release-guard)), then retry the guard job. |
| `could not read the main pipeline ... (N consecutive API failures)` | gitlab.com 5xx, 429 or a network error on `MAIN_PIPELINE_GUARD_MAX_API_ERRORS` (default 5) polls in a row | Retry the guard job. |

**There is no bypass variable, on purpose.** A flaky job is fixed by retrying it in the
`main` pipeline, which leaves a record of what ran. A variable that skips the check would
leave no such record. If an exemption is truly warranted (a new job that is not a check on
the code), add it to `EXEMPT_JOBS` with its reason on a branch, so the change is reviewed.

`scripts/release.sh` still checks the merge commit's pipeline before it tags. That check runs
on the maintainer's machine and reads the aggregate status. The guard runs in CI, so it also
covers tags pushed by hand.

## Superseded pipelines end `canceled`

**Signature:** an MR or `main` pipeline shows `canceled`, with most lint/test/security jobs
`canceled` and nobody having pressed Cancel. A newer pipeline on the same ref exists.

**Cause:** this is intended (#2419, #2421). `default: interruptible: true` plus
`workflow: auto_cancel: on_new_commit: interruptible` in `.gitlab-ci.yml` means a newer
commit on the same ref cancels the older pipeline's read-only jobs. On an MR that is a new
push to the branch. On `main` it is the next merge. Main is linear, so the newest `main`
pipeline tests a superset of the canceled one. The trade-off: during a merge burst a failure is
reported against the newest commit, not the merge that introduced it.

Jobs with an external side effect are `interruptible: false` and are never canceled once they
start: image, manifest and attestation pushes, `helm-publish`, `github-release`,
`docs-deploy`, `pages`, `cleanup-merged-branches`, `seed-demo-data`, `kaizen-yield-watch`,
`sonar:scan`, plus `release-main-pipeline-guard` (seconds on `main`; it is `docs-deploy`'s
only need), the kind/Compose drills, and the scheduled-only long jobs (`backend-mutation`,
`backend-mutation-report`, `nightly-load-test`, `backend-schema-fuzz-deep`).
`scripts/tests/ci-interruptible.test.sh` enforces the list. A non-interruptible job whose
`needs:` were canceled is skipped. For the `main` image pushes, that means a superseded
commit gets no `:<short-sha>` image, and the newer pipeline moves `:main` forward. Tag
pipelines are unique refs and are never superseded. A newer commit never cancels a
scheduled pipeline (`workflow:rules` sets `on_new_commit: none` on it).

**What to do:** nothing for an MR. For `main`, read the **newest** `main` push pipeline's
required jobs, not "every `main` pipeline is green". `/mass_merge`'s post-merge gate does that.
For a release, the guard judges the tagged commit's own pipeline, so retry the canceled jobs
there (see the `release-main-pipeline-guard` table above).

## Tool download `504 Gateway Time-out` (kind, kubectl, helm, yq, kubeconform, gitleaks, cosign, ...)

**Signature:** a job that installs a third-party binary (`helm-template`, `helm-install`,
`helm-netpol`, `dep-scan-osv`, `gitleaks-*`, the manifest/attest/publish jobs) fails with a
confusing downstream error such as `/usr/local/bin/yq: line 1: syntax error near unexpected
token '<'` or `kind: not found`. Upstream hosts (GitHub releases, `kind.sigs.k8s.io`,
`dl.k8s.io`, `get.helm.sh`) occasionally return a transient 504, and a plain retry goes green.

**Root cause:** the downloads used `curl -sSL` without `-f` (so the HTML error page was saved as
the binary), or sat in a `cmd && chmod` list or a `curl | tar` pipe that hid curl's exit status.
Separately, the `wget` jobs and the jobs that already used `-f` had no retry, so one transient 5xx
failed a required job (#2160).

**Fix (in place):** every tool download now runs `curl -fsSL --retry 3 --retry-all-errors
--retry-delay 5`, one step per script line, so a persistent failure stops the job at the
download line with curl's own error (`curl: (22) ... error: 504`). If you see that error after the
retries, the upstream is genuinely down or the pinned version URL is wrong; re-run later or fix
the version pin. New tool downloads in `.gitlab-ci.yml` must follow the same pattern.

## `main-red-guard` fails an MR: "main is red"

**Signature:** the `main-red-guard` job (#2460) fails with `ERROR: main is red: <job> failed in
main pipeline ...` and names the open **`main is red`** issue (label `ci`).

**Why it exists:** in the 2026-11-21 audit, `script-tests` stayed red on 7 consecutive `main`
pipelines while seven merges landed on top, because every MR pipeline was green. GitLab Free
has no merge trains or merged-results pipelines, so the brake is built from jobs:

- **Tripwire.** `main-red-tripwire` runs in GitLab's built-in `.post` stage (after every other stage) of every
  `main` *push* pipeline (never `schedule`, `web`, `api` or `trigger`), and treats a pipeline with any other job still
  `running`/`pending`/`created` as not judgeable: it never closes the issue then, it only logs.
  Tripwires are serialized (`resource_group: main-red-tripwire`), and one skips every write when
  a *newer* `main` push pipeline has already finished, so a slow older pipeline can neither close
  the issue over a newer red one nor open a second issue.
  If a non-`allow_failure` job failed it opens the single `main is red` issue, or comments on
  it if one is open, naming the failing jobs, commit and pipeline. A later pipeline with no such
  failure comments and closes it. Writing needs an `api`-scope token: it uses `KAIZEN_API_TOKEN`
  (falling back to `GITLAB_API_TOKEN`, which is `read_api` only, so the write is refused and the
  job prints a `WARNING` and passes). Until the token exists the tripwire is inert (it cannot open
  or close the issue); creating it is tracked in #2470. See [Tokens and Rotation](tokens-and-rotation.md).
- **Guard.** `main-red-guard` runs in MR pipelines, reads the latest *finished*
  (`success`/`failed`) `main` push pipeline anonymously, and fails if it failed.

**Fix:** fix `main` first. The fix MR carries the **`main-fix`** label; the guard reads labels
live, so add the label and retry `main-red-guard` (no new pipeline needed). Do not label an
unrelated MR `main-fix` to get around the brake.

**After main is green again:** the guard only runs when an MR pipeline runs, so every other
open MR whose `main-red-guard` failed while main was red keeps a failed pipeline. Retry that
MR's `main-red-guard` job (or re-run its pipeline) once the tripwire has closed the issue;
nothing re-runs it automatically.

**Fails open:** a network error, a 5xx, or no finished `main` pipeline makes the guard print
`WARNING: ... FAILING OPEN` and pass, the same convention as
`scripts/check-suppression-issues.sh`. A green latest `main` pipeline is authoritative even if
a change-conditional job that failed earlier did not re-run in it.

## Hermetic CI-script tests: protected variables are poisoned (#2461)

Protected variables (`GITLAB_API_TOKEN`, ...) exist on `main` pipelines but not in MR pipelines
from unprotected branches, so a test that quietly reads one passed on the MR and failed only
after merge (#2412, `resolve-docs-version.test.sh`). `script-tests` and `script-tests-glibc`
now `. scripts/ci-poison-env.sh` first, on **both** pipelines: every listed token is the
sentinel `poisoned-by-ci-poison-env-2461` and `CI_API_V4_URL` is `http://127.0.0.1:9/api/v4`
(a dead endpoint, so an accidental API call fails fast). A test that needs a variable must set
it itself, as the `runrt()` helper in `resolve-docs-version.test.sh` does.

`scripts/ci-poison-env.sh` is the one place the list lives. `scripts/check-ci-poison-list.sh`
(run in `script-tests`) fails when `.gitlab-ci.yml` or a script under `scripts/` references a `*_TOKEN` variable that is in
neither `CI_POISON_VARS` nor `CI_POISON_EXEMPT` (which needs a reason). Fix a failure by adding
the variable to the right list.

**Loopback canary.** A dead endpoint fails closed exactly like a missing token, so poison alone
cannot catch a test that quietly depends on a protected variable. Both jobs therefore start
`scripts/ci-api-canary.py` (stdlib listener on 127.0.0.1, answers every request `200 []` and logs
it) and point `CI_API_V4_URL` at it. After the tests run, `ci-api-canary.py verify` fails the job and
prints every requested path when the log is non-empty: "a test reached the API with inherited CI
variables". A test that talks to a fake API (`runapi` in `resolve-docs-version.test.sh`) sets its own
URL and never touches the canary; fix a flagged test by setting its own URL and token, or unsetting
the inherited ones. `scripts/tests/ci-api-canary.test.sh` replays #2412: with the `env -u` scrub
reverted in `resolve-docs-version.test.sh`, the canary flags the call
(`GET /api/v4/projects/1/pipelines?ref=v1.3.0...`).

## `runner_system_failure` is auto-retried; script failures never are (#2462)

`default: retry:` (max 2) covers infrastructure failure classes only: `runner_system_failure`,
`runner_unsupported`, `stuck_or_timeout_failure`, `scheduler_failure`, `api_failure`,
`data_integrity_failure`, `stale_schedule`. A week in November 2026 had 42 `runner_system_failure`
failures, all on `gitlab-runner-nuc-2-visiban` (host root cause: #2406 / #2148), mostly
`clients-contract`. `script_failure` and `unknown_failure` are **never** retried: red tests here
have repeatedly been real bugs. `scripts/check-ci-retry.sh` (run in `script-tests`) fails if any
`retry:` in `.gitlab-ci.yml` includes `script_failure`, `unknown_failure`, or `always`, and also
if a retry has no `when:` at all (`retry: 2`, `retry: {max: 2}`): GitLab then retries every
failure class, script failures included. Use `retry: 0` to opt out.

A job-level `retry:` replaces the default. Non-idempotent jobs set `retry: 0` with a reason on the
line: `helm-publish`, `github-release`, `docs-deploy`, `pages`, the image-attest jobs,
`cleanup-merged-branches`, `seed-demo-data`, `kaizen-yield-watch`, `main-red-tripwire` (posts issue
comments) and `backend-schema-fuzz-deep` (files issues in `after_script`). The kaniko
build/push jobs and the manifest jobs keep the default retry because re-pushing the same digest is
idempotent; `gitleaks-commits` keeps it too, as it only reads the diff and writes nothing (it has no
upload step). Add the same to any new job
whose side effect is not safe to repeat. A job that still shows a `runner_system_failure` after
two retries points at the runner, not the job; see #2406.
