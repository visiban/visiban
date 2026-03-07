# Architecture Overview

## System components

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│              React 18 + TypeScript SPA              │
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
│      PostgreSQL 16      │ │         Redis 7         │
│  (primary data store)   │ │(WebSocket channel layer)│
└─────────────────────────┘ └─────────────────────────┘
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| ASGI server | daphne (required for WebSocket support) |
| Database | PostgreSQL 16 |
| Cache / Pub-Sub | Redis 7 (Django Channels channel layer) |
| Real-time | Django Channels 4, channels-redis |
| Auth | django-allauth (Google / GitHub / GitLab OAuth) + dj-rest-auth |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 3 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

## Django apps

| App | Responsibility |
|---|---|
| `accounts` | Custom `User` model, password change, auth provider list |
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
4. Any mutation (card move, update, delete) calls `broadcast_board_event()` which publishes to Redis
5. Redis fans the event out to all consumers in the group
6. Each consumer forwards the event to its WebSocket client
7. The `useBoardSocket` React hook applies the event to local state

## Frontend architecture

The SPA is a single `App.tsx` with React Router v6 routes:

- `/` — Dashboard (boards + group tree)
- `/groups/:id` — Group detail (members, boards, subgroups)
- `/boards/:id` — Board view (DnD kanban grid)
- `/join/:token` — Invite link landing page

State is local React state with optimistic updates on drag-and-drop. No global state library.
