# Notifications

Visiban surfaces in-app notifications for two events: card assignment and card staleness.

## Notification bell

The navbar shows a bell icon with an unread count badge. Clicking it opens a dropdown feed. Each notification links to the relevant board.

## Assignment notifications

When a card is assigned to a user by someone else, that user receives a notification:

> "You were assigned to "{card title}""

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
| `GET /api/notifications/` | List notifications for the current user |
| `GET /api/notifications/unread-count/` | Returns `{ "count": N }` |
| `POST /api/notifications/mark-read/` | Mark notifications as read — body: `{ "ids": [1, 2] }` or `{}` to mark all |
