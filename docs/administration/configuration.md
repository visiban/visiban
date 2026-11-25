# Required credentials reference

Find every secret, credential, and environment variable Visiban needs in local development, the GitLab CI pipeline, and production.

**Why it matters:** In production, `DB_PASSWORD`, `REDIS_PASSWORD`, and `APP_VERSION` are required, and `DJANGO_SECRET_KEY` must be unique and kept secret.

**The big picture:** start with your environment ([local development](#local-development), [GitLab CI pipeline](#gitlab-ci-pipeline), [production](#production-deployment)), then the feature sections: [reverse proxies](#reverse-proxies-and-the-client-ip), [optional features](#optional-features-off-by-default), [import limits](#import-limits), [email](#email-smtp), [demo mode](#demo-mode), [variables documented elsewhere](#variables-documented-on-other-pages), [health checks](#health-check-endpoints), [deprecated names](#deprecated-environment-variable-names).

---

## In-app help links

*(new in 1.3)* The "?" and "Learn more" links in the app open the Visiban docs in a new tab, matched to the version you run: a 1.3.x install links to `docs.visiban.com/1.3/...`, a prerelease build to `/next/`, and a build whose version is missing or not a release number to `/latest/`. A build from `main` reports the last released version, so its links point at that version's docs until a 1.3 prerelease is cut.

To point them at your own documentation mirror (for example on an air-gapped network), set the `VITE_DOCS_BASE_URL` build argument when you build the frontend image:

```bash
docker build --build-arg VITE_DOCS_BASE_URL=https://docs.example.internal/visiban frontend/
```

| Variable | Meaning | Default |
|---|---|---|
| `VITE_DOCS_BASE_URL` | Docs base URL, `http://` or `https://` only. Used exactly as given (a trailing slash is ignored) with no version segment added, so the mirror should serve one doc set at that address. Anything else is ignored. | empty (`https://docs.visiban.com`, version-matched) |

**Watch out:** this is a build-time setting baked into the JavaScript bundle, so it can't be changed on a prebuilt release image. A runtime setting is not part of this release (tracked in #2604), so until then prebuilt images cannot be overridden.

---

## Local development

Copy `.env.example` to `.env` in the repository root and fill in the values below.

| Variable | Description | Example / default |
|---|---|---|
| `DJANGO_SECRET_KEY` | Django signing key. Generate with: `python -c "import secrets; print(secrets.token_urlsafe(50))"` | *generated value* |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://visiban:visiban@db:5432/visiban` |
| `POSTGRES_PASSWORD` | Must match the password in `DATABASE_URL` | `visiban` (dev only) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth — leave blank to disable | *optional* |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth — leave blank to disable | *optional* |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | GitLab OAuth — leave blank to disable | *optional* |
| `ALLOWED_HOSTS` | Comma-separated list of hostnames the backend will accept. Defaults to `localhost,127.0.0.1`. Must include your LAN IP or hostname if you access Visiban from another machine or a non-localhost address. | `localhost,127.0.0.1` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of origins allowed to make API requests. Must match the exact origin your browser uses (scheme + host + port). Defaults to `http://localhost:5173`. Also controls `CSRF_TRUSTED_ORIGINS` unless that is set separately. | `http://localhost:5173` |
| `SILENCED_SYSTEM_CHECKS` | Comma-separated Django system-check IDs to silence, for warnings you have reviewed and accepted (for example `accounts.W001,accounts.W002`, the IDs named in `manage.py check` hints). Empty by default, so nothing is silenced. Helm: `backend.settings.silencedSystemChecks` (with `--set`, escape commas as `\,` or use a values file). | *empty* |
| `VITE_API_URL` | Frontend env var for `npm run dev` — create `frontend/.env.local` (gitignored) and set to `http://localhost:8000`. Leave empty for Docker builds; the frontend falls back to `window.location.origin` and relies on nginx to proxy `/api/` and `/ws/`. | `http://localhost:8000` |

Valkey has no authentication in development, so no variable is needed.

### Frontend local override

When running the Vite dev server directly (`npm run dev`), create `frontend/.env.local` with:

```bash
VITE_API_URL=http://localhost:8000
```

This file is gitignored and excluded from Docker builds via `frontend/.dockerignore`.

**Watch out:** never set `VITE_API_URL` to a `localhost` value in a Docker image. It is baked into the JS bundle and breaks WebSocket connections for any client accessing from a non-localhost address. The correct value for all Docker builds (dev compose, prod compose, Helm) is an empty string, which makes the frontend resolve the API relative to `window.location.origin`.

---

## GitLab CI pipeline

Add these in **Settings → CI/CD → Variables**. **Watch out:** the pipeline fails or produces SAST warnings if any are missing.

| Variable | Used by | Masked | Notes |
|---|---|---|---|
| `CI_DJANGO_SECRET_KEY` | `backend-test`, `backend-test-migrations`, `backend-test-slow`, `migration-check`, `schema-validation` | Yes | Any non-empty string; not a production secret |
| `CI_POSTGRES_PASSWORD` | `backend-test`, `backend-test-migrations`, `backend-test-slow` | Yes | Ephemeral test DB; any non-empty string |
| `CI_POSTGRES_USER` | `backend-test`, `backend-test-migrations`, `backend-test-slow` | No | e.g. `visiban` |
| `CI_POSTGRES_DB` | `backend-test`, `backend-test-migrations`, `backend-test-slow` | No | e.g. `visiban_test` |
| `GHCR_TOKEN` | `backend-docker-push`, `frontend-docker-push` | Yes | GitHub PAT, `write:packages` scope |
| `GHCR_USER` | Same | No | `visiban` |
| `GITHUB_TOKEN` | `github-release` | Yes | GitHub PAT, `repo` scope |
| `DOCS_DEPLOY_TOKEN` | `docs-deploy` | Yes | GitLab project access token, `write_repository` scope |
| `GITLAB_API_TOKEN` | `release-main-pipeline-guard` (release tags; **required**, every `v*` tag pipeline refuses to publish without it), `schedule-config-check`, `suppressions-check` | Yes | GitLab personal access token, `read_api` scope, owner Reporter or higher (Maintainer for `schedule-config-check`). Mark it **protected**. See [Tokens and Rotation](../maintainers/tokens-and-rotation.md#gitlab_api_token-and-the-release-guard) |
| `MINIO_ENDPOINT` | Cache warm jobs | No | MinIO S3-compatible cache endpoint |
| `MINIO_ACCESS_KEY` | Cache warm jobs | Yes | |
| `MINIO_SECRET_KEY` | Cache warm jobs | Yes | |
| `MINIO_BUCKET` | Cache warm jobs | No | |

### Schema-fuzz overrides

| Variable | Default | Notes |
|---|---|---|
| `VISIBAN_DISABLE_THROTTLING` | `false` | CI/test-only; not for production. Set by the `backend-schema-fuzz` job so its ~20k requests are not answered with 429. Lifts every API throttle rate and allauth's failed-login lockout (which answers 400 on the API and would hide the login view from the fuzzer). Requires `DEBUG=True`; the app refuses to start if it is set otherwise. |
| `VISIBAN_GIT_LENS_STUB_PROVIDERS` | `false` | **CI/dev only; never set this in a deployed environment.** Set by the `backend-schema-fuzz-git-lens` job (#1338) so the Issue Board Lens answers GitHub/GitLab requests from a fixed in-process fixture instead of the network. Requires `DEBUG=True` and `DEMO_MODE` off; the app refuses to start if it is set otherwise. |

---

## Production deployment

### Docker Compose

Create a server-side `.env` file alongside `docker-compose.prod.yml`:

> Secret values (`DJANGO_SECRET_KEY`, OAuth/OIDC client IDs and secrets, `EMAIL_HOST_PASSWORD`, `DEMO_ADMIN_PASSWORD`, `DEMO_MEMBER_PASSWORD`) are used verbatim, including when they start with `$`; they are never treated as references to other variables.

| Variable | Description |
|---|---|
| `APP_VERSION` | Image tag to pull, e.g. `v1.1.0`. **Required**: the compose file fails to start if unset and no longer falls back to the mutable `latest` tag (see [Container image retention](container-image-retention.md)). `.env.example` ships a pinned value. The backend strips only a leading `v`: `GET /api/v1/version/` reports bare semver (e.g. `1.1.0`) for a release tag, and serves a non-release value such as `latest` or `dev` back verbatim (see [Version API](../api/version.md)). |
| `DB_PASSWORD` | PostgreSQL password — required, no default; the compose file will error on startup if missing |
| `REDIS_PASSWORD` | Valkey authentication password — required in production; the Valkey service starts with `--requirepass` and `REDIS_URL`/`REDIS_CACHE_URL` are built from this value. Generate with: `openssl rand -hex 32` (base64 output can contain `/`, which breaks the URL) |
| `VALKEY_MAXMEMORY` | Valkey memory ceiling for `docker-compose.prod.yml` (default `256mb`, for example `512mb`). The eviction policy is fixed at `volatile-lru`. Keep it below the container memory limit; see [Valkey memory limit and eviction](#valkey-memory-limit-and-eviction) |
| `REDIS_URL_PASSWORD` | Not set under Compose, which puts the password into `REDIS_URL`/`REDIS_CACHE_URL` itself (from `REDIS_PASSWORD`). The Helm chart sets it from a Secret when `valkey.auth.enabled` is true or `externalRedis.existingSecret` is set. The backend percent-encodes it into both URLs, so any character is safe, and keeps a username in the URL (`redis://user@host:6379/0`, a Redis ACL user). It refuses to start if a URL already carries a password too, because the two would compete. |
| `DATABASE_URL_PASSWORD` | Optional (#1910). Not set under Compose, or by default under Helm. The Helm chart sets it from the `password` key of the Secret named by `postgresql.auth.existingSecret`, and renders `DATABASE_URL` without a password. The backend percent-encodes it into `DATABASE_URL`, so any character is safe. The chart does not set it when `secret.existingSecret` supplies a complete `database-url`. It refuses to start if `DATABASE_URL` already carries a password too, because the two would compete. |
| `DJANGO_SECRET_KEY` | Production Django signing key — must be unique and kept secret |
| `DOMAIN` | Your domain name for Nginx and Certbot, e.g. `app.visiban.com` |
| `SILENCED_SYSTEM_CHECKS` | Optional. Comma-separated Django system-check IDs to silence, e.g. `accounts.W001,accounts.W002`. Empty by default. |
| `CERTBOT_EMAIL` | Email address for Let's Encrypt expiry notifications |
| OAuth variables | As in the local dev table above — only needed for providers you enable |

### Helm

Pass sensitive values via a gitignored `values.secret.yaml` file — **never via `--set`** (leaks to shell history and process lists) and **never committed to version control**.

An example file is included at `helm/visiban/values.secret.yaml.example`. Copy it to `values.secret.yaml`, fill in values, and pass it with `-f`:

**Tip:** for production clusters, bring your own Kubernetes Secret instead of having the chart create one. Set `secret.existingSecret` to the Secret name and the chart will reference it directly. See [Deployment — Using an existing Kubernetes Secret](../architecture/deployment.md#using-an-existing-kubernetes-secret).

| Key | Description |
|---|---|
| `secret.existingSecret` | Name of a pre-existing K8s Secret — when set, the chart does not create its own |
| `secret.djangoSecretKey` | Production Django signing key (ignored when `existingSecret` is set) |
| `postgresql.auth.existingSecret` | Name of a pre-existing K8s Secret for the PG password (key: `password`). The bundled PostgreSQL and the backend (via `DATABASE_URL_PASSWORD`) both read the password from it, so `postgresql.auth.password` is unused (#1910) |
| `postgresql.auth.password` | PostgreSQL password, used to build the chart-managed `database-url`. An empty or placeholder (`visiban`) value fails the render; set your own password. Not used, and not checked, when `postgresql.auth.existingSecret` is set |
| `backend.settings.frontendUrl` | Full URL of the SPA — allauth redirects here after OAuth login/logout |
| `backend.settings.silencedSystemChecks` | Optional. Comma-separated Django system-check IDs to silence, e.g. `accounts.W002` (becomes `SILENCED_SYSTEM_CHECKS`). With `--set`, escape commas (`a\,b`) or use a values file; otherwise Helm splits on the comma and fails with `key "W001" has no value` |
| `backend.settings.siteDomain` | Public hostname for OAuth callback URLs |
| `backend.oauth.google.*` | Google OAuth credentials |
| `backend.oauth.github.*` | GitHub OAuth credentials |
| `backend.oauth.gitlab.*` | GitLab OAuth credentials |
| `backend.oauth.oidc.serverUrl` | OIDC issuer URL — set all three OIDC fields to enable generic OIDC login |
| `backend.oauth.oidc.clientId` | OIDC client ID |
| `backend.oauth.oidc.clientSecret` | OIDC client secret |
| `backend.oauth.oidc.providerName` | Label on the OIDC login button (default: `SSO`) |
| `backend.image.tag` | Image tag to deploy, e.g. `v1.0.0` |
| `frontend.image.tag` | Image tag to deploy, e.g. `v1.0.0` |

Example using a values file:

```bash
helm upgrade --install visiban ./helm/visiban \
  -f helm/visiban/values.secret.yaml \
  --set backend.settings.frontendUrl="https://boards.example.com" \
  --set backend.settings.siteDomain="boards.example.com" \
  --set backend.image.tag="v1.0.0" \
  --set frontend.image.tag="v1.0.0"
```

---

## Reverse proxies and the client IP

> **Added in 1.2** (#1180).

Per-IP rate limits (the login throttle, the anonymous request ceiling, allauth's failed-login lockout, the [MCP pre-auth failure limit](../api/mcp.md#failed-authentication-limit-per-ip), `MCP_THROTTLE_PREAUTH_RATE`) and the `/admin/` IP allowlist need the visitor's real address. Behind proxies, Visiban reads it from `X-Forwarded-For`, trusting the entry the configured number of proxies appended. Everything to its left is client-supplied.

| Variable | Default | Description |
|---|---|---|
| `NUM_PROXIES` | `1` | Number of reverse proxies in front of the backend that append to `X-Forwarded-For`. The default `1` counts this chart's own frontend nginx: correct for Docker Compose and for Helm with the ingress disabled and nothing else in front of the frontend Service. Helm renders `2` when `ingress.enabled` is true, `frontend.service.type` is `ClusterIP` and `backend.settings.numProxies` is unset; an explicit value always wins. A non-negative integer; anything else refuses to start. Helm: `backend.settings.numProxies`. |

**Watch out:** set it to the real depth of your proxy chain.

- **Too low**: every client appears to come from the nearest proxy. One client exhausts the login and anonymous throttles for everyone.
- **Too high**: a client can choose its own address by sending its own `X-Forwarded-For`, and so escape per-IP limits.

**Behind an ingress controller, `1` is too low.** The Helm chart therefore renders `2` by default when its Ingress is enabled and the frontend Service is `ClusterIP` (if the frontend Service is exposed directly, only one hop applies; set `backend.settings.numProxies` to override; an additional proxy in front of the ingress, such as a CDN, needs an explicit value).

**How to count:**

- This chart's frontend nginx always appends one hop (`proxy_add_x_forwarded_for`). An ingress controller in front of it appends its own, so the real chain is two hops deep, not one.
- Count every proxy between the internet and the frontend Service, including the frontend nginx itself.
- The value must equal the number of trusted proxy hops that append to `X-Forwarded-For`.
- Each proxy (including the ingress controller) must be configured to preserve and append the upstream header; check your controller's forwarded-header settings in its documentation.

The hosted demo behind a Cloudflare Tunnel uses `2` (Cloudflare appends the visitor, then the frontend nginx appends the tunnel pod). See [Public demo mode](demo-data.md#public-demo-mode-helm).

---

## Optional features (off by default)

Three features are dormant until an operator opts in. Set these in your `.env` file, then run `docker compose up -d` to recreate the backend with them (`docker compose restart` does not re-read `.env`).

- **Migration:** turning `GIT_LENS_ENABLED` on adds the `git_lens` app and its tables, so a migration must run. In the production stack the `backend-init` service does that on `up -d`.
- **Helm:** the chart exposes the enable flags `backend.settings.mcpServerEnabled`, `backend.settings.gitLensEnabled` and `backend.settings.webhooksEnabled` (all default `false`), plus `backend.settings.gitLensMaxPages` for `GIT_LENS_MAX_PAGES` (default unset, so the backend default of `3` applies; the chart accepts `1` to `10`), `backend.settings.webhookAllowedPrivateTargets`, `backend.settings.webhookHostMaxPerMinute`, `backend.settings.webhookHostMaxConcurrency` and `webhooks.dispatcher.*` for webhooks (see [Kubernetes deployment](../architecture/deployment.md)). The other variables in the table below (`GIT_LENS_OUTBOUND_LOG_LEVEL`, `MCP_ALLOWED_HOSTS`, `MCP_THROTTLE_*_RATE`) and the webhook tuning variables are Compose/env-only; the chart has no values for them.
- **Names are stable:** a rename keeps the old name as a deprecated alias for at least one minor release.

| Variable | Default | Description |
|---|---|---|
| `GIT_LENS_ENABLED` | `false` | Turns on the [Issue Board Lens](../features/issue-board-lens.md), a read-only board built from a public GitHub or GitLab repository's issues. While off, there is no Lens tab, no Lens settings, and no related API surface. *(new in 1.2)* |
| `GIT_LENS_OUTBOUND_LOG_LEVEL` | `INFO` | Log level of the one-line record written for each outbound GitHub/GitLab request the lens makes. Set `WARNING` to silence it without affecting the usage report. See [Issue Board Lens Usage](issue-board-lens-usage.md). |
| `GIT_LENS_MAX_PAGES` | `3` | How many pages of 100 issues one lens refresh may load, so `3` is 300 issues. Values below `1` are treated as `1` and values above `10` as `10` (1,000 issues); a non-number falls back to `3`. Every extra page is one more GitHub or GitLab request per refresh, and anonymous GitLab reads count against your instance's own IP, so the per-fetch bound in the [usage report](issue-board-lens-usage.md#why-the-traffic-is-bounded) grows with it. The fetch runs inside the viewer's request, one page after another: a 10-page refresh normally takes a few seconds but can take up to 160 seconds when every request to the provider times out, so keep your proxy and worker timeouts above the time a refresh takes at the value you choose. The bundled nginx in the Compose stack has a fixed 90-second `proxy_read_timeout` for `/api/`, which the default of `3` already reaches in the worst case (9 requests of up to 10 seconds each); the Helm chart's frontend nginx sets none for `/api/`, so nginx's own 60-second default applies there. Neither is configurable, so any value above `3` needs a deployment whose proxy allows a longer read. Otherwise a slow refresh shows the viewer a `504` error while the fetch carries on in the backend and fills the cache, so reloading the board a little later shows it. Helm: `backend.settings.gitLensMaxPages`. *(new in 1.3)* |
| `MCP_SERVER_ENABLED` | `false` | Mounts the [MCP server](../features/mcp-server.md) at `/mcp` so AI agents can reach boards with a personal access token. While off, `/mcp` returns `404 Not Found` and the MCP SDK is never imported. *(new in 1.2)* |
| `MCP_ALLOWED_HOSTS` | empty (falls back to `ALLOWED_HOSTS`) | Comma-separated hostnames clients use to reach `/mcp`, checked against the `Host` header as DNS-rebinding protection. Set it explicitly when `ALLOWED_HOSTS` is `*`, because a wildcard cannot serve as the allowlist. When set, it takes precedence over `ALLOWED_HOSTS`. See [MCP Server API](../api/mcp.md). |
| `MCP_THROTTLE_READ_RATE` | `300/min` | Baseline per-token limit applied to every MCP tool call and resource read. |
| `MCP_THROTTLE_COMPUTE_RATE` | `30/min` | Additional, tighter per-token limit for expensive reads (`list_cards`, `board_flow_metrics`, `aging_cards` and `board://{board_id}`), spent on top of the baseline. |
| `MCP_THROTTLE_PREAUTH_RATE` | `30/min` | Per-client-IP limit on failed MCP authentication attempts. Once an IP is over budget, all of its requests (valid ones too) are refused until the window slides. See [Failed authentication limit](../api/mcp.md#failed-authentication-limit-per-ip). |
| `WEBHOOKS_ENABLED` | `false` | Lets board admins register [outbound webhooks](../features/webhooks.md). The dispatcher must also run. Tuning is in [Webhooks](#webhooks) below. *(new in 1.3)* |

Rates use the DRF form `<count>/<period>` with `sec`, `min`, `hour` or `day`. See [MCP Server API: Rate limiting](../api/mcp.md#rate-limiting) for how the buckets stack.

---

## Database connection pool

> **Added in 1.3** (#1958).

By default each HTTP request opens and closes its own PostgreSQL connection. Set `DATABASE_POOL=true` to have each backend process share a [psycopg connection pool](https://www.psycopg.org/psycopg3/docs/advanced/pool.html) instead, which removes the connect and authentication cost per request. It applies only to PostgreSQL; with another engine it is ignored with a warning. Visiban sets `CONN_MAX_AGE=0` for you when the pool is on, as Django requires.

| Variable | Description | Default |
|---|---|---|
| `DATABASE_POOL` | Enables the connection pool. Helm: `backend.settings.dbPool.enabled`. | `false` |
| `DATABASE_POOL_MIN_SIZE` | Connections each process keeps open. Must be at least 1. Helm: `backend.settings.dbPool.minSize`. | `2` |
| `DATABASE_POOL_MAX_SIZE` | Most connections each process opens. Must be at least `DATABASE_POOL_MIN_SIZE`. Helm: `backend.settings.dbPool.maxSize`. | `10` |

**When the pool is full:** a request needs a connection for as long as its view runs, on its own thread. When more than `DATABASE_POOL_MAX_SIZE` requests are in flight in one process, the extra ones queue for a free connection and raise `PoolTimeout` (a `500`) after the 30-second default timeout of psycopg_pool's `ConnectionPool`. Raise `DATABASE_POOL_MAX_SIZE` before `max_connections` is the limit you hit, or add replicas.

**Health checks:** with the pool on, Visiban also enables Django's `CONN_HEALTH_CHECKS`, so a connection that died (PostgreSQL restart or failover) is replaced instead of being handed to a request.

**Sizing:** the pool is per process, so the worst case is `DATABASE_POOL_MAX_SIZE` x processes per replica x replicas. Keep that below PostgreSQL's `max_connections` (default 100), leaving headroom for migrations and admin sessions, or put pgBouncer in front. The migrate init container, the CronJobs and the scheduler inherit the same environment, so each of them also opens up to `DATABASE_POOL_MIN_SIZE` connections while it runs; count them too. The migration lock connection deliberately bypasses the pool. See [Scaling](../architecture/scaling.md).

## PostgreSQL lock table and the change feed

<span class="vb-version" title="Added in 1.3">1.3+</span>

A transaction that writes [change feed](../api/events.md) events holds one PostgreSQL advisory lock per board it writes events on, until it commits (#2053). The lock lets feed readers tell that no lower event id is still committing. Writers never wait for each other on it. PostgreSQL keeps every session's locks in one shared table of `max_locks_per_transaction × (max_connections + max_prepared_transactions)` entries: 6,400 at the defaults (64 × 100).

An ordinary write uses one or two entries. The largest case in the product is deactivating or deleting an account that has pending invite links on many boards, which uses one entry per such board. Deleting boards, including a bulk delete in the Django admin, uses none for the deleted boards themselves, plus one per other board where a deleted card was blocking a card (that card gets a `card.updated`). A single transaction therefore only nears the limit when it writes events on thousands of boards. If a write fails with `out of shared memory` and the hint `You might need to increase max_locks_per_transaction`, raise `max_locks_per_transaction` in `postgresql.conf` (or the chart's PostgreSQL configuration) and restart PostgreSQL.

## Backend memory and CPU sizing

The Helm defaults fit a small team, not a large board with long history. Opening Analytics on a big board can push the backend past the default memory limit and get the pod OOM-killed, which drops every WebSocket.

**Why it matters:** The chart sets `backend.resources` to `requests: 100m / 256Mi` and `limits: 500m / 512Mi`. One Analytics overview on a 12k-card board peaked at 551 MB of process memory, and on a 2.4k-card board with three years of history it peaked at 1.1 GB. Idle, the backend uses about 115 MB.

**The headline:** A 512 MB backend limit is too small for a board with about three years of history and 12k active cards. On such a board, one cumulative-flow day drill-down (`?date=`) peaked at 678-720 MB of process memory. Until that is fixed ([#2559](https://gitlab.com/visiban/visiban/-/issues/2559)), give the backend more than 512 MB; the tiers below suggest `2Gi` for a board of that size and age.

**Measured since:** The 1.3 beta-exit stress run ([#2588](https://gitlab.com/visiban/visiban/-/issues/2588), [#2595](https://gitlab.com/visiban/visiban/-/issues/2595)) measured the current code (results reported 2026-11-25):

- **Fixture:** `seed_demo_data --scale 100 --aged-generations 12`, which gave 11,990 active and 143,880 archived cards (12 generations, about 3 years).
- **Setup:** a CI runner, `daphne`, `DEBUG=False`, `ANALYTICS_MAX_CONCURRENT=1`, two runs.

| Request | Result |
|---|---|
| `metrics/cumulative-flow/?date=` drill-down | Peak process memory 720 MB (first run) and 678 MB (second run: 10 requests, about 5.1-5.8 s each, 218,843 streamed rows) |
| `metrics/cumulative-flow/` (no `date`) | Refused with `422 analytics_too_large`: 150,001 held movements, over `ANALYTICS_MAX_MOVEMENTS=150000` |
| `metrics/overview/?days=90` | Refused with `422`, same count |
| `analytics/?days=365` | No response within 30 s (first run) or 90 s (second run), and no completion logged within about 6.5 minutes |

- **Latencies are indicative:** the second run shared a busy runner. Its memory figures are not much affected by that load.
- **Not yet measured:** the concurrency figures (memory and responsiveness while several overviews are opened at once) are still pending a third run.

**By the numbers:** The figures below were measured on 2026-11-20, before #2426 and #2427 shipped. They are per Analytics overview open as it was then (`analytics/?days=90`, `analytics/?days=365`, the `metrics/*` endpoints and `summary`). The overview now sends two requests, `metrics/overview/?days=90` and `analytics/?days=90`, so treat them as upper-bound, pre-fix figures:

| Largest board | Cards / movements | Largest single request (peak Python allocation) | Overview, 8 requests serial (measured 2026-11-20, before #2426 and #2427) |
|---|---|---|---|
| 2.4k active, 80 days of history | 2,395 / 24,919 | `analytics/?days=365`: 0.49 s, 29 MB | 1.4 s |
| 2.4k active, plus 1 year archived | 11,947 / 124,255 | `analytics/?days=365`: 1.95 s, 137 MB | 4.6 s |
| 2.4k active, plus 3 years archived | 31,051 / 322,927 | `metrics/*`: 1.4-1.6 s, 186 MB | 10.0 s |
| 12k active, 80 days of history | 12,058 / 124,374 | `analytics/?days=365`: 2.26 s, 144 MB | 7.4 s |
| 12k active, plus 1 year archived | 60,262 / 621,534 | `analytics/?days=365`: 9.58 s, 691 MB | 22.9 s |

Process memory is higher than the Python allocation in the table (about 115 MB idle, plus the request, plus memory the process keeps). Use these as a starting point for `backend.resources.limits.memory`, and raise it if the pod restarts with `OOMKilled`. The tiers are interpolated from the peaks above, not measured per tier. Process memory for 12k cards with a year of history was never measured:

| Largest board | Suggested `limits.memory` | Suggested `requests.memory` |
|---|---|---|
| Up to about 2.4k active cards and under a year of history | `512Mi` (the default) | `256Mi` (the default) |
| Up to about 12k active cards with under a year of history, or about 2.4k active with 1 to 2 years of history | `1Gi` | `512Mi` |
| Large boards: 12k or more active cards with a year or more of history, or 2 or more years of history | `2Gi` (the highest process peak measured was 1,956 MB, so this tier leaves only about 190 MB over that burst peak) | `1Gi` |

```yaml
backend:
  resources:
    requests:
      cpu: 250m
      memory: 1Gi
    limits:
      cpu: 1000m
      memory: 2Gi
```

The 2026-11-20 latencies above are from a laptop on a full core. The default `cpu: 500m` limit roughly doubles the wall time of a heavy request. Raise `limits.cpu` if Analytics on a large board feels slow. If you enable `backendAutoscaling`, keep `requests.cpu` set, because the autoscaler needs it.

**Yes, but:** `daphne` keeps its high-water mark. After a burst of Analytics requests the process does not give the memory back: it sat at 703 MB before the next burst after a 1,128 MB peak, and at 1,407 MB after a 1,956 MB peak. A pod that survived one heavy open starts the next one closer to its limit. This is CPython allocator behavior (arenas and fragmentation), not a leak in Visiban code, and it was not proven to grow without bound. Leave headroom above the peak, not just above idle.

**Watch out:**

- The Helm chart's default limits are **not** raised yet. Raising a default changes behavior for existing installs, so that decision waits on #2425 (still open) and the rest of the re-measure (#2430). #2426 and #2427 have shipped and should shrink most of the 2026-11-20 numbers.
- The 2026-11-20 numbers are pre-fix numbers from a local run (Apple Silicon laptop, PostgreSQL 17, `DEBUG=False`, an aged copy of the demo seed). Treat them as a floor for sizing, not a guarantee. Re-measure on your own data.
- The 2026-11-20 numbers were also measured before the [Analytics limits](#analytics-limits) existed. Since 1.3 a request that would hold more than `ANALYTICS_MAX_MOVEMENTS` movement rows is refused with `analytics_too_large`, and each process computes at most `ANALYTICS_MAX_CONCURRENT` Analytics requests at once. If you raise `limits.memory` for a large board, raise `ANALYTICS_MAX_MOVEMENTS` with it, or that board's Analytics stays refused.
- `daphne` has no `--max-requests`. If memory keeps climbing between Analytics bursts, restart the backend pods on a schedule (for example `kubectl -n <namespace> rollout restart deployment -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=backend`; in-flight requests can be cut and WebSocket clients reconnect). Tuning `MALLOC_ARENA_MAX` or `PYTHONMALLOC` is untested for Visiban, so measure before and after if you try it.

**Go deeper:** [Helm chart README](https://gitlab.com/visiban/visiban/-/blob/main/helm/visiban/README.md#backend-sizing), [Kubernetes install](../getting-started/kubernetes.md).

## Valkey memory limit and eviction

Valkey holds only short-lived state: the Channels layer (WebSocket groups, db 0) and the Django cache (db 1). The cache carries rate-limit counters, single-use WebSocket tickets, Git lens fetch locks, filter caches and, if you set a cache `SESSION_ENGINE`, sessions. Every one of these keys is written with a TTL. Nothing in Valkey is a system of record: PostgreSQL is.

Without a ceiling, Valkey grows until the container or pod is OOM-killed, which drops every WebSocket connection. Visiban therefore ships a ceiling and an eviction policy in all three deployments:

| Deployment | Ceiling | Policy | How to change it |
|---|---|---|---|
| Development `docker-compose.yml` | `256mb` | `volatile-lru` | Edit the `valkey` service `command` |
| Production `docker-compose.prod.yml` | `256mb` | `volatile-lru` | Set `VALKEY_MAXMEMORY` in `.env` (for example `512mb`) |
| Helm chart | `128mb` (pod limit is `192Mi`) | `volatile-lru` | `valkey.primary.maxmemory` and `valkey.primary.maxmemoryPolicy` |

**Why `volatile-lru` and not `allkeys-lru`.** `volatile-lru` evicts only keys that carry a TTL and returns an error on a write that would need to evict a key without one. Today that is the same set of keys, but it means a future key that must not disappear (a lock or counter written without an expiry) is never silently dropped. `noeviction` is the wrong choice here: at the ceiling it would make every Channels and cache write fail, which is an outage rather than a degraded cache.

**What eviction costs.** Keys go in least-recently-used order, so under sustained pressure an idle user's cache entry, ticket or counter can be evicted early. The effects are small and self-healing: a cache miss recomputes, a WebSocket reconnects with a fresh ticket, a rate-limit window restarts, and a cache-backed session signs the user out. If `evicted_keys` in `valkey-cli INFO stats` keeps rising, raise the ceiling rather than the policy. Keep the ceiling below the container or pod memory limit, because AOF rewrites and client buffers need headroom.

Under Helm, a `maxmemory` line in `valkey.commonConfiguration` comes after the chart's own and wins. Set `valkey.primary.maxmemory` to an empty string to remove the ceiling. For an external Valkey or Redis (`externalRedis`), set `maxmemory` and `maxmemory-policy volatile-lru` on that server yourself.

### If Valkey goes down

> **Changed in 1.3** (#1465).

A Valkey outage no longer takes the app offline. The readiness probe stays `200` and reports `{"status": "degraded"}`, so pods stay in the Service, and:

- **Ordinary REST requests keep working.** The global `anon` and `user` rate limits fail open: they are not enforced until Valkey returns. Maintenance mode, registration mode and the uploads toggle are read from the database instead.
- **The Git lens board fails closed** (experimental, `GIT_LENS_ENABLED`): it returns `503` with `code: "lens_unavailable"` and makes no GitHub or GitLab request until Valkey returns, because its fetch budgets and lock live in Valkey.
- **Security rate limits fail closed.** Login (including the failed-login lockout), registration, password change and reset, user search, invite-link and share-link redemption, and the other endpoints with their own limit return `500` until Valkey returns, rather than run without brute-force protection. With the default database session engine, signed-in users keep their sessions.
- **Realtime updates stop** until Valkey returns.

Alert on Valkey's own metrics or on the `Readiness degraded: cache` and `Cache unreachable` log lines, not on the readiness probe. See [Health API](../api/health.md#get-apihealthreadiness).

**Cache timeouts.** Every cache call gives up after a bounded wait, so a Valkey that is unreachable without refusing connections (a dropped route, a firewall that discards packets, a node that disappeared) fails fast instead of hanging each request. The readiness probe makes one cache call, so its answer arrives inside the 1-second Kubernetes default probe timeout. The timeouts apply to the Django cache only: the realtime (Channels) connection keeps its own settings, because it holds blocking reads open on purpose.

| Variable | Description | Default |
|---|---|---|
| `REDIS_CACHE_SOCKET_CONNECT_TIMEOUT` | Seconds to wait for a connection to the cache (`REDIS_CACHE_URL`). Must be greater than 0. Keep it below 1 unless you also raise the readiness probe's `timeoutSeconds`. Helm: `backend.settings.cacheTimeouts.connectSeconds`. *(new in 1.3)* | `0.5` |
| `REDIS_CACHE_SOCKET_TIMEOUT` | Seconds to wait for each cache reply. Must be greater than 0. Helm: `backend.settings.cacheTimeouts.socketSeconds`. *(new in 1.3)* | `0.5` |

## Webhooks

> **Added in 1.3** (#863).

[Outbound webhooks](../features/webhooks.md) are off until `WEBHOOKS_ENABLED=true`, and nothing is delivered until the dispatcher runs: the Compose `webhooks` profile, the Helm `webhooks.dispatcher.enabled` Deployment, or `manage.py dispatch_webhooks` from host cron. `WEBHOOKS_ENABLED` together with `DEMO_MODE` is a startup error (`webhooks.E001`).

| Variable | Default | Description |
|---|---|---|
| `WEBHOOKS_ENABLED` | `false` | Turns the feature on. Helm: `backend.settings.webhooksEnabled`. |
| `WEBHOOK_ALLOWED_PRIVATE_TARGETS` | empty | Comma-separated exact hostnames, IPs or CIDRs of private destinations webhooks may reach. Hostname and CIDR entries admit RFC 1918, CGNAT and IPv6 unique-local addresses; loopback, link-local and cloud-metadata addresses need an exact single-address entry (`127.0.0.1`, `::1/128`). `http://` and ports below 1024 other than 443 are allowed only for these destinations. A `/0`, a public range or a reserved address is a startup error (`webhooks.E002`). Helm: `backend.settings.webhookAllowedPrivateTargets`. See [Private and LAN destinations](../features/webhooks.md#private-and-lan-destinations). With the Helm dispatcher egress policy on, add each private destination to `webhooks.dispatcher.networkPolicy.allowedCIDRs` as well, or the network policy still blocks it; see [Dispatcher egress policy](../features/webhooks.md#dispatcher-egress-policy-kubernetes). |
| `WEBHOOK_CONNECT_TIMEOUT_SECONDS` | `3` | Connect timeout per delivery. |
| `WEBHOOK_TIMEOUT_SECONDS` | `10` | Overall timeout per delivery, connect included. |
| `WEBHOOK_MAX_PER_BOARD` | `10` | Webhooks per board. |
| `WEBHOOK_MAX_PER_USER` | `25` | Webhooks owned by one account, across boards. |
| `WEBHOOK_MAX_TOTAL` | `1000` | Webhooks on the server. |
| `WEBHOOK_MAX_EVENTS_PER_RUN` | `100` | Events read for one webhook in one dispatcher run. |
| `WEBHOOK_RUN_BUDGET_SECONDS` | `50` | Wall-clock budget of one dispatcher run; keep it below the run interval for cron. |
| `WEBHOOK_BACKOFF_BASE_SECONDS` | `30` | First retry delay after a failure; doubles per consecutive failure. |
| `WEBHOOK_BACKOFF_MAX_SECONDS` | `3600` | Longest retry delay. |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | `20` | Consecutive failures that turn a webhook off. |
| `WEBHOOK_DISABLE_AFTER_HOURS` | `24` | Hours of continuous failure that turn a webhook off. |
| `WEBHOOK_REFUSAL_FLOOR_SECONDS` | `WEBHOOK_CONNECT_TIMEOUT_SECONDS` | Every "can't send to this address" refusal at save time takes at least this long, so its timing does not reveal which address rule matched. Lowering it trades that for a faster answer. |
| `WEBHOOK_SETTLE_SECONDS` | `10` | Events younger than this wait for the next run. Since 1.3 the dispatcher never skips an event whose transaction commits late, whatever this value is (#2053); the window only delays delivery. |
| `WEBHOOK_DISPATCHER_STALE_SECONDS` | `300` | After this long without a dispatcher run, the board's Webhooks tab warns its admins. |
| `WEBHOOK_HOST_MAX_PER_MINUTE` | `120` | Deliveries to one destination host per minute, across every board's webhooks and every dispatcher (counted in the shared cache; per process without one). The budget is per destination host and shared by every board on the instance, so a hosted receiver that many boards use (Slack, a SaaS automation service) gets 120 a minute in total, not 120 per board; raise this value for such a receiver. A webhook whose host is at the limit waits for a later run, taking turns with the other webhooks waiting on that host; it is not a failure. `0` turns the limit off. Helm: `backend.settings.webhookHostMaxPerMinute`. *(new in 1.3)* |
| `WEBHOOK_HOST_MAX_CONCURRENCY` | `2` | Deliveries to one destination host in flight at once, across dispatchers. One dispatcher sends one at a time, so this binds only with several (Helm replicas, a loop beside a cron). `0` turns the limit off. Helm: `backend.settings.webhookHostMaxConcurrency`. *(new in 1.3)* |
| `WEBHOOK_LOG_LEVEL` | `INFO` | Level of the `webhooks` logger (dispatcher runs and delivery failures). It logs ids and fixed codes only, never an address or secret. |

Two API throttle scopes bound the endpoints that resolve or contact a destination, per user: `webhook_config` (create, URL change, rotate) at 30/hour and `webhook_test` at 10/hour.

## Instance time zone

| Variable | Description | Default |
|---|---|---|
| `INSTANCE_TIMEZONE` | IANA time zone name (for example `America/Los_Angeles` or `Asia/Tokyo`) that decides what "today" is for the date-based card signals: **overdue** everywhere it shows: the card list filter, the auto health count, and the card face's overdue badge, border, status line and Show chips (the web app reads the zone from `GET /api/v1/auth/site-config/`, so both sides turn a card overdue at the same midnight, *changed in 1.3*, #2313; see [Overdue](../features/board.md#overdue)), the `notify_due_soon` job's due-soon window, and [auto health status](../features/health-status.md). Due dates are plain dates, so without a zone a card turns overdue at midnight UTC. An unknown name stops the server at startup with a clear error rather than falling back to UTC. Does not change timestamps, the scheduler's clock (see [Scheduled jobs](scheduled-jobs.md)) or Django's `TIME_ZONE`. Helm: `backend.settings.instanceTimezone`. *(new in 1.3)* | `UTC` |

Existing installs are unaffected until you set it, with one exception: the card list's `?overdue=` filter used the host's local date (`date.today()`) and now uses the instance zone, so on a host whose own zone is not UTC its day boundary moves to UTC until you set this. After changing it, the next auto health run
(or a board admin's **Recompute now**) applies the new day boundary. Changing it does not move the scheduled jobs: auto health runs at 02:00 UTC by default, which is 18:00 or 19:00 the previous day in Los Angeles and about 11 hours after local midnight in Tokyo, so a card that turns overdue at local midnight is not counted until the next auto run. Also set Helm `scheduledJobs.timeZone` to the same zone, or on Compose move `SCHEDULE_COMPUTE_HEALTH` and `SCHEDULE_NOTIFY_DUE_SOON` to the UTC times just after local midnight and in the local morning. See [Scheduled jobs](scheduled-jobs.md).

## Import limits

| Variable | Description | Default |
|---|---|---|
| `IMPORT_MAX_SIZE_BYTES` | Maximum size, **in bytes**, of a Trello JSON export accepted by the [Trello import wizard](../features/trello-import.md). Oversized uploads get `413`. Separate from `MAX_UPLOAD_SIZE_BYTES`, which caps attachments and native board imports. Helm: `backend.settings.importMaxSizeBytes`. Deprecated alias: `VISIBAN_IMPORT_MAX_SIZE` (see [Deprecated names](#deprecated-environment-variable-names)). *(new in 1.2)* | `26214400` (25 MB) |

**Watch out:** the import runs synchronously inside the request, so every hop in front of
Django must accept a body this large and wait long enough for the board to be
created:

- **Docker Compose nginx** (`nginx/*.conf.template`): `client_max_body_size`
  is `35M` (25 MB + 10 MB multipart headroom). Raise it if you raise
  `IMPORT_MAX_SIZE_BYTES`. `proxy_read_timeout` on `/api/` is `90s`, well
  above the few seconds a capped import takes.
- **Helm**: nginx `client_max_body_size` and the ingress `proxy-body-size`
  annotation are derived automatically from the larger of
  `maxUploadSizeBytes` and `importMaxSizeBytes`.
- **Your own reverse proxy / load balancer**: nginx defaults to a 1 MB body
  limit and returns its own `413` before Visiban sees the request. Allow at
  least `IMPORT_MAX_SIZE_BYTES` + 10 MB.
- The application server (daphne) and the web client set no request timeout
  of their own.

---

## Attachment limits

*(new in 1.3)* Card attachments are capped per file, per card and per user
(#2007). Before 1.3 only the per-file size and the general API rate limit
applied, so one collaborator could fill the media volume for every board on
the instance by uploading in a loop.

| Variable | Description | Default |
|---|---|---|
| `MAX_UPLOAD_SIZE_BYTES` | Largest single attachment, **in bytes**. Also caps native board imports. Helm: `backend.settings.maxUploadSizeBytes`. | `10485760` (10 MB) |
| `ATTACHMENT_MAX_PER_CARD` | Most attachments one card may hold. `0` = no limit. Helm: `backend.settings.attachmentMaxPerCard`. | `100` |
| `ATTACHMENT_MAX_BYTES_PER_CARD` | Most attachment bytes one card may hold, **in bytes**, counting the file being uploaded. `0` = no limit. Helm: `backend.settings.attachmentMaxBytesPerCard`. | `1073741824` (1 GiB) |
| `ATTACHMENT_THROTTLE_UPLOAD_RATE` | Attachment uploads per user, as `<n>/<second\|minute\|hour\|day>`; anything else refuses to start. Counted on top of the general per-user API limit; listing attachments is not counted. Empty = the default. Applies in development (`DEBUG`) too, where the default is otherwise `9999/hour`. Helm: `backend.settings.attachmentUploadRate`. | `120/hour` |

- An upload that would break a per-card quota gets `400` with
  `"code": "attachment_quota_exceeded"` and nothing is stored. An upload over
  the rate limit gets `429` with a `Retry-After` header.
- The defaults are chosen so an existing install keeps working: few cards hold
  anywhere near 100 files. At the default 10 MB file size the count quota is
  reached before the byte quota, which starts to matter when you raise
  `MAX_UPLOAD_SIZE_BYTES`.
- Plain-text and CSV uploads are scanned in full for HTML markup before they
  are stored, so raising `MAX_UPLOAD_SIZE_BYTES` far beyond the default also
  lengthens each such upload request.
- Lowering a quota never deletes anything. A card already over it keeps its
  attachments and accepts new ones only once it is back under the quota.
- Comments and checklist items have their own per-card caps; see
  [Comment and checklist limits](#comment-and-checklist-limits).
- The quota is checked while the card row is locked, so two uploads racing for
  a card's last slot cannot both succeed.
- These quotas bound one card. A user can still spread uploads over many cards,
  which is what the rate limit bounds: at the defaults one account can add at
  most about 1.2 GB an hour. Size the media volume, or lower the rate, with
  that in mind. Turning uploads off entirely is in **Site admin → General**.

---

## Analytics limits

<span class="vb-version" title="Added in 1.3">1.3+</span>

Every Analytics request (the Summary tab, the dwell time heatmap, each `metrics/*`
chart and the MCP flow tools) replays the board's card history in the server
process. Two settings bound that work. Both are per server process, so with
several pods or worker processes the instance-wide figure is that many times
larger. These codes and settings follow the 1.0+ compatibility rules.

| Variable | Description | Default |
|---|---|---|
| `ANALYTICS_MAX_CONCURRENT` | Analytics requests one server process computes at once. A request that finds every slot taken waits up to 8 seconds for one (REST) or is refused at once (MCP) with `503` `analytics_busy` and `Retry-After: 10`. Helm: `backend.settings.analyticsMaxConcurrent`. | `1` |
| `ANALYTICS_MAX_MOVEMENTS` | Card movement rows one Analytics request may hold in memory. A pass that reads rows one card at a time and drops them (the cumulative flow diagram's cards that rest outside the range, and its day drill-down) has a fixed ceiling of four times this instead. A request that needs more is refused with `422` `analytics_too_large`; it is never answered from part of the history. Helm: `backend.settings.analyticsMaxMovements`. | `150000` |

Both must be a whole number of at least 1; blank keeps the default. Unlike the
attachment and comment quotas, `0` does **not** mean "no limit": there is no
off switch, and `0`, a negative number or a non-integer stops the server at
startup with a configuration error.

No account is exempt, site admins included. Each user may also have at most two
Analytics requests running or waiting at once (the Analytics page sends two, one after the other), and
at most four requests wait for a slot per process. In
[demo mode](demo-data.md) every visitor shares one login, so the per-user limit
there is effectively the process-wide one.

### Sizing analytics for your pod

One Analytics request's memory grows with the movement rows it holds, so the
size limit is what bounds it. Rows a pass reads one card at a time and drops
are not held, and are meant to cost CPU time rather than memory; they are
bounded by the fixed ceiling of four times `ANALYTICS_MAX_MOVEMENTS`, so even a
runaway pass ends. Do not read that as a guarantee that such a pass uses little
memory: on a board with years of history, the cumulative-flow `?date=`
drill-down, a streamed pass, peaked far above the estimate below
([#2559](https://gitlab.com/visiban/visiban/-/issues/2559)). Rows are counted as
they are read: a request over a limit is refused once it has read up to that
limit, and holds its slot until then. Size a pod so that:

```
baseline memory + ANALYTICS_MAX_CONCURRENT × (one request's peak at ANALYTICS_MAX_MOVEMENTS) < the pod's memory limit
```

The defaults are a starting point for the chart's default `512Mi` memory and
`500m` CPU limits, to be tuned for each deployment. As a rough estimate (an
illustration, not a measured figure for your data), a request holding close to
the default 150000 rows needs on the order of 150-190 MB above the server's
idle baseline of about 115 MB, more for a longer range and less for a single chart;
at that size `ANALYTICS_MAX_CONCURRENT=1` leaves headroom for the rest of the
process's work under `512Mi`. Measure your
own peak (the `analytics.replay` log line reports each request's `movements`
held and `streamed`) before raising either setting.

**Yes, but:** that estimate does not hold for a board with years of history. On a
board with 11,990 active and 143,880 archived cards (about 3 years), one
cumulative-flow `?date=` drill-down (218,843 streamed rows) peaked at 678-720 MB
of process memory, with `ANALYTICS_MAX_CONCURRENT=1` and the default
`ANALYTICS_MAX_MOVEMENTS`. A `512Mi` limit is too small for a board of that age.
See [Backend memory and CPU sizing](#backend-memory-and-cpu-sizing).

The baseline in the formula is not only idle memory: `daphne` keeps its
high-water mark after a burst of Analytics requests, so a process that has
already served one heavy request starts the next one higher (see
[Backend memory and CPU sizing](#backend-memory-and-cpu-sizing) for the
measured peaks, the suggested memory tiers and the restart options). Leave
headroom above that, not just above idle.

Raise `ANALYTICS_MAX_MOVEMENTS` (and the pod's memory limit with it, using the
tiers in [Backend memory and CPU sizing](#backend-memory-and-cpu-sizing)) when a
board's Analytics page says the board has more history than the server is set up to analyze.

The slot count bounds how much analytics work and memory a process takes on at
once. It does not guarantee how fast the rest of the server answers while a
request is running: analytics shares the process's CPU with everything else, so
other requests can still slow down during a long replay.

Raise `ANALYTICS_MAX_CONCURRENT` only with more CPU and memory per pod: analytics is
CPU-bound, so two requests at once in one process take about twice as long
each. A request waiting for a slot uses a database connection, so with
connection pooling on keep `ANALYTICS_MAX_CONCURRENT` + 4 (the waiting
requests) well under `DATABASE_POOL_MAX_SIZE`.

One open of the Analytics page sends its two requests one after the other
(the overview first, then the heatmap), so the second waits for the first to
finish and the page's two requests never compete for the same slot. A request
that waits more than 8 seconds for a slot is refused and retried once by the web
app after `Retry-After`. A "busy" message therefore means another request,
yours in another tab or another user's, held the slot beyond that wait. On boards
whose Analytics takes longer than that, or when several people or tabs open
Analytics at once, expect a "busy" message, and raise `ANALYTICS_MAX_CONCURRENT`
together with the pod's CPU and memory.

---

## Comment and checklist limits

*New in 1.3 (#2376).* One card's comments and checklist items are capped, so
a single member (or a leaked API token) cannot grow one card without bound,
and with it the card detail response and every change-feed event that copies
the card.

| Variable | Description | Default |
|---|---|---|
| `COMMENT_MAX_PER_CARD` | Most comments one card may hold. `0` = no limit. Helm: `backend.settings.commentMaxPerCard`. | `1000` |
| `CHECKLIST_MAX_ITEMS_PER_CARD` | Most checklist items one card may hold. `0` = no limit. Helm: `backend.settings.checklistMaxItemsPerCard`. | `500` |

- A comment or checklist item past its cap gets `400` with
  `"code": "comment_quota_exceeded"` or `"code": "checklist_quota_exceeded"`
  and a readable `detail`, which the card detail panel shows; nothing is stored.
- The defaults are far above normal use, so an existing install keeps working.
  A negative value refuses to start.
- Lowering a cap never deletes anything. A card already over it keeps its rows
  and accepts new ones only once it is back under the cap.
- The count is checked while the card row is locked, so two creates racing for
  a card's last slot cannot both succeed.
- Board import (Visiban JSON and Trello) is not capped: it fills a board it is
  creating, bounded by the import size limit.
- Django admin adds of comments and checklist items are not capped (site
  admins only).
- There is no per-board or instance-wide byte budget for comments, checklist
  items or descriptions yet (tracked in #2418).

## Card link write limit

*(new in 1.3)* Linking a card to a parent on another board, adding a child
card to a parent (Add child), and removing a link from either end, share a per-user rate limit (#2383). Each link write
records history on two cards and notifies two boards, so the general per-user
API limit alone let one account churn links thousands of times an hour.

| Variable | Description | Default |
|---|---|---|
| `CARD_LINK_THROTTLE_WRITE_RATE` | Card link writes per user (link, Add child, child-side unlink, parent-side unlink together), as `<n>/<second\|minute\|hour\|day>`; anything else refuses to start. Counted on top of the general per-user API limit; reading a card's children is not counted. Empty = the default. Applies in development (`DEBUG`) too, where the default is otherwise `9999/hour`. Helm: `backend.settings.cardLinkWriteRate`. | `300/hour` |

A write over the limit gets `429` with a `Retry-After` header and changes
nothing. 300 an hour fills a parent to its 100-child cap three times over, so
the default only refuses scripted churn.

---

## Email (SMTP)

Visiban uses Django's email backend for password resets, email verification and — since 1.2 — [notification email](../features/notifications.md#email-notifications).

There are two ways to configure it, and **exactly one of them is in effect at a time**.
Settings are never merged across the two:

1. **Environment variables** (below): the default, unchanged from earlier releases.
2. **The admin UI** — *new in 1.2.* **Site admin → Email** stores the same settings in the database, so you can configure and test SMTP without shell access or a restart. See [Configuring SMTP from the admin UI](#configuring-smtp-from-the-admin-ui).

**Yes, but:** an instance uses environment variables until an admin explicitly switches the source to the stored configuration, so **upgrading changes nothing** about how your instance sends mail.

### Environment variables

Configure these in `.env` (Docker Compose) or as environment variables in your Helm values:

| Variable | Description | Default |
|---|---|---|
| `EMAIL_BACKEND` | Django email backend class. Setting this explicitly pins the backend and **disables** the admin-UI configuration entirely. | *(unset — uses the source selected in the admin UI, falling back to these variables)* |
| `EMAIL_HOST` | SMTP server hostname | `localhost` |
| `EMAIL_PORT` | SMTP server port | `587` |
| `EMAIL_HOST_USER` | SMTP authentication username | *(empty — no auth)* |
| `EMAIL_HOST_PASSWORD` | SMTP authentication password | *(empty)* |
| `EMAIL_USE_TLS` | Use STARTTLS | `true` |
| `EMAIL_USE_SSL` | Use implicit TLS/SSL. Mutually exclusive with `EMAIL_USE_TLS`. *(new in 1.2)* | `false` |
| `EMAIL_TIMEOUT` | SMTP socket timeout, in seconds. *(new in 1.2)* | `10` |
| `NOTIFICATION_EMAIL_ENABLED` | Master switch for outbound **notification** email. Set to `false` to stop notification mail instance-wide without touching per-user preferences. Password resets and email verification are unaffected — silencing notifications must not lock anyone out of account recovery. *(new in 1.2)* | `true` |
| `NOTIFICATION_EMAIL_TIMEOUT` | Socket timeout floor, in seconds, for notification email only. Notification mail is sent from the card-mutation path, so an unreachable SMTP host would otherwise hang a worker; this bounds it. Applied only when neither `EMAIL_TIMEOUT` nor the admin-UI timeout is set, so a timeout you configured is never overridden. *(new in 1.2)* | `10` |
| `NOTIFICATION_EMAIL_ASYNC` | Send notification mail from a background thread rather than inline on the request. Keeps a slow or unreachable SMTP host from making card actions appear to hang, at the cost of delivery being best-effort — recycling a worker mid-send drops that batch. Set to `false` to send inline. *(new in 1.2)* | `true` |
| `INVITE_EMAIL_ENABLED` | Lets group admins and site admins send invite links straight to an email address instead of copying them. Set to `false` to remove the option instance-wide; the send endpoints then return `403` with `code: "invite_email_disabled"`. Always off when `DEMO_MODE` is on. Uses the same mail configuration as everything else, with `NOTIFICATION_EMAIL_TIMEOUT` as its socket timeout floor. Rate limits (fixed, not configurable): 10 sends/hour per admin, 30/day per group, 200/day instance-wide for group invites, and a separate 200/day instance-wide budget for site-admin invites (throttle scope `invite_email_global_site`) so group admins cannot use up the site admins' allowance. Refused or failed sends don't count. The counters live in the Django cache: on a multi-worker or multi-replica deployment the limits hold only when every worker uses the shared Valkey/Redis cache (`REDIS_CACHE_URL`); with a per-process cache each worker counts separately. *(new in 1.2)* | `true` |
| `DEFAULT_FROM_EMAIL` | Sender address for outgoing emails | `noreply@example.com` |
| `VISIBAN_SECRET_ENCRYPTION_KEY` | Optional dedicated key for secrets stored at rest. *(new in 1.2)* See [Secret rotation](secret-rotation.md#visiban_secret_encryption_key). | *(empty — derived from `DJANGO_SECRET_KEY`)* |

### Example: Gmail / Google Workspace

```bash
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_HOST_USER=noreply@yourdomain.com
EMAIL_HOST_PASSWORD=your-app-password
EMAIL_USE_TLS=true
DEFAULT_FROM_EMAIL=noreply@yourdomain.com
```

### Example: Amazon SES

```bash
EMAIL_HOST=email-smtp.us-east-1.amazonaws.com
EMAIL_PORT=587
EMAIL_HOST_USER=AKIAIOSFODNN7EXAMPLE
EMAIL_HOST_PASSWORD=your-ses-smtp-password
EMAIL_USE_TLS=true
DEFAULT_FROM_EMAIL=noreply@yourdomain.com
```

### Console backend (development)

To print emails to stdout instead of sending them (useful for development):

```bash
EMAIL_BACKEND=django.core.mail.backends.console.EmailBackend
```

!!! note
    The default value of `EMAIL_VERIFICATION` is `optional`, which sends a verification email on signup but allows login without verifying. SMTP should be configured so that verification emails are delivered. Set `EMAIL_VERIFICATION=none` to disable verification emails entirely (no SMTP needed). The old alias `ACCOUNT_EMAIL_VERIFICATION` was removed in 1.1 — only `EMAIL_VERIFICATION` is read.

    *(Changed in 1.2)* With `EMAIL_VERIFICATION=mandatory`, a registration for an address that is already in use gets the same response as any other registration, and the address is emailed a notice instead of a confirmation link. With `optional` or `none` it is refused with an error, because a new registration is signed in straight away in those modes. See [Registration](../api/authentication.md#an-address-that-is-already-in-use).

### Configuring SMTP from the admin UI

> **Added in 1.2**

*(1.3+)* A superuser can configure outbound email from **Site admin → Email** without shell access or a container restart, which suits managed and cloud deployments.

1. Fill in the server, port, sender address, and credentials.
2. Switch **Configuration source** to **Stored in this admin UI**.
3. Click **Send test email**. The test is delivered to your own account's email address.

Changes take effect on the next email sent — there is no restart and no cache to wait for.

**How the two sources interact:**

- **All-or-nothing.** With *stored configuration*, every value comes from the database; with *environment variables*, every value comes from the environment. A single setting is never taken from the other source.
- **Incomplete forms are harmless.** You cannot switch to the stored configuration until it has at minimum a host and a sender address (plus a password if you set a username). A partly-filled form stays a draft and your existing configuration keeps working.
- **Setting `EMAIL_BACKEND` explicitly overrides both.** If you pin it (to a third-party relay, or the console backend in development), Visiban honors it and ignores the stored configuration entirely. The admin page says so.

**Password storage.** The SMTP password is encrypted at rest and never returned by the API. By default the key is derived from `DJANGO_SECRET_KEY`, so **rotating that key makes a stored password unrecoverable** and you must re-enter it. To decouple the two, set `VISIBAN_SECRET_ENCRYPTION_KEY` before storing a password; see [Secret rotation](secret-rotation.md#visiban_secret_encryption_key).

!!! warning "The test button connects to whatever host you enter"
    **Send test email** opens an outbound SMTP connection from the Visiban backend to
    the host and port in the form, including internal addresses the backend can reach
    but you cannot. It is a site-admin-only capability with real network reach, so grant
    `is_site_admin` accordingly. The action is limited to 5 attempts per hour per admin,
    always delivers to the requesting admin's own address, and every server change is
    recorded in the [admin action log](../api/admin.md#action-log).

!!! note "Notification email is off per user, not per instance"
    Configuring SMTP does not start notification email. Every per-user email preference
    defaults to **off**, so an instance with working SMTP mails nobody until a user opts in
    under **Settings → Notifications**. Set `NOTIFICATION_EMAIL_ENABLED=false` to guarantee
    no notification mail leaves the instance whatever users have chosen. See
    [Email notifications](../features/notifications.md#email-notifications).

!!! note "Sender address placeholder"
    Visiban refuses to send mail from the shipped `noreply@example.com` placeholder. Earlier
    releases checked at startup, so a production instance would not boot until
    `DEFAULT_FROM_EMAIL` was set. Since 1.2 the check happens when mail is sent (and on save
    in the admin UI), so an instance can boot and be configured entirely through the UI.
    Startup logs a warning instead, and outbound mail is refused with a clear error until a
    real sender address is set, by either method.

---

## Demo mode

> **Added in 1.2** — for public demo instances only.

Demo mode turns an instance into a public, shared demo: a one-click "Explore the demo" sign-in with a published account, an in-app countdown to the next reset, and a deny-by-default write fence that refuses every change except creating, editing and moving cards. It is **off by default**; existing installs are unaffected.

| Variable | Default | Description |
|---|---|---|
| `DEMO_MODE` | `false` | Arm demo mode and its write fence. Parsed strictly: an unrecognized value such as `ture` refuses to start rather than silently leaving the fence off. |
| `DEMO_LOGIN_USERNAME` | `visitor` | The **published** account. `seed_demo_data --demo-site` creates it as a non-admin member on every seeded board. Must not be `admin`, `maya` or `jordan`. |
| `DEMO_LOGIN_PASSWORD` | *(empty)* | Password of the published account, shown on the login page. With no value no credential is shown. |
| `DEMO_ADMIN_PASSWORD` | *(empty)* | Password of the seeded site admin (`admin`). **Never published**, and must differ from `DEMO_LOGIN_PASSWORD`. Required by `seed_demo_data --demo-site`. |
| `DEMO_MEMBER_PASSWORD` | *(empty)* | Password for the two seeded member accounts. Never published. Required by `seed_demo_data --demo-site`. |
| `DEMO_RESET_SCHEDULE` | `0 * * * *` | Cron expression (UTC) of the reset job. Drives the countdown on the login page and in the app. Only minute and hour fields are evaluated; the other three must be `*`. An expression the backend cannot evaluate refuses to start while `DEMO_MODE` is on. Set but **empty** means no reset is scheduled: the login page and the demo bar then promise no reset and show no countdown. The Helm chart renders it empty when `demo.reset.enabled` is false. |
| `DEMO_THROTTLE_USER_RATE` | *(empty)* | Replaces the rate of the `user` throttle scope while `DEMO_MODE` is on, e.g. `60000/hour`. Every visitor signs in as the one published account, so this scope is a single budget shared by all of them. Format `<n>/<second\|minute\|hour\|day>`; anything else refuses to start. Ignored when `DEMO_MODE` is off. Deprecated alias: `DEMO_USER_THROTTLE_RATE` (see [Deprecated names](#deprecated-environment-variable-names)). |

If `DEMO_LOGIN_USERNAME` or `DEMO_LOGIN_PASSWORD` is set while `DEMO_MODE` is off, startup logs a warning: nothing is published, but the fence is not armed either.

!!! danger "The credentials are public by design"
    When `DEMO_MODE` is on, `DEMO_LOGIN_USERNAME` and `DEMO_LOGIN_PASSWORD` are returned to anyone by `GET /api/v1/auth/site-config/`. Enable it only on a dedicated, throwaway instance with its own database, no SSO or real SMTP, and a scheduled reset. Never enable it on an instance with real data.

See [Demo data](demo-data.md#hosted-demo-instance) for seeding, and [Public demo mode](demo-data.md#public-demo-mode-helm) for the Helm deployment that sets all of these.

## Variables documented on other pages

These variables are set in the same `.env` file but are explained where they matter. Each row links to the authoritative page, which holds the default and the full behavior.

| Variable | What it controls | Details |
|---|---|---|
| `FRONTEND_URL` | Full URL of the SPA. allauth redirects here after OAuth login and logout. Must be set in production. | [Installation](../getting-started/installation.md#environment-variables) |
| `SITE_DOMAIN` | Public hostname for OAuth callback URLs. Re-synced to the Sites framework on every backend start. | [Installation](../getting-started/installation.md#environment-variables), [First boot](../getting-started/first-boot.md) |
| `FORCE_INSECURE_COOKIES` | Turns off secure session and CSRF cookies for plain-HTTP deployments. `init-prod.sh` sets it with `TLS_MODE=none`. | [Installation](../getting-started/installation.md#environment-variables) |
| `SECURE_HSTS_SECONDS` | `Strict-Transport-Security` max-age. In the production Compose stack it also drives the nginx header. | [Installation](../getting-started/installation.md#environment-variables) |
| `DJANGO_ADMIN_ALLOWED_IPS` | IPs and CIDR ranges allowed to reach `/admin/`. Production default is loopback only. | [Installation](../getting-started/installation.md#environment-variables), [Secret rotation](secret-rotation.md) |
| `USE_X_ACCEL_REDIRECT` | How `/media/` downloads are delivered after the board-membership check. | [Media security](media-security.md) |
| `BOARD_EVENT_RETENTION_DAYS` (default `30`), `NOTIFICATION_RETENTION_DAYS` (default `90`, minimum `14`) | Retention windows for the board change feed and in-app notifications. Enforced only when the matching prune job is scheduled. | [Scheduled jobs](scheduled-jobs.md) |
| `SHARE_BOARD_CACHE_TTL_SECONDS` (default `15`) | How long, in seconds, the anonymous [share-link](../features/board.md#board-sharing) board view is cached. `0` turns the cache off. Revoking, rotating, expiring or deactivating a link is never delayed by it. Must be a whole number (a non-numeric value fails at startup); a negative value also turns the cache off. Helm: `backend.settings.shareBoardCacheTtlSeconds`. *(1.3+, #1965)* | [Board sharing](../features/board.md#board-sharing) |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SERVER_URL`, `OIDC_PROVIDER_NAME` | Generic OIDC single sign-on. Set the first three together to enable it; the provider name labels the login button (default `SSO`). | [OAuth and SSO](../getting-started/oauth.md), [Authentication](authentication.md) |
| `DJANGO_SUPERUSER_USERNAME`, `DJANGO_SUPERUSER_EMAIL` | Override the bootstrap site admin's username and email. | [First boot](../getting-started/first-boot.md) |
| `VISIBAN_ADMIN_PASSWORD_FILE` | Where the generated bootstrap admin password is written (default `/tmp/visiban_admin_password`). | [First boot](../getting-started/first-boot.md) |

## Health check endpoints

The backend exposes two health check endpoints for use by load balancers, monitoring systems, and Kubernetes probes:

| Endpoint | Method | Purpose | Checks | Success |
|---|---|---|---|---|
| `/api/health/liveness/` | GET | Is the process alive? | ASGI server responds | `200 {"status": "ok"}` |
| `/api/health/readiness/` | GET | Can the process serve traffic? | Database reachable; a Valkey outage reports `degraded` with HTTP 200 | `200 {"status": "ok"}` |

Both endpoints are unauthenticated and do not require a valid `Host` header.

**Docker Compose** uses the liveness endpoint in the backend healthcheck. **Helm** uses both: liveness probe hits `/api/health/liveness/`, readiness probe hits `/api/health/readiness/`.

**Tip:** for external load balancers (AWS ALB, HAProxy, etc.), point the health check at `/api/health/readiness/` on the backend port (8000), so traffic reaches only instances with a working database connection. A Valkey outage does not fail this check: it answers `200 {"status": "degraded"}` (see [If Valkey goes down](#if-valkey-goes-down)). A load balancer that must also avoid a Valkey outage has to match `"status":"ok"` in the body.

---

## Deprecated environment variable names

Once an environment variable name has shipped, it keeps working. When a name is changed, the old one stays as a **deprecated alias**.

- **How it behaves:** the alias is still read, and setting it logs a startup warning naming its replacement.
- **How long:** each alias works for at least one minor release after its deprecation, and its removal is announced in the [upgrade guide](upgrade.md) first.
- **If both names are set,** the new name wins whenever it has a non-empty value. An install that sets only the old name behaves exactly as before.

**Watch out:** the Helm chart sets the new names, so it needs a backend image from the same release. See the [1.2 upgrade notes](upgrade.md#upgrading-to-12x).

| Deprecated name | Use instead | Deprecated in | Notes |
|---|---|---|---|
| `VISIBAN_IMPORT_MAX_SIZE` | `IMPORT_MAX_SIZE_BYTES` | 1.2 | Shipped in 1.2 pre-releases. Renamed to match `MAX_UPLOAD_SIZE_BYTES`. The Helm key `backend.settings.importMaxSizeBytes` is unchanged. |
| `DEMO_USER_THROTTLE_RATE` | `DEMO_THROTTLE_USER_RATE` | 1.2 | Shipped in 1.2 pre-releases. Renamed to match `MCP_THROTTLE_*_RATE` and the Helm key `demo.throttle.userRate`, which is unchanged. |
| `VISIBAN_MIGRATE_CONNECT_TIMEOUT` | `MIGRATE_CONNECT_TIMEOUT_SECONDS` | 1.2 | Shipped in 1.2 pre-releases. Read by `manage.py migrate_with_lock`, the Helm chart's `migrate` init container. The Helm key `backend.migrate.connectTimeout` is unchanged. |
| `VISIBAN_MIGRATE_LOCK_TIMEOUT` | `MIGRATE_LOCK_TIMEOUT_SECONDS` | 1.2 | Shipped in 1.2 pre-releases. Read by `manage.py migrate_with_lock`. The Helm key `backend.migrate.lockTimeout` is unchanged. |

Names removed in earlier releases (`OIDC_SECRET` and `ACCOUNT_EMAIL_VERIFICATION`, both
removed in 1.1) are listed in the [1.1 upgrade notes](upgrade.md#upgrading-to-11x).
