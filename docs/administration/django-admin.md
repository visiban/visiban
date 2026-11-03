# Edit raw records in the Django admin

Django's built-in admin lives at `/admin/` (**with** a trailing slash) on the backend server (port 8000 in development). Use it for direct database record editing, not day-to-day administration.

**Why it matters:** this is a different page from the React **site-admin panel** at `/admin` (**no** trailing slash; see [Admin Panel](admin-panel.md)). Use the site-admin panel for most day-to-day tasks (users, registration mode, maintenance mode).

**Yes, but:** the two share a URL prefix by coincidence of routing, not by design. Nginx and the SPA router tell them apart by the trailing slash.

## Access

Log in with any user that has `is_staff = True` or `is_superuser = True`. The site admin account created by `ensure_site_admin` has `is_staff` and `is_superuser` set, so it can sign in here once it has changed the generated password (see below).

To give another account Django admin access, set `is_staff` on it:

```bash
python manage.py shell -c "
from accounts.models import User
u = User.objects.get(username='someone')
u.is_staff = True
u.save()
"
```

**Watch out:** an account with a forced password or username change pending (`must_change_password` or `must_change_username`) cannot use the Django admin until it completes the change in the web app. `/admin/` redirects it to the app and refuses form submissions. Only **Log out** stays available. The account created by `ensure_site_admin` starts with `must_change_password` set, so it changes its password in the web app before it can use the Django admin.

## Passwords

- **Your own password:** the admin's **Change password** link opens the web app, where you change it like any other user.
- **Another user's password** (the user's **Password** form at `/admin/accounts/user/<id>/password/`): saving a new password, or disabling password sign-in, deletes that user's Personal Access Tokens and API token and ends their sessions. If a new password was set, the user must change it the next time they sign in. The action is recorded in the [admin action log](../api/admin.md) with who made the change and which account it applied to; the password itself is never recorded.
- **Passwords set from the command line:** `createsuperuser` (when a password is set), `ensure_site_admin` (the generated one-time password), `changepassword` and `provision_fuzz_token --set-random-password` write the same admin action log entry with source `cli` and no actor. The entry and the password change save together, so the password changes only if the entry saves. Accounts created through the site-admin panel's API (`POST /api/v1/admin/users/`) are recorded the same way, with source `admin_api` and who created them. The demo seed writes no entry: it runs only with `DEMO_MODE=true`, and the demo's hourly reset empties the log.
- **Adding a user:** a user created here with a password must choose their own password the first time they sign in, the same as one created from the site-admin panel. Adding a user with a password is recorded in the admin action log; the password itself is not. A user created with password sign-in disabled is not asked to create one.

## Deactivating users

Clearing **Active** on a user deletes their Personal Access Tokens and API token, revokes their pending invite links, and *(1.2+)* turns off any public board share link they turned on, the same as deactivating them from the site-admin panel.

## What you can manage

