# Write down when a card may enter a column, and when it is done

<a id="column-policies"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

A board admin can give each column a short **policy**: its **entry criteria** (what must be true before a card moves in) and its **definition of done** (what must be true before the card moves on). Everyone on the board sees the policy from the column header.

**Why it matters:** "make policies explicit" is a core Kanban practice, alongside WIP limits. When the rules for a stage live only in people's heads, "Review" means something different to each person, and cards move on before they are ready.

**How it works:** the policy is text the board shows at the moments it matters: in the column header, while you drag a card over the column, and in card detail. In **Ask the mover to confirm** mode, a card dropped into the column opens a checklist of its entry criteria first.

**Yes, but:** a policy is guidance, not enforcement. The server never refuses a move because of it. The confirm checklist is a prompt in the web app only; the API, the [MCP server](mcp-server.md), bulk moves, the card detail **Move** button and board import never show it. Use [WIP limits](board.md) when you need a hard rule.

---

## Write a policy

You need to be a board admin.

1. In the column header, open the **⋮** menu and choose **Add policy…** (or **Edit settings…**, then the **Policy** tab). On a column that already has a policy, click **Policy** in the header, then **Edit policy**.
2. Under **Entry criteria**, click **+ Add criterion** and type one criterion per line, for example *Acceptance criteria written* or *Has an owner*.
3. Under **Definition of done**, add what must be true before the card leaves the column, for example *Reviewed by a second engineer*.
4. Use the **↑** and **↓** buttons to put the criteria in order, and **×** to remove one.
5. Choose what happens when a card enters:
    - **Show the criteria** (the default): the criteria appear in the header and while a card is dragged over the column.
    - **Ask the mover to confirm**: after a drop, the mover checks off every entry criterion before the card moves in.
6. Click **Save**.

Each list holds up to 8 criteria of up to 200 characters each, one line each. A list can be empty. Remove every criterion from both lists to remove the policy.

Everyone on the board sees a saved policy at once, without reloading. If the board has a public [share link](board.md#board-sharing), its policies are part of what the link shares, so keep customer names and other private details out of them.

## Read a policy

A column with a policy shows a **Policy** button next to its name, at rest, not only on hover. On a narrow screen it is the clipboard icon alone. Click it to see the entry criteria, the definition of done, and the mode (**Advisory** or **Confirm on entry**). Press Escape or click elsewhere to close it.

When you open a card, its column's **Definition of done** is listed in the *Details* tab for reference. It never stops you moving the card on.

## Moving cards into a column with a policy

While you drag a card over a column with entry criteria, the drop target lists them (**Entry: …**). With the keyboard, the criteria are read aloud as you move over the column.

In **Ask the mover to confirm** mode, dropping the card opens **Move "…" to Review?** with the entry criteria as a checklist. **Move to Review** stays unavailable until every item is checked. **Keep in In progress** (named after the card's current column), Escape, or clicking outside cancels the move. Either way, focus returns to the card.

A [WIP or weight limit](board.md) comes first: if the drop would be blocked by a limit, no checklist opens, and the move is refused as usual. Moving a card within the same column never asks.

## Export, import and templates

Policies are part of the board's [JSON export](../api/boards.md#get-apiv1boardsidexportformatjson), and a JSON import restores them. A board template column can carry a `policy` too. An import with a malformed policy is refused with `400`; a template's malformed policy is dropped, and the column is created without one.

## For API clients

`policy` is a field on every column object: `null`, or `{"v": 1, "entry": [...], "done": [...], "mode": "advisory" | "confirm"}`. Only board admins can change it. See the [Boards API](../api/boards.md#columns) and [Field Enforcement](../architecture/field-enforcement.md), where it is classified as advisory.
