# Installation

## Hardware requirements

| Tier | vCPU | RAM | Disk | Notes |
|------|------|-----|------|-------|
| Minimum (production) | 2 | 4 GB | 40 GB SSD | ≤10 users; comfortable for a first install |
| Recommended (production) | 4 | 8 GB | 80 GB SSD | 10–50 users; room to grow |
| Development | 4 | 8 GB | 40 GB free | Docker Desktop on Mac/Windows needs at least 6–8 GB allocated to the VM; Vite dev server spikes on hot reload |

The production stack at idle consumes ~350 MB for PostgreSQL, ~350 MB for daphne workers, and ~160 MB combined for Redis, Nginx, and Docker overhead — leaving no safe margin on a 1 GB host. 4 GB is the minimum that provides headroom for startup, migrations, and WebSocket bursts without risking OOM.

**Disk:** Docker image pulls and build cache alone account for ~3–4 GB. The main unbounded variable is file attachments (cards support up to 10 MB each). The figures above assume light-to-moderate attachment use. Teams with heavy attachment activity should plan for additional storage or configure object storage (S3-compatible).

## Prerequisites

- Docker and Docker Compose **or** Python 3.12+ and Node.js 18+
- Redis 7+ (included automatically in Docker Compose and Helm; required for WebSocket real-time updates — Docker Compose bundles Redis 7, Kubernetes/Helm bundles Redis 8)

## Docker (recommended)

> **Tested:** The Docker Compose development setup has been verified end-to-end. If something doesn't work, open an issue.

```bash
git clone https://gitlab.com/visiban/visiban.git && cd visiban
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY and any OAuth credentials
docker compose up --build
```

!!! note "`--build` is required on first install and after pulling updates"
    The `--build` flag tells Docker Compose to build the images before starting containers. It is required the first time you run the stack (no pre-built images exist locally yet) and any time you pull code changes that affect the `Dockerfile` or frontend assets. Omitting it on a fresh clone will fail; omitting it after `git pull` may leave you running stale images.

Docker Compose starts four services: `db` (Postgres 17), `redis` (Redis 7), `backend` (daphne/ASGI), and `frontend` (Vite dev server).

