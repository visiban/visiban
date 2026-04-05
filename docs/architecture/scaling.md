# Scaling

This page describes how each component of the Visiban stack scales, what the practical ceilings are on a single server, and what to change — and when — as load grows.

!!! note "Managed hosting"
    Managed Visiban hosting (multi-tenant, globally distributed) is an enterprise feature. This page covers self-hosted deployments: a single team or organisation running their own instance. The architecture is the same; the operational responsibility is yours.

---

## The single-server baseline

The default Docker Compose stack runs all services on one machine:

```
Internet → Nginx → daphne (ASGI) → PostgreSQL
                               ↘ Redis (channel layer)
                               ↘ Local disk (attachments)
```

**Practical ceiling for a single server (4 vCPU / 8 GB RAM):**

| Metric | Comfortable | Approaching limit |
|---|---|---|
| Active users (daily) | < 500 | > 1 000 |
| Concurrent open boards | < 100 | > 200 |
| Simultaneous WebSocket connections | < 300 | > 600 |
| Boards | < 1 000 | > 5 000 |
| Cards (total across all boards) | < 500 000 | > 2 000 000 |
| Attachment storage | < 100 GB | Disk-dependent |

A well-tuned 8 vCPU / 16 GB server comfortably doubles these numbers. The bottleneck on a single server is almost always **concurrent REST requests** (synchronous daphne workers), not memory or the database.

---

## Component-by-component guide

### Application server (daphne / ASGI)

Daphne is an ASGI server that handles both HTTP requests and WebSocket connections in a single process. WebSocket connections are handled asynchronously (coroutines); REST API requests are also async-capable but go through synchronous Django views today.

**What limits it:**
The REST views are synchronous. Under high concurrent HTTP load, requests queue behind each other. Symptoms: rising p95 latency on the card list and board endpoints before the database shows any stress.

**How to tune before scaling out:**

```bash
# Increase daphne worker count in docker-compose.yml or Helm values
command: daphne -b 0.0.0.0 -p 8000 --verbosity 1 -u /tmp/daphne.sock visiban.asgi:application
```

For production, run daphne behind Nginx and increase `--workers` or switch to `uvicorn` with multiple workers:

```
uvicorn visiban.asgi:application --workers 8 --host 0.0.0.0 --port 8000
```

A good starting point: `(2 × vCPU) + 1` workers.

**How to scale out (horizontal):**
Run multiple backend replicas behind a load balancer. Requirements before doing this:

