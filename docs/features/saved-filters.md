# Saved Filters

> **Added in 1.0**

Save a named filter combination on any board and restore it in one click. Saved filters are stored server-side, so they are available on every device and browser you use to access Visiban.

## Saving a filter

1. Open the board and set your filters using the filter bar (press `f` or click **Filters**).
2. Click the **Saved** dropdown to the right of the filter controls.
3. Click **Save current filters**, enter a descriptive name, and confirm.

The filter combination — search text, assignee, labels, priority, and due-date selection — is captured at save time. Changes to the filter bar after saving do not affect the stored preset.

## Loading a saved filter

Open the **Saved** dropdown and click any preset name. The filter bar updates immediately and the board redraws to show only matching cards.

## Deleting a saved filter

Hover over a preset name in the **Saved** dropdown to reveal the delete icon. Click it to remove the preset permanently. This action cannot be undone.

## Scope and privacy

Saved filters are private to each user. Other board members cannot see, load, or delete your presets.

Any board role — including Viewer — can create, load, and delete their own saved filters.

## API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/boards/{id}/saved-filters/` | List your saved filters for this board |
| `POST` | `/api/v1/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/v1/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |

See [`docs/api/boards.md`](../api/boards.md#saved-filters) for the full `state_json` shape and request/response fields.

## Schema versioning

Each saved filter carries a `state_version` field (introduced in 1.1). The version identifies the shape of the stored `state_json` so a future non-additive change to the filter state (for example, splitting one field into two) can be migrated forward without losing presets saved under the old shape.

Today only version `1` exists. The server accepts higher `state_version` values from newer clients unchanged — a mixed-version deploy where a newer frontend writes `state_version: 2` against an older backend will not lose the user's save. On read, older clients fall back to a defensive v1 reader for any shared fields; unknown v2-only fields are ignored.

Additive changes (adding a new optional key to `state_json`) do **not** require a version bump — update the key allow-list in the serializer's `validate_state_json` validator and the frontend `FilterState` type in the same release.
