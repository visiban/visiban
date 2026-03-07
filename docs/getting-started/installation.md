# Installation

## Prerequisites

- Docker and Docker Compose **or** Python 3.12+ and Node.js 18+
- Redis 7+ (included automatically in Docker Compose and Helm; required for WebSocket real-time updates)

## Docker (recommended)

```bash
git clone https://gitlab.com/kellyhair/visiban.git
cd visiban
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY and any OAuth credentials
docker compose up --build
```

Docker Compose starts four services: `db` (Postgres 16), `redis` (Redis 7), `backend` (daphne/ASGI), and `frontend` (Vite dev server).

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |

On first boot the backend will print a one-time admin password — see [First Boot](first-boot.md).

## Local Development

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp ../.env.example .env
# Set DATABASE_URL=sqlite:///db.sqlite3 for local SQLite

python manage.py migrate
python manage.py ensure_site_admin   # prints one-time password
python manage.py runserver
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|---|:---:|---|
| `DJANGO_SECRET_KEY` | Yes | Django secret key — generate with `python -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DATABASE_URL` | Yes | PostgreSQL DSN e.g. `postgres://user:pass@host:5432/dbname` |
| `REDIS_URL` | Yes | Redis DSN (default: `redis://redis:6379/0` in Docker Compose) |
| `DEBUG` | No | Set `True` for local dev only |
| `ALLOWED_HOSTS` | No | Comma-separated hostnames (default: `localhost,127.0.0.1`) |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed frontend origins (default: `http://localhost:5173`) |
| `SITE_DOMAIN` | No | Public hostname used for OAuth callbacks (default: `localhost:8000`) — must match your OAuth app's redirect URI |
| `DJANGO_SUPERUSER_USERNAME` | No | Override bootstrap admin username (default: `admin`) |
| `DJANGO_SUPERUSER_EMAIL` | No | Override bootstrap admin email (default: `admin@localhost`) |

OAuth variables are documented in [OAuth Setup](oauth.md).
