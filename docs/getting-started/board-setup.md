# Board Setup

This guide covers the initial configuration steps that make analytics accurate from the start. Complete these steps after [First Boot](first-boot.md) and before inviting your team.

## Create your first board

When you click **+ New board**, the Create Board modal offers 11 pre-built templates (Sales Pipeline, Customer Support, Product Roadmap, and more). Each template sets up columns and a first swimlane tailored to that workflow, so you can start adding cards immediately. If none of the templates fit, choose **Blank board** for the default layout (Backlog, To Do, Doing, Done).

Templates are applied once at creation time — you can freely rename, reorder, add, or remove columns afterward. For the full list of available templates, see [Board & Cards — Board creation](../features/board.md#board-creation).

## Customizing columns

Columns represent the stages in your pipeline (for example: Backlog, In Progress, Review, Done). If you used a template, you may already have the right columns in place — skip ahead to [Marking the Done column](#marking-the-done-column) if so.

To add a column, hover over the vertical separator between any two columns on the board — a blue **+** handle appears at the center. Click it to insert a new column to the right of that separator.

To rename a column, click its name in the column header (Enter to confirm, Escape to cancel). For full column settings, open the column header overflow menu and choose **Edit**.

See [Board & Cards — Columns](../features/board.md#columns) for the full list of column options including WIP limits and weight limits.

## Marking the Done column

!!! warning "Required for accurate analytics"
    Until at least one column is marked as done, the dwell-time heatmap includes all columns — closed work stays visible in the data and distorts stage timing. Mark your completion column before your team starts moving cards.

Every board should have at least one column designated as the completion point (for example, "Done", "Closed", or "Released"). Marking it tells Visiban to:

- **Exclude it from the dwell-time heatmap** — so completed work does not inflate time-in-stage figures for active stages
- **Count movements into it as completed work** — powering the 7-day and 30-day velocity figures in the Summary view

### Steps

1. Open the column header overflow menu on your Done column (the **⋯** icon that appears on hover).
2. Choose **Edit**.
3. Check **Mark as done column**.
4. Save.

The column label does not change on the board — the "done" designation is only reflected in analytics views. You can mark multiple columns as done (for example, both "Closed Won" and "Closed Lost").

!!! tip
    To verify the setting took effect, open the Analytics view. A note below the heatmap shows how many done columns are excluded from the calculation.

## Why this matters

Without a marked done column:

- Cards that have been completed continue to accumulate dwell time in their current column
- The heatmap shows those columns as bottlenecks even though the work is finished
- Velocity counts in the Summary view stay at zero

With a marked done column:

- The heatmap covers only active in-flight stages
- Archived cards use their archive timestamp as the exit time, so they do not accumulate dwell time after archiving
- Velocity counts reflect real throughput

## Demo board

If you seeded the instance with demo data (`python manage.py seed_demo_data`), the demo board comes pre-configured with `is_done` set correctly on its terminal column. You can inspect it as a reference before configuring your own boards.

## Next steps

- [Invite your team](first-boot.md#inviting-your-team) — generate invite links or set the registration mode
- [Analytics](../features/analytics.md) — full reference for the dwell-time heatmap, stalled cards, and CSV export
