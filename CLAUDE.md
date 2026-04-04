# Visiban — Claude Instructions

## Personas

- **Maya** (Project Manager, mid-size team): plans sprints, monitors progress, needs at-a-glance status across multiple simultaneous workstreams. Values: speed and overview. Pain: too many context switches, can't see the whole picture in one place.
- **Jordan** (Senior Engineer, power user): lives in the board all day, uses keyboard shortcuts, relies on the audit trail for incident retrospectives. Values: accuracy, keyboard nav, full history. Pain: anything that interrupts flow or hides information.
- **Sam** (Designer, occasional user): checks in a few times a week to update card status and add notes. Values: intuitive UI that requires no training. Pain: features that assume daily familiarity.
- **Alex** (IT Admin): provisions users, manages SSO, monitors usage, handles onboarding. Values: control, visibility, low maintenance. Pain: anything requiring manual intervention at scale.

---

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

## Backward compatibility — always on from 1.0

Visiban 1.0 is a public API contract. Every change from this point forward must be backward compatible unless a major version bump is explicitly planned. Apply these rules by default:

### REST API
- **Never remove or rename a field** from an existing serializer response — add new fields, deprecate old ones, never delete them in a patch or minor release
- **Never change a field's type** (e.g. string → integer, nullable → required) without a major bump
- **Never remove an endpoint** — return `410 Gone` with a deprecation notice for at least one minor release first
- **New optional query params only** — never add a required query param to an existing endpoint; new body fields must be optional with a sensible default

### Database migrations
- **Every new column must be nullable or have a default** — `NOT NULL` without a default requires a multi-step deploy and blocks zero-downtime upgrades
- **Never drop a column or table** in the same migration that removes the ORM reference — add a second migration after at least one release cycle
- **Rename = add + copy + drop** in three separate releases — never rename a column in a single migration

### WebSocket event schema
- The `{event, data}` shape is the public contract for `board_*` events. Never switch back to a flat `{type, ...spread}` schema — it collides with serializer field names
- **Never remove an event type** — add new ones freely; mark old ones deprecated in the docs for at least one release before removing
- **Never remove a field from an event payload** — add fields freely; removals require a major bump

### TypeScript / frontend contracts
- **`Board`, `Card`, `User`, and related interfaces must match the backend serializer fields exactly** — when a new serializer field is added, update the corresponding TypeScript interface in the same MR
- **Never remove a field from a shared interface** without confirming it is unreferenced across the entire frontend

### Settings and env vars
- **Never rename an env var** — add the new name and keep the old one as a deprecated alias for at least one minor release
- **Never change the default value** of an existing env var in a way that alters behavior for existing installs — document it explicitly in CHANGELOG and the upgrade guide

### OSS / enterprise extension boundary
- The OSS core must remain fully functional without the enterprise repo — do not introduce hard dependencies on enterprise hooks, signals, or settings
- Extension points (settings includes, URL patterns, signal hooks) must remain stable — enterprise code registers against them; changing their shape is a breaking change for enterprise customers

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
- **Changelog entries use fragment files** — create a file in `changelog.d/` named `<issue-or-slug>.<type>.md` (e.g. `434.fixed.md`) instead of editing `CHANGELOG.md` directly. Valid types: `added`, `changed`, `fixed`, `security`. The CI `changelog-check` job enforces this. Fragments are assembled into `CHANGELOG.md` automatically at release time by `scripts/assemble-changelog.sh`. **Never edit `CHANGELOG.md` directly on a feature branch.**
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

## Backend test conventions

### Threaded tests — always close DB connections

Any test that spawns threads which touch the Django ORM **must** call `connections.close_all()` inside the thread function before it returns:

```python
from django.db import connections as _conns

def worker():
    # ... ORM calls ...
    _conns.close_all()  # release thread-local PostgreSQL connection

t = threading.Thread(target=worker)
t.start(); t.join()
```

**Why:** Django opens a per-thread database connection on first ORM access. The test runner only knows about the main thread's connection. Thread-local connections remain open after the thread exits, causing `TransactionTestCase.teardown_databases()` to fail with `"database is being accessed by other users"` when it tries to `DROP` the test database — breaking every subsequent pipeline job. This applies to any test that uses `threading.Thread`, `concurrent.futures`, or any other concurrency primitive.

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
