# Cards API

## Cards

### `GET /api/boards/{board_id}/cards/`
List all cards on the board. Pagination is disabled — all cards are returned in a single response. Supports `?search=<q>` (title and description), `?assignee=<id>`, `?priority=<value>`, `?label=<id>`, and `?due_date_before=<YYYY-MM-DD>`.

### `POST /api/boards/{board_id}/cards/`
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

### `GET /api/boards/{board_id}/cards/{id}/`
Get a single card. The response includes a `uid` field — a stable 16-character hex identifier that does not change when the card is renamed, moved, or reassigned. The `uid` is read-only.

### `PATCH /api/boards/{board_id}/cards/{id}/`
Update card fields. Requires member or above.

**Patchable fields:** `title`, `description`, `priority`, `weight`, `due_date`, `assignee_id`, `label_ids`, `column`, `swimlane`

> `uid` is not patchable — any `uid` value sent in the request body is silently ignored.

### `DELETE /api/boards/{board_id}/cards/{id}/`
Delete a card. Requires member or above.

---

## Move

### `POST /api/boards/{board_id}/cards/{id}/move/`
Move a card to a new column/swimlane/position. Creates a `CardMovement` record if column or swimlane changes. Requires member or above.

**Request**
```json
{ "column_id": 3, "swimlane_id": 2, "position": 0 }
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
    "moved_by": { "id": 7, "username": "alice" },
    "moved_at": "2026-03-15T09:41:22Z",
    "notes": ""
  }
}
```

`movement` is `null` if only position changed within the same cell.

**WIP / weight limit enforcement**

When `enforce_wip_limits` or `enforce_weight_limits` is enabled on the board and the target column is at or above its limit, the move returns `409 Conflict`:

```json
{ "code": "wip_limit_exceeded", "detail": "Column 'Doing' is at its WIP limit (5).", "column_id": 3, "wip_limit": 5, "current_count": 5 }
```

```json
{ "code": "weight_limit_exceeded", "detail": "Column 'Doing' is at its weight limit (10).", "column_id": 3, "weight_limit": 10, "current_weight": 10 }
```

Board admins may override the limit by appending `?force=true` to the move URL:

```bash
POST /api/boards/1/cards/42/move/?force=true
```

Non-admin users who send `?force=true` receive `403 Forbidden`.

The `*_uid` fields in the movement record are permanent — they remain set even after the referenced column or swimlane is deleted (the FK `*_id` field becomes `null` at that point, but the UID is preserved). See [Stable UIDs](../features/stable-uids.md).

---

## History

### `GET /api/boards/{board_id}/cards/{id}/movements/`
Full movement history for a card. Each record includes `from_column_uid`, `to_column_uid`, `from_swimlane_uid`, and `to_swimlane_uid` in addition to the FK and name fields. UID fields are stable across column/swimlane renames and deletions. See [Stable UIDs](../features/stable-uids.md).

### `GET /api/boards/{board_id}/cards/{id}/activities/`
Activity log (field changes, comments, attachments, checklist events).

---

## Comments

### `GET /api/boards/{board_id}/cards/{id}/comments/`
List comments. Requires board member or above.

### `POST /api/boards/{board_id}/cards/{id}/comments/`
Add a comment. **Minimum role: Collaborator.**

**Request** `{ "body": "Looking into this now." }`

### `DELETE /api/boards/{board_id}/cards/{id}/comments/{comment_id}/`
Delete a comment. **Minimum role: Collaborator.** Collaborators may only delete their own comments; members and above may delete any comment.

---

## Attachments

### `GET /api/boards/{board_id}/cards/{id}/attachments/`
List attachments.

### `POST /api/boards/{board_id}/cards/{id}/attachments/`
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

### `DELETE /api/boards/{board_id}/cards/{id}/attachments/{attachment_id}/`
Delete an attachment. **Minimum role: Collaborator.**

---

## Checklist

### `GET /api/boards/{board_id}/cards/{id}/checklist/`
List checklist items.

### `POST /api/boards/{board_id}/cards/{id}/checklist/`
Add a checklist item. **Minimum role: Collaborator.**

**Request** `{ "text": "Write tests" }`

### `PATCH /api/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Update an item (e.g. check/uncheck). **Minimum role: Collaborator.**

**Request** `{ "is_checked": true }`

### `DELETE /api/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Delete a checklist item. **Minimum role: Collaborator.**
