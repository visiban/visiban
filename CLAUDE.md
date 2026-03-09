# Visiban — Claude Instructions

## Release process

When asked to create a release, run the release script. Ask for the version string before starting if it hasn't been provided.

### Version string
- Format: strict [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH` for stable releases, `MAJOR.MINOR.PATCH-<stage>.N` for pre-releases
  - Valid pre-release stages in ascending order: `alpha` → `beta` → `rc`
  - Examples: `0.1.0-alpha.1`, `0.1.0-beta.1`, `1.0.0-rc.1`, `0.1.1`, `0.2.0`, `1.0.0`
  - Pre-release suffixes must include a numeric component (`rc.1` not `rc`)
  - Semver precedence: `1.0.0-alpha.1 < 1.0.0-beta.1 < 1.0.0-rc.1 < 1.0.0`
  - Use `alpha` for early/unstable builds, `beta` for feature-complete but unpolished, `rc` for release candidates (production-ready, baking before stable)
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
   The script will: create a release branch, update `.env.example`, rotate `CHANGELOG.md`, commit, push the branch, create an MR, wait for the pipeline, merge, tag, and create the GitLab release automatically.
4. Confirm `APP_VERSION` in the running stack matches the new version

---

## General conventions

- **Never commit or push directly to `main`** — all changes go through a feature branch and MR, no exceptions (including docs, chores, and hotfixes)
- Branch naming: `feat/`, `fix/`, `docs/`, `chore/`
- Workflow for every change:
  1. `git checkout main && git pull origin main`
  2. `git checkout -b <prefix>/<short-description>`
  3. Make changes, commit, push branch
  4. Open MR targeting `main`, merge when ready
- Release commits also go through branches and MRs — `scripts/release.sh` handles this automatically
- All MR descriptions and git commit messages with multi-line bodies use heredoc syntax — never inline `\n` literals
- Always update `CHANGELOG.md` `[Unreleased]` section on any branch before merging
- When functionality changes, update the relevant documentation in `docs/` and `README.md` (if applicable) to reflect the new behavior
- Use **US English** in all code, comments, documentation, commit messages, MR descriptions, and UI copy — e.g. "color" not "colour", "center" not "centre", "canceled" not "cancelled", "authorization" not "authorisation"

---

## Documentation conventions

- Docs live in the OSS repo alongside the code — never split into a separate repo
- When writing or updating documentation, mark any feature that requires the enterprise edition with a callout:
  ```markdown
  > **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).
  ```
- Place the callout immediately after the section heading for the enterprise feature
- Enterprise-only features that may appear in OSS docs include: SSO/SAML, audit logs, advanced analytics, automation rules, external integrations, multi-tenancy, white-labeling, and compliance tooling
- Do **not** add the enterprise callout to core OSS features — only features that require the enterprise edition
- When documenting a feature that has both an OSS and enterprise tier (e.g. basic analytics in OSS, advanced analytics in enterprise), note the distinction inline

---

## Open core vs. enterprise boundary

Visiban follows an open-core model:

- **OSS repo** (`visiban/visiban`) — the fully functional core product
- **Enterprise repo** (`visiban/visiban-enterprise`) — private, mirrors OSS and adds premium features

### Guiding principle

A small team should be able to use Visiban end-to-end without needing the enterprise edition. If a feature is necessary for a single team to complete their day-to-day workflow — creating boards, managing cards, collaborating, and tracking progress — it belongs in the OSS core.

When evaluating whether a feature is OSS or enterprise, ask: **"Can a small team work together effectively without this?"**

- If **no** → it should be in the OSS core (suggest this to the user)
- If **yes** → it is a candidate for enterprise

Enterprise features are things like: SSO/SAML, audit logs, advanced analytics, automation rules, integrations with external services, multi-tenancy, white-labeling, and compliance tooling.

### Rules

- **Never add enterprise code to the OSS repo** — enterprise features live exclusively in `visiban/visiban-enterprise`
- If a planned enterprise feature turns out to be essential for basic team workflows, flag it and suggest moving it to OSS
- OSS should expose clean extension points (settings includes, URL patterns, hook interfaces) that enterprise can plug into without modifying OSS files