1. **Attachment storage must be on S3/GCS** — local disk is not shared between replicas; see [Attachment storage](#attachment-storage) below.
2. **Redis is already required** — the channel layer (WebSocket pub/sub) uses Redis; this is already in the default stack.
3. **Sticky sessions are not required** — WebSocket subscriptions use Django Channels group names keyed by board ID; any replica can handle any connection.
4. **Database connections** — each replica opens its own connection pool. Add pgBouncer if the total connection count approaches PostgreSQL's `max_connections` (default 100).

**Kubernetes:** The Helm chart supports `backend.replicaCount`. Set it to 2+ and ensure the `externalDatabase` and `externalRedis` values point to shared instances (not the bundled in-cluster pods, which are single-replica by default).

**When to act:** When p95 HTTP response time on `/api/v1/boards/{id}/cards/` exceeds 300 ms under normal load, or when CPU is consistently above 70% during business hours.

---

### PostgreSQL

PostgreSQL handles all persistent state: boards, cards, movements, memberships, comments, attachments metadata, and notifications.

**What limits it:**
Write throughput (card moves, comment creates, WebSocket broadcasts trigger writes via `CardMovement`). Read throughput is less of a concern because the query budgets are tight (≤ 20 queries for full board load) and the ORM uses `select_related`/`prefetch_related` throughout.

**Connection count:** Each daphne/uvicorn worker opens a persistent connection. With 4 workers per replica and 3 replicas, you need ~12 connections minimum plus headroom. PostgreSQL's default `max_connections = 100` is fine for small deployments; large deployments should add pgBouncer.

**How to tune before scaling out:**

```sql
-- Check connection usage
SELECT count(*) FROM pg_stat_activity;

-- Increase max_connections (requires restart)
-- Set in postgresql.conf or via Helm: postgresql.primary.extraEnvVars
max_connections = 200
shared_buffers = 256MB   -- 25% of RAM is a common starting point
effective_cache_size = 1GB
```

**Connection pooling (pgBouncer):**
Add pgBouncer in transaction-mode pooling between the application and PostgreSQL. This is the first step when connection count becomes a concern, before adding a read replica.

```yaml
# docker-compose.yml addition
pgbouncer:
  image: edoburu/pgbouncer
  environment:
    DATABASE_URL: postgresql://visiban:password@db:5432/visiban
    POOL_MODE: transaction
    MAX_CLIENT_CONN: 200
    DEFAULT_POOL_SIZE: 20
```

**Read replica:**
Analytics queries (the dwell-time heatmap, summary endpoint, stalled-cards list) are read-heavy. Route them to a read replica by adding a `DATABASES["analytics"]` entry in `settings.py` and using `queryset.using("analytics")` in the analytics ViewSet. This is not required until the analytics endpoint measurably impacts write latency on the primary.

**When to act:**
- Add pgBouncer when connection count regularly exceeds 80% of `max_connections`
- Vertical scale (more CPU/RAM) before a read replica — PostgreSQL scales well vertically
- Add a read replica when analytics queries start affecting p95 write latency (observable via `pg_stat_activity` slow query logging)

---

### Redis

Redis serves two roles: the Django Channels channel layer (WebSocket pub/sub) and the registration-mode cache.

**What limits it:**
Redis is single-threaded per core. The channel layer publish/subscribe pattern means every board mutation triggers one `PUBLISH` and N `SUBSCRIBE` deliveries (one per connected WebSocket client on that board). At 50 users on a single board, that is 50 message deliveries per card move.

**How to tune:**
Redis is rarely the bottleneck for team-scale deployments. The default single-node Redis handles tens of thousands of pub/sub messages per second. No action required until you see Redis CPU above 80%.

**Redis Cluster / Sentinel:**
For high availability, use Redis Sentinel (managed failover) or Redis Cluster (horizontal sharding). Configure via `CHANNEL_LAYERS`:

```python
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [
                {"host": "redis-sentinel-1", "port": 26379},
                {"host": "redis-sentinel-2", "port": 26379},
            ],
            "master_name": "visiban-master",
        },
    }
}
```

**When to act:** When Redis CPU is consistently above 60% during peak hours, or when you require HA with automatic failover (Sentinel). Redis Cluster adds complexity without benefit until you have millions of pub/sub events per minute.

---

### Attachment storage

**This is the one hard blocker for horizontal scaling.**

The default configuration stores uploaded files on the container's local filesystem (`MEDIA_ROOT`). If you run two backend replicas, each has its own local disk — files uploaded via replica A are invisible to replica B.

**Before adding a second backend replica, migrate attachments to S3 (or any S3-compatible store — MinIO, Cloudflare R2, Backblaze B2):**

```python
# settings.py — add django-storages
DEFAULT_FILE_STORAGE = "storages.backends.s3boto3.S3Boto3Storage"
AWS_STORAGE_BUCKET_NAME = env("AWS_STORAGE_BUCKET_NAME")
AWS_S3_ENDPOINT_URL = env("AWS_S3_ENDPOINT_URL", default=None)  # For MinIO / R2
AWS_S3_FILE_OVERWRITE = False
AWS_DEFAULT_ACL = None  # Private by default
```

```bash
pip install django-storages boto3
```

Existing attachments on local disk must be migrated to S3 before switching. Use `aws s3 sync` or equivalent.

**MinIO for self-hosters who want S3 compatibility without AWS:**

```yaml
# docker-compose.yml addition
minio:
  image: minio/minio
  command: server /data --console-address ":9001"
  environment:
    MINIO_ROOT_USER: visiban
    MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
  volumes:
    - minio_data:/data
```

**When to act:** Before adding a second backend replica. There is no workaround — shared filesystem (NFS) is an alternative but significantly slower and operationally complex compared to S3.

---

### Static assets (Nginx / CDN)

Static assets (the compiled React frontend, fonts, icons) are served by WhiteNoise from the Django/daphne process. WhiteNoise is efficient and appropriate for single-server deployments — it serves pre-compressed files from memory.

**For multi-region or high-traffic deployments**, offload static assets to a CDN:

1. Run `python manage.py collectstatic` to collect assets to `STATIC_ROOT`
2. Upload `STATIC_ROOT` to a CDN bucket (S3 + CloudFront, R2 + Cloudflare, etc.)
3. Set `STATIC_URL` to the CDN base URL

```python
STATIC_URL = "https://cdn.example.com/static/"
STORAGES["staticfiles"]["BACKEND"] = "storages.backends.s3boto3.S3StaticStorage"
```

Disable WhiteNoise once the CDN is serving static files.

**When to act:** When static asset requests are a measurable share of backend CPU, or when you have users in multiple geographic regions and need lower latency for the initial page load. Not required for single-region deployments.

---

### Nginx (reverse proxy / load balancer)

Nginx is the entry point in both the Docker Compose and Kubernetes stacks. In a single-server deployment it terminates TLS and proxies to daphne. For horizontal scaling it also load-balances across backend replicas.

**WebSocket handling — critical configuration:**
Nginx must forward `Upgrade` and `Connection` headers for WebSockets to work:

```nginx
location /ws/ {
    proxy_pass http://backend;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;  # Keep WebSocket connections alive
}
```

**Multi-replica upstream:**

```nginx
upstream backend {
    least_conn;  # Route to the replica with fewest active connections
    server backend-1:8000;
    server backend-2:8000;
    server backend-3:8000;
}
```

`least_conn` is preferred over round-robin because WebSocket connections are long-lived — round-robin would accumulate all WebSocket connections on the first server reached.

---

## Scaling sequence

Scale components in this order. Each step resolves the typical bottleneck before it becomes a problem.

| Step | When | What to do |
|---|---|---|
| **1. Tune workers** | p95 REST > 300 ms | Increase daphne/uvicorn worker count |
| **2. Vertical scale** | CPU > 70% sustained | Larger instance (vCPU + RAM) |
| **3. Migrate to S3** | Before step 4 | Move attachments off local disk |
| **4. Add pgBouncer** | DB connections > 80% of `max_connections` | Connection pooling in front of PostgreSQL |
| **5. Add backend replicas** | After steps 3–4 | `backend.replicaCount: 2+` in Helm |
| **6. PostgreSQL read replica** | Analytics queries affecting write latency | Route analytics ViewSet to replica |
| **7. Redis HA** | Redis CPU > 60% or availability SLA | Sentinel or Cluster |
| **8. CDN for static** | Multi-region users or high static asset CPU | CloudFront / R2 / Fastly |

Steps 1–2 are operational changes with no code. Steps 3–8 require configuration changes and, for step 6, a small code change to route queries.

---

## What does not scale linearly

- **Board-scoped WebSocket groups** — every user on the same board shares one Redis channel group. 100 users on one board means 100 deliveries per card move. This is by design; it does not degrade other boards.
- **The `/api/v1/boards/{id}/full/` endpoint** — returns the full board state in one request. At the 500-card import limit, this is a large payload. If teams consistently hit this size, consider paginating card loads rather than scaling infrastructure — it's a product decision.
- **`CardMovement` table growth** — every card move and card creation writes a row. On active boards over months, this table grows. Archiving old boards reclaims logical space; a periodic vacuum handles physical space. This is not a problem at team scale but worth noting for multi-year deployments.
