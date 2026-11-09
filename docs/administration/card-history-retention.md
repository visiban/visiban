# Keep deleted cards' history, or erase it on request

> **Added in 1.2** (#1797)

Since 1.2, deleting a card keeps its movement history (#1469). A superuser erases it on request with the `purge_card_history` management command. Since 1.3, the same command also redacts the card's content in the board change feed (#1816).

**Why it matters:** a deleted card's title and moves persist. Know what remains, who can see it, and what the command does and does not erase.

**The big picture:** this page covers what that history keeps, who can see it, how long it lasts, and how to purge it.

## What a deleted card leaves behind

Each movement record of a deleted card keeps:

- the card's UID, and the card's title **as it was at the time of that move** (`card_uid`, `card_title`);
- the movement's notes, the columns and swimlanes involved, who moved it and when.

Since 1.3, each [block](../features/blocked-cards.md) of a deleted card is kept the same way (#1149): the card's UID and title when it was blocked, the block's **reason** and **resolution** (free text), the column, who blocked and unblocked it and when. Board members see the reasons in [Analytics](../features/analytics.md#blocked-time).

While the card exists, its history shows under its current title. Once it is deleted, each movement shows under the title recorded with it, so a card renamed before deletion appears in the board's **History** view under each earlier title. This is intended: it is what the card was called at each move.

**Yes, but:** two exceptions.

- Movements recorded before the 1.2 upgrade, and imported ones, carry the title as of the upgrade or the import, which can differ from what the card was called at that move.
- A movement written by the previous release while an upgrade was rolling out has no title stored until `backfill_card_movement_snapshots` runs or the card is deleted. Either fills in the card's title at that point (see [Upgrading](upgrade.md)).

**Who can see it:** every board member, through the board's **History** view; users with [`can_access_all_content`](../features/permissions.md), who can open every board; and Django admin users with permission to view card movements (read-only).

**How long it lasts:** until the board is deleted, or until a superuser purges it with the command below. Nothing expires it on a schedule.

See [Card History](../features/card-history.md#deleted-cards-keep-their-history) for how deleted-card history appears to board members and how it affects metrics and exports.

### Other places a deleted card's title can remain

**Watch out:** `purge_card_history` erases movement records and, since 1.3, block records, and redacts the card's change-feed events (see [What the purge redacts in the change feed](#what-the-purge-redacts-in-the-change-feed)). A deleted card's title can also remain in the places below.

- **The board [change feed](../api/events.md)** (`GET /api/v1/boards/{id}/events/`), when you have not purged the card. Each event stores its broadcast payload verbatim. `card.created`, `card.updated` and `card.unarchived` events, and the `card` object inside `card.moved`, hold the full card as it was at that moment: title, description, block reason, custom field values and external reference; `card.moved` also holds the movement's notes. Deleting a card does not remove or redact these events. They are not tied to the board by a foreign key either, so deleting the board does not remove them. Only a `purge_card_history` run or the [`prune_board_events`](scheduled-jobs.md) job changes them. The job deletes events older than its retention window (30 days by default) and, since 1.3, runs by default on the Compose `scheduler` service (`SCHEDULE_PRUNE_BOARD_EVENTS`, `03:00` UTC). On Helm it is off until you enable `scheduledJobs.pruneBoardEvents`. If it is off, or you run neither it nor the command, events are kept forever. Until it prunes them, a deleted card's or board's payloads stay in the feed; `purge_card_history` is the path for an erase request. `purge_card_history --board` refuses a board that has been deleted; use `--card` or a date range instead.
- **The Django admin log** (`django_admin_log`). Any change made to a card in the Django admin, including deleting it there, records the card's title (`object_repr`) in the admin's own history. Visiban does not prune this table.
- **Attachment files** in media storage. Since 1.2, deleting a card, its column, its swimlane or its board, or deleting it in the Django admin, removes its attachment files after the delete commits. Files from deletes made before upgrading, or whose removal failed (for example, storage was down at the time), stay until you run [`purge_orphaned_attachments`](media-security.md#removing-orphaned-attachment-files). Deleting a user does not remove their uploads: the file stays with its card.
- **Copies outside the instance:** notification emails already sent, deliveries to installed extensions, board exports downloaded before the card was deleted, and any copies made of them.
- **Database backups** taken before the purge.

## Purging retained history

> **Added in 1.2** (#1797)

```bash
# Dry run (the default): report how many records would be deleted
docker compose exec backend python manage.py purge_card_history \
    --actor admin --card 3f9a0c1d2e4b5a69

# Delete them
docker compose exec backend python manage.py purge_card_history \
    --actor admin --card 3f9a0c1d2e4b5a69 --yes
```

On Kubernetes, run the same command with `kubectl exec` in a backend pod.

| Option | Meaning |
|---|---|
| `--actor USERNAME` | Required. An active **superuser**; any other account is refused. Recorded as the actor of the action-log entry. |
| `--card CARD_UID` | Only the history and change-feed events of the card with this UID. |
| `--board BOARD` | Only history and change-feed events on this board, given as its numeric ID or its UID. |
| `--since DATE` | Only movements (blocks by their start), and change-feed events, at or after this moment. |
| `--before DATE` | Only movements (blocks by their start), and change-feed events, strictly before this moment. |
| `--include-live-cards` | Also delete matching history, and redact matching change-feed events, of cards that still exist. Needs `--card` or `--board`. |
| `--yes` | Delete and redact. Without it the command only reports what would be deleted and redacted. |

Every selector matches block records the same way it matches movements, and one run erases both; the output and the action-log entry count them separately (`deleted_count` is movements, `deleted_block_count` blocks and `redacted_event_count` change-feed events, both since 1.3).

Dates are `YYYY-MM-DD` (midnight UTC at the start of that day) or an ISO 8601 datetime (UTC when it has no offset). `--since 2026-03-01 --before 2026-04-01` covers exactly March.

How the command behaves:

- **Selectors combine.** `--card`, `--board`, `--since` and `--before` apply together. At least one is required; no form purges everything. A date range alone covers deleted cards on every board.
- **`--board` matches the board recorded on each movement.** A movement written by the previous release while an upgrade was rolling out may not have its board recorded yet, and `--board` does not match it. If you upgraded to 1.2 while the old release was still serving, run `python manage.py backfill_card_movement_snapshots` once before purging by board, so those movements carry their board (see [Upgrading](upgrade.md)).
- **Deleted cards only, by default.** Without `--include-live-cards`, only history of cards that no longer exist is matched, and naming a card that still exists with `--card` is refused. A live card's history feeds its timeline and the board's metrics, so erasing it is a separate, explicit choice, narrowed with `--card` or `--board`: a date range alone is refused with `--include-live-cards`.
- **Dry run by default.** The dry run prints counts of records, cards and boards, and the number of change-feed events it would redact, never titles. Re-run with `--yes` to delete.
- **Recorded.** A purge that deletes or redacts anything writes one `card_history.purged` entry to the [admin action log](../api/admin.md#action-log) with source `cli`, the `--actor` account, the selector used, the number of records deleted and (since 1.3) the number of change-feed events redacted. The entry never contains a purged title or note. A run that matches nothing writes no entry.
- **All or nothing.** The records are deleted, and the events redacted, in the same transaction that writes the log entry. If the entry cannot be written, nothing is deleted or redacted.

Finding the card UID: a deleted card's UID is shown in the Django admin's **Card movements** list (`/admin/boards/cardmovement/`), which can be searched by the recorded title.

!!! warning "This breaks the append-only history on purpose"
    Movement records are otherwise never edited or deleted outside a board delete, and change-feed events are never otherwise rewritten. A purge removes the records and the redacted values for good: Board History, the change feed and any later review cannot recover them. The action-log entry is the only record that the purge happened.

    The exception is the card's activity trail (`CardActivity`), which the command does not touch. A deleted card's trail was already removed with the card. With `--include-live-cards` the card still exists, so its trail stays: [`GET /api/v1/boards/{board_id}/cards/{id}/timeline/`](../api/cards.md#timeline) still returns its block reasons and resolutions, earlier titles and checklist item text.

!!! note "`--actor` is accountability, not authentication"
    Anyone who can run `manage.py` already has database access and can name any account. Shell access is the real control; `--actor` records which superuser authorized the purge, so the action log can answer "who erased this?".

### What the purge redacts in the change feed

> **Added in 1.3** (#1816)

The selector that picks movement and block records also picks the card's [change-feed](../api/events.md) events. The command **redacts** these events rather than deleting them: a feed consumer reads by an ID cursor, and a removed event would leave a gap it cannot explain.

**What changes:** in each matching `card.created`, `card.updated`, `card.unarchived` and `card.moved` event, the card's content values become `null`:

- the card's `title`, `description` and `blocked_reason` (the free-text reason of a manual block, since 1.3);
- the `value` of each `custom_field_values` entry (the entry and its `field_definition` stay);
- the `ref` and `url` of `external_ref` (`provider` stays);
- in `card.moved`, the movement's `card_title` and `notes`, and the same card fields inside `card`.

**What stays:** every key; the card's `uid` and `id`, column, swimlane, position, labels, priority, due date and weight; its `is_blocked` and `blocked_at`; its assignee and creator; in `card.moved`, the movement's columns, swimlanes, mover and time; and the event's ID, type, actor and time. The event's `redacted_at` field shows when it was redacted. `card.deleted` and `card.archived` events carry only the card UID and are not changed. A block's `resolution` is never in an event; it is only in the block record, which the purge deletes.

How the selector applies to events:

- **`--card`** matches the card UID recorded in the event, on every board. With `--board`, it matches that card's events on that board, and on other boards only if it has movement or block records on that board (see `--board` below). Date bounds narrow which records count: a record outside `--since` or `--before` does not extend the match to other boards.
- **`--board`** matches the board the event was recorded on. It also matches, on any board, the events of every card whose movement or block records it selects. A card moved to another board in the Django admin keeps its earlier events on the old board, and these are redacted with it. A card whose movement and block records an earlier purge already deleted is not followed this way; use `--card` for it.
- **`--since` and `--before`** match the time the event was recorded, not the time of a movement or block. A date-bounded run leaves every event recorded outside the range untouched, and those events can still hold the text. A card event repeats the title, description and block reason for as long as the card has them, so `--card X --before 2026-02-01` deletes a January block but leaves its reason in a March `card.moved` event. **To erase a card on request, use `--card` with no dates.** The bound can also fall between a record and its event: an event is recorded a moment after the movement or block it describes, so a `--before` in that gap deletes the record and leaves the event unredacted. Re-running with a later `--before` redacts it.
- **Deleted cards only, by default.** Without `--include-live-cards`, an event matches only when no card with its UID (or, for the events described below, its ID) exists.
- **Events match on their own.** A card whose movement records an earlier run already deleted, for example a purge made with 1.2, still has its events redacted when you run the command for it again. An event already redacted is skipped, so re-running a purge changes nothing and records nothing.

**Events without a card UID.** The MCP write tools recorded card events without a UID in 1.2 pre-releases (fixed by #1926). Those events carry the card's numeric ID instead, and the command matches them on it: a live card's ID, or a deleted card's ID as recorded in its other change-feed events. Visiban does not reuse card IDs, so an ID that no existing card has belongs to a deleted card. A database restored with its ID sequence reset can reuse them; an ID resolved for a deleted card that an existing card now has is therefore skipped. An event the command cannot attribute is left as it is, and the dry run and the purge both print how many such events the selected board and date range hold. An event cannot be attributed when its payload has no usable ID, or when `--card` names a deleted card that has no other change-feed event giving its ID.

**Deleted boards.** `--board` needs a board that still exists. To redact the events of cards that went with a deleted board, use `--card`, or a date range without `--board`, which matches deleted cards' events on every board. Feed retention after a card or board is deleted without a purge is not covered by this command.

**Yes, but:** the event payload is not indexed. A purge with `--card` and no `--board` reads every card event in the feed, and so does a purge with `--board`, to follow its cards onto other boards. These are plain reads and do not block the feed's other writes, but on a large feed they take time.

Redaction changes stored events only. Copies already delivered are not changed: frames sent over the WebSocket, and events that consumers already read from the feed.
