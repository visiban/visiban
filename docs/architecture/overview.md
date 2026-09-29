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
             │ psycopg2               │ channels-redis
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
3. On connect, the consumer joins the `board_{id}` channel group and separately checks board membership, closing with code 4003 for a non-member regardless of how the connection was authenticated
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
│  │  SAST + Secret Detection (GitLab catalog components)     │
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
│  │  docs-deploy           (version tags only — mike deploy  │
│  │                         to gh-pages; stable → "latest",  │
│  │                         pre-release → "next" alias)      │
│  │  github-release, helm-publish (tags only)                │
└─────────────────────────────────────────────────────────────┘
```

Key design decisions:

- **Test and build stages run in parallel** — Docker image builds (kaniko `--no-push` verification) don't depend on test results, so they share the `test` stage to avoid sequential waiting.
- **Dependency and license scans are non-blocking** (`allow_failure: true`); `dep-scan-osv` is severity-gated instead — only low-severity findings are allowed to fail. SAST, secret detection, and the Bandit/eslint-security jobs block the merge like any other job.
- **Kaniko for amd64 Docker builds** — no Docker-in-Docker or privileged mode needed, runs on any runner. arm64 release images build on a dedicated Apple Silicon runner instead, since kaniko cannot cross-build — see [CI Runners](../maintainers/ci-runners.md).
- **Auto-retry on infrastructure failures** — runner system failures and stuck pods are retried up to 2 times automatically.
- **Docs versioned with mike** — each release tag publishes a frozen snapshot to docs.visiban.com; stable releases update the `latest` alias, pre-releases update `next`.

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
