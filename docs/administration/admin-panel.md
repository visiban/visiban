# Admin Panel

The admin panel at `/admin` is the primary interface for managing your Visiban instance. It is only accessible to site admins.

## Settings tab

Controls instance-wide registration behavior and feature availability.

### Registration mode

| Mode | Who can create an account |
|---|---|
| **Open** | Anyone — no restriction |
| **Invite-only** | Only users with a valid invite link can register |
| **Closed** | Nobody — all self-registration disabled |

Changes take effect immediately with no restart required. Existing user sessions and OAuth-linked accounts are never affected — only new sign-ups are gated.

### Features

| Toggle | Default | Effect |
|---|---|---|
| **File uploads** | On | When turned off, all users (including board admins) receive `403 Forbidden` when attempting to upload an attachment. Existing attachments are preserved and can still be viewed and downloaded. |

Feature changes take effect within approximately 60 seconds due to server-side caching. Toggling a feature does not delete or alter any existing data.

### Maintenance mode

Puts the whole instance into **read-only mode** while you run an upgrade or a migration. It is
off by default.

| Control | Effect |
|---|---|
| **Maintenance mode** toggle | When on, every write from a non-admin is rejected with `503 Service Unavailable`. Reads keep working. |
| **Notice** | Plain-text message (max 1000 characters) shown to everyone while maintenance mode is on. Leave it blank to use the built-in default. |

While maintenance mode is on:

- **People can still read.** Boards, cards, comments and history all stay visible. This is a
  read-only mode, not an outage, so nobody loses access to information they need mid-incident.
- **Writes are blocked** — creating, editing, moving, archiving and deleting all fail with a
  `maintenance_mode` error. This covers the REST API and the MCP write tools alike.
- **Site admins are exempt** and keep full read/write access, whether they are signed in through
  the browser or using a personal access token. Admins still see the notice, so they can tell at
  a glance that the instance is not in its normal state.
- **The notice is shown to every signed-in user** until you turn maintenance mode back off.

The setting lives in the database, so it survives a restart, and it takes effect immediately —
there is no need to restart the service or wait for a cache to expire.

!!! tip "Put an end time in the notice"
    A notice with no ETA is the one people find most frustrating: "changes are disabled" with no
    sense of for how long reads as either trivial or alarming, depending on the reader. Say when
    you expect to be finished — for example, *"Upgrading to 1.2 — back by 14:00 UTC."*

