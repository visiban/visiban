# Probe Visiban's health with two unauthenticated GETs

Point your liveness probe at `/api/health/liveness/` and your readiness probe at `/api/health/readiness/`.

```bash
curl -i http://localhost:8000/api/health/readiness/   # 200 {"status": "ok"}, 200 {"status": "degraded"} if only Valkey is down, 503 if the database is down
```

**Why it matters:** the two probes answer different questions. A failed liveness probe means restart the container; a failed readiness probe means stop sending it traffic.

**The big picture:** two unauthenticated endpoints for liveness and readiness probes — usable with Kubernetes, Docker Compose `healthcheck` directives, or any uptime monitoring tool.

**By the numbers:**

| Endpoint | Checks | Success | Failure |
|---|---|---|---|
| `GET /api/health/liveness/` | Process is running; no external checks | `200` | Restart the container |
| `GET /api/health/readiness/` | Database reachable (Valkey is reported, not required) | `200` | `503`; withhold traffic |

**Go deeper:** the [Kubernetes example](#kubernetes-example) has both probes ready to paste.

## `GET /api/health/liveness/`

Returns `200 OK` if the process is running. No authentication required. No external checks performed.

**Response**
```json
{"status": "ok"}
```

Use this as a **liveness probe** — if it fails, the container should be restarted.

---

## `GET /api/health/readiness/`

Returns `200 OK` while the database is reachable. No authentication required. A Valkey outage does not fail readiness (see below).

**Response — healthy**
```json
{"status": "ok"}
```

**Response — Valkey down** (`200 OK`)
```json
{"status": "degraded"}
```

Valkey backs realtime updates and the cache. With it down the database is fine, so the pod stays ready instead of every pod leaving the Service at once *(1.3+, [#1465](https://gitlab.com/visiban/visiban/-/issues/1465))*. The body names no component; the server log carries `Readiness degraded: cache`. Alert on that log line or on Valkey's own metrics, not on the probe.

**What works while Valkey is down** *(1.3+)*. Each cache call gives up after `REDIS_CACHE_SOCKET_TIMEOUT` / `REDIS_CACHE_SOCKET_CONNECT_TIMEOUT` (0.5 s by default), so this holds whether Valkey refuses connections or silently drops them:

- **Ordinary REST requests succeed.** The global `anon` (300/hour) and `user` (5000/hour) rate limits **fail open**: they cannot read their counters, so they let the request through and are not enforced until Valkey returns. Maintenance mode, the registration mode and the uploads toggle are read from the database instead of the cache, so they keep their real values.
- **The Git lens board fails closed** *(experimental, `GIT_LENS_ENABLED`)*: `GET /api/v1/git-lens/board/{board_id}/` returns `503` with `code: "lens_unavailable"` and makes no request to GitHub or GitLab until Valkey returns. Its per-user fetch budgets, refresh cooldown and fetch lock live in Valkey, so it cannot fetch without them and has no cached copy to serve.
- **Endpoints with their own security rate limit fail closed** and return `500` until Valkey returns: login (including the failed-login lockout), registration, password change and reset, user search, invite-link redemption, share-link reads, and the other named limits in `DEFAULT_THROTTLE_RATES`. These limits exist to stop brute force and enumeration, so they are never silently lifted. With the default database session engine, signed-in users keep their sessions; with `SESSION_ENGINE` set to the cache-only engine, session requests return a retryable `503` until Valkey returns, and nobody is signed out.
- **Realtime board updates stop**, and WebSocket connections cannot be opened, until Valkey returns.

The server log carries one `Cache unreachable (...)` warning per affected component per minute per process while the outage lasts.

**Response — not ready** (`503 Service Unavailable`)
```json
{
  "status": "error",
  "errors": {
    "db": "unavailable"
  }
}
```

Only the database can fail readiness, so `db` is the only key that appears in `errors`, with the fixed value `unavailable`. (Before 1.3 a Valkey failure returned `503` with a `redis` key; it now returns the `200` `degraded` response above.) Failure details are written to the server log, not the response. Use this as a **readiness probe** — traffic should not be routed to the instance until it returns `200`.

!!! warning "Deprecated *(1.3+)*: the `errors` object"
    The `errors` object is deprecated. It is still returned, with its `db` key, on every `503` for all of 1.x, but it names the backing services to anonymous callers, so it is planned for removal in 2.0 ([#1902](https://gitlab.com/visiban/visiban/-/issues/1902)). After that the not-ready body is `{"status": "error"}` only. The `redis` key no longer appears from 1.3, because a Valkey failure no longer fails readiness (see above).

    Decide readiness from the HTTP status code (`200` or `503`), or from `status`. The Helm probes, the Helm test hook, and the deploy drills already read only those. If an external monitor or load balancer parses `errors`, switch it to the status code before upgrading to 2.0. Which component failed is in the server log (`Readiness check failed: database` or `Readiness degraded: cache`).

---

## `GET /api/v1/version/`

Returns the running application version string. **Requires authentication** (`IsAuthenticated`). Unauthenticated requests receive `401 Unauthorized` (with a `WWW-Authenticate: Token` header).

**Response**
```json
{ "version": "1.2.0" }
```

The value is read from the `APP_VERSION` environment variable set at deploy time (see `.env.example`). Use this to confirm which version is deployed before running migrations or checking the changelog. See [Version API](version.md) for the full reference.

---

## Kubernetes example

```yaml
livenessProbe:
  httpGet:
    path: /api/health/liveness/
    port: 8000
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /api/health/readiness/
    port: 8000
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
```
