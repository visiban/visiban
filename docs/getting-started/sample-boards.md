# Sample Boards

Visiban ships with 11 pre-built board templates in the `sample-boards/` directory
at the repository root. Each template includes realistic cards, movement history,
labels, checklists, comments, and activity records — everything you need to see
a fully populated board with working analytics.

## Available templates

| Template | Swimlane theme | Use case |
|----------|---------------|----------|
| **Demo Board** | Product teams | General product development with bug fixes, features, and infrastructure |
| **Sales Pipeline** | Sales regions | Deal tracking from prospect through close |
| **Customer Support** | Customer accounts | Support ticket lifecycle from report to resolution |
| **Customer Success** | Account tiers | Account health, onboarding, adoption, and renewal tracking |
| **Simple Kanban** | Teams / workstreams | General-purpose kanban for any team |
| **Product Roadmap** | Product areas | Feature tracking from idea through launch |
| **Project Delivery** | Projects | Cross-functional project tracking from planning to retro |
| **Content Production** | Content channels | Content pipeline from ideation to publishing |
| **Hiring & Recruiting** | Departments | Hiring pipeline from sourcing to offer |
| **Infra & DevOps** | Systems / environments | Infrastructure and operations tracking |
| **Legal & Compliance** | Practice areas | Legal document and compliance workflow tracking |

## How to import

1. Log in to your Visiban instance as an admin or member
2. From the **Dashboard**, click **Import**
3. Select a `.json` file from the `sample-boards/` directory
4. The board is created with all columns, swimlanes, labels, and cards

Each template also has a `.csv` version containing a flat card summary without
movement history — useful for spreadsheet review.

## What is included

Every sample board includes:

- **10+ swimlanes** with theme-appropriate names, colors, and contact info
- **110+ cards** distributed across columns and swimlanes with realistic titles
- **Movement history** — cards show a full progression through the pipeline,
  including stage skips and backtracks, so the analytics heatmap and dwell-time
  charts are populated immediately
- **Activity records** — label changes, priority changes, assignee updates,
  checklist modifications, and comments
- **Labels, checklists, and due dates** on most cards
- **Done columns marked with `is_done`** — analytics correctly exclude
  completed work from dwell-time calculations

## Regenerating templates

The sample board files are generated from scripts in `backend/boards/seed_data/`.
After modifying the scripts, regenerate by running:

```bash
# Regenerate the 10 template boards (no database required)
python3 backend/boards/seed_data/generate_seed_data.py

# Regenerate the demo board (requires Django + running database)
cd backend
python manage.py seed_demo_data --wipe --export --force
```

Both commands write output to the `sample-boards/` directory.
