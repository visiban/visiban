# Visiban

A self-hosted Kanban board built around swimlane rows and automatic card movement tracking. Use it to manage customer pipelines, project workflows, or any process where you need to see what stage each item is in — and a full history of how it got there.

## Contents

- [Overview](#overview)
- [Documentation](#documentation)
- [Getting started](#getting-started)
- [Features](#features)
- [Tech stack](#tech-stack)

---

## Overview

Visiban gives you a grid of **columns** (stages) and **swimlane rows** (customers, projects, or any entity moving through your process). Cards live in cells at the intersection of a column and a swimlane. Drag a card to a new cell and a movement record is created automatically — who moved it, when, and from where.

Multiple users can have the board open at the same time. Changes appear on everyone's screen instantly over a WebSocket connection, with no page refresh needed.

---

## Documentation

Full documentation is available in the [`/docs`](docs/index.md) folder and can be served locally with MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve   # opens at http://localhost:8001
```

| Topic | Link |
|---|---|
| Installation | [docs/getting-started/installation.md](docs/getting-started/installation.md) |
| OAuth setup | [docs/getting-started/oauth.md](docs/getting-started/oauth.md) |
| Roles & permissions | [docs/rbac/roles.md](docs/rbac/roles.md) |
| Architecture | [docs/architecture/overview.md](docs/architecture/overview.md) |
| API reference | [docs/api/boards.md](docs/api/boards.md) |
| Administration | [docs/administration/site-admins.md](docs/administration/site-admins.md) |

---

## Getting started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

That's it for the quick start. Redis and PostgreSQL are included in the Docker Compose file — you don't need to install them separately.

### 1. Clone and configure

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env
```

Open `.env` and set at minimum:

| Variable | Description |
|---|---|
| `DJANGO_SECRET_KEY` | Any long random string. Generate one with: `python -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DATABASE_URL` | Pre-filled for Docker Compose — leave it unless you're using an external database |
| `REDIS_URL` | Pre-filled for Docker Compose — leave it unless you're using an external Redis |

OAuth login (Google, GitHub, GitLab) is optional. See [OAuth Setup](docs/getting-started/oauth.md) if you want it.

### 2. Start the stack

```bash
docker compose up --build
```

This starts four services:

| Service | URL | Description |
|---|---|---|
| Frontend | http://localhost:5173 | React app |
| Backend API | http://localhost:8000 | Django REST API + WebSocket server |
| Django admin | http://localhost:8000/admin | Admin panel |
| Redis | (internal) | WebSocket channel layer |

### 3. Log in

On first boot, the backend prints a one-time admin password to the terminal logs. Use it to log in at http://localhost:5173. You'll be prompted to change it immediately.

See [First Boot](docs/getting-started/first-boot.md) for details.

---

## Features

### Kanban board

The board is a grid of columns and swimlane rows. Each cell is a drop zone for cards.

- Drag cards between cells to move them through your pipeline
- Drag column headers left or right to reorder stages
- Right-click any cell to add a card directly into that column and swimlane
- Swimlanes can be collapsed to save screen space
- Column headers stay fixed as you scroll horizontally

### Columns

Each column (stage) can have:

- A **name** and **colour**
- A **WIP limit** — maximum number of cards. Header turns red when exceeded
- A **weight limit** — maximum total card weight. Header turns orange when exceeded
- An **allow card creation** toggle — disable on "Done" columns to prevent accidental adds

### Cards

Each card has:

| Field | Notes |
|---|---|
| Title | Required |
| Description | Free text |
| Priority | low / medium / high / urgent — shown as a coloured left border |
| Assignee | Any board member |
| Labels | Board-scoped, multi-select |
| Due date | Optional |
| Weight | Numeric effort estimate (default 1) |
| Checklist | Sub-tasks with checked/unchecked state |
| Attachments | Files up to 10 MB each |
| Comments | Visible to all board members |

### Card movement history

Every time a card moves to a different column or swimlane, a movement record is saved: who moved it, when, and from where. Each card's detail view shows the full timeline alongside comments and other activity (priority changes, assignee changes, etc.).

### Filters

Filter the board client-side without a page reload. Filters stack — all conditions must match.

- **Search** — matches card title, description, assignee name, and label names
- **Assignee** — any member, or "Unassigned"
- **Labels** — card must have all selected labels
- **Priority** — one or more of low / medium / high / urgent
- **Due date** — none set / overdue / due today / due this week

### Views

Switch between three views from the toolbar:

| View | What it shows |
|---|---|
| **Board** | The live kanban grid with drag-and-drop |
| **Summary** | Table of swimlane card counts with 7-day and 30-day velocity |
| **Analytics** | Dwell-time heatmap per stage, outlier detection, stalled card list, CSV export |

### Real-time sync

All open tabs on the same board stay in sync over a WebSocket connection. Card moves, edits, additions, deletions, and structural changes (columns, swimlanes) appear immediately without refreshing. The toolbar shows a green **Live** dot when connected. The client reconnects automatically if the connection drops.

### Groups

Boards are organised into a group hierarchy — groups can contain subgroups to any depth.

- Group membership is **inherited**: a member of a parent group automatically has access to all subgroups and their boards
- Group admins can create subgroups, manage members, and generate shareable **invite links** for onboarding users without knowing their username in advance
- The dashboard shows all groups the user belongs to in a collapsible tree

### Access control

Five roles control what users can do:

| Role | Scope | What they can do |
|---|---|---|
| `site_admin` | Site-wide | Full access to everything |
| `admin` | Group or Board | Manage structure, members, and settings |
| `member` | Group or Board | Create, edit, and move cards |
| `collaborator` | Board only | Comment on cards |
| `viewer` | Board only | Read-only access |

Group membership grants board access automatically. Board admins can override the role per user from the Members panel in the board toolbar.

### Notifications

In-app notifications for card assignment and cards that have gone stale (not moved in a configurable number of days).

---

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
| Drag & drop | @dnd-kit/core + @dnd-kit/sortable |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
