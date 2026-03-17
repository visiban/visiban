# Stable UIDs

> **Added in 1.0.0-rc.5**

Every board object — boards, columns, swimlanes, labels, and cards — carries a stable, globally unique identifier called a **UID**.

## What is a UID?

A UID is a 16-character lowercase hex string (64 bits of randomness), generated once when the object is created and never changed again. Example: `3a9f1c2d7e4b8a05`.

UIDs are:

- **Globally unique** — no two objects of the same type will ever share a UID, even across different boards or installations.
- **Stable across renames** — renaming a column or swimlane does not change its UID.
- **Stable across moves** — moving a card to a different column does not change the card's UID.
- **Read-only** — the API ignores any attempt to set or change a UID via `POST` or `PATCH`.
- **Permanent** — once assigned, a UID is never reused, even after the object is deleted.

## Where UIDs appear

UIDs are included in all API responses that return the relevant object type.

| Object | Field | Where it appears |
|---|---|---|
| Board | `uid` | `GET /api/boards/`, `GET /api/boards/{id}/`, `GET /api/boards/{id}/full/` |
| Column | `uid` | `GET /api/boards/{id}/full/` (inside `columns` array) |
| Swimlane | `uid` | `GET /api/boards/{id}/full/` (inside `swimlanes` array) |
| Label | `uid` | `GET /api/boards/{id}/full/` (inside `labels` array), `GET /api/boards/{id}/labels/` |
| Card | `uid` | All card endpoints |

## UIDs in movement history

When a card is moved, `CardMovement` captures the UID of the source and destination column and swimlane **at the time of the move**. These UID fields are:

| Field | Meaning |
|---|---|
| `from_column_uid` | UID of the column the card left |
| `to_column_uid` | UID of the column the card entered |
| `from_swimlane_uid` | UID of the swimlane the card left |
| `to_swimlane_uid` | UID of the swimlane the card entered |

These values survive the deletion or renaming of the referenced column or swimlane. After a column is deleted, its `id` FK becomes `null` in the movement record, but the `_uid` field retains the original value. This makes UIDs the correct identifier to use when reconciling movement history against an external system.

!!! tip
    If you are building an integration that tracks where cards have been, use the `*_uid` fields — not the `*_id` or `*_name` fields. Names change. IDs become null after deletion. UIDs are permanent.

## Using UIDs in integrations

### Example: correlating a card across two API calls

```python
# Fetch the board
board = requests.get("/api/boards/42/full/").json()

# Map column UIDs to names for later reference
col_by_uid = {c["uid"]: c["name"] for c in board["columns"]}

# Later — look up movement history for a card
movements = requests.get("/api/boards/42/cards/101/movements/").json()
for mv in movements:
    to_col = col_by_uid.get(mv["to_column_uid"], f"<deleted: {mv['to_column_uid']}>")
    print(f"Card moved to: {to_col} at {mv['moved_at']}")
```

Because `to_column_uid` is stable, this lookup works correctly even if the column was renamed after the move.

### Example: webhook deduplication

If your webhook processor receives board update events, use the `uid` to deduplicate or update records without relying on the numeric `id`:

```python
def handle_card_event(payload):
    uid = payload["card"]["uid"]
    record = db.upsert("cards", uid=uid, title=payload["card"]["title"])
```

Numeric `id` values are local to each Visiban installation. UIDs are the correct key to use when storing Visiban objects in an external system.

## UIDs in export files

The JSON and CSV exports (`GET /api/boards/{id}/export/`) serialize objects **by name, not by UID**. UIDs are not included in export files. This is intentional: the export format is designed for portability — columns and swimlanes are referenced by name so the file can be imported into a different board or a different Visiban installation without carrying over identifiers that are meaningless in the new context.

## UIDs on import

When a board is imported via `POST /api/boards/import/`, **every object receives a brand new UID** regardless of the source file. This applies to boards, columns, swimlanes, labels, and cards.

- If the source file was produced by the Visiban export endpoint, the original UIDs are not preserved — the imported board is a new entity with new identities.
- If the source file was hand-crafted (e.g. for automation testing or to match the import template spec), any `uid` field present in the JSON is silently ignored.

This means you cannot use UIDs to correlate an imported board with its export source. If you need to track which records came from a specific import, use the board name or a naming convention, then delete those boards explicitly after use.

!!! warning "Imported test data is indistinguishable from real data"
    Records created via import carry no provenance marker. An imported test card looks identical to a real card — same UID format, same `archived_at` behavior, same appearance in movement history. Clean up test imports explicitly; there is no automated way to find and remove them after the fact. See [Demo Data](../administration/demo-data.md) for cleanup guidance.

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
