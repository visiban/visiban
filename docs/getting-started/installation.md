# Installation

## Prerequisites

- Docker and Docker Compose **or** Python 3.12+ and Node.js 18+
- Redis 7+ (included automatically in Docker Compose and Helm; required for WebSocket real-time updates — Docker Compose bundles Redis 7, Kubernetes/Helm bundles Redis 8)

## Docker (recommended)

> **Tested:** The Docker Compose development setup has been verified end-to-end. If something doesn't work, open an issue.

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY and any OAuth credentials
docker compose up --build
```

Docker Compose starts four services: `db` (Postgres 17), `redis` (Redis 7), `backend` (daphne/ASGI), and `frontend` (Vite dev server).

This setup is for **local development only** — the Vite dev server is not suitable for production. See [Production with HTTPS](#production-with-https) below for a production deployment.

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |

On first boot the backend will print a one-time admin password — see [First Boot](first-boot.md).

### Troubleshooting

**`db` container exits immediately / backend cannot connect**

A common cause after pulling updates is a PostgreSQL major-version mismatch. The data volume was initialized by one major version (e.g. PG 16) and the image has been updated to a newer one (e.g. PG 17), which refuses to start:

```
db-1 | FATAL: database files are incompatible with server
db-1 | DETAIL: The data directory was initialized by PostgreSQL version 16, which is not compatible with this version 17.x.
```

> **⚠ Destructive:** The steps below delete all local database data. Back up anything you need to keep first (`docker compose exec db pg_dump -U visiban visiban > backup.sql`).

```bash
docker compose down -v          # stop all containers and remove volumes
docker compose up --build       # recreate from scratch
```

After the containers start, run migrations and recreate the site admin account:

```bash
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py ensure_site_admin
```

---

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
| `REDIS_URL` | Yes | Redis DSN for Channels / WebSocket (default: `redis://redis:6379/0` in Docker Compose) |
| `REDIS_CACHE_URL` | No | Redis DSN for the Django cache — rate limiting, health checks (default: `redis://localhost:6379/1`). In Docker Compose this is set automatically. Use a different database index than `REDIS_URL` to avoid key collisions. |
| `FRONTEND_URL` | No | Full URL of the React SPA (default: `http://localhost:5173`) — allauth redirects here after OAuth login/logout. **Must be set in production.** |
| `DEBUG` | No | Set `True` for local dev only |
| `ALLOWED_HOSTS` | No | Comma-separated hostnames (default: `localhost,127.0.0.1`) |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed frontend origins (default: `http://localhost:5173`). Also controls `CSRF_TRUSTED_ORIGINS` unless `CSRF_TRUSTED_ORIGINS` is set explicitly. |
| `CSRF_TRUSTED_ORIGINS` | No | Override CSRF trusted origins independently of `CORS_ALLOWED_ORIGINS`. Defaults to `CORS_ALLOWED_ORIGINS`. |
| `SITE_DOMAIN` | No | Public hostname used for OAuth callbacks (default: `localhost:8000`) — must match your OAuth app's redirect URI |
| `DJANGO_SUPERUSER_USERNAME` | No | Override bootstrap admin username (default: `admin`) |
| `DJANGO_SUPERUSER_EMAIL` | No | Override bootstrap admin email (default: `admin@localhost`) |

OAuth variables are documented in [OAuth Setup](oauth.md).

## Kubernetes / Helm

> **Tested:** The Helm chart has been deployed and verified on a live Kubernetes cluster.

