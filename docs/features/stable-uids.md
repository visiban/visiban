# Stable UIDs

Every board object — boards, columns, swimlanes, labels, cards, and custom field definitions — carries a stable, globally unique identifier called a **UID**. **Why it matters:** names change and numeric IDs go null on delete; a UID never does, so it's the safe key for external systems.

## What is a UID?

A UID is a 16-character lowercase hex string (64 bits of randomness), generated once when the object is created and never changed again. Example: `3a9f1c2d7e4b8a05`.

UIDs are:

- **Globally unique** — no two objects of the same type will ever share a UID, even across different boards or installations.
- **Stable across renames** — renaming a column or swimlane does not change its UID.
- **Stable across moves** — moving a card to a different column does not change the card's UID.
- **Read-only** — the API ignores any attempt to set or change a UID via `POST` or `PATCH`.
- **Permanent** — once assigned, a UID is never reused, even after the object is deleted.

## Where UIDs appear

UIDs appear in every API response that returns the object type.

| Object | Field | Where it appears |
|---|---|---|
| Board | `uid` | `GET /api/v1/boards/`, `GET /api/v1/boards/{id}/`, `GET /api/v1/boards/{id}/full/` |
| Column | `uid` | `GET /api/v1/boards/{id}/full/` (inside `columns` array) |
| Swimlane | `uid` | `GET /api/v1/boards/{id}/full/` (inside `swimlanes` array) |
| Label | `uid` | `GET /api/v1/boards/{id}/full/` (inside `labels` array), `GET /api/v1/boards/{id}/labels/` |
| Card | `uid` | All card endpoints |
| Custom field definition | `uid` | `GET /api/v1/boards/{id}/custom-fields/`, `GET /api/v1/boards/{id}/swimlane-custom-fields/` — see [Custom Fields](custom-fields.md) |

## UIDs in movement history

When a card is moved, `CardMovement` captures the UID of the source and destination column and swimlane **at the time of the move**. These UID fields are:

| Field | Meaning |
|---|---|
| `from_column_uid` | UID of the column the card left |
| `to_column_uid` | UID of the column the card entered |
| `from_swimlane_uid` | UID of the swimlane the card left |
| `to_swimlane_uid` | UID of the swimlane the card entered |

These values survive the deletion or renaming of the referenced column or swimlane. After a column is deleted, its `id` FK becomes `null` in the movement record, but the `_uid` field keeps the original value — the right identifier for reconciling movement history against an external system.

!!! tip
    Building an integration that tracks where cards have been? Use the `*_uid` fields, not `*_id` or `*_name`. Names change. IDs go null after deletion. UIDs are permanent.

## Using UIDs in integrations

### Example: correlating a card across two API calls

```python
# Fetch the board
board = requests.get("/api/v1/boards/42/full/").json()

# Map column UIDs to names for later reference
col_by_uid = {c["uid"]: c["name"] for c in board["columns"]}

# Later — look up movement history for a card
movements = requests.get("/api/v1/boards/42/cards/101/movements/").json()
for mv in movements:
    to_col = col_by_uid.get(mv["to_column_uid"], f"<deleted: {mv['to_column_uid']}>")
    print(f"Card moved to: {to_col} at {mv['moved_at']}")
```

This lookup works even if the column was renamed after the move, because `to_column_uid` never changes.

### Example: webhook deduplication

Use `uid`, not the numeric `id`, to deduplicate or update records from webhook events:

```python
def handle_card_event(payload):
    uid = payload["card"]["uid"]
    record = db.upsert("cards", uid=uid, title=payload["card"]["title"])
```

Numeric `id` values are local to each installation. UIDs are the right key for storing Visiban objects in an external system.

## UIDs in export files

The JSON and CSV exports (`GET /api/v1/boards/{id}/export/`) serialize objects **by name, not by UID** — UIDs aren't included at all. This is intentional: the export format is built for portability, so columns and swimlanes are referenced by name and the file can be imported into a different board or installation without carrying over identifiers meaningless in the new context.

## UIDs on import

Importing a board via `POST /api/v1/boards/import/` assigns **every object a brand new UID**, regardless of the source file. This applies to boards, columns, swimlanes, labels, and cards.

- If the source file was produced by the Visiban export endpoint, the original UIDs are not preserved — the imported board is a new entity with new identities.
- If the source file was hand-crafted (e.g. for automation testing or to match the import template spec), any `uid` field present in the JSON is silently ignored.

You can't use UIDs to correlate an imported board with its export source. To track which records came from a specific import, use the board name or a naming convention, then delete those boards explicitly after use.

!!! warning "Imported test data is indistinguishable from real data"
    Records created via import carry no provenance marker. An imported test card looks identical to a real card — same UID format, same `archived_at` behavior, same appearance in movement history. Clean up test imports explicitly; there's no automated way to find and remove them after the fact. See [Demo Data](../administration/demo-data.md) for cleanup guidance.

## API response examples

### Card (excerpt)

```json
{
  "id": 101,
  "uid": "3a9f1c2d7e4b8a05",
  "title": "Investigate login failure",
  "column": 3,
  "swimlane": 1,
  "priority": "high"
}
```

### CardMovement (excerpt)

```json
{
  "id": 55,
  "from_column": 2,
  "from_column_name": "To Do",
  "from_column_uid": "a1b2c3d4e5f60718",
  "to_column": 3,
  "to_column_name": "In Progress",
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
```

After `to_column` is later deleted, the same record looks like:

```json
{
  "to_column": null,
  "to_column_name": "In Progress",
  "to_column_uid": "9f8e7d6c5b4a3210"
}
```

The name and UID are preserved even though the FK is null.
