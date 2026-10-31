---
title: What new users see on their first board
description: An 8-step guided tour runs once per user, on the first board they open. Here's what it covers and how to replay it.
sidebar:
  label: Onboarding tour
---

> **Added in 1.1**

Every new user gets an 8-step guided tour the first time they open any board. It runs once, until someone resets it.

**Why it matters:** Occasional users learn the four ideas that make Visiban different (swimlanes, the audit trail, filters, and live updates) without anyone training them.

## The eight steps

| Step | Target | What it explains |
|------|--------|------------------|
| 1 | View tabs (Board / Summary / History / Analytics) | Four lenses on the same data; History traces every card movement |
| 2 | Swimlane label | Swimlanes represent clients or workstreams |
| 3 | Swimlane collapse chevron | Collapse a lane to focus; press C while hovering to use the keyboard |
| 4 | Card | Drag cards between columns to update status |
| 5 | History tab | Every card movement is recorded as an audit trail |
| 6 | Filter button | Narrow the board by assignee, label, priority, or due date; press F to toggle |
| 7 | Live indicator | Real-time connection status; changes from teammates appear instantly |
| 8 | *(full-screen)* | Space + drag to pan across a wide board |

## How it behaves

- **When it shows:** whenever the user's `has_completed_tour` flag is `false`, on any board they open. There's no minimum swimlane or card count.
- **Missing targets are skipped.** Each step points at a specific element (a swimlane, a card, and so on). If the board doesn't have that element yet, the tour skips to the next step, or completes immediately if no later step has a visible target either.
- **Moving through it:** **Next** advances a step. **Done** on the last step completes the tour.
- **Dismissing it:** **Skip tour** at any step, or **Escape**, dismisses the tour immediately.
- **It never comes back on its own.** Any dismissal (skip, complete, or Escape) sends `PATCH /api/v1/auth/me/` with `has_completed_tour: true`.

## Replay the tour

**Any user, for themselves:** patch your own profile and the tour shows on your next board visit:

```
PATCH /api/v1/auth/me/
{ "has_completed_tour": false }
```

**Site admins, for anyone:** click **Restart onboarding tour** next to the user in the Admin panel's Users tab (see [Admin Panel](https://docs.visiban.com/latest/administration/admin-panel/#restart-onboarding-tour)). The button appears only for users who have already completed the tour. It calls the same Admin API as the other admin user actions:

```
PATCH /api/v1/admin/users/{id}/
{ "has_completed_tour": false }
```

**Either way:** the user sees the tour the next time they open a board. A reset doesn't touch any board data or settings.

## API

The tour state is a boolean field on the User model:

- `GET /api/v1/auth/me/` returns `has_completed_tour`.
- `PATCH /api/v1/auth/me/` with `{ "has_completed_tour": true }` marks the tour as completed.
- `PATCH /api/v1/admin/users/{id}/` with `{ "has_completed_tour": false }` lets an admin reset the flag.
