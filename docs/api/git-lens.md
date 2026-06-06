# Issue Board Lens API

!!! warning "Experimental feature"
    Issue Board Lens is an **experimental** feature. It is read-only, supports **public repositories only**, and is subject to change without a deprecation notice until it leaves experimental status.

Issue Board Lens surfaces GitHub or GitLab issues directly inside a Visiban board, pivoted by column and swimlane dimensions. The feature is flag-gated: all endpoints below return `404 Not Found` unless the server is started with `GIT_LENS_ENABLED=true`.

All endpoints require authentication (`Authorization: Token <value>`). Unauthenticated requests receive `403 Forbidden`.

---

## Object reference

### LensConnection

Represents the saved mapping between a Visiban board and a remote issue tracker repository.

| Field | Type | Description |
|---|---|---|
| `id` | integer | Database primary key |
| `provider` | string | Issue tracker provider. One of `"github"` or `"gitlab"` |
| `repo_slug` | string | Repository in `owner/repo` format (e.g. `"acme/backend"`) |
| `column_dim` | string | Dimension used to map issues to board columns. One of `"status"`, `"state"` |
| `swimlane_dim` | string | Dimension used to map issues to swimlanes. One of `"milestone"`, `"assignee"`, `"label"` |
| `created_by` | object | User who created the connection — `{ id, username, display_name, avatar_url }` |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 timestamp of last update |

### LensData

Returned by the board data endpoint. Contains the full issue grid for a board at fetch time.

| Field | Type | Description |
|---|---|---|
| `columns` | array | Column dimension keys — `[{ key, label }]` |
| `swimlanes` | array | Swimlane dimension keys — `[{ key, label }]`. Synthetic keys `"__none__"` and `"__nostatus__"` appear with user-friendly labels when issues lack the relevant field. |
| `issues` | array | Issue objects (see below) |
| `fetched_at` | string | ISO 8601 timestamp of when the data was fetched from the provider. Results are cached server-side for ~60 seconds per user + repository + pivot combination. |
| `source` | object | `{ provider, repo, url }` — identifies the upstream source |
| `truncated` | boolean | `true` when the provider returned more issues than the server fetched. When `true`, `total_count` (if available) indicates the full result size. |
| `total_count` | integer / null | Total issue count reported by the provider, or `null` when the provider does not expose this value |

**Issue object** (each element of `issues`):

| Field | Type | Description |
|---|---|---|
| `number` | integer | Issue number in the remote repository |
| `title` | string | Issue title |
| `url` | string | URL to the issue on the provider's website |
| `state` | string | `"open"` or `"closed"` |
| `labels` | array | `[{ name, color }]` — `color` is a 6-character hex string without a leading `#` (e.g. `"d73a4a"`) |
| `assignees` | array | `[{ username, avatar_url }]` |
| `milestone` | string / null | Milestone title, or `null` if none |
| `column_keys` | array | List of column dimension key strings this issue maps to |
| `swimlane_keys` | array | List of swimlane dimension key strings this issue maps to. An issue may appear in **multiple** swimlane keys (e.g. when it carries more than one label and `swimlane_dim` is `"label"`); the UI renders it in each matching lane. |

---

## Endpoints

### `GET /api/v1/git-lens/connections/{board_id}/`

Retrieve the saved LensConnection for a board.

**Permissions:** Any board member. Non-members receive `403 Forbidden`.

**Response — 200 OK**
```json
{
  "id": 12,
  "provider": "github",
  "repo_slug": "acme/backend",
  "column_dim": "status",
  "swimlane_dim": "milestone",
  "created_by": {
    "id": 5,
    "username": "alice",
    "display_name": "Alice Smith",
    "avatar_url": null
  },
  "created_at": "2026-05-01T12:00:00Z",
  "updated_at": "2026-05-14T09:22:11Z"
}
```

**Errors**

| Status | Condition |
|---|---|
| `403 Forbidden` | Caller is not a member of the board |
| `404 Not Found` | No lens connection is configured for this board, or `GIT_LENS_ENABLED` is not set |

---

### `PUT /api/v1/git-lens/connections/{board_id}/`

Create or replace the LensConnection for a board. If no connection exists, one is created; if one already exists, it is replaced in full.

**Permissions:** Board admin, board owner, or site admin. Board members without admin role receive `403 Forbidden`.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | Yes | Issue tracker provider. One of `"github"` or `"gitlab"` |
| `repo_slug` | string | Yes | Repository in `owner/repo` format. Must be a public repository |
| `column_dim` | string | No | Dimension for board columns. One of `"status"`, `"state"` (default: `"status"`) |
| `swimlane_dim` | string | No | Dimension for swimlanes. One of `"milestone"`, `"assignee"`, `"label"` (default: `"milestone"`) |

