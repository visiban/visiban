# Release

You are creating a release for Visiban. Follow these steps exactly — the release script handles the git, MR, pipeline, tagging, and docs deployment automatically. Do not attempt to replicate what the script does manually.

## Step 0 — Get the version string

If not provided in `$ARGUMENTS`, determine it:

1. Read `CHANGELOG.md [Unreleased]` and the git log since the last tag
2. Apply these rules:
   - **PATCH** — only `### Fixed` entries → e.g. `0.1.1`
   - **MINOR** — any `### Added` entries → e.g. `0.2.0`
   - **MAJOR** — any breaking change (removed/renamed API endpoints, changed auth flows, destructive migrations, incompatible config changes) → e.g. `1.0.0`
   - **Pre-release** — keep the same base version, increment suffix → e.g. `0.2.0-beta.1` → `0.2.0-beta.2`
   - When in doubt between MINOR and MAJOR, prefer MINOR and call it out explicitly
3. Present the suggestion with a one-line rationale and ask the user to confirm before proceeding

### Valid version format
- Stable: `MAJOR.MINOR.PATCH` (e.g. `1.2.3`)
- Pre-release: `MAJOR.MINOR.PATCH-<stage>.N` (e.g. `1.2.3-rc.1`)
- Valid stages in ascending order: `alpha` → `beta` → `rc`
- Pre-release suffix must include a numeric component (`rc.1` not `rc`)

## Step 1 — Pre-flight checks

Before running the script:
- [ ] Confirm all open MRs intended for this release are merged into `main`
- [ ] Confirm `CHANGELOG.md [Unreleased]` is up to date — if not, stop and update it first
- [ ] Confirm the working tree is clean (`git status`) and on `main` with latest pulled

## Step 2 — Run the release script

```bash
./scripts/release.sh {version}
```

The script will automatically:
1. Create a `chore/release-{version}` branch from `main`
2. Update `.env.example` and `docker-compose.yml` with the new version
3. Rotate `CHANGELOG.md` — moves `[Unreleased]` to `[vX.Y.Z] — YYYY-MM-DD`, prepends a fresh `[Unreleased]` block
4. Commit and push the branch
5. Create an MR targeting `main`
6. Wait for the pipeline to go green
7. Merge the MR
8. Tag the merge commit
9. Create a GitLab release with notes from the CHANGELOG
10. Deploy docs via `mike deploy --push --update-aliases`

Do not interrupt the script. If it fails, read the error output before taking any action.

## Step 3 — Post-release verification

- [ ] Confirm `APP_VERSION` in the running stack matches the new version
- [ ] Confirm docs.visiban.com shows the new version:
  - Stable releases publish under the `latest` alias
  - Pre-releases publish under the `next` alias
