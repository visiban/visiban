# Webhooks API

`/api/v1/boards/{board_pk}/webhooks/` lets a board admin register URLs that receive a signed `POST` for each board change-feed event.

```bash
curl -X POST -b cookies.txt -H "X-CSRFToken: $CSRF" -H "Content-Type: application/json" \
  -d '{"name": "Deploys", "url": "https://hooks.example.com/visiban", "event_types": ["card.moved"]}' \
  "https://visiban.example.com/api/v1/boards/3/webhooks/"
# 201 {"id": 12, ..., "url": "https://hooks.example.com/visiban", "secret": "whsec_…"}
```

**Why it matters:** your integration gets each change pushed to it, signed, in order, without polling.

**Yes, but:** delivery is at-least-once and best-effort with retry. Deduplicate on `X-Visiban-Event-Id`; read the [change feed](events.md) directly if you need every event with certainty.

**Go deeper:** setup, scheduling the dispatcher and the private-network setting are in [Features — Webhooks](../features/webhooks.md).

!!! info "Since 1.3"
    Webhooks are new in Visiban 1.3, and off unless the operator sets `WEBHOOKS_ENABLED=true`.

---

## Access

Checked in this order:

| Condition | Response |
|---|---|
| Not signed in | `401` (with `WWW-Authenticate: Token`) |
| No access to the board | `404` (the endpoint does not confirm the board exists) |
| Board role below admin | `403` |
| `WEBHOOKS_ENABLED` off (or `DEMO_MODE` on), any action but `status/` | `403 {"code": "webhooks_disabled"}` |
| A personal access token on a session-only action | `403 {"code": "session_required"}` |
| A subscription id that belongs to another board | `404` |

Board admins and site admins (`can_access_all_content`) may use every action. **Session-only** actions are the ones that choose where data goes or how it is signed: create, a `PATCH` that changes `url`, `reenable`, `rotate` and `test`. They refuse personal access tokens and any other non-session credential. `reenable`, `rotate` and `test` refuse before the subscription is looked up, so a token gets `403`, not `404`, for an unknown id. A `PATCH` looks the subscription up first, because it has to read the body to see whether `url` is present, so a token gets `404` for an unknown id and `403` for a known one. On the other actions a token needs the `read` scope for `GET` and `write` for `PATCH`, `DELETE` and `disable`.

## Endpoints

| Method and path | Session only | Notes |
|---|---|---|
| `GET status/` | | Always `200` for a board admin, whether webhooks are on or off. |
| `GET /` | | List the board's webhooks. Not paginated (at most 10 per board by default). |
| `POST /` | yes | Create. `201`. Throttle scope `webhook_config` (30/hour per user). |
| `GET {id}/` | | One webhook. |
| `PATCH {id}/` | only when `url` is present | Any of `name`, `event_types`, `url`. Throttle `webhook_config` when `url` is present. |
| `DELETE {id}/` | | `204`. |
| `POST {id}/disable/` | | Turn off; `disabled_reason` becomes `manual`. Idempotent. No notice is sent. |
| `POST {id}/reenable/` | yes | Body `{"resume_from": "cursor" \| "latest"}`, default `cursor`. |
| `POST {id}/rotate/` | yes | New signing secret, returned once. Throttle scope `webhook_config`. |
| `POST {id}/test/` | yes | Send a `webhook.test` event now. Throttle scope `webhook_test` (10/hour per user). |

`PUT` is not supported.

Throttled actions (`webhook_config`: create, a `PATCH` that includes `url`, rotate; `webhook_test`: test) answer `429` with a `Retry-After` header once the per-user limit is reached.

### `GET status/`

```json
{
  "enabled": true,
  "dispatcher_last_run_at": "2026-11-01T09:14:30.002000Z",
  "dispatcher_stale": false,
  "subscribable_event_types": ["board.created", "board.updated", "card.archived", "card.created", "..."],
  "disable_after_failures": 20,
  "test_timeout_seconds": 10.0
}
```