- **Users** — view/edit user accounts, activate or deactivate accounts, and (superusers only) set `is_staff`, `is_superuser`, groups and permissions. The form does not carry `is_site_admin` or `must_change_password`; use the site-admin panel or `set_site_admin` for those. Removing `is_superuser` also removes the account's site-admin and all-content access; site admin can then be granted again explicitly. *(1.3+)* Turning `is_superuser` on or off records each flag it changes in the [admin action log](../api/admin.md#action-log), with you as the actor.
  - For staff who are not superusers, `is_staff`, `is_superuser`, groups and permissions are read-only, `email`, `username`, `first_name`, `last_name` and `is_active` are read-only on staff, superuser, site-admin and *(1.3+)* all-content accounts other than their own, superuser accounts are not listed, and the **Password** form is refused for those accounts. Changing or deleting another account of those kinds is left to superusers.
  - For every user, superusers included, the form applies the same guards as the site-admin panel: you cannot deactivate your own account, a user who owns boards without transferring them, or the last active site admin, and you cannot remove your own superuser status, the last active superuser's status, or the last active site admin's access. The shell and management commands are the only routes without these guards.
  - Deleting a user, from the user's delete page or the **Delete selected users** action, applies the same guards: you cannot delete your own account, a user who owns boards (transfer the boards first), a user who owns groups (transfer the groups first, see [Transferring a group's ownership](#transferring-a-groups-ownership); deactivating the account remains available), the last active site admin, the last active superuser, or *(1.2+)* the last active admin of a group (make another active member an admin of the group first; a deactivated admin does not count, so a group whose only other admin is its deactivated owner needs a new admin or an [ownership transfer](#transferring-a-groups-ownership)); staff accounts that are not superusers cannot delete another staff, superuser, site-admin or *(1.3+)* all-content account. A bulk delete is all-or-nothing: if any selected user is refused, none are deleted and each reason is shown.
  - Changing a user's **Email address** here mails the user's previous address a short notice that the account's email was changed (it does not include the new address), the same as when users change it themselves.
  - Marking an email address as verified (the **Email addresses** admin's verify action) on an account that has no password mails the account's current email a short notice that an address was confirmed on the account, the same as when users confirm one themselves.
  - A save is refused with a reload message if the account changed after you opened its form.
- **Groups** (workspace groups, under the **Groups** app) — visible to superusers only and read-only: fields cannot be edited and groups cannot be deleted here. The one write is the **Transfer ownership of the selected group** action, intended for a group whose owner is deactivated or gone; it works on any group (see [Transferring a group's ownership](#transferring-a-groups-ownership)).
- **Authentication and Authorization → Groups** (Django auth permission groups) — visible and editable by superusers only; staff accounts do not see this entry even when granted the group permissions
- **Site settings** — instance-wide configuration (registration mode, file uploads, [maintenance mode](maintenance-mode.md)); clicking the entry goes directly to the settings form — there is always exactly one row
- **Card movements** — view and search only (#1469): movement records can't be added, edited or deleted here. They are removed only by deleting their board, or by a superuser running the `purge_card_history` command (since 1.2, #1797; see [Card History Retention](card-history-retention.md)).
- **Boards, columns, swimlanes** — direct database access for debugging
- **Board memberships** — view and correct membership records
- **Email addresses, social accounts, social tokens, social apps, API tokens and Sites** — available to superusers only. Staff accounts do not see these entries.

The change forms for users, groups, site settings, boards and board memberships save only the fields you changed; the rest keep their stored values. If the record changed after you opened its form, the save is refused with a message asking you to reload and redo your changes.

## Transferring a group's ownership

> **Added in 1.2** (#1643)

A superuser can move a group to a new owner from the Django admin. A user who owns groups cannot be deleted until ownership moves, and only the owner can transfer a group through the web app. Use this when the owner is deactivated or gone:

1. Open **Groups** under the **Groups** app and tick exactly one group. The list shows each owner and whether the owner is active.
2. Choose **Transfer ownership of the selected group** and click **Go**.
3. Pick the new owner. The list holds only active members of that group other than the current owner; add the person to the group first if they are not a member.
4. Confirm. The new owner becomes an admin member of the group and its owner, the previous owner stays on the group as an admin member, and open sessions receive the same group update the web app sends.

**Yes, but:** the action shares its transfer code with the web app, but its rules are deliberately looser, since it is a superuser's judgment call:

- there is no group-name confirmation
- the new owner can be any active member of the group (not only an existing admin) and is made an admin
- it works on any group, not only those with a departed owner

The page records the owner it showed. If the owner changed before you confirmed, the transfer is refused and you retry from a reloaded page. Each transfer is recorded in the admin log.

The action is available to superusers only. Staff accounts that are not superusers do not see the Groups entry. Once the groups are transferred, the former owner can be deleted.

## Production note

**Restricted to loopback by default** — both the bundled Nginx config and
`AdminIPRestrictionMiddleware` block any client IP that isn't `127.0.0.1` or
`::1`, unless you widen the allowlist. See [Secret Rotation → Admin interface
access](secret-rotation.md#admin-interface-access) for the Compose and Helm
steps, and why they differ.
