# Version API

A single endpoint that reports the running server's version string.

**Why it matters:** it's the frozen 1.x contract clients rely on to check compatibility before
calling anything else — see the stability commitment below.

## `GET /api/v1/version/`

Returns the running server version string. Authentication is required.

**Authentication:** requires a valid session or personal access token (`IsAuthenticated`). Unauthenticated requests receive `403 Forbidden`.

**Response**

```json
{
  "version": "1.1.0"
}
```

| Field | Type | Description |
|---|---|---|
| `version` | string | Semantic version string matching the release tag (e.g. `"1.1.0"`) |

**Stability commitment:** this endpoint and its `version` field are part of the public 1.x API contract. The field will never be removed or renamed in a minor/patch release. The value follows [Semantic Versioning](https://semver.org/) — clients may parse the string to compare against a minimum required server version.

The `APP_VERSION` environment variable that provides this value is set as the release tag operators pin (e.g. `v1.1.0` — see [Configuration](../administration/configuration.md)). The server strips only a leading `v`, so this field is bare semver (`1.1.0`) whenever `APP_VERSION` is pinned to a release tag. A non-release value such as `latest` or `dev` has no leading `v` to strip and is served back verbatim.

**Errors:** none. The endpoint always returns `200 OK` when the server is running.
