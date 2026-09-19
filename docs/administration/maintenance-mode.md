# Maintenance Mode

> **Added in 1.2**

Maintenance mode puts a Visiban instance into **read-only mode** for the duration of an
upgrade or a migration. It exists so an operator can stop concurrent writes without stopping
the instance — reads, and the operator's own access, keep working throughout.

This page covers when to use it, how to turn it on and off, what everyone else sees while
it's active, and how to recover if something goes wrong mid-window. For the API shape, see
[Maintenance mode](../api/admin.md#maintenance-mode) in the API reference.

## When to use it

Reach for maintenance mode when the thing you want to prevent is **concurrent writes**, not
the upgrade itself — for example, running a data-integrity script, or a migration that is
technically zero-downtime-safe but you'd rather nobody move a card while it runs. It is the
softer alternative to taking the instance fully offline.

If you're following the [Standard upgrade steps](upgrade.md#standard-upgrade-steps) or the
[Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md), most 1.x releases don't need a
maintenance window at all — Visiban's migrations are additive-only by rule. Turn maintenance
mode on only when you specifically want to freeze writes, and off again once you're done.

## Turning it on

From **Admin → Settings → Maintenance**:

| Control | Effect |
|---|---|
| **Maintenance mode** toggle | When on, every write from a non-admin is rejected with `503 Service Unavailable`. Reads keep working. |
| **Message** | Plain-text notice (max 1000 characters) shown to everyone while maintenance mode is on. Leave it blank to use the built-in default. |

Turning the toggle **on** asks for inline confirmation — "Enable maintenance mode? All
non-admin users will immediately lose write access." — since it's an instance-wide,
immediate-effect change. Turning it **off** does not prompt: exits are never gated behind a
confirmation, only the transition that removes access is.

!!! tip "Put an end time in the message"
    A notice with no ETA is the one people find most frustrating: "changes are disabled" with
    no sense of for how long reads as either trivial or alarming, depending on the reader. Say
    when you expect to be finished — for example, *"Upgrading to 1.2 — back by 14:00 UTC."*

The setting lives on the database, so it survives a restart, and it takes effect immediately
for every worker — there is no need to restart the service or wait for a cache to expire.

## What everyone else sees

- **Reads keep working.** Boards, cards, comments and history all stay visible. This is a
  read-only mode, not an outage, so nobody loses access to information they need mid-incident.
- **Writes are blocked** — creating, editing, moving, archiving and deleting all fail with a
  `503` and a `maintenance_mode` error. This covers the REST API and the MCP write tools alike.
- **Every signed-in user sees the notice** — a non-dismissible amber banner — until you turn
  maintenance mode back off.
- **Site admins are exempt** and keep full read/write access, whether they're signed in
  through the browser or using a personal access token. Admins still see the notice, so they
  can tell at a glance that the instance is not in its normal state.

!!! warning "You cannot lock yourself out"
    Signing in, signing out, password reset, the forced password/username change flows, SSO
    login callbacks, the health probes and the whole admin API stay writable while maintenance
    mode is on. Turning it back off is always reachable, even from a signed-out browser.
    Self-registration, profile edits and token creation are **not** exempt — they are blocked
    like any other write. To stop new sign-ups specifically, use
    [Registration mode](admin-panel.md#registration-mode) instead.

## Known limitation: an already-open tab can lag behind

Nothing pushes maintenance state to a browser tab that is already open — there is no
WebSocket event for it. A tab only learns the instance is in maintenance mode in one of two
ways:

- **It tries to write.** The `503` response tells the client immediately, and the banner
  appears at that point.
- **It regains focus.** Coming back to a tab re-checks the current user, throttled to at most
  once every 30 seconds, so a tab that was in the background picks up the change on refocus.

A user who is idling on an open tab — not writing, not switching away — will not see the
banner appear or disappear the instant you flip the toggle. Don't assume every open session
updates the moment you act; if you need everyone to see the notice immediately, say so in
another channel (chat, status page) rather than relying on the banner alone.

## Who turned it on? — the action log

> **Added in 1.2**

Every flip of the maintenance mode toggle is recorded, so an incident retrospective can
answer "who put us into maintenance, and when did it end?" without guesswork. Each entry
records the actor, the time, whether it went on or off, and the notice that was in force.

Read it from [`GET /api/v1/admin/action-log/`](../api/admin.md#action-log):

```bash
curl -s https://visiban.example.com/api/v1/admin/action-log/?action=maintenance_mode.enabled \
  -H "Authorization: Token vbn_…"
```

The same log also covers the other two instance-wide toggles — [registration
mode](admin-panel.md#registration-mode) and file uploads — so it is the single place to look
for "who changed an instance setting".

Changes made from the admin panel, the `maintenance_mode` management command below, and the
[Django admin](django-admin.md) are all recorded, each tagged with which route was used. A
command-line change has no signed-in user to attribute, so it is recorded with no actor and
`source: "cli"`.

!!! warning "An empty log does not prove nothing happened"
    A change written straight to the database — `manage.py shell`, or `psql` — has no actor to
    record and leaves no entry. Every route an operator would normally use is covered, but
    treat an empty log as "no audited path made this change", not as proof the setting was
    never touched.

Setting a value to the one it already holds is not recorded: the log contains real
transitions only, so the gap between an `enabled` entry and the next `disabled` entry is the
actual duration of the maintenance window.

The log covers the instance-wide settings on the Admin → Settings tab. It does **not** yet
cover user management — granting site admin, deactivating an account, or issuing an invite
link leaves no entry.

!!! warning "The audit write is part of the change"
    A setting change and its log entry commit together: if the entry cannot be written, the
    change is rejected rather than applied unrecorded. That is the right trade for an audit
    trail, but it means a database fault specific to the `admin_action_logs` table would block
    the admin panel, the management command *and* the Django admin from toggling maintenance
    mode — during exactly the incident when you need it. The last resort is then to write the
    setting directly, which bypasses the audit path (and so records nothing):

    ```sql
    UPDATE site_settings SET maintenance_mode = false WHERE id = 1;
    ```

    Workers pick this up within 60 seconds, once the cached value expires — the usual instant
    invalidation does not run on this path. Use it only when every audited route is unavailable,
    and note what you did somewhere durable, because the log will not.

## Turning maintenance mode off from the shell

If the web UI is unreachable — a broken ingress, a bad deploy — maintenance mode can be
cleared from any container with database access:

```bash
# Show the current state
python manage.py maintenance_mode

# Turn it on, with a message
python manage.py maintenance_mode --on --message "Upgrading to 1.3 — back by 14:00 UTC."

# Turn it back off
python manage.py maintenance_mode --off
```

Changes take effect immediately, exactly as they do from the admin panel. This is the
break-glass path for an operator with shell access but no working ingress.

Maintenance mode is also editable from the [Django admin](django-admin.md) as a second
break-glass route — `Site settings` has exactly one row, and edits there go through the same
save path, so the cache invalidation still fires.

## Related pages

- [Admin Panel](admin-panel.md#settings-tab) — the Settings tab this control lives on, and the
  other instance-wide toggles alongside it
- [Maintenance mode](../api/admin.md#maintenance-mode) — the API reference: request/response
  shapes, the `503` error body, and MCP behavior
- [Action log](../api/admin.md#action-log) — the audit trail of who changed which
  instance-wide setting, and when
- [Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md#3-when-this-playbook-doesnt-apply) — when maintenance mode is the right tool versus scaling to zero
- [Upgrading Visiban](upgrade.md#standard-upgrade-steps) — the Docker Compose upgrade sequence maintenance mode is designed to wrap
