# Visiban

A self-hosted Kanban board with swimlane rows and automatic card movement tracking. Lightweight alternative to Trello/Smartsheet focused on pipeline visibility per swimlane, with a full audit trail of every card movement between stages.

## Features

- **Swimlanes** — each row represents an entity (customer, project, team); columns are pipeline stages
- **Movement history** — every drag automatically logs from/to column, from/to swimlane, who moved it, and when
- **Time-in-stage metrics** — see how long a card spent in each stage
- **OAuth login** — Google, GitHub, and GitLab
- **WIP limits** — optional per-column work-in-progress card count limit; header turns red when exceeded
- **Card weights** — assign a numeric weight to each card (default 1) to represent effort or complexity
- **Weight limits** — optional per-column cap on total card weight; header turns orange when exceeded
- **Editable columns** — click any column header to update its name, colour, WIP limit, or weight limit
- **Square card tiles** — compact tiles auto-fill column width; multiple cards visible per swimlane cell
- **Right-click to add** — right-click any cell to instantly open the add-card input
- **Labels** — board-scoped, reusable across all cards; create with a colour picker directly from the card detail panel
- **Priority, assignees, due dates, comments** on cards — all editable inline
- **Optimistic drag-and-drop** — instant UI updates with rollback on failure

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, Django 5, Django REST Framework |
| Database | PostgreSQL 16 |
| Auth | django-allauth (Google / GitHub / GitLab OAuth) |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS 3 |
| Drag & Drop | @dnd-kit/core + @dnd-kit/sortable |
| Infra | Docker Compose, Nginx |

## Getting Started

### Prerequisites

- Docker and Docker Compose (for the Docker path)
- Python 3.12+ and Node.js 18+ (for local development)

### Docker (recommended)

1. Clone the repo and copy the environment template:

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env
```

2. Fill in your OAuth credentials in `.env` (see [OAuth Setup](#oauth-setup) below).

3. Start all services:

```bash
docker compose up --build
```

- Backend API: http://localhost:8000
- Frontend: http://localhost:5173
- Admin: http://localhost:8000/admin

### Local Development (without Docker)

**Backend**

```bash
cd backend

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp ../.env.example .env
# Edit .env and set DATABASE_URL to use SQLite for local dev:
#   DATABASE_URL=sqlite:///db.sqlite3

# Run migrations and create a superuser
python manage.py migrate
python manage.py createsuperuser  # optional

# Start the dev server
python manage.py runserver
```

Backend runs at http://localhost:8000.

**Frontend**

```bash
cd frontend

# Install dependencies
npm install

# Start the dev server
npm run dev
```

Frontend runs at http://localhost:5173.

### OAuth Setup

Create OAuth apps for the providers you want to use and add the credentials to `.env`:

**Google** — [Google Cloud Console](https://console.cloud.google.com/) > APIs & Services > Credentials
Scopes: `openid`, `email`, `profile`

**GitHub** — GitHub Settings > Developer settings > OAuth Apps
Scopes: `read:user`, `user:email`

**GitLab** — GitLab > User Settings > Applications
Scopes: `read_user`, `openid`, `email`

## Project Structure

```
visiban/
├── backend/
│   ├── visiban/         # Django project settings
│   ├── accounts/        # Custom user model, auth views
│   ├── boards/          # Board, Column, Customer, Card, CardMovement models + API
│   ├── manage.py
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/            # React + Vite app (Phase 3)
├── docker-compose.yml
├── .env.example
└── README.md
```

## API Overview

```
GET  /api/boards/                          List boards
POST /api/boards/                          Create board
GET  /api/boards/{id}/full/                Full board state (columns, swimlanes, cards, labels)

POST /api/boards/{id}/columns/             Create column (name, color, wip_limit, weight_limit)
PATCH /api/boards/{id}/columns/{id}/       Update column (name, color, wip_limit, weight_limit)
POST /api/boards/{id}/columns/reorder/     Reorder columns

POST /api/boards/{id}/customers/           Create swimlane (name, contact_email, color)
POST /api/boards/{id}/customers/reorder/   Reorder swimlanes

POST /api/boards/{id}/labels/              Create board-scoped label (name, color)

POST /api/boards/{id}/cards/               Create card
PATCH /api/boards/{id}/cards/{id}/         Update card (title, description, priority, due_date, weight, assignee_id, label_ids)
POST /api/boards/{id}/cards/{id}/move/     Move card (triggers audit log)
GET  /api/boards/{id}/cards/{id}/movements/ Movement history
POST /api/boards/{id}/cards/{id}/comments/ Add comment
```

## Kubernetes / Helm

A production-ready Helm chart is included under `helm/visiban/`.

### Prerequisites
- Kubernetes 1.25+
- Helm 3.10+
- Images built and pushed to a registry (see `Dockerfile.prod` in `backend/` and `frontend/`)

### Install

```bash
# Add the Bitnami repo (for the PostgreSQL subchart)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Download chart dependencies
helm dependency update helm/visiban

# Install (replace values as needed)
helm install visiban helm/visiban \
  --set ingress.host=visiban.example.com \
  --set secret.djangoSecretKey=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))") \
  --set postgresql.auth.password=<strong-password>
```

### Upgrade

```bash
helm upgrade visiban helm/visiban --reuse-values
```

### Key values

| Value | Default | Description |
|---|---|---|
| `ingress.host` | `visiban.example.com` | Public hostname |
| `ingress.tls.enabled` | `false` | Enable TLS (requires cert-manager or manual secret) |
| `secret.djangoSecretKey` | `change-me-in-production` | Django `SECRET_KEY` |
| `postgresql.auth.password` | `visiban` | Database password |
| `backend.image.tag` | `latest` | Backend image tag |
| `frontend.image.tag` | `latest` | Frontend image tag |
| `postgresql.enabled` | `true` | Use built-in PostgreSQL (set false to use `externalDatabase`) |

### Production Dockerfiles

```bash
# Build production images
docker build -f backend/Dockerfile.prod -t <registry>/visiban/backend:latest backend/
docker build -f frontend/Dockerfile.prod -t <registry>/visiban/frontend:latest frontend/

docker push <registry>/visiban/backend:latest
docker push <registry>/visiban/frontend:latest
```

## Running Tests

```bash
# Docker
docker compose run --rm backend python manage.py test

# Local
cd backend && python manage.py test
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