!!! warning "You cannot lock yourself out"
    Signing in, signing out, password reset, the forced password/username change flows, SSO
    callbacks, the health probes and the whole admin API stay writable while maintenance mode is
    on. Turning it back off is always reachable, even from a signed-out browser. Self-registration,
    profile edits and token creation are **not** exempt — they are blocked like any other write.
    To stop new sign-ups specifically, use [Registration mode](#registration-mode) instead.

#### Turning maintenance mode off from the shell

If the web UI is unreachable — a broken ingress, a bad deploy — maintenance mode can be cleared
from any container with database access:

```bash
# Show the current state
python manage.py maintenance_mode

# Turn it on, with a notice
python manage.py maintenance_mode --on --message "Upgrading to 1.3 — back by 14:00 UTC."

# Turn it back off
python manage.py maintenance_mode --off
```

Changes take effect immediately, exactly as they do from the admin panel. Maintenance mode is
also editable from the [Django admin](django-admin.md) as a second break-glass route.

See [Maintenance mode](../api/admin.md#maintenance-mode) for the API, and the
[Zero-Downtime Upgrade Playbook](zero-downtime-upgrade.md) for when a maintenance window is
needed at all — most 1.x upgrades do not need one.

## Users tab

Lists all accounts on the instance, paginated 50 per page. Use the search bar to filter by username, display name, or email address.

### User status badges

| Badge | Meaning |
|---|---|
| **Admin** | User has site admin privileges (`is_site_admin`) |
| **All content** | User can read and write every board and group on the instance (`can_access_all_content`) |
| **Reset req.** | User will be prompted to set a new password on next login |
| **Inactive** | Account is deactivated — user cannot log in |

### Actions per user

#### Add user

Creates a local account directly. Fields:

| Field | Notes |
|---|---|
| Username | Must be unique on the instance (case-insensitive) |
| Email | Used for future email notification features |
| Password | Minimum 12 characters |
| Force password reset | On by default — the user must choose a new password on first login |

!!! warning
    Copy the temporary password before closing the dialog — it is not shown again. The user needs it to log in and trigger the password-reset prompt. If you lose it, deactivate the account and create a new one.

#### Deactivate / Reactivate

Deactivated accounts cannot log in. No data is deleted. Can be reversed at any time by clicking **Reactivate**.

You cannot deactivate your own account from this panel.

#### Make admin / Remove admin

Grants or revokes site admin status. You cannot change your own admin status — ask another site admin.

The last active site admin on the instance cannot be demoted.

#### Grant all-content / Revoke all-content

> **Added in 1.0**

Controls the `can_access_all_content` flag independently of admin status. When enabled, the user can read and write every board and group on the instance regardless of membership.

- **Grant all-content** gives a user omniscient access without making them a site admin. This is useful for support engineers who need visibility into all boards but should not manage instance settings.
- **Revoke all-content** removes that access. The user will only see boards and groups they are explicitly a member of.

These two flags — `is_site_admin` (admin panel access) and `can_access_all_content` (board/group omniscience) — are fully independent. See [Site Admins](site-admins.md) for a detailed explanation of the two-flag model and examples of common configurations.

!!! tip
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently, use the admin panel toggles described here, or edit the user directly in the Django admin at `/django-admin/accounts/user/`.

#### Force password reset

Sets `must_change_password = true` on the user. The next time they log in, they are presented with a password-change dialog before accessing the application. Useful after a suspected credential compromise.

## Invite Links tab

> **Added in 1.0**

The **Invite Links** tab lets site admins create and manage invite links for instance-wide registration. Invite links are only relevant when the instance registration mode is set to **Invite-only** (see [Settings tab](#settings-tab)), but links can be created regardless of the current mode and activated later.

Invite links work for both password-based and OAuth registration (Google, GitHub, GitLab, OIDC). When a new user follows a join link and chooses OAuth, the token is carried through the IdP redirect automatically and consumed on successful signup.

### Link list

Each row in the list shows:

| Column | Description |
|---|---|
| **Token prefix** | The first 8 characters of the token — enough to identify a link without exposing the full value |
| **Status** | `Active`, `Expired`, or `Revoked` |
| **Expires** | Expiry date and time in the instance timezone |
| **Single-use** | Whether the link can only be used once |
| **Uses** | How many times the link has been successfully redeemed |

### Creating a new invite link

Click **New invite link** to open the creation dialog. Fields:

| Field | Notes |
|---|---|
| **TTL** | Time-to-live for the link — choose from preset durations (1 hour, 24 hours, 7 days, 30 days) or enter a custom value |
| **Single-use** | When enabled, the link is automatically revoked after the first successful registration |

After clicking **Create**, the full join URL (`/join/<token>`) is displayed **once** in the dialog. Copy it immediately — it is not shown again. The token prefix remains visible in the list for reference.

!!! warning
    The full join URL is only revealed at creation time. If you close the dialog without copying it, you must revoke the link and create a new one.

### Revoking a link

Click **Revoke** on any active link to invalidate it immediately. Revoked links cannot be re-activated. Users who attempt to use a revoked link receive a clear error message.

## CLI alternatives

All admin-panel operations are also available via management commands for scripting and automation:

```bash
# Grant site admin
python manage.py set_site_admin <username>

# Revoke site admin
python manage.py set_site_admin <username> --revoke

# Create the initial site admin (run once on first boot)
python manage.py ensure_site_admin
```

For Docker:

```bash
docker compose run --rm backend python manage.py set_site_admin <username>
```

See [Site Admins](site-admins.md) for first-boot setup and registration mode details.
