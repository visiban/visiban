# Run the instance with the admin API

Close self-registration with one site-admin `PATCH`:

```bash
curl -X PATCH -H "Authorization: Token $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"registration_mode": "invite_only"}' http://localhost:8000/api/v1/admin/settings/
```

Changes take effect within about 60 seconds, with no restart.

**Why it matters:** every endpoint here changes the whole instance, so a non-admin call fails with `403 Forbidden`.

**Go deeper:** [Site settings](#site-settings), [Action log](#action-log), [Email settings](#email-settings), [Maintenance mode](#maintenance-mode), [Users](#users), [Invite links](#invite-links), [Board invites](#board-invites).

**The big picture:** site-wide settings, the action log, email configuration, maintenance mode, users, invite
links, and board invites — administrative endpoints, restricted to site admins.

All endpoints below require **site admin** authentication; non-admin users receive `403 Forbidden`.

See [Admin Panel](../administration/admin-panel.md) for the equivalent UI and [Site Admins](../administration/site-admins.md) for first-boot setup.

The Issue Board Lens has its own admin-only usage endpoint, documented separately: see
[Issue Board Lens API → Admin usage](git-lens.md#admin-usage).

---

## Site settings

### `GET /api/v1/admin/settings/`
Return the current instance-wide settings.

**Response**
```json
{
  "registration_mode": "open",
  "uploads_enabled": true,
  "maintenance_mode": false,
  "maintenance_message": ""
}
```

| Field | Type | Description |
|---|---|---|
| `registration_mode` | `"open"` / `"invite_only"` / `"closed"` | Controls who can self-register |
| `uploads_enabled` | boolean | When `false`, attachment uploads are blocked for all users |
| `maintenance_mode` | boolean | When `true`, non-admin write requests are rejected with `503`. Defaults to `false`. Added in 1.2. |
| `maintenance_message` | string | Plain-text notice shown while maintenance mode is active. Max 1000 characters. Blank means "use the built-in default". Added in 1.2. |

### `PATCH /api/v1/admin/settings/`
Update site settings. All fields are optional.

**Request**
```json
{ "registration_mode": "invite_only", "uploads_enabled": false }
```

Changes take effect within approximately 60 seconds (server-side cache TTL) — no restart required.

Every change to `registration_mode`, `uploads_enabled`, `maintenance_mode` and
`maintenance_message` is recorded in the [action log](#action-log). Submitting a field with
the value it already holds is not a change and records nothing.

---

## Action log

> **Added in 1.2**

### `GET /api/v1/admin/action-log/`

Return the audit trail of instance-wide admin actions, newest first. Site-admin only — an
audit trail of privileged actions is itself sensitive, since it shows when the instance was
unattended and who holds admin rights.

Read-only: there is no write or delete endpoint. Rows are appended by the actions themselves,
and an audit log an admin can edit is not evidence of anything.

**Query parameters**

| Param | Description |
|---|---|
| `action` | Return only rows with this action. An unrecognized value is a `400`, not an empty page. |
| `offset` / `page_size` | Standard pagination (default 50, max 200). |

**Response**
```json
{
  "count": 2,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 2,
      "action": "maintenance_mode.disabled",
      "actor_id": 4,
      "actor_username": "alice",
      "source": "admin_api",
      "metadata": { "message": "Upgrading to 1.2 — back by 14:00 UTC." },
      "created_at": "2026-09-18T14:02:11Z"
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique row id |
| `action` | string | What happened, as `<subject>.<verb>` — see the table below |
| `actor_id` | integer / null | User who performed the action; `null` when the action has no recorded actor (most management commands; `purge_card_history` records the superuser named by its `--actor` option). May reference an account that has since been deleted |
| `actor_username` | string | Username captured at the time of the action; `""` when the action has no recorded actor |
| `source` | `"admin_api"` / `"django_admin"` / `"cli"` | Which operator path was used |
| `metadata` | object | Action-specific detail. Keys are additive-only |
| `created_at` | string | ISO 8601 timestamp |

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "'<value>' is not a valid action.", "code": "invalid_query_param"}` | The `action` query param does not match one of the values in the table below |

**Actions**

| `action` | `metadata` |
|---|---|
| `maintenance_mode.enabled` | `{"message": "<the notice users will now see>"}` |
| `maintenance_mode.disabled` | `{"message": "<the notice users saw during the window>"}` |
| `maintenance_message.changed` | `{"from": "...", "to": "..."}` |
| `registration_mode.changed` | `{"from": "open", "to": "closed"}` |
| `uploads_enabled.enabled` | `{}` |
| `uploads_enabled.disabled` | `{}` |
| `email_settings.source_changed` | `{"from": "env", "to": "database"}` |
| `email_settings.server_changed` | `{"from": "old.example.org:587 (starttls)", "to": "smtp.example.org:465 (ssl)"}` |
| `email_settings.from_email_changed` | `{"from": "...", "to": "..."}` |
| `email_settings.username_changed` | `{}` |
| `email_settings.password_changed` | `{}` |
| `email_settings.test_sent` | `{"result": "success"}` or `{"result": "failure"}` |
| `user.password_set` | `{"target_id": 42, "target_username": "jordan"}` (password set on an existing account, or a user added with a password, in the Django admin; also written with `source` `cli` and no actor by `createsuperuser`, `ensure_site_admin`, `provision_fuzz_token --set-random-password` and `changepassword`; written with `source` `admin_api` and the acting admin when an account is created through `POST /api/v1/admin/users/`) |
| `user.password_disabled` | `{"target_id": 42, "target_username": "jordan"}` |
| `card_history.purged` | `{"selector": {"card_uid": "3f9a0c1d2e4b5a69", "board_id": 42, "board_uid": "a1b2c3d4e5f60718", "since": null, "before": "2026-01-01T00:00:00+00:00", "include_live_cards": false}, "deleted_count": 12}` (written with `source` `cli` by the `purge_card_history` command, with the superuser named by its `--actor` option as the actor, unlike the commands above; selector keys not given are `null`; purged titles and notes are never recorded) |

New action types may be added in any minor release; treat an unrecognized `action` as an
opaque string rather than failing on it.

!!! note "Email credentials are recorded as markers, without values"
    `email_settings.password_changed` and `email_settings.username_changed` carry an empty
    `metadata` on purpose. The password is a credential, and an SMTP username is routinely
    an email address — neither belongs in a table whose rows are never rewritten. That a
    change happened, by whom, and when is the auditable part. `email_settings.test_sent`
    likewise records the outcome but never the recipient.

!!! note "Administrator-set passwords"
    `user.password_set` and `user.password_disabled` are recorded with `source` `django_admin`
    when an administrator saves another account's **Password** form in the
    [Django admin](../administration/django-admin.md). `user.password_set` is also recorded when an
    administrator adds a user with a password there; no entry is written for a user added with
    password sign-in disabled. `metadata` names the account concerned; the password and its hash
    are never stored. Changing your own password is not recorded.

    Creating an account with `POST /api/v1/admin/users/` records `user.password_set` with `source`
    `admin_api` and the acting admin. The `createsuperuser`, `ensure_site_admin`,
    `provision_fuzz_token --set-random-password` and `changepassword`
    management commands also record `user.password_set`, with `source` `cli` and no actor (`actor_id` is
    null). The entry is written in the same transaction as the password, so the password is
    only changed when the entry is saved. `createsuperuser` writes an entry only when a password
    is set; an account created without one (`--noinput` with no `DJANGO_SUPERUSER_PASSWORD`) has
    no usable password and writes none, as with a user added without a password in the Django admin. The demo seed (`seed_demo_data --demo-site`)
    writes no entries: it runs only with `DEMO_MODE=true`, and the demo's hourly reset empties
    the log.

!!! warning "What this log does *not* record yet"
    The instance-wide settings, the password events and the card-history purges listed above
    are covered. Granting or
    revoking site admin, changing `can_access_all_content`, deactivating a user, and creating or
    revoking invite links are **not** recorded — so this is not yet a complete record of
    privileged activity.
    Do not read an absence of entries as evidence that no admin action took place.

!!! warning "The acting admin's username is retained indefinitely"
    `actor_username` is stored verbatim and is **not** cleared when the account is deleted —
    unlike, for example, group and invite-link creators, which report `null` once anonymized.
    This is deliberate: an audit record that cannot name the actor cannot answer the question
    it exists for. Operators with data-erasure obligations should account for this table.

!!! note "Direct database writes are not captured"
    Rows are written by the admin API, the `maintenance_mode` management command, the
    password management commands (`ensure_site_admin`, `createsuperuser`, `changepassword`,
    `provision_fuzz_token`), the `purge_card_history` management command, and the Django admin. A change made straight through the ORM (`manage.py shell`) has no actor to
    record and leaves no row, so an empty log means "no audited path made this change" — not
    "nothing happened".

---

## Email settings

> **Added in 1.2**

DB-backed outbound SMTP configuration. See
[Configuration → Email](../administration/configuration.md#email-smtp) for the operator
guide.

### `GET /api/v1/admin/email-settings/`

```json
{
  "config_source": "env",
  "host": "",
  "port": 587,
  "username": "",
  "use_tls": true,
  "use_ssl": false,
  "from_email": "",
  "timeout": 10,
  "password_set": false,
  "password_decryptable": true,
  "effective_source": "env",
  "effective_host": "smtp.example.org",
  "effective_port": 587,
  "effective_from_email": "noreply@example.org",
  "effective_use_tls": true
}
```

| Field | Type | Notes |
|---|---|---|
| `config_source` | string | `env` or `database`. Selects which source configures outbound mail. Settings are **never** merged across the two. |
| `host`, `port`, `username`, `use_tls`, `use_ssl`, `from_email`, `timeout` | — | The stored configuration. Used only when `config_source` is `database`. |
| `password_set` | boolean | Whether a password is stored. The password itself is **never** returned. |
| `password_decryptable` | boolean | `false` means the instance encryption key changed (typically a `DJANGO_SECRET_KEY` rotation) and the stored password is unrecoverable. It must be re-entered before mail can be sent. |
| `effective_*` | — | What is actually in effect right now, after resolving `config_source` and any explicit `EMAIL_BACKEND`. Read-only. |
| `effective_source` | string | `env`, `database`, or `env_backend_override` — the last meaning the operator pinned `EMAIL_BACKEND`, so both the stored configuration and the `EMAIL_*` variables are bypassed. |

### `PATCH /api/v1/admin/email-settings/`

Accepts any subset of `config_source`, `host`, `port`, `username`, `password`, `use_tls`,
`use_ssl`, `from_email`, `timeout`.

`password` is write-only. **Omitting it leaves the stored password unchanged; sending an
empty string clears it.** The two are deliberately distinct, so the host can be edited
without re-typing or silently discarding the password.

| Status | Body | Cause |
|---|---|---|
| `400` | `{"use_ssl": ["STARTTLS and implicit SSL cannot both be enabled…"]}` | `use_tls` and `use_ssl` would both be true *after* applying the patch |
| `400` | `{"from_email": ["Enter your real sending address…"]}` | Sender is still an `example.com` placeholder |
| `400` | `{"config_source": ["Cannot switch to the stored configuration until it is complete. Missing: …"]}` | Switching to `database` without a host, sender, or (when a username is set) a password |
| `400` | `{"config_source": ["The stored SMTP password could not be decrypted…"]}` | Switching to `database` after the encryption key changed |

Because switching to `database` requires a complete configuration, a partly-filled row is
never authoritative — an interrupted edit leaves the previous configuration working.

Every change is recorded in the [action log](#action-log). Submitting a field with its
existing value writes no row.

### `POST /api/v1/admin/email-settings/test/`

Sends a test email using the configuration currently in effect and reports the result.

**The recipient is always the requesting admin's own email address.** It cannot be
supplied in the request body — an admin-gated endpoint that delivered to an arbitrary
address would be usable as an open relay and as a network probe.

Throttled to **5 requests per hour** per user (raised to 9999/hour in `DEBUG`, a finite budget; `VISIBAN_DISABLE_THROTTLING` is the CI-only full bypass).

```json
{ "success": true, "code": null, "sent_to": "admin@example.org" }
```

The success response carries no `detail` key.

On failure the endpoint returns `400` with the standard `{"code": str, "detail": str}`
machine-error shape, plus `"success": false`:

```json
{
  "success": false,
  "code": "auth_failed",
  "detail": "The mail server rejected the username or password."
}
```

`code` comes from a fixed taxonomy and is what clients should switch on. `detail` is always
present and always a non-empty string: a fixed, neutral message for that code.

| `code` | Meaning | `detail` |
|---|---|---|
| `dns_failure` | The hostname could not be resolved | The mail server's hostname could not be resolved. Check the host name. |
| `connection_refused` | Nothing accepted a connection on that host and port | Nothing accepted a connection on the configured host and port. Check the host, the port, and any firewall in between. |
| `tls_failure` | TLS negotiation failed — often STARTTLS vs implicit SSL, or the wrong port | The secure connection to the mail server could not be established. Check that STARTTLS or SSL matches the port. |
| `auth_failed` | The server rejected the username or password | The mail server rejected the username or password. |
| `timeout` | The server did not respond within the configured timeout | The mail server did not respond within the configured timeout. |
| `config_unusable` | The stored configuration is incomplete, or its password cannot be decrypted | One of a few fixed messages saying which — for example "Email is set to use the configuration stored in the admin UI, but it is incomplete. Set a host and a sender address in Admin → Settings → Email." |
| `no_recipient` | The requesting admin's account has no email address | Your account has no email address, so there is nowhere to send the test. Add one in your profile first. |
| `backend_pinned` | `EMAIL_BACKEND` is set explicitly on the server, so neither configuration source is what sends mail and there is nothing here to test | EMAIL_BACKEND is set on the server, so Visiban cannot test the configuration below — it is not what sends mail. |
| `unknown` | Anything else | The test email could not be sent. The error type is recorded in the server log. |

The `detail` wording may be refined in any release; do not match on it.

!!! note "The underlying SMTP error is never returned"
    Neither `detail` nor any other key ever contains the mail server's error text. Some
    mail servers echo the offending protocol line back in their error text, which on an
    authentication failure can contain the submitted credentials. Only the code and the
    exception type are logged server-side — the error text is not logged either.

New codes may be added in any minor release; treat an unrecognized `code` as `unknown`.

---

## Maintenance mode

> **Added in 1.2**

Turning `maintenance_mode` on puts the whole instance into read-only mode, for the duration
of an upgrade or a migration.

```bash
curl -X PATCH https://visiban.example.com/api/v1/admin/settings/ \
  -H "Authorization: Token vbn_…" \
  -H "Content-Type: application/json" \
  -d '{"maintenance_mode": true, "maintenance_message": "Upgrading to 1.2 — back by 14:00 UTC."}'
```

While it is active:

- **Reads keep working.** `GET`, `HEAD`, `OPTIONS` and `TRACE` are never blocked — maintenance
  mode is read-only mode, not an outage.
- **Writes from non-admins are rejected** with `503 Service Unavailable`:

  ```json
  { "code": "maintenance_mode", "detail": "Upgrading to 1.2 — back by 14:00 UTC." }
  ```

  The response carries `Retry-After: 120` so clients back off rather than retry immediately.
  `detail` is the operator's message, or the built-in default when that message is blank.
- **Site admins are exempt** and keep full read/write access, whether they authenticate with a
  session cookie or a personal access token.
- **[`GET /api/v1/auth/site-config/`](authentication.md#get-apiv1authsite-config)** reports
  `maintenance_mode` and `maintenance_message` so a client can show the notice, signed in or
  not. When `maintenance_mode` is `true`, `maintenance_message` is always non-empty.
  `GET /api/v1/auth/user/` and `/auth/me/` still report both, with the same values, but those
  copies are deprecated (#1872).
- **The notice is public.** `site-config` needs no authentication, and an anonymous write gets
  the notice in its `503` body, so anyone who can reach the instance can read it. Keep internal
  detail out of `maintenance_message`.

!!! warning "Endpoints that stay writable"
    `/api/v1/admin/`, `/api/v1/auth/login/`, `/api/v1/auth/logout/`, the password reset and
    forced-change endpoints, and `/api/v1/auth/ws-ticket/` continue to accept writes, as do
    `/admin/` and `/api/health/`. The **only** exempt paths under `/accounts/` are the SSO login
    round trip — `/accounts/<provider>/login/` and `/accounts/<provider>/login/callback/` — so a
    signed-out SSO-only admin can still sign back in. Every other `/accounts/` write (signup,
    email management, password change, 3rd-party connect/disconnect) is **not** exempt. These are
    the recovery path: a maintenance mode you cannot switch off is an outage. Self-registration,
    profile updates and token creation are likewise **not** exempt and are blocked like any other
    write.

The state is stored on the `SiteSetting` singleton, so it survives a restart, and the cache is
invalidated on save, so a change reaches every worker immediately rather than after the 60s TTL.

MCP write tools (`create_card`, `move_card`, `update_card`, `archive_card`) are blocked too, and
return `{"error": {"code": "maintenance_mode", "detail": "…"}}`. MCP read tools keep working.

---

## Users

### `GET /api/v1/admin/users/`
Paginated list of all accounts on the instance. Site admin only.

**Query params**

| Param | Description |
|---|---|
| `search` | Filter by username, display name, or email (partial, case-insensitive). A value containing a NUL (0x00) character returns `400` with `{"detail": "search must not contain NUL (0x00) characters.", "code": "invalid_query_param"}` (*Changed in 1.3, #1887*; it was a `500` on PostgreSQL) |
| `offset` | Zero-based row offset (default: `0`) |
| `page_size` | Results per page (default: `50`, max: `200`) |

**Response** — `{count, offset, page_size, results}` envelope (same shape as all paginated endpoints):
```json
{
  "count": 142,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 1,
      "username": "alice",
      "email": "alice@example.com",
      "display_name": "Alice Smith",
      "first_name": "Alice",
      "last_name": "Smith",
      "avatar_url": null,
      "is_active": true,
      "is_site_admin": false,
      "can_access_all_content": false,
      "is_superuser": false,
      "has_completed_tour": true,
      "must_change_password": false,
      "date_joined": "2026-01-15T09:00:00Z",
      "owned_boards": [
        { "id": 3, "uid": "a1b2c3d4e5f60718", "name": "Acme Pipeline" }
      ]
    }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `id`, `username`, `email` | — | Account identifiers |
| `display_name`, `first_name`, `last_name` | string | Name fields |
| `avatar_url` | string\|null | URL to the user's avatar image |
| `is_active` | boolean | `false` means the account is deactivated (login blocked) |
| `is_site_admin` | boolean | Whether this user has access to the admin panel |
| `can_access_all_content` | boolean | Whether this user has super-admin access to all boards and groups, independent of membership |
| `is_superuser` | boolean | *(1.2+)* Read-only. Whether this user is a Django superuser. Superuser status implies `is_site_admin` and `can_access_all_content`, and neither can be cleared through `PATCH` while it is set, so the admin panel does not offer **Demote admin** or **Revoke all-content** on these rows. It can be changed only in the [Django admin](../administration/django-admin.md); a `PATCH` that sends it is ignored. |
| `has_completed_tour` | boolean | Whether the onboarding tour has been dismissed |
| `must_change_password` | boolean | `true` means the user will be forced to set a new password on next login |
| `date_joined` | ISO 8601 | Account creation timestamp |
| `owned_boards` | array | Boards owned by this user — each entry has `id`, `uid`, and `name`. Critical for determining what must be transferred before deactivation. |

### `POST /api/v1/admin/users/`
Create a new local account. Site admin only.

**Request**
```json
{
  "username": "bob",
  "email": "bob@example.com",
  "password": "securepassword123",
  "force_password_reset": true
}
```

| Field | Required | Notes |
|---|---|---|
| `username` | Yes | Must be unique on the instance (case-insensitive), and since 1.2 can't be another active user's email address (#1221) |
| `email` | Yes | Must be unique on the instance, and since 1.2 can't be another active user's email or any user's username, compared ignoring case (#1221) |
| `password` | Yes | Minimum 12 characters |
| `force_password_reset` | No | Default `true` — the user must set a new password on first login |

Returns `201 Created` with the new user object. The response does **not** include the password — copy it before closing if needed.

> **Added in 1.2**

The account creation is recorded in the [admin action log](#action-log) as `user.password_set` with `source` `admin_api` and the acting admin. The entry is saved in the same transaction as the account, so the account exists only if the entry does. It names the new account (`target_id`, `target_username`); the password and its hash are never stored.

### `PATCH /api/v1/admin/users/{id}/`
Update a user's account flags. Site admin only.

**Patchable fields**

| Field | Type | Notes |
|---|---|---|
| `is_active` | boolean | `false` deactivates the account (blocks login without deleting data). Cannot deactivate your own account. Only a superuser can change `is_active` on a superuser account. |
| `is_site_admin` | boolean | Grant or revoke admin panel access. Cannot demote yourself. Cannot demote the last active admin. |
| `can_access_all_content` | boolean | Grant or revoke omniscient read/write access to all boards and groups. Only a superuser can change this on a superuser account. Independent of `is_site_admin` for non-superusers — see [Site Admins](../administration/site-admins.md). Setting `false` on a superuser returns `400` with `can_access_all_content` and `detail` set to `Cannot remove all-content access from a superuser; remove superuser status first.` Superuser status implies this flag. |
| `has_completed_tour` | boolean | Reset (`false`) to re-show the onboarding tour to this user on next login |
| `must_change_password` | boolean | `true` forces a password reset on next login. Only a superuser can change this on a superuser account (`400` otherwise). |

> **Added in 1.2**

Setting `is_active: false` also deletes the user's personal access tokens and API auth token (so they do not come back on reactivation) and revokes the user's pending invite links exactly like [`POST /api/v1/admin/users/{id}/deactivate/`](#post-apiv1adminusersiddeactivate): unused site invite links, pending board invites and active, unused group invite links (each affected board and group receives an `invite_link.revoked` event). Consumed single-use links are left as they are. It also turns off every public [board share link](boards.md#board-sharing) the user enabled (each affected board receives a `board.updated` event). Clearing `can_access_all_content` (the only flag that confers group-admin rights; `is_site_admin` does not) revokes the user's unused group invite links that they can no longer administer (links where they are still a group admin by membership are kept). Clearing `can_access_all_content` or `is_site_admin` also turns off the public board share links the user enabled on boards where they are no longer a board admin by membership, ownership or group role (each affected board receives a `board.updated` event). Previously those board and group links stayed active in the database and in the admin link lists, though they were already refused at preview and join.

> **Added in 1.2**

Clearing `is_site_admin` revokes the user's unused site invite links. Site invite links create accounts only while their creator is an active site admin (see [`GET /api/v1/admin/invite-links/`](#get-apiv1admininvite-links)).

**Request**
```json
{ "is_active": false }
```

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "..."}` | Invalid field value, or attempting to demote yourself / the last active site admin, or to set `is_site_admin: false` on a superuser (remove superuser status first; the body carries both `detail` and an `is_site_admin` field error). |
| `403 Forbidden` | `{"detail": "..."}` | Caller is not a site admin. |
| `409 Conflict` | `{"code": "owned_boards", "detail": "...", "owned_boards": [{"id", "uid", "name"}, ...]}` | Caller attempted to set `is_active: false` on a user who owns one or more boards. Use [`POST /api/v1/admin/users/{id}/deactivate/`](#post-apiv1adminusersiddeactivate) instead and supply a `transfers` list. The `owned_boards` array identifies which boards block the deactivation. |

### `POST /api/v1/admin/users/{id}/deactivate/`

Deactivate a user account and transfer ownership of any boards they own to other members.

Deactivation also deletes the user's personal access tokens and API auth token, revokes the user's unused site invite links and *(1.2+)* their pending [board invites](boards.md#board-invites) (`revoked_by` is the caller; each board gets an `invite_link.revoked` event) and *(1.2+)* their active, unused [group invite links](groups.md) (each affected group receives an `invite_link.revoked` event). Consumed single-use links are left as they are. *(1.2+)* It also turns off every public [board share link](boards.md#board-sharing) the user enabled, and each affected board receives a `board.updated` event. Links enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier), record no enabler and no longer resolve from the upgrade on, whoever is deactivated ([upgrade notes](../administration/upgrade.md#upgrading-to-12x), #1939).

**Permission:** `IsSiteAdmin`. Cannot deactivate your own account. Only a superuser can deactivate a superuser account (`400`).

If the target user owns boards, you must supply a `transfers` list mapping each owned board to an eligible recipient, who needs access to the board as a direct member or through group membership (group-inherited access is accepted). If any owned board has no eligible target (the user is its sole member, with no group-inherited members either), the request returns `400 Bad Request` with details.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `transfers` | array | Conditional | Required when the user owns boards. Each entry maps one board to a new owner. |
| `transfers[].board_id` | integer | Yes | ID of the board to transfer. |
| `transfers[].transfer_to` | integer | Yes | ID of the user who will become the new owner. Must be an existing board member. |

```json
{
  "transfers": [
    { "board_id": 12, "transfer_to": 7 },
    { "board_id": 18, "transfer_to": 7 }
  ]
}
```

**Response** `200 OK` — the updated user object (same shape as `GET /api/v1/admin/users/`).

```json
{
  "id": 4,
  "username": "carol",
  "email": "carol@example.com",
  "display_name": "Carol Jones",
  "first_name": "Carol",
  "last_name": "Jones",
  "avatar_url": null,
  "is_active": false,
  "is_site_admin": false,
  "can_access_all_content": false,
  "is_superuser": false,
  "has_completed_tour": true,
  "must_change_password": false,
  "date_joined": "2025-11-02T08:00:00Z",
  "owned_boards": []
}
```

After a successful deactivation with transfers, `owned_boards` will be `[]` — all boards have been transferred to their new owners.

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | A `transfer_to` does not have access to the specified board (neither direct membership nor group-inherited access) |
| `400 Bad Request` | A board in the `transfers` list does not belong to this user |
| `409 Conflict` | User owns one or more boards and no `transfers` were provided |

If a `transfers` item is malformed (missing or non-integer `board_id` or `transfer_to`), the `400` body keys the item errors by zero-based item index, for example `{"transfers": {"1": {"board_id": ["A valid integer is required."]}}}`; valid items are omitted. Through 1.2.0-beta.1 (Django REST framework 3.17) this was an array with one entry per item.

### `POST /api/v1/admin/users/{id}/clear-lockout/`

Clear the target user's per-account login lockout early (#1203). The `login_failed` lockout (5 failed login or password-change attempts / 5 minutes; see [Rate limiting](../architecture/deployment.md#rate-limiting)) normally expires on its own. This endpoint lets a site admin lift it at once, for a user who can't wait and either can't complete a password reset (the other early-recovery path, which clears it automatically) or has no need to change their password.

**Permission:** `IsSiteAdmin`. Only a superuser can clear the lockout of a superuser account (`400` otherwise).

Idempotent — calling it on an account that isn't currently locked out succeeds and changes nothing. Visiban accepts login by username or email, and since 1.2 (#1206) both count against one lockout keyed on the account; this clears that lockout, plus the username- and email-string buckets (used for identifiers that don't resolve to exactly one account, and by lockouts recorded before the upgrade).

**Request body:** none.

**Response** `200 OK` — the user object (same shape as `GET /api/v1/admin/users/`).

**Errors**

| Status | Body | When |
|---|---|---|
| `403 Forbidden` | `{"detail": "..."}` | Caller is not a site admin. |
| `404 Not Found` | `{"detail": "User not found."}` | No user exists with that ID. |

---

## Invite links

Invite links allow new users to self-register when the instance is in `invite_only` mode. Each link contains a single-use or multi-use token that is validated during registration.

### `GET /api/v1/admin/invite-links/`

List all invite links on the instance.

**Permission:** `IsSiteAdmin`.

**Response**

```json
[
  {
    "id": 1,
    "prefix": "iL4xQ",
    "expires_at": "2026-04-30T00:00:00Z",
    "single_use": true,
    "used_at": null,
    "revoked_at": null,
    "created_at": "2026-03-20T10:00:00Z",
    "use_count": 0,
    "status": "pending",
    "created_by_username": "admin",
    "delivery": "link"
  },
  {
    "id": 2,
    "prefix": "rZ9mW",
    "expires_at": null,
    "single_use": false,
    "used_at": null,
    "revoked_at": "2026-03-25T14:00:00Z",
    "created_at": "2026-03-15T09:00:00Z",
    "use_count": 4,
    "status": "revoked",
    "created_by_username": "admin",
    "delivery": "link"
  }
]
```

**Response fields**

| Field | Type | Description |
|---|---|---|
| `id` | integer | Unique link ID. |
| `prefix` | string | Short identifier derived from the token — safe to display, cannot be used to reconstruct the full token. |
| `expires_at` | datetime \| null | ISO 8601 UTC expiry, or `null` if the link does not expire. |
| `single_use` | boolean | When `true`, the link becomes invalid after one successful registration. |
| `used_at` | datetime \| null | ISO 8601 UTC timestamp of when a single-use link was consumed, or `null`. |
| `revoked_at` | datetime \| null | ISO 8601 UTC timestamp of when the link was revoked, or `null`. |
| `created_at` | datetime | ISO 8601 UTC timestamp of when the link was created. |
| `use_count` | integer | Number of successful registrations through this link. Incremented on every consumption (including multi-use links) and preserved across revocation for audit visibility. |
| `status` | `"pending"` \| `"expired"` \| `"used"` \| `"revoked"` | Computed status of the link. Precedence is revoked > used > expired > pending. *(1.2+)* A link that would otherwise be `pending` reports `revoked` when its creator is no longer an active site admin (deactivated, deleted, or no longer a site admin), because registration refuses it; `revoked_at` stays `null` in that case until the link is revoked explicitly. Such a link is not permanently revoked: if the creator's standing is restored, it reports `pending` and works again. To retire it for good, revoke it explicitly with `DELETE /api/v1/admin/invite-links/{id}/`, which accepts a link in this state. |
| `created_by_username` | string | Username of the admin who created the link. |
| `delivery` | `"link"` \| `"email"` | `link` for links created and shared by an admin; `email` for links sent with `POST /api/v1/admin/invite-links/send/`. Added in 1.2. |

---

### `POST /api/v1/admin/invite-links/`

Create a new invite link.

**Permission:** `IsSiteAdmin`.

**Request body** — all fields are optional.

| Field | Type | Required | Description |
|---|---|---|---|
| `expires_in_days` | `1` \| `7` \| `30` \| `null` | No | How many days until the link expires. `null` creates a non-expiring link. Default: `null`. |
| `single_use` | boolean | No | When `true`, the link is invalidated after one successful registration. Default: `false`. |

```json
{ "expires_in_days": 7, "single_use": true }
```

**Response** `201 Created`

The response includes a one-time `raw_token` field. Note that the [group](groups.md#post-apiv1groupsidinvite-links) and [board](boards.md#post-apiv1boardsidinvite-links) invite-link create responses return the same kind of secret as `token`, not `raw_token`. The names differ across the three endpoints for historical reasons and are frozen by the 1.0 contract; none is renamed before a major version. A consistent alias is planned for the next major version (#1255). **Store or share it immediately — it cannot be retrieved again.** All other fields are identical to the list response.

```json
{
  "id": 3,
  "prefix": "kT2vN",
  "expires_at": "2026-04-03T10:00:00Z",
  "single_use": true,
  "used_at": null,
  "revoked_at": null,
  "created_at": "2026-03-27T10:00:00Z",
  "use_count": 0,
  "status": "active",
  "created_by_username": "admin",
  "raw_token": "kT2vNa8f3b1c9e2d7f4a0b5c6d8e1f2a3b4c5d6e7"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | `expires_in_days` is not one of `1`, `7`, `30`, or `null` |
| `400 Bad Request` | The active-link cap for the instance (50) has been reached. Emailed links do not count toward it, and *(1.2+)* neither do links reported as `revoked` because their creator is no longer an active site admin. |

---

### `POST /api/v1/admin/invite-links/send/`

> **Added in 1.2**

Email a single-use registration invite to one address.

**Permission:** `IsSiteAdmin`.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `email` | string | Yes | Recipient address. Surrounding spaces are stripped; an address with a line break is rejected. The address itself is **never stored** or logged; the invite keeps only a keyed hash of it, and registration with it requires this address (`invite_recipient_mismatch` otherwise, #1703). |
| `expires_in_days` | `1` \| `7` \| `30` | No | Days until the link expires. Default `7`. `null` (never expires) is **not** accepted for emailed links. |

```json
{ "email": "new.hire@example.org", "expires_in_days": 7 }
```

The server mints a link with `single_use: true` and `delivery: "email"` and sends a plain-text email with the join link (`<FRONTEND_URL>/join/<token>`) and the expiry date. There is no free-text message field.

**Response** `202 Accepted`

```json
{ "detail": "Invite sent", "sent_to": "new.hire@example.org", "already_registered": false }
```

`already_registered` is `true` when an account with that address (case-insensitive) already exists; the email is sent either way. The raw token is **never** returned. Under `DEBUG` with console mail delivery the response also carries `"delivery": "console"`.

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | Invalid or missing `email`, address with a line break, or `expires_in_days` not one of `1`, `7`, `30` |
| `400 Bad Request` | `{"code": "invite_email_cap_reached"}` — 200 pending emailed links already exist on the instance (*(1.2+)* links whose creator is no longer an active site admin do not count) |
| `403 Forbidden` | Not a site admin, or `{"code": "invite_email_disabled"}` when `INVITE_EMAIL_ENABLED=false` or in demo mode |
| `429 Too Many Requests` | 10 sends/hour per admin (shared with that admin's group invite emails), and 200/day instance-wide for site-admin invites — a budget separate from group invite emails, so group admins cannot exhaust it. Refused or failed sends don't count |
| `502 Bad Gateway` | `{"code": "<error code>"}` — the mail server refused or could not be reached; the just-created link is revoked automatically. `code` is a sanitized SMTP code (`auth_failed`, `connection_refused`, `dns_failure`, `tls_failure`, `timeout`, `config_unusable`, `unknown`) |

---

### `DELETE /api/v1/admin/invite-links/{id}/`

Revoke an invite link immediately. The link can no longer be used for registration.

!!! note "Differs from the other revoke endpoints"
    This route deliberately keeps its 1.1 contract: `200 OK` with the revoked link and `400` on a repeat revoke. The board-scoped, group-scoped and [`admin/board-invite-links`](#delete-apiv1adminboard-invite-linksid) revokes answer `204` with no body, `404` on a repeat revoke and `400` for a used invite. The two conventions stay different for all of 1.x because changing a shipped status code would break 1.1 clients (#1912).

**Permission:** `IsSiteAdmin`.

**Response** `200 OK` — the updated link object with `status: "revoked"`.

```json
{
  "id": 1,
  "prefix": "iL4xQ",
  "expires_at": "2026-04-30T00:00:00Z",
  "single_use": true,
  "used_at": null,
  "revoked_at": "2026-03-27T11:05:00Z",
  "created_at": "2026-03-20T10:00:00Z",
  "use_count": 0,
  "status": "revoked",
  "created_by_username": "admin"
}
```

**Errors**

| Status | Reason |
|---|---|
| `400 Bad Request` | Link is already revoked |
| `400 Bad Request` | Link has already been used (single-use links cannot be revoked after use) |
| `404 Not Found` | Link does not exist |

---

## Board invites

> **Added in 1.2**

Every board's [invites](boards.md#board-invites) — emailed invites and shareable invite links — across the whole instance, so a site admin can audit them and revoke a leaked link without being a member of its board. Board admins manage their own board's invites through the board endpoints; these endpoints are site-admin only, and a board admin who is not a site admin gets `403`.

### `GET /api/v1/admin/board-invite-links/`

**Permission:** `IsSiteAdmin`.

**Query parameters**

| Param | Description |
|---|---|
| `status` | `pending` (default), `used`, `expired`, `revoked` or `all`. Any other value is `400 {"detail": "'<value>' is not a valid status.", "code": "invalid_query_param"}`. Filtering follows the same precedence as the `status` field — revoked > used > expired > pending — so each invite is listed under exactly the status it reports. |
| `offset` | Zero-based row offset (default `0`). |
| `page_size` | Rows per page (default `50`, max `200`). |

**Response** `200 OK` — the standard `{count, offset, page_size, results}` envelope, newest first.

```json
{
  "count": 1,
  "offset": 0,
  "page_size": 50,
  "results": [
    {
      "id": 51,
      "board_id": 12,
      "board_name": "Launch Plan",
      "role": "viewer",
      "delivery": "link",
      "status": "pending",
      "prefix": "vbnb_8a2",
      "expires_at": "2026-10-14T09:30:00.101Z",
      "created_at": "2026-10-07T09:30:00.120Z",
      "created_by_username": "alice",
      "single_use": false,
      "use_count": 3,
      "can_register": true
    }
  ]
}
```

| Field | Description |
|---|---|
| `id` | The invite id — the `{id}` for `DELETE` below. |
| `prefix` | The token's first 8 characters (`vbnb_…`), safe to display. The full token is never returned. |
| `board_id`, `board_name` | The invite's board. |
| `role` | `member`, `collaborator` or `viewer`. |
| `delivery` | `email` or `link`. |
| `status` | The **stored** status: `pending`, `used`, `expired` or `revoked`. It always matches the `?status=` filter (see the note below). |
| `expires_at` | When it expires. Always set for invites created through the API. |
| `created_at` | When it was sent or created. |
| `created_by_username` | `null` when the creator's account was deleted. |
| `single_use`, `use_count` | `use_count` is the number of distinct people who redeemed the invite (each account counts once). |
| `can_register` | Advisory, computed when read: whether a new person could create an account from this invite under the current registration mode. `false` unless the invite is pending and its creator active; on an `invite_only` site, `true` only for an emailed single-use invite from a site admin (with email invites enabled); always `false` on a `closed` site. Registration re-checks everything, including the creator's board role. |

The token and the address an invite was emailed to are never returned.

!!! note "Stored status, not the creator check"
    This list reports each invite's **stored** status and does **not** apply the check that the board's own list and the join endpoints apply: that the creator is still active and still an admin of the board. An invite whose creator was demoted can therefore show **pending** here while the board's own list shows `revoked` and joins are refused (`410 revoked`). (Deactivating an account revokes that user's pending invites outright, so those do show `revoked`.) Revoke such an invite here to make it permanent. `can_register` is advisory for the same reason.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "'bogus' is not a valid status.", "code": "invalid_query_param"}` | Unknown `status` value. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | No credentials. |
| `403 Forbidden` | `{"detail": "You must be a site administrator to perform this action."}` | Not a site admin — including a board admin, or an account with all-content access but no site admin. A site admin with a pending forced password change gets `403` `"You must change your password before continuing."`, and one with a pending forced username change gets `403` `"You must choose a new username before continuing."`, until they complete it. |

### `DELETE /api/v1/admin/board-invite-links/{id}/`

Revoke any board's invite, emailed or shareable. Sets `revoked_at` and `revoked_by` (the caller) and publishes `invite_link.revoked` `{ "id" }` on that board's [WebSocket channel](websockets.md#invite-events-since-12), exactly like the board-scoped revoke. Revoking an expired invite is allowed.

**Permission:** `IsSiteAdmin`.

**Response** `204 No Content` — no body, like the [board-scoped revoke](boards.md#delete-apiv1boardsidinvite-linkslink_id). Re-fetch the list (or set the row's `status` to `revoked`) to show the new state.

**Errors**

| Status | Body | When |
|---|---|---|
| `400 Bad Request` | `{"detail": "This invite has already been used and cannot be revoked."}` | The invite was consumed; its "used" record is kept. |
| `401 Unauthorized` | `{"detail": "Authentication credentials were not provided."}` | No credentials. |
| `403 Forbidden` | `{"detail": "You must be a site administrator to perform this action."}` | Not a site admin. Checked before the lookup, so a non-admin gets `403` even for an id that does not exist. |
| `404 Not Found` | `{"detail": "Invite not found."}` | No invite with that id, or it is already revoked (a revoked row is hidden, so a repeat revoke is `404`). |

This endpoint behaves exactly like the [board-scoped revoke](boards.md#delete-apiv1boardsidinvite-linkslink_id): `204` on success, `400` for a used invite, `404` for an unknown or already-revoked one. The endpoint is new in 1.2 and in no GA release; before this change the 1.2 pre-releases answered `200` with the row and `400` for a repeat revoke. The separate site invite-link revoke (`DELETE /api/v1/admin/invite-links/{id}/`) keeps its 1.1 behavior (`200` with a body, `400` on a repeat revoke), which differs from this family on purpose and stays that way for all of 1.x (#1912).

