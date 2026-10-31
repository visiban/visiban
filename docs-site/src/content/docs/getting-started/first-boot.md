---
title: Log in once, then lock the door
description: Retrieve the one-time admin password, set your own, and choose who can sign up before you share the URL.
sidebar:
  label: First boot
---

On first start, Visiban creates an `admin` account and writes its one-time password to a file. Retrieve it, log in, set your own password, and choose a registration mode before you invite anyone.

**Why it matters:** The password is written once and never printed to the logs. If the container is recreated before you read the file, the file is gone and you'll need to reset the password instead.

<a id="automatic-admin-bootstrap"></a>

**How it works:**

- **When no site admin exists,** `ensure_site_admin` creates one and writes the password to `/tmp/visiban_admin_password` by default.
- **The password isn't printed to stdout,** so it can't end up in a log aggregator such as CloudWatch, Datadog, or the Docker log driver.
- **The file is created exclusively, with mode `0600`, and symlinks are never followed.** If something other than a regular file you own is already at that path, Visiban refuses to use it and prints the password to the command's stdout instead.
- **Set `VISIBAN_ADMIN_PASSWORD_FILE`** to use a private directory instead of `/tmp`.

What stdout shows:

```
============================================================
  VISIBAN INITIAL ADMIN CREDENTIALS
============================================================
  Created site admin: admin
  Password:           [REDACTED — written to /tmp/visiban_admin_password]
============================================================
  Retrieve the password, then delete the file.
  You will be required to change it on first login.
============================================================
```

<a id="retrieving-the-password"></a>

## Retrieve the password

### Docker Compose

**Development:**

```bash
docker compose exec backend cat /tmp/visiban_admin_password
```

**Production:**

```bash
docker compose -f docker-compose.prod.yml exec backend cat /tmp/visiban_admin_password
```

Delete the file once you have the password:

```bash
docker compose -f docker-compose.prod.yml exec backend rm /tmp/visiban_admin_password
```

**Watch out:** The service is named `backend` in this project's compose files, not `api`.

### Local development (bare metal or venv)

```bash
cat /tmp/visiban_admin_password
```

