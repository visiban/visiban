# Health Check API

Two unauthenticated endpoints are available for liveness and readiness probes. Both are suitable for use with Kubernetes, Docker Compose `healthcheck` directives, or any uptime monitoring tool.

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
    "db": "connection refused",
    "redis": "cache read/write mismatch"
  }
}
```

Only the failing subsystems appear in `errors`. Use this as a **readiness probe** — traffic should not be routed to the instance until it returns `200`.

---

## `GET /api/v1/version/`

Returns the running application version string. **Requires authentication** (`IsAuthenticated`). Unauthenticated requests receive `403 Forbidden`.

**Response**
```json
{ "version": "1.1.0" }
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
