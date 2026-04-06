# API Versioning

## URL path versioning — `/api/v1/`

All Visiban API endpoints are served under the `/api/v1/` prefix (e.g. `/api/v1/boards/`, `/api/v1/auth/login/`). This is implemented using DRF's `URLPathVersioning` with `DEFAULT_VERSION = "v1"` and `ALLOWED_VERSIONS = ["v1"]`.

Requests to an unsupported version (e.g. `/api/v2/`) receive `406 Not Acceptable`.

A small number of infrastructure-level endpoints are intentionally unversioned:

| Endpoint | Reason |
|---|---|
| `GET /api/health/liveness/` | Infrastructure health probes must not change URL across releases |
| `GET /api/health/readiness/` | Same |
| `GET /api/share/<token>/` | Externally shared URLs embedded in emails and bookmarks must remain stable |
| `/api/schema/`, `/api/schema/swagger-ui/`, `/api/schema/redoc/` | Schema introspection endpoints; clients use the versioned base paths within the schema |

## Backward-compatibility policy

The URL prefix is the version signal for clients. Within a major version, the following changes are **never** made in a patch or minor release:

| Change type | Rule |
|---|---|
| Remove or rename a response field | Never — add new fields, deprecate old ones, never delete |
| Change a field's type | Never (e.g. string → integer, nullable → required) without a major version bump |
| Remove an endpoint | Never — endpoints receive a `410 Gone` response with a deprecation notice for at least one minor release first |
| Add a required query parameter to an existing endpoint | Never — new parameters must be optional with a sensible default |
| Add a required body field to an existing endpoint | Never — new body fields must be optional with a sensible default |

These rules are enforced by code review and are documented in `CLAUDE.md` so they apply to every contribution.

## Pagination shape

All paginated list endpoints return a consistent envelope:

```json
{
  "count": 42,
  "offset": 0,
  "page_size": 50,
  "results": [...]
}
```

Query parameters: `?offset=0&page_size=50` (max `200`). This shape is stable for the lifetime of `v1`.

## How deprecation works

When a field or endpoint needs to be removed in a future release:

1. **Announce deprecation** — add `Deprecation` and `Sunset` response headers to the relevant endpoint for at least one minor release before removing the behavior:

    ```
    Deprecation: true
    Sunset: <ISO 8601 date of planned removal>
    ```

2. **Document in CHANGELOG** — the deprecation notice must appear in `CHANGELOG.md` under the release that introduced the headers, and the planned removal must appear under the release that performs it.

3. **Remove after the sunset date** — the field or endpoint may be removed once the sunset release has shipped. Clients that read the `Sunset` header have advance notice to update.

For endpoints being retired, return `410 Gone` with a JSON body explaining what replaced it:

```json
{
  "detail": "This endpoint was removed in 1.x.0. Use /api/v1/replacement/ instead.",
  "docs": "https://docs.visiban.com/api/replacement/"
}
```

## Future versioning

When a breaking change is unavoidable, a `/api/v2/` prefix will be introduced. Both versions will be served in parallel for at least one minor release cycle to allow integrators to migrate. Until a breaking change is required, only `v1` exists — there is no `/api/v2/` today.
