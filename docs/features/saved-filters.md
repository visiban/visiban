# Saved Filters


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
| `GET` | `/api/boards/{id}/saved-filters/` | List your saved filters for this board |
| `POST` | `/api/boards/{id}/saved-filters/` | Save a new filter preset |
| `DELETE` | `/api/boards/{id}/saved-filters/{filter_id}/` | Delete a saved filter |
