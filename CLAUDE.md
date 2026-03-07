# Visiban — Claude Instructions

## Release process

When asked to create a release, run the release script. Ask for the version string before starting if it hasn't been provided.

### Version string
- Format: strict [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH` for stable releases, `MAJOR.MINOR.PATCH-alpha.N` or `MAJOR.MINOR.PATCH-beta.N` for pre-releases
  - Examples: `0.1.0-alpha.1`, `0.1.0-beta.1`, `0.1.1`, `0.2.0`, `1.0.0`
  - Pre-release suffixes must include a numeric component (`alpha.1` not `alpha`)
- If not provided, read `CHANGELOG.md [Unreleased]` and the git log since the last tag, then suggest a version using these rules:
  - **PATCH** — only `### Fixed` entries (bug fixes, no new features, no breaking changes) → e.g. `0.1.1`
  - **MINOR** — any `### Added` entries (new backwards-compatible features, with or without fixes) → e.g. `0.2.0`
  - **MAJOR** — any breaking change: removed or renamed API endpoints, changed auth flows, destructive migrations, incompatible config changes → e.g. `1.0.0`
  - For pre-releases, keep the same base version and increment the suffix number → e.g. `0.2.0-beta.1` → `0.2.0-beta.2`
  - When in doubt between MINOR and MAJOR, prefer MINOR and call it out explicitly
- Present the suggestion with a one-line rationale before asking the user to confirm

### Steps
1. Confirm all open MRs intended for this release are merged into `main`
2. Ensure the `## [Unreleased]` section of `CHANGELOG.md` is up to date
3. Run the release script from the repo root on `main` with a clean working tree:
   ```bash
   ./scripts/release.sh {version}
   ```
   The script will: update `.env.example`, rotate `CHANGELOG.md`, commit, tag, push to `main`, and create the GitLab release automatically.
4. Confirm `APP_VERSION` in the running stack matches the new version

---

## General conventions

- All MR descriptions and git commit messages with multi-line bodies use heredoc syntax — never inline `\n` literals
- Branch naming: `feat/`, `fix/`, `docs/`, `chore/`
- Always update `CHANGELOG.md` `[Unreleased]` section on any branch before merging
