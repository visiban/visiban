# Notifications

Visiban surfaces in-app notifications for the following events: card assignment, @mention in a comment or description, due date warning, card moved, comment added, and board invite. Staleness alerts are delivered separately via the `notify_stale_cards` management command.

Four of these events can also be **delivered by email** — see [Email notifications](#email-notifications) below.

## Notification bell

The navbar shows a bell icon with an unread count badge. Clicking it opens a dropdown feed showing only **unread** notifications. Each notification is a deep link — clicking it marks it as read (removing it from the dropdown) and navigates to the relevant board and opens the card detail panel automatically.

Click **Mark all read** to dismiss all notifications at once. Read notifications do not reappear after a page refresh or navigation.

!!! note "Notification limit"
    The dropdown shows at most **50 unread notifications**. Older unread notifications beyond the 50 most recent are not shown in the UI, though they are still marked read when you click **Mark all read**.

## Notification preferences

Each user can enable or disable individual notification triggers in **Settings → Notifications**. Preferences are saved immediately on toggle. Available toggles:

| Trigger | In-app default | Email available | Email default |
|---|---|---|---|
| Card assigned to me | On | Yes | Off |
| I am @mentioned | On | Yes | Off |
| Due date approaching | Off | Yes | Off |
| Card moved | Off | Yes | Off |
| Comment on a watched card | Off | No | — |
| Card has gone stale | Off | No | — |
| Board invites | On | No | — |

> **Changed in 1.2**
> Staleness notifications are user-configurable, and always were — they were
> gated on the **Due date approaching** preference, which is not what that
> preference says it does. 1.2 splits them apart: staleness now has its own
> **Card has gone stale** toggle, and **Due date approaching** finally controls
> the due-date warning it is named after. Your existing setting was copied
> across on upgrade, so nothing you receive today changes.

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

Recipients opt in with the **Due date approaching** preference. The scan runs from
a management command rather than on a request, so schedule it the same way as the
staleness scan:

```bash
python manage.py notify_due_soon

# crontab example — run at 7am daily, before the staleness scan
0 7 * * * cd /app && python manage.py notify_due_soon
```

Pass `--days N` to widen the window. `Card.due_date` is a date, not a timestamp,
so the window is expressed in whole days; the default of `1` is the documented
24-hour warning and covers cards due today or tomorrow.

The command is idempotent per due date: a card is visible to it on two
consecutive runs (due tomorrow, then due today) and produces **one** notification
in total. Changing a card's due date makes it eligible again, because a
rescheduled card is a new commitment. An assignee who has since lost access to
the board is skipped — the assignee field is not cleared when a member is
removed, and card titles are board content.

!!! note "Added in 1.2"
    The due-date notification is new in 1.2 (#356). Earlier releases described it
    and shipped the preference toggle, but nothing ever created the notification.

## Card moved notifications

When a card is moved to a different column by another user, the card's assignee is notified.

## Board invite notifications

When a user is added to a board (directly or via group membership), they receive a notification:

> "You were added to "{board name}""

This notification appears in the bell dropdown and includes a **View board →** link, making it clear that clicking will navigate to the board. Users can disable board invite notifications in **Settings → Notifications** by toggling the **Board invites** preference.

## Comment added notifications

When a comment is posted on a card, the card's assignee is notified (unless they posted the comment themselves).

## Staleness notifications

Cards that haven't moved between columns in a configurable number of days are considered **stale**. The `notify_stale_cards` management command scans all boards and creates notifications for assignees and board admins of stale cards, for those who have the **Card has gone stale** preference on (it was **Due date approaching** before 1.2 — see the note in [Notification preferences](#notification-preferences)).

### Staleness threshold

Each board has a `staleness_threshold_days` setting (default: **7 days**). A card is stale when its last `CardMovement` record is older than this threshold (or when a card has never been moved and was created more than that many days ago).

### Stale card indicator

Cards that are stale show an amber tint overlay with reduced opacity in the board view.

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

## Email notifications

> **Added in 1.2**

Team members who are not watching the board all day can have notifications
delivered to their email address as well as the bell. Four events support it:

| Event | Email preference |
|---|---|
| Card assigned to me | **Also send by email** under *Card assigned to me* |
| Someone @mentions me | **Also send by email** under *Someone @mentions me* |
| Due date approaching | **Also send by email** under *Due date approaching* |
| Card I'm watching is moved | **Also send by email** under *Card I'm watching is moved* |

### Turning it on

Two things have to be true before any email is sent:

1. **An administrator has configured outgoing email** — either the `EMAIL_*`
   environment variables or **Admin → Settings → Email**. See
   [Configuration](../administration/configuration.md#email-smtp). Nothing is
   sent, and nothing is queued, if email is unconfigured.
2. **You turned the event's email toggle on** in **Settings → Notifications**.

!!! warning "Email is off by default, deliberately"
    Every email preference defaults to **off**, for every user, including on an
    instance that already has working SMTP. Upgrading to 1.2 does not start
    emailing anybody. This is the only safe default: the alternative is an
    upgrade that silently mails every member of every board.

### Email rides on the in-app notification

An email is a copy of the in-app notification, sent when that notification is
created. So the in-app toggle for an event gates both: with the in-app
notification off there is no notification to copy, and the email toggle is inert.
The settings UI disables it and says so rather than letting you turn on something
that would quietly do nothing.

### What an email contains

Plain text only — no HTML part, no tracking, no images. The subject is the board
name followed by the same sentence the bell shows. The body repeats it, names the
board and card, and links straight to the card (the same deep link the bell uses,
so both land in the same place). A footer links to your notification settings,
and the message carries a `List-Unsubscribe` header pointing there.

Mail is sent from the address configured as the sender (`DEFAULT_FROM_EMAIL`, or
the sender set in the admin UI). There is no separate notification sender.

### Who does not receive email

- Users with no email address on their account
- Deactivated users — their notification history is kept, their mail is not
- Users whose address is unconfirmed, **when** the instance sets
  `EMAIL_VERIFICATION=mandatory`. Under the default `optional` policy unverified
  addresses are normal — the same instance already sends password-reset mail to
  them — so they still receive notification mail.

    Two things follow from that default, and they are the reason to consider
    `mandatory` on a public instance. Notification mail carries board content
    (board names, card titles) to whatever address the account holder last saved,
    proved or not. And because a member can set their own address to anyone's, a
    member could point notifications at a third party who never asked for them,
    with card titles they chose. Neither gives anybody access to a board they are
    not on, but `EMAIL_VERIFICATION=mandatory` closes both, and
    `NOTIFICATION_EMAIL_ENABLED=false` closes them outright.
- Everybody, when `NOTIFICATION_EMAIL_ENABLED=false`

### When mail fails

A delivery failure never breaks the action that caused it. Notifications are
created inside the request's transaction; once it commits, the messages are
handed to a background thread that sends them over a single connection with a
socket timeout (`NOTIFICATION_EMAIL_TIMEOUT`, default 10 seconds). If the SMTP
server is unreachable, misconfigured or rejects the credentials, the card update
still succeeds, the in-app notification is still created, and the failure is
logged with a sanitized error code. Logs never contain a recipient address.

The send runs on a thread rather than inline because the timeout is applied per
socket operation, not as a wall-clock total — a tarpitting relay can spend it
again at every step of the conversation, which inline would mean a card
assignment or drag-and-drop appearing to hang. The trade-off is that delivery is
explicitly **best-effort**: restarting or recycling a worker mid-send drops that
batch. Set `NOTIFICATION_EMAIL_ASYNC=false` to send inline instead.

There is no retry and no queue: a notification email is only useful promptly, and
a durable queue is not a dependency the OSS core takes on. If mail is failing, fix
the SMTP configuration — **Admin → Settings → Email** has a **Send test email**
button.

### Extending delivery

Notification creation fires a `post_notification_created` signal, which is a
stable extension point: additional delivery backends attach to it without
modifying any file in this repository. See
[Open core boundary](../architecture/open-core-boundary.md#oss-extension-points-implementation-status).

---

## Notification data model

Each notification stores structured metadata alongside the human-readable `verb` string:

- **`actor`** — the user who triggered the notification (e.g. the person who assigned the card or posted the comment). Shown in the notification feed as the actor's display name. Null for system-generated notifications such as staleness alerts.
- **`action_type`** — a machine-readable classifier for the event. Possible values: `assigned`, `mentioned`, `card_moved`, `stale`, `board_invite`, `due_soon` *(added in 1.2)*. Useful for filtering or grouping notifications programmatically. Values are added over time, so a client that switches on this field must fall through to a generic rendering for one it does not recognize.

## Notification API

| Endpoint | Description |
|---|---|
| `GET /api/v1/notifications/` | List unread notifications for the current user (max 50) |
| `GET /api/v1/notifications/unread-count/` | Returns `{ "count": N }` |
| `POST /api/v1/notifications/mark-read/` | Mark notifications as read — body: `{ "ids": [1, 2] }` or `{ "all": true }` to mark all |

The `GET /api/v1/notifications/` response returns an array of objects with the following shape:

```json
{
  "id": 42,
  "verb": "You were assigned to \"Deploy v2.3\"",
  "card_id": 7,
  "card_title": "Deploy v2.3",
  "board_id": 1,
  "board_name": "Engineering",
  "actor": {
    "id": 7,
    "username": "alice",
    "display_name": "Alice",
    "avatar_url": ""
  },
  "action_type": "assigned",
  "read": false,
  "created_at": "2026-03-27T14:00:00Z"
}
```

The `action_type` field is a machine-readable classifier for the event. Possible values: `assigned`, `mentioned`, `card_moved`, `stale`, `board_invite`, `due_soon` *(added in 1.2)*, or `""` (empty string for legacy notifications created before action types were introduced). New values are additive; treat an unrecognized one as generic rather than as an error.

!!! note "Added in 1.1"
    The `actor` field (the user who triggered the notification) is included in the API response as a slim user object (#1007). It is `null` for system-generated notifications such as staleness alerts.
