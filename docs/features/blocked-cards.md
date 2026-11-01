# Mark a card blocked and see how long it waited

<a id="blocked-cards"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

Open a card and click **Block…** in its header. Say what it is waiting on, then click **Block card**. The card shows the blocked glyph with how long it has been blocked, for example **⊘ 3d**.

**Why it matters:** "waiting on the customer" or "vendor outage" is not another card, so a [relation](card-relations.md) cannot say it. A block records who blocked the card, when, and why, so you can see how long work sat blocked, in which column, and for which reasons.

**How it works:** a card is either blocked or not. Each block is kept in the card's history with its reason, its start and end, and the column the card was in, so blocked time can be summed per column and grouped by reason in [Analytics](analytics.md).

**Yes, but:** blocking does not stop anyone from moving or editing the card, and it is never set or cleared automatically. Unblock it when the wait is over.

---

## Blocking and unblocking

1. Open the card and click **Block…** in the header. A short form opens at the top of the *Details* tab (not a separate dialog).
2. Enter a **Reason**. It is required, up to 500 characters. Pick wording your team will reuse: reasons that differ only in capitals or spacing are counted as one in Analytics.
3. Click **Block card**. **Cancel** or Escape closes the form without blocking, and returns you to **Block…**.

While the card is blocked, a red banner at the top of *Details* shows:

- **Blocked for 3d 5h**, and the reason
- who blocked it and when
- **Total blocked time** across every block the card has had, for example *5d 10h across 2 blocks*

To unblock, click **Unblock** in the banner. Optionally note how it was resolved under **Resolution**, then click **Unblock card**. A card that was blocked before, and is not now, shows its total blocked time in a single line instead of the banner.

Both events appear in the card's *Activity* tab ("Blocked: Waiting on customer", "Unblocked: Customer signed off"), and that history cannot be edited.

---

## On the board

A blocked card shows the blocked glyph (a filled circle with a bar) first in its metadata row, at every card density and in the compact layout, so blocked work stands out while you scan a column:

| Card is | Card face shows | Border |
|---|---|---|
| Blocked manually | Glyph and elapsed time, for example **⊘ 3d** | Red |
| Blocked by another card ([relation](card-relations.md)) | Glyph only, with a count from 2 blockers up | Priority color, unchanged |
| Both | Glyph and elapsed time | Red |

Hovering the glyph shows the full time and the reason ("Blocked 3d 5h: Waiting on customer"); screen readers read the same text. The glyph and the time carry the meaning, so it does not depend on color.

### Show blocked only

Click **Blocked only** in the filter row to show just the blocked cards. Its number is how many cards on the board are blocked. It counts manual blocks and relation blocks alike. While it is on, a **Blocked only ✕** chip appears with your other filters; click it to clear the filter. The setting is remembered per board.

### Summary view

The **Summary** view has a **Blocked** column: how many active cards in each swimlane (not archived and not in a done column) are blocked right now, manually or by a relation.

### Analytics

[Analytics](analytics.md) adds **Blocked time** for the selected period: blocked days per column (the column each block started in) and the most common reasons, with how many blocks and how many days each one cost.

---

## Blocked cards and a "Blocked" custom field

Some boards already track blocked work with a [custom field](custom-fields.md) choice named **Blocked**, or a label. Visiban does not read those: no signal is ever keyed to a choice or label name, and an admin-colored **Blocked** choice stays a chip on the card, never the blocked glyph or the red border. Nothing is migrated automatically.

| | Blocked state | "Blocked" custom field choice |
|---|---|---|
| Card-face glyph and elapsed time | Yes | No |
| Who, when, why recorded | Yes, every block | No |
| Blocked time per column, top reasons | Yes | No |
| **Blocked only** filter | Yes | Filter on the field instead |
| Free to rename, recolor, combine with other values | No | Yes |

To switch over, filter the board on the old field value, block each of those cards with a reason, then remove the choice from the field (Board Settings → Fields) once nobody uses it. Keep the field if it means something the blocked state does not, for example a status your process reports on.

---

## Permissions

| Role | See blocked state and history | Block / unblock |
|---|---|---|
| Admin, site admin | Yes | Any card |
| Member | Yes | Cards they created; any card with the moderator entitlement |
| Collaborator, viewer | Yes | No |

The same rules apply over the [API](../api/cards.md#block-and-unblock-since-13) and the [MCP server](mcp-server.md) (`block_card`, `unblock_card`). The shared demo does not offer blocking.

---

## Limits

- **One block at a time.** Blocking an already blocked card is refused; unblock it first. Each new block starts a new entry in the history.
- **Relation blocks are separate.** **Unblock** clears only the manual block. A card blocked by another card stays blocked until that card is archived or the relation is removed; moving the blocking card to a done column does not clear it (see [Card Relations](card-relations.md#limits)).
- **Archived and deleted cards.** An archived card cannot be blocked or unblocked, and its block history is kept. A block still open on an archived card stops counting time at the archive while the card stays archived; if the card is restored, the block counts again from when it started, archived period included. Deleting a card keeps its *finished* blocks in the board's Analytics, reasons included; a block still open when the card was deleted is left out of Analytics entirely.
- **Export and import.** A board's [JSON export](board.md#export-import) carries each card's block state and history. Importing restores the current block always, and past blocks with the *history* option. CSV does not carry them.
