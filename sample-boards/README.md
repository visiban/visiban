# Sample Boards

Ready-to-import board templates for Visiban. Each template includes realistic
cards, movement history, labels, checklists, comments, and activity records.

## Available Templates

| File | Description | Swimlanes | Cards |
|------|-------------|-----------|-------|
| `demo_board.json` | General product development board | 10 | ~113 |
| `sales_pipeline.json` | Deal tracking by sales region | 11 | ~117 |
| `customer_support.json` | Support tickets by customer account | 11 | ~110 |
| `customer_success.json` | Account health and lifecycle tracking | 11 | ~132 |
| `simple_kanban.json` | General-purpose team kanban | 10 | ~120 |
| `product_roadmap.json` | Feature tracking from idea to launch | 10 | ~120 |
| `project_delivery.json` | Cross-functional project tracking | 10 | ~120 |
| `content_production.json` | Content pipeline by channel | 10 | ~120 |
| `hiring_recruiting.json` | Hiring pipeline by department | 10 | ~120 |
| `infra_devops.json` | Infrastructure and operations tracking | 10 | ~120 |
| `legal_compliance.json` | Legal document and compliance tracking | 10 | ~120 |

## How to Import

1. Log in to your Visiban instance
2. Go to **Dashboard** and click **Import**
3. Select a `.json` file from this directory
4. The board, columns, swimlanes, labels, and cards are created automatically

CSV files are also provided for each template — these contain a flat card summary
without movement history, suitable for spreadsheet review or migration from other tools.

## Regenerating

These files are generated from the seed data scripts in `backend/boards/seed_data/`.
To regenerate after modifying the scripts:

```bash
# Regenerate template boards (10 templates)
python3 backend/boards/seed_data/generate_seed_data.py

# Regenerate demo board (requires Django + database)
python manage.py seed_demo_data --wipe --export --force
```