- `dispatcher_last_run_at` is when the dispatcher last finished (or, failing that, started) a run, or `null` if it never has.
- `dispatcher_stale` is `true` when that is `null` or older than `WEBHOOK_DISPATCHER_STALE_SECONDS` (300 by default).
- `disable_after_failures` and `test_timeout_seconds` are the server's `WEBHOOK_DISABLE_AFTER_FAILURES` and `WEBHOOK_TIMEOUT_SECONDS`, so a client can state them without guessing.
- `subscribable_event_types` is the complete list `event_types` may contain, sorted. It is the board-channel event registry minus per-user events, admin-only events, `ping` and `board.deleted`. Build pickers from it; it grows when new event types are added.

### The subscription object

```json
{
  "id": 12,
  "board": 3,
  "name": "Deploys",
  "url_display": "hooks.example.com/…/k3f9",
  "url_host": "hooks.example.com",
  "event_types": ["card.moved"],
  "enabled": true,
  "disabled_reason": null,
  "disabled_at": null,
  "last_delivered_event_id": 4182,
  "consecutive_failures": 0,
  "failing_since": null,
  "next_attempt_at": null,
  "last_attempt_at": "2026-11-01T09:14:31.551000Z",
  "last_success_at": "2026-11-01T09:14:31.551000Z",
  "last_error_code": "",
  "last_status_code": 204,
  "created_by": { "id": 7, "username": "maya", "display_name": "Maya", "avatar_url": "" },
  "configured_by": { "id": 7, "username": "maya", "display_name": "Maya", "avatar_url": "" },
  "created_at": "2026-11-01T09:10:00.000000Z",
  "updated_at": "2026-11-01T09:14:31.552000Z",
  "configured_at": "2026-11-01T09:10:00.000000Z",
  "secret_rotated_at": null
}
```

| Field | Meaning |
|---|---|
| `url_display` | `host/…/last4`: the host and the URL's last four characters (just the host when there is no path). The rest is never returned after creation: for many services the path or query is the credential. |
| `event_types` | Empty list = every subscribable type, including types added in later versions. |
| `disabled_reason` | `null` while enabled; otherwise `manual`, `failures`, `cursor_expired`, `creator_lost_access` or `secret_unavailable`. |
| `last_delivered_event_id` | The change-feed id the webhook has delivered (or skipped by type) up to. |
| `last_error_code` | `""`, or `connection_failed`, `tls_error`, `timeout` or `http_error`. Never the receiver's response or an exception message. |
| `last_status_code` | The HTTP status of the last attempt, or `null` when no response was received. |
| `configured_by` | The owner: the account whose board-admin standing keeps the webhook delivering. Set on create, URL change, rotate and re-enable. `null` once that account is deleted, and the webhook then turns off. |

### `POST /` — create

Body: `url` (required), `name` (optional, at most 200 characters), `event_types` (optional, default `[]`).

The `201` response is the subscription object plus `url` and `secret`, with `Cache-Control: no-store`. **This is the only response that contains them.** The secret is `whsec_` followed by 43 URL-safe characters.

A new webhook starts at the board's newest event, so `last_delivered_event_id` starts at that event's id: nothing earlier is delivered. On a board whose events have all been removed by retention pruning it starts at the highest removed id instead, and on a board that never had events at `0`.

### `PATCH {id}/`

Send only the keys you change. Changing `url` validates it again, makes the caller the owner (`configured_by`), and leaves the secret unchanged.

### `POST {id}/reenable/`

Resets the failure state and makes the caller the owner. On a webhook that is already on it does the same (and ignores `resume_from`).

| `resume_from` | Result |
|---|---|
| `cursor` (default) | Delivers what was missed since the webhook stopped. `409 {"code": "cursor_expired"}` if any event after `last_delivered_event_id` was pruned from the feed, including when every missed event was pruned and nothing newer exists. |
| `latest` | Skips to new events: `last_delivered_event_id` becomes the board's newest event id or its highest pruned id, whichever is greater. |

`409 {"code": "secret_unavailable"}` when the stored URL or secret can no longer be decrypted (the instance encryption key changed). Delete the webhook and create a new one.

**Taking over** *(a webhook turned off with `creator_lost_access`)* re-verifies the caller, who becomes its owner:

