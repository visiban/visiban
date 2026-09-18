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
| `column_dim` | string | Dimension used to map issues to board columns. One of `"status"`, `"state"`, `"pipeline"` |
| `swimlane_dim` | string | Dimension used to map issues to swimlanes. One of `"milestone"`, `"assignee"`, `"label"` |
| `created_by` | object | User who created the connection — `{ id, username, display_name, avatar_url }` |
| `created_at` | string | ISO 8601 creation timestamp |
| `updated_at` | string | ISO 8601 timestamp of last update |

### LensData

Returned by the board data endpoint. Contains the full issue grid for a board at fetch time.

| Field | Type | Description |
|---|---|---|
| `columns` | array | Column dimension keys — `[{ key, label }]` |
| `swimlanes` | array | Swimlane dimension keys — `[{ key, label, is_current? }]`. Synthetic keys `"__none__"` and `"__nostatus__"` appear with user-friendly labels when issues lack the relevant field. `is_current` is `true` on at most one lane, only when `swimlane_dim=milestone`, marking the milestone currently being worked on (see [Current milestone](#current-milestone)). The field is additive — treat its absence as `false`. |
| `issues` | array | Issue objects (see below) |
| `fetched_at` | string | ISO 8601 timestamp of when the data was fetched from the provider. Results are cached server-side for ~60 seconds per user + repository + pivot combination. |
| `source` | object | `{ provider, repo, url }` — identifies the upstream source |
| `truncated` | boolean | `true` when the provider returned more issues than the server fetched. When `true`, `total_count` (if available) indicates the full result size. |
| `total_count` | integer / null | Total issue count reported by the provider, or `null` when the provider does not expose this value |
| `available_milestones` | array of strings | Milestone titles found in the fetched issues, in alphabetical order. Intended for the filter's autocomplete. This list is derived from the fetched issues, not an exhaustive repo milestone list (the milestones-list endpoints require auth even for public repos, so they are not called). The `milestone` query parameter accepts any title, including ones not in this list. |

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
| `milestone_due` | string / null | Due date of that milestone as an ISO date (`YYYY-MM-DD`), or `null`. Carried through from the provider so current-milestone detection needs no second API call. Additive field. |
| `milestone_state` | string / null | State of that milestone — `"active"`/`"open"` vs `"closed"` — or `null`. Additive field. |
| `column_keys` | array | List of column dimension key strings this issue maps to |
| `swimlane_keys` | array | List of swimlane dimension key strings this issue maps to. An issue may appear in **multiple** swimlane keys (e.g. when it carries more than one label and `swimlane_dim` is `"label"`); the UI renders it in each matching lane. |
| `has_branch` | boolean | `true` when a feature branch for this issue exists in the repo. Always `false` when `column_dim` is not `"pipeline"`. |
| `has_open_pr` | boolean | `true` when an open MR/PR references or closes this issue. Always `false` when `column_dim` is not `"pipeline"`. |
| `pipeline_evidence` | object / null | Why the issue landed in its pipeline column (see [PipelineEvidence](#pipelineevidence) below). `null` when `column_dim` is not `"pipeline"`, or when the issue has no linked branch or open MR. |

### PipelineEvidence

Present on an issue when `column_dim=pipeline` and the issue has a linked branch or open MR. `null` otherwise.

| Field | Type | Description |
|---|---|---|
| `branch` | string / null | Name of the feature branch driving a "Doing" placement, or `null` if none |
| `mr_number` | integer / null | Number of the open MR/PR driving a "Review" placement, or `null` if none |
| `mr_url` | string / null | URL to the open MR/PR on the provider's website, or `null` if none |
| `mr_closes` | boolean | `true` when the MR's closing pattern explicitly targets this issue |

### Pipeline column dimension

When `column_dim` is `"pipeline"` the board always renders exactly five fixed columns regardless of issue state:

| Key | Label | Placement condition |
|---|---|---|
| `backlog` | Backlog | Default — no milestone, no branch, no open MR, issue is open |
| `todo` | To Do | Issue has a milestone but no branch and no open MR |
| `doing` | Doing | A feature branch for the issue exists in the repo |
| `review` | Review | An open MR/PR references or closes the issue |
| `done` | Done | Issue is closed |

Placement uses a first-match ladder in the order shown above (e.g. a closed issue with an open MR still lands in `done`). All five columns are always present in the `columns` array of the response, even when they contain no issues.

!!! note
    Branch and open-MR detection requires the connected repository to be on **github.com** or **gitlab.com**. GitLab reads are performed anonymously. The `has_branch`, `has_open_pr`, and `pipeline_evidence` fields are populated only when `column_dim=pipeline`; for all other column dimensions they are `false`, `false`, and `null` respectively.

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
| `column_dim` | string | No | Dimension for board columns. One of `"status"`, `"state"`, `"pipeline"` (default: `"pipeline"`) |
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
| `400 Bad Request` | Invalid `provider` value, malformed `repo_slug` (must be `owner/repo`), unsupported `column_dim` (must be `"status"`, `"state"`, or `"pipeline"`) or `swimlane_dim` value |
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

| Parameter | Type | Description |
|---|---|---|
| `column_dim` | string | Override the column pivot dimension for this request only. One of `"status"`, `"state"`, `"pipeline"`. Does not modify the saved connection. |
| `swimlane_dim` | string | Override the swimlane pivot dimension for this request only. One of `"milestone"`, `"assignee"`, `"label"`. Does not modify the saved connection. |
| `state` | string | Filter by issue state. `"open"` or `"closed"`. Any other value (including omitting the parameter) returns all states. Applied **server-side** before the issue set is returned. |
| `milestone` | string | Filter to a single milestone by title. Use the synthetic value `"__none__"` to return only issues with no milestone. Max 255 characters. Applied **server-side** on both providers (see [Filtering](#filtering)). Omitting returns all milestones. |
| `labels` | string | Comma-separated label names. Applied **server-side** on both providers and **AND-ed** — an issue must carry *every* listed label to match. At most 5 labels; extras are dropped rather than rejected. Values are trimmed, deduplicated and sorted server-side, so `?labels=b,a` and `?labels=a,b` are the same request. Label names are matched **case-sensitively** (both providers preserve label case). Each value is capped at 255 characters. |
| `assignee` | string | Filter to issues assigned to a single username. Applied **server-side** on both providers. Deliberately single-valued: neither the GitLab nor the GitHub API can express "assigned to any of N" in one call. Max 255 characters. |
| `refresh` | string | `"1"` or `"true"` forces a re-fetch from the provider past the ~60s server cache, so the response carries a fresh `fetched_at`. Rate-limited per user, per repository (see [Refresh and rate limits](#refresh-and-rate-limits)); a request inside the cooldown is served the cached copy instead — it does not error. |

All filter parameters are **optional** and default to "no filter". Unrecognized or
empty values are ignored rather than rejected: a lens URL is a shareable snapshot
that can outlive the data it points at, so a link carrying a stale value still
renders a board instead of returning `400`.

!!! note
    Ad-hoc pivot overrides via query parameters affect only the current response. The saved LensConnection on the board is not changed.

### Filtering

The `state`, `milestone`, `labels` and `assignee` parameters narrow which issues are returned. All four are applied **server-side** — pushed into the upstream provider query before any fetching occurs — so that a filter can surface issues that fall outside the default 300-issue fetch budget (3 pages × 100 per page).

**GitLab** — `state`, `milestone`, `labels` (as `labels=`) and `assignee` (as `assignee_username=`) are all pushed to the GitLab API query. A `?milestone=Sprint+5` request asks GitLab for _only_ that milestone's issues, which means a milestone with more than 300 issues can still be fully retrieved within the budget (the fetch budget applies to the filtered set, not the full repository).

**GitHub** — `state`, `labels` and `assignee` map directly onto the GitHub Issues API parameters of the same names.

For example, `GET /api/v1/git-lens/board/42/?labels=bug,priority-1&assignee=alice` returns only issues that carry both the `bug` and `priority-1` labels **and** are assigned to `alice` — the same AND semantics apply on both providers.

`milestone` is also server-side, but requires one extra step: the GitHub Issues API filters by milestone **number**, not title. The server resolves the title against the repository's milestone roster (`GET /repos/{owner}/{repo}/milestones`, one page of 100, cached for ~10 minutes per user and repository) and sends the resolved number. Two outcomes are possible when the title is not in the roster:

| Roster | Behavior |
|---|---|
| Complete (fewer than 100 milestones) | The milestone genuinely does not exist. An **empty board** is returned, and no issue request is made. |
| Capped (a full page of 100 returned) | The title may exist on a page that was not read, so resolution is *unknown*, not negative. The server falls back to filtering the fetched set client-side and sets `truncated: true`. |

The synthetic `"__none__"` value needs no resolution on either provider — GitLab receives its `None` literal and GitHub its `none` literal.

> **Changed in 1.2**

GitHub `milestone` filtering was applied client-side in earlier releases, which silently dropped matching issues outside the 300-issue budget. It is now server-side. No request or response shape changed — only the completeness of the result.

**Text search** — there is no `q` or text-search query parameter. Full-text filtering (by title or issue number) is performed client-side by the SPA over the issues already in the response. Do not pass a text-search value to this endpoint; it is silently ignored.

**Coverage expansion** — when any server-side filter is active, the effective issue set is scoped to it, and the fetch budget applies to the scoped set rather than the full repository. This makes filtering a useful way to deep-dive a large milestone or label without fetching the entire repository.

The `available_milestones` field in the response lists the milestone titles present in the current fetched set, for use as autocomplete suggestions. Because it is derived from the fetched issues and not from the provider's full milestone list, milestones whose issues were not fetched (e.g. milestones beyond the budget on an unfiltered request) will not appear — but passing their title as a `?milestone=` value still works.

There is deliberately no `available_labels` or `available_assignees` field: every issue object already carries its `labels` and `assignees`, so a client can derive both suggestion sets from the response it already has. Note that, as with `available_milestones`, any such derived list narrows as filters are applied — a client that needs a stable suggestion list should accumulate values across responses rather than recompute from the latest one.

**Response — 200 OK** (`column_dim=state`, the default for `"state"` connections)
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
      "swimlane_keys": ["v2.0"],
      "has_branch": false,
      "has_open_pr": false,
      "pipeline_evidence": null
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
      "swimlane_keys": ["__none__"],
      "has_branch": false,
      "has_open_pr": false,
      "pipeline_evidence": null
    }
  ],
  "fetched_at": "2026-06-06T08:30:00Z",
  "source": {
    "provider": "github",
    "repo": "acme/backend",
    "url": "https://github.com/acme/backend"
  },
  "truncated": false,
  "total_count": 2,
  "available_milestones": ["v2.0", "v2.1"]
}
```

**Response — 200 OK** (`?column_dim=pipeline`)
```json
{
  "columns": [
    { "key": "backlog", "label": "Backlog" },
    { "key": "todo",    "label": "To Do" },
    { "key": "doing",   "label": "Doing" },
    { "key": "review",  "label": "Review" },
    { "key": "done",    "label": "Done" }
  ],
  "swimlanes": [
    { "key": "v2.0", "label": "v2.0" },
    { "key": "__none__", "label": "No milestone" }
  ],
  "issues": [
    {
      "number": 214,
      "title": "Fix pagination on mobile",
      "url": "https://github.com/acme/backend/issues/214",
      "state": "open",
      "labels": [{ "name": "bug", "color": "d73a4a" }],
      "assignees": [
        { "username": "alice", "avatar_url": "https://avatars.githubusercontent.com/u/1234?v=4" }
      ],
      "milestone": "v2.0",
      "column_keys": ["review"],
      "swimlane_keys": ["v2.0"],
      "has_branch": true,
      "has_open_pr": true,
      "pipeline_evidence": {
        "branch": "fix/214-mobile-pagination",
        "mr_number": 87,
        "mr_url": "https://github.com/acme/backend/pull/87",
        "mr_closes": true
      }
    },
    {
      "number": 201,
      "title": "Refactor auth middleware",
      "url": "https://github.com/acme/backend/issues/201",
      "state": "open",
      "labels": [],
      "assignees": [],
      "milestone": "v2.0",
      "column_keys": ["doing"],
      "swimlane_keys": ["v2.0"],
      "has_branch": true,
      "has_open_pr": false,
      "pipeline_evidence": {
        "branch": "feat/201-auth-middleware",
        "mr_number": null,
        "mr_url": null,
        "mr_closes": false
      }
    },
    {
      "number": 198,
      "title": "Update dependencies",
      "url": "https://github.com/acme/backend/issues/198",
      "state": "closed",
      "labels": [],
      "assignees": [],
      "milestone": null,
      "column_keys": ["done"],
      "swimlane_keys": ["__none__"],
      "has_branch": false,
      "has_open_pr": false,
      "pipeline_evidence": null
    }
  ],
  "fetched_at": "2026-06-06T08:30:00Z",
  "source": {
    "provider": "github",
    "repo": "acme/backend",
    "url": "https://github.com/acme/backend"
  },
  "truncated": false,
  "total_count": 3,
  "available_milestones": ["v2.0"]
}
```

**Errors**

| Status | Body | Condition |
|---|---|---|
| `403 Forbidden` | `{ "detail": "..." }` | Caller is not a board member |
| `404 Not Found` | `{ "detail": "..." }` | Board does not exist, no connection is configured, or `GIT_LENS_ENABLED` is not set |
| `409 Conflict` | `{ "detail": "...", "code": "auth_required" }` | Provider is GitHub and the requesting user has not linked their GitHub account. The user must connect their GitHub account via profile settings before fetching data. |
| `429 Too Many Requests` | `{ "detail": "...", "code": "rate_limited", "retry_after": 47 }` | The provider's API rate limit has been reached. `retry_after` is the number of seconds to wait before retrying. |
| `429 Too Many Requests` | `{ "detail": "...", "code": "fetch_budget_exhausted" }` | The caller's own upstream-fetch budget is spent (see [Refresh and rate limits](#refresh-and-rate-limits)) and no cached copy exists to serve instead. No `retry_after`; retry after the budget window (5 minutes) elapses. |
| `502 Bad Gateway` | `{ "detail": "...", "code": "lens_error" }` | Upstream provider returned an unexpected error or the request timed out. |


## Current milestone

When `swimlane_dim=milestone`, the server marks at most one swimlane `is_current: true` — the
milestone being actively worked on — so a client can promote it instead of burying it among
every other milestone.

Detection is automatic; there is no configuration and no per-release maintenance:

1. Among milestones that are **not closed** and have **at least one open issue**, the one whose
   due date is nearest — the next upcoming due date, or, if every candidate is already past, the
   most recent past one (an overdue milestone is still the one in progress).
2. Only when **no** candidate carries a due date *and* `column_dim=pipeline`: the milestone with
   the most issues sitting in Doing/Review.
3. Otherwise no lane is marked.

Ties break on milestone title, so the result is stable across fetches. The synthetic
`"__none__"` lane is never marked current.

The precedence is deliberately independent of `column_dim` so the marked lane does not move when
a viewer switches column views — the in-progress signal in rule 2 is only computable under
pipeline columns, so leading with it would make the badge flicker between pivots.

## Refresh and rate limits

Board data is cached server-side for ~60 seconds per repository, pivot and filter combination,
shared across everyone viewing that board. `?refresh=1` deliberately bypasses that cache.

Three limits bound how much upstream traffic one account can cause. The first two are per user
**per repository** — not per board — because the budget being protected is the provider's rate
limit, which every board pointing at the same repository shares:

| Limit | Scope | Window | Behavior when exceeded |
|---|---|---|---|
| One forced refresh (`?refresh=1`) | user + repository | 30 s | The request is served the cached copy. No error; `fetched_at` simply does not advance. |
| 12 upstream fetches from any path | user + repository | 5 min | A cached copy is served if one exists, otherwise `429 Too Many Requests` with `code: "fetch_budget_exhausted"`. |
| 48 upstream fetches from any path | user, all repositories | 5 min | Same behavior. Backstops the per-repository limit, which is scoped on a repository slug the caller can change at will. |

The second limit covers cold cache keys as well as forced refreshes. `milestone`, `labels` and
`assignee` all accept free text, so the space of reachable cache keys is unbounded and every new
value is a cache miss that would otherwise reach the provider. The fetch budget bounds that
fan-out structurally rather than by restricting values: minting a distinct cache key *requires* a
cold fetch, and the budget is spent before the provider is contacted — so the number of keys one
account can create can never exceed the number of fetches it is allowed, regardless of how many
filter dimensions exist. This is why filter values are never restricted to a known list; scoping
to a milestone or label outside the fetched window is the point of filtering server-side.

Filtered responses are retained for a shorter period than the unfiltered board (3 minutes versus
10). The unfiltered board is the hot, genuinely shared entry; filtered combinations are a long
tail that is far less likely to be re-read.

Refresh is available to **every** board role including viewers — the lens is a read-only surface
whose main audience is viewers, so the cap is on rate, not on role.
