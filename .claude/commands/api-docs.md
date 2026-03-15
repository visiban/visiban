# API Docs Sync

You are ensuring the API documentation in `docs/api/` is up to date with code changes. The CI does not enforce this — doc drift is caught in review or by users filing bugs.

## Docs structure

```
docs/api/
├── authentication.md   — login, logout, token refresh, OAuth
├── boards.md           — boards CRUD, full board fetch, members
├── cards.md            — cards CRUD, move, activities, movements, comments, checklists
├── groups.md           — groups CRUD, membership, subgroups
└── health.md           — liveness, readiness probes
```

## What to do

Given the endpoint, serializer, or model change in `$ARGUMENTS` (or infer from the current git diff if no argument is provided):

### 1. Identify what changed

Map each code change to its doc file:
- New/modified viewset action → the relevant `docs/api/*.md` file
- New/modified serializer field → update request/response examples
- New/modified model field exposed via API → update field tables
- New/modified permission rule → update the "Permissions" note for that endpoint
- Removed endpoint or field → remove from docs (do not leave stale entries)

### 2. Check each affected endpoint doc for completeness

Every documented endpoint must have:
- HTTP method + path (e.g. `POST /api/boards/{board_id}/cards/`)
- One-line description
- Permission requirement (e.g. "Requires member or above")
- Request body — field table with name, type, required/optional, description
- Response — example JSON showing the shape (not exhaustive, but representative)
- Error cases worth documenting (403, 404, 400 with common reasons)

### 3. Update request/response examples

- Examples must reflect the **current** field names and types — no stale field names
- Use realistic placeholder values (not `"string"` or `0`)
- If a field was renamed, find and update every example that references the old name
- Format: fenced code block with `json` syntax highlighting

### 4. Check the enterprise callout

Per `CLAUDE.md` documentation conventions:
- If the new/changed feature requires enterprise edition, add the callout immediately after the section heading:
  ```markdown
  > **Visiban Enterprise** — This feature is available in [Visiban Enterprise](https://visiban.com/enterprise).
  ```
- Do not add the callout to OSS features

### 5. Check navigation

If a new doc page is added:
- Is it listed in `mkdocs.yml` under the correct nav section?
- Does it have a meaningful page title (used in the sidebar)?

### 6. Output

List every doc change made, or needed if not yet made:
- File path
- Section added/updated/removed
- One-line description of the change

If no doc changes are needed (e.g. internal refactor with no API surface change), state that explicitly so the reviewer knows it was checked.
