# Maintainer Runbooks

Operational reference for whoever runs the Visiban project itself — CI infrastructure,
credentials, and known failure patterns. This is **not** end-user or self-hosted-instance
documentation; see [Administration](../administration/index.md) for that audience.

These pages exist because operational facts that only live in a maintainer's personal notes
are invisible to everyone else and nothing forces them to stay current. Point-in-time facts
belong here, committed and versioned, not in a private notes file.

| Guide | Description |
|---|---|
| [CI Runners](ci-runners.md) | Self-hosted runner inventory, which jobs need them and why, the untagged-fallthrough trap |
| [Tokens and Rotation](tokens-and-rotation.md) | Every PAT and CI credential: scope, owner, storage, expiry, and how to rotate it |
| [Known CI Failures](known-ci-failures.md) | Failure signature → root cause → fix, so the next person greps instead of re-deriving |
| [Hosted Demo](demo-deploy.md) | try.visiban.com: where it runs, the out-of-band preconditions CI cannot check, install, tunnel, and the deployment record |

## Release checklist

The version-string half of a release is enforced by a gate rather than by memory. Do not
re-verify these by hand; run the release and read what the gate says.

- `scripts/release.sh <version>` rewrites the version-bearing files, including the
  `docs/index.md` banner: the release-candidate banner for RC tags, a pre-release banner for
  alpha/beta tags, and the stable "Latest release" banner for GA tags. It then runs the docs
  gate as a cross-check, plus its own consistency checks against `.env.example`,
  `frontend/package.json`, `README.md`, the `docs/getting-started/` pages,
  `docker-compose.prod.yml`, and the Helm chart — and **aborts the release** (rolling the
  branch back to `main`, no partial commit) if any of them fail, rather than merely warning
  (#1269).
- CI job `docs-version-accuracy` (script `scripts/check-docs-version-accuracy.sh`) runs on
  MRs, `main`, and tag pipelines. It reads the current version from `frontend/package.json`
  and fails on: a `Coming in X` / `Ships in X` / `Lands in X` / `Planned for X` claim naming
  an already-released version anywhere in `README.md`, `VISIBAN_FEATURES.md` or `docs/`; an
  RC banner on a GA version; stale `APP_VERSION=` / image-tag pins in `README.md` and
  `docs/getting-started/`; and a tag that does not match `frontend/package.json`.
- A failure means fix the page (there is no allowlist). `New in X` labels are provenance and
  are intentionally not flagged.

