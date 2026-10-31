---
title: Mark your Done column so analytics stay honest
description: Create a board, shape its columns, and mark where work finishes, before your team moves a card.
sidebar:
  label: Board setup
---

Create a board from a template, adjust its columns, then mark every column where work finishes as **done**. Do it after [First boot](/getting-started/first-boot/) and before you invite your team.

**Why it matters:** These steps are what make analytics accurate from day one. Until a Done column is marked, finished work counts as work in progress.

## Create your first board

Click **+ New board**. The Create Board modal offers 11 templates:

- **10 pre-built pipelines** (Sales Pipeline, Customer Support, Product Roadmap, and more), each with columns and a first swimlane tailored to that workflow
- **Blank Board**, which starts with no columns or swimlanes at all, so you add your own

**Yes, but:** a template applies once, at creation. Afterward you can rename, reorder, add, or remove columns freely.

**Go deeper:** the full template list is in [Board & Cards: Board creation](https://docs.visiban.com/latest/features/board/#board-creation).

## Customizing columns

Columns are the stages in your pipeline, for example Backlog, In Progress, Review, Done. If a template already gave you the right ones, skip to [Marking the Done column](#marking-the-done-column).

- **Add a column:** hover over the vertical separator between two columns. A blue **+** handle appears at its center. Click it to insert a column to the right of that separator.
- **Rename a column:** click its name in the header. Press Enter to confirm or Escape to cancel.
- **Everything else:** open the header's overflow menu and choose **Edit**.

**Go deeper:** WIP limits, weight limits, and every other column option are in [Board & Cards: Columns](https://docs.visiban.com/latest/features/board/#columns).

## Marking the Done column

Mark every column where work finishes as **done** (for example "Done", "Closed", or "Released") before your team moves its first card.

:::caution[Required for accurate analytics]
Until at least one column is marked as done, the dwell-time heatmap includes all columns: closed work stays in the data and distorts stage timing. Mark your completion column before your team starts moving cards.
:::

<a id="why-this-matters"></a>

**Why it matters:** Without a marked done column:

- completed cards keep accumulating dwell time in their current column
- the heatmap shows those columns as bottlenecks even though the work is finished
- velocity counts in the Summary view stay at zero

**How it works:** Marking a column done tells Visiban to:

- **Exclude it from the dwell-time heatmap**, so completed work doesn't inflate time-in-stage figures for active stages
- **Count movements into it as completed work**, which powers the 7-day and 30-day velocity figures in the Summary view

Archived cards use their archive timestamp as the exit time, so they don't accumulate dwell time after archiving.

<a id="steps"></a>

**To mark it:**

1. Open the header overflow menu on your Done column (the **⋯** icon that appears on hover).
2. Choose **Edit**.
3. Check **Mark as done column**.
4. Save.

**Yes, but:** the column label doesn't change on the board. The "done" designation shows up only in analytics views. You can mark more than one column as done, for example both "Closed Won" and "Closed Lost".

:::tip[Check that it took]
Open the Analytics view. A note below the heatmap shows how many done columns are excluded from the calculation.
:::

<a id="demo-board"></a>

**Want a reference board?** If you seeded the instance with demo data (`python manage.py seed_demo_data`), the demo board already has `is_done` set on its terminal column. Inspect it before configuring your own.

<a id="next-steps"></a>

**Next:** [Invite your team](/getting-started/first-boot/#inviting-your-team) with invite links or a registration mode. **Go deeper:** [Analytics](https://docs.visiban.com/latest/features/analytics/) covers the dwell-time heatmap, stalled cards, and CSV export.
