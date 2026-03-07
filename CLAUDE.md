# Visiban — Claude Instructions

## Release process

When asked to create a release, follow these steps in order. Ask for the version string before starting if it hasn't been provided.

### 1. Pre-flight
- Confirm all open MRs intended for this release are merged
- `git checkout main && git pull origin main`
- Confirm working tree is clean

### 2. Version string
- Format: strict [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH` for stable releases, `MAJOR.MINOR.PATCH-alpha.N` or `MAJOR.MINOR.PATCH-beta.N` for pre-releases
  - Examples: `0.1.0-alpha.1`, `0.1.0-beta.1`, `0.1.1`, `0.2.0`, `1.0.0`
  - Increment `PATCH` for backwards-compatible bug fixes, `MINOR` for new backwards-compatible features, `MAJOR` for breaking changes
  - Pre-release suffixes must include a numeric component (`alpha.1` not `alpha`)
- If not provided, ask: _"What version string should I use for this release?"_

### 3. Update files
- **`docker-compose.yml`** — set `APP_VERSION: {version}` (not `${APP_VERSION:-dev}`)
- **`.env.example`** — set `APP_VERSION={version}`
- **`CHANGELOG.md`** — rename `## [Unreleased]` to `## [v{version}] — {today's date}`, add a one-line summary of the release, then add a fresh empty `## [Unreleased]` above it

### 4. Commit & tag
```bash
git add CHANGELOG.md docker-compose.yml .env.example
git commit -m "chore: release v{version}"
git push origin main
```

### 5. Create GitLab release
```bash
glab release create v{version} --name "v{version}" --notes "..."
```
Use the content of the new `[v{version}]` CHANGELOG section as the release notes.

### 6. Confirm
- Verify the tag appears on GitLab
- Confirm `APP_VERSION` in the running stack matches the new version

---

## General conventions

- All MR descriptions and git commit messages with multi-line bodies use heredoc syntax — never inline `\n` literals
- Branch naming: `feat/`, `fix/`, `docs/`, `chore/`
- Always update `CHANGELOG.md` `[Unreleased]` section on any branch before merging
