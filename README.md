# Visiban

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. Lightweight alternative to Trello/Smartsheet focused on pipeline visibility per customer or project, with a full audit trail of every card movement between stages.

## Quick start

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env          # set DJANGO_SECRET_KEY
docker compose up --build
```

On first boot a one-time admin password is printed to the backend logs — see the [First Boot](docs/getting-started/first-boot.md) guide.

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |

## Documentation

Full documentation is in [`/docs`](docs/index.md):

- [Installation](docs/getting-started/installation.md)
- [Architecture](docs/architecture/overview.md)
- [Roles & Permissions](docs/rbac/roles.md)
- [API Reference](docs/api/boards.md)
- [Administration](docs/administration/site-admins.md)

### Build the docs site

```bash
pip install -r docs/requirements.txt
mkdocs serve        # http://localhost:8001
mkdocs build        # outputs to site/
```

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| Database | PostgreSQL 16 |
| Auth | django-allauth (Google / GitHub / GitLab OAuth) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 3 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Infra | Docker Compose, Nginx, Helm |

## License

Apache 2.0 — see [LICENSE](LICENSE).
