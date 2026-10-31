# Make sure registry cleanup never deletes a released image

> **Added in 1.2** (#1074)

Visiban publishes `backend` and `frontend` images to **two** registries on every release: the GitLab container registry (`${CI_REGISTRY_IMAGE}`, i.e. `registry.gitlab.com/visiban/visiban`) and GHCR (`ghcr.io/visiban/visiban`). Run `:latest` or a pinned release tag (`:v1.2.0`) in production, or pin by [digest](#digest-pinning).

**Why it matters:** Both registries can run their own cleanup/retention policy, configured outside this repository: in the GitLab project settings UI, or (for GHCR, if ever added) a GitHub Actions workflow. Neither shows up in a diff, so a policy that deletes a released image is invisible until someone goes looking for the 404.

**The big picture:** this page records the live GitLab policy, the GHCR state, the scheduled check that watches both, and how to pin images by digest.

## Why this page exists

TruePPM's beta-readiness audit found this as its single most urgent finding: a GitLab
container-registry cleanup policy (`keep_n=1`, `name_regex=".*"`, **no keep-regex**) matched
every tag and protected none. Its daily sweep deleted the released `v0.3.0-alpha.3`
`api`/`web` images weeks after that release shipped — confirmed 404, live. No version-pinned
install of the current release was possible, and rollback was impossible. The publish jobs
had gone green; the policy that erased their output afterward lived entirely in the GitLab
UI, asserted by nothing in the repo.

Separately, Red-team finding M17 in the same audit was against TruePPM's own release path. Its documented production compose defaulted `APP_VERSION` to `latest`, a mutable tag, while its release images were scanned, SBOM'd and signed by digest. Pulling `latest` in production could therefore never be verified against that signature or rolled back to a specific artifact.

Visiban's `APP_VERSION` half of the same gap is now closed; see [Upgrading → `APP_VERSION` is now required](upgrade.md#upgrading-to-12x). Since 1.2, Visiban's release images are also cosign-signed and carry a CycloneDX SBOM attestation per architecture (#1153); see [Verifying release images](image-verification.md). Below covers the registry-retention half and digest pinning.

## GitLab container registry

Recorded 2026-10-14 via:

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
  "name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest|sha256-[0-9a-f]{64}\\.(sig|att))\\z",
  "next_run_at": "2026-10-15T22:10:00.561Z"
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
- **cosign `sha256-<64 hex>.sig`/`.att` tags are unconditionally protected (#1541).** See
  [Signature and SBOM attestation tags](#signature-and-sbom-attestation-tags-1153) below.
- **Everything else is swept** by `keep_n: 10` / `older_than: 90d`: the per-arch
  `-amd64`/`-arm64` working tags, `MAJOR.MINOR` aliases, `:main` and short-SHA tags (see the
  sections below).

### Signature and SBOM attestation tags (#1153)

Since 1.2, cosign stores each release image's signatures and SBOM attestations in the same
repository as **tags** named `sha256-<64 hex>.sig` and `sha256-<64 hex>.att` (one per signed or
attested digest). The live keep-regex recorded above matches exactly that shape
(`sha256-` plus 64 lowercase hex characters plus `.sig` or `.att`), so the cleanup policy
never sweeps them, on either the release index digest or the platform digests the per-arch
`-amd64`/`-arm64` tags pointed at. GHCR has no cleanup policy, so its copies are unaffected
too. This protection was added by [#1541](https://gitlab.com/visiban/visiban/-/issues/1541)
(see [#1541 update](#1541-update-cosign-sigatt-tags-added-to-the-keep-regex) below). Before
it, these tags fell under the `keep_n: 10` / `older_than: 90d` sweep; no signed release had
reached the 90-day mark by the time the keep-regex went live, so nothing was lost.

**Yes, but:** #1541 is still open for its second acceptance criterion: the nightly
`check-release-attestations` job must confirm that a signed release older than 90 days still
verifies on the GitLab registry. The first signed release (`v1.2.0-beta.1`, 2026-10-12) reaches
that age around 2027-01-10.

If a signature or SBOM tag is ever deleted anyway (for example by hand), the
`image-attest-backfill` CI job can re-attach it, but the re-attached copy carries the backfill
job's `@refs/heads/main` identity, not the original release tag's. For that release, the
GitLab registry copy then **fails** the tag-only (and exact-release) verification identity
that [Verifying release images](image-verification.md) recommends. It needs the main-or-tag
backfill regexp from that page. The GHCR copy is unaffected.

The nightly `check-release-attestations` job
([#1542](https://gitlab.com/visiban/visiban/-/issues/1542)) checks that the newest signed releases'
signatures and SBOM attestations are still present and still verify, on both registries. It
fails when a sweep or manual delete removes them. See the
[CI gates runbook](../development/ci-gates.md#self-tested-today) for what a red run means and
how to re-attach a backfilled release.

!!! warning "Cleaning up per-arch tags (#1196) must keep the platform manifests"
    The `-amd64`/`-arm64` intermediate tags point at the same platform manifests the release
    index references, and those digests carry the signatures and SBOM attestations. Any
    cleanup of them may remove the intermediate **tags**, but it must not delete the platform
    **manifests** or their `sha256-<digest>.sig`/`.att` tags. Deleting them breaks
    `docker pull` for that platform and removes its signature and SBOM. How #1196 resolved
    this on each registry is under
    [Per-arch working tags (#1196)](#per-arch-working-tags-1196).

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
  GHCR they are still kept, because no safe removal exists yet ([#1650](https://gitlab.com/visiban/visiban/-/issues/1650)). See [Per-arch working tags (#1196)](#per-arch-working-tags-1196)
  for why each registry is handled the way it is.
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

### Per-arch working tags (#1196)

Each release pushes `<tag>-amd64` and `<tag>-arm64` to both registries so `manifest-tool` can
assemble the multi-arch `:<tag>` index. The index references the two platform manifests **by
digest**, not by tag. Those same digests carry the cosign signatures and SBOM attestations
(`sha256-<digest>.sig`/`.att`, #1153). `attest-image-sbom.sh` and
`check-release-attestations.sh` read the digests from the published index, and nothing after
`backend-manifest`/`frontend-manifest` reads the `-amd64`/`-arm64` tags. (The SBOM's
`metadata.component.version`, for example `v1.2.0-arm64`, is a label syft is given, not a
reference to the tag.) So once the index exists, the per-arch **tag** is a disposable label,
while the platform **manifest** it points at must stay.

That distinction decides what each registry can safely do:

| | What a delete removes | Mechanism used | Result |
|---|---|---|---|
| **GitLab registry** | The cleanup policy deletes **tags**, not the manifests behind them. GitLab's registry garbage collection should not remove a manifest that an index still references. That is GitLab's documented behavior, not something this repo checks; confirming it on the first real sweep (around 2026-12-28) is tracked in [#1651](https://gitlab.com/visiban/visiban/-/issues/1651), due 2026-12-14. | The existing cleanup policy. `name_regex_keep` does not match `-amd64`/`-arm64`-suffixed tags, so they fall under `keep_n: 10` / `older_than: 90d`. | Per-arch tags removed about 90 days after the release; the index and the platform manifests it references stay. The `.sig`/`.att` tags on those platform digests are protected by the live keep-regex (#1541), so neither a per-arch sweep nor the policy itself removes them (see [Signature and SBOM attestation tags](#signature-and-sbom-attestation-tags-1153)). |
| **GHCR** | GHCR has no tag-only delete. GitHub's API deletes a **package version**, and a version is a manifest digest: deleting the version that carries `v1.2.0-amd64` deletes the amd64 platform manifest itself, along with every tag on it. | None yet. No safe tag-only removal is in place; tracked in [#1650](https://gitlab.com/visiban/visiban/-/issues/1650). | Two extra tag names per image per release. They add no storage: each labels a manifest the release index needs anyway. |

**Why not delete them right after manifest assembly (#1196 option 1).** On GHCR a direct
version delete would break `docker pull` on that platform and orphan its signature and SBOM.
The known workaround is to push a throwaway manifest onto the per-arch tag (moving the tag off
the platform manifest) and then delete the throwaway version. That removes the tag, but it
leaves the platform manifests as **untagged** versions, which the GHCR cleanup recipe in the
warning below would then delete. It is not used here for that reason. On the GitLab registry a manifest-level delete (the registry
`DELETE /v2/<repo>/manifests/<digest>` that `crane delete <repo>@<digest>` sends) has the same
effect. Only GitLab's tag-delete API removes the tag alone, and the existing cleanup policy
already removes these tags without adding a registry-delete credential to the tag pipeline.

**The keep-regex is pinned by a test.** `scripts/tests/registry-keep-regex.test.sh` (CI job
`registry-keep-regex-test`, on MRs touching this page, the test or `.gitlab-ci.yml`) reads the
live `name_regex_keep` from the recorded-policy block at the top of the GitLab section (the one
with `next_run_at`) and checks it against the tag shapes the pipeline pushes: release tags and
`latest` kept, `-amd64`/`-arm64` tags (including pre-release ones like `v1.2.0-beta.1-arm64`)
not kept, and exactly `sha256-<64 hex>.sig`/`.att` kept. It also reads three historical regexes
and checks why each was replaced: the #1541 PUT body must equal the live regex, the #1190 PUT
body must not keep `.sig`/`.att`, and the unanchored `v.*` from the history above must keep
per-arch tags. It checks that `.gitlab-ci.yml` still uses the `-amd64`/`-arm64` suffixes, so a
change to the naming scheme fails the test instead of slipping past the regex. Built-in
negative controls prove it goes red when the live block loses the `.sig`/`.att` alternative,
when the live block is unanchored, and when the #1190 PUT body is loosened to `v.*`. No other
JSON on this page is read.

!!! warning "A GHCR \"delete untagged versions\" workflow would break multi-arch releases"
    The common GHCR cleanup recipe (for example `actions/delete-package-versions` with
    `delete-only-untagged-versions: true`) treats an untagged version as garbage. Today the
    `-amd64`/`-arm64` tags are what keep each platform manifest tagged on GHCR. If those tags
    are ever removed, the platform manifests become untagged versions, and such a workflow
    would delete them, breaking every multi-arch release on GHCR. A GHCR retention workflow
    must exclude any version referenced by a release index. The same applies to every way of
    getting rid of the per-arch tag names on GHCR: the throwaway-manifest workaround above, and
    copying the assembled index from the GitLab registry to GHCR by digest instead of pushing
    per-arch tags there (`crane copy` copies an index's platform manifests without tags). Both
    leave the platform manifests untagged, so any GHCR cleanup must skip versions that an
    index references.

**The GHCR half of #1196 is not resolved by this change.** On GHCR the per-arch tag names
still accumulate (two per image per release, with no extra storage). Removing them without
deleting platform manifests is tracked in
[#1650](https://gitlab.com/visiban/visiban/-/issues/1650).

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

Verified at the time against the same `jq '.container_expiration_policy'` read above; the
policy recorded on 2026-10-01 carried exactly this regex. It has since been replaced by the
#1541 regex below. (Using `\z` rather than `$` anchors the regex to the true end
of string, not "end of line" — GitLab's cleanup policy regex is a Ruby `Regexp`, where `$`
also matches before a trailing newline.)

### #1541 update: cosign `.sig`/`.att` tags added to the keep-regex

The policy that protects signature and SBOM attestation tags (the `sha256-<64 hex>.sig` and
`.att` tags described above). It is the #1190 policy with one alternative appended; every other
field is unchanged. A Maintainer applies it (a project setting, not changeable from a branch).

**Status: live.** It was not live when this section was written on 2026-10-10, and the
read-back on 2026-10-14 (the JSON at the top of this section) shows it applied. #1541 does not
record the exact apply date. #1541 itself stays open until the nightly check confirms a release
older than 90 days still verifies (see
[Signature and SBOM attestation tags](#signature-and-sbom-attestation-tags-1153)).

The command:

```bash
glab api --method PUT "projects/visiban%2Fvisiban" \
  -H "Content-Type: application/json" \
  --input - <<'EOF'
{"container_expiration_policy_attributes": {"name_regex_keep": "^(v[0-9]+\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?|latest|sha256-[0-9a-f]{64}\\.(sig|att))\\z"}}
EOF
```

The resulting policy is the JSON recorded at the top of this section.

`name_regex_keep` is matched against the whole tag name, so the new alternative only protects
tags that are exactly `sha256-` plus 64 lowercase hex characters plus `.sig` or `.att`. It does
not protect other `sha256-*` tags, a bare `sha256-<hex>` tag, or longer or shorter hex strings.
All tag shapes the previous regex kept (`vX.Y.Z`, `vX.Y.Z-alpha|beta|rc.N`, `latest`) are still
kept. Per-arch tag cleanup ([#1196](https://gitlab.com/visiban/visiban/-/issues/1196)) must
leave these tags alone for the same reason as the warning above.

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
someone deletes them by hand. This includes the per-arch `-amd64`/`-arm64` tags #1084 added.
They are still kept on GHCR: a plain delete removes a whole package version, which for these
tags is the platform manifest the release index, signature and SBOM depend on. Removing the tag
names safely is tracked in [#1650](https://gitlab.com/visiban/visiban/-/issues/1650). See
[Per-arch working tags (#1196)](#per-arch-working-tags-1196), including the warning there
before adding any GHCR cleanup workflow.

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
unconditionally, and how it avoids deleting platform manifests that a release index
references.

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

**If this job goes red,** a released, documented version is not pullable from the named registry. Check that registry's retention/cleanup policy first (see the sections above), then re-run the FULL tag pipeline's publish chain to restore the image: `backend-docker-push` /
`frontend-docker-push` alone (amd64) is **not** sufficient — as of the 2026-09-28 #1084
re-audit, those jobs only push `-amd64`-suffixed intermediate tags on a release tag, never the
real `:<tag>` name directly. The real name is written exclusively by `backend-manifest` /
`frontend-manifest`, which `needs:` both the amd64 leg above and the arm64 leg
(`backend-docker-push-arm64` / `frontend-docker-push-arm64`). Re-running only the amd64 leg
will not bring the tag back at all — all six jobs (`arm64-runner-preflight`,
`backend-docker-push` + `backend-docker-push-arm64`, `frontend-docker-push` +
`frontend-docker-push-arm64`, and `backend-manifest` + `frontend-manifest`) must complete for
the real, multi-arch tag to exist again.

**Watch out if you're restoring an OLD *stable* release's tag** (not the newest one): the
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

**Guidance:** run `:latest` or a pinned release tag (`:v1.2.0`) in production. Anyone who was tracking GitLab `:latest` to follow `main` should switch to `:main`.

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

This intentionally opts out of `APP_VERSION` entirely for that service. You are now pinned to one specific, immutable artifact until you edit the file again for the next upgrade.

**Tip:** keep a note of which `vX.Y.Z` tag that digest corresponds to (e.g. in a comment on the same line), since `docker compose ps`/`images` will only show the digest, not the version.

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
