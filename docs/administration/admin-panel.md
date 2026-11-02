# Run your instance from one panel

The admin panel at `/admin` is where site admins manage users, registration, invites, and instance settings.

**Why it matters:** Most day-to-day admin work (adding a user, closing sign-ups, revoking a leaked invite, turning on maintenance mode) happens here without a shell.

**The big picture:** The panel has four tabs: **Settings**, **Users**, **Invite Links**, and **Board Invites**. It is accessible to site admins only.

**Go deeper:** Every operation also has a [CLI alternative](#cli-alternatives). For the two-flag admin model, see [Site Admins](site-admins.md).

## Settings tab

Controls instance-wide registration behavior and feature availability.

### Registration mode

Set who can create an account. Changes take effect immediately, with no restart.

| Mode | Who can create an account |
|---|---|
| **Open** | Anyone — no restriction |
| **Invite-only** | Only users with a valid invite link can register — a site invite link, or *(1.2+)* a group invite a site admin emailed (see [Groups](../features/groups.md#new-users-on-invite-only-instances)) |
| **Closed** | Nobody — all self-registration disabled |

**Yes, but:** only new sign-ups are gated. Existing user sessions and OAuth-linked accounts are never affected.

### Features

| Toggle | Default | Effect |
|---|---|---|
| **File uploads** | On | When turned off, all users (including board admins) receive `403 Forbidden` when attempting to upload an attachment. Existing attachments are preserved and can still be viewed and downloaded. |

**By the numbers:** feature changes take effect within about 60 seconds because of server-side caching. Toggling a feature never deletes or alters existing data.

### Email

<span class="vb-version" title="Added in 1.2">1.2+</span>

Configure the SMTP server for password-reset and email-verification messages, without editing environment variables or restarting the backend.

**Yes, but:** this is available only when the deployment has not pinned `EMAIL_BACKEND`/`backend.email.backend` to an explicit value. See [Configuring SMTP from the admin UI](../administration/configuration.md#configuring-smtp-from-the-admin-ui).

### Maintenance mode

<span class="vb-version" title="Added in 1.2">1.2+</span>

Put the whole instance into **read-only mode** during an upgrade or migration. It is off by default.

| Control | Effect |
|---|---|
| **Maintenance mode** toggle | When on, every write from a non-admin is rejected with `503 Service Unavailable`. Reads keep working. |
| **Message** | Plain-text notice (max 1000 characters) shown to everyone while maintenance mode is on. Leave it blank to use the built-in default. |

**How it works:** site admins are exempt and keep full read/write access (signed in through the browser or using a personal access token), but still see the notice. The setting lives in the database, so it survives a restart, and it takes effect immediately for every worker.

**Go deeper:** [Maintenance Mode](maintenance-mode.md) is the full runbook: what everyone else sees, the exempt endpoints that keep you from locking yourself out, the shell break-glass command, and a known limitation on tabs left open in the background.

### Change history

<span class="vb-version" title="Added in 1.2">1.2+</span>

Changes to the toggles on this tab (registration mode, file uploads, and maintenance mode) are recorded with the admin who made them and when.

**Yes, but:** there is no UI for this yet. Read the trail from [`GET /api/v1/admin/action-log/`](../api/admin.md#action-log). See [Who turned it on?](maintenance-mode.md#who-turned-it-on-the-action-log) for the incident-retro walkthrough.

## Users tab

Lists all accounts on the instance, 50 per page. Use the search bar to filter by username, display name, or email address.

### User status badges

| Badge | Meaning |
|---|---|
| **Admin** | User has site admin privileges (`is_site_admin`) |
| **All content** | User can read and write every board and group on the instance (`can_access_all_content`) |
| **Reset req.** | User will be prompted to set a new password on next login |
| **Inactive** | Account is deactivated — user cannot log in |

### Actions per user

> **Changed in 1.2** — the less-frequent actions moved into a per-row overflow menu.

Each row shows **Deactivate**/**Reactivate** and **Make admin**/**Demote admin** as inline text buttons, the actions admins reach for most often.

The lower-frequency actions live behind the **More actions** (`⋮`) button at the end of the row, when each applies to that user:

- **Grant all-content**/**Revoke all-content**
- **Force password reset**
- **Clear lockout**
- **Restart onboarding tour**

Open the menu with a click, or with the keyboard: Tab to the button, Enter/Space/↓ to open, ↑/↓ to move between items, Esc to close. Every item is keyboard-navigable and screen-reader-labeled.

*(1.3+)* **On a superuser account**, a site admin who is not a superuser does not see **Deactivate**, **Reactivate**, **Grant all-content**, **Revoke all-content**, **Force password reset**, or **Clear lockout**, because the API refuses them. The row says "Only a superuser can change this account's access or sign-in." instead. **Make admin** and **Restart onboarding tour** stay where they apply.

#### Add user

Creates a local account directly.

| Field | Notes |
|---|---|
| Username | Must be unique on the instance (case-insensitive) |
| Email | Used for future email notification features |
| Password | Minimum 12 characters |
| Force password reset | On by default — the user must choose a new password on first login |

!!! warning
    Copy the temporary password before closing the dialog — it is not shown again. The user needs it to log in and trigger the password-reset prompt. If you lose it, deactivate the account and create a new one.

#### Deactivate / Reactivate

Deactivated accounts cannot log in. No data is deleted. Click **Reactivate** to reverse it at any time.

- You cannot deactivate your own account from this panel.
- On a superuser account, **Deactivate** and **Reactivate** are available to, and shown to, superusers only.

**If the user owns any boards**, deactivation first opens a **Transfer boards & deactivate** dialog, because you cannot deactivate a board owner without reassigning ownership. Search for a new owner per board (any existing member counts, direct or through group membership) and confirm. Deactivation and the transfers happen together, atomically.

**What else deactivation does:** it revokes any invite links the departing user created:

- site invite links
- *(1.2+)* the pending board invites they emailed (each board's admins see those invites move to **Revoked**)
- their active, unused group invite links (each affected group's admins see them move to **Revoked**)

Consumed single-use links are left as they are.

*(1.2+)* It also turns off any public board share link the user turned on (links turned on before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier) record no admin and stop working at the upgrade instead; see the [upgrade notes](upgrade.md#upgrading-to-12x)); see [Board sharing](../features/board.md#when-a-share-link-ends-automatically).

#### Make admin / Demote admin

Grants or revokes site admin status.

- You cannot change your own admin status. Ask another site admin.
- **Demote admin** is not shown for an account that is still a superuser (the API refuses it). Remove superuser status in the Django admin first.
- *(1.2+)* **Demote admin** also revokes the unused site invite links that user created; only an active site admin's site invite links create accounts.
- The last active site admin on the instance cannot be demoted.

#### Grant all-content / Revoke all-content

> **Added in 1.0**

Controls the `can_access_all_content` flag independently of admin status (for accounts that are not superusers). When enabled, the user can read and write every board and group on the instance regardless of membership.

- **Grant all-content** gives a user omniscient access without making them a site admin. This is useful for support engineers who need visibility into all boards but should not manage instance settings.
- **Grant all-content** on a superuser account is available to, and shown to, superusers only.
- **Revoke all-content** removes that access. The user will only see boards and groups they are explicitly a member of. It is not shown for a superuser account, because superuser status implies all-content access (the API refuses it); remove superuser status in the Django admin first.

**The big picture:** `is_site_admin` (admin panel access) and `can_access_all_content` (board/group omniscience) are independent for accounts that are not superusers. A superuser always has both. See [Site Admins](site-admins.md) for a detailed explanation of the two-flag model and examples of common configurations.

!!! tip
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently for accounts that are not superusers, use the admin panel toggles described here, or edit the user directly in the [Django admin](django-admin.md) at `/admin/accounts/user/`.

#### Force password reset

Sets `must_change_password = true` on the user. At their next login, they get a password-change dialog before accessing the application. Use it after a suspected credential compromise. On a superuser account it is available to, and shown to, superusers only.

#### Restart onboarding tour

<span class="vb-version" title="Added in 1.2">1.2+</span>

Clears `has_completed_tour` for a user, so they see the [onboarding tour](../getting-started/onboarding-tour.md) again the next time they open a board. It is the admin-initiated equivalent of the self-service **Restart onboarding tour** button in Settings → Behavior.

It is shown only when the user has already completed the tour, since there is nothing to reset otherwise. No data is changed beyond the flag.

#### Clear lockout

<span class="vb-version" title="Added in 1.2">1.2+</span>

Clears the per-account login lockout immediately, so the user can log in again without waiting out the rest of the 5-minute window. The lockout is 5 failed login or password-change attempts within 5 minutes; see [Rate limiting](../architecture/deployment.md#rate-limiting). On a superuser account this is available to, and shown to, superusers only.

**Yes, but:** a successful password reset already clears the lockout. Use **Clear lockout** when that isn't an option, for example the user contacts support instead of using the reset flow, or reset emails aren't arriving. It is safe at any time: if the account isn't locked out, nothing happens.

## Invite Links tab

> **Added in 1.0**

Create and manage invite links for instance-wide registration. Links matter only when registration mode is **Invite-only** (see [Settings tab](#settings-tab)), but you can create them in any mode and activate them later.

Invite links work for password and OAuth registration (Google, GitHub, GitLab, OIDC). When a new user follows a join link and chooses OAuth, the token is carried through the IdP redirect and consumed on successful signup.

### Link list

Each row shows:

| Column | Description |
|---|---|
| **Token prefix** | The first 8 characters of the token — enough to identify a link without exposing the full value |
| **Status** | `Active`, `Expired`, or `Revoked` |
| **Expires** | Expiry date and time in the instance timezone |
| **Single-use** | Whether the link can only be used once |
| **Uses** | How many times the link has been successfully redeemed |

Links that Visiban emailed (see [Inviting by email](#inviting-by-email)) carry an **Emailed** badge and never show a copyable link, because the token exists only in the email.

### Creating a new invite link

Click **New invite link** to open the creation dialog.

| Field | Notes |
|---|---|
| **TTL** | Time-to-live for the link — choose from preset durations (1 hour, 24 hours, 7 days, 30 days) or enter a custom value |
| **Single-use** | When enabled, the link is automatically revoked after the first successful registration |

After you click **Create**, the dialog shows the full join URL (`/join/<token>`) **once**. Copy it immediately. The token prefix stays visible in the list for reference.

!!! warning
    The full join URL is only revealed at creation time. If you close the dialog without copying it, you must revoke the link and create a new one.

### Inviting by email

> **Added in 1.2** (#731)

In the **Invite by email** section above the link list, enter an address and select **Send invite**. Visiban creates a single-use link that expires in 7 days (the API also accepts 1 or 30) and sends it from the instance's sender address. The address is not stored.

Emailed links count toward their own limit of 200 pending, not the 50 shareable links, and can be revoked like any other link. See [Site Admins](site-admins.md) for the API and rate-limit details.

**Yes, but:** when emailing isn't possible, the section is replaced by a note. It points to **Settings → Email** (select it to open the Settings tab) and reminds you that email invites must be enabled (`INVITE_EMAIL_ENABLED`, see [Configuration](configuration.md)). On a demo site the note just says email invites are disabled. You can still create shareable links as usual.

### Revoking a link

Click **Revoke** on any active link to invalidate it immediately. Revoked links cannot be re-activated. Users who attempt to use a revoked link receive a clear error message.

## Board Invites tab

<span class="vb-version" title="Added in 1.2">1.2+</span>

Audit the invites of **every board** on the instance, or revoke a leaked link, without being a member of the board. The tab lists invites board admins emailed and shareable invite links they created. Board admins manage their own board's invites from **Board Settings → Members**.

Pick a **Status** (Pending, the default; Used; Expired; Revoked; or All). Each row shows:

- the board
- the role the invite grants
- how it was delivered (**Email** or **Link**)
- its status
- when it expires
- who created it (**—** when that account was removed)

An **Existing accounts only** tag means a new person couldn't create an account from the invite on this site right now (always so for a shareable link on an invite-only site). The list shows 50 invites per page.

To stop an invite immediately, select **Revoke** on a pending invite and then **Confirm**. Anyone with the board open sees it leave their invite list. Used invites can't be revoked. The API is documented in [Admin API — Board invites](../api/admin.md#board-invites).

**Yes, but:** the tab shows each invite's **stored** status and, unlike the board's own list, does not check whether the creator is still a board admin. An invite whose creator was demoted can show **Pending** here while the board's list shows it revoked and nobody can join with it. Revoke it here to make that permanent. The **Existing accounts only** tag is a best-effort hint; registration re-checks everything.

## CLI alternatives

All admin-panel operations are also available via management commands, for scripting and automation.

```bash
# Grant site admin
python manage.py set_site_admin <username>

# Revoke site admin
python manage.py set_site_admin <username> --revoke   # refused for a superuser; remove superuser status first

# Create the initial site admin (run once on first boot)
python manage.py ensure_site_admin
```

For Docker:

```bash
docker compose run --rm backend python manage.py set_site_admin <username>
```

See [Site Admins](site-admins.md) for first-boot setup and registration mode details.
