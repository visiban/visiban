# Webhooks

<a id="webhooks"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

A board admin can register a URL that receives a signed HTTP `POST` for every change on the board. It lets you connect a board to Zapier, n8n, a Slack incoming-webhook bridge, or your own script without writing a polling loop.

**Why it matters:** an integration hears about a card move within seconds, with the same payload the [change feed](../api/events.md) returns, and can check that each request really came from your Visiban server.

!!! note "Off by default"
    Webhooks are disabled until an operator sets `WEBHOOKS_ENABLED=true` **and** starts the webhook dispatcher. While they are off, the board's **Webhooks** settings tab says so, and the API refuses every webhook action except the status check.

**Go deeper:** the endpoint reference, the payload, the headers and signature-verification code are in [API Reference — Webhooks](../api/webhooks.md).

## How delivery works

Each webhook is a cursor into its board's [change feed](../api/events.md). The dispatcher, a small background process, reads the events after the cursor in order, sends each one, and moves the cursor forward when your receiver answers with a `2xx` status. There is no separate queue.

What follows from that design:

- **Order.** Events reach one webhook in `event_id` order.
- **At least once.** If the dispatcher stops between sending an event and recording it, the event is sent again. Use the `X-Visiban-Event-Id` header to discard duplicates.
- **A failing receiver holds its own webhook back.** After a failure the webhook waits (30 seconds, then 1, 2, 4 minutes and so on, up to an hour) and retries the same event. Later events wait behind it, so order holds. Other webhooks are not affected.
- **Automatic turn-off.** After 20 failures in a row, or 24 hours of failing, the webhook is turned off and the board's admins are told (see [Notices](#notices)).
- **Starting point.** A new webhook starts with the next event. Nothing that happened before it was created is sent.
- **Latency.** Events are sent about 10 to 25 seconds after they happen. The dispatcher waits a few seconds so that events from slow transactions are not skipped.
- **Retention.** Events stay in the feed for `BOARD_EVENT_RETENTION_DAYS` (30 by default). A webhook that falls further behind than that is turned off with the reason *fell too far behind*, rather than silently skipping what it missed.
- **Deleting the board** deletes its webhooks. A `board.deleted` event is never sent.

Delivery is best-effort with retry. If your integration needs every event with certainty, have it read the change feed itself; webhooks are the convenient path, not the guaranteed one.

## What is sent

Every request body is one change-feed event, exactly as [`GET /boards/{id}/events/`](../api/events.md) returns it to a **viewer**:

```json
{
  "id": 4182,
  "event": "card.moved",
  "data": { "id": 311, "column": 14, "swimlane": 3, "...": "..." },
  "actor_id": 7,
  "actor": { "id": 7, "username": "maya", "display_name": "Maya", "avatar_url": "" },
  "created_at": "2026-11-01T09:14:03.118000Z"
}
```

The receiver is outside the board, so it gets the narrowest view the board offers, whoever set the webhook up:

- Members' private activity (stars, saved filters) is never sent.
- Admin-only events (share-link changes) are never sent.
- Fields a viewer cannot see, such as moderator flags and admin-only swimlane values, are removed.

You can limit a webhook to some event types. **All events** also includes event types added in later versions; receivers should ignore an `event` they do not recognize.

## Set up a webhook (board admins)

1. Open the board, then **Board settings → Webhooks**.
2. Choose **New webhook**, give it a name, paste the receiver's URL, and choose **All events** or the events you want.
3. Choose **Create webhook**. Visiban shows the full URL and the **signing secret once**. Copy the secret into your receiver now; you cannot see it again. If you lose it, rotate it.
4. Choose **Send test**. Visiban sends a `webhook.test` event straight away and shows what your receiver answered.

Creating, re-pointing, re-enabling, rotating and testing a webhook need a signed-in browser session; a personal access token cannot do them. Listing, renaming, changing the event types, disabling and deleting work with a token too.

### Who owns a webhook

A webhook keeps delivering only while the person who last set it up (created it, changed its URL, rotated its secret, or re-enabled it) is still an active admin of the board. If that person loses admin access, by demotion, removal from the board or a group, deactivation or account deletion, the webhook is turned off at its next delivery. Any other board admin can re-enable it, which makes them the owner.

