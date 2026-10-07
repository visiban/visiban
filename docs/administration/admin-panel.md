# Admin Panel

The admin panel at `/admin` is the primary interface for managing your Visiban instance. It is only accessible to site admins.

## Settings tab

Controls instance-wide registration behavior and feature availability.

### Registration mode

| Mode | Who can create an account |
|---|---|
| **Open** | Anyone — no restriction |
| **Invite-only** | Only users with a valid invite link can register — a site invite link, or *(1.2+)* a group invite a site admin emailed (see [Groups](../features/groups.md#new-users-on-invite-only-instances)) |
| **Closed** | Nobody — all self-registration disabled |

Changes take effect immediately with no restart required. Existing user sessions and OAuth-linked accounts are never affected — only new sign-ups are gated.

### Features

| Toggle | Default | Effect |
|---|---|---|
| **File uploads** | On | When turned off, all users (including board admins) receive `403 Forbidden` when attempting to upload an attachment. Existing attachments are preserved and can still be viewed and downloaded. |

Feature changes take effect within approximately 60 seconds due to server-side caching. Toggling a feature does not delete or alter any existing data.

### Email

> **Added in 1.2**

Configure the SMTP server used for password-reset and email-verification messages, without editing environment variables or restarting the backend. Available only when the deployment has not pinned `EMAIL_BACKEND`/`backend.email.backend` to an explicit value. See [Configuring SMTP from the admin UI](../administration/configuration.md#configuring-smtp-from-the-admin-ui).

### Maintenance mode

> **Added in 1.2**

Puts the whole instance into **read-only mode** while you run an upgrade or a migration. It is
off by default.

| Control | Effect |
|---|---|
| **Maintenance mode** toggle | When on, every write from a non-admin is rejected with `503 Service Unavailable`. Reads keep working. |
| **Message** | Plain-text notice (max 1000 characters) shown to everyone while maintenance mode is on. Leave it blank to use the built-in default. |

Site admins are exempt and keep full read/write access — signed in through the browser or
using a personal access token — but still see the notice. The setting lives in the database,
so it survives a restart, and it takes effect immediately for every worker.

See [Maintenance Mode](maintenance-mode.md) for the full runbook: what everyone else sees, the
exempt endpoints that keep you from locking yourself out, the shell break-glass command, and a
known limitation on tabs left open in the background.

### Change history

> **Added in 1.2**

Changes to the toggles on this tab — registration mode, file uploads, and maintenance mode —
are recorded with the admin who made them and when. There is no UI for this yet; read the
trail from [`GET /api/v1/admin/action-log/`](../api/admin.md#action-log). See
[Who turned it on?](maintenance-mode.md#who-turned-it-on-the-action-log) for the incident-retro
walkthrough.

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

> **Changed in 1.2** — the less-frequent actions moved into a per-row overflow menu.

Each row shows **Deactivate**/**Reactivate** and **Make admin**/**Remove admin** as inline
text buttons — these are the actions admins reach for most often. The remaining, lower-frequency
actions (**Grant all-content**/**Revoke all-content**, **Force password reset**, **Clear
lockout**, and **Restart onboarding tour**, when each applies to that user) live behind the
**More actions** (`⋮`) button at the end of the row. Open it with a click, or reach it with
the keyboard (Tab to the button, Enter/Space/↓ to open, ↑/↓ to move between items, Esc to
close) — every item in the menu is a fully keyboard-navigable, screen-reader-labeled control,
not just a mouse target.

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

**If the user owns any boards**, deactivation opens a **Transfer boards & deactivate**
dialog first — you cannot deactivate a board owner without reassigning ownership.
Search for a new owner per board (any existing member — a direct board member or one who
has access through group membership both count) and confirm; deactivation and the ownership
transfers happen together, atomically. Deactivating the account also revokes any invite links
the departing user created — site invite links and, *(1.2+)*, the pending board invites they
emailed (each board's admins see those invites move to **Revoked**).

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
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently, use the admin panel toggles described here, or edit the user directly in the [Django admin](django-admin.md) at `/admin/accounts/user/`.

#### Force password reset

Sets `must_change_password = true` on the user. The next time they log in, they are presented with a password-change dialog before accessing the application. Useful after a suspected credential compromise.

#### Restart onboarding tour

> **Added in 1.2**

Clears `has_completed_tour` for a user, so they see the [onboarding tour](../getting-started/onboarding-tour.md) again the next time they open a board — the admin-initiated equivalent of the self-service **Restart onboarding tour** button in Settings → Behavior. Only shown when the user has already completed the tour — there is nothing to reset otherwise. No data is changed beyond the flag.

#### Clear lockout

> **Added in 1.2**

Clears the per-account login lockout (5 failed login attempts within 5 minutes — see [Rate limiting](../architecture/deployment.md#rate-limiting)) immediately, letting the user log in again without waiting out the rest of the 5-minute window.

A successful password reset already clears this automatically, so **Clear lockout** is for the case where that isn't an option — for example the user contacts support directly instead of using the reset-password flow, or reset emails aren't reaching them. It is safe to click at any time: if the account isn't currently locked out, nothing happens.

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

Links that Visiban emailed (see [Inviting by email](#inviting-by-email)) carry an **Emailed** badge and never show a copyable link, because the token exists only in the email.

### Creating a new invite link

Click **New invite link** to open the creation dialog. Fields:

| Field | Notes |
|---|---|
| **TTL** | Time-to-live for the link — choose from preset durations (1 hour, 24 hours, 7 days, 30 days) or enter a custom value |
| **Single-use** | When enabled, the link is automatically revoked after the first successful registration |

After clicking **Create**, the full join URL (`/join/<token>`) is displayed **once** in the dialog. Copy it immediately — it is not shown again. The token prefix remains visible in the list for reference.

!!! warning
    The full join URL is only revealed at creation time. If you close the dialog without copying it, you must revoke the link and create a new one.

### Inviting by email

> **Added in 1.2** (#731)

Above the link list, the **Invite by email** section lets you have Visiban email an invite straight to an address: enter it and select **Send invite**. Visiban creates a single-use link that expires in 7 days (the API also accepts 1 or 30) and sends it from the instance's sender address. The address is not stored. Emailed links count toward their own limit of 200 pending, not the 50 shareable links, and can be revoked like any other link. See [Site Admins](site-admins.md) for the API and rate-limit details.

When emailing isn't possible, the section is replaced by a note that points to **Settings → Email** (select it to open the Settings tab) and reminds you that email invites must be enabled (`INVITE_EMAIL_ENABLED`, see [Configuration](configuration.md)). On a demo site the note just says email invites are disabled. You can still create shareable links as usual.

### Revoking a link

Click **Revoke** on any active link to invalidate it immediately. Revoked links cannot be re-activated. Users who attempt to use a revoked link receive a clear error message.

## Board Invites tab

*(New in 1.2)* The **Board Invites** tab lists the invites of **every board** on the instance — invites board admins emailed and shareable invite links they created — so you can audit them or revoke a leaked link without being a member of the board. Board admins manage their own board's invites from **Board Settings → Members**.

Pick a **Status** (Pending, the default; Used; Expired; Revoked; or All). Each row shows the board, the role the invite grants, how it was delivered (**Email** or **Link**), its status, when it expires, and who created it (**—** when that account was removed). An **Existing accounts only** tag means a new person couldn't create an account from the invite on this site right now — always the case for a shareable link on an invite-only site. The list shows 50 invites per page.

The tab shows each invite's **stored** status. Unlike the board's own list, it does not check whether the invite's creator is still an admin of the board: an invite whose creator was demoted can show **Pending** here while the board's list shows it as revoked and nobody can join with it. Revoke it here to make that permanent. The **Existing accounts only** tag is likewise a best-effort hint; registration re-checks everything.

Select **Revoke** on a pending invite and then **Confirm** to stop it working immediately. Anyone with the board open sees it leave their invite list. Used invites can't be revoked. The API is documented in [Admin API — Board invites](../api/admin.md#board-invites).

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
