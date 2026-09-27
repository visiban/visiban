# Import from Trello

> **Added in 1.2**

Bring a Trello board into Visiban in a few minutes. You export the board from Trello as a JSON file, upload it, review a preview, and Visiban creates a **new board** from it.

!!! note "What is not supported"
    - Importing into an **existing** board. The import always creates a new board.
    - Attachment files. Only attachment links are imported.
    - Jira or other tools. Only Trello JSON exports are supported.

## Export your board from Trello

1. Open the board in Trello.
2. Open the board menu and choose **Print, export, and share**.
3. Choose **Export as JSON** and save the file.

Files up to 25 MB are accepted by default. Administrators can change this limit with `VISIBAN_IMPORT_MAX_SIZE`. See [Import limits](../administration/configuration.md#import-limits).

## Start the import

1. Go to the **Dashboard**, or open a group page.
2. Click **Import**.
3. Click the **Import a Trello export** link.

From the Dashboard, the new board is created in your personal boards. From a group page, it is created in that group, and you must be a member of the group to import into it.

## Step 1: Choose the file

Click the drop area and select your Trello `.json` file, or drag the file onto it. Then click **Continue**. Visiban uploads the file and reads it. Nothing is created yet.

## Step 2: Review and configure

The review step shows what the import will create. Change any option you like. The summary updates as you go, and nothing is created until you click **Create board**.

**Board name.** Defaults to the Trello board name. The text below the field tells you where the board will be created.

**Warnings.** If some Trello data cannot be imported, a warning box lists it. Everything else still imports normally.

**Summary tiles.** Counts of columns, cards, labels, checklist items, comments, attachments, members, and checklists.

**Columns.** Each Trello list becomes a column, in the same order. If the export contains archived lists, turn on **Include archived lists** to import them too. Their cards are imported as archived. A table shows each list, its card count, and whether it will be imported or skipped.

**Swimlanes.** Optional. Turn on **Make swimlane** for any Trello labels you want as swimlanes.

- A card goes to the swimlane of its first selected label, in that card's own label order.
- Cards with no selected label go to a default swimlane. Set its name in **Default swimlane name** (default: `Unassigned`). It must differ from the names of the labels you turned into swimlanes.
- Unnamed labels can't be swimlanes.
- If you select no labels, all cards go into a single swimlane.

**Members.** See [Member matching and privacy](#member-matching-and-privacy).

Click **Create board**. You see an upload progress bar, then **Creating board…**. Keep the window open until it finishes. The import runs while you wait (there is no background job yet), so very large boards can take a minute.

## What gets imported

| Trello | Visiban |
|--------|---------|
| Lists | Columns, in the same order. Archived lists are skipped by default. If you include them, they are imported along with their archived cards. |
| Cards | Cards with the title (up to 500 characters), description, due date, archived state, and original creation time. The due date is imported as a date, in UTC. |
| Labels | Labels. Each Trello color maps to the closest Visiban color. Unnamed labels are named after their color. Duplicate names get a " (2)" suffix. |
| Checklists | One checklist per card. Visiban supports one checklist per card, so multiple Trello checklists are combined, and each item is prefixed with `Checklist name: `. |
| Comments | Comments, with their original timestamps. |
| Attachments | Links are added to the card description under **Attachments (imported from Trello)**. The files themselves are not copied. |
| Members | Matched to Visiban users when possible. See below. |

**Not imported:** Power-Up data, custom fields, start dates, stickers, attachment files, votes, and covers. The preview lists what applies to your board.

## Member matching and privacy

Visiban matches a Trello member to a Visiban user when the Trello username equals the Visiban username, ignoring case.

Only people you can already see in Visiban are checked: people who share a board or group with you, and members of the target group. Site admins can match everyone.

!!! note "Why the preview does not name matched people"
    The preview shows only **how many** members matched, never who. This stops the import from revealing which accounts exist on the instance. People who did not match are listed by their Trello name.

**Add matched members to this board** is off by default.

- **On:** matched users become board members with the Member role. They are assigned to their cards (the first matched Trello member on each card), and their comments keep them as the author, marked *(imported from Trello)* so it is clear the comment came from the import.
- **Off**, and for unmatched people: cards are unassigned, and comments are posted by you with a `**Name** (imported from Trello)` prefix.

Importing never sends notifications.

## Limits

| Limit | Value |
|-------|-------|
| File size | 25 MB (configurable) |
| Lists | 50 |
| Cards | 5,000 |
| Labels | 200 |
| Checklist items | 20,000 |
| Comments | 20,000 |
| Members | 1,000 |
| Trello actions (activity, including comments) | 50,000 |
| Attachments | 20,000 |
| Previews | 60 per hour |
| Imports | 10 per hour |

Trello imports share the 10-per-hour import budget with the regular [board import](board.md#import).

Trello's own export includes only the most recent 1,000 actions, so older comments may be missing. The preview warns you when this is likely.

If your board exceeds a count limit, split it into smaller boards in Trello and import each one.

## Troubleshooting

**"File is too large. Maximum size is 25 MB."** Your export is over the size limit. If the file is smaller than the limit and you still see this, a reverse proxy in front of Visiban may be rejecting large uploads. Ask your administrator to check [Import limits](../administration/configuration.md#import-limits).

**"This does not look like a Trello board export."** The file is not a board export from Trello. Export the board again using **Print, export, and share** then **Export as JSON**. Make sure you choose the board export and not another file.

**"Unsupported file format."** Upload the `.json` file exported from Trello.

**"You don't have permission to create boards in this group."** You are not allowed to create boards in that group. Ask a group admin to add you, or import from the Dashboard to create a personal board.

**"Too many previews" or "Import limit reached (10 per hour)".** You hit a rate limit. The message tells you how many minutes to wait.

**The window closed or the connection dropped while creating.** The board may already have been created. Check your boards before trying again.