A Helm chart is included for Kubernetes deployments. See [Deployment — Kubernetes / Helm](../architecture/deployment.md#kubernetes-helm) for install instructions, configuration values, and upgrade steps.

## Production with HTTPS

> **Note:** The production Docker Compose stack has not been tested in a live environment yet. The configuration is complete and follows standard practices, but treat it as best-effort until it has been end-to-end validated. If you find issues, please open an issue.

The production stack (`docker-compose.prod.yml`) replaces the Vite dev server with:

| Component | Role |
|---|---|
| **Nginx** | Serves the compiled React app; proxies `/api/`, `/_allauth/`, `/ws/`, `/admin/`, `/static/`, `/media/` to the backend |
| **Frontend build** | `npm run build` runs once at startup and outputs static files to a shared volume |
| **Certbot** | Obtains the Let's Encrypt certificate on first boot; renews automatically every 12 hours |

### Prerequisites

- A Linux server (VPS, cloud VM, bare metal) reachable on the public internet
- Ports **80** and **443** open in your firewall / security group
- A DNS **A record** pointing `yourdomain.com` → your server's public IP
  (Let's Encrypt verifies domain ownership before issuing a certificate — DNS must resolve before running the init script)
- **Docker** and **Docker Compose** installed
- **`envsubst`** available on the host (used to render the nginx config template)

Installing `envsubst`:

```bash
# Ubuntu / Debian
sudo apt-get install -y gettext-base

# CentOS / RHEL / Amazon Linux
sudo yum install -y gettext

# macOS (Homebrew)
brew install gettext && brew link --force gettext
```

### Step 1 — Clone and configure

```bash
git clone https://gitlab.com/visiban/visiban.git
cd visiban
cp .env.example .env
```

Open `.env` in a text editor and set the following values. Every line marked **required** must be changed before continuing.

```bash
# Django
DJANGO_SECRET_KEY=<long random string>   # required — generate: python -c "import secrets; print(secrets.token_urlsafe(50))"
DEBUG=false                              # required — never run DEBUG=true in production
ALLOWED_HOSTS=yourdomain.com            # required
CORS_ALLOWED_ORIGINS=https://yourdomain.com  # required
FRONTEND_URL=https://yourdomain.com     # required — allauth redirects here after OAuth login/logout
SITE_DOMAIN=yourdomain.com             # required — used for OAuth callback URLs

# Database (Postgres runs inside Docker Compose)
DATABASE_URL=postgres://visiban:${DB_PASSWORD}@db:5432/visiban
DB_PASSWORD=<strong password>           # required — used by both Django and Postgres

# Redis (runs inside Docker Compose — no change needed)
# REDIS_URL and REDIS_CACHE_URL are set in docker-compose.prod.yml environment block.
# Only override here if you use an external Redis.

# Let's Encrypt
DOMAIN=yourdomain.com                   # required — must match your DNS A record
CERTBOT_EMAIL=admin@yourdomain.com     # required — used for cert expiry alerts

# App version — set to the version you are deploying (see CHANGELOG.md)
APP_VERSION=1.0.0-rc.1
```

> **OAuth** (Google, GitHub, GitLab) is optional. See [OAuth Setup](oauth.md) if you want social login.

### Step 2 — Run the init script

```bash
chmod +x init-letsencrypt.sh
./init-letsencrypt.sh
```

The script performs these steps automatically:

1. Renders `nginx/app.conf` from `nginx/app.conf.template` using your `DOMAIN`
2. Builds the backend and frontend Docker images
3. Runs the **certbot standalone** container — it temporarily binds port 80 to complete the ACME HTTP-01 challenge and obtain the certificate
4. Starts the full stack: `db`, `redis`, `backend`, `nginx`, `frontend-build`, `certbot`

When it finishes you will see:

```
  Visiban is live at https://yourdomain.com
```

### Step 3 — Verify

| Check | Expected |
|---|---|
| `https://yourdomain.com` loads | React app renders and you can log in |
| `http://yourdomain.com` | Redirects to HTTPS |
| Green **Live** dot in toolbar | WebSocket connected |
| `https://yourdomain.com/admin/` | Django admin accessible |

The backend prints a one-time admin password on first boot — run `docker compose -f docker-compose.prod.yml logs backend` to retrieve it.

### Subsequent deploys

Pull the latest code and rebuild:

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

This rebuilds images, re-runs the frontend build (output replaces the previous static files in the shared volume), and restarts services with zero manual steps.

### Certificate renewal

The `certbot` container calls `certbot renew` every 12 hours. Let's Encrypt certificates are valid for 90 days and are renewed automatically when fewer than 30 days remain. No manual action is required.

To check renewal status:

```bash
docker compose -f docker-compose.prod.yml logs certbot
```

### Stopping and starting

```bash
# Stop all services (data volumes are preserved)
docker compose -f docker-compose.prod.yml down

# Start again (no rebuild needed unless code changed)
docker compose -f docker-compose.prod.yml up -d
```

### Updating to a new version

```bash
cd visiban
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

Django migrations run automatically on startup. Check the backend logs after updating:

```bash
docker compose -f docker-compose.prod.yml logs backend | tail -20
```

### Backing up and restoring

**Database backup:**

```bash
docker compose -f docker-compose.prod.yml exec db \
  pg_dump -U visiban visiban > backup_$(date +%Y%m%d).sql
```

**Database restore:**

```bash
docker compose -f docker-compose.prod.yml exec -T db \
  psql -U visiban visiban < backup_20260308.sql
```

**Media files** (card attachments) are stored in a Docker volume. Back them up with:

```bash
docker compose -f docker-compose.prod.yml exec backend \
  tar czf /tmp/media.tar.gz -C /app media/
docker compose -f docker-compose.prod.yml cp backend:/tmp/media.tar.gz ./media_backup.tar.gz
```

### Troubleshooting

**`certbot: error: Could not bind to port 80`**
Something else is already using port 80. Stop it before running the init script:
```bash
sudo systemctl stop nginx apache2   # or whichever service holds port 80
./init-letsencrypt.sh
```

**`Challenge failed: DNS problem: NXDOMAIN`**
Your DNS A record hasn't propagated yet. Check with `dig yourdomain.com` — it must return your server's IP before certbot can issue a certificate. Wait a few minutes and retry.

**Let's Encrypt rate limit**
If you hit the issuance limit (5 certs per domain per week during testing), add `--staging` to the certbot command in `init-letsencrypt.sh` to use the Let's Encrypt staging environment. Remove it once you're ready for a real certificate.

**Nginx `502 Bad Gateway`**
The backend may still be starting up. Check: `docker compose -f docker-compose.prod.yml logs backend`. Wait for the `daphne` line to appear before reloading the page.

**`nginx/app.conf` is missing**
This file is generated by `init-letsencrypt.sh` and is intentionally excluded from version control. If you delete it, re-run the init script (it will skip cert issuance if the cert already exists).
