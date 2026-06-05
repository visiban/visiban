# Architecture Overview

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
| Cache / Pub-Sub | Valkey 8 (Docker Compose and Helm — Bitnami subchart) |
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

## Request lifecycle (REST)

1. Browser sends REST request with session cookie
2. DRF authenticates via `SessionAuthentication`
3. View calls `get_board_role()` or `_require_group_admin()` to resolve the caller's effective role
4. Queryset filtering restricts results to accessible boards/groups
5. Response serialized and returned as JSON

## WebSocket lifecycle

1. Frontend opens `ws://{host}/ws/boards/{board_id}/` on page load
2. `AuthMiddlewareStack` authenticates the connection via the session cookie; unauthenticated connections are closed with code 4001
3. On connect, the consumer joins the `board_{id}` channel group
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
│  │  changelog-check (CHANGELOG.md [Unreleased] must update) │
│                                                             │
│  test                                                       │
│  │  backend-test          (Django tests, 90% coverage)      │
│  │  frontend-test         (Vitest)                          │
│  │  migration-check       (makemigrations --check)          │
│  │  backend-docker-build  (kaniko, MR only)                 │
│  │  frontend-docker-build (kaniko, MR only)                 │
│                                                             │
│  security (MR only)                                         │
│  │  backend-dep-scan   (pip-audit / OSV)                    │
│  │  frontend-dep-scan  (npm audit)                          │
│  │  secret-detection   (detect-secrets)                     │
│  │  semgrep-sast       (GitLab SAST component)              │
│                                                             │
│  deploy                                                     │
│  │  docker-push-backend   (main branch — pushes :latest     │
│  │  docker-push-frontend   and :<sha> to registry)          │
│  │  docs-deploy           (version tags only — mike deploy  │
│  │                         to gh-pages; stable → "latest",  │
│  │                         pre-release → "next" alias)      │
└─────────────────────────────────────────────────────────────┘
```

Key design decisions:

- **Test and build stages run in parallel** — Docker image builds (kaniko) don't depend on test results, so they share the `test` stage to avoid sequential waiting.
- **Security jobs are non-blocking** — `allow_failure: true` so they surface warnings without gating merges.
- **Kaniko for Docker builds** — no Docker-in-Docker or privileged mode needed, runs natively on Kubernetes runners.
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
