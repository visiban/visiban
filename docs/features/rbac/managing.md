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

Valid group roles: `admin`, `member`

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

!!! warning
    Only grant site admin to trusted operators. Site admins have unrestricted access to all data and cannot be removed by regular admins.
