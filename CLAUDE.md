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

---

## Licensing

- **OSS repo** — Apache 2.0. All files are covered by the root `LICENSE` file. Do not add per-file license headers to OSS files.
- **Enterprise repo** — dual-licensed:
  - Mirrored OSS files retain Apache 2.0 — never modify the root `LICENSE` file or add headers to mirrored files
  - Enterprise-specific code lives exclusively under the `enterprise/` directory and is covered by the Elastic License 2.0 (`LICENSE-ENTERPRISE`)
  - Every new file created under `enterprise/` must include this header comment at the top:
    ```
    # Copyright (c) Visiban. Licensed under the Elastic License 2.0.
    # See LICENSE-ENTERPRISE in the repository root for details.
    ```
    Use the appropriate comment syntax for the file type (`//` for TypeScript/JavaScript, `#` for Python, etc.)
- **Never** apply the ELv2 header to files outside `enterprise/` — OSS files are Apache 2.0 only
- **Never** apply Apache 2.0 headers to files inside `enterprise/` — they are ELv2 only

## Contributor License Agreement

- All external contributors must agree to the CLA before their MR can be merged — see `CLA.md`
- The default MR template (`.gitlab/merge_request_templates/Default.md`) includes a CLA checkbox; do not remove it
- The CLA grants Visiban the right to use contributions in both the OSS (Apache 2.0) and enterprise (ELv2) products — this is intentional and must not be weakened
- Core team members (employees/contractors with a signed agreement) are exempt from the CLA checkbox

## Frontend UI conventions

### Dropdown menus

All dropdown menus — whether using the shared `SelectDropdown` component (`frontend/src/components/Common/SelectDropdown.tsx`) or custom dropdown implementations (e.g. `FilterBar`) — must follow this style:

**Trigger button**
- `bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition`
- Default state: `border-slate-600 text-slate-300 hover:border-slate-400`
- Open / active-filter state: `border-blue-400 text-blue-400`

**Menu panel**
- `bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1`

**Menu items**
- `w-full text-left px-3 py-1.5 text-sm transition hover:bg-slate-700`
- Default text: `text-slate-300`; selected/active: `text-blue-400`

**Separators between every adjacent item pair** (3D engraved effect — applies to ALL dropdowns, including future ones):
```tsx
{i > 0 && (
  <div role="separator" className="mx-4">
    <div className="h-px bg-slate-900" />
    <div className="h-px bg-slate-600/50" />
  </div>
)}
```
- Place this before each item where `i > 0` — no manual `separatorBefore` prop needed
- For new `SelectDropdown` usages, this is automatic; for hand-rolled dropdowns (like FilterBar), add it manually to the item loop

---

## Mirror and governance maintenance

- OSS (`visiban/visiban`) push-mirrors to enterprise (`visiban/visiban-enterprise`) automatically on every push — all branches and tags
- The mirror uses a PAT belonging to `visiban-mirror-bot` (Maintainer on enterprise) — **token expires 2027-03-10**
- GitLab emails project maintainers after 3 consecutive mirror failures; ensure at least one maintainer has notifications enabled
- Enterprise-specific code lives exclusively in `enterprise/` — this directory is not present in OSS and will never be overwritten by the mirror
- Enterprise-specific dependencies (if any) belong in `enterprise/requirements.txt` / `enterprise/package.json` and must pass the same GPL license checks as OSS deps
