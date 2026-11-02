# Grant admin access without granting every board

Two flags control what a "site admin" can do on your instance: who can manage it, and who can see every board and group on it. They are independent for accounts that are not superusers.

**Why it matters:** You can give a support engineer visibility into every board without instance-settings access, or give an admin the settings panel without reading every board.

**Go deeper:** Day-to-day actions live in the [Admin Panel](admin-panel.md).

## What is a site admin?

"Site admin" covers two distinct privileges, tracked by separate flags:

| Flag | What it controls |
|---|---|
| `is_site_admin` | Access to the `/admin` admin panel and admin API (`/api/v1/admin/*`). Required to manage users, settings, and instance configuration. |
| `can_access_all_content` | Read/write access to **every board and group** on the instance, regardless of membership. This is the "omniscient" content access. *(1.3+)* Only a superuser can grant it from the admin panel or API. |

**Yes, but:** before Visiban 1.0.0 these two were coupled, and `is_site_admin` implied content access. They are now independent for accounts that are not superusers (see the note below), so operators can grant admin panel access without also granting board/group omniscience, and vice versa.

!!! note
    Existing site admins are **automatically migrated**: the database migration sets `can_access_all_content=True` for every row where `is_site_admin=True`, so no access is lost on upgrade.

See [Roles & Permissions](../features/rbac/roles.md) for the full permission table.

## Granting and revoking content access separately

To let a user manage the admin panel **without** seeing all boards and groups, grant `is_site_admin` and leave `can_access_all_content` off:

```bash
# Grant admin panel access only — board/group access unchanged
python manage.py set_site_admin <username>
# Then immediately revoke content access if the user should not have it:
# (Site Admin → Users → Revoke all-content in the admin panel)
```

Or use **Make admin** in the admin panel, which sets `is_site_admin` alone.

To let a user (e.g. a support engineer) see all boards **without** admin panel access, a superuser enables `can_access_all_content` in the admin panel (**Site Admin → Users → Grant all-content**) and leaves `is_site_admin` off.

