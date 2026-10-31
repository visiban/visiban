# Hide finished cards without losing them

<a id="card-archiving"></a>

> **Added in 1.0**

Click **Archive card** in the card detail panel to hide a card from the board. Its history stays, and you can unarchive it any time.

**Why it matters:** Archiving is a soft-delete and is reversible; deletion is not. Archive a card that is complete or on hold but may be referenced later. Delete a card you no longer need at all.

**The big picture:** archived cards vanish from the board grid and drag-and-drop but still count in analytics for the period they were active.

**Watch out:** deleting a column, swimlane, or board also deletes the archived cards in it. See [Column and swimlane deletion](#column-and-swimlane-deletion).

<a id="archiving-a-card"></a>
<a id="viewing-archived-cards"></a>
<a id="unarchiving-a-card"></a>

## Archive and unarchive

| Action | How | Result |
|---|---|---|
| Archive | Open the card, click **Archive card** in the footer, confirm | Card is immediately hidden from the board |
| View | Click **Archived** in the board toolbar | Panel lists each archived card's title, its column and swimlane, and the date archived |
| Unarchive | Click **Unarchive** next to a card in that panel | Card returns to its original column and swimlane position |

**Permission:** member role or higher, for both archiving and unarchiving. Viewers and collaborators cannot.

## Real-time sync

Archive and unarchive events are broadcast to all board members over WebSockets:

| Event | Effect on other sessions |
|---|---|
| `card.archived` | Card is removed from the active board view |
| `card.unarchived` | Card is added back to the board in its column/swimlane |

## Analytics and dwell time

Archived cards are included in analytics for the period they were active. Dwell time in the final stage is calculated up to the archive timestamp, not the current date. See [Analytics & Summary](analytics.md#dwell-time-and-archived-cards).

## Relationship to deletion

Archive when the card may be referenced later; delete when it is no longer needed at all (see the lede).

## Column and swimlane deletion

!!! warning "Deleting a column or swimlane deletes its archived cards"
    Deleting a column or swimlane also deletes all cards in it, including archived cards that were in it when archived. Both confirmation dialogs warn that archived cards will also be permanently deleted.

## Board deletion

Deleting a board permanently deletes every card on it, including archived cards. Every board-delete confirmation says so (on the dashboard, in the board switcher, and in the **Danger Zone** of Board Settings), and when the board has archived cards it tells you how many.

Archived cards count toward the typed confirmation:

- If a board holds any cards, active **or** archived, you must type the board's name before **Delete** is enabled.
- A board with no active cards but hundreds of archived ones can no longer be deleted with a single click.
- Only a board with no cards at all deletes without typing its name.

> **Added in 1.2** (#1289)

The active card count shown elsewhere (for example on the dashboard) still excludes archived cards; the delete dialogs report the two numbers separately.