:::tip[A `%` after the password isn't part of it]
The password is on its own line. If your shell shows a `%` right after it, that's a zsh prompt indicator. Copy only the characters before the `%`.
:::

<a id="kubernetes-helm"></a>

### Kubernetes and Helm

**How it works:** `ensure_site_admin` runs as the `bootstrap` init container on every deploy. It writes the password to `/run/visiban/admin_password` on a shared volume that persists into the running backend pod.

Retrieve it:

```bash
kubectl exec -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- cat /run/visiban/admin_password
```

Delete it once you have it:

```bash
kubectl exec -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- rm /run/visiban/admin_password
```

If the admin already exists (for example, the pod restarted before you retrieved the password), reset it:

```bash
kubectl exec -it -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- python manage.py changepassword admin
```

## No password file? Reset the password

:::note[Password file not found?]
The admin was already created on an earlier boot, and the password is written only once.

**Why it happens even on a "fresh" start:** The database lives in a named Docker volume that survives `docker compose down`, `up --build`, and image rebuilds. `/tmp` inside the `backend` container doesn't. Any time the container is recreated after the admin's first boot (a rebuild, a `down`/`up` cycle, or anything else that gives you a new container), `ensure_site_admin` finds the admin already in Postgres, does nothing, and never writes the file again. That file can't be recovered.
:::

Reset the password:

```bash
docker compose exec backend python manage.py changepassword admin
```

For production:

```bash
docker compose -f docker-compose.prod.yml exec backend python manage.py changepassword admin
```

**What a reset does:** It revokes any personal access tokens and API auth token issued under the old password. It doesn't change whether the account must choose a new password. The exception, by design, is the temporary password `ensure_site_admin` generates. That one sets the forced-change flag, because it's written to a file.

**Yes, but: `changepassword` needs a real TTY.** It prompts interactively. `docker compose exec` allocates a TTY by default in an interactive terminal, but scripts, CI, and some automation don't, and they fail with `EOFError`. In a non-interactive context, set the password directly:

```bash
docker compose exec -T backend python manage.py shell -c "
from django.db import transaction
from accounts.credentials import lock_user_row, revoke_credentials_after_operator_reset
from accounts.models import User
with transaction.atomic():
    u = lock_user_row(User.objects.get(username='admin'))
    u.set_password('a-new-temporary-password')
    u.must_change_password = True
    u.save()
    revoke_credentials_after_operator_reset(u)
"
```

:::caution[Lost the temporary password before changing it?]
Reset it the same way from the Django shell:

```python
from django.db import transaction
from accounts.credentials import lock_user_row, revoke_credentials_after_operator_reset
from accounts.models import User

with transaction.atomic():
    u = lock_user_row(User.objects.get(username="admin"))
    u.set_password("new-temporary-password")
    u.must_change_password = True
    u.save()
    revoke_credentials_after_operator_reset(u)
```
:::

<a id="changing-the-password"></a>

## Change the password

On first login you get a password change screen. You can't use the application until you set a new password of at least 12 characters, and you can't reuse the temporary one.

**After that:** Once SMTP is configured, any user (not just admins) can reset their own password with **Forgot password?** on the login page. No administrator is needed. For SMTP setup notes, see [Authentication: Forgot password](https://docs.visiban.com/latest/administration/authentication/#forgot-password-self-service-password-reset).

<a id="customizing-the-bootstrap-account"></a>

## Customize the bootstrap account

Set these **before** the first boot:

```bash
DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_EMAIL=admin@example.com
```

<a id="subsequent-boots"></a>

**On later boots:** `ensure_site_admin` still runs every time. Once a site admin exists the bootstrap does nothing, and credentials are never printed again. The command also re-syncs the Sites framework's domain from `SITE_DOMAIN` on every run, so a changed `SITE_DOMAIN` takes effect as soon as you restart the backend, with no extra step.

## Inviting your team

Choose how people join **before** you share the URL. Go to **Admin → Settings** and set the registration mode:

| Mode | Who can create an account |
|---|---|
| **Open** | Anyone who reaches the login page can self-register. No admin action needed. |
| **Invite-only** | New users must follow a valid invite link from a site admin. That's a site invite link or *(1.2+)* a group invite that a site admin emailed from a group's invite panel. Registration attempts without one are rejected. |
| **Closed** | Self-registration is off. Site admins create accounts by hand under **Admin → Users → Add user**. |

**How it works:** The change applies immediately, with no restart. Existing sessions and OAuth-linked accounts are never affected.

<a id="generating-invite-links-invite-only-mode"></a>

### Generate invite links (Invite-only mode)

**The big picture:** Invite links work for both password and OAuth sign-up. If a user follows an invite link and signs up with Google, GitHub, GitLab, or OIDC, the token rides through the OAuth redirect and is consumed when sign-up succeeds. Nobody has to enter a token by hand.

To create a link:

1. Open the **Admin** panel (`/admin`) and go to the **Invite Links** tab.
2. Click **Generate invite link**.
3. Choose an expiry: **1 day**, **7 days**, **30 days**, or **Never expires**.
4. Optionally turn on **Single-use**, which consumes the link on the first registration so it can't be reused.
5. Copy the generated token and send it to the new user over a secure channel.

**Watch out: you see the token once.** It isn't stored in plain text and can't be retrieved later. If a link is lost before it's used, revoke it and generate a new one.

| Status | Meaning |
|---|---|
| Pending | Valid and not yet used |
| Used | Consumed by a registration (single-use links only) |
| Expired | Past the expiry date |
| Revoked | Manually invalidated by a site admin |

:::note[By the numbers: 50 shareable links per instance]
At most 50 active (pending, unexpired) shareable invite links can exist per instance; revoke unused ones to stay under the limit. Invite links sent by email (new in 1.2, via `POST /api/v1/admin/invite-links/send/`) don't count toward it. They have a separate limit of 200 pending.
:::

<a id="creating-accounts-manually-closed-mode"></a>

### Create accounts by hand (Closed mode)

Use **Admin → Users → Add user**. Set a temporary password and turn on **Force password reset** so the user picks their own password on first login.

:::caution[Copy the temporary password before you close the dialog]
The Create User dialog doesn't show it again. Send it to the new user over a secure channel.
:::

<a id="loading-sample-data"></a>

**Next:** [Set up your first board](/getting-started/board-setup/). For a fully populated board to explore first, import a [sample board](/getting-started/sample-boards/). The backend image ships the JSON files, so **Import** on the dashboard → **Start from a sample** works without a download. To import a file yourself, or to get the CSVs (which are repo-only), download them from [`backend/boards/sample_boards/` on GitLab](https://gitlab.com/visiban/visiban/-/tree/main/backend/boards/sample_boards) (or the [GitHub mirror](https://github.com/visiban/visiban/tree/main/backend/boards/sample_boards)) and use **Dashboard → Import**.