> **Changed in 1.3** (#1830)

**Who can grant all-content access.** Only a superuser, because the flag reads and writes every board and group. A site admin who is not a superuser doesn't see **Grant all-content**, and the API refuses the grant with `400`, on their own account and on any other. They can still revoke the flag from an account that is not a superuser. Every grant and revoke of either flag is recorded with the actor in the [admin action log](../api/admin.md#action-log).

**If your instance has no superuser.** Anyone who can run `manage.py` still has a route:

- `python manage.py createsuperuser` creates a superuser, who can then grant the flag from the admin panel.
- `python manage.py set_site_admin <username>` sets both flags on that account directly. A site admin can then **Demote admin** to leave all-content access on its own.

`ensure_site_admin` won't help here: it does nothing once any site admin exists.

The `set_site_admin` management command always sets **both** flags together for convenience:

```bash
# Grant both flags
python manage.py set_site_admin <username>

# Revoke both flags
python manage.py set_site_admin <username> --revoke
```

To manage the flags independently for accounts that are not superusers, use **Site Admin → Users** in the admin panel. Granting all-content access there takes a superuser.

!!! note
    Superuser status implies both flags. The admin API refuses to clear either flag on an account that is still a superuser, and a save that would leave `can_access_all_content` off on a superuser sets both flags again. Remove superuser status first (which also clears both flags). **Site Admin → Users** therefore does not show **Demote admin** or **Revoke all-content** on a superuser's row.
    Existing superusers that have `can_access_all_content` switched off regain it the next time their account is saved, for example at sign-in.

## First site admin

On first boot, the `ensure_site_admin` management command creates an admin account automatically and prints a one-time password. See [First Boot](../getting-started/first-boot.md).

## Granting site admin

**Admin panel (recommended)**

Go to **Site Admin → Users** (`/admin`), find the user, and click **Make admin** in their row.

**Management command**

```bash
python manage.py set_site_admin <username>

# Docker
docker compose run --rm backend python manage.py set_site_admin <username>
```

**Django admin panel (advanced)**

The user form at `/admin/accounts/user/` (the Django admin — see [Django Admin](django-admin.md) for why this differs from the `/admin` site-admin panel above) has no site admin checkbox. A superuser can turn on **Superuser status** there, which also gives the account site admin and all-content access.

## Revoking site admin

**Admin panel (recommended)**

Go to **Site Admin → Users** (`/admin`), find the user, and click **Demote admin** in their row.

**Management command**

```bash
python manage.py set_site_admin <username> --revoke
```

!!! note
    An account that is still a superuser cannot have site admin removed; remove its superuser status first. The command refuses it, and **Demote admin** is not offered for superuser accounts.

!!! note
    A site admin cannot demote themselves, which prevents locking yourself out. To revoke your own status, ask another site admin. The last active site admin cannot be demoted through the admin API or the site-admin panel.

## Restricting registration

By default, anyone can create an account. Change this in the admin panel's **Settings** tab (`/admin`):

| Mode | Effect |
|---|---|
| **Open** | Anyone can register |
| **Invite-only** | New users must present a valid invite link to register. Existing users are unaffected. |
| **Closed** | All registration is disabled |

The change takes effect immediately — no restart required.

**What changes when invite-only or closed is enabled:**

- **Invite-only:** `POST /api/v1/auth/registration/` refuses a sign-up without a valid invite token with `400 Bad Request`, and OAuth sign-up (Google, GitHub, GitLab, OIDC) is refused the same way. With a valid invite — a site invite link, or *(1.2+)* an emailed group or board invite sent by a site admin — both work.
- **Closed:** `POST /api/v1/auth/registration/` returns `403 Forbidden` for every new sign-up, invite or not, and new OAuth accounts cannot be created. The only way to add a user is **Admin → Users → Add user**.
- Existing users, including OAuth-linked accounts, can still log in either way.
- The login page shows: *"An invite link is required to create an account."*

**Inviting users when invite-only is on:**

Go to **Site Admin → Invite Links** to generate a new invite link. Send the link to the prospective user, who follows it to complete self-registration. Each link can be configured with an expiry and optional use limit. Up to 50 shareable links can be active at once.

*(1.2+)* A site invite link creates accounts only while the admin who created it is still an active site admin. These stop their links from working:

- deactivating or deleting that admin (by any means, including the Django admin's **Active** checkbox)
- removing their site admin status (**Demote admin** in the admin panel, `set_site_admin --revoke`, or removing their superuser status in the Django admin)

**Site Admin → Invite Links** then lists those links as **Revoked** and no longer counts them toward the 50-link limit. **Demote admin**, `set_site_admin --revoke`, removing superuser status and deactivation from the admin panel also mark the pending links revoked.

**Yes, but:** a link shown as **Revoked** only because its creator lost standing is not permanently revoked. If the creator's standing is restored, it becomes usable again. To retire such a link for good, revoke it explicitly while its creator is in good standing (the **Revoke** action is shown only for pending links), or at any time through `DELETE /api/v1/admin/invite-links/{id}/` (see the [Admin API](../api/admin.md)).

> **Added in 1.2**

**Who can admit new accounts on an invite-only instance:** only site admins. Besides site invite links, an invite a **site admin** emails from a group's invite panel lets its recipient create an account (password or OAuth) and joins them to that group with the invite's role. It is single-use and expires in 7 days by default.

It stops creating accounts when:

- its sender is deactivated, is no longer a site admin, or is no longer an admin of the group
- email invites are turned off (`INVITE_EMAIL_ENABLED=false`, see [Configuration](configuration.md)), including invites already sent

Emailed invites from group admins who are not site admins, and every shareable group link, only work for people who already have an account; the group panel tells those senders so. See [Groups](../features/groups.md#new-users-on-invite-only-instances).

> **Added in 1.2**

**Board invites follow the same rule.** An invite a **site admin** emails from a board's **Board Settings → Members → Invite by email** lets its recipient create an account and adds them to that board with the invite's role (member, collaborator or viewer). It stops creating accounts if its sender is deactivated, loses site admin, or is no longer an admin of the board, and when `INVITE_EMAIL_ENABLED` is off. A board admin who is not a site admin can invite only people who already have an account; their pending invites show an **Existing accounts only** tag. There is no separate setting for this. On a **closed** instance no invite creates an account; on an **open** one anyone can sign up and the invite then adds them to the board.

> **Added in 1.2**

**Shareable board invite links never create accounts on an invite-only instance** — not even one a site admin created. They let people who already have an account join the board; on an **open** instance a newcomer can sign up first and then joins. Their create form says which applies. Site admins can see and revoke every board's invites, emailed and shareable, under **Site Admin → Board Invites** (see [Admin Panel](admin-panel.md#board-invites-tab)).

> **Added in 1.2**

**Emailed group and board invites work only for the address they were sent to.** Visiban stores a keyed fingerprint of the address (an HMAC keyed from `DJANGO_SECRET_KEY`), never the address itself, and checks it every time the invite is used (#1678):

- **Joining with an existing account:** the account must have the invited address. Under `EMAIL_VERIFICATION=mandatory` that means a verified address (a pending, unconfirmed change does not count). Under `optional` or `none`, the account's email address also counts; those modes never ask anyone to prove an address, so the check is only as strong as the verification setting. Capitalization and surrounding spaces don't matter; `+tags` and dots do.
- **Creating an account from the invite** (invite-only instances, see above): the sign-up address, or the address the OAuth provider reports, must be the invited one. The new account still goes through the normal email-verification setting.
- *(New in 1.2)* **When the membership starts, with `EMAIL_VERIFICATION=mandatory`:** an account created from an emailed group or board invite joins the group or board when the invited address is verified, not at sign-up (#1704). Only invites bound to an address that is not yet verified are held; emailed invites sent before the upgrade, and sign-ups whose OAuth provider reports the invited address as verified, still join at sign-up. Until then the invite is held for that account: it is not used up and it lists as pending. The person sees the usual "verify your email" step; confirming the invited address adds them with the invite's role and uses up the invite.
    - **What the binding guarantees:** the membership is granted to the account that registered the invited address, once that address is confirmed. Completing the grant requires control of the invited mailbox; the binding does not by itself verify who chose the account's password.
    - **Taking over a held invite:** a second sign-up that would also have to wait for verification cannot use a held invite. A sign-up that does not have to wait (an OAuth provider that reports the invited address as verified, or a site set to `optional` or `none`) uses the invite even when another account holds it; that account then gets nothing when it confirms.
    - **Joining with an existing account ignores the hold.** An existing account with the invited address verified can still join from the invite, which uses it up. This is also the way to recover an invite held by an account that never confirms.
    - **Confirming adds nothing** if, by then, the invite was revoked, expired or used, its sender lost standing, its role is not one an invite may grant, or email invites were turned off. The hold is released. Confirming a different address adds nothing and keeps the hold.
    - **Only allauth's confirmation counts.** Addresses confirmed through the verification email, or with the allauth admin action **Mark as verified**, trigger the grant (verification by code is not enabled by Visiban). An address marked verified another way (a direct database or Django admin edit of the address, or other allauth flows that skip the confirmation signal) does not; the invite stays held and its recipient can still use it through the join page.
    - **Inactive accounts:** a deactivated account can still confirm its address, but is granted nothing and the invite stays held. Confirmation does not happen again after the account is reactivated, so the way to use the invite then is the join page.
    - **Closed instances:** no invite creates an account on a **closed** instance. An invite held before the instance was closed is still granted when its address is confirmed, because the account already exists.
    - **Other modes:** an OAuth sign-up whose provider reports the invited address as verified joins right away. Under `optional` or `none` the account joins at sign-up, as before. Emailed site invites grant no membership, so they are still used up at sign-up; under `mandatory` the new account still cannot sign in until its address is verified.
- **A mismatch is refused** with *"This invite was sent to a different email address. Sign in with the account that uses that address, or ask for a new invite."* (`code: "invite_recipient_mismatch"`). The message never reveals the invited address. The invite is **not** used up, so the person it was sent to can still use it.
- **Shareable links are unchanged.** They are not tied to anyone and work for whoever holds them, within their role, expiry and single-use settings. Use a shareable link when you want "link, not email" behavior.
- **Invites emailed before the upgrade** carry no fingerprint and keep working for whoever holds them until they are used, expire or are revoked. Revoke and resend any you want tied to an address.
- **Changing `DJANGO_SECRET_KEY`** makes pending emailed site, group and board invites unusable, because their fingerprints no longer match. Resend them after a key change. Visiban has no environment variable for keeping an old key around. If you set Django's `SECRET_KEY_FALLBACKS` in your own settings override, invites made under a key listed there keep matching.
- *(New in 1.2)* **Emailed site invites** (**Invite by email** under **Site Admin → Invite Links**) are bound the same way (#1703): the sign-up address, or the address the OAuth provider reports, must be the invited one, and a mismatch leaves the invite unused. Shareable site invite links are not tied to an address, and neither are site invites emailed before the upgrade.

> **Added in 1.2**

Site admins can also have Visiban **email an invite** straight to an address. Under **Site Admin → Invite Links**, enter the address in **Invite by email** and select **Send invite** (also available as `POST /api/v1/admin/invite-links/send/`; see the [Admin API](../api/admin.md)).

- **What it creates:** a single-use link that expires in 7 days (the API also accepts 1 or 30), sent from the instance's sender address.
- **Limits:** emailed links have their own limit of 200 pending, and don't count against the 50 shareable links.
- **What's stored:** the address is not stored. The `202` response includes `already_registered`, saying whether it already belongs to an account (the email is sent either way), and never the raw token.
- **On failure:** if the mail server rejects the message, the endpoint returns `502` with a sanitized error `code` and revokes the link automatically.
- **Availability:** `invite_email_available` on `GET /api/v1/auth/site-config/` tells clients whether sending is currently possible. Emailing requires working outbound email and can be switched off with `INVITE_EMAIL_ENABLED=false` (see [Configuration](configuration.md)). If emailing isn't available (email isn't set up, or `INVITE_EMAIL_ENABLED` is off), the section points you to **Settings → Email** instead; on a demo site it just says email invites are disabled.
- **Binding:** the invite is bound to the address you entered. Only a sign-up with that address (capitalization and surrounding spaces ignored) can use it.

**Yes, but:** following the link does not verify the recipient's address. Registration still follows the normal email-verification setting.

See [First Boot](../getting-started/first-boot.md) for a full walkthrough of the invite link workflow, and [Admin Panel](admin-panel.md) for the user management interface.
