# Sample Boards

Ready-to-import boards for Visiban. Each JSON file is a complete board export: columns
with WIP and weight limits, swimlanes with their own custom fields, labels, typed card
custom fields, cards with checklists, timestamped comments, merge request links,
archived cards, movement history with notes, and a full audit trail of every change.

Full guide: [docs/getting-started/sample-boards.md](../docs/getting-started/sample-boards.md)
(published at the Visiban docs site under **Getting Started → Sample Boards**).

## Available boards

| File | Board | Swimlane = | Cards |
|------|-------|-----------|------:|
| `sales_overlay.json` | Sales Overlay: enterprise AE + overlay AE/SA account coverage | Account | 46 |
| `sales_pipeline.json` | Sales Pipeline | Region | 117 |
| `customer_support.json` | Customer Support | Customer account | 110 |
| `customer_success.json` | Customer Success | Segment | 132 |
| `simple_kanban.json` | Simple Kanban | Team | 120 |
| `product_roadmap.json` | Product Roadmap | Product area | 120 |
| `project_delivery.json` | Project Delivery | Project | 120 |
| `content_production.json` | Content Production | Channel | 120 |
| `hiring_recruiting.json` | Hiring & Recruiting | Department | 120 |
| `infra_devops.json` | Infrastructure & DevOps | System | 120 |
| `legal_compliance.json` | Legal & Compliance | Practice area | 120 |
| `demo_board.json` | Visiban Demo Board | Team | 115 |

## Getting the files onto a packaged install

These files are **not** included in the Docker images or the Helm chart. Download the
ones you want from this directory, either on
[GitLab](https://gitlab.com/visiban/visiban/-/tree/main/sample-boards) or on the
[GitHub mirror](https://github.com/visiban/visiban/tree/main/sample-boards):

```bash
curl -LO https://gitlab.com/visiban/visiban/-/raw/main/sample-boards/sales_overlay.json
```

## How to import

1. Log in to your Visiban instance.
2. From the **Dashboard**, click **Import**.
3. Choose a `.json` file from this directory.
4. The board is created with everything in the file.

Users named `demo1` to `demo5` in the files are linked if accounts with those usernames
exist. Otherwise cards import unassigned, and moves and history are attributed to the
importing user.

Each template's `.csv` file has the same column layout as **Export → CSV**
(`demo_board.csv` keeps an older summary layout). It is meant for
spreadsheet review or for trying the CSV importer, which creates cards but not their
history, comments, checklists or custom field values.

## Regenerating

These files are generated. Do not edit them by hand: `backend/boards/tests/test_sample_boards.py`
regenerates them and fails on any difference.

```bash
# The eleven templates (no database needed; deterministic output)
python3 backend/boards/seed_data/generate_seed_data.py

# The demo board (requires Django + database)
cd backend && python manage.py seed_demo_data --wipe --export --force
```

Template sources live in `backend/boards/seed_data/`: `generate_seed_data.py` (templates
1-5 and the generator), `generate_seed_data_part2.py` (templates 6-10),
`sample_features.py` (custom fields, limits and links) and `sales_overlay.py`.
