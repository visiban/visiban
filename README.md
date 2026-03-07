# Visiban

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. Lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

## Quick start

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY and any OAuth credentials
docker compose up --build
```

Docker Compose starts four services: `db` (PostgreSQL 16), `redis` (Redis 7), `backend` (daphne ASGI), and `frontend` (Vite dev server).

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |

On first boot the backend prints a one-time admin password — see [First Boot](docs/getting-started/first-boot.md).

## Features

### Board

- CSS grid with columns (stages) on the x-axis and swimlane rows (customers / projects) on the y-axis
- Drag cards between cells; drag column headers to reorder columns — all changes are optimistic with automatic rollback on failure
- Every drag that changes column or swimlane creates a `CardMovement` audit record automatically
- Right-click any cell to open an inline card creation input in that exact column + swimlane
- Column headers sticky on horizontal scroll; each shows a live card count and total weight
- WIP limit exceeded → header turns red; weight limit exceeded → header turns orange
- Columns have an optional **allow card creation** flag — useful for marking "done" columns as write-protected
- Swimlanes are collapsible

### Cards

Each card has: title, description, priority (low / medium / high / urgent), assignee, labels, due date, weight, checklist, file attachments (up to 10 MB each), and threaded comments. Priority is shown as a colored left border.

### Filters

Client-side filters that stack without a round-trip: full-text search (title, description, assignee, labels), assignee, labels, priority, and due date (none / overdue / today / this week).

### Views

| View | Description |
|---|---|
| **Board** | Default kanban grid with drag-and-drop |
| **Summary** | Table of swimlane card counts with 7-day and 30-day velocity |
| **Analytics** | Dwell-time heatmap per stage with outlier detection, stalled card list, and CSV export |

### Real-time sync

WebSocket connection (Django Channels + Redis) pushes card and structural changes to all open tabs instantly — no polling. The toolbar shows a green **Live** dot when connected; the client reconnects automatically after 3 seconds on drop.

### Groups

Boards are organised into a group hierarchy (unlimited nesting, up to 6 levels traversal). Group membership is inherited downward — members of a parent group automatically have access to all subgroups and their boards. Group admins can generate shareable invite links.

### Access control

Five roles: `site_admin`, `admin`, `member`, `collaborator` (comment-only), `viewer` (read-only). Group membership grants board access automatically; board admins can override roles per user. Site admins see all boards and groups regardless of membership and are protected from demotion by non-site-admins.

### Card history

Full activity timeline per card: every column or swimlane change is recorded with actor and timestamp. Additional events: priority, weight, assignee, and label changes; comments; attachment add/delete; checklist item changes.

### Notifications

In-app notifications for card assignment and staleness detection.

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

## Environment variables

| Variable | Required | Description |
|---|:---:|---|
| `DJANGO_SECRET_KEY` | Yes | Generate with `python -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DATABASE_URL` | Yes | PostgreSQL DSN, e.g. `postgres://user:pass@host:5432/dbname` |
| `REDIS_URL` | Yes | Redis DSN (default in Docker Compose: `redis://redis:6379/0`) |
| `DEBUG` | No | `True` for local dev only |
| `ALLOWED_HOSTS` | No | Comma-separated hostnames (default: `localhost,127.0.0.1`) |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed frontend origins (default: `http://localhost:5173`) |
| `SITE_DOMAIN` | No | Public hostname for OAuth callbacks — must match your OAuth app redirect URI |

OAuth provider variables are documented in [OAuth Setup](docs/getting-started/oauth.md).

## Documentation

Full documentation is in [`/docs`](docs/index.md) and served by MkDocs:

```bash
pip install -r docs/requirements.txt
mkdocs serve        # http://localhost:8001
mkdocs build        # outputs to site/
```

Key pages:

- [Installation](docs/getting-started/installation.md)
- [Architecture](docs/architecture/overview.md)
- [Roles & Permissions](docs/rbac/roles.md)
- [API Reference](docs/api/boards.md)
- [Administration](docs/administration/site-admins.md)

## License

Apache 2.0 — see [LICENSE](LICENSE).