**Example request**
```json
{
  "provider": "github",
  "repo_slug": "acme/backend",
  "column_dim": "status",
  "swimlane_dim": "label"
}
```

**Response — 200 OK** — the full LensConnection object (same shape as `GET`)
```json
{
  "id": 12,
  "provider": "github",
  "repo_slug": "acme/backend",
  "column_dim": "status",
  "swimlane_dim": "label",
  "created_by": {
    "id": 5,
    "username": "alice",
    "display_name": "Alice Smith",
    "avatar_url": null
  },
  "created_at": "2026-05-01T12:00:00Z",
  "updated_at": "2026-06-06T08:15:00Z"
}
```

**Errors**

| Status | Condition |
|---|---|
| `400 Bad Request` | Invalid `provider` value, malformed `repo_slug` (must be `owner/repo`), unsupported `column_dim` or `swimlane_dim` value |
| `403 Forbidden` | Caller does not have board admin, owner, or site admin role |
| `404 Not Found` | Board does not exist, or `GIT_LENS_ENABLED` is not set |

---

### `DELETE /api/v1/git-lens/connections/{board_id}/`

Remove the LensConnection for a board. The board's issue data cache is also purged.

**Permissions:** Board admin, board owner, or site admin. Board members without admin role receive `403 Forbidden`.

**Response — 204 No Content** — empty body.

**Errors**

| Status | Condition |
|---|---|
| `403 Forbidden` | Caller does not have board admin, owner, or site admin role |
| `404 Not Found` | Board does not exist, no connection is configured, or `GIT_LENS_ENABLED` is not set |

---

### `GET /api/v1/git-lens/board/{board_id}/`

Fetch live issue data from the remote provider for a board, pivoted into columns and swimlanes. The board must have a saved LensConnection (see above).

**Permissions:** Any board member. Non-members receive `403 Forbidden`.

**Query parameters**

| Parameter | Description |
|---|---|
| `column_dim` | Override the column pivot dimension for this request only. One of `"status"`, `"state"`. Does not modify the saved connection. |
| `swimlane_dim` | Override the swimlane pivot dimension for this request only. One of `"milestone"`, `"assignee"`, `"label"`. Does not modify the saved connection. |

!!! note
    Ad-hoc pivot overrides via query parameters affect only the current response. The saved LensConnection on the board is not changed.

**Response — 200 OK**
```json
{
  "columns": [
    { "key": "open", "label": "Open" },
    { "key": "closed", "label": "Closed" }
  ],
  "swimlanes": [
    { "key": "v2.0", "label": "v2.0" },
    { "key": "v2.1", "label": "v2.1" },
    { "key": "__none__", "label": "No milestone" }
  ],
  "issues": [
    {
      "number": 214,
      "title": "Fix pagination on mobile",
      "url": "https://github.com/acme/backend/issues/214",
      "state": "open",
      "labels": [
        { "name": "bug", "color": "d73a4a" },
        { "name": "mobile", "color": "0075ca" }
      ],
      "assignees": [
        { "username": "alice", "avatar_url": "https://avatars.githubusercontent.com/u/1234?v=4" }
      ],
      "milestone": "v2.0",
      "column_keys": ["open"],
      "swimlane_keys": ["v2.0"]
    },
    {
      "number": 198,
      "title": "Update dependencies",
      "url": "https://github.com/acme/backend/issues/198",
      "state": "closed",
      "labels": [],
      "assignees": [],
      "milestone": null,
      "column_keys": ["closed"],
      "swimlane_keys": ["__none__"]
    }
  ],
  "fetched_at": "2026-06-06T08:30:00Z",
  "source": {
    "provider": "github",
    "repo": "acme/backend",
    "url": "https://github.com/acme/backend"
  },
  "truncated": false,
  "total_count": 2
}
```

**Errors**

| Status | Body | Condition |
|---|---|---|
| `403 Forbidden` | `{ "detail": "..." }` | Caller is not a board member |
| `404 Not Found` | `{ "detail": "..." }` | Board does not exist, no connection is configured, or `GIT_LENS_ENABLED` is not set |
| `409 Conflict` | `{ "detail": "...", "code": "auth_required" }` | Provider is GitHub and the requesting user has not linked their GitHub account. The user must connect their GitHub account via profile settings before fetching data. |
| `429 Too Many Requests` | `{ "detail": "...", "code": "rate_limited", "retry_after": 47 }` | The provider's API rate limit has been reached. `retry_after` is the number of seconds to wait before retrying. |
| `502 Bad Gateway` | `{ "detail": "...", "code": "lens_error" }` | Upstream provider returned an unexpected error or the request timed out. |
