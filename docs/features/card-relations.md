# Card Relations

> **Added in 1.2**

Link two cards on the same board to record that one depends on the other. A card
that something is waiting on carries a red indicator on the board, so you can see
what is stuck without opening anything.

Three relation directions are available:

| Direction | Meaning | Affects the board indicator |
|---|---|---|
| **Blocked by** | The other card has to land before this one can move | Yes — on this card |
| **Blocks** | This card has to land before the other one can move | Yes — on the other card |
| **Relates to** | The two cards are associated, with no ordering implied | No |

**Blocks** and **Blocked by** are the same link seen from opposite ends. Record
"A is blocked by B" and card B automatically shows "Blocks A" — there is nothing
to keep in sync by hand.

---

## The blocked indicator

A card with at least one unfinished blocker shows a red ⊖ glyph at the start of
its metadata row. With more than one blocker, the count appears next to it.

The indicator appears at **every card density** and in both the Compact and
Expanded card layouts, because seeing blocked work while scanning a column is the
point of the feature. Hovering shows the exact count ("Blocked by 2 cards").

Only **Blocked by** relations count. A card that blocks other cards is not itself
blocked, and **Relates to** never contributes.

Blockers that have been **archived** stop counting — an archived card is not on
the board, so it cannot be what is holding work up. The relation itself is kept
and shown in the card detail panel (struck through, marked *Archived*) so you can
see why and remove it.

---

## Viewing and editing relations

Open a card and find the **Relations** section in the *Details* tab, between
Weight and Checklist. It groups links under **Blocked by**, **Blocks**, and
**Relates to**, in that order — what you are waiting on first.

Each row shows the linked card's title and the column it is currently sitting in,
which usually answers "is my blocker done yet?" without another click. Click a
title to open that card; the panel switches to it.

The section starts expanded when the card has any relations and collapsed when it
has none.

### Adding a relation

1. Click **+ Add relation**.
2. Pick the direction — **Blocked by** (the default), **Blocks**, or **Relates to**.
3. Type at least two characters to search the board's cards, and pick one.

The picker stays open after each link so you can add several in a row. Cards that
cannot be linked — the card itself, and anything already linked in a way that
would conflict — are left out of the results.

### Removing a relation

Hover a relation row and click **✕**. Either card can remove the link; both show
it. There is no confirmation step — the relation is trivially re-addable.

---

## Permissions

| Role | View relations | Add / remove |
|---|---|---|
| Viewer | Yes | No |
| Collaborator | Yes | Yes |
| Member | Yes | Yes |
| Admin | Yes | Yes |

A relation changes how a card reads on the board for everyone, so adding and
removing requires at least the Collaborator role. Viewers see relations but no
controls.

---

## Limits

- **Same board only.** Relations cannot span boards.
- **A card cannot be linked to itself.**
- **Two cards cannot block each other.** Longer chains (A blocks B blocks C
  blocks A) are not detected and are permitted.
- **Relations are not carried by board export or import.** A board exported and
  re-imported loses its relations.
- **Blockers are not cleared automatically.** Moving a blocking card to a done
  column does not remove the relation or the indicator — archive the card, or
  remove the relation, when the dependency is resolved.

---

## Real-time behavior

Adding or removing a relation updates both cards for everyone viewing the board
immediately, over the same WebSocket channel as every other card change. See
[Real-time Updates](realtime.md).

Relations are visible on **public share links** only as the blocked indicator —
anonymous visitors see that a card is blocked and by how many cards, but not the
relation list, who created it, or when.

---

## API

See [Cards API → Relations](../api/cards.md#relations-since-12) for the
`blocker_count` field and the relation endpoints.
