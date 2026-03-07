# Authentication API

All endpoints except login, registration, OAuth, and invite-link resolution require an authenticated session (cookie-based).

## Endpoints

### `POST /api/auth/login/`

Log in with username or email and password.

**Request**
```json
{ "username": "alice", "password": "secret" }
```
*`username` accepts either a username or an email address.*

**Response** `200 OK` — sets session cookie.

---

### `POST /api/auth/logout/`

End the current session.

**Response** `200 OK`

---

### `POST /api/auth/registration/`

Create a new account.

**Request**
```json
{ "username": "alice", "email": "alice@example.com", "password1": "secret", "password2": "secret" }
```

**Response** `201 Created`

---

### `GET /api/auth/user/`

Return the current authenticated user.

**Response**
```json
{
  "id": 1,
  "username": "alice",
  "email": "alice@example.com",
  "display_name": "Alice",
  "avatar_url": "",
  "is_site_admin": false,
  "must_change_password": false
}
```

---

### `PATCH /api/auth/user/`

Update profile fields.

**Request** (all fields optional)
```json
{ "display_name": "Alice Smith", "email": "alice@example.com" }
```

---

### `POST /api/auth/change-password/`

Change the current user's password. Clears `must_change_password` on success.

**Request**
```json
{ "current_password": "old", "new_password": "new-min-12-chars" }
```

**Response** `200 OK` or `400` with `detail` message.

---

### `GET /api/auth/providers/`

Returns which OAuth providers are configured.

**Response**
```json
{ "google": true, "github": false, "gitlab": true }
```
