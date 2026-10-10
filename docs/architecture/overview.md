# Architecture Overview

How Visiban's pieces fit together: a Django/DRF backend and a React SPA, talking over REST and WebSocket, backed by PostgreSQL and Valkey. Read this first if you're contributing code or evaluating self-hosting.

## System components

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│              React 19 + TypeScript SPA              │
│         Vite dev server / Nginx (production)        │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / REST JSON
                       │ WebSocket (ws://)
┌──────────────────────▼──────────────────────────────┐
│           Django 5 + DRF  (daphne ASGI)             │
│   accounts/   boards/   groups/                     │
│   django-allauth   dj-rest-auth   channels          │
└────────────┬────────────────────────┬───────────────┘
             │ psycopg 3              │ channels-redis
┌────────────▼────────────┐ ┌─────────▼───────────────┐
│      PostgreSQL 17      │ │        Valkey 8          │
│  (primary data store)   │ │(WebSocket channel layer)│
└─────────────────────────┘ └─────────────────────────┘
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| ASGI server | daphne (required for WebSocket support) |
| Database | PostgreSQL 17 |
| Cache / Pub-Sub | Valkey 8 (Docker Compose; Helm — built-in StatefulSet on `valkey/valkey:8-alpine`) |
| Real-time | Django Channels 4, channels-redis |
| Auth | django-allauth (Google / GitHub / GitLab OAuth) + dj-rest-auth |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 3 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| CI/CD | GitLab CI (Ruff, ESLint, pytest, Vitest, Semgrep SAST, pip-audit, kaniko) |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

## Django apps

| App | Responsibility |
|---|---|
| `accounts` | Custom `User` model, `SiteSetting` (registration mode, uploads toggle), `PersonalAccessToken`, `InviteLink`, notification preferences, password change, auth provider list |
| `boards` | Boards, columns, swimlanes, labels, cards, movements, comments, attachments, checklists |
| `groups` | Group hierarchy, group memberships, invite links |
| `git_lens` | [Issue Board Lens](../features/issue-board-lens.md) — off by default (`GIT_LENS_ENABLED`); only registered, with its routes and one model, when the flag is on |

## Request lifecycle (REST)

1. Browser sends REST request with session cookie; a non-browser client sends a `PersonalAccessToken` instead
2. DRF authenticates, trying `PATAuthentication`, then `SessionAuthentication`, then `TokenAuthentication` in that order
3. View calls `get_board_role()` or `_require_group_admin()` to resolve the caller's effective role
4. Queryset filtering restricts results to accessible boards/groups
5. Response serialized and returned as JSON

## WebSocket lifecycle

1. Frontend opens `ws://{host}/ws/boards/{board_id}/` on page load
2. `AuthMiddlewareStack` authenticates the connection via the session cookie; unauthenticated connections are closed with code 4001. A caller with no session cookie — a PAT/DRF-token client, a different origin, or a native/CLI client — instead requests a short-lived, single-use **ticket** over REST first and passes it as `?ticket=` on the upgrade (`accounts.ws_auth.TicketAuthMiddleware`, #1109); the ticket only authenticates the connection, it grants no extra authorization
3. On connect, the consumer joins the `board_{id}` channel group and separately checks board membership, closing with code 4003 for a non-member (or an account with a pending password or username change) regardless of how the connection was authenticated
4. Any mutation (card move, update, delete) calls `broadcast_board_event()` which publishes to Valkey
5. Valkey fans the event out to all consumers in the group
6. Each consumer forwards the event to its WebSocket client
7. The `useBoardSocket` React hook applies the event to local state

## CI/CD pipeline

GitLab CI runs on every push, MR, and version tag. The pipeline validates code quality, runs tests, scans for vulnerabilities, and — on merges to `main` and version tags — deploys Docker images and the docs site.

```
┌─────────────────────────────────────────────────────────────┐
│                     GitLab CI Pipeline                      │
│                                                             │
│  lint                                                       │
│  │  backend-lint    (Ruff + CodeClimate report)             │
│  │  frontend-lint   (ESLint + tsc --noEmit)                 │
│  │  changelog-check (changelog.d/ fragment required)        │
│                                                             │
│  test                                                       │
│  │  backend-test-coverage (Django tests, 90% floor)         │
│  │  frontend-test         (Vitest)                          │
│  │  migration-check       (makemigrations --check + zero-   │
│  │                         downtime schema checks)           │
│  │  backend-docker-build  (kaniko --no-push, verification)  │
│  │  frontend-docker-build (kaniko --no-push, verification)  │
│  │  helm-lint / helm-template / helm-install / helm-netpol  │
│                                                             │
│  security                                                    │
│  │  SAST + Secret Detection (pinned catalog components;     │
│  │    see Security Scanners runbook for what blocks)        │
│  │  backend-sast (Bandit) / frontend-sast (eslint-security) │
│  │  backend-dep-scan / frontend-dep-scan / dep-scan-osv     │
│  │  gitleaks-scan, trivy-scan, license-check jobs           │
│                                                             │
│  deploy                                                     │
│  │  backend-docker-push / frontend-docker-push (kaniko;     │
│  │    amd64 on any runner, arm64 on a dedicated runner —    │
│  │    tags only; see CI Runners)                            │
│  │  backend-manifest / frontend-manifest (multi-arch        │
│  │    manifests, tags only)                                 │
│  │  backend-image-attest / frontend-image-attest (cosign    │
│  │    sign + per-arch CycloneDX SBOM attestation, both      │
│  │    registries, tags only)                                │
│  │  docs-deploy           (version tags only — mike deploy  │
│  │                         to gh-pages; stable → "latest",  │
│  │                         pre-release → "next" alias)      │
│  │  github-release, helm-publish (tags only)                │
└─────────────────────────────────────────────────────────────┘
```

Key design decisions:

- **Test and build stages run in parallel** — Docker image builds (kaniko `--no-push` verification) don't depend on test results, so they share the `test` stage to avoid sequential waiting.
- **Security scanners: most block, a few deliberately do not** — see [Which security jobs block a merge](#which-security-jobs-block-a-merge) below. A failing blocking job stops the merge because the GitLab project enforces `only_allow_merge_if_pipeline_succeeds`.
- **Kaniko for amd64 Docker builds** — no Docker-in-Docker or privileged mode needed, runs on any runner. arm64 release images build on a dedicated Apple Silicon runner instead, since kaniko cannot cross-build — see [CI Runners](../maintainers/ci-runners.md).
- **Auto-retry on infrastructure failures** — runner system failures and stuck pods are retried up to 2 times automatically.
- **Docs versioned with mike** — each release tag publishes a frozen snapshot to docs.visiban.com; stable releases update the `latest` alias, pre-releases update `next`.

### Which security jobs block a merge

"Blocks" means the job fails the pipeline, and the project setting `only_allow_merge_if_pipeline_succeeds` then prevents the merge. A job with `allow_failure: true` shows a yellow warning instead. Full policy, suppression format, and runbook: [Security Scanners](../maintainers/security-scanners.md).

| Job | Checks | Runs on | Blocks an MR? | Blocks the nightly schedule? |
|---|---|---|---|---|
| `gitleaks-scan` | Secrets in the whole working tree | MR, `main` | Yes, any finding | Yes (the `main` rule matches a schedule on `main`) |
| `gitleaks-history` | Secrets in full git history | `main` only (post-merge tripwire) | No (not run on MRs) | Yes, on `main` pipelines, including a schedule on `main` |
| `secret_detection` + `secret-detection-gate` | GitLab secret-detection component | MR, `main` | Yes, via the gate. The component job exits 0 on findings, so `allow_failure: false` on it alone only catches an analyzer crash; `secret-detection-gate` reads its report and fails on any unsuppressed finding | Yes (same rules on `main`) |
| `semgrep-sast` + `sast-severity-gate` | GitLab SAST component (Python, TypeScript/JavaScript) | MR, `main` | Yes, via the gate, at High/Critical only; Low/Medium/Info stay visible in the MR security widget | Yes (same rules on `main`) |
| `backend-sast` | bandit, medium+ | MR and `main`, when `backend/**/*.py` changed | Yes | Yes (`changes:` matches on a schedule) |
| `frontend-sast` | eslint-plugin-security (`error` rules only; object-injection and timing rules are `warn`) | MR and `main`, when `frontend/src/**/*.{ts,tsx}` changed | Yes | Yes (`changes:` matches on a schedule) |
| `trivy-scan` | HIGH/CRITICAL vulnerabilities, Dockerfile/Helm misconfigurations, and secrets in the repo filesystem | MR when a Dockerfile, a dependency manifest or lockfile (`requirements.txt`, `requirements.lock`, `requirements-build.lock`, `package-lock.json`), `helm/`, `.gitlab-ci.yml`, `.trivyignore.yaml`, or the expiry script changed; nightly (`CVE_SCAN=true`). Not every `main` push | Yes (`--exit-code 1`, no `allow_failure`) | Yes |
| `backend-dep-scan` (pip-audit) | CVEs in `backend/requirements.lock` | MR when a backend requirements file changed; nightly (`CVE_SCAN=true`) | No (`allow_failure: true` on MRs) | Yes (`allow_failure: false`) |
| `frontend-dep-scan` (npm audit) | HIGH/CRITICAL CVEs in `frontend/package-lock.json`, minus expiring accepted risks | MR when `package-lock.json` changed; nightly (`CVE_SCAN=true`) | No (`allow_failure: true` on MRs) | Yes (`allow_failure: false`) |
| `dep-scan-osv` | OSV advisories for `backend/requirements.txt` and `frontend/package-lock.json` | Every MR, `main`, and nightly (`OSV_SCAN=true`) | Yes for HIGH/CRITICAL (CVSS 7.0 or higher, or a HIGH/CRITICAL advisory label when unscored) and for a missing or unparseable report (exit 1). MEDIUM, LOW, and unscored advisories exit 2, which `allow_failure: exit_codes: [2]` turns into a warning | Same: blocks on HIGH/CRITICAL, warns on the rest |
| `backend-license-check` / `frontend-license-check` | GPL-2.0 / GPL-3.0 dependencies | MR | No (`allow_failure: true`; warn only) | n/a (MR only) |
| `sonar:scan` | SonarCloud analysis and coverage import | Nightly (`SONAR_SCHEDULED=true`) only | No | No (`allow_failure: true`, `qualitygate.wait=false`; dashboard refresh, not a gate) |

Notes:

- Because dep-scan-osv warns (exit 2) on MEDIUM/LOW findings, a pipeline can be green while that job shows yellow. Check the job itself, not just the pipeline status.
- The pip-audit and npm audit jobs are nightly drift detectors on purpose: a new CVE against an unchanged dependency fails the nightly pipeline (and emails maintainers) rather than blocking unrelated MRs.

## Frontend architecture

The SPA is a single `App.tsx` with React Router v7 routes:

- `/` — Dashboard (boards + group tree)
- `/groups/:id` — Group detail (members, boards, subgroups)
- `/boards/:id` — Board view (DnD kanban grid)
- `/settings` — User settings (profile, locale, appearance, notifications, security)
- `/join/:token` — Invite link landing page
- `/share/:token` — Public read-only board view (no authentication required)
- `/admin` — Site administration panel (site admins only)

State is local React state with optimistic updates on drag-and-drop. No global state library.
