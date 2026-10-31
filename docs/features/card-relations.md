# See what's stuck without opening a card

> **Added in 1.2**

In a card's *Details* tab, open **Relations** → **+ Add relation** to say what blocks it. A blocked card shows a red ⊖ on the board.

**Why it matters:** You can see what is stuck while scanning a column, without opening anything.

**How it works:** three relation directions link two cards on the same board.

| Direction | Meaning | Affects the board indicator |
|---|---|---|
| **Blocked by** | The other card has to land before this one can move | Yes, on this card |
| **Blocks** | This card has to land before the other one can move | Yes, on the other card |
| **Relates to** | The two cards are associated, with no ordering implied | No |

**Blocks** and **Blocked by** are the same link seen from opposite ends. Record "A is blocked by B" and card B automatically shows "Blocks A". There is nothing to keep in sync by hand.

**Yes, but:** blockers are not cleared automatically; see [Limits](#limits).

---

## The blocked indicator

A card with at least one unfinished blocker shows a red ⊖ glyph at the start of its metadata row. With more than one blocker, the count appears next to it. Hovering shows the exact count ("Blocked by 2 cards").

- **Where it appears:** at **every card density** and in both Compact and Expanded layouts, because seeing blocked work while scanning a column is the point.
- **What counts:** only **Blocked by** relations. A card that blocks others is not itself blocked, and **Relates to** never contributes.
- **Archived blockers stop counting:** an archived card is not on the board, so it can't be holding work up. The relation is kept and shown in the card detail panel (struck through, marked *Archived*) so you can see why and remove it.

---

## Viewing and editing relations

Open a card and find **Relations** in the *Details* tab, between Weight and Checklist. It groups links under **Blocked by**, **Blocks**, and **Relates to**, in that order: what you are waiting on first.

Each row shows the linked card's title and the column it is in, which usually answers "is my blocker done yet?" without another click. Click a title to open that card; the panel switches to it.

The section starts expanded when the card has any relations and collapsed when it has none.

### Adding a relation

1. Click **+ Add relation**.
2. Pick the direction: **Blocked by** (the default), **Blocks**, or **Relates to**.
3. Type at least two characters to search the board's cards, and pick one.

The picker stays open after each link so you can add several in a row. Cards that can't be linked (the card itself, and anything already linked in a conflicting way) are left out of the results.

### Removing a relation

Hover a relation row and click **✕**. Either card can remove the link; both show it. There is no confirmation step, since the relation is trivially re-addable.

---

## Permissions

| Role | View relations | Add / remove |
|---|---|---|
| Viewer | Yes | No |
| Collaborator | Yes | No |
| Member | Yes | Yes |
| Admin | Yes | Yes |

A relation changes how a *different* card reads on the board for everyone, so adding and removing requires at least the Member role. That is one tier stricter than comments, attachments, and checklist items, which collaborators can edit. Viewers and collaborators see relations but no controls.

Any member can remove any relation, including one someone else created. A member can already edit both linked cards, so restricting the unlink to its author would protect nothing.

---

## Limits

- **Same board only.** Relations cannot span boards.
- **A card cannot be linked to itself.**
- **Two cards cannot block each other.** Longer chains (A blocks B blocks C blocks A) are not detected and are permitted.
- **Relations are not carried by board export or import.** A board exported and re-imported loses its relations.
- **Blockers are not cleared automatically.** Moving a blocking card to a done column does not remove the relation or the indicator. Archive the card, or remove the relation, when the dependency is resolved.

---

## Real-time behavior

Adding or removing a relation updates both cards for everyone viewing the board immediately, over the same WebSocket channel as every other card change. See [Real-time Updates](realtime.md).

Relations are visible on **public share links** only as the blocked indicator. Anonymous visitors see that a card is blocked and by how many cards, but not the relation list, who created it, or when.

---

## API

See [Cards API → Relations](../api/cards.md#relations-since-12) for the `blocker_count` field and the relation endpoints.
