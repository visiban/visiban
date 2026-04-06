# Notifications API

Visiban creates notifications for board members when:

- A card is assigned to them (`notif_card_assigned`)
- They are @mentioned in a comment or card description (`notif_mentioned`)
- A card's due date is approaching (`notif_due_soon`)
- A card they own is moved (`notif_card_moved`)
- A comment is added to a card they own (`notif_comment_added`)

Each notification preference can be toggled individually via `PATCH /api/v1/auth/me/`. See [Authentication](authentication.md).

---

## Endpoints

### `GET /api/v1/notifications/`
List the 50 most recent **unread** notifications for the current user. Requires authentication.

**Response**
```json
[
  {
    "id": 1,
    "verb": "alice assigned you to \"Fix login bug\"",
    "action_type": "card_assigned",
    "card_id": 42,
    "card_title": "Fix login bug",
    "board_id": 3,
    "board_name": "Sales Pipeline",
    "read": false,
    "created_at": "2026-03-15T09:41:22Z"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `id` | integer | Notification ID — used with `mark-read` |
| `verb` | string | Human-readable description of the event |
| `card_id` | integer / null | ID of the related card (null if the card has been deleted) |
| `card_title` | string / null | Card title at notification time (null if card deleted) |
| `board_id` | integer / null | ID of the related board |
| `board_name` | string / null | Board name (null if board deleted) |
| `action_type` | string | Machine-readable event type (e.g. `card_assigned`, `mentioned`, `due_soon`, `card_moved`, `comment_added`, `board_invite`). Use this for programmatic filtering or i18n instead of parsing `verb`. |
| `read` | boolean | Always `false` — this endpoint only returns unread notifications |
| `created_at` | string | ISO 8601 timestamp |

---

### `POST /api/v1/notifications/mark-read/`
Mark notifications as read. Requires authentication.

**Mark specific notifications**
```json
{ "ids": [1, 2, 3] }
```

**Mark all unread notifications**
```json
{ "all": true }
```

**Response** `{ "ok": true }`

---

### `GET /api/v1/notifications/unread-count/`
Return the count of unread notifications for the current user. Used by the navbar bell badge. Requires authentication.

**Response** `{ "count": 5 }`
