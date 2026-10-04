# Sample Boards

Visiban ships 12 ready-to-import sample boards: eleven templates and a demo board. Import
one to get a fully populated board in a few seconds. Each sample has real columns,
swimlanes, labels and cards, typed custom fields, a full audit trail and enough movement
history to fill the analytics charts.

## Where to get the files

The samples live in the [`sample-boards/`](https://gitlab.com/visiban/visiban/-/tree/main/sample-boards)
directory at the root of the Visiban repository. Each board comes as a `.json` file and a
`.csv` file.

**Installed with Docker Compose or Helm?** The samples are not inside the container
images or the Helm chart. Download them from the repository instead, either from
[GitLab](https://gitlab.com/visiban/visiban/-/tree/main/sample-boards) or from the
[GitHub mirror](https://github.com/visiban/visiban/tree/main/sample-boards):

```bash
# One board
curl -LO https://gitlab.com/visiban/visiban/-/raw/main/sample-boards/sales_overlay.json

# All of them (sparse checkout of just the samples directory)
git clone --depth 1 --filter=blob:none --sparse https://gitlab.com/visiban/visiban.git
cd visiban && git sparse-checkout set sample-boards
```

To match your installed version, replace `main` with your release tag (for example
`v1.2.0`). Every sample imports into the release it was published with or into a later one.

**Working from a clone of the repository?** The files are already on disk at
`sample-boards/`, next to `backend/` and `frontend/`.

## Available samples

| File | Board | Swimlane = | Cards | Highlights |
|------|-------|-----------|------:|-----------|
| `sales_overlay.json` | **Sales Overlay** | Account | 46 | Enterprise overlay coverage: AD, AE, SA, overlay AE/SA pods and services lead per account. Uses every custom field type and all 15 swimlane fields. One account is partly covered and one has no overlay coverage |
| `sales_pipeline.json` | Sales Pipeline | Region | 117 | Deal value, forecast category, win probability, competitors |
| `customer_support.json` | Customer Support | Customer account | 110 | Severity, SLA due, affected components, support plan per account |
| `customer_success.json` | Customer Success | Segment | 132 | Health score, ARR at stake, risk driver, products adopted |
| `simple_kanban.json` | Simple Kanban | Team | 120 | Story points, sprint, GitLab merge request links |
| `product_roadmap.json` | Product Roadmap | Product area | 120 | RICE score, target quarter, platforms, GitHub issue links |
| `project_delivery.json` | Project Delivery | Project | 120 | RAG status, percent complete, budget, sponsor per project |
| `content_production.json` | Content Production | Channel | 120 | Content type, publish date, word count, channels |
| `hiring_recruiting.json` | Hiring & Recruiting | Department | 120 | Level, source, interview loop, admin-only comp budget |
| `infra_devops.json` | Infrastructure & DevOps | System | 120 | Severity, environments, SLO and tier per system, merge request links |
| `legal_compliance.json` | Legal & Compliance | Practice area | 120 | Risk, deadline, jurisdictions, admin-only privilege note |
| `demo_board.json` | Visiban Demo Board | Team | 115 | General product development board |

## How to import

1. Log in to your Visiban instance.
2. From the **Dashboard**, click **Import**.
3. Choose a `.json` file from `sample-boards/`.
4. Optionally untick what you don't want (cards, labels, comments, checklists, history).
   The board's columns, swimlanes and custom field definitions are always imported.
5. The board is created with everything in the file.

Imports are limited to 10 per user per hour.

!!! tip "Who did what"
    The samples name the users `demo1` through `demo5` as assignees and as the people
    behind each move and history entry. If accounts with those usernames exist on your
    instance, the import links them. If they don't, cards are imported unassigned and the
    moves and history entries are attributed to you, the importing user. Comments are
    always imported as written by you.

The `.csv` file for each of the eleven templates uses the same layout as **Export → CSV**
(`demo_board.csv` keeps an older, simpler summary layout). Use it to look at
the data in a spreadsheet or to try the CSV importer. CSV import creates cards with their
title, description, column, swimlane, priority, labels, due date and weight. It does not
restore movement history, comments, checklists or custom field values.

## What each sample includes

- **Typed custom fields on cards.** Six to eleven per board. Together the samples use
  every field type: number (with `$`, `%` or unit formatting), dropdown and multi-select
  (with choice colors), date, URL, checkbox and text. Sales Overlay uses all of them on
  one board. Two per board are pinned to the card face.
- **Swimlane fields.** Owner, budget, tier and similar facts about each row, pinned to the
  row header. Some are admin-only and hidden from non-admin members.
- **Column limits.** WIP and weight limits on the busy columns. On every board, one
  column is deliberately just over its limit so you can see how that is flagged.
- **A full audit trail on every card.** Creation, assignments and reassignments, labels
  added and removed, priority escalations, due-date changes, renames, description edits,
  checklist items added, checked, unchecked and deleted, and comments. Each entry has the
  user and time it happened.
- **Movement history.** Cards move through the workflow, sometimes skipping a stage or
  going back one. Backward moves carry a note explaining why. The heatmap and dwell-time
  charts are populated as soon as you import.
- **Archived cards.** Some finished cards are archived, the way a team clears its Done
  column.
- **Merge request and issue links.** The engineering boards link cards to fictional GitLab
  and GitHub URLs.
- **Done columns marked with `is_done`**, so analytics treat finished work correctly.

All people, companies and links in the samples are fictional.

## Regenerating the samples (contributors)

The eleven templates are generated. Do not edit the JSON or CSV by hand: the backend test
suite regenerates them and fails if the committed files differ from the generator output.

| File | Contains |
|------|----------|
| `backend/boards/seed_data/generate_seed_data.py` | Templates 1-5, history and audit-trail generation, CSV writer, entry point |
| `backend/boards/seed_data/generate_seed_data_part2.py` | Templates 6-10 |
| `backend/boards/seed_data/sample_features.py` | Custom fields, swimlane fields, column limits and links for templates 1-10 |
| `backend/boards/seed_data/sales_overlay.py` | The hand-written Sales Overlay board |

```bash
# Regenerate the eleven templates (no database needed; output is deterministic)
python3 backend/boards/seed_data/generate_seed_data.py

# Regenerate the demo board (needs Django and a running database)
cd backend
python manage.py seed_demo_data --wipe --export --force
```

Both commands write to `sample-boards/`.
