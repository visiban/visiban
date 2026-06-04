# Version API

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

**Errors:** none. The endpoint always returns `200 OK` when the server is running.
