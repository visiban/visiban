# Managing Roles

## Board membership

Board admins can add, change, or remove members via the board settings panel or the API.

```http
POST /api/boards/{board_id}/members/
{ "user_id": 42, "role": "member" }

DELETE /api/boards/{board_id}/members/42/
```

Valid board roles: `admin`, `member`, `collaborator`, `viewer`

## Group membership

Group admins can change or remove members from the group detail page or the API.

```http
PATCH /api/groups/{group_id}/members/42/
{ "role": "admin" }

DELETE /api/groups/{group_id}/members/42/
```

Valid group roles: `admin`, `member`, `collaborator`, `viewer`

## Granting site admin

Site admin status is a field on the `User` model (`is_site_admin`). It can be set via:

**Management command (recommended)**

```bash
# Grant
python manage.py set_site_admin <username>

# Revoke
python manage.py set_site_admin <username> --revoke

# Docker
docker compose run --rm backend python manage.py set_site_admin <username>
```

**Django admin panel**

Navigate to `/admin/accounts/user/`, find the user, and toggle the `is_site_admin` checkbox.

!!! note "Two separate flags"
    The `set_site_admin` command sets both `is_site_admin` (admin panel access) and `can_access_all_content` (board/group omniscience) together. To manage them independently — for example, granting admin panel access without board omniscience — use the admin panel instead. See [Site Admins](../../administration/site-admins.md) for details.

!!! warning
    The `is_site_admin` flag protects the user from demotion: any role-change or remove-member API call targeting a user with `is_site_admin=True` returns `403 Forbidden` unless the caller is also a site admin. This protection is based on `is_site_admin` specifically, not `can_access_all_content`.

    Only grant site admin to trusted operators.