This setup is for **local development only** — the Vite dev server is not suitable for production. See [Production Deployment](#production-deployment) below for a production deployment.

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |
| API Schema (Swagger UI) | http://localhost:8000/api/schema/swagger-ui/ |
| API Schema (ReDoc) | http://localhost:8000/api/schema/redoc/ |
| API Schema (raw YAML) | http://localhost:8000/api/schema/ |

> **Note:** The schema endpoints are served by Django — access them on port 8000 directly. The Vite dev server on port 5173 does not proxy `/api/` requests, so `http://localhost:5173/api/schema/` will not work.

On first boot the backend will print a one-time admin password — see [First Boot](first-boot.md).

!!! warning "Accessing from a non-localhost address?"
    The defaults in `.env.example` are configured for `localhost` only. If you access Visiban from a LAN IP address, hostname, or any address other than `127.0.0.1`, you must update two variables before starting the stack — otherwise API calls may fail and WebSocket connections will stay stuck on **Reconnecting**:

    ```bash
    ALLOWED_HOSTS=192.168.1.100          # or your LAN hostname
    CORS_ALLOWED_ORIGINS=http://192.168.1.100:5173   # must match the exact origin the browser uses
    ```

    For production deployments behind nginx (where the frontend and backend share the same origin), the `CORS_ALLOWED_ORIGINS` value should match the nginx-served origin (e.g. `http://192.168.1.100:8080`), not the Vite dev server port.

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

**API calls fail / browser shows a CORS error**

If the browser console shows a CORS error (e.g. `Access to fetch at 'http://...' from origin '...' has been blocked`) it means the backend is rejecting cross-origin requests from the address the browser is using. This happens when you access Visiban from anything other than `http://localhost:5173` — a LAN IP, a VM hostname, a different port, etc.

At startup, the backend logs the active CORS origins. Check what it has:

```bash
docker compose logs backend | grep "CORS allowed origins"
```

If the logged origin does not match what your browser shows in the address bar, update `.env`:

```bash
CORS_ALLOWED_ORIGINS=http://192.168.1.100:5173   # must be the exact origin the browser uses
ALLOWED_HOSTS=192.168.1.100                       # must include the hostname/IP too
```

Then restart the backend:

```bash
docker compose restart backend
```

### Running two Visiban stacks side-by-side

If you have a second checkout of Visiban (or another Compose project that uses the same default ports), the two stacks will fight over `5432` / `8000` / `5173` on the host. The default `docker-compose.yml` reads host ports and the Compose project name from `.env` so a second checkout can coexist without changes to source.

In the second checkout's `.env`, set:

```bash
COMPOSE_PROJECT_NAME=visiban-secondary    # namespaces containers, networks, volumes
DB_PORT=5433
BACKEND_PORT=8001
FRONTEND_PORT=5174
KEYCLOAK_PORT=8081                         # only matters when running docker-compose.oidc.yml
# REDIS_PORT=6380                          # rarely needed — only for host-side redis-cli/GUI

# Must move with FRONTEND_PORT — the backend rejects requests from any other origin
CORS_ALLOWED_ORIGINS=http://localhost:5174
FRONTEND_URL=http://localhost:5174

# Must move with BACKEND_PORT — used to build OAuth callback URLs
SITE_DOMAIN=localhost:8001

# Must move with BACKEND_PORT — the URL the browser uses to call the API.
# Read by the frontend container and exposed to client code via import.meta.env.
VITE_API_URL=http://localhost:8001
```

Containers always listen on the canonical ports (`5432` / `8000` / `5173` / `8080`) on the internal Compose network — only the host-side mapping changes. Vite's HMR client port is wired to `FRONTEND_PORT` automatically so hot reload keeps working when the host port shifts.

!!! note "Why aren't the URL vars interpolated from the port vars?"
    `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `SITE_DOMAIN`, and `VITE_API_URL` are kept as separate explicit values rather than `${FRONTEND_PORT}`-style interpolation because Compose's `env_file:` directive does **not** expand variables — interpolated values would arrive at the Django container as literal `${FRONTEND_PORT}` strings and silently break allauth redirects, OAuth callbacks, and CORS. Four vars, four explicit updates: it's a bit more typing but it works in every dev path (Compose, native Python, Helm).

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

`npm run dev` expects the backend to be reachable at `http://localhost:8000`. Create `frontend/.env.local` (gitignored — never commit it) to tell Vite where the API is:

```bash
# frontend/.env.local — local dev only, never included in Docker builds
VITE_API_URL=http://localhost:8000
```

A template with comments is at `frontend/.env.local.example`.

## Environment Variables

| Variable | Required | Description |
|---|:---:|---|
| `DJANGO_SECRET_KEY` | Yes | Django secret key — generate with `python -c "import secrets; print(secrets.token_urlsafe(50))"` |
| `DATABASE_URL` | Yes | PostgreSQL DSN e.g. `postgres://user:pass@host:5432/dbname` |
| `REDIS_URL` | Yes | Redis DSN for Channels / WebSocket (default: `redis://redis:6379/0` in Docker Compose) |
| `REDIS_CACHE_URL` | No | Redis DSN for the Django cache — rate limiting, health checks (default: `redis://localhost:6379/1`). In Docker Compose this is set automatically. Use a different database index than `REDIS_URL` to avoid key collisions. |
| `FRONTEND_URL` | No | Full URL of the React SPA (default: `http://localhost:5173`) — allauth redirects here after OAuth login/logout. **Must be set in production.** |
| `DEBUG` | No | Set `True` for local dev only |
| `ALLOWED_HOSTS` | No | Comma-separated hostnames (default: `localhost,127.0.0.1`). **Must be set to your actual domain in production** — the default only permits loopback addresses and will cause Django to reject all requests from a real hostname. |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed frontend origins (default: `http://localhost:5173`). Also controls `CSRF_TRUSTED_ORIGINS` unless `CSRF_TRUSTED_ORIGINS` is set explicitly. |
| `CSRF_TRUSTED_ORIGINS` | No | Override CSRF trusted origins independently of `CORS_ALLOWED_ORIGINS`. Defaults to `CORS_ALLOWED_ORIGINS`. |
| `SITE_DOMAIN` | No | Public hostname used for OAuth callbacks (default: `localhost:8000`) — must match your OAuth app's redirect URI |
| `VITE_API_URL` | No | Browser-facing backend URL (default: `http://localhost:8000`) — the frontend bundle calls the API at this origin. Must move with `BACKEND_PORT` when running side-by-side stacks; in production, set to your public backend origin (e.g. `https://api.yourdomain.com` or the same origin as the SPA when served behind a single proxy). |
| `DJANGO_SUPERUSER_USERNAME` | No | Override bootstrap admin username (default: `admin`) |
| `DJANGO_SUPERUSER_EMAIL` | No | Override bootstrap admin email (default: `admin@localhost`) |
| `EMAIL_VERIFICATION` | No | Email verification mode: `optional` (default — sends verification email but allows login without it), `none` (no verification required, works without SMTP), or `mandatory` (blocks login until email is verified). The old alias `ACCOUNT_EMAIL_VERIFICATION` was removed in 1.1 — use `EMAIL_VERIFICATION` only. |
| `SECURE_HSTS_SECONDS` | No | HTTP Strict-Transport-Security max-age in seconds (default: `0` in development, `31536000` — 1 year — in production when `DEBUG=false`). **Warning:** setting this incorrectly locks browsers into HTTPS for the full duration with no easy rollback. Set to a small value (e.g. `300`) when first enabling HTTPS, then increase once you confirm everything works. |
| `DJANGO_ADMIN_ALLOWED_IPS` | No | Comma-separated list of IP addresses (or CIDR blocks) allowed to access `/admin/`. In production the default is loopback only (`127.0.0.1`, `::1`). Set this to your management network range if you need non-loopback access. Also documented in [Secret Rotation](../administration/secret-rotation.md). |
| `OIDC_CLIENT_ID` | No | OIDC provider client ID — required when using generic OIDC / OpenID Connect SSO (e.g. Keycloak, Authentik). All three `OIDC_*` vars must be set together to enable OIDC login. See [OAuth Setup](oauth.md). |
| `OIDC_CLIENT_SECRET` | No | OIDC provider client secret. The old alias `OIDC_SECRET` was removed in 1.1 — only `OIDC_CLIENT_SECRET` is read. |
| `OIDC_SERVER_URL` | No | OIDC issuer URL, e.g. `https://idp.example.com/realms/my-realm`. Must be the issuer root — allauth appends `.well-known/openid-configuration` to discover endpoints. |
| `OIDC_PROVIDER_NAME` | No | Display name shown on the OIDC login button (default: `SSO`). |
| `TLS_MODE` | No | TLS mode for the production Docker stack: `letsencrypt` (default), `selfsigned`, or `none`. See [TLS modes](#tls-modes). |
| `FORCE_INSECURE_COOKIES` | No | Set `true` to disable `SESSION_COOKIE_SECURE` and `CSRF_COOKIE_SECURE` for plain-HTTP deployments. Automatically set by `init-prod.sh` when `TLS_MODE=none`. Default: `false`. |
| `MAX_UPLOAD_SIZE_BYTES` | No | Maximum file size for card attachment uploads in bytes (default: `10485760` — 10 MB). Increase for teams with large attachment needs; decrease to limit storage use. |

OAuth variables are documented in [OAuth Setup](oauth.md).

## Kubernetes / Helm

> **Tested:** The Helm chart has been deployed and verified on a live Kubernetes cluster.

A Helm chart is included for Kubernetes deployments. See [Deployment — Kubernetes / Helm](../architecture/deployment.md#kubernetes-helm) for install instructions, configuration values, and upgrade steps.

## Production Deployment

> **Tested:** The production Docker Compose stack has been verified end-to-end. If you encounter issues, please open an issue.

### TLS modes

The production stack supports three TLS modes, controlled by the `TLS_MODE` environment variable:

| Mode | Description | Use case |
|---|---|---|
| `letsencrypt` | **(default)** Obtain and auto-renew a Let's Encrypt certificate | Public-facing deployments with a DNS A record |
| `selfsigned` | Generate a self-signed certificate | Staging, internal networks, or development |
| `none` | Serve over plain HTTP — no TLS | Air-gapped networks or deployments behind an external load balancer that terminates TLS |

!!! warning "Security warnings for non-default modes"
    **`selfsigned`** — Browsers will show a certificate warning on every visit. HSTS is disabled by default to prevent browsers from permanently rejecting the self-signed cert. Intended for internal or staging use only.

    **`none`** — All traffic including session cookies and API calls is unencrypted. The init script automatically sets `FORCE_INSECURE_COOKIES=true` so Django does not require HTTPS for cookies. **Do not use this for deployments reachable from the public internet.**

### Pre-flight security checklist

Before starting the production stack, confirm each item below. The backend will refuse to start if any of these are wrong — this is intentional.

| Variable | Requirement |
|---|---|
| `DB_PASSWORD` | Must be set to a strong, unique password. Docker Compose **will not start** if this variable is missing — there is no insecure default. |
| `REDIS_PASSWORD` | Must be set to a strong, unique password. The production Redis service starts with `--requirepass` and the backend URLs are built from this value. Docker Compose **will not start** if this variable is missing. Generate with: `openssl rand -base64 32` |
| `DJANGO_SECRET_KEY` | Must be a long random string. If left as `change-me-in-production` or empty, Django will raise `ImproperlyConfigured` at startup. Generate one with: `python -c "import secrets; print(secrets.token_hex(50))"` |
| `CORS_ALLOWED_ORIGINS` | Must be set to your production frontend origin (e.g. `https://yourdomain.com`). The default `http://localhost:5173` is only suitable for local development. |
| `DEBUG` | Must be `false` in production. Running with `DEBUG=true` leaks stack traces to HTTP responses and disables the `DJANGO_SECRET_KEY` guard. |
| `ALLOWED_HOSTS` | Must include your domain name (e.g. `yourdomain.com`). |

!!! warning "`ALLOWED_HOSTS` must be set before going live"
    The codebase default for `ALLOWED_HOSTS` is `localhost,127.0.0.1`. If you deploy without explicitly setting this variable to your real domain, Django will reject every inbound HTTP request with a `400 Bad Request` — the site will be unreachable. Set it to your public hostname before starting the production stack:

    ```bash
    ALLOWED_HOSTS=yourdomain.com
    ```

    If you serve the application on a non-standard port or via a load balancer, include the hostname without the port. Django reads the `Host` header, not the port.

The production stack (`docker-compose.prod.yml`) replaces the Vite dev server with:

| Component | Role |
|---|---|
| **Nginx** | Serves the compiled React app; proxies `/api/`, `/_allauth/`, `/ws/`, `/admin/`, `/static/`, `/media/` to the backend |
| **Frontend build** | `npm run build` runs once at startup and outputs static files to a shared volume |
| **Certbot** | (TLS_MODE=letsencrypt only) Obtains the Let's Encrypt certificate on first boot; renews automatically every 12 hours |

### Prerequisites

- A Linux server (VPS, cloud VM, bare metal)
- **Docker** and **Docker Compose** (v2.21+ required for Compose profiles)
- For `TLS_MODE=letsencrypt`:
    - Ports **80** and **443** open in your firewall / security group
    - A DNS **A record** pointing `yourdomain.com` → your server's public IP (Let's Encrypt verifies domain ownership before issuing a certificate)
- For `TLS_MODE=selfsigned`: Port **443** open (and **80** for the HTTP→HTTPS redirect)
- For `TLS_MODE=none`: Port **80** open

### Step 1 — Clone and configure

```bash
git clone https://gitlab.com/visiban/visiban.git && cd visiban
cp .env.example .env
```

Open `.env` in a text editor and set the following values. Every line marked **required** must be changed before continuing.

!!! tip "Keeping secrets out of shell history"
    Always edit secrets directly in the `.env` file — never pass them as command-line arguments (e.g. `DB_PASSWORD=hunter2 docker compose up`). Arguments appear in shell history, `/proc/*/cmdline`, and process listings.

    To generate and insert a secret in one step without it touching your history:

    ```bash
    # Generate DJANGO_SECRET_KEY directly into .env
    sed -i "s|^DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')|" .env

    # Generate DB_PASSWORD directly into .env
    sed -i "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -base64 32)|" .env

    # Generate REDIS_PASSWORD directly into .env
    sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$(openssl rand -base64 32)|" .env
    ```

```bash
# Django
DJANGO_SECRET_KEY=<long random string>   # required — generate: python -c "import secrets; print(secrets.token_urlsafe(50))"
DEBUG=false                              # required — never run DEBUG=true in production
ALLOWED_HOSTS=yourdomain.com            # required
CORS_ALLOWED_ORIGINS=https://yourdomain.com  # required — must be your public domain, not localhost
FRONTEND_URL=https://yourdomain.com     # required — allauth redirects here after OAuth login/logout
SITE_DOMAIN=yourdomain.com             # required — used for OAuth callback URLs

# Database (Postgres runs inside Docker Compose)
DATABASE_URL=postgres://visiban:${DB_PASSWORD}@db:5432/visiban
DB_PASSWORD=<strong password>           # required — used by both Django and Postgres

# Redis (runs inside Docker Compose)
REDIS_PASSWORD=<strong password>        # required — generate: openssl rand -base64 32
# REDIS_URL and REDIS_CACHE_URL are built from REDIS_PASSWORD in docker-compose.prod.yml.
# Only override here if you use an external Redis.

# TLS mode — choose one: letsencrypt (default), selfsigned, none
TLS_MODE=letsencrypt

# Let's Encrypt (required only when TLS_MODE=letsencrypt)
DOMAIN=yourdomain.com                   # required — must match your DNS A record
CERTBOT_EMAIL=admin@yourdomain.com     # required — used for cert expiry alerts

# App version — set to the version you are deploying (see CHANGELOG.md)
APP_VERSION=1.1.0-rc.2
```

!!! tip "Using `TLS_MODE=none` behind an external load balancer"
    If TLS is terminated by an upstream proxy (AWS ALB, Cloudflare, Traefik, etc.) that sets the `X-Forwarded-Proto: https` header, you do **not** need `FORCE_INSECURE_COOKIES=true`. Django reads the header and treats the request as secure. Set `CORS_ALLOWED_ORIGINS` and `FRONTEND_URL` to `https://...` as usual.

    Only set `FORCE_INSECURE_COOKIES=true` (done automatically by `init-prod.sh` for `TLS_MODE=none`) when there is genuinely no TLS anywhere in the request path.

!!! warning "CORS_ALLOWED_ORIGINS must not contain localhost in production"
    Visiban refuses to start with `DEBUG=False` if `CORS_ALLOWED_ORIGINS` contains a
    `localhost` or `127.0.0.1` origin. This prevents a common misconfiguration where
    the default development value is left in place for a production deployment.

    **Correct:**
    ```
    CORS_ALLOWED_ORIGINS=https://yourdomain.com
    ```

    **Incorrect (will cause startup failure):**
    ```
    CORS_ALLOWED_ORIGINS=http://localhost:5173
    ```

> **OAuth** (Google, GitHub, GitLab) is optional. See [OAuth Setup](oauth.md) if you want social login.

### Step 2 — Run the init script

```bash
chmod +x init-prod.sh
./init-prod.sh
```

The script performs these steps automatically based on `TLS_MODE`:

| TLS_MODE | What the script does |
|---|---|
| `letsencrypt` | Runs certbot standalone to obtain the certificate, then starts the full stack including the certbot renewal service |
| `selfsigned` | Generates a self-signed certificate with `openssl` (valid 365 days), then starts the stack without certbot |
| `none` | Sets `FORCE_INSECURE_COOKIES=true` in `.env`, selects the HTTP-only nginx config, starts the stack without certbot |

When it finishes you will see:

```
  Visiban is live at https://yourdomain.com
```

(or `http://` for `TLS_MODE=none`)

!!! note "Migrating from `init-letsencrypt.sh`"
    The old `init-letsencrypt.sh` script still works — it prints a deprecation warning and delegates to `init-prod.sh` with `TLS_MODE=letsencrypt`. No action is required for existing deployments, but new installs should use `init-prod.sh` directly.

### Step 3 — Verify

| Check | Expected |
|---|---|
| `https://yourdomain.com` loads (or `http://` for `TLS_MODE=none`) | React app renders and you can log in |
| `http://yourdomain.com` (when TLS is enabled) | Redirects to HTTPS |
| Green **Live** dot in toolbar | WebSocket connected |
| `https://yourdomain.com/admin/` | Returns 403 from the internet (restricted to loopback — access via SSH tunnel) |

The backend writes a one-time admin password to `/tmp/visiban_admin_password` on first boot. Retrieve it with:

```bash
docker compose -f docker-compose.prod.yml exec backend cat /tmp/visiban_admin_password
```

Delete the file after retrieving the password.

!!! note "Password file not found?"
    If the file does not exist, the admin account was already created on a previous boot (the password is only written once). Reset the password with:

    ```bash
    docker compose -f docker-compose.prod.yml exec backend python manage.py changepassword admin
    ```

See [First Boot](first-boot.md) for full details.

### Subsequent deploys

Pull the latest code and rebuild:

```bash
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```

This rebuilds images, re-runs the frontend build (output replaces the previous static files in the shared volume), and restarts services with zero manual steps.

### Certificate renewal

The `certbot` container (active only with `TLS_MODE=letsencrypt`) calls `certbot renew` every 12 hours. Let's Encrypt certificates are valid for 90 days and are renewed automatically when fewer than 30 days remain. No manual action is required.

For `TLS_MODE=selfsigned`, the self-signed certificate is valid for 365 days. To regenerate it, delete the certificate directory and re-run the init script:

```bash
rm -rf certbot/conf/live/yourdomain.com
./init-prod.sh
```

To check renewal status (Let's Encrypt only):

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
./init-prod.sh
```

**`Challenge failed: DNS problem: NXDOMAIN`**
Your DNS A record hasn't propagated yet. Check with `dig yourdomain.com` — it must return your server's IP before certbot can issue a certificate. Wait a few minutes and retry.

**Let's Encrypt rate limit**
If you hit the issuance limit (5 certs per domain per week during testing), add `--staging` to the certbot command in `init-prod.sh` to use the Let's Encrypt staging environment. Remove it once you're ready for a real certificate.

**Nginx `502 Bad Gateway`**
The backend may still be starting up. Check: `docker compose -f docker-compose.prod.yml logs backend`. Wait for the `daphne` line to appear before reloading the page.

**"Live" dot stays yellow (Reconnecting) or never turns green**

The connection indicator in the toolbar reflects the WebSocket connection to `/ws/boards/{id}/`. If it stays yellow after the page loads, work through the following:

1. **Backend not ready** — WebSocket connections are rejected until daphne is fully started:
   ```bash
   docker compose -f docker-compose.prod.yml logs backend | tail -20
   ```
   Wait for a line containing `daphne` before reloading the page.

2. **Redis unavailable** — Django Channels requires Redis for the channel layer. If Redis is down, the backend accepts the WebSocket upgrade but immediately closes the connection:
   ```bash
   docker compose -f docker-compose.prod.yml logs redis
   docker compose -f docker-compose.prod.yml exec backend python manage.py shell -c "import django_redis; print('ok')"
   ```

3. **`ALLOWED_HOSTS` missing your domain** — Django rejects WebSocket handshakes from unlisted hosts. Confirm `ALLOWED_HOSTS=yourdomain.com` is set in `.env`.

4. **Nginx not proxying `/ws/`** — Verify the nginx container started without errors and that its config includes the WebSocket location block:
   ```bash
   docker compose -f docker-compose.prod.yml logs nginx
   docker compose -f docker-compose.prod.yml exec nginx nginx -T | grep "location /ws"
   ```

5. **Upstream proxy stripping upgrade headers** — If Visiban sits behind another reverse proxy (CDN, load balancer), confirm that proxy forwards `Upgrade` and `Connection` headers and does not terminate WebSocket connections.
