# Notifications

Visiban surfaces in-app notifications for three events: card assignment, @mention in a comment, and card staleness.

## Notification bell

The navbar shows a bell icon with an unread count badge. Clicking it opens a dropdown feed showing only **unread** notifications. Each notification is a deep link — clicking it marks it as read (removing it from the dropdown) and navigates to the relevant board and opens the card detail panel automatically.

Click **Mark all read** to dismiss all notifications at once. Read notifications do not reappear after a page refresh or navigation.

## Assignment notifications

When a card is assigned to a user by someone else, that user receives a notification:

> "You were assigned to "{card title}""

## @mention notifications

Typing `@username` in a card comment notifies the mentioned user:

> "{author} mentioned you in "{card title}""

- Type `@` in the comment box to open an inline autocomplete dropdown filtered by username and display name
- Keyboard navigation: ↑↓ to move through suggestions, Enter or Tab to select, Escape to dismiss
- Mentions are rendered as **bold blue** text in saved comments
- The comment author is never notified for their own mention
- Only users who are members of the board (directly, via group inheritance, or site admins) can be mentioned

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

## Notification API

| Endpoint | Description |
|---|---|
| `GET /api/notifications/` | List unread notifications for the current user (max 50) |
| `GET /api/notifications/unread-count/` | Returns `{ "count": N }` |
| `POST /api/notifications/mark-read/` | Mark notifications as read — body: `{ "ids": [1, 2] }` or `{ "all": true }` to mark all |
