<a id="api-versioning"></a>

# The /api/v1/ contract: what never changes

Visiban's REST API is a public contract from 1.0 onward: this page is the backward-compatibility policy that binds every change to it.

**Why it matters:** Integrations built on `/api/v1/` keep working through every 1.x release. Deprecations get headers and at least one minor release of notice.

## URL path versioning — `/api/v1/`

Every API endpoint is served under `/api/v1/` (e.g. `/api/v1/boards/`, `/api/v1/auth/login/`), using DRF's `URLPathVersioning` with `DEFAULT_VERSION = "v1"` and `ALLOWED_VERSIONS = ["v1"]`. A request to an unsupported version (e.g. `/api/v2/`) receives `406 Not Acceptable` when authenticated (anonymous callers get `401`). An unmatched `/api/v1/...` path returns a JSON `404` without requiring authentication.

A few infrastructure endpoints are intentionally unversioned:

| Endpoint | Reason |
|---|---|
| `GET /api/health/liveness/` | Infrastructure health probes must not change URL across releases |
| `GET /api/health/readiness/` | Same |
| `GET /api/share/<token>/` | Externally shared URLs embedded in emails and bookmarks must remain stable |
| `/api/schema/`, `/api/schema/swagger-ui/`, `/api/schema/redoc/` | Schema introspection endpoints; clients use the versioned base paths within the schema |

## Backward-compatibility policy

The URL prefix is the version signal. Within a major version, a patch or minor release **never** makes these changes:

| Change type | Rule |
|---|---|
| Remove or rename a response field | Never — add new fields, deprecate old ones, never delete |
| Change a field's type | Never (e.g. string → integer, nullable → required) without a major version bump |
| Remove an endpoint | Never — endpoints receive a `410 Gone` response with a deprecation notice for at least one minor release first |
| Add a required query parameter to an existing endpoint | Never — new parameters must be optional with a sensible default |
| Add a required body field to an existing endpoint | Never — new body fields must be optional with a sensible default |

Code review and `CLAUDE.md` enforce these rules on every contribution.

## Pagination shape

Most paginated list endpoints return a consistent envelope:

```json
{
  "count": 42,
  "offset": 0,
  "page_size": 50,
  "results": [...]
}
```

Query parameters: `?offset=0&page_size=50` (max `200`). This shape is stable for the lifetime of `v1`. A few endpoints deliberately use another shape (cursor `{results, next_cursor}` on `/cards/`, `next`/`previous` links on a card timeline, `{results, next_cursor}` on the board events feed, where `next_cursor` is an integer and the deprecated `next` is also returned, and bare arrays for small bounded lists); see [Pagination](../api/index.md#pagination) for the full list.

## How deprecation works

To remove a field or endpoint in a future release:

1. **Announce deprecation** — add `Deprecation` and `Sunset` response headers to the endpoint for at least one minor release before removing the behavior:

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

## Currently deprecated fields

| Field | Since | Status |
|---|---|---|
| `Group.default_board_member_role` (also writable via `PATCH /groups/{id}/board-defaults/`) | 1.2 | No effect: it was never read, and group members get their group role on every group board. Still accepted and returned unchanged, and marked `deprecated: true` in the OpenAPI schema. Tracked in [#1430](https://gitlab.com/visiban/visiban/-/issues/1430). |
| `next` on the change feed response (`GET /boards/{id}/events/`) | 1.2 | Deprecated in favor of `next_cursor`. Still returned in every response with a value identical to `next_cursor`, and marked `deprecated: true` in the OpenAPI schema. Removed only at a major version bump. Tracked in [#1869](https://gitlab.com/visiban/visiban/-/issues/1869). |
| `CurrentUser.maintenance_mode` (`GET /auth/user/`, `/auth/me/`) | 1.2 | Read it from [`GET /auth/site-config/`](../api/authentication.md#get-apiv1authsite-config), which returns the same value. Still returned unchanged for all of 1.x and marked `deprecated: true` in the OpenAPI schema. Removal needs a major version ([#1872](https://gitlab.com/visiban/visiban/-/issues/1872)). |
| `CurrentUser.maintenance_message` (`GET /auth/user/`, `/auth/me/`) | 1.2 | Same as `maintenance_mode`: read it from `site-config`. Removal needs a major version ([#1872](https://gitlab.com/visiban/visiban/-/issues/1872)). |
| `CurrentUser.demo_mode` (`GET /auth/user/`, `/auth/me/`) | 1.2 | Same as `maintenance_mode`: read it from `site-config`. Removal needs a major version ([#1872](https://gitlab.com/visiban/visiban/-/issues/1872)). |
| `CurrentUser.demo_next_reset_at` (`GET /auth/user/`, `/auth/me/`) | 1.2 | Same as `maintenance_mode`: read it from `site-config`. Removal needs a major version ([#1872](https://gitlab.com/visiban/visiban/-/issues/1872)). |

## Future versioning

If a breaking change becomes unavoidable, a `/api/v2/` prefix will be introduced and both versions served in parallel for at least one minor release cycle, so integrators can migrate. Until then only `v1` exists; there is no `/api/v2/` today.
