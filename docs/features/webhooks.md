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
- **Retention.** Events stay in the feed for `BOARD_EVENT_RETENTION_DAYS` (30 by default). When history cleanup removes an event a webhook has not sent yet, the webhook is turned off with the reason *fell too far behind*, rather than skipping what it missed. This is exact: `prune_board_events` records the highest event it removed from each board, so it applies even when every missed event was removed and nothing newer has happened, and when the missed event is one whose delivery was failing. A webhook that missed nothing keeps sending, however long it was idle or turned off. The record is per board, so a webhook can also be turned off when the only events removed were ones it would never have been sent (another person's stars or saved filters, admin-only events, or types it does not subscribe to). If you schedule `prune_board_events` from host cron or a separately pinned image, keep it on the same version as the backend: an older pruner removes events without recording them, and a webhook then cannot report the loss.
- **Deleting the board** deletes its webhooks. A `board.deleted` event is never sent.

Delivery is best-effort with retry. If your integration needs every event with certainty, have it read the change feed itself; webhooks are the convenient path, not the guaranteed one.

## What is sent

Every request body is one change-feed event, exactly as [`GET /boards/{id}/events/`](../api/events.md) returns it to a **viewer**. Its `data` is the event's WebSocket payload; see the [event reference](../api/websockets.md#event-reference) for each event's shape. A `card.moved` body looks like this:

```json
{
  "id": 4182,
  "event": "card.moved",
  "data": {
    "card": { "id": 311, "column": 14, "swimlane": 3, "position": 0, "...": "..." },
    "movement": { "from_column": 12, "to_column": 14, "...": "..." },
    "sibling_positions": [{ "id": 305, "position": 1, "version": 4 }]
  },
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

An event's `data` can also gain fields in a later version, so receivers should ignore keys they do not recognize. For example, since 1.3 a `card.moved` body carries `sibling_positions`, the other cards whose position the move changed (see [Sibling positions on `card.moved`](../api/websockets.md#sibling-positions-on-cardmoved-since-13)).

## Set up a webhook (board admins)

1. Open the board, then **Board settings → Webhooks**.
2. Choose **Add webhook**, paste the receiver's address, and choose **All events** or **Only these events**.
3. Choose **Create webhook**. Visiban shows the **signing secret once**, above the list. Copy it into your receiver, tick **I've stored this secret somewhere safe**, then choose **Done**. Until you tick it, Board settings will not close by accident: Escape and Close ask first. If you lose the secret, rotate it.
4. Open the webhook with **Manage** and choose **Send test event**. Visiban sends a `webhook.test` event straight away and shows what your receiver answered and how long it took.

After you save, Visiban shows the address only as `host/…/last4`, because webhook addresses often carry a token. To change it, enter the full new address.

### Rotate a signing secret

Open the webhook with **Manage**, choose **Rotate secret…**, then one of:

- **Keep old secret for 24 hours.** Visiban signs each delivery with both secrets for 24 hours, so your receiver keeps working while you give it the new one. The webhook shows **Old secret still signed until…** while this lasts. Your receiver's check must accept any signature the header lists ([how to verify](../api/webhooks.md#verifying-signatures)); one that compares the whole header rejects every delivery during those 24 hours. The API allows up to seven days.
- **Revoke old secret now.** Only the new secret signs from now on, and your receiver rejects deliveries until you update it.

Either way the new secret is shown once, so until it arrives you can't close Board settings, switch tabs or go back to the list. Rotating again during the 24 hours keeps only the secret you just replaced, so update your receiver right after. Changing the webhook's address ends the overlap too.

If a rotation reports that it couldn't be confirmed, it may have gone through with its response lost, and that secret can't be shown. If that happened with **Keep old secret for 24 hours**, the webhook shows **Old secret still signed until…**, as long as Visiban could re-read it after the error; reload the page if you are unsure. Rotate again to get a secret you can copy, then update your receiver right away, because a second rotation stops signing with the secret your receiver holds.

!!! warning "If the secret leaked, revoke it and replace it on your receiver"
    Visiban can't revoke a secret for you. Anyone holding it can forge requests that your receiver accepts until your receiver stops accepting it. **Revoke old secret now** only stops Visiban's own signatures with it, so replace the secret on your receiver as well.

Creating a webhook, changing its address, turning it back on and rotating its secret need a signed-in browser session; a personal access token cannot do them. Listing, changing the event types, turning off and deleting work with a token too.

### Who owns a webhook

A webhook keeps delivering only while the person who last set it up (created it, changed its address, rotated its secret, or turned it back on) is still an active admin of the board. If that person loses admin access, by demotion, removal from the board or a group, deactivation, account deletion or a forced password change, the webhook is turned off at its next run. Another board admin can **take it over**: that turns it back on with them as the owner, and asks for their current password first (or, for an account that signs in through SSO, a fresh SSO sign-in).

### Notices

When a webhook is turned off automatically, every admin of the board, and the person who last set the webhook up if they still administer the board (a site admin who isn't a member, for example), gets an in-app notification and an email. The email is sent whatever your email notification settings are, but only to a verified address. The notice says exactly three things: the board, the webhook's number, and the reason code with its plain-language label. It never contains the address, the host, or anything the receiver sent back. **Open board settings** in the notification goes straight to the Webhooks tab.

Turning a webhook off yourself sends no notice.

### Turn on again

Turning a webhook back on is always confirmed, and the confirmation says what will happen:

- After **repeated delivery failures** or a manual turn-off: sending resumes with the events it missed.
- After it **fell too far behind** (history cleanup removed events it had not sent): it starts with new events, and the gap is never sent.
- After **its creator lost access**: you take it over (see above).

A webhook turned off because its stored address or secret can no longer be read (usually after the server's secret key changed) cannot be turned back on. Delete it and create a new one.

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

    Run one pass a minute; it exits after at most about a minute, plus up to 30 seconds if a notice email is still sending:

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

- A **hostname** entry admits that exact host on a private address (RFC 1918, carrier-grade NAT `100.64.0.0/10`, IPv6 unique-local, or IPv6 site-local).
- A **CIDR or IP** entry admits private addresses inside it.
- **Loopback, link-local and cloud metadata addresses** are admitted only by an exact single-address entry, such as `127.0.0.1` or `::1/128`. A range never admits them.
- `http://` and ports below 1024 other than 443 are allowed only for allowlisted destinations.
- `0.0.0.0/8`, multicast and reserved ranges are never admitted. A `/0` or a public range is a startup error (`webhooks.E002`).

A board admin who tries to save a destination that is not allowed sees one message, which says to ask the operator. It does not name this setting, and it is the same whatever the reason, so it reveals nothing about the network.

### Limits and tuning

All settings, with their defaults, are in [Configuration — Webhooks](../administration/configuration.md#webhooks): timeouts, retry and turn-off thresholds, and caps of 10 webhooks per board, 25 per user and 1000 per server.

### Secret key rotation

Webhook URLs and secrets are stored encrypted with a key derived from `DJANGO_SECRET_KEY`, unless `VISIBAN_SECRET_ENCRYPTION_KEY` is set. Rotating the key without that variable makes every stored webhook unreadable; each one turns off with *stored secret could not be decrypted* and must be recreated. See [Secret rotation](../administration/secret-rotation.md).
