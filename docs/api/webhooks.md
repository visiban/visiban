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
| Not signed in | `401` / `403` |
| No access to the board | `404` (the endpoint does not confirm the board exists) |
| Board role below admin | `403` |
| `WEBHOOKS_ENABLED` off (or `DEMO_MODE` on), any action but `status/` | `403 {"code": "webhooks_disabled"}` |
| A personal access token on a session-only action | `403 {"code": "session_required"}` |
| A subscription id that belongs to another board | `404` |

Board admins and site admins (`can_access_all_content`) may use every action. **Session-only** actions are the ones that choose where data goes or how it is signed: create, a `PATCH` that changes `url`, `reenable`, `rotate` and `test`. They refuse personal access tokens and any other non-session credential.

## Endpoints

| Method and path | Session only | Notes |
|---|---|---|
| `GET status/` | | Always `200` for a board admin, whether webhooks are on or off. |
| `GET /` | | List the board's webhooks. Not paginated (at most 10 per board by default). |
| `POST /` | yes | Create. `201`. Throttle scope `webhook_config` (30/hour per user). |
| `GET {id}/` | | One webhook. |
| `PATCH {id}/` | only when `url` is present | Any of `name`, `event_types`, `url`. |
| `DELETE {id}/` | | `204`. |
| `POST {id}/disable/` | | Turn off; `disabled_reason` becomes `manual`. Idempotent. No notice is sent. |
| `POST {id}/reenable/` | yes | Body `{"resume_from": "cursor" \| "latest"}`, default `cursor`. |
| `POST {id}/rotate/` | yes | New signing secret, returned once. Throttle scope `webhook_config`. |
| `POST {id}/test/` | yes | Send a `webhook.test` event now. Throttle scope `webhook_test` (10/hour per user). |

`PUT` is not supported.

### `GET status/`

```json
{
  "enabled": true,
  "dispatcher_last_run_at": "2026-11-01T09:14:30.002000Z",
  "dispatcher_stale": false,
  "subscribable_event_types": ["board.created", "board.updated", "card.archived", "card.created", "..."]
}
```

- `dispatcher_last_run_at` is when the dispatcher last finished (or, failing that, started) a run, or `null` if it never has.
- `dispatcher_stale` is `true` when that is `null` or older than `WEBHOOK_DISPATCHER_STALE_SECONDS` (300 by default).
- `subscribable_event_types` is the complete list `event_types` may contain, sorted. It is the board-channel event registry minus per-user events, admin-only events, `ping` and `board.deleted`. Build pickers from it; it grows when new event types are added.

### The subscription object

```json
{
  "id": 12,
  "board": 3,
  "name": "Deploys",
  "url_display": "https://hooks.example.com/…",
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
| `url_display` | `scheme://host/…`. The path, query and port are never returned after creation: for many services the path is the credential. |
| `event_types` | Empty list = every subscribable type, including types added in later versions. |
| `disabled_reason` | `null` while enabled; otherwise `manual`, `failures`, `cursor_expired`, `creator_lost_access` or `secret_unavailable`. |
| `last_delivered_event_id` | The change-feed id the webhook has delivered (or skipped by type) up to. |
| `last_error_code` | `""`, or `connection_failed`, `tls_error`, `timeout` or `http_error`. Never the receiver's response or an exception message. |
| `last_status_code` | The HTTP status of the last attempt, or `null` when no response was received. |
| `configured_by` | The owner: the account whose board-admin standing keeps the webhook delivering. Set on create, URL change, rotate and re-enable. `null` once that account is deleted, and the webhook then turns off. |

### `POST /` — create

Body: `url` (required), `name` (optional, at most 200 characters), `event_types` (optional, default `[]`).

The `201` response is the subscription object plus `url` and `secret`, with `Cache-Control: no-store`. **This is the only response that contains them.** The secret is `whsec_` followed by 43 URL-safe characters.

A new webhook starts at the board's newest event: nothing earlier is delivered.

### `PATCH {id}/`

Send only the keys you change. Changing `url` validates it again, makes the caller the owner (`configured_by`), and leaves the secret unchanged.

### `POST {id}/reenable/`

Resets the failure state and makes the caller the owner.

| `resume_from` | Result |
|---|---|
| `cursor` (default) | Delivers what was missed since the webhook stopped. `409 {"code": "cursor_expired"}` if those events were already pruned from the feed. |
| `latest` | Skips to new events. |

`409 {"code": "secret_unavailable"}` when the stored URL or secret can no longer be decrypted (the instance encryption key changed). Delete the webhook and create a new one.

### `POST {id}/rotate/`

Returns the subscription object plus a new `secret`, with `Cache-Control: no-store`. The old secret stops working immediately; a delivery already in flight may still be signed with it, and it is retried with the new secret if your receiver rejects it.

### `POST {id}/test/`

```json
{"ok": true, "code": null, "status_code": 204}
{"ok": false, "code": "http_error", "status_code": 500}
{"ok": false, "code": "timeout", "status_code": null}
```

Sends the event below, synchronously, with the same headers and signature as a real delivery. It does not move the cursor or count as a failure. A disabled webhook can be tested.

```json
{"id": 0, "event": "webhook.test", "data": {"subscription_id": 12, "board_id": 3}, "actor_id": null, "actor": null, "created_at": "2026-11-01T09:20:00.000000Z"}
```

### Validation errors

Every refusal of the request body has the 1.1 machine-error shape, `{"detail": "...", "code": "..."}`, with a string `code`:

| `code` | When |
|---|---|
| `invalid_url` | Not an `https://` or `http://` URL, contains a username or password, a bad port, whitespace, or longer than 2048 characters. |
| `url_not_allowed` | The destination is not allowed: the host does not resolve, any of its addresses is private, local or reserved and not in `WEBHOOK_ALLOWED_PRIVATE_TARGETS`, `http` to a destination that is not allowlisted, or a port below 1024 other than 443 to one that is not. One code and one message for all of these. |
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
X-Visiban-Timestamp: 1761988471
X-Visiban-Signature: v1=5e0c…

{"id":4182,"event":"card.moved","data":{...},"actor_id":7,"actor":{...},"created_at":"2026-11-01T09:14:03.118000Z"}
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

Anything else is a failure, including `3xx`: redirects are not followed. After a failure the webhook retries the **same** event after 30 seconds, doubling up to an hour, and later events wait behind it. After 20 consecutive failures or 24 hours of failing it is turned off, and the board's admins get a `webhook_disabled` [notification](notifications.md) and an email.

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

    def verify(secret: str, headers, raw_body: bytes) -> bool:
        timestamp = headers.get("X-Visiban-Timestamp", "")
        signature = headers.get("X-Visiban-Signature", "")
        if not timestamp.isdigit() or abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
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

## Stability

The webhook endpoints, the subscription object, the delivery headers, the body shape and the `v1` signature scheme are intended to be declared stable for 1.x when 1.3 is released, under the [API versioning policy](../architecture/api-versioning.md): fields and event types are added, never removed or retyped. Until then, in 1.3 pre-releases, they may still change. A future signature scheme would be sent alongside `v1=` in the same header before `v1` is retired. The delivery body is a change-feed row, so it already follows the [change feed's stability rules](events.md#stability-and-versioning).