### Notices

When a webhook is turned off automatically, every admin of the board gets an in-app notification and an email. The email is sent whatever your email notification settings are, but only to a verified address. The notice names the board, the webhook's number and the reason. It never contains the URL or anything the receiver sent back.

Turning a webhook off yourself sends no notice.

### Re-enable

**Re-enable** asks where to resume:

- **Send the events it missed** (the default) delivers everything since the webhook stopped, if it is still in the feed.
- **Skip to new events only** starts with the next event.

If the missed events have already been removed by history cleanup, only the second option is offered.

A webhook turned off because its stored URL or secret can no longer be read (usually after the server's secret key changed) cannot be re-enabled. Delete it and create a new one.

## For operators

### Turn webhooks on

Set `WEBHOOKS_ENABLED=true` on the backend and start the dispatcher. Webhooks cannot be enabled on a public demo (`DEMO_MODE`): the backend refuses to start with both.

=== "Docker Compose"

    Add to `.env`:

    ```bash
    WEBHOOKS_ENABLED=true
    COMPOSE_PROFILES=webhooks          # comma-separate with scheduler / letsencrypt
    ```

    Then `docker compose -f docker-compose.prod.yml up -d`. The `webhook-dispatcher` service runs `manage.py dispatch_webhooks --loop --interval 15`.

=== "Helm"

    ```yaml
    backend:
      settings:
        webhooksEnabled: true
    webhooks:
      dispatcher:
        enabled: true
    ```

    This renders a one-replica `webhook-dispatcher` Deployment. If you enforce egress NetworkPolicies, allow that pod to reach your webhook destinations; the chart adds no egress policy for it.

=== "Host cron"

    Run one pass a minute; it exits after at most about a minute:

    ```cron
    * * * * * cd /app && python manage.py dispatch_webhooks
    ```

Running more than one dispatcher at once is safe: each webhook is claimed by one dispatcher at a time, so no event is sent twice because of an overlap.

The **Webhooks** tab warns board admins when the dispatcher has not run for five minutes (`WEBHOOK_DISPATCHER_STALE_SECONDS`), so a stopped dispatcher does not go unnoticed.

### Private and LAN destinations

By default a webhook may only target public internet addresses over `https`. Visiban checks every address the URL's host resolves to, when the webhook is saved and again on every delivery, and connects only to the address it checked. Redirects are not followed.

To let webhooks reach a service on your own network, such as a self-hosted n8n, list it in `WEBHOOK_ALLOWED_PRIVATE_TARGETS`:

```bash
WEBHOOK_ALLOWED_PRIVATE_TARGETS=n8n.lan,192.168.10.0/24
```

- A **hostname** entry admits that exact host on a private address (RFC 1918, carrier-grade NAT `100.64.0.0/10`, or IPv6 unique-local).
- A **CIDR or IP** entry admits private addresses inside it.
- **Loopback, link-local and cloud metadata addresses** are admitted only by an exact single-address entry, such as `127.0.0.1` or `::1/128`. A range never admits them.
- `http://` and ports below 1024 other than 443 are allowed only for allowlisted destinations.
- `0.0.0.0/8`, multicast and reserved ranges are never admitted. A `/0` or a public range is a startup error (`webhooks.E002`).

A board admin who tries to save a destination that is not allowed sees one message, which names this setting and says to ask the operator.

### Limits and tuning

All settings, with their defaults, are in [Configuration — Webhooks](../administration/configuration.md#webhooks): timeouts, retry and turn-off thresholds, and caps of 10 webhooks per board, 25 per user and 1000 per server.

### Secret key rotation

Webhook URLs and secrets are stored encrypted with a key derived from `DJANGO_SECRET_KEY`, unless `VISIBAN_SECRET_ENCRYPTION_KEY` is set. Rotating the key without that variable makes every stored webhook unreadable; each one turns off with *stored secret could not be decrypted* and must be recreated. See [Secret rotation](../administration/secret-rotation.md).
