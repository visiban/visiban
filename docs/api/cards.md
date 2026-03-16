# Cards API

## Cards

### `GET /api/boards/{board_id}/cards/`
List all cards on the board.

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
Get a single card.

### `PATCH /api/boards/{board_id}/cards/{id}/`
Update card fields. Requires member or above.

**Patchable fields:** `title`, `description`, `priority`, `weight`, `due_date`, `assignee_id`, `label_ids`, `column`, `swimlane`

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
  "card": { ... },
  "movement": { "id": 42, "from_column_name": "To Do", "to_column_name": "Doing", ... }
}
```

`movement` is `null` if only position changed within the same cell.

---

## History

### `GET /api/boards/{board_id}/cards/{id}/movements/`
Full movement history for a card.

### `GET /api/boards/{board_id}/cards/{id}/activities/`
Activity log (field changes, comments, attachments, checklist events).

---

## Comments

### `GET /api/boards/{board_id}/cards/{id}/comments/`
List comments. Requires board member or above.

### `POST /api/boards/{board_id}/cards/{id}/comments/`
Add a comment. Requires collaborator or above.

**Request** `{ "body": "Looking into this now." }`

---

## Attachments

### `GET /api/boards/{board_id}/cards/{id}/attachments/`
List attachments.

### `POST /api/boards/{board_id}/cards/{id}/attachments/`
Upload an attachment (`multipart/form-data`, field name `file`). Max size: 10 MB.

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
Delete an attachment.

---

## Checklist

### `GET /api/boards/{board_id}/cards/{id}/checklist/`
List checklist items.

### `POST /api/boards/{board_id}/cards/{id}/checklist/`
Add a checklist item.

**Request** `{ "text": "Write tests" }`

### `PATCH /api/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Update an item (e.g. check/uncheck).

**Request** `{ "is_checked": true }`

### `DELETE /api/boards/{board_id}/cards/{id}/checklist/{item_id}/`
Delete a checklist item.
