# Show whether a board or group is on track

<a id="health-status"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

A board or group admin can mark a board or a group **On track**, **At risk** or **Off track**. A group's status carries down to its subgroups and boards, so one status on a group covers a whole workstream, and any board or subgroup can set its own instead.

**Why it matters:** cards tell you how each piece of work is going, but not whether the workstream as a whole is in trouble. A health status gives a project manager that answer at a glance, on the dashboard, in the group tree and on every board.

**How it works:** the status is set by hand. Visiban never works it out from the cards, and a group's status is never worked out from its boards. When a board or subgroup has no status of its own, it shows the status of the nearest group above it that has one. That inherited status is drawn with a dashed border and says where it comes from.

**Yes, but:** a status is a judgment someone keeps up to date. Visiban shows when it was last set or confirmed and by whom ("Set 3d ago by Priya"), so an old status is visible as old, but nothing reminds anyone to review it.

---

## The four states

| State | Shape | Meaning |
|---|---|---|
| **On track** | filled circle | Work is going as planned. |
| **At risk** | triangle | Something could slip without action. |
| **Off track** | diamond | The plan is not being met. |
| **No status** | hollow circle | Nothing is set here or in any group above. Only admins see it, on the board or group page, as the place to set one. |

Every state has its own shape and word as well as its color, so it reads the same without color.

## Set a status

You need to be a board admin to set a board's status, and a group admin to set a group's.

1. On a board, find the status next to the star after the board's name, at the top of the page. On a group page, it is next to the member and board counts under the group's name.
2. Click it (or Tab to it and press Enter).
3. Choose **On track**, **At risk** or **Off track**. The arrow keys move between them.
4. Optionally add a **Note** (up to 280 characters), the reason for the status, such as "vendor slipped API delivery". It is shown in the tooltip and the history.
5. Press Enter or click **Save**.

**Confirm a status that is still right.** Open the editor without changing the choice, optionally add a note, and click **Confirm status**. That records that someone checked, refreshes "Set … ago", and adds a "confirmed" line to the history. **Save** with an unchanged choice just closes the editor; only **Confirm status** records a check. A note is saved only with **Save** or **Confirm status**; Cancel, Escape or clicking elsewhere discards it.

To go back to the inherited status, choose **Inherit from** *group name* and save. On a top-level group or a personal board, which has nothing above it, that choice is **No status**, which clears the status.

Escape, **Cancel**, or clicking elsewhere closes the editor without saving. A status that is not saved shows an error in the editor, and your choice stays selected so you can try again.

Members, collaborators and viewers see the status but cannot change it. Clicking it opens a read-only view with who set it, the note and the history. When nothing applies, they see nothing.

In the hosted demo the status cannot be changed.

## How a status carries down

- A group's status applies to every subgroup and board below it, up to six levels down, unless one of them sets its own.
- A board or subgroup that sets its own status keeps it when a group above it changes. Setting the same value as the group still counts as its own: it stays when the group changes.
- The nearest group with a status wins. If **Engineering** is *At risk* and its subgroup **Platform** is *On track*, the boards in Platform show *On track*.
- An inherited status shows a dashed border, and its tooltip says where it comes from, for example *At risk (inherited from Engineering)*. On the group page, a caption reads **Inherited from Engineering**.

There is no roll-up in the other direction: a group is never marked *Off track* because one of its boards is.

## Where the status shows

- **Board page:** next to the star after the board's name. On a narrow screen only the shape shows; the word is still read out by screen readers.
- **Group page:** under the group's name, with its subgroup cards, its boards and, when **Show subgroup boards** is on, the boards in its subgroups.
- **Dashboard:** next to each board's name, and in the groups tree.

Lists show a status only where one applies; they never show **No status**. A group you can see only because it is on the path to one of your groups (shown without its counts) shows no status either.

## Who set it, and the history

The status's tooltip says when it was set and by whom, with the note if there is one: *Health status: At risk. Set 3d ago by Priya. Note: vendor slipped API delivery.* Within a week the time is relative ("3d ago"); after that it is a date ("on Sep 14"). Hover a time for the exact date and time. On a group page the same line shows under the group's name. An inherited status shows when its group set it: *inherited from Eng, set 3d ago*.

**History** in the editor lists the 20 most recent changes, newest first: from and to, who, when, and the note. A confirm shows as one status followed by "confirmed". **System** means the account was removed or the change was automatic. A status set before this history existed has no "Set …" line and no history until it is next set or confirmed. Older changes are kept but not listed.

## Lane status

<a id="lane-status"></a>

A board admin can also give a single swimlane its own status. On a board with one lane per customer, project or candidate, that marks the one lane in trouble (the **Acme** lane is **At risk**) while the rest of the board is fine.

- **Set it:** hover the lane's label panel and choose the half-filled circle icon (on a touch screen it is always visible), or Tab to it. Pick **On track**, **At risk** or **Off track** and choose **Save**. To change or clear it, choose the lane's status pill; **No status** clears it. Only board admins can set or clear a lane's status.
- **Where it shows:** on its own line under the lane's name. On a collapsed lane only the shape shows, next to the name; the word is still read out by screen readers. A lane with no status shows nothing to anyone who is not a board admin.
- **It is independent of the board:** a lane's status never comes from the board's, and the board's status is never worked out from its lanes. Changing one never changes the other. A lane with no status means just that, *no status*: unlike a board, whose empty status means "inherit from the group above", a lane never inherits, so its pill is never dashed.
- **Who sees it:** everyone who can see the board, and a change reaches everyone with the board open at once. A public share link does not show lane status.
- **Export and import:** a board's JSON export carries each lane's status, and importing the file restores it.
- **No note or history:** a lane's status has no note, no **Confirm status** and no **History**; those are for boards and groups.

!!! note "If you already track health with a lane field"
    A board that built its own **Health** dropdown as a [swimlane custom field](custom-fields.md#swimlane-row-custom-fields) now has two: that field and the lane status. Nothing moves the field's values into the lane status. Lane status is the one that shares the board and group pills' shapes and words, and that later lane features will build on; you can delete the custom field once you have set the statuses by hand.

The lane status is the lane's **manual** status: a value an admin pins. Like every 1.0+ field it follows the API stability rules, so it will not be renamed or removed.

## When other people see a change

A change to a board's status reaches everyone who has that board open, at once.

A change to a group's status updates that group's page for everyone who has it open, including the subgroups and boards listed on it. The pages of its subgroups and boards that are already open do **not** update: they show the new inherited status after a reload (a board page also catches up after a lost connection). The dashboard shows the new status the next time it loads.

## For API clients

Boards and groups carry `health_status_changed_at`, `health_status_changed_by` and `health_status_note` (the last set or confirm; 1.3+) and `POST .../health-status/` / `GET .../health-history/` endpoints for setting, confirming and reading the history. They also carry three fields: `health_status` (the entity's own value, or `null` to inherit), `effective_health_status` (the value that applies) and `health_status_source` (the `{id, name}` of the group the value comes from, or `null`). Values are `on_track`, `at_risk` and `off_track`. See the [Boards API](../api/boards.md#get-apiv1boardsid) and the [Groups API](../api/groups.md#get-apiv1groupsid).

Swimlanes carry one field, `health_status` (the lane's manual status, or `null` for no status; there is no inheritance, so there is no `effective_health_status` or `health_status_source`). Board admins write it with `PATCH /api/v1/boards/{id}/swimlanes/{swimlane_id}/`; see the [Swimlanes API](../api/boards.md#swimlanes).
