# Get Visiban running, locally or in production

To try Visiban, run `docker compose up --build`. To run it for real, use `init-prod.sh` and `docker-compose.prod.yml`. Those are two different stacks.

**Why it matters:** The local stack runs the Vite dev server and isn't safe for production. The production stack adds nginx, TLS, and startup guards that refuse to boot on unsafe settings.

**The big picture:**

- **Try it locally:** four containers, a dev server, and `localhost` defaults.
- **Run it in production:** released images pinned by `APP_VERSION`, nginx, and Let's Encrypt or your own TLS. Three steps.
- <a id="kubernetes-helm"></a>**On Kubernetes?** Skip this page and use [Kubernetes (Helm)](kubernetes.md). The chart has been deployed and verified on a live cluster. Install values and upgrade steps are in [Deployment: Kubernetes / Helm](../architecture/deployment.md#kubernetes-helm).

<a id="hardware-requirements"></a>

## Size the host

**By the numbers:**

| Tier | vCPU | RAM | Disk | Notes |
|------|------|-----|------|-------|
| Minimum (production) | 2 | 4 GB | 40 GB SSD | Up to 10 users; comfortable for a first install |
| Recommended (production) | 4 | 8 GB | 80 GB SSD | 10–50 users; room to grow |
| Development | 4 | 8 GB | 40 GB free | Docker Desktop on Mac/Windows needs at least 6–8 GB allocated to the VM; the Vite dev server spikes on hot reload |

**Why 4 GB is the floor:** At idle, the production stack uses about 350 MB for PostgreSQL, 350 MB for the daphne workers, and 160 MB combined for Valkey, nginx, and Docker overhead. That leaves no safe margin on a 1 GB host. 4 GB gives headroom for startup, migrations, and WebSocket bursts without risking OOM kills.

**Disk:** Image pulls and build cache take about 3–4 GB on their own. The main open-ended cost is file attachments: each card attachment can be up to 10 MB. The figures above assume light-to-moderate attachment use. If your team attaches a lot, plan for more storage or configure S3-compatible object storage.

<a id="prerequisites"></a>

**You need:**

- Docker and Docker Compose, **or** Python 3.12+ and Node.js 18+ to run from source
- Valkey 8, the Redis-compatible, BSD-licensed fork. Docker Compose and Helm include it automatically. Real-time WebSocket updates require it.

<a id="docker-recommended"></a>

## Try it locally

> **Tested:** The Docker Compose development setup has been verified end to end. If something doesn't work, open an issue.

```bash
git clone https://gitlab.com/visiban/visiban.git && cd visiban
cp .env.example .env
# Edit .env — set DJANGO_SECRET_KEY and any OAuth credentials
docker compose up --build
```

!!! note "`--build` is required on first install and after pulling updates"
    `--build` builds the images before starting the containers. On a fresh clone no images exist locally yet, so omitting it fails. After a `git pull` that touches the `Dockerfile` or frontend assets, omitting it can leave you running stale images.

**What starts:** four services. They are `db` (Postgres 17), `valkey` (Valkey 8), `backend` (daphne/ASGI), and `frontend` (the Vite dev server).

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Django admin | http://localhost:8000/admin |
| API Schema (Swagger UI) | http://localhost:8000/api/schema/swagger-ui/ |
| API Schema (ReDoc) | http://localhost:8000/api/schema/redoc/ |
| API Schema (raw YAML) | http://localhost:8000/api/schema/ |

**Watch out:** Django serves the schema endpoints, so use port 8000. The Vite dev server on 5173 doesn't proxy `/api/`, so `http://localhost:5173/api/schema/` won't work.

**Next:** On first boot the backend creates a one-time admin password. See [First boot](first-boot.md) to retrieve it.

!!! warning "Accessing it from anything but localhost? Change two variables first"
    The `.env.example` defaults only work on `localhost`. If you reach Visiban from a LAN IP, a hostname, or any address other than `127.0.0.1`, set these before starting the stack. Otherwise API calls may fail and WebSocket connections stay stuck on **Reconnecting**.

    ```bash
    ALLOWED_HOSTS=192.168.1.100          # or your LAN hostname
    CORS_ALLOWED_ORIGINS=http://192.168.1.100:5173   # must match the exact origin the browser uses
    ```

    Behind nginx in production, the frontend and backend share one origin. There, `CORS_ALLOWED_ORIGINS` must match the origin nginx serves (for example `http://192.168.1.100:8080`), not the Vite dev server port.

**This stack is for local development only.** The Vite dev server isn't suitable for production. For a server, see [Production deployment](#production-deployment).

<a id="troubleshooting"></a>

### When the local stack won't start

**The `db` container exits immediately, or the backend can't connect.** After pulling updates, the usual cause is a PostgreSQL major-version mismatch. The data volume was initialized by one major version (for example PG 16), and the image moved to a newer one (for example PG 17), which refuses to start:

```
db-1 | FATAL: database files are incompatible with server
db-1 | DETAIL: The data directory was initialized by PostgreSQL version 16, which is not compatible with this version 17.x.
```

!!! danger "Destructive: this deletes all local database data"
    Back up anything you need first: `docker compose exec db pg_dump -U visiban visiban > backup.sql`.

```bash
docker compose down -v          # stop all containers and remove volumes
docker compose up --build       # recreate from scratch
```

After the containers start, run migrations and recreate the site admin account:

```bash
docker compose exec backend python manage.py migrate
docker compose exec backend python manage.py ensure_site_admin
```

**The frontend container exits right after upgrading from a pre-1.2 checkout.** The cause is a stale, root-owned `node_modules` volume. See [Upgrading to 1.2.x](../administration/upgrade.md#upgrading-to-12x).

**API calls fail, or the browser console shows a CORS error** (for example `Access to fetch at 'http://...' from origin '...' has been blocked`). The backend is rejecting requests from the address the browser is using. This happens whenever you aren't on `http://localhost:5173`, for example from a LAN IP, a VM hostname, or a different port.

The backend logs its active CORS origins at startup. Check them:

```bash
docker compose logs backend | grep "CORS allowed origins"
```

If the logged origin doesn't match your browser's address bar, update `.env`:

```bash
CORS_ALLOWED_ORIGINS=http://192.168.1.100:5173   # must be the exact origin the browser uses
ALLOWED_HOSTS=192.168.1.100                       # must include the hostname/IP too
```

Then restart the backend:

```bash
docker compose restart backend
```

<a id="compose-project-names"></a>

### Compose project names: keep dev and prod apart

**Why it matters:** If the two stacks resolve to the same Compose project, they share one database volume.

| File | Project name |
|---|---|
| `docker-compose.yml` | `${COMPOSE_PROJECT_NAME:-visiban-dev}` |
| `docker-compose.prod.yml` | `visiban` |
| `docker-compose.oidc.yml` | *(none: it's an overlay, and a second file's `name:` would rename the stack it extends)* |

**How it breaks:** Both stacks declare a bare `pgdata:` volume, and both define `db`, `valkey`, and `backend`. In one project they share `<project>_pgdata`. Postgres applies `POSTGRES_PASSWORD` only on first init, so whichever stack starts second gets the other's password, or the development `SECRET_KEY` lands on production data. Same-named services in one project also recreate each other's containers in place on `up`.

!!! warning "Upgrading from a checkout where dev defaulted to `visiban`"
    The development stack used to default to the project name `visiban`, which is also what `docker-compose.prod.yml` resolves to on a default clone. It now defaults to `visiban-dev`.

    - **Production is unaffected.** `visiban` is what it already resolved to, so the new explicit pin changes nothing.
    - **Development starts with an empty database** the first time you `docker compose up` after this change, because your containers and volumes are under the old name. The old data is still in `visiban_pgdata`. Either re-seed (the usual choice for a dev database) or copy it across:

    ```bash
    docker volume ls | grep pgdata          # visiban_pgdata is the old one
    docker compose up -d                     # creates visiban-dev_pgdata
    # then restore a dump, or: docker run --rm -v visiban_pgdata:/from \
    #   -v visiban-dev_pgdata:/to alpine sh -c 'cp -a /from/. /to/'
    ```

    `docker compose -p visiban up` still reaches the old stack if you need it.

    `scripts/wt` exports `COMPOSE_PROJECT_NAME=visiban-dev` for the same reason. An exported variable overrides every `name:` pin, so worktrees share one development stack while staying clear of production.

<a id="running-two-visiban-stacks-side-by-side"></a>

### Run two Visiban stacks side by side

**Why it matters:** A second checkout, or any other Compose project on the same default ports, fights over `5432`, `8000`, and `5173` on the host. `docker-compose.yml` reads host ports and the project name from `.env`, so a second checkout can coexist without source changes.

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

**How it works:** Inside the Compose network, containers always listen on the canonical ports (`5432`, `8000`, `5173`, `8080`). Only the host-side mapping changes. Vite's HMR client port follows `FRONTEND_PORT` automatically, so hot reload keeps working.

!!! note "Why aren't the URL vars interpolated from the port vars?"
    `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS`, `SITE_DOMAIN`, and `VITE_API_URL` need explicit values. They can't be `${FRONTEND_PORT}`-style interpolations, because Compose's `env_file:` directive does **not** expand variables. An interpolated value would reach the Django container as the literal string `${FRONTEND_PORT}` and silently break allauth redirects, OAuth callbacks, and CORS. Four vars, four explicit updates: it's a bit more typing, but it works in every dev path (Compose, native Python, and Helm).

## Production deployment

> **Tested:** The production Docker Compose stack has been verified end to end. If you hit a problem, open an issue.

Run `init-prod.sh` once and it obtains a certificate, starts the stack, and tells you the URL.

**Why it matters:** The production stack refuses to start on unsafe settings. Getting `.env` right the first time is most of the work.

**What runs:** `docker-compose.prod.yml` replaces the Vite dev server with:

| Component | Role |
|---|---|
| **Nginx** | Serves the compiled React app; proxies `/api/`, `/accounts/`, `/ws/`, `/admin/`, `/static/`, `/media/` to the backend |
| **Frontend build** | Copies the release image's pre-built SPA (compiled at image-build time) into a shared volume at startup |
| **Certbot** | (`TLS_MODE=letsencrypt` only) Obtains the Let's Encrypt certificate on first boot and renews it automatically every 12 hours |

**Verify the images <span class="vb-version" title="Added in 1.2">1.2+</span>:** The `backend` and `frontend` images this stack pulls are cosign-signed, and each carries a per-architecture CycloneDX SBOM. Verify them before deploying: see [Verifying release images](../administration/image-verification.md). The stack's other images (`postgres`, `valkey`, `nginx`, `certbot`) are upstream images that Visiban does not sign.

<a id="prerequisites_1"></a>

**You need:**

- A Linux server (VPS, cloud VM, or bare metal)
- **Docker** and **Docker Compose** (v2.21+ is required for Compose profiles)
- For `TLS_MODE=letsencrypt`:
    - Ports **80** and **443** open in your firewall or security group
    - A DNS **A record** pointing `yourdomain.com` at your server's public IP. Let's Encrypt verifies domain ownership before it issues a certificate.
- For `TLS_MODE=selfsigned`: port **443** open (and **80** for the HTTP→HTTPS redirect)
- For `TLS_MODE=none`: port **80** open

### TLS modes

Set `TLS_MODE` to pick one:

| Mode | What it does | Use it for |
|---|---|---|
| `letsencrypt` | **(default)** Obtains and auto-renews a Let's Encrypt certificate | Public-facing deployments with a DNS A record |
| `selfsigned` | Generates a self-signed certificate | Staging, internal networks, or development |
| `none` | Serves plain HTTP, with no TLS | Air-gapped networks, or behind an external load balancer that terminates TLS |

!!! warning "The non-default modes trade away security"
    **`selfsigned`:** Browsers show a certificate warning on every visit. HSTS is off by default so browsers don't permanently reject the self-signed cert. If you want it anyway (for example, a staging host with a long-lived trusted cert), set `SECURE_HSTS_SECONDS` explicitly in `.env`. Use this mode for internal or staging hosts only.

    **`none`:** All traffic, including session cookies and API calls, is unencrypted. The init script sets `FORCE_INSECURE_COOKIES=true` automatically so Django doesn't require HTTPS for cookies. **Don't use this for a deployment reachable from the public internet.**

!!! note "nginx sends the HSTS header, exactly once"
    `init-prod.sh` writes the `Strict-Transport-Security` header from `SECURE_HSTS_SECONDS` directly into the active nginx config (`nginx/app.conf.template`). Every location that proxies to the backend hides Django's own copy of that header (`proxy_hide_header`). So exactly one `Strict-Transport-Security` header reaches the browser on every path, the SPA document included.

    After you change `SECURE_HSTS_SECONDS` in `.env`, re-run `./init-prod.sh` to re-render the template. Then run `docker compose -f docker-compose.prod.yml up -d --force-recreate nginx`. A plain `up -d` doesn't notice that the bind-mounted config file changed.

### Step 1: clone and configure

```bash
git clone https://gitlab.com/visiban/visiban.git && cd visiban
cp .env.example .env
```

Open `.env` in an editor and set the values below. Change every line marked **required** before you continue.

!!! tip "Keep secrets out of shell history"
    Edit secrets directly in `.env`. Never pass them as command-line arguments (for example `DB_PASSWORD=hunter2 docker compose up`), which show up in shell history, `/proc/*/cmdline`, and process listings.

    To generate and insert a secret in one step without it touching your history:

    ```bash
    # Replace KEY's line in .env, or append it if .env has none (DB_PASSWORD is
    # only a comment in .env.example, so a bare `sed` would silently change nothing).
    set_env() { grep -q "^$1=" .env && sed -i "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }

    set_env DJANGO_SECRET_KEY "$(python3 -c 'import secrets; print(secrets.token_urlsafe(50))')"
    set_env DB_PASSWORD "$(openssl rand -hex 32)"
    set_env REDIS_PASSWORD "$(openssl rand -hex 32)"
    ```

!!! warning "Use hex, not base64, for `DB_PASSWORD` and `REDIS_PASSWORD`"
    `docker-compose.prod.yml` puts both passwords inside connection URLs (`postgres://visiban:<DB_PASSWORD>@db…`), and Compose can't escape them. A `/`, `?`, `#`, `%`, `[`, `]`, or space in either one breaks the URL and the backend refuses to start. `openssl rand -base64` puts a `/` in about half its outputs. `openssl rand -hex 32` is just as strong and URL-safe. `init-prod.sh` rejects an unsafe value before it starts anything.

```bash
# Django
DJANGO_SECRET_KEY=<long random string>   # required — generate: python -c "import secrets; print(secrets.token_urlsafe(50))"
DEBUG=false                              # required — never run DEBUG=true in production
ALLOWED_HOSTS=yourdomain.com            # required
CORS_ALLOWED_ORIGINS=https://yourdomain.com  # required — must be your public domain, not localhost
FRONTEND_URL=https://yourdomain.com     # required — allauth redirects here after OAuth login/logout
SITE_DOMAIN=yourdomain.com             # required — used for OAuth callback URLs
DEFAULT_FROM_EMAIL=noreply@yourdomain.com  # required on 1.1.x — the backend refuses to start
                                           # while it is the example.com default (1.2+ only warns)

# Database (Postgres runs inside Docker Compose). docker-compose.prod.yml builds
# DATABASE_URL from DB_PASSWORD itself; there is nothing else to set.
DB_PASSWORD=<strong password>           # required — generate: openssl rand -hex 32

# Valkey (runs inside Docker Compose)
REDIS_PASSWORD=<strong password>        # required — generate: openssl rand -hex 32
# REDIS_URL and REDIS_CACHE_URL are built from REDIS_PASSWORD in docker-compose.prod.yml.
# Only override here if you use an external Valkey or Redis-compatible instance.

# TLS mode — choose one: letsencrypt (default), selfsigned, none
TLS_MODE=letsencrypt

# Let's Encrypt (required only when TLS_MODE=letsencrypt)
DOMAIN=yourdomain.com                   # required — must match your DNS A record
CERTBOT_EMAIL=admin@yourdomain.com     # required — used for cert expiry alerts

# App version — pin to a release tag of the form vX.Y.Z (see CHANGELOG.md);
# the bare X.Y.Z form is not published on GHCR and the pull will fail.
APP_VERSION=v1.2.0
```

<a id="pre-flight-security-checklist"></a>

**Pre-flight check:** The backend refuses to start if any of these are wrong. That's intentional.

| Variable | Requirement |
|---|---|
| `DB_PASSWORD` | Set to a strong, unique password. Docker Compose **won't start** without it. There is no insecure default. |
| `REDIS_PASSWORD` | Set to a strong, unique password. The production Valkey starts with `--requirepass`, and the backend URLs are built from this value. Docker Compose **won't start** without it. Generate with `openssl rand -hex 32` (not base64; see the warning above). |
| `DJANGO_SECRET_KEY` | A long random string. Left as `change-me-in-production` or empty, Django raises `ImproperlyConfigured` at startup. Generate one with `python -c "import secrets; print(secrets.token_hex(50))"`. |
| `CORS_ALLOWED_ORIGINS` | Your production frontend origin (for example `https://yourdomain.com`). The default `http://localhost:5173` is only for local development. |
| `DEBUG` | `false` in production. `DEBUG=true` leaks stack traces into HTTP responses and disables the `DJANGO_SECRET_KEY` guard. |
| `ALLOWED_HOSTS` | Must include your domain name (for example `yourdomain.com`). |

!!! warning "Set `ALLOWED_HOSTS` before going live, or the site is unreachable"
    The codebase default is `localhost,127.0.0.1`. Deploy without setting it to your real domain and Django rejects every inbound request with `400 Bad Request`. Set it to your public hostname before starting the production stack:

    ```bash
    ALLOWED_HOSTS=yourdomain.com
    ```

    On a non-standard port or behind a load balancer, give the hostname without the port. Django reads the `Host` header, not the port.

!!! warning "`CORS_ALLOWED_ORIGINS` must not contain localhost in production"
    With `DEBUG=False`, Visiban refuses to start if `CORS_ALLOWED_ORIGINS` contains a `localhost` or `127.0.0.1` origin. This catches the common mistake of leaving the development value in place.

    **Correct:**
    ```
    CORS_ALLOWED_ORIGINS=https://yourdomain.com
    ```

    **Incorrect (startup fails):**
    ```
    CORS_ALLOWED_ORIGINS=http://localhost:5173
    ```

!!! tip "Behind an external load balancer with `TLS_MODE=none`"
    If an upstream proxy (AWS ALB, Cloudflare, Traefik, etc.) terminates TLS and sets `X-Forwarded-Proto: https`, you do **not** need `FORCE_INSECURE_COOKIES=true`. Django reads the header and treats the request as secure. Set `CORS_ALLOWED_ORIGINS` and `FRONTEND_URL` to `https://...` as usual.

    Set `FORCE_INSECURE_COOKIES=true` only when there is genuinely no TLS anywhere in the request path. `init-prod.sh` sets it for you with `TLS_MODE=none`.

**Optional:** Social login (Google, GitHub, GitLab) and OIDC are covered in [OAuth and SSO](oauth.md).

### Step 2: run the init script

```bash
chmod +x init-prod.sh
./init-prod.sh
```

**How it works:** The script follows `TLS_MODE`:

| TLS_MODE | What the script does |
|---|---|
| `letsencrypt` | Runs certbot standalone to obtain the certificate, then starts the full stack including the certbot renewal service |
| `selfsigned` | Generates a self-signed certificate with `openssl` (valid 365 days), then starts the stack without certbot |
| `none` | Sets `FORCE_INSECURE_COOKIES=true` in `.env`, selects the HTTP-only nginx config, and starts the stack without certbot |

When it finishes you'll see this (`http://` for `TLS_MODE=none`):

```
  Visiban is live at https://yourdomain.com
```

!!! note "Migrating from `init-letsencrypt.sh`"
    The old `init-letsencrypt.sh` still works. It prints a deprecation warning and hands off to `init-prod.sh` with `TLS_MODE=letsencrypt`. Existing deployments need no action, but new installs should call `init-prod.sh` directly.

<a id="step-3-verify"></a>

### Step 3: verify and log in

| Check | Expected |
|---|---|
| `https://yourdomain.com` loads (`http://` for `TLS_MODE=none`) | The React app renders and you can log in |
| `http://yourdomain.com` (when TLS is on) | Redirects to HTTPS |
| Green **Live** dot in the toolbar | The WebSocket is connected |
| `https://yourdomain.com/admin/` | Returns 403 from the internet (restricted to loopback; reach it over an SSH tunnel) |

On first boot the backend writes a one-time admin password to `/tmp/visiban_admin_password`. Retrieve it, then delete the file:

```bash
docker compose -f docker-compose.prod.yml exec backend cat /tmp/visiban_admin_password
```

!!! note "Password file not found?"
    The admin account was already created on an earlier boot; the password is written only once. Reset it:

    ```bash
    docker compose -f docker-compose.prod.yml exec backend python manage.py changepassword admin
    ```

**Go deeper:** [First boot](first-boot.md) covers the password, registration modes, and inviting your team.

!!! tip "Sample data"
    The backend image ships the sample board JSON files. To try Visiban with a populated board, use **Import** on the dashboard and pick one under **Start from a sample**, or download a file from [`backend/boards/sample_boards/`](https://gitlab.com/visiban/visiban/-/tree/main/backend/boards/sample_boards) and use **Dashboard → Import**. See [Sample boards](sample-boards.md).

## Keep it running

<a id="subsequent-deploys"></a>

**Subsequent deploys:** The production stack runs the released images named by `APP_VERSION` in `.env`. It builds nothing locally, and `git pull` doesn't change `.env`. To move to a new release, see [Updating to a new version](#updating-to-a-new-version).

### Updating to a new version

Take a database backup first (see [Backing up and restoring](#backing-up-and-restoring)), then:

```bash
cd visiban
git pull origin main                     # updated compose file, nginx templates, scripts
# Edit .env: set APP_VERSION to the new release tag (vX.Y.Z)
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

**Watch out:** Changing `APP_VERSION` is the step that actually upgrades. Without it, `pull` fetches the version you already run.

**How it works:** The `backend-init` service applies the new migrations before the new backend starts, and `frontend-build` copies the new SPA into place. See the [Upgrade guide](../administration/upgrade.md) for version-specific notes and rollback. Then check the backend logs:

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

**Media files** (card attachments) live in a Docker volume. Back them up with:

```bash
docker compose -f docker-compose.prod.yml exec backend \
  tar czf /tmp/media.tar.gz -C /app media/
docker compose -f docker-compose.prod.yml cp backend:/tmp/media.tar.gz ./media_backup.tar.gz
```

### Certificate renewal

**Let's Encrypt renews itself.** The `certbot` container (active only with `TLS_MODE=letsencrypt`) runs `certbot renew` every 12 hours. Certificates are valid for 90 days and renew when fewer than 30 days remain. No manual action is needed. To check renewal status:

```bash
docker compose -f docker-compose.prod.yml logs certbot
```

**Self-signed certificates last 365 days.** To regenerate one, delete the certificate directory and re-run the init script:

```bash
rm -rf certbot/conf/live/yourdomain.com
./init-prod.sh
```

### Stopping and starting

```bash
# Stop all services (data volumes are preserved)
docker compose -f docker-compose.prod.yml down

# Start again (no rebuild needed unless code changed)
docker compose -f docker-compose.prod.yml up -d
```

<a id="troubleshooting_1"></a>

## When production misbehaves

**`certbot: error: Could not bind to port 80`:** Something else is using port 80. Stop it, then re-run the init script:

```bash
sudo systemctl stop nginx apache2   # or whichever service holds port 80
./init-prod.sh
```

**`Challenge failed: DNS problem: NXDOMAIN`:** Your DNS A record hasn't propagated yet. Check with `dig yourdomain.com`; it must return your server's IP before certbot can issue a certificate. Wait a few minutes and retry.

**You hit the Let's Encrypt rate limit** (5 certificates per domain per week during testing): Add `--staging` to the certbot command in `init-prod.sh` to use the Let's Encrypt staging environment. Remove it once you're ready for a real certificate.

**nginx returns `502 Bad Gateway`:** The backend may still be starting. Check `docker compose -f docker-compose.prod.yml logs backend`, and wait for the `daphne` line before reloading the page.

**The Live dot stays yellow (Reconnecting) or never turns green.** The toolbar indicator shows the WebSocket connection to `/ws/boards/{id}/`. If it stays yellow after the page loads, work down this list:

1. **Backend not ready.** WebSocket connections are rejected until daphne has fully started:
   ```bash
   docker compose -f docker-compose.prod.yml logs backend | tail -20
   ```
   Wait for a line containing `daphne` before reloading the page.

2. **Valkey unavailable.** Django Channels needs Valkey for the channel layer. Without it, the backend accepts the WebSocket upgrade and then closes it immediately. Edits still save, but their live updates are dropped, and the backend logs a `board broadcast dropped` warning for each one. Once Valkey is back, an open board catches up when its socket reconnects, when its tab next regains focus, or when you choose **Refresh board** in the connection popover. API clients can replay missed board events from the [change feed](../api/events.md).
   ```bash
   docker compose -f docker-compose.prod.yml logs valkey
   docker compose -f docker-compose.prod.yml exec backend python manage.py shell -c "from django.core.cache import cache; cache.set('healthcheck', 'ok'); print(cache.get('healthcheck'))"
   ```

3. **`ALLOWED_HOSTS` missing your domain.** A handshake is refused with `403` if its `Origin` matches neither `CORS_ALLOWED_ORIGINS` / `CSRF_TRUSTED_ORIGINS` nor an exact host in `ALLOWED_HOSTS`. Confirm `ALLOWED_HOSTS=yourdomain.com` is set in `.env`. If `ALLOWED_HOSTS` uses `*` or a leading-dot entry, list your public origin in `CORS_ALLOWED_ORIGINS` instead.

4. **Nginx not proxying `/ws/`.** Confirm the nginx container started cleanly and that its config has the WebSocket location block:
   ```bash
   docker compose -f docker-compose.prod.yml logs nginx
   docker compose -f docker-compose.prod.yml exec nginx nginx -T | grep "location /ws"
   ```

5. **Upstream proxy stripping upgrade headers.** If Visiban sits behind another reverse proxy (a CDN or load balancer), confirm that proxy forwards the `Upgrade` and `Connection` headers and doesn't terminate WebSocket connections.

**You're signed out as soon as you open a board or group page** (since 1.3). The browser's session cookie isn't reaching the WebSocket handshake on `/ws/`, so the server refuses it with `4001` and the web app signs you out, as for any expired session. Before 1.3 the same misconfiguration showed up as a Live dot stuck on **Reconnecting…** instead (#2145). The web app authenticates `/ws/` with the same session cookie as `/api/`, so:

- Serve `/ws/` from the same host as `/api/` (the host in `VITE_API_URL`, or the SPA's own origin behind a single proxy). The session cookie is scoped to the host that set it, so a `/ws/` on another host never receives it.
- With TLS, connect over `wss://`: the session cookie is `Secure` unless `FORCE_INSECURE_COOKIES` is set, so a browser doesn't send it on a plain `ws://` upgrade. The web app picks `wss://` itself when the page or `VITE_API_URL` is `https://`.
- Every proxy in front of the backend (the bundled nginx, a CDN, a load balancer, an ingress) must forward the `Cookie` header on the WebSocket upgrade request, not only on ordinary HTTP requests. The bundled nginx `location /ws/` block does.
- Don't rewrite the cookie's path: it must cover `/ws/` as well as `/api/`.

To confirm, open the browser's developer tools on a board page and check that the `/ws/boards/<id>/` request carries a `Cookie` header with the session cookie (`sessionid` by default).

## Environment variables

**The big picture:** Only the first three are required. The rest default to safe local values, but production needs several of them set (see [Step 1](#step-1-clone-and-configure)). OAuth variables are in [OAuth and SSO](oauth.md).

| Variable | Required | Description |
|---|:---:|---|
| `DJANGO_SECRET_KEY` | Yes | Django secret key. Generate with `python -c "import secrets; print(secrets.token_urlsafe(50))"`. |
| `DATABASE_URL` | Yes | PostgreSQL DSN, e.g. `postgres://user:pass@host:5432/dbname`. |
| `REDIS_URL` | Yes | Valkey DSN for Channels / WebSocket (default in Docker Compose: `redis://valkey:6379/0`). |
| `REDIS_CACHE_URL` | No | Valkey DSN for the Django cache, used for rate limiting and health checks (default: `redis://localhost:6379/1`). Docker Compose sets it automatically. Use a different database index than `REDIS_URL` to avoid key collisions. |
| `FRONTEND_URL` | No | Full URL of the React SPA (default: `http://localhost:5173`). allauth redirects here after OAuth login and logout. **Must be set in production.** |
| `DEBUG` | No | Set `True` for local development only. |
| `ALLOWED_HOSTS` | No | Comma-separated hostnames (default: `localhost,127.0.0.1`). **Must be set to your real domain in production.** The default allows only loopback addresses, so Django rejects every request from a real hostname. |
| `CORS_ALLOWED_ORIGINS` | No | Comma-separated allowed frontend origins (default: `http://localhost:5173`). Also controls `CSRF_TRUSTED_ORIGINS` unless that is set explicitly. |
| `CSRF_TRUSTED_ORIGINS` | No | Overrides CSRF trusted origins independently of `CORS_ALLOWED_ORIGINS`. Defaults to `CORS_ALLOWED_ORIGINS`. |
| `SITE_DOMAIN` | No | Public hostname used for OAuth callbacks (default: `localhost:8000`). Must match your OAuth app's redirect URI. |
| `VITE_API_URL` | No | Browser-facing backend URL (default: `http://localhost:8000`). The frontend bundle calls the API at this origin. Must move with `BACKEND_PORT` when running side-by-side stacks. In production, set it to your public backend origin (e.g. `https://api.yourdomain.com`, or the SPA's own origin behind a single proxy). If you serve the SPA from a different origin than the API with the frontend image's nginx config, `Referrer-Policy: same-origin` breaks "Connect account" until #2045 lands; serve the SPA on that host with a looser policy such as `strict-origin-when-cross-origin`. |
| `DJANGO_SUPERUSER_USERNAME` | No | Overrides the bootstrap admin username (default: `admin`). |
| `DJANGO_SUPERUSER_EMAIL` | No | Overrides the bootstrap admin email (default: `admin@localhost`). |
| `EMAIL_VERIFICATION` | No | Email verification mode: `optional` (default: sends a verification email but allows login without it), `none` (no verification; works without SMTP), or `mandatory` (blocks login until the email is verified). The old alias `ACCOUNT_EMAIL_VERIFICATION` was removed in 1.1; use `EMAIL_VERIFICATION` only. |
| `SECURE_HSTS_SECONDS` | No | HTTP Strict-Transport-Security max-age in seconds. Defaults: `0` in development; `31536000` (1 year) in production when `DEBUG=false`. **In the production Compose stack this value also drives the header `init-prod.sh` renders into nginx**, and nginx is the only thing that sends the header there (see [TLS modes](#tls-modes)). With `TLS_MODE=letsencrypt` and the value unset, nginx sends `63072000` (2 years), the value existing installs already got. With `TLS_MODE=selfsigned`, nginx sends no header unless you set this. For the Compose stack the value must be `0` or a positive integer with **no leading zero** and at most 10 digits (e.g. `300`, not `0300`); `init-prod.sh` fails closed with an error rather than guess at a malformed value. Django's own parsing elsewhere is more lenient. **Warning:** a wrong value locks browsers into HTTPS for the full duration, with no easy rollback. Start small (e.g. `300`) when you first enable HTTPS, then raise it once everything works. |
| `DJANGO_ADMIN_ALLOWED_IPS` | No | Comma-separated IPs and/or CIDR ranges (e.g. `10.0.0.0/8`) allowed to reach `/admin/`. In production the default is loopback only (`127.0.0.1`, `::1`). Setting this **replaces** that default, so include `127.0.0.1,::1` if you still need loopback access. Also covered in [Secret Rotation](../administration/secret-rotation.md). |
| `OIDC_CLIENT_ID` | No | OIDC provider client ID, for generic OIDC / OpenID Connect SSO (e.g. Keycloak, Authentik). All three `OIDC_*` vars must be set together to enable OIDC login. See [OAuth and SSO](oauth.md). |
| `OIDC_CLIENT_SECRET` | No | OIDC provider client secret. The old alias `OIDC_SECRET` was removed in 1.1; only `OIDC_CLIENT_SECRET` is read. |
| `OIDC_SERVER_URL` | No | OIDC issuer URL, e.g. `https://idp.example.com/realms/my-realm`. Must be the issuer root: allauth appends `.well-known/openid-configuration` to discover endpoints. |
| `OIDC_PROVIDER_NAME` | No | Label on the OIDC login button (default: `SSO`). |
| `TLS_MODE` | No | TLS mode for the production Docker stack: `letsencrypt` (default), `selfsigned`, or `none`. See [TLS modes](#tls-modes). |
| `FORCE_INSECURE_COOKIES` | No | Set `true` to turn off `SESSION_COOKIE_SECURE` and `CSRF_COOKIE_SECURE` for plain-HTTP deployments. `init-prod.sh` sets it automatically with `TLS_MODE=none`. Default: `false`. |
| `MAX_UPLOAD_SIZE_BYTES` | No | Maximum card attachment size in bytes (default: `10485760`, 10 MB). Raise it for large attachments; lower it to limit storage use. |
| `BOARD_EVENT_RETENTION_DAYS` | No | How long a board [change feed](../api/events.md) event stays readable, in days (default: `30`). Nothing expires on its own: schedule `manage.py prune_board_events` (see [Scheduled Jobs](../administration/scheduled-jobs.md)) or the `board_events` table grows without bound. Set it longer than the longest outage a feed consumer must survive. |
| `NOTIFICATION_RETENTION_DAYS` | No | How long an in-app notification is kept, read or unread, in days (default: `90`, minimum `14`). Enforced only when `manage.py prune_notifications` is scheduled (see [Scheduled Jobs](../administration/scheduled-jobs.md)). Unscheduled, notifications are kept forever. |
| `SCHEDULE_NOTIFY_DUE_SOON`, `SCHEDULE_NOTIFY_STALE_CARDS`, `SCHEDULE_PRUNE_BOARD_EVENTS`, `SCHEDULE_PRUNE_NOTIFICATIONS` | No | Daily run time (`HH:MM` UTC, or `off`) for each job of the opt-in Compose `scheduler` service. Defaults: `07:00`, `08:00`, `off`, `off`. Read only by `manage.py run_scheduler`. See [Scheduled Jobs](../administration/scheduled-jobs.md). |
| `GIT_LENS_ENABLED` | No | Set `true` to turn on the [Issue Board Lens](../features/issue-board-lens.md) (default: `false`). See [Optional features](../administration/configuration.md#optional-features-off-by-default). |
| `MCP_SERVER_ENABLED` | No | Set `true` to serve the [MCP server](../features/mcp-server.md) at `/mcp` (default: `false`). Also configurable: `MCP_ALLOWED_HOSTS`, and the `MCP_THROTTLE_READ_RATE`, `MCP_THROTTLE_COMPUTE_RATE`, and `MCP_THROTTLE_PREAUTH_RATE` limits. See [Optional features](../administration/configuration.md#optional-features-off-by-default). |
| `IMPORT_MAX_SIZE_BYTES` | No | Maximum Trello JSON export size for the [Trello import wizard](../features/trello-import.md), in bytes (default: `26214400`, 25 MB). Your reverse proxy must accept bodies at least this large; see [Import limits](../administration/configuration.md#import-limits). The 1.2 pre-release name `VISIBAN_IMPORT_MAX_SIZE` still works as a deprecated alias. |

<a id="local-development"></a>

## Run from source

**For contributors:** run the backend and frontend directly, without Docker.

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# Docker images install the hash-pinned backend/requirements.lock instead. If
# you edit requirements.txt, run scripts/lock-backend-requirements.sh and commit
# the regenerated lock (see docs/development/dependency-lock.md).
# Re-run `pip install -r requirements.txt` after every pull that changes
# requirements.txt: a stale venv shows up as a bare ModuleNotFoundError (e.g.
# mcp 1.x vs the 2.x pin), not as a clear "out of date" message. From a
# checkout, `scripts/wt doctor` warns about any `==` pin that differs from
# what is installed, naming the package and both versions.

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

**Point Vite at the API:** `npm run dev` expects the backend at `http://localhost:8000`. Create `frontend/.env.local` to tell Vite where the API is. The file is gitignored; never commit it.

```bash
# frontend/.env.local — local dev only, never included in Docker builds
VITE_API_URL=http://localhost:8000
```

A commented template is at `frontend/.env.local.example`.
