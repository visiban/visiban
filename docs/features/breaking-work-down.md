# Breaking work down: which tool?

<a id="which-tool"></a>

Visiban has five ways to break work down or track progress inside a column. Pick by asking two questions: is it about **this one card** or **every card in the column**, and does it need **its own flow** or just **done / not done**?

**Why it matters:** the five look alike on the board. A sign-off every card in Review needs can end up hand-typed into each card's checklist, and a piece of work that needs its own team and board can end up as a checklist item nobody else sees.

**The big picture:** a checklist and a child card belong to one card. Sub-columns, tracks and entry criteria belong to the column, so a board admin sets them up once and they apply to every card that enters it. A column is also called a **stage**, and a stage split into sub-columns is a **gated stage** (see [Board & Cards](board.md#board-cards)).

## Compare the five

| Tool | Use when | Belongs to | What it shows on the board |
|---|---|---|---|
| [Checklist](board.md#card-detail-panel) | to-dos inside one card, done or not done | the card | a `✓ 3/7` count on the card face |
| [Child card](board.md#child-cards-setting) (on another board that holds children) | a piece of the work needs its own workflow, usually on another team's board | the card | child progress on the parent card's footer |
| [Sub-columns](board.md#sub-columns-and-tracks-13) | every card in a column passes the same ordered steps | the column | the card's position in the gated stage (or a progress bar with **Show sub-columns** off) |
| [Tracks](board.md#sub-columns-and-tracks-13) | every card in a column needs the same checks, in any order | the column | one chip per track on the card |
| [Entry criteria](column-policies.md) (column policy) | remind the mover what "ready" means on entry | the column | nothing on the card; shown on the column header and when a card enters |

## The two-question rule

1. **Is it about this one card, or every card in the column?** One card: a checklist or a child card. Every card: sub-columns, tracks or entry criteria.
2. **Does it need its own flow, or just done / not done?**
    - For one card: its own flow (an owner on another team, its own columns, its own history) is a child card. Done / not done is a checklist item.
    - For every card in the column: steps that must happen in order are sub-columns. Checks that can finish in any order are tracks. A reminder of what "ready" means before a card comes in is entry criteria.

## One example per tool

**Checklist.** A card "Renew Acme contract" needs "Send the draft", "Get the signed copy" and "File it". Only this card needs them, and each is done or not. Add them to the card's checklist. Each item can have an assignee and a due date, but it has no columns or history of its own.

**Child card.** The same renewal needs a security review that the security team runs on its own board, with its own columns. Make it a child card: a board admin turns on **Cards on this board can have children** in **Board settings → Rules & limits → Child cards**, then **Add child** on the card's **Children** tab creates it on the child board. The parent card's footer shows the child's progress.

**Sub-columns.** Every card in **Build** goes through "Doing", then "Review", then "Ready". The order matters, and time in "Ready" is waiting. Split **Build** into those three sub-columns in its **Stage** tab. Cards move through them left to right, and analytics counts the last one as wait time.

**Tracks.** Every card in **Review** needs a Legal sign-off and a Security sign-off, in either order. Add two tracks, "Legal" and "Security", in the **Stage** tab instead of typing them into each card's checklist. Each card shows a chip per track, and its value is set in the card's **Custom fields**. A swimlane where Legal does not apply can mark that track not applicable for all its cards.

**Entry criteria.** Before a card enters **Review**, the mover should confirm "Tests pass" and "Description is complete". Write those as the column policy's entry criteria and choose **Ask the mover to confirm**. Nothing changes on the card; the criteria show on the column header and when a card is dropped in. They are a prompt in the web app, not a rule the server enforces.
