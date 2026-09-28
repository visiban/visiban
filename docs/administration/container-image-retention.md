# Container image retention

Visiban publishes `backend` and `frontend` images to **two** registries on every release:
the GitLab container registry (`${CI_REGISTRY_IMAGE}`, i.e. `registry.gitlab.com/visiban/visiban`)
and GHCR (`ghcr.io/visiban/visiban`). Both registries can run their own cleanup/retention
policy, configured outside this repository — in the GitLab project settings UI, or (for
GHCR, if ever added) a GitHub Actions workflow. Neither shows up in a diff, so a policy that
deletes a released image is invisible until someone goes looking for the 404.

## Why this page exists

TruePPM's beta-readiness audit found this as its single most urgent finding: a GitLab
container-registry cleanup policy (`keep_n=1`, `name_regex=".*"`, **no keep-regex**) matched
every tag and protected none. Its daily sweep deleted the released `v0.3.0-alpha.3`
`api`/`web` images weeks after that release shipped — confirmed 404, live. No version-pinned
install of the current release was possible, and rollback was impossible. The publish jobs
had gone green; the policy that erased their output afterward lived entirely in the GitLab
UI, asserted by nothing in the repo.

Separately, Red-team finding M17 in the same audit: the documented production compose path
defaulted `APP_VERSION` to `latest` — a mutable tag — while every release image was scanned,
SBOM'd and signed **by digest**. Pulling `latest` in production could never be verified
against that signature or rolled back to a specific artifact. See
[Upgrading → `APP_VERSION` is now required](upgrade.md#upgrading-to-12x) for how Visiban
closed that half; this page covers the registry-retention half and digest pinning.

## GitLab container registry

Recorded 2026-09-27 via:

```bash
glab api "projects/visiban%2Fvisiban" | jq '.container_expiration_policy'
```

```json
{
  "cadence": "1d",
  "enabled": true,
  "keep_n": 10,
  "older_than": "90d",
  "name_regex": ".*",
  "name_regex_keep": "v.*",
  "next_run_at": "2026-09-26T23:52:16.652Z"
}
```

A tag matching `name_regex_keep` is **never** swept, regardless of age or the `keep_n`/
`older_than` count-and-age limits that apply to everything else `name_regex` matches. Reading
this policy against Visiban's actual tag set:

- **`v*` release tags are unconditionally protected.** `name_regex_keep: "v.*"` matches every
  `vX.Y.Z`(-alpha/beta/rc.N) tag this repo's kaniko push jobs create, so a released tag
  cannot be reaped by this policy no matter how old it gets or how many other tags have been
  pushed since. This is the exact gap TruePPM's incident exploited — it is closed here.
- **`latest` is *not* unconditionally protected.** `name_regex_keep: "v.*"` does not match
  the literal string `latest`. It survives today only because `backend-docker-push` /
  `frontend-docker-push` re-push `:latest` on every `main`-branch merge, which almost always
  keeps it inside `keep_n: 10` most-recently-pushed or younger than `older_than: 90d`. If
  `main` ever goes 90+ days without a merge to either image *and* 10 other tags get pushed in
  the meantime, `latest` becomes eligible for the sweep — a scenario the policy does not rule
  out, only makes unlikely under normal development cadence.
- **Known tradeoff, not yet addressed: per-arch `-amd64`/`-arm64` tags accumulate forever.**
  Since #1084, each release tag also pushes `:<tag>-amd64` and `:<tag>-arm64` on both
  registries — the source images `backend-manifest` / `frontend-manifest` combine into the
  real multi-arch `:<tag>` / `:latest` / `:MAJOR.MINOR`. On the GitLab registry,
  `name_regex_keep: "v.*"` matches these too (they start with `v`), so they're protected
  from the sweep the same as the real release tags — meaning they're never cleaned up,
  not just protected from premature deletion. On GHCR there is no cleanup at all (see below),
  so they accumulate there unconditionally. Neither is a correctness problem — the per-arch
  tags are only ever consumed by the manifest-assembly job, immediately after being pushed —
  but it is unbounded storage growth with no code path that reclaims it. Tracked in **#1196**
  (delete the per-arch tags after manifest assembly, or exclude them from the keep-regex);
  not fixed by #1084 itself.

**This change does not modify the policy.** Changing a GitLab project setting is an
outward-facing admin action outside this branch's scope (#1074). If you want to close the
`latest` gap, the exact call is:

```bash
glab api "projects/visiban%2Fvisiban" --method PUT \
  --header "Content-Type: application/json" \
  --input - <<'EOF'
{"container_expiration_policy_attributes": {"name_regex_keep": "^(v.*|latest)\\z"}}
EOF
```

Verify afterward with the same `jq '.container_expiration_policy'` read above. (Using `\z`
rather than `$` anchors the regex to the true end of string, not "end of line" — GitLab's
cleanup policy regex is a Ruby `Regexp`, where `$` also matches before a trailing newline.)

## GHCR (GitHub Container Registry)

GHCR has **no per-package automatic retention/cleanup policy setting** at all, on any GitHub
plan — unlike GitLab's project-level `container_expiration_policy`, there is no equivalent
API field or UI toggle to query. The only way GHCR images get swept is a workflow that
explicitly deletes package versions (typically `actions/delete-package-versions` in a GitHub
Actions workflow).

Checked 2026-09-27: this repository's only GitHub Actions workflow is
`.github/workflows/issue-bridge.yml` (unrelated — bridges GitLab issues to GitHub for
visibility). **No workflow deletes GHCR package versions**, so GHCR-published `backend`/
`frontend` images are not subject to any automated retention here — they persist until
someone deletes them by hand. This includes the per-arch `-amd64`/`-arm64` tags #1084 added
(see the GitLab registry section above) — GHCR has no keep-regex to even consider excluding
them from, so they accumulate unconditionally until #1196 is addressed.

The `gh` CLI used for this audit was authenticated but its token lacked the `read:packages`
scope needed to list package versions directly (`gh api orgs/visiban/packages` → 403). That
is a token-scope gap, not a "no packages" result — an operator who wants to confirm GHCR's
current package list and any manual deletions should do one of:

```bash
# Re-authenticate gh with package read access, then list:
gh auth refresh -h github.com -s read:packages
gh api "orgs/visiban/packages?package_type=container"

# Or check in the browser (no scope needed — it's your own org):
# https://github.com/orgs/visiban/packages
```

If a retention workflow is ever added for GHCR, record its keep-rule here in the same shape
as the GitLab section above, including whether it protects `v*` tags and `latest`
unconditionally.

## The scheduled check: `check-release-images`

Both of the above are point-in-time reads — nothing re-verifies them as either registry's
tag set or policy changes. `scripts/check-release-images.sh` (ported from TruePPM's own fix
for this incident) runs on every scheduled CI pipeline as the `check-release-images` job and
fails — **not `allow_failure`** — if the newest released `vX.Y.Z` `backend` or `frontend`
image is missing from *either* `${CI_REGISTRY_IMAGE}` or `ghcr.io/visiban/visiban`. This is
the check that would have caught TruePPM's incident the morning it happened, rather than
whenever the next release attempt failed to pull.

- **Not `allow_failure`.** A self-hoster who cannot pull the version the docs told them to
  run has no working install — that is a release defect, not an informational signal.
- **`RELEASE_IMAGE_PROBE`** lets the decision logic (which registry, which image, which tag,
  what counts as missing) be unit-tested with a stub, without a daemon or live registry
  credentials — see the script's `--self-test` mode and
  [CI gate self-tests](../development/ci-gates.md).
- **`ACCEPTED_GAPS`** is the escape hatch for a documented, permanent, single-reference
  exception (e.g. an old pre-release image intentionally never republished) — set per-entry
  by the CI job with a comment naming the decision issue, never defaulted in the script.
- The probe itself uses `crane manifest <ref>` (no daemon, no image pull, no `docker:dind`) —
  consistent with the rest of this repo's kaniko-based, daemonless registry tooling.

If this job goes red, it means a released, documented version is not pullable from the named
registry. Check that registry's retention/cleanup policy first (see the sections above), then
re-run the FULL tag pipeline's publish chain to restore the image: `backend-docker-push` /
`frontend-docker-push` alone (amd64) is **not** sufficient — as of the 2026-09-28 #1084
re-audit, those jobs only push `-amd64`-suffixed intermediate tags on a release tag, never the
real `:<tag>`/`:latest` names directly. The real names are written exclusively by
`backend-manifest` / `frontend-manifest`, which `needs:` both the amd64 leg above and the
arm64 leg (`backend-docker-push-arm64` / `frontend-docker-push-arm64`). Re-running only the
amd64 leg will not bring the tag back at all — all six jobs (`arm64-runner-preflight`,
`backend-docker-push` + `backend-docker-push-arm64`, `frontend-docker-push` +
`frontend-docker-push-arm64`, and `backend-manifest` + `frontend-manifest`) must complete for
the real, multi-arch tag to exist again.

**Caution if you're restoring an OLD release's tag** (not the newest one): both manifest jobs
always pass `--tags latest` (and `:MAJOR.MINOR` for a stable release) to `manifest-tool`, with
no check that the tag being rebuilt is actually the newest release. Re-running the full chain
for an old tag will move the real `:latest` (and `:MAJOR.MINOR`) reference back to that old
release on both registries, not just restore the specific `:<tag>` this check flagged. Confirm
that's intended — or restore the missing tag by other means (e.g. re-pushing the specific
digest, if still available on the other registry) — before re-running the chain for anything
other than the current newest release.

