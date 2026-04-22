# Onboarding Tour

> **Added in 1.0**

When a new user opens a board for the first time, Visiban displays a 4-step guided tour that introduces the core concepts:

| Step | Target | What it explains |
|------|--------|------------------|
| 1 | Swimlane label | Swimlanes represent clients or workstreams |
| 2 | Card | Dragging cards between columns tracks progress |
| 3 | History button | Every card movement is recorded as an audit trail |
| 4 | Filter button | The filter bar narrows the board by assignee, label, priority, or due date |

## Behavior

- The tour triggers only when the user's `has_completed_tour` flag is `false` **and** the board has at least one swimlane and one card (so every tour step has a visible target element).
- Clicking **Next** advances to the next step. Clicking **Done** on the last step completes the tour.
- Clicking **Skip tour** at any step immediately dismisses the tour.
- Pressing **Escape** dismisses the tour.
- Any dismissal (skip, complete, or Escape) sends a `PATCH /api/v1/auth/me/` request setting `has_completed_tour: true` so the tour never appears again.

## Resetting the tour

Site admins can reset a user's tour flag from the admin panel:

1. Go to `/admin` → **Users** tab.
2. Find the user and open their detail view.
3. Click **Reset onboarding tour**.

The user will see the tour again the next time they open a board. Resetting the tour does not affect any board data or settings.

You can also reset the flag via the API:

```
PATCH /api/v1/admin/users/{id}/
{ "has_completed_tour": false }
```

## API

The tour state is stored as a boolean field on the User model:

- `GET /api/v1/auth/me/` — returns `has_completed_tour` in the response
- `PATCH /api/v1/auth/me/` with `{ "has_completed_tour": true }` — marks the tour as completed
- `PATCH /api/v1/admin/users/{id}/` with `{ "has_completed_tour": false }` — admin resets the flag
