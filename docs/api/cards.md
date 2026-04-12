# Cards API

## Cards

### `GET /api/v1/boards/{board_id}/cards/`
List all cards on the board. Pagination is disabled — all cards are returned in a single response.

**Query parameters**

| Parameter | Description |
|---|---|
| `?search=<q>` | Filter by title and description (partial, case-insensitive) |
| `?assignee=<id>` | Filter by assignee user ID |
| `?unassigned=true` | Return only cards with no assignee |
| `?priority=<value>` | Filter by priority (`low`, `medium`, `high`, `urgent`) |
| `?column=<id>` | Filter by column ID |
| `?swimlane=<id>` | Filter by swimlane ID |
| `?due_before=<YYYY-MM-DD>` | Cards with a due date on or before this date (ISO 8601) |
| `?due_after=<YYYY-MM-DD>` | Cards with a due date on or after this date (ISO 8601) |
| `?overdue=true` | Cards past their due date (due date is set and is before today) |
| `?ordering=<field>` | Sort results. Prefix with `-` for descending. Allowed fields: `position` (default), `due_date`, `created_at`, `priority`. Example: `?ordering=-due_date` |

### `POST /api/v1/boards/{board_id}/cards/`
Create a card. Requires member or above. The target column must have `allow_card_creation` enabled.

**Request**
```json
{
  "title": "Fix login bug",
  "column": 1,
  "swimlane": 2,
  "priority": "high",
  "assignee_id": 5,
  "label_ids": [1, 3],
  "due_date": "2026-04-01",
  "weight": 2
}
```

