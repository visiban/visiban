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

Separately, Red-team finding M17 in the same audit was against TruePPM's own release path:
its documented production compose defaulted `APP_VERSION` to `latest` — a mutable tag — while
its release images were scanned, SBOM'd and signed by digest, so pulling `latest` in
production could never be verified against that signature or rolled back to a specific
artifact. Visiban's `APP_VERSION` half of the same gap is now closed — see
[Upgrading → `APP_VERSION` is now required](upgrade.md#upgrading-to-12x). Since 1.2, Visiban's
release images are also cosign-signed and carry a CycloneDX SBOM attestation per architecture
(#1153) — see [Verifying release images](image-verification.md). Below covers the
registry-retention half and digest pinning.

## GitLab container registry

Recorded 2026-10-01 via:

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
  "name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest)\\z",
  "next_run_at": "2026-10-02T16:35:33.317Z"
}
```

A tag matching `name_regex_keep` is **never** swept, regardless of age or the `keep_n`/
`older_than` count-and-age limits that apply to everything else `name_regex` matches. Reading
this policy against Visiban's actual tag set:

- **`v*` release tags and `latest` are both unconditionally protected (#1190).** The
  alternation matches every `vX.Y.Z`(-alpha/beta/rc.N) release tag this repo's publish
  pipeline creates, and the literal string `latest`, so neither can be reaped by this policy
  no matter how old it gets or how many other tags have been pushed since. `v*` protection is
  the exact gap TruePPM's incident exploited — it predates this page's history. `latest`
  previously survived only incidentally, via `backend-docker-push`/`frontend-docker-push`
  re-pushing `:latest` on every `main`-branch merge (until #1409 moved those pushes to
  `:main`, which makes the explicit protection essential), which almost always kept it inside
  `keep_n: 10` most-recently-pushed or younger than `older_than: 90d` — a mechanism that
  stops working the moment `main` goes 90+ days without a merge to either image while 10
  other tags get pushed in the meantime. #1190 closes that gap unconditionally instead of
  relying on development cadence.

### Signature and SBOM attestation tags (#1153)

Since 1.2, cosign stores each release image's signatures and SBOM attestations in the same
repository as **tags** named `sha256-<64 hex>.sig` and `sha256-<64 hex>.att` (one per signed or
attested digest). The keep-regex recorded above does not match them, so they fall under the
ordinary `keep_n: 10` / `older_than: 90d` sweep. **On the GitLab registry, a release's
signatures and SBOMs are deleted about 90 days after it ships, while the image itself
survives**, and `cosign verify` against `registry.gitlab.com/visiban/visiban` starts failing
with `no signatures found`. GHCR has no cleanup policy, so its copies are unaffected.

Until the policy is extended (tracked in
[#1541](https://gitlab.com/visiban/visiban/-/issues/1541)), verify against GHCR (see
[Verifying release images](image-verification.md)). To keep the GitLab copies, a maintainer
adds the cosign tag shape to `name_regex_keep`:

```text
^(v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?|latest|sha256-[0-9a-f]{64}\.(sig|att))\z
```

This also keeps signatures for intermediate `-amd64`/`-arm64` digests. Those are the same
digests the release index points at, so keeping them is intended. Record the change here
the same way #1190 was recorded. The `image-attest-backfill` CI job can re-attach any
signatures and SBOMs that were already swept, but the re-attached copies carry the backfill
job's `@refs/heads/main` identity, not the original release tag's. For that release, the
GitLab registry copy then **fails** the tag-only (and exact-release) verification identity
that [Verifying release images](image-verification.md) recommends. It needs the main-or-tag
backfill regexp from that page. The GHCR copy is unaffected. Applying the keep-regex above
([#1541](https://gitlab.com/visiban/visiban/-/issues/1541)) avoids this entirely, because the
original tag-pipeline signatures are then never swept.

Nothing yet checks on a schedule that a release's signatures and attestations are still
present. Only the images themselves are checked. That check is tracked in
[#1542](https://gitlab.com/visiban/visiban/-/issues/1542).

!!! warning "Cleaning up per-arch tags (#1196) must keep the platform manifests"
    The `-amd64`/`-arm64` intermediate tags point at the same platform manifests the release
    index references, and those digests carry the signatures and SBOM attestations. Any
    cleanup done for [#1196](https://gitlab.com/visiban/visiban/-/issues/1196) may remove the
    intermediate **tags**, but it must not delete the platform **manifests** or their
    `sha256-<digest>.sig`/`.att` tags. Deleting them breaks `docker pull` for that platform
    and removes its signature and SBOM.

### History: the semver-anchored form predates #1190

The keep-regex above is anchored to a strict semver shape
(`^v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?\z`) rather than the looser, unanchored
`v.*` this page recorded through 2026-09-29. That tightening was **already live** when
#1190's audit started (2026-10-01) — #1190 only added the `|latest` alternative alongside it,
it did not introduce the semver anchoring.

The anchored form traces to commit `6dfcad088` ("feat(ci): restore native arm64 image
publishing (#1084)", 2026-09-27) on branch `feat/1084-restore-arm64-image-publish`. That
commit's message documents applying this exact regex via the GitLab API that same day,
**specifically so the `-amd64`/`-arm64` intermediate tags #1084 introduces would not match
`name_regex_keep`** and would instead fall back to the ordinary `keep_n`/`older_than` sweep
rather than being retained forever (the old unanchored `v.*` matched those too, since they
start with `v`). This is deliberate, not an oversight — it is recorded here because the
branch that documents it was never merged: #1084 shipped via a different implementation
(`docker buildx imagetools create` was dropped in favor of `manifest-tool`; see merged
commits `720d21b5e` and `40d52cea2`), so that branch's doc update, including this history,
never reached `main`. The live GitLab setting, changed directly via the API, was unaffected
by which branch merged and was never reverted — so it was already in this tightened shape
when #1190 began, and this page is only now catching up to it.

- **Per-arch `-amd64`/`-arm64` intermediate tags: swept by `keep_n`/`older_than` on GitLab,
  unconditionally retained on GHCR.** Each release tag pushes `<tag>-amd64` and `<tag>-arm64`
  (e.g. `v1.2.0-amd64`) on both registries before `backend-manifest`/`frontend-manifest`
  combine them into the real multi-arch `:<tag>`/`:latest`/`:MAJOR.MINOR`. The anchored regex
  does **not** match these: the `\z` anchor requires the string to end right after the
  optional prerelease group, so a trailing `-amd64`/`-arm64` suffix breaks the match. On the
  GitLab registry they therefore fall back to the ordinary `keep_n: 10`/`older_than: 90d`
  sweep that `name_regex: ".*"` subjects everything else to — they get cleaned up in due
  course, not retained forever, as a direct result of the 2026-09-27 tightening above. On
  GHCR there is still no cleanup mechanism at all (see below), so they accumulate there
  unconditionally regardless of tag shape. Whether reclaiming them only after a `keep_n`/90d
  wait (versus immediately after manifest assembly) is good enough is a separate question
  still tracked in **#1196**.
- **`MAJOR.MINOR` alias tags (e.g. `1.2`) are also not protected.** For a stable release,
  `backend-manifest`/`frontend-manifest` additionally alias the manifest onto a bare
  `MAJOR.MINOR` tag with the leading `v` stripped (`manifest-tool ... --tags latest,1.2` from
  `v1.2.0`) — so the pushed tag is literally `1.2`, not `v1.2`. The keep-regex only matches a
  `v`-prefixed, three-component version or the literal `latest`, so `1.2` falls back to the
  same `keep_n`/`older_than` sweep as the per-arch tags on GitLab, and is never cleaned up on
  GHCR. No commit or issue found states this was a deliberate design decision for `MAJOR.MINOR`
  tags specifically — it reads as an incidental consequence of the per-arch-tag anchoring
  above rather than a considered choice, and should be treated as unrecorded, not intended,
  until someone confirms otherwise.

### #1190 update: `latest` added to the keep-regex

The call actually used, 2026-10-01 (kept the existing semver strictness from the history
above, and added `latest` alongside it):

```bash
glab api "projects/visiban%2Fvisiban" --method PUT \
  --header "Content-Type: application/json" \
  --input - <<'EOF'
{"container_expiration_policy_attributes": {"name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest)\\z"}}
EOF
```

Verified against the same `jq '.container_expiration_policy'` read above — see the recorded
JSON at the top of this section. (Using `\z` rather than `$` anchors the regex to the true end
of string, not "end of line" — GitLab's cleanup policy regex is a Ruby `Regexp`, where `$`
also matches before a trailing newline.)

### #1541 update: cosign `.sig`/`.att` tags added to the keep-regex

The target policy that protects signature and SBOM attestation tags (the `sha256-<64 hex>.sig`
and `.att` tags described above). It is the #1190 policy with one alternative appended; every
other field is unchanged. A Maintainer applies it (a project setting, not changeable from a
branch):

```bash
glab api --method PUT "projects/visiban%2Fvisiban" \
  -H "Content-Type: application/json" \
  --input - <<'EOF'
{"container_expiration_policy_attributes": {"name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest|sha256-[0-9a-f]{64}\\.(sig|att))\\z"}}
EOF
```

Resulting policy (read back with the `jq '.container_expiration_policy'` command at the top of
this section):

```json
{
  "cadence": "1d",
  "enabled": true,
  "keep_n": 10,
  "older_than": "90d",
  "name_regex": ".*",
  "name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest|sha256-[0-9a-f]{64}\\.(sig|att))\\z"
}
```

`name_regex_keep` is matched against the whole tag name, so the new alternative only protects
tags that are exactly `sha256-` plus 64 lowercase hex characters plus `.sig` or `.att`. It does
not protect other `sha256-*` tags, a bare `sha256-<hex>` tag, or longer or shorter hex strings.
All tag shapes the previous regex kept (`vX.Y.Z`, `vX.Y.Z-alpha|beta|rc.N`, `latest`) are still
kept. Per-arch tag cleanup ([#1196](https://gitlab.com/visiban/visiban/-/issues/1196)) must
leave these tags alone for the same reason as the warning above. Once applied, replace the
"until the policy is extended" guidance above with the date it was applied.

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
- **Every required architecture, not just presence (#1197).** A tag that resolves but whose
  manifest is not a list covering every entry in `RELEASE_REQUIRED_ARCHES` (default
  `amd64 arm64`) is reported `ARCH-MISSING` and fails the job the same as a missing image —
  that is what a `backend-manifest` / `frontend-manifest` run that silently dropped the arm64
  leg would publish.
- The probe itself uses `crane manifest <ref>` (no daemon, no image pull, no `docker:dind`) —
  consistent with the rest of this repo's kaniko-based, daemonless registry tooling.

If this job goes red, it means a released, documented version is not pullable from the named
registry. Check that registry's retention/cleanup policy first (see the sections above), then
re-run the FULL tag pipeline's publish chain to restore the image: `backend-docker-push` /
`frontend-docker-push` alone (amd64) is **not** sufficient — as of the 2026-09-28 #1084
re-audit, those jobs only push `-amd64`-suffixed intermediate tags on a release tag, never the
real `:<tag>` name directly. The real name is written exclusively by `backend-manifest` /
`frontend-manifest`, which `needs:` both the amd64 leg above and the arm64 leg
(`backend-docker-push-arm64` / `frontend-docker-push-arm64`). Re-running only the amd64 leg
will not bring the tag back at all — all six jobs (`arm64-runner-preflight`,
`backend-docker-push` + `backend-docker-push-arm64`, `frontend-docker-push` +
`frontend-docker-push-arm64`, and `backend-manifest` + `frontend-manifest`) must complete for
the real, multi-arch tag to exist again.

**Caution if you're restoring an OLD *stable* release's tag** (not the newest one): the
manifest jobs pass `--tags latest,MAJOR.MINOR` to `manifest-tool` only for a stable
(non-pre-release) tag, with no check that the stable tag being rebuilt is actually the newest
release. Re-running the full chain for an old stable tag will move the real `:latest` (and
`:MAJOR.MINOR`) reference back to that old release on both registries, not just restore the
specific `:<tag>` this check flagged. Confirm that's intended — or restore the missing tag by
other means (e.g. re-pushing the specific digest, if still available on the other registry) —
before re-running the chain for anything other than the current newest stable release. A
pre-release tag (`-alpha.N`/`-beta.N`/`-rc.N`) gets no `--tags` at all — restoring one only
ever recreates its own exact `:<tag>`, never touches `:latest`.

## GitLab-registry `:latest` is stable-only; `main` publishes `:main`

Both registries now treat `:latest` the same way (#1409):

| Tag | Written by | Architectures |
|---|---|---|
| `:latest` (GHCR and GitLab) | **Stable** release tags only (`backend-manifest` / `frontend-manifest`) — a pre-release tag (`-alpha`/`-beta`/`-rc`) never touches it | linux/amd64 + linux/arm64, until the next stable release |
| `:main` (GitLab only) | Every `main`-branch merge (`backend-docker-push` / `frontend-docker-push`, via kaniko) | amd64 only |
| `:<short-sha>` (GitLab only) | Every `main`-branch merge — for rollback | amd64 only |

The native arm64 legs (`*-docker-push-arm64`), `arm64-runner-preflight`, and the manifest jobs
all have release-tag-only `rules:`, so a `main` merge cannot produce a multi-arch image. Before
#1409 the GitLab `:latest` was overwritten with that amd64-only build on every merge, which
meant GitLab `:latest` was an unvetted `main` build between releases and disagreed with GHCR.
Main builds now go to `:main`, leaving `:latest` on the newest stable release.

**Retention:** `:main` may be swept after a long idle period (the same `keep_n`/`older_than`
failure mode described for `latest` above); the next `main` merge recreates it, and nothing pins
to it, so it needs no `name_regex_keep` entry. Short-SHA tags age out under that same sweep, as
before. `:latest` and release tags stay unconditionally protected.

**Building arm64 on every `main` merge** would serialize each merge through the single dedicated
Apple Silicon runner (`Max1-Runner-Visiban`); that throughput cost has not been evaluated
(#1208), which is why `:main` remains amd64-only. If that changes, the fix is to run the arm64
leg and manifest assembly on `main` merges by changing those jobs' `rules:` in `.gitlab-ci.yml`.

**Guidance:** run `:latest` or a pinned release tag (`:v1.2.0`) in production. Anyone who was
tracking GitLab `:latest` to follow `main` should switch to `:main`.

## Digest pinning

Both `docker-compose.prod.yml` and the Helm chart select images by **tag** (`APP_VERSION` /
`values.yaml`'s `tag:`). A tag is a mutable pointer — even a `v1.1.0` tag that is never
intentionally overwritten, but registries let it be recreated (an operator who suspects a
GHCR/GitLab-side re-push, or who wants the strongest possible guarantee that the image bytes
they run are the exact ones that were built and pushed, can pin by **digest** instead.

Every release image is content-addressed by its digest (a `sha256:...` hash of the image
manifest) at the point it is pushed, and it cannot change without the digest itself changing.
Since 1.2 the signature and SBOM attestations CI attaches target digests, not tags: the
multi-arch index digest and each platform digest are signed, and each platform digest carries
its SBOM — independent of whichever tag currently points at it. See
[Verifying release images](image-verification.md).

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
