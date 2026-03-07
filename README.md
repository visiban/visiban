# Visiban

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. Lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

## Quick start

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env          # set DJANGO_SECRET_KEY and OAuth credentials
docker compose up --build
```

On first boot a one-time admin password is printed to the backend logs — see the [First Boot](docs/getting-started/first-boot.md) guide.

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |

## Features

- **Kanban board** — CSS grid of columns x swimlane rows; drag cards between cells, drag columns to reorder
- **Swimlanes** — one row per customer/project; collapsible, colour-coded
- **Card movement audit trail** — every column or swimlane change is recorded with actor, timestamp, and notes
- **Real-time sync** — WebSocket connection broadcasts structural changes (columns, swimlanes, cards) to all open tabs instantly
- **Card detail** — description, priority, weight, assignee, labels, due date, checklists, attachments, comments, activity timeline
- **Filters** — search, assignee, labels, priority, due date (overdue / today / this week)
- **WIP & weight limits** — per-column limits with visual indicators
- **Analytics** — dwell-time heatmap, stalled cards, summary table
- **Notifications** — assignment alerts and staleness detection
- **Groups** — hierarchical board organisation; group membership inherits board access
- **Role-based access** — five roles: site admin, board admin, member, collaborator, viewer
- **OAuth** — Google, GitHub, and GitLab login via django-allauth

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| Database | PostgreSQL 16 |
| Auth | django-allauth (Google / GitHub / GitLab OAuth) |
| WebSockets | Django Channels + Redis channel layer |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 3 |
| Drag & drop | @dnd-kit/core + @dnd-kit/sortable |
| Infra | Docker Compose, Nginx, Helm |

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
