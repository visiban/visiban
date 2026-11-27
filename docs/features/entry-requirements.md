# Entry requirements

!!! info "New in 1.3"

Entry requirements let a column say what a card needs before it enters: an
amount above a threshold, a field filled in, a dimension satisfied, or a whole
field set complete. They are the enforceable form of a [column policy's](column-policies.md)
entry criteria.

## What a requirement can check

| Field type | Conditions |
|---|---|
| Text, URL, date, dropdown | is filled |
| Number | is filled, is more than, is at least |
| Multi-select | is filled, has at least N choices |
| Dimension | is satisfied, is filled. *Not applicable* in a swimlane counts as satisfied. |
| Checkbox | Can't be required yet. |
| A [field set](custom-fields.md) | every field in the set is filled (checkbox fields are ignored) |

A column can have up to 10 requirements. All of them must be met.

## Enforcement modes

Each column chooses one mode. New requirements start in **Warn**.

- **Warn**: the card moves in and a toast says which requirements were not
  met. The move is recorded with what was not met: the card's History tab and
  the board's History show "· N entry requirements not met" on that move, and
  the record names the requirements, never the card's values.
- **Block**: the move is refused. A board admin can move it anyway with a
  reason, and so can the card's assignee when the board allows
  [assignee overrides](board.md#letting-a-cards-assignee-move-it-anyway-since-13). The reason is visible to everyone on
  the board and is saved to the card's history.
- **Hard**: the move is refused for every role.

Turning a column's requirements off keeps them saved, so you can turn them
back on later. Saving an empty requirement list is different: it removes
every requirement and turns the mode off.

Over MCP, **Block** acts as **Hard**: an MCP tool call can't send an override
reason, so a move that would need one is refused.

## When requirements are checked

- Moving a card **forward** into the column (from a column to its left).
- Creating a card directly in the column.
- Restoring an archived card into the column.

They are not checked when a card moves backward, changes swimlane inside the
same column, moves between sub-columns of a stage, or changes weight. A card
already in the column is not affected when a requirement is added, and
clearing a required field later is allowed.

Board import and the demo seed commands restore boards as exported and are
not checked.

## Export and import

A board export carries each column's requirements and mode, naming fields and
field sets by name rather than by id. Importing the file restores them on the
new board. A requirement whose field or field set name matches nothing in the
file is skipped, and so is one the field's type can't take (for example a
"has at least N choices" condition on a number field, or a count below 1);
each skip is listed in `import_summary.warnings`. A column left with no
requirements imports with the mode off. Override history is not exported.

## Which swimlanes a requirement applies to

You don't choose swimlanes for a requirement. It follows the field set its
field belongs to: a field in a set shown only in some swimlanes is required
only in those swimlanes, and an ungrouped field is required everywhere.
Deleting that set, or moving the field out of it, makes the requirement apply
in every swimlane; the field set editor lists the affected requirements before
you save.

## Setting them up

Board admins set requirements in **Board settings › Rules & limits › Entry
requirements**, or from a column's **⋮** menu with **Entry requirements…**,
which opens the same place with that column selected. Search **Find a setting**
for "entry requirements" to jump there.

1. Pick the column in the strip at the top. Each column's marker shows its
   mode: a plain ring for off, ⚠ for Warn, a lock for Block and ⛔ for Hard.
2. Add conditions with **+ Field condition** (choose a field, then *is filled*,
   *is more than*, *is at least*, *has at least N choices* or *is satisfied*,
   depending on the field's type) or **+ Whole field set complete**. Every
   condition must hold. Checkbox fields can't be required yet. A column can
   have up to 10 conditions.
3. Choose what happens when a card doesn't meet them: **Warn** (let it in and
   flag it; the default), **Block** (board admins, and assignees when the board
   allows it, can move it anyway with a reason) or **Hard** (no override).
4. Select **Save requirements**. The "Applies to" line under the conditions
   shows which swimlanes they cover; it follows the field sets, so it is not
   chosen here.

Turning **Requirements on** off keeps the saved conditions but stops checking
them. A column with **Requirements on** and no conditions saves as off, and
the editor says "Add at least one condition to turn requirements on." If the
board has no card fields yet, the editor says "Add card fields first (Board
settings > Card fields)." and hides **+ Field condition**. Switching columns
with unsaved edits shows an inline Discard/Cancel prompt; Escape cancels it.
Everyone else on the board reads one sentence per column and the note
"Only board admins can change entry requirements."

When a move is refused, the notice reads "Can't move to {column}" and lists
what the card needs. An override always asks for a reason, which everyone on
the board can see. After a Warn move, a notice says how many requirements are
not met, with **Fill in**, which opens the card. Screen readers hear the
refusal as a count (for example "2 entry requirements unmet"); the "Needs:"
list is in the visible body only.

Warn is announced after a move, including a move forced past a WIP limit.
Creating or restoring a card into a Warn column records the unmet list on the
movement and returns `entry_unmet`, but shows no toast yet.

Two aids are not built yet: a save-time confirm of how many cards would be
blocked, and a footer showing how many cards don't meet the requirements
today. They are tracked in #2649.

Deleting a field set, saving a set so a field leaves a lane-limited set, or
changing a set's scope from swimlanes to all lists the requirements that would then apply in every swimlane before it goes
ahead.

## API

See [`PUT .../columns/{id}/entry-requirements/`](../api/boards.md#put-apiv1boardsidcolumnscol_identry-requirements-since-13-1923)
and the [`entry_requirements_unmet` error](../api/cards.md#entry-requirements-since-13-1923).
