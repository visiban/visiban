# First Boot

The first time Visiban starts, it creates a one-time admin password — retrieve it, log in, and set your own password before inviting anyone else.

## Automatic admin bootstrap

On the very first startup — when no site admin exists — Visiban creates an admin account and writes the one-time password to a file (`/tmp/visiban_admin_password` by default). The password is **not** printed to stdout to prevent it appearing in container log aggregators such as CloudWatch, Datadog, or the Docker log driver.

The file is created exclusively with mode `0600` and symlinks are never followed. If something other than a regular file you own already exists at that path, Visiban refuses to use it and prints the password to the command's stdout instead. Set `VISIBAN_ADMIN_PASSWORD_FILE` to use a private directory instead of `/tmp`.

The stdout output looks like this:

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

### Retrieving the password

**Docker Compose (development):**

```bash
docker compose exec backend cat /tmp/visiban_admin_password
```

**Docker Compose (production):**

```bash
docker compose -f docker-compose.prod.yml exec backend cat /tmp/visiban_admin_password
```

Delete the file after retrieving it:

```bash
docker compose -f docker-compose.prod.yml exec backend rm /tmp/visiban_admin_password
```

!!! note "Password file not found?"
    If the file does not exist, the admin account was already created on a previous boot (the password is only written once). This commonly happens even on what looks like a fresh start: the database lives in a named Docker volume that survives `docker compose down` / `up --build` / image rebuilds, but `/tmp` inside the `backend` container does not. So the moment the container is recreated for any reason after the admin's first boot — a rebuild, a `down`/`up` cycle, anything that gives you a new container instance — `ensure_site_admin` sees the admin already exists in Postgres, no-ops, and never writes the file again. There is no way to recover that specific file after the fact.

    Reset the password with:

    ```bash
    docker compose exec backend python manage.py changepassword admin
    ```

    For production:

    ```bash
    docker compose -f docker-compose.prod.yml exec backend python manage.py changepassword admin
    ```

    `changepassword` prompts interactively and needs a real TTY (`docker compose exec` allocates one by default in an interactive terminal; scripts, CI, and some automation contexts do not and will fail with `EOFError`). In a non-interactive context, set the password directly instead:

    ```bash
    docker compose exec -T backend python manage.py shell -c "
    from accounts.models import User
    u = User.objects.get(username='admin')
    u.set_password('a-new-temporary-password')
    u.must_change_password = True
    u.save()
    "
    ```

    Also double check the service name — it's `backend` in this project's compose files, not `api`.

**Local development (bare metal / venv):**

```bash
cat /tmp/visiban_admin_password
```

!!! tip
    The password is on its own line. If your shell displays a `%` immediately after it, that is a zsh prompt indicator — it is **not** part of the password. Copy only the characters before the `%`.

### Kubernetes / Helm

`ensure_site_admin` runs automatically as a `bootstrap` init container on every deploy. The password is written to `/run/visiban/admin_password` inside a shared volume that persists into the running backend pod.

Retrieve the password with:

```bash
kubectl exec -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- cat /run/visiban/admin_password
```

Delete it once you have it:

```bash
kubectl exec -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- rm /run/visiban/admin_password
```

If the admin already exists (e.g. the pod restarted before you retrieved the password), reset the password with:

```bash
kubectl exec -it -n visiban $(kubectl get pods -n visiban -l app.kubernetes.io/component=backend -o jsonpath='{.items[0].metadata.name}') -- python manage.py changepassword admin
```

## Changing the password

On first login you will be shown a password change screen. You cannot access the application until a new password (minimum 12 characters) is set. The temporary password cannot be reused.

Once SMTP is configured, regular users (not just admins) can reset their own passwords via **Forgot password?** on the login page — no administrator intervention required. See [Authentication — Forgot password](../administration/authentication.md#forgot-password-self-service-password-reset) for SMTP setup notes.

## Customizing the bootstrap account

Set these environment variables **before** the first boot:

```bash
DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_EMAIL=admin@example.com
```

## Subsequent boots

`ensure_site_admin` runs on every boot. Admin bootstrap is a no-op once a site admin exists — credentials are never printed again — but the command also re-syncs the Sites framework's domain from `SITE_DOMAIN` every time it runs, so changing `SITE_DOMAIN` and restarting the backend takes effect immediately, with no extra step.

!!! warning
    If you lose the temporary password before changing it, reset it via the Django shell:
    ```python
    from accounts.models import User
    u = User.objects.get(username="admin")
    u.set_password("new-temporary-password")
    u.save()
    ```

## Inviting your team

Before inviting anyone, decide how new users can join the instance. Go to **Admin → Settings** and set the registration mode:

| Mode | Who can create an account |
|---|---|
| **Open** | Anyone who reaches the login page can self-register — no action required from an admin |
| **Invite-only** | New users must follow a valid invite link generated by a site admin; attempts to register without a link are rejected |
| **Closed** | Self-registration is disabled entirely; site admins create accounts manually from **Admin → Users → Add user** |

The change takes effect immediately with no restart required. Existing sessions and OAuth-linked accounts are never affected.

### Generating invite links (Invite-only mode)

When registration mode is set to Invite-only, go to **Admin → Invite Links** to create links for new users.

Invite links work for both password-based and OAuth registration. When a user follows an invite link and chooses to sign up via Google, GitHub, GitLab, or OIDC, the token is carried through the OAuth redirect and consumed on successful signup — no manual token entry required.

**To create a link:**

1. Open the **Admin** panel (`/admin`) and go to the **Invite Links** tab.
2. Click **Generate invite link**.
3. Choose an expiry window: **1 day**, **7 days**, **30 days**, or **Never expires**.
4. Optionally enable **Single-use** — the link is consumed after the first registration and cannot be reused.
5. Copy the generated token and share it with the new user via a secure channel.

The raw token value is shown only once at creation — it is not stored in plain text and cannot be retrieved later. If a link is lost before it is used, revoke it and generate a new one.

**Link statuses:**

| Status | Meaning |
|---|---|
| Pending | Valid and not yet used |
| Used | Consumed by a registration (single-use links only) |
| Expired | Past the expiry date |
| Revoked | Manually invalidated by a site admin |

!!! note
    A maximum of 50 active (pending, non-expired) invite links can exist at one time per instance. Revoke unused links to stay below this limit.

### Creating accounts manually (Closed mode)

When registration mode is Closed, use **Admin → Users → Add user** to create accounts directly. Set a temporary password and enable **Force password reset** so the user chooses their own password on first login.

!!! warning
    Copy the temporary password before closing the Create User dialog — it is not shown again. Share it with the new user via a secure channel.

## Loading sample data

To see a fully populated board before your team's real work arrives, import one of the
sample boards. They are not shipped inside the Docker images or the Helm chart; download
them from [`sample-boards/` on GitLab](https://gitlab.com/visiban/visiban/-/tree/main/sample-boards)
(or the [GitHub mirror](https://github.com/visiban/visiban/tree/main/sample-boards)), then
use **Dashboard → Import**. See [Sample Boards](sample-boards.md) for the list and for what
each board demonstrates.
