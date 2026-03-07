# Architecture Overview

## System components

```
┌─────────────────────────────────────────────────────┐
│                     Browser                         │
│              React 18 + TypeScript SPA              │
│         Vite dev server / Nginx (production)        │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / REST JSON
┌──────────────────────▼──────────────────────────────┐
│                  Django 5 + DRF                     │
│   accounts/   boards/   groups/                     │
│   django-allauth   dj-rest-auth                     │
└──────────────────────┬──────────────────────────────┘
                       │ psycopg2
┌──────────────────────▼──────────────────────────────┐
│                PostgreSQL 16                        │
└─────────────────────────────────────────────────────┘
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| Database | PostgreSQL 16 |
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

## Request lifecycle

1. Browser sends REST request with session cookie
2. DRF authenticates via `SessionAuthentication`
3. View calls `get_board_role()` or `_require_group_admin()` to resolve the caller's effective role
4. Queryset filtering restricts results to accessible boards/groups
5. Response serialized and returned as JSON

## Frontend architecture

The SPA is a single `App.tsx` with React Router v6 routes:

- `/` — Dashboard (boards + group tree)
- `/groups/:id` — Group detail (members, boards, subgroups)
- `/boards/:id` — Board view (DnD kanban grid)
- `/join/:token` — Invite link landing page

State is local React state with optimistic updates on drag-and-drop. No global state library.
