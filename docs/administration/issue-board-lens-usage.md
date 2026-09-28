# Issue Board Lens Usage

> **Added in 1.2**

!!! warning "Experimental feature"
    The [Issue Board Lens](../features/issue-board-lens.md) is experimental. The usage report's fields may change while the feature is experimental.

The Issue Board Lens reads GitHub and GitLab on behalf of the people viewing a lens board. GitLab reads are anonymous, so they count against your **instance's** IP address and the rate limit gitlab.com applies to it. GitHub reads use each viewer's own token. This page explains how to see how much upstream traffic the lens actually generates, and why that traffic has a hard upper bound.

Two surfaces are available only while `GIT_LENS_ENABLED=true`:

- an admin-only **usage report**, served over the API, and
- one **structured log line** for every outbound GitHub/GitLab HTTP call.

---

## The usage report

Site admins can read `GET /api/v1/admin/git-lens/usage/`. From a shell, pass a [personal access token](../features/personal-access-tokens.md) that carries the `admin` scope:

```bash
curl -H "Authorization: Token vbn_..." https://visiban.example.com/api/v1/admin/git-lens/usage/
```

The report has three parts:

| Section | What it tells you |
|---|---|
| `last_24h` / `current_hour` | For each provider: `outbound_calls` (total HTTP requests made to GitHub or GitLab), `outbound_by_kind` (the same calls broken down by what was read, `issues`, `branches`, `merge_requests` or `milestones`, and by outcome), and `board_requests` (how each lens board load was answered). |
| `hourly` | Outbound calls per provider for each of the last 24 hours, oldest first. |
| `bounds` | The fixed limits that cap the traffic (see [Why the traffic is bounded](#why-the-traffic-is-bounded)). |

### Outbound call outcomes

| Outcome | Meaning |
|---|---|
| `ok` | The provider answered successfully. |
| `not_found` | The repository does not exist or is not public. |
| `auth_error` | The provider rejected the credential. A viewer's GitHub token may have expired. |
| `rate_limited` | The provider is throttling. If this count rises steadily for `gitlab`, the instance's IP is at gitlab.com's anonymous limit. |
| `http_error` | Any other non-success response from the provider. |
| `network_error` | Timeout, DNS or connection failure. The provider was never reached. |

### Board request outcomes

`board_requests` shows how much of the viewing load the lens cache absorbed. Only the `fetched`, `error` and `error_stale` outcomes contacted the provider.

| Outcome | Meaning |
|---|---|
| `cache_fresh` | Served from cache. No provider call was made. |
| `cache_stale_locked` | Another request was already refreshing the same board, so the cached copy was served. |
| `budget_exhausted_stale` | The viewer hit their fetch limit, so the cached copy was served. |
| `budget_exhausted_429` | The viewer hit their fetch limit and nothing was cached, so the request was refused with `429`. |
| `fetched` | Fresh data was fetched from the provider. |
| `error_stale` | The provider fetch failed, so the last good copy was served. |
| `error` | The provider fetch failed and nothing was cached, so the viewer saw an error. |

A healthy instance shows `cache_fresh` well ahead of `fetched`.

### Retention and accuracy

The counters are kept in the Redis/Valkey cache as hourly buckets for 24 hours. They are **operational telemetry, not an audit log**. They are approximate, they are not attributed to users, and they reset if the cache is flushed or restarted. For longer history, collect the log lines described below with your normal log pipeline.

---

## The outbound log line

Every GitHub or GitLab HTTP request the lens makes writes one `INFO` line to the backend's standard output, on the logger `git_lens.outbound`:

```text
git_lens outbound provider=gitlab kind=issues outcome=ok status=200 duration_ms=184 repo=acme/backend
```

| Field | Meaning |
|---|---|
| `provider` | `github` or `gitlab` |
| `kind` | `issues`, `branches`, `merge_requests` or `milestones` |
| `outcome` | Same values as the outbound outcomes above |
| `status` | HTTP status code, or `-` when no response was received |
| `duration_ms` | Wall-clock time of the request |
| `repo` | The public repository slug a board admin configured |

The same fields are attached to the log record as `lens_provider`, `lens_kind`, `lens_outcome`, `lens_status`, `lens_duration_ms` and `lens_repo`, so a JSON log formatter can emit them as structured fields.

The line never contains a token, an `Authorization` header, the request URL, or query parameters. Filter values such as assignee usernames are never logged.

To quiet the line without affecting the usage report, set:

```bash
GIT_LENS_OUTBOUND_LOG_LEVEL=WARNING
```

The default is `INFO`. The logger has nothing to emit while `GIT_LENS_ENABLED` is off.

---

## Why the traffic is bounded

The lens cannot generate unbounded upstream traffic, however many people view it or how they filter. The `bounds` section of the report shows the live values:

| Limit | Default | Effect |
|---|---|---|
| Shared cache (`cache_soft_ttl_seconds`) | 60 s | Everyone viewing the same GitLab repository, pivot and filter shares one fetch per minute. GitHub is cached per viewer. |
| Calls per fetch (`max_outbound_calls_per_fetch`) | 8 | At most 3 issue pages, 2 branch pages, 2 merge-request pages and 1 milestone page. |
| Fetches per user per repository (`fetch_budget_per_user_repo`) | 12 per 5 min | Covers refreshes, pivots and new filter values alike. |
| Fetches per user across all repositories (`fetch_budget_per_user`) | 48 per 5 min | Stops one account from multiplying its budget by pointing boards at many repositories. |
| Calls per user (`max_outbound_calls_per_user_per_window`) | 384 per 5 min | The product of the two lines above: the most one account can cause, whatever it does. |

See [Refresh and rate limits](../api/git-lens.md#refresh-and-rate-limits) for how these limits behave from a viewer's point of view.