| Account | Needs | Refusals |
|---|---|---|
| Has a password | `"current_password"` in the body | `400 password_required`, `400 password_incorrect`; wrong passwords count against the same failed-attempt lockout as sign-in (`429`) |
| Signs in only through an identity provider | A sign-in with that provider in this session within allauth's reauthentication window | `403 recent_login_required`: sign in again with the provider, then retry |

The password is never echoed back or logged.

### `POST {id}/rotate/`

Returns the subscription object plus a new `secret`, with `Cache-Control: no-store`. The old secret stops working immediately: a dispatcher run that started before the rotation stops before its next delivery. A delivery already in flight may still be signed with the old secret, and it is retried with the new one if your receiver rejects it.

### `POST {id}/test/`

```json
{"ok": true, "code": null, "status_code": 204, "latency_ms": 340}
{"ok": false, "code": "http_error", "status_code": 500, "latency_ms": 85}
{"ok": false, "code": "timeout", "status_code": null, "latency_ms": null}
```

The request itself answers `200` whatever happened at the receiver. `code` is `null` on success, otherwise `connection_failed` (including a destination that is no longer allowed: it is re-checked at send time and reported the same way as a failed connection), `tls_error`, `timeout`, `http_error` or `secret_unavailable`. `latency_ms` is the time to the receiver's status line, or `null` when nothing answered.

Sends the event below, synchronously, with the same headers and signature as a real delivery. It does not move the cursor or count as a failure. A disabled webhook can be tested.

```json
{"id": 0, "event": "webhook.test", "data": {"subscription_id": 12, "board_id": 3}, "actor_id": null, "actor": null, "created_at": "2026-11-01T09:20:00.000000Z", "redacted_at": null}
```

### Validation errors

The refusals below carry the machine-error shape `{"detail": "...", "code": "..."}` with a string `code`. Other invalid input (a `name` over 200 characters, a `resume_from` other than `cursor` or `latest`) returns the standard DRF field-error object keyed by field name, with no `code`. A body that is not a JSON object is a plain `400`.

| `code` | When |
|---|---|
| `invalid_url` | The address text is unusable, with a `reason`: `creds` (it contains a user name or password), `http` (`http://` while the operator allowlist is empty, so it can never be allowed), or `format` (anything else: not `https://`/`http://`, a bad port, whitespace, longer than 2048 characters). Each is decided from the text alone, without a DNS lookup. |
| `url_not_allowed` | The destination is not allowed: the host does not resolve (or not within the connect timeout), any of its addresses is private, local or reserved and not in `WEBHOOK_ALLOWED_PRIVATE_TARGETS`, `http` or a port below 1024 other than 443 to a destination that is not allowlisted. One code, one message ("Visiban can't send to this address. If it should be allowed, ask your Visiban operator.") and one response time for all of these: every such refusal is held until the DNS deadline (`WEBHOOK_REFUSAL_FLOOR_SECONDS`, default `WEBHOOK_CONNECT_TIMEOUT_SECONDS`), so neither the body nor the timing says which rule matched. It never names a resolved address. |
| `invalid_event_types` | Not a list of distinct strings from `subscribable_event_types`. |
| `limit_reached` | The per-board (10), per-user (25) or per-server (1000) cap. |

## Deliveries

### Request

```http
POST /visiban HTTP/1.1
Host: hooks.example.com
Content-Type: application/json
User-Agent: Visiban-Webhooks/1.3.0
X-Visiban-Event: card.moved
X-Visiban-Event-Id: 4182
X-Visiban-Board-Id: 3
X-Visiban-Subscription-Id: 12
X-Visiban-Timestamp: 1793524471
X-Visiban-Signature: v1=5e0c…

{"id":4182,"event":"card.moved","data":{...},"actor_id":7,"actor":{...},"created_at":"2026-11-01T09:14:03.118000Z","redacted_at":null}
```

