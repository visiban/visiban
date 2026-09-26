# Notifications API

Visiban creates notifications for board members when:

- A card is assigned to them (`notif_card_assigned`)
- They are @mentioned in a comment or card description (`notif_mentioned`)
- A card they own is moved to a different column or swimlane (`notif_card_moved`)
- A card they own is due within 24 hours (`notif_due_soon`) — *added in 1.2*
- A card they own has not moved within the configured staleness window (`notif_stale`) — *added in 1.2; previously gated on `notif_due_soon`*
- They are invited to a board (`notif_board_invite`)

Each notification preference can be toggled individually via `PATCH /api/v1/auth/me/`. See [Authentication](authentication.md).

The first four events can also be delivered by email, controlled by a parallel set of
fields on the same endpoint — `email_notif_card_assigned`, `email_notif_mentioned`,
`email_notif_due_soon`, `email_notif_card_moved` — all of which default to `false`.
An email is a copy of the in-app notification, so an `email_notif_*` field has no effect
while its `notif_*` counterpart is `false`. See
[Email notifications](../features/notifications.md#email-notifications).

---

## Endpoints

### `GET /api/v1/notifications/`
List the 50 most recent **unread** notifications for the current user. Requires authentication.

Notifications referencing a board the requesting user no longer has access to are filtered from this list (and from `unread-count` below) — see #987.

**Response**
```json
[
  {
    "id": 1,
    "verb": "alice assigned you to \"Fix login bug\"",
    "actor": {
      "id": 7,
      "username": "alice",
      "display_name": "Alice",
      "avatar_url": ""
    },
    "action_type": "assigned",
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
| `actor` | object / null | User who triggered the notification (slim shape: `id`, `username`, `display_name`, `avatar_url`). `null` for system-generated notifications (e.g. stale-card alerts). Added in 1.1 (#1007). |
| `card_id` | integer / null | ID of the related card (null if the card has been deleted) |
| `card_title` | string / null | Card title at notification time (null if card deleted) |
| `board_id` | integer / null | ID of the related board |
| `board_name` | string / null | Board name (null if board deleted) |
| `action_type` | string | Machine-readable event type. One of: `assigned`, `mentioned`, `card_moved`, `stale`, `board_invite`, `due_soon` (`due_soon` added in 1.2). Use this for programmatic filtering or i18n instead of parsing `verb`. The set may grow in future releases — clients must treat an unrecognized value as a generic notification (render `verb` as-is) rather than erroring. |
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
