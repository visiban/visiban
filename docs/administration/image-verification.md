# Verifying release images and the Helm chart

*(New in 1.2)* Every Visiban release is signed keyless with [Sigstore cosign](https://docs.sigstore.dev/)
by the GitLab CI job that published it, so you can check that what you pull was built and
pushed by Visiban's release pipeline rather than trusting the registry:

| Artifact | Where | What CI attaches |
|---|---|---|
| Helm chart | `ghcr.io/visiban/charts/visiban` | A signature |
| `backend` and `frontend` images | `ghcr.io/visiban/visiban/<image>` **and** `registry.gitlab.com/visiban/visiban/<image>` | A signature on the multi-arch index **and** on each platform image, plus a CycloneDX SBOM attestation on **each** platform image (`linux/amd64`, `linux/arm64`) |

Signatures and attestations are stored in the same registry as the image, so each registry
carries its own copy. Verify against the registry you actually pull from. GHCR keeps its
copies indefinitely. On the GitLab registry, the current cleanup policy can sweep signature
and attestation tags about 90 days after a release, even though the image itself is kept.
See [Container image retention](container-image-retention.md#signature-and-sbom-attestation-tags-1153).

There is no key to download. A signature is valid when its Sigstore certificate says it was
issued to Visiban's GitLab CI pipeline. Every command below pins that identity:

```bash
ISSUER=https://gitlab.com
# Recommended: a release tag pipeline only.
IDENTITY='^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*$'
```

Use this tag-only identity for every release cut after image signing shipped. It accepts
only a certificate issued to the tag pipeline that built and pushed the release. A release
that was signed later by the backfill job needs a wider identity, described in
[Older releases](#older-releases). Use that wider identity only for those versions.

Keep the regexp anchored (`^...$`) as shown. A loose pattern such as `gitlab\.com/visiban/visiban`
also matches other projects whose path starts the same way, such as `visiban/visiban-enterprise`.

## Verify an image signature

```bash
cosign verify ghcr.io/visiban/visiban/backend:v1.2.0 \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"
```

This checks the multi-arch index the tag points at. The platform images inside it are signed
too, so the same check also works against a single-platform digest (see below). This matters
if your admission controller or pull policy resolves images to a platform digest.

To pin a deployment to what you verified, record the digest and deploy by `@sha256:...`. See
[Container image retention → Digest pinning](container-image-retention.md#digest-pinning).

## Verify and read an image's SBOM

The SBOM is attached to each **platform** digest, not to the tag. The tag resolves to the
multi-arch index, which has no filesystem and no packages, so it has nothing to describe.
Resolve the digest for your platform first:

```bash
IMAGE=ghcr.io/visiban/visiban/backend
TAG=v1.2.0
DIGEST=$(crane digest --platform linux/arm64 "$IMAGE:$TAG")
# or: docker buildx imagetools inspect "$IMAGE:$TAG"   (lists each platform's digest)

cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  "$IMAGE@$DIGEST" > attestation.json

# The SBOM is the predicate of the in-toto statement:
jq -r '.payload' attestation.json | head -1 | base64 -d | jq '.predicate' > backend-arm64.cdx.json
jq '.metadata.component' backend-arm64.cdx.json
# → {"type": "container", "name": "ghcr.io/visiban/visiban/backend", "version": "v1.2.0-arm64", ...}
```

`metadata.component.version` is always `<tag>-<arch>`, which shows which platform image the
SBOM describes. The release job generates each SBOM with [syft](https://github.com/anchore/syft),
attaches it, verifies it again in the same job, and fails the release if any of these is
wrong for either platform on either registry:

- the SBOM does not name its own image, tag, and architecture
- it lists no packages
- it lists a package built for the other architecture

You can feed the extracted SBOM to any CycloneDX-aware scanner, for example
`grype sbom:backend-arm64.cdx.json` or `trivy sbom backend-arm64.cdx.json`.

## Verify the Helm chart

```bash
cosign verify ghcr.io/visiban/charts/visiban:<chart-version> \
  --certificate-identity-regexp '^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/tags/v[0-9][^/]*$' \
  --certificate-oidc-issuer "$ISSUER"
```

`<chart-version>` is the chart's own `version:` (for example `0.7.0`), not the Visiban
release version. `helm show chart oci://ghcr.io/visiban/charts/visiban` prints both. The chart is only ever signed from a release tag pipeline, so its identity has no `heads/main`
alternative. A chart release is not published until both of that release's images have been
signed and attested.

## Older releases

Images published before this feature (1.1.x and the 1.2 pre-releases cut before it merged)
carry no image signature or SBOM, and `cosign verify` reports `no signatures found`.
This means the image was never signed. It does not mean the image was tampered with.
Maintainers can bring an already-published release up to the same bar without re-cutting
it: the manual `image-attest-backfill` CI job on `main` signs and attests a given tag's
images on both registries, and skips any digest that already verifies.

A backfilled release's certificate identity ends in `@refs/heads/main` rather than
`@refs/tags/v…`, because a released tag cannot be re-run without moving it. The tag-only
`IDENTITY` above rejects it. For a backfilled version **only**, verify with:

```bash
# Backfilled versions only: a release tag pipeline, or the manual backfill job on main.
IDENTITY='^https://gitlab\.com/visiban/visiban//\.gitlab-ci\.yml@refs/(tags/v[0-9][^/]*|heads/main)$'
```

Backfill is **trust-on-first-use**. The job signs whatever the tag points at when it runs,
not what the original release pipeline pushed. A backfilled signature therefore proves only
that Visiban's pipeline vouched for those bytes at backfill time. Only Maintainers should run
the job, and only after comparing the tag's current digests with the original release
pipeline's log. `scripts/attest-image-sbom.sh --dry-run` prints the digests read-only. The
wider regexp also accepts any later run of the backfill job on `main`. Accepting it for every
release would widen what you trust for no benefit, which is why it is not the default.

Charts published at or before `v1.2.0-alpha.2` are unsigned (#1284). See
[Known CI failures](../maintainers/known-ci-failures.md) if verification fails for a version
you expect to be signed.

## What this does not cover

- **Build provenance.** The SBOM says what is in the image, not how it was built. SLSA
  provenance attestations are not published.
- **Source signing.** Release git tags are not signed.
- **Mutable tags.** A signature on `:latest` or `:1.2` proves only what that tag pointed at
  when you checked. Pin by digest for anything you need to reproduce.