### `GET /api/v1/boards/{board_id}/cards/{id}/`
Get a single card. The response includes a `uid` field — a stable 16-character hex identifier that does not change when the card is renamed, moved, or reassigned. The `uid` is read-only. The response also includes a `version` integer that increments on every mutation; clients may pass this value back on the [move endpoint](#move) as an optimistic concurrency token.

### `PATCH /api/v1/boards/{board_id}/cards/{id}/`
Update card fields. Requires member or above.

**Patchable fields:** `title`, `description`, `priority`, `weight`, `due_date`, `assignee_id`, `label_ids`

> **Do not PATCH `column` or `swimlane` directly.** These fields are present in the serializer response but patching them bypasses WIP/weight enforcement, skips `CardMovement` record creation, and skips position reordering — corrupting board state silently. To move a card, always use `POST /api/v1/boards/{board_id}/cards/{id}/move/`.

> `uid` is not patchable — any `uid` value sent in the request body is silently ignored.

### `DELETE /api/v1/boards/{board_id}/cards/{id}/`
Delete a card. Requires member or above.

---

## Archive

### `POST /api/v1/boards/{board_id}/cards/{id}/archive/`
Soft-delete a card. Sets `archived_at` to the current timestamp. The card is removed from the active board view and excluded from WIP/weight counts. **Minimum role: Member.**

If the card is already archived this is a no-op — `200 OK` is returned with the current card state.

**Response** — full card object with `archived_at` set.

Broadcasts `card.archived` to all board WebSocket subscribers.

### `POST /api/v1/boards/{board_id}/cards/{id}/unarchive/`
Unarchive a card. Clears `archived_at`; the card re-enters its original column and swimlane at its original position. **Minimum role: Member.**

**Response** — full card object with `archived_at: null`.

Broadcasts `card.unarchived` to all board WebSocket subscribers.

### `GET /api/v1/boards/{board_id}/cards/archived/`
List all archived cards for the board, newest archived first. Available to all board members including viewers.

**Query parameters**

| Parameter | Description |
|---|---|
| `offset` | Pagination offset (default: `0`) |

**Response** — paginated envelope, page size fixed at 50:

```json
{
  "count": 124,
  "offset": 0,
  "page_size": 50,
  "results": [
    { "id": 101, "uid": "3a9f1c2d7e4b8a05", "archived_at": "2026-03-20T12:00:00Z", "..." : "..." }
  ]
}
```

### `GET /api/v1/boards/{board_id}/cards/{id}/status/`
Check whether a card exists and whether it is archived. Used by the deep-link handler (`?card=`) to display a contextual message when the target card is not visible in the active board view.

**Permissions:** any board member (viewer and above).

**Response**
```json
{ "archived": true }
```

| Field | Type | Description |
|---|---|---|
| `archived` | boolean | `true` when the card exists but is archived; `false` when it is active |

**Errors:** `404 Not Found` if the card does not belong to this board or has been hard-deleted.

---

## Move

### `POST /api/v1/boards/{board_id}/cards/{id}/move/`
Move a card to a new column/swimlane/position. Creates a `CardMovement` record if column or swimlane changes. Requires member or above.

**Request**
```json
{ "column_id": 3, "swimlane_id": 2, "position": 0, "version": 4 }
```

| Field | Required | Description |
|---|---|---|
| `column_id` | ✓ | ID of the destination column (must belong to this board) |
| `swimlane_id` | ✓ | ID of the destination swimlane (must belong to this board) |
| `position` | | Target position within the destination cell (0-based, default: `0`) |
| `version` | | Optimistic concurrency token. When provided, the server rejects the move with `409 Conflict` (`code: "version_conflict"`) if the card has been modified since the client last fetched it. Omitting this field disables the OCC check. |

**Version conflict error**

```json
{
  "code": "version_conflict",
  "detail": "This card was modified by another user. Please refresh and try again.",
  "current_version": 5
}
```

**Response**
```json
{
  "card": { "id": 101, "uid": "3a9f1c2d7e4b8a05", ... },
  "movement": {
    "id": 42,
    "from_column": 2,
    "from_column_name": "To Do",
    "from_column_uid": "a1b2c3d4e5f60718",
    "to_column": 3,
    "to_column_name": "Doing",
    "to_column_uid": "9f8e7d6c5b4a3210",
    "from_swimlane": 1,
    "from_swimlane_name": "Acme Corp",
    "from_swimlane_uid": "deadbeef01234567",
    "to_swimlane": 1,
    "to_swimlane_name": "Acme Corp",
    "to_swimlane_uid": "deadbeef01234567",
    "moved_by": { "id": 7, "username": "alice", "display_name": "Alice Smith", "avatar_url": null },
    "moved_at": "2026-03-15T09:41:22Z",
    "movement_type": "move",
    "notes": ""
  }
}
```

| Field | Type | Description |
|---|---|---|
| `moved_by` | object | User who performed the move — `{ id, username, display_name, avatar_url }` |
| `movement_type` | string | Always `"move"` for explicit card moves via this endpoint |
| `notes` | string | Optional notes recorded at move time (empty string by default) |

`movement` is `null` if only position changed within the same cell.

**WIP / weight limit enforcement**

When `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board and the target column is at or above its limit, the move returns `409 Conflict`:

```json
{ "code": "wip_limit_exceeded", "column_name": "Doing", "current_count": 5, "wip_limit": 5 }
```

```json
{ "code": "weight_limit_exceeded", "column_name": "Doing", "current_weight": 10, "weight_limit": 10, "card_weight": 2 }
```

When `enforce_wip_hard` is enabled on the board, the limit cannot be overridden by any role — all users receive `409 Conflict` with code `wip_hard_blocked`:

```json
{ "code": "wip_hard_blocked", "column_name": "Doing", "current_count": 5, "wip_limit": 5 }
```

When `enforce_wip_hard` is not enabled, board admins may override the limit by appending `?force=true` to the move URL:

```bash
POST /api/v1/boards/1/cards/42/move/?force=true
```

Non-admin users who send `?force=true` receive `403 Forbidden`.

The `*_uid` fields in the movement record are permanent — they remain set even after the referenced column or swimlane is deleted (the FK `*_id` field becomes `null` at that point, but the UID is preserved). See [Stable UIDs](../features/stable-uids.md).

---

## History

### `GET /api/v1/boards/{board_id}/cards/{id}/movements/`
Full movement history for a card. Each record includes `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, and `to_swimlane_uid` in addition to the FK and name fields. UID fields are stable across column/swimlane renames and deletions. See [Stable UIDs](../features/stable-uids.md).

### `GET /api/v1/boards/{board_id}/cards/{id}/activities/`
Activity log (field changes, comments, attachments, checklist events).

---

## Comments

### `GET /api/v1/boards/{board_id}/cards/{id}/comments/`
List comments. Requires board member or above.

### `POST /api/v1/boards/{board_id}/cards/{id}/comments/`
Add a comment. **Minimum role: Collaborator.**

**Request** `{ "body": "Looking into this now." }`

### `DELETE /api/v1/boards/{board_id}/cards/{id}/comments/{comment_id}/`
Delete a comment. **Minimum role: Collaborator.** Collaborators and members may only delete their own comments. Admins and members/collaborators with the `is_moderator` entitlement may delete any comment.

---

## Attachments

### `GET /api/v1/boards/{board_id}/cards/{id}/attachments/`
List attachments. Response fields per attachment: `id`, `filename`, `size` (bytes), `url` (relative URL), `uploaded_by` (user object), `uploaded_at`.

To download an attachment file, fetch its `url` URL with the same `Authorization` header used for API requests — attachments are served via the authenticated `/media/<path>` route. Unauthenticated requests and requests from users without board membership return `403 Forbidden`.

```bash
curl -O -J http://localhost:8000/media/attachments/abc123.pdf \
  -H "Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b"
```

### `POST /api/v1/boards/{board_id}/cards/{id}/attachments/`
Upload an attachment (`multipart/form-data`, field name `file`). Max size: 10 MB. **Minimum role: Collaborator.**

**Allowed file types**

The server validates both the declared `Content-Type` and the file's magic bytes. Uploads with a disallowed type are rejected with `HTTP 400`.

| Category | Accepted types |
|---|---|
| Images | JPEG, PNG, GIF, WebP |
| Documents | PDF |
| Office (OOXML) | DOCX, XLSX, PPTX |
| Archives | ZIP |
| Text | Plain text, CSV |

**Error response (unsupported type)**

```json
{ "detail": "File type 'application/x-executable' is not allowed. Accepted types: images (JPEG, PNG, GIF, WebP), PDF, Office documents (DOCX, XLSX, PPTX), plain text, CSV, ZIP." }
```

**Error response (magic-byte mismatch)**

```json
{ "detail": "File content does not match a recognized safe format. The file may be corrupt or its type may have been misrepresented." }
```

### `DELETE /api/v1/boards/{board_id}/cards/{id}/attachments/{attachment_id}/`
Delete an attachment. **Minimum role: Collaborator.** Collaborators and members may only delete their own attachments. Members/collaborators with the `is_moderator` entitlement may delete any attachment.

---

## Checklist

### `GET /api/v1/boards/{board_id}/cards/{id}/checklist/`
List checklist items.

### `POST /api/v1/boards/{board_id}/cards/{id}/checklist/`
Add a checklist item. **Minimum role: Collaborator.**

**Request** `{ "text": "Write tests" }`

### `PATCH /api/v1/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Update an item (e.g. check/uncheck). **Minimum role: Collaborator.**

**Request** `{ "is_checked": true }`

### `DELETE /api/v1/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Delete a checklist item. **Minimum role: Collaborator.**
