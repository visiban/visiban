# Notifications

Visiban surfaces in-app notifications for the following events: card assignment, @mention in a comment or description, due date warning, card moved, and comment added. Staleness alerts are delivered separately via the `notify_stale_cards` management command.

## Notification bell

The navbar shows a bell icon with an unread count badge. Clicking it opens a dropdown feed showing only **unread** notifications. Each notification is a deep link — clicking it marks it as read (removing it from the dropdown) and navigates to the relevant board and opens the card detail panel automatically.

Click **Mark all read** to dismiss all notifications at once. Read notifications do not reappear after a page refresh or navigation.

!!! note "Notification limit"
    The dropdown shows at most **50 unread notifications**. Older unread notifications beyond the 50 most recent are not shown in the UI, though they are still marked read when you click **Mark all read**.

## Notification preferences

Each user can enable or disable individual notification triggers in **Settings → Notifications**. Preferences are saved immediately on toggle. Available toggles:

| Trigger | Default |
|---|---|
| Card assigned to me | On |
| I am @mentioned | On |
| Due date warning | Off |
| Card moved | Off |
| Comment added | Off |

Staleness notifications (from the `notify_stale_cards` command) are always delivered and are not user-configurable.

## Assignment notifications

When a card is assigned to a user by someone else, that user receives a notification:

> "You were assigned to "{card title}""

## @mention notifications

Typing `@username` in a card comment **or description** notifies the mentioned user:

> "{author} mentioned you in "{card title}""

- Type `@` in the comment box or description field to open an inline autocomplete dropdown filtered by username and display name
- Keyboard navigation: ↑↓ to move through suggestions, Enter or Tab to select, Escape to dismiss
- Mentions are rendered as **bold blue** text in saved comments and descriptions
- The author is never notified for their own mention
- Only users who are members of the board (directly, via group inheritance, or site admins) can be mentioned
- **Description re-save guard** — Visiban tracks which users have already been notified for mentions on a given card's description. If you edit and re-save a description that still contains an existing `@username`, that user is not notified again. Only newly added mentions trigger a notification.

## Due date notifications

When a card's due date is approaching (within 24 hours by default), the assignee is notified:

> ""{card title}" is due soon"

## Card moved notifications

When a card is moved to a different column by another user, the card's assignee is notified.

## Comment added notifications

When a comment is posted on a card, the card's assignee is notified (unless they posted the comment themselves).

## Staleness notifications

Cards that haven't moved between columns in a configurable number of days are considered **stale**. The `notify_stale_cards` management command scans all boards and creates notifications for assignees of stale cards.

### Staleness threshold

Each board has a `staleness_threshold_days` setting (default: **7 days**). A card is stale when its last `CardMovement` record is older than this threshold (or when a card has never been moved and was created more than that many days ago).

### Stale card indicator

Cards that are stale show an amber left border and a ⏱ badge in the board view.

### Running the stale check

The command is idempotent — it won't create duplicate notifications if run multiple times in the same day:

```bash
python manage.py notify_stale_cards
```

Schedule this as a daily cron job or Kubernetes CronJob in production:

```bash
# crontab example — run at 8am daily
0 8 * * * cd /app && python manage.py notify_stale_cards
```

## Notification data model

Each notification stores structured metadata alongside the human-readable `verb` string:

- **`actor`** — the user who triggered the notification (e.g. the person who assigned the card or posted the comment). Shown in the notification feed as the actor's display name. Null for system-generated notifications such as staleness alerts.
- **`action_type`** — a machine-readable classifier for the event. Possible values: `assigned`, `mentioned`, `card_moved`, `stale`. Useful for filtering or grouping notifications programmatically.

## Notification API

| Endpoint | Description |
|---|---|
| `GET /api/notifications/` | List unread notifications for the current user (max 50) |
| `GET /api/notifications/unread-count/` | Returns `{ "count": N }` |
| `POST /api/notifications/mark-read/` | Mark notifications as read — body: `{ "ids": [1, 2] }` or `{ "all": true }` to mark all |

The `GET /api/notifications/` response returns an array of objects with the following shape:

```json
{
  "id": 42,
  "verb": "You were assigned to \"Deploy v2.3\"",
  "card_id": 7,
  "card_title": "Deploy v2.3",
  "board_id": 1,
  "board_name": "Engineering",
  "read": false,
  "created_at": "2026-03-27T14:00:00Z"
}
```

!!! note
    The `action_type` and `actor` fields are stored on the model but are not currently included in the API response. They are available for direct database queries and will be added to the API in a future release.
