# Card Archiving

Archiving is a soft-delete for cards — an archived card is hidden from the active board but its history is preserved and it can be restored at any time.

## Archiving a card

Open the card detail panel and click **Archive card** in the footer. A confirmation dialog appears before the card is removed from the board. Archived cards are immediately hidden from the board grid and DnD.

**Permission:** member role or higher. Viewers and collaborators cannot archive cards.

## Viewing archived cards

Click **Archived** in the board toolbar to open the archived cards panel. The panel lists all archived cards for the board, showing the card title, column and swimlane it was in, and the date it was archived.

## Restoring a card

In the archived cards panel, click **Restore** next to a card. The card returns to its original column and swimlane position and becomes active again on the board.

**Permission:** member role or higher. Viewers and collaborators cannot restore cards.

## Real-time sync

Archive and restore events are broadcast to all board members over WebSockets:

| Event | Effect on other sessions |
|---|---|
| `card.archived` | Card is removed from the active board view |
| `card.unarchived` | Card is added back to the board in its column/swimlane |

## Relationship to deletion

Archiving is reversible; deletion is not. Use archiving when a card is complete or on hold but may need to be referenced later. Use deletion when the card is no longer needed at all.

## Analytics and dwell time

Archived cards are included in analytics for the period they were active. Dwell time in the final stage is calculated up to the archive timestamp, not the current date. See [Analytics & Summary](analytics.md#dwell-time-and-archived-cards) for details.

## Column and swimlane deletion

Deleting a column or swimlane also deletes all cards in it — including archived cards that were in that column or swimlane at the time of archiving. A warning in the confirmation dialog notes that archived cards will also be deleted.