## Digest pinning

Both `docker-compose.prod.yml` and the Helm chart select images by **tag** (`APP_VERSION` /
`values.yaml`'s `tag:`). A tag is a mutable pointer — even a `v1.1.0` tag that is never
intentionally overwritten, but registries let it be recreated (an operator who suspects a
GHCR/GitLab-side re-push, or who wants the strongest possible guarantee that the image bytes
they run are the exact ones that were scanned and signed, can pin by **digest** instead.

Every release image is content-addressed by its digest (a `sha256:...` hash of the image
manifest) at the point it is pushed — that digest is what CI's SBOM/scan/sign steps actually
operate on, and it cannot change without the digest itself changing.

### Finding the digest for a release

```bash
# Via crane (no docker pull required):
crane digest ghcr.io/visiban/visiban/backend:v1.1.0

# Via docker, if you already have docker available:
docker buildx imagetools inspect ghcr.io/visiban/visiban/backend:v1.1.0 --format '{{.Manifest.Digest}}'

# Via the GitLab UI: Deploy → Container Registry → backend → the tag's row shows its digest.
# Via the GitHub UI: the package's page (https://github.com/orgs/visiban/packages/container/visiban%2Fbackend)
# lists each version's digest.
```

### Pinning `docker-compose.prod.yml` by digest

Digest references use `@sha256:...` instead of (or in addition to) a tag, and — unlike
`${APP_VERSION}` — are not something `docker-compose.prod.yml` can templatize per-service from
a single `.env` variable, since compose does not let you combine a variable-selected tag with
a fixed digest suffix on the same image reference. Pin all three backend-image lines
(`backend-init`, `backend`, `scheduler`) and the frontend line by editing your local copy of
`docker-compose.prod.yml` directly, replacing e.g.:

```yaml
image: ghcr.io/visiban/visiban/backend:${APP_VERSION:?...}
```

with:

```yaml
image: ghcr.io/visiban/visiban/backend@sha256:<digest>
```

This intentionally opts out of `APP_VERSION` entirely for that service — you are now pinned
to one specific, immutable artifact until you edit the file again for the next upgrade. Keep
a note of which `vX.Y.Z` tag that digest corresponds to (e.g. in a comment on the same line)
since `docker compose ps`/`images` will only show the digest, not the version.

### Pinning the Helm chart by digest

The chart templates render `image: "{{ .repository }}:{{ .tag }}"` — there is no separate
`digest` values key. Docker/OCI image references accept a tag **and** a digest together
(`repo:tag@digest`; the digest wins when both are present, and the tag stays as the
human-readable label), so append the digest directly onto `tag`:

```yaml
backend:
  image:
    repository: ghcr.io/visiban/visiban/backend
    tag: "v1.1.0@sha256:<digest>"

frontend:
  image:
    repository: ghcr.io/visiban/visiban/frontend
    tag: "v1.1.0@sha256:<digest>"
```

`values.schema.json` only rejects the literal value `latest` for these two `tag` fields
(#542 — so an upgrade can never leave replicas on two different builds); a `tag@digest`
string passes that check unchanged.
