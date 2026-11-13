# Probe Visiban's health with two unauthenticated GETs

Point your liveness probe at `/api/health/liveness/` and your readiness probe at `/api/health/readiness/`.

```bash
curl -i http://localhost:8000/api/health/readiness/   # 200 {"status": "ok"}, or 503 when a dependency is down
```

**Why it matters:** the two probes answer different questions. A failed liveness probe means restart the container; a failed readiness probe means stop sending it traffic.

**The big picture:** two unauthenticated endpoints for liveness and readiness probes — usable with Kubernetes, Docker Compose `healthcheck` directives, or any uptime monitoring tool.

**By the numbers:**

| Endpoint | Checks | Success | Failure |
|---|---|---|---|
| `GET /api/health/liveness/` | Process is running; no external checks | `200` | Restart the container |
| `GET /api/health/readiness/` | Database and Valkey cache reachable | `200` | `503`; withhold traffic |

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

Returns `200 OK` if both the database and Valkey cache are reachable. No authentication required.

**Response — healthy**
```json
{"status": "ok"}
```

**Response — degraded** (`503 Service Unavailable`)
```json
{
  "status": "error",
  "errors": {
    "db": "unavailable",
    "redis": "unavailable"
  }
}
```

Only the failing subsystems appear in `errors`, each with the fixed value `unavailable`. Failure details are written to the server log, not the response. Use this as a **readiness probe** — traffic should not be routed to the instance until it returns `200`.

!!! warning "Deprecated *(1.3+)*: the `errors` object"
    The `errors` object, and its component keys `db` and `redis`, are deprecated. They are still returned unchanged on every `503` for all of 1.x, but they name the backing services to anonymous callers, so they are planned for removal in 2.0 ([#1902](https://gitlab.com/visiban/visiban/-/issues/1902)). After that the degraded body is `{"status": "error"}` only.

    Decide readiness from the HTTP status code (`200` or `503`), or from `status`. The Helm probes, the Helm test hook, and the deploy drills already read only those. If an external monitor or load balancer parses `errors`, switch it to the status code before upgrading to 2.0. Which component failed is in the server log (`Readiness check failed: database` or `Readiness check failed: cache`).

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
