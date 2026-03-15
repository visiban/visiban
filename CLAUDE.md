# Visiban — Claude Instructions

## Secure code — always on

When writing any backend code, apply these by default — no need to be asked:

- **No raw SQL** — always use the ORM or parameterized queries; never string-interpolate user input into a query
- **Input validation at the boundary** — validate and sanitize in serializers, not in views or models
- **Never log sensitive fields** — passwords, tokens, emails, and PII must not appear in log statements
- **Use `secrets` not `random`** for any token, key, or nonce generation
- **Flag `shell=True`** — any `subprocess` call with `shell=True` must have an inline comment explaining why it is safe; prefer list-form args
- **No hardcoded credentials** — secrets always come from env vars; never commit `.env` files or literal key values
- **Object-level authorization** — when fetching a resource by PK, always confirm the requesting user has access to that specific object (IDOR prevention)
- **Frontend: no `dangerouslySetInnerHTML`** unless the content is sanitized server-side and the reason is documented inline

These apply to all new code and to any existing code touched in a change. CI (`bandit`, `eslint-plugin-security`) enforces a subset of these automatically, but do not rely on CI as the first line of defense.

---

## Release process

When asked to create a release, invoke `/release`. The skill handles version string suggestion, pre-flight checks, running `scripts/release.sh`, and post-release verification.

---

## General conventions

- **Never commit or push directly to `main`** — all changes go through a feature branch and MR, no exceptions (including docs, chores, and hotfixes)
- **Never merge an MR with a failing pipeline** — the GitLab project enforces this (`only_allow_merge_if_pipeline_succeeds = true`), but do not attempt to work around it. If a pipeline fails, fix the root cause on the branch and let the pipeline re-run before merging.
- Branch naming: `feat/`, `fix/`, `docs/`, `chore/`
- Workflow for every change:
  1. `git checkout main && git pull origin main`
  2. `git checkout -b <prefix>/<short-description>`
  3. Make changes, commit, push branch
  4. Open MR targeting `main`, wait for a **green pipeline**, then merge
- Release commits also go through branches and MRs — `scripts/release.sh` handles this automatically
- All MR descriptions and git commit messages with multi-line bodies use heredoc syntax — never inline `\n` literals
- Always update `CHANGELOG.md` `[Unreleased]` section on any branch before merging
- **CHANGELOG entries must be appended to the existing `### Added` / `### Changed` / `### Fixed` section** within `[Unreleased]` — never create a second `### Added`, `### Changed`, or `### Fixed` heading in the same release block; duplicate headings cause the changelog to render incorrectly and entries to appear twice
- **Every new or modified feature must include test cases and documentation updates in the same MR** — do not ship a feature without both. This applies to frontend and backend changes equally:
  - Frontend tests: `frontend/src/test/`
  - Backend tests: `backend/boards/tests/` (or the relevant app's `tests/` directory)
  - Documentation: `docs/` and `README.md` where applicable
- Use **US English** in all code, comments, documentation, commit messages, MR descriptions, and UI copy — e.g. "color" not "colour", "center" not "centre", "canceled" not "cancelled", "authorization" not "authorisation"
- When writing complex business logic (model methods, custom serializer behaviour, transaction sequences, permission checks), add a docstring or inline comment explaining **why** — not what the code does, but the intent or constraint behind it

---

## Documentation conventions

- Docs live in the OSS repo alongside the code — never split into a separate repo
- When writing or updating documentation, invoke `/docs` — it covers structure, version callouts, enterprise callouts, nav updates, and build verification

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

See [`frontend/CLAUDE.md`](frontend/CLAUDE.md) for all frontend UI and branding rules — color tokens, buttons, inputs, dropdowns, modals, badges, swimlanes, typography, version display, and more.

---

## Mirror and governance maintenance

- OSS (`visiban/visiban`) push-mirrors to enterprise (`visiban/visiban-enterprise`) automatically on every push — all branches and tags
- The mirror uses a PAT belonging to `visiban-mirror-bot` (Maintainer on enterprise) — **token expires 2027-03-10**
- GitLab emails project maintainers after 3 consecutive mirror failures; ensure at least one maintainer has notifications enabled
- Enterprise-specific code lives exclusively in `enterprise/` — this directory is not present in OSS and will never be overwritten by the mirror
- Enterprise-specific dependencies (if any) belong in `enterprise/requirements.txt` / `enterprise/package.json` and must pass the same GPL license checks as OSS deps
