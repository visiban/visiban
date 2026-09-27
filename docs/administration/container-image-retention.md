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

Recorded 2026-09-27 (updated same day — see below) via:

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
  "name_regex_keep": "^v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?\\z",
  "next_run_at": "2026-09-28T22:57:01.040Z"
}
```

A tag matching `name_regex_keep` is **never** swept, regardless of age or the `keep_n`/
`older_than` count-and-age limits that apply to everything else `name_regex` matches. Reading
this policy against Visiban's actual tag set:

- **`v*` release tags are unconditionally protected**, and — since the #1084 update below —
  *only* real release tags, not the per-arch intermediate tags #1084 introduced. A released
  `vX.Y.Z`(-alpha/beta/rc.N) tag cannot be reaped by this policy no matter how old it gets or
  how many other tags have been pushed since. This is the exact gap TruePPM's incident
  exploited — it was closed here (originally with the looser `v.*`, tightened 2026-09-27, see
  below).
- **`latest` is *not* unconditionally protected.** The keep-regex does not match the literal
  string `latest`. It survives today only because `backend-docker-push` /
  `frontend-docker-push` re-push `:latest` on every `main`-branch merge, which almost always
  keeps it inside `keep_n: 10` most-recently-pushed or younger than `older_than: 90d`. If
  `main` ever goes 90+ days without a merge to either image *and* 10 other tags get pushed in
  the meantime, `latest` becomes eligible for the sweep — a scenario the policy does not rule
  out, only makes unlikely under normal development cadence. Unchanged by #1084 — out of that
  issue's scope; see the historical PUT example this section used to carry if you want to
  close it.

### 2026-09-27 update: tightened for #1084's per-arch intermediate tags

#1084 (restore native arm64 image publishing) introduces intermediate tags
`<tag>-amd64`/`<tag>-arm64` (e.g. `v1.2.0-amd64`) that a manifest-assembly job consumes and
then leaves behind. The *original* `name_regex_keep: "v.*"` is an unanchored prefix match, so
it matched these too — meaning every release would permanently retain two extra never-swept
tags per image, forever, a storage-growth cost that didn't exist before #1084 introduced the
naming scheme.

Tightened the same day to anchor on the real release-tag shape only:

```bash
glab api "projects/visiban%2Fvisiban" --method PUT \
  --header "Content-Type: application/json" \
  --input - <<'EOF'
{"container_expiration_policy_attributes": {"name_regex_keep": "^v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?\\z"}}
EOF
```

Verified against every real tag in this repo's history (`git tag -l 'v*'`) before applying —
matches every `vX.Y.Z` and `vX.Y.Z-(alpha|beta|rc).N` tag, and does **not** match
`v1.2.0-amd64` / `v1.2.0-arm64`, so those intermediate tags fall back to the ordinary
`keep_n: 10` / `older_than: 90d` sweep like everything else `name_regex: ".*"` matches — they
get cleaned up in the normal course of subsequent releases rather than retained forever.

Verify the live policy with the same `jq '.container_expiration_policy'` read above before
trusting this section. (Using `\z` rather than `$` anchors the regex to the true end of
string, not "end of line" — GitLab's cleanup policy regex is a Ruby `Regexp`, where `$` also
matches before a trailing newline.)

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
someone deletes them by hand.

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
image is missing from *either* `${CI_REGISTRY_IMAGE}` or `ghcr.io/visiban/visiban`, **or** is
present but missing a required architecture (`amd64`, `arm64` — added for #1084). This is
the check that would have caught TruePPM's incident the morning it happened, rather than
whenever the next release attempt failed to pull — and, since #1084, the same for a
manifest-assembly job that silently dropped a platform leg while still reporting green.

- **Not `allow_failure`.** A self-hoster who cannot pull the version the docs told them to
  run has no working install — that is a release defect, not an informational signal. The
  same is true of a release that only covers one architecture despite the docs promising
  both — a self-hoster on the undocumented-missing architecture has no working install
  either, even though the tag itself resolves.
- **`RELEASE_IMAGE_PROBE`** lets the decision logic (which registry, which image, which tag,
  what counts as missing) be unit-tested with a stub, without a daemon or live registry
  credentials — see the script's `--self-test` mode and
  [CI gate self-tests](../development/ci-gates.md). **`RELEASE_ARCH_PROBE`** /
  **`RELEASE_REQUIRED_ARCHES`** are the #1084 equivalent for the arch-presence check.
- **`ACCEPTED_GAPS`** is the escape hatch for a documented, permanent, single-reference
  exception (e.g. an old pre-release image intentionally never republished) — set per-entry
  by the CI job with a comment naming the decision issue, never defaulted in the script. It
  covers a MISSING image only, not an ARCH-MISSING one — there's no legitimate permanent
  reason for a current release to ship one architecture short.
- The probe itself uses `crane manifest <ref>` (no daemon, no image pull, no `docker:dind`) —
  consistent with the rest of this repo's kaniko-based, daemonless registry tooling. The
  arch-presence check reuses the same `crane manifest` output, parsed with `jq` for each
  `.manifests[].platform.architecture`.

If this job goes red, it means a released, documented version is not pullable from the named
registry. Check that registry's retention/cleanup policy first (see the sections above), then
re-run that tag's `backend-docker-push` / `frontend-docker-push` publish jobs to restore the
image.

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
