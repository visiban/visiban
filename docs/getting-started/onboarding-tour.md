# Onboarding Tour

> **Added in 1.1**

When a new user opens a board for the first time, Visiban displays an 8-step guided tour that introduces the core concepts:

| Step | Target | What it explains |
|------|--------|------------------|
| 1 | View tabs (Board / Summary / History / Analytics) | Four lenses on the same data; History traces every card movement |
| 2 | Swimlane label | Swimlanes represent clients or workstreams |
| 3 | Swimlane collapse chevron | Collapse a lane to focus; press C while hovering to use the keyboard |
| 4 | Card | Drag cards between columns to update status |
| 5 | History tab | Every card movement is recorded as an audit trail |
| 6 | Filter button | Narrow the board by assignee, label, priority, or due date; press F to toggle |
| 7 | Live indicator | Real-time connection status — changes from teammates appear instantly |
| 8 | *(full-screen)* | Space + drag to pan across a wide board |

## Behavior

- The tour triggers only when the user's `has_completed_tour` flag is `false` **and** the board has at least one swimlane and one card (so every tour step has a visible target element).
- Clicking **Next** advances to the next step. Clicking **Done** on the last step completes the tour.
- Clicking **Skip tour** at any step immediately dismisses the tour.
- Pressing **Escape** dismisses the tour.
- Any dismissal (skip, complete, or Escape) sends a `PATCH /api/v1/auth/me/` request setting `has_completed_tour: true` so the tour never appears again.

## Resetting the tour

**Self-service (any user):** patch your own profile to re-show the tour on your next board visit:

```
PATCH /api/v1/auth/me/
{ "has_completed_tour": false }
```

**Admin reset (site admins only):** reset any user's tour flag from the admin panel:

1. Go to `/admin` → **Users** tab.
2. Find the user and open their detail view.
3. Click **Reset onboarding tour**.

You can also reset it via the Admin API:

```
PATCH /api/v1/admin/users/{id}/
{ "has_completed_tour": false }
```

In all cases the user will see the tour again the next time they open a board. Resetting the tour does not affect any board data or settings.

## API

The tour state is stored as a boolean field on the User model:

- `GET /api/v1/auth/me/` — returns `has_completed_tour` in the response
- `PATCH /api/v1/auth/me/` with `{ "has_completed_tour": true }` — marks the tour as completed
- `PATCH /api/v1/admin/users/{id}/` with `{ "has_completed_tour": false }` — admin resets the flag
