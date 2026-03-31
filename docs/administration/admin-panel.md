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

> **Added in 1.0.0-rc.9**

Controls the `can_access_all_content` flag independently of admin status. When enabled, the user can read and write every board and group on the instance regardless of membership.

- **Grant all-content** gives a user omniscient access without making them a site admin. This is useful for support engineers who need visibility into all boards but should not manage instance settings.
- **Revoke all-content** removes that access. The user will only see boards and groups they are explicitly a member of.

These two flags — `is_site_admin` (admin panel access) and `can_access_all_content` (board/group omniscience) — are fully independent. See [Site Admins](site-admins.md) for a detailed explanation of the two-flag model and examples of common configurations.

!!! tip
    The `set_site_admin` management command sets **both** flags together for convenience. To manage them independently, use the admin panel toggles described here, or edit the user directly in the Django admin at `/django-admin/accounts/user/`.

#### Force password reset

Sets `must_change_password = true` on the user. The next time they log in, they are presented with a password-change dialog before accessing the application. Useful after a suspected credential compromise.

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