The body is one row of the [change feed](events.md), exactly as `GET /boards/{id}/events/` returns it to a **viewer** with no per-user rows: member-private events, admin-only events and viewer-hidden fields are never included, whoever owns the webhook. See [Fields that depend on who is reading](events.md#fields-that-depend-on-who-is-reading).

| Header | Meaning |
|---|---|
| `X-Visiban-Event` | The event type. Ignore types you do not recognize: new ones are added in minor releases. |
| `X-Visiban-Event-Id` | The change-feed id. **Your idempotency key**: delivery is at-least-once, so the same id can arrive twice. `0` is the test event. |
| `X-Visiban-Board-Id`, `X-Visiban-Subscription-Id` | Which board and which webhook. |
| `X-Visiban-Timestamp` | Unix seconds when this request was signed. |
| `X-Visiban-Signature` | `v1=` + hex HMAC-SHA256 of `"{timestamp}.{raw body}"` with the webhook's secret. |

### Response

Answer `2xx` within 10 seconds (`WEBHOOK_TIMEOUT_SECONDS`). Visiban reads only the status line; the response body is discarded and never stored.

Anything else is a failure, including `3xx`: redirects are not followed. After a failure the webhook retries the **same** event after 30 seconds, doubling up to an hour (each delay gets up to 10% added jitter), and later events wait behind it. After 20 consecutive failures or 24 hours of failing (the defaults of `WEBHOOK_DISABLE_AFTER_FAILURES` and `WEBHOOK_DISABLE_AFTER_HOURS`) it is turned off with `disabled_reason: "failures"`, and the board's admins get a `webhook_disabled` [notification](notifications.md) and an email.

### Ordering

Events for one webhook are delivered in increasing `X-Visiban-Event-Id` order. The dispatcher only reads events older than `WEBHOOK_SETTLE_SECONDS` (10) and stops before the oldest newer one, so an event whose transaction committed late is not skipped. That is a best-effort window: until [#2053](https://gitlab.com/visiban/visiban/-/issues/2053) gives the feed a commit-ordered cursor, a transaction held open longer than the window can still land behind the cursor. Treat the change feed as the source of truth when exactness matters.

## Verifying signatures

1. Read the raw request body as bytes, **before** any JSON parsing.
2. Compute HMAC-SHA256 of `timestamp + "." + body` with your secret, hex-encoded, and prefix `v1=`.
3. Compare it with `X-Visiban-Signature` in constant time.
4. Refuse the request if `X-Visiban-Timestamp` is more than 5 minutes from your clock. That limits replay of a captured request.

=== "Python"

    ```python
    import hashlib
    import hmac
    import time

    TOLERANCE_SECONDS = 300

    # headers: a case-insensitive mapping, such as Django's request.headers or Flask's request.headers.
    def verify(secret: str, headers, raw_body: bytes) -> bool:
        timestamp = headers.get("X-Visiban-Timestamp", "")
        signature = headers.get("X-Visiban-Signature", "")
        if not (timestamp.isascii() and timestamp.isdigit()):
            return False
        if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
            return False
        message = timestamp.encode() + b"." + raw_body
        expected = "v1=" + hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)
    ```

=== "Node.js"

    ```javascript
    const crypto = require("node:crypto");

    const TOLERANCE_SECONDS = 300;

    // rawBody must be the unparsed request body (a Buffer), e.g. express.raw({ type: "application/json" }).
    function verify(secret, headers, rawBody) {
      const timestamp = headers["x-visiban-timestamp"] || "";
      const signature = headers["x-visiban-signature"] || "";
      if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
        return false;
      }
      const expected =
        "v1=" +
        crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    ```

Test vector: secret `whsec_test`, timestamp `1700000000`, body `{"a":1}` gives
`v1=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789`.

The [Python and TypeScript clients](events.md#using-the-client) ship this check as `verify_signature` / `verifySignature` (experimental, and tested against the vector above), so a consumer that both polls and receives pushes can use one package.

## Stability

These endpoints are new in 1.3. The endpoints, the subscription object, the delivery headers, the body shape and the signature scheme may change in a 1.3 pre-release, and become part of the 1.x contract at 1.3.0 GA ([#2070](https://gitlab.com/visiban/visiban/-/issues/2070)). The delivery body is a change-feed row, so it follows the [change feed's stability rules](events.md#stability-and-versioning).
