# Visiban

[![coverage](https://gitlab.com/visiban/visiban/badges/main/coverage.svg)](https://gitlab.com/visiban/visiban/-/pipelines)
[![pipeline](https://gitlab.com/visiban/visiban/badges/main/pipeline.svg)](https://gitlab.com/visiban/visiban/-/pipelines)
![License](https://img.shields.io/badge/license-Apache%202.0-blue)

When you're managing multiple customers or projects through a multi-stage process, two questions come up constantly: _where is everything right now_, and _how did it get there_? Most Kanban tools answer the first but not the second — and none of them let you track many independent entities (customers, accounts, projects) as separate rows on the same board.

Visiban is a self-hosted Kanban board that solves both problems. It gives each entity its own **swimlane row** so you can see every customer or project and its current stage at a glance. Every time a card moves between columns, a timestamped movement record is created automatically — so you always have a full audit trail of who moved what, when, and from where. Changes made by other users appear on your screen instantly over a live WebSocket connection.

## Contents

- [Overview](#overview)
- [Documentation](#documentation)
- [Getting started](#getting-started)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Contributing](#contributing)

---

## Overview

Visiban gives you a grid of **columns** (stages) and **swimlane rows** (customers, projects, or any entity moving through your process). Each card belongs to a column and a swimlane. Drag a card to a new column and a movement record is created automatically — who moved it, when, and from where.

Multiple users can have the board open at the same time. Changes appear on everyone's screen instantly over a WebSocket connection, with no page refresh needed.

---

## Documentation

Full documentation is available in the [`/docs`](docs/index.md) folder and can be served locally with MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve --dev-addr=localhost:8001   # port 8001 avoids conflict with Django on 8000
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
git clone https://gitlab.com/visiban/visiban.git
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
| Frontend | http://localhost:5173 | React app (Vite dev server) |
| Backend API | http://localhost:8000 | Django REST API + WebSocket server |
| Django admin | http://localhost:8000/admin | Admin panel |
| Redis | (internal) | WebSocket channel layer |

This setup is for **local development only**. For a production deployment with HTTPS, see step 3.

### 3. Log in

On first boot, the backend prints a one-time admin password to the terminal logs. Use it to log in at http://localhost:5173. You'll be prompted to change it immediately.

See [First Boot](docs/getting-started/first-boot.md) for details.

---

## Production deployment

For a public-facing server, use the production stack which swaps the Vite dev server for a built React app served by Nginx with automatic HTTPS via Let's Encrypt.

**Prerequisites:** a server with ports 80 and 443 open, and a DNS A record pointing your domain to the server's IP.

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env
```

Edit `.env` and add the production values:

```
DJANGO_SECRET_KEY=<long random string>
DEBUG=false
ALLOWED_HOSTS=yourdomain.com
CORS_ALLOWED_ORIGINS=https://yourdomain.com
SITE_DOMAIN=yourdomain.com

DOMAIN=yourdomain.com
CERTBOT_EMAIL=admin@yourdomain.com
DB_PASSWORD=<strong password>
```

Then run the one-time setup script:

```bash
chmod +x init-letsencrypt.sh
./init-letsencrypt.sh
```

The script obtains the TLS certificate and starts the full stack. Visiban is then live at `https://yourdomain.com`. Certificates renew automatically.

Full instructions, troubleshooting, and subsequent deploy steps are in [docs/getting-started/installation.md](docs/getting-started/installation.md#production-with-https).

---

## Features

### Kanban board

The board is a grid of columns and swimlane rows. Drop cards into any column to move them through your pipeline.

- Drag cards between columns to advance them through your stages
- Drag column headers left or right to reorder stages
- Drag a column to the right edge to reveal a **trash zone** — drop to delete the column (with confirmation)
- Hover a column header to reveal **+** buttons at its edges — insert a new column immediately left or right without drag-reordering
- Right-click any board cell to add a card directly into that column and swimlane
- **Bulk operations** — select multiple cards via checkboxes, then move, assign, set priority, or delete them all at once from a toolbar at the bottom of the board
- Swimlanes can be collapsed to save screen space
- Columns can be collapsed — they span the full board height and display per-swimlane card counts
- Column headers stay fixed as you scroll horizontally

### Keyboard shortcuts

| Key | Action |
|---|---|
| `f` | Toggle the filter bar |
| `/` | Open the filter bar and focus the search input |
| `?` | Show / hide the keyboard shortcuts overlay |
| `Esc` | Deselect cards / close the card detail panel or any open dialog |

### Columns

Each column (stage) can have:

- A **name** and **color**
- A **WIP limit** — maximum number of cards. Header turns red when exceeded
- A **weight limit** — maximum total card weight. Header turns orange when exceeded
- An **allow card creation** toggle — disable on "Done" columns to prevent accidental adds

### Cards

Cards are displayed as compact horizontal rows with a colored left border indicating priority. Hovering over a card expands it to reveal additional metadata inline.

Each card has:

| Field | Notes |
|---|---|
| Title | Required |
| Description | Free text |
| Priority | low / medium / high / urgent — shown as a colored left border |
| Assignee | Any board member; shown as an initials avatar |
| Labels | Board-scoped, multi-select; shown as color pills on the card |
| Due date | Optional; shown as relative text ("Today", "Tomorrow", "3d", "2d late") |
| Weight | Numeric effort estimate (default 1, hidden when 1) |
| Checklist | Sub-tasks with checked/unchecked state; progress shown on the card |
| Attachments | Files up to 10 MB each; count shown on the card |
| Comments | Visible to all board members; type `@` to mention a member; timestamps show relative time for recent comments and full date + time for older ones |

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
| **Analytics** | Dwell-time heatmap per stage, outlier detection, stalled card list, CSV export (admin only) |

### Export & import

Export a board as CSV or JSON from the **Export** dropdown in the board toolbar. CSV includes all cards with metadata and movement history; JSON includes the full board structure (columns, swimlanes, labels, cards with comments and checklists).

Import a board from a previously exported JSON or CSV file via the **Import** button on the dashboard or the group detail page. The import atomically creates a new board with all structure and cards. When importing from a group page, the board is placed directly into that group.

### Real-time sync

All open tabs on the same board stay in sync over a WebSocket connection. Card moves, edits, additions, deletions, and structural changes (columns, swimlanes) appear immediately without refreshing. The toolbar shows a green **Live** dot when connected. The client reconnects automatically if the connection drops.

### Groups

Boards are organized into a group hierarchy — groups can contain subgroups to any depth.

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

In-app notifications for card assignment, @mentions in comments, and cards that have gone stale (not moved in a configurable number of days). The notification dropdown shows only unread notifications — clicking a notification marks it as read and navigates to the relevant card. Read notifications stay dismissed across page refreshes.

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
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 3 |
| Drag & drop | @dnd-kit/core + @dnd-kit/sortable |
| CI/CD | GitLab CI (lint, test, security scan, Docker build verification) |
| Infra | Docker Compose, Nginx, Helm (Kubernetes) |

---

## Contributing

Bug reports, feature requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines, including how to file a bug report and set up a local development environment.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a full history of changes.

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
