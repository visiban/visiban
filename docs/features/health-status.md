# Show whether a board or group is on track

<a id="health-status"></a>

<span class="vb-version" title="Added in 1.3">1.3+</span>

A board or group admin can mark a board or a group **On track**, **At risk** or **Off track**. A group's status carries down to its subgroups and boards, so one status on a group covers a whole workstream, and any board or subgroup can set its own instead.

**Why it matters:** cards tell you how each piece of work is going, but not whether the workstream as a whole is in trouble. A health status gives a project manager that answer at a glance, on the dashboard, in the group tree and on every board.

**How it works:** the status is set by hand. Visiban never works it out from the cards, and a group's status is never worked out from its boards. When a board or subgroup has no status of its own, it shows the status of the nearest group above it that has one. That inherited status is drawn with a dashed border and says where it comes from.

**Yes, but:** a status is a judgment someone keeps up to date. Nothing reminds anyone to review it, and an old status keeps showing until someone changes it.

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
4. Press Enter or click **Save**.

To go back to the inherited status, choose **Inherit from** *group name* and save. On a top-level group or a personal board, which has nothing above it, that choice is **No status**, which clears the status.

Escape, **Cancel**, or clicking elsewhere closes the editor without saving. A status that is not saved shows an error in the editor, and your choice stays selected so you can try again.

Members, collaborators and viewers see the status but cannot change it. When nothing applies, they see nothing.

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

## When other people see a change

A change to a board's status reaches everyone who has that board open, at once.

A change to a group's status updates that group's page for everyone who has it open, including the subgroups and boards listed on it. The pages of its subgroups and boards that are already open do **not** update: they show the new inherited status after a reload (a board page also catches up after a lost connection). The dashboard shows the new status the next time it loads.

## For API clients

Boards and groups carry three fields: `health_status` (the entity's own value, or `null` to inherit), `effective_health_status` (the value that applies) and `health_status_source` (the `{id, name}` of the group the value comes from, or `null`). Values are `on_track`, `at_risk` and `off_track`. See the [Boards API](../api/boards.md#get-apiv1boardsid) and the [Groups API](../api/groups.md#get-apiv1groupsid).
