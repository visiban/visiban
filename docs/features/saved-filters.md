# Save a filter once, reuse it in one click

<a id="saved-filters"></a>

> **Added in 1.0**

Set your filters, open the **Saved** dropdown next to the filter bar, and click **Save current filters**. Click a preset name later to restore it.

**Why it matters:** Presets are stored server-side, so they follow you across devices and browsers.

**By the numbers:** a preset captures search text, assignee, labels, priority, and due-date selection. Presets are private to you, and every board role, including Viewer, can create, load, and delete their own.

## Saving a filter

1. Open the board and set your filters with the filter bar (press `f` or click **Filters**).
2. Click the **Saved** dropdown to the right of the filter controls.
3. Click **Save current filters**, enter a descriptive name, and confirm.

Later changes to the filter bar don't affect the stored preset.

<a id="loading-a-saved-filter"></a>
<a id="deleting-a-saved-filter"></a>

## Loading and deleting

- **Load:** click a preset name in **Saved**. The filter bar updates and the board shows only matching cards.
- **Delete:** hover a preset name, then click the delete icon. This is permanent and can't be undone.

## Scope and privacy

Other board members can't see, load, or delete your presets. Any board role, including Viewer, can manage their own.

## Real-time sync

Saving or deleting a filter syncs your other open tabs on the same board over WebSocket. The broadcast carries only the filter's ID and your user ID, never its contents, so other members never see that you saved anything. See [Real-time Updates](realtime.md).

## API reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/v1/boards/{id}/saved-filters/` | List your saved filters for this board |
| `POST` | `/api/v1/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/v1/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |

See [`docs/api/boards.md`](../api/boards.md#saved-filters) for the full `state_json` shape and request/response fields.

## Schema versioning

<span class="vb-version" title="Added in 1.1">1.1+</span>

Each saved filter carries a `state_version` field identifying the shape of its stored `state_json`. A future non-additive change (for example, splitting one field into two) can then be migrated without losing old presets.

**By the numbers:** only version `1` exists today. The server accepts any `state_version` number ≥ 1, including one higher than it recognizes, so a mixed-version deploy where a newer frontend tags its write `state_version: 2` isn't rejected on the version number alone.

**Yes, but:** that check is separate from the `state_json` key allow-list.

- The server still accepts only the v1 key set (`search`, `assigneeIds`, `labelIds`, `priorities`, `dueDate`, `blockedOnly`, `customFields`, `visibleCustomFieldFilterIds`), whatever version is declared.
- A genuinely new v2-only key is rejected with `400` until the backend's allow-list is updated.
- On read, older clients fall back to a defensive v1 reader for any shared fields.

Additive changes (a new optional key in `state_json`) need **no** version bump. Update the allow-list in the serializer's `validate_state_json` validator and the frontend `FilterState` type in the same release.
