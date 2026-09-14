"""Data migration: reconcile BoardTemplate.columns_json with what board
creation has actually been applying via the (now-retired) BOARD_TEMPLATES
dict, and add the `is_done` flag the table has never carried (#1115).

Until this release, board creation applied templates from a separate
BOARD_TEMPLATES dict in boards/templates.py, while this table only backed
the read-only GET /boards/templates/ list. The two drifted:

  - "project_delivery" here has 6 columns; the dict (and therefore every
    board actually created with this template) has always produced 7,
    ending in a "Done" column.
  - "legal_compliance" here ends in a column named "Archived"; the dict (and
    therefore every board actually created with this template) has always
    named it "Closed".
  - No row here has ever carried `is_done` on any column; the dict has, for
    the templates' natural terminal columns (e.g. "Closed Won", "Verified"),
    and that data DID reach real boards via the dict-based code path.

This migration is a one-time correction, not an ongoing policy: it hardcodes
its own literal column data (rather than importing the live
boards.templates module) so a future edit to that module can never silently
change what an already-applied migration does — the same reason 0023 and
0029 hardcode their own literals instead of importing anything. Going
forward, boards.template_sync.sync_board_templates() (run at every migrate
via BoardsConfig.ready()'s post_migrate hook) only *inserts* missing rows;
it never updates an existing one, so no future release will silently rewrite
these columns again without an equally explicit migration.

Scope: this only changes the BoardTemplate rows used for *future* board
creations and for the list endpoint's preview. Templates are applied once at
board-creation time (see boards/models.py:BoardTemplate docstring) and there
is no FK from Board back to BoardTemplate, so no existing board or column is
touched.
"""
from django.db import migrations

# Full corrected columns_json per slug that actually changes (name/order
# fixes plus is_done). Only project_delivery and legal_compliance need a
# name/count fix; every slug gets its is_done additions here for the same
# reason — this is the only place that data has ever been written.
NEW_COLUMNS = {
    "sales_pipeline": [
        {"name": "Prospect",      "color": "#6B7280", "position": 0},
        {"name": "Qualified",     "color": "#3B82F6", "position": 1},
        {"name": "Discovery",     "color": "#8B5CF6", "position": 2},
        {"name": "Demo",          "color": "#F59E0B", "position": 3},
        {"name": "Proposal Sent", "color": "#F97316", "position": 4},
        {"name": "Negotiation",   "color": "#EF4444", "position": 5},
        {"name": "Closed Won",    "color": "#10B981", "position": 6, "is_done": True},
        {"name": "Closed Lost",   "color": "#9CA3AF", "position": 7, "is_done": True},
    ],
    "customer_support": [
        {"name": "New",               "color": "#6B7280", "position": 0},
        {"name": "Triaged",           "color": "#3B82F6", "position": 1},
        {"name": "Investigating",     "color": "#F59E0B", "position": 2},
        {"name": "Awaiting Customer", "color": "#F97316", "position": 3},
        {"name": "Escalated",         "color": "#EF4444", "position": 4},
        {"name": "Resolved",          "color": "#10B981", "position": 5, "is_done": True},
        {"name": "Closed",            "color": "#9CA3AF", "position": 6, "is_done": True},
    ],
    "customer_success": [
        {"name": "Onboarding", "color": "#3B82F6", "position": 0},
        {"name": "Adoption",   "color": "#8B5CF6", "position": 1},
        {"name": "Healthy",    "color": "#10B981", "position": 2},
        {"name": "Expansion",  "color": "#F59E0B", "position": 3},
        {"name": "Renewal",    "color": "#F97316", "position": 4},
        {"name": "Churned",    "color": "#EF4444", "position": 5, "is_done": True},
    ],
    "simple_kanban": [
        {"name": "Backlog", "color": "#6B7280", "position": 0},
        {"name": "To Do",   "color": "#3B82F6", "position": 1},
        {"name": "Doing",   "color": "#F59E0B", "position": 2},
        {"name": "Review",  "color": "#8B5CF6", "position": 3},
        {"name": "Done",    "color": "#10B981", "position": 4, "is_done": True},
    ],
    "product_roadmap": [
        {"name": "Idea",        "color": "#8B5CF6", "position": 0},
        {"name": "Validated",   "color": "#6B7280", "position": 1},
        {"name": "Scoped",      "color": "#3B82F6", "position": 2},
        {"name": "Prioritized", "color": "#F97316", "position": 3},
        {"name": "In Build",    "color": "#F59E0B", "position": 4},
        {"name": "Beta",        "color": "#EC4899", "position": 5},
        {"name": "Launched",    "color": "#10B981", "position": 6, "is_done": True},
        {"name": "Monitoring",  "color": "#14B8A6", "position": 7},
    ],
    "project_delivery": [
        {"name": "Planning",         "color": "#6B7280", "position": 0},
        {"name": "Kickoff",          "color": "#3B82F6", "position": 1},
        {"name": "Execution",        "color": "#F59E0B", "position": 2},
        {"name": "Milestone Review", "color": "#8B5CF6", "position": 3},
        {"name": "Wrap-up",          "color": "#F97316", "position": 4},
        {"name": "Retro",            "color": "#14B8A6", "position": 5},
        {"name": "Done",             "color": "#10B981", "position": 6, "is_done": True},
    ],
    "content_production": [
        {"name": "Idea",             "color": "#8B5CF6", "position": 0},
        {"name": "Assigned",         "color": "#3B82F6", "position": 1},
        {"name": "Draft",            "color": "#F59E0B", "position": 2},
        {"name": "Internal Review",  "color": "#F97316", "position": 3},
        {"name": "Edits",            "color": "#EF4444", "position": 4},
        {"name": "Final Approval",   "color": "#EC4899", "position": 5},
        {"name": "Scheduled",        "color": "#14B8A6", "position": 6},
        {"name": "Published",        "color": "#10B981", "position": 7, "is_done": True},
    ],
    "hiring_recruiting": [
        {"name": "Applied",           "color": "#6B7280", "position": 0},
        {"name": "Phone Screen",      "color": "#3B82F6", "position": 1},
        {"name": "Technical Screen",  "color": "#8B5CF6", "position": 2},
        {"name": "Interview",         "color": "#F59E0B", "position": 3},
        {"name": "Reference Check",   "color": "#F97316", "position": 4},
        {"name": "Offer Extended",    "color": "#EC4899", "position": 5},
        {"name": "Hired",             "color": "#10B981", "position": 6, "is_done": True},
        {"name": "Rejected",          "color": "#9CA3AF", "position": 7, "is_done": True},
    ],
    "legal_compliance": [
        {"name": "Submitted",           "color": "#6B7280", "position": 0},
        {"name": "Under Review",        "color": "#3B82F6", "position": 1},
        {"name": "Needs Clarification", "color": "#F97316", "position": 2},
        {"name": "Approved",            "color": "#10B981", "position": 3, "is_done": True},
        {"name": "Denied",              "color": "#EF4444", "position": 4, "is_done": True},
        {"name": "Closed",              "color": "#9CA3AF", "position": 5, "is_done": True},
    ],
    "infra_devops": [
        {"name": "Reported",      "color": "#6B7280", "position": 0},
        {"name": "Triaged",       "color": "#3B82F6", "position": 1},
        {"name": "Assigned",      "color": "#8B5CF6", "position": 2},
        {"name": "In Progress",   "color": "#F59E0B", "position": 3},
        {"name": "Testing",       "color": "#F97316", "position": 4},
        {"name": "Change Window", "color": "#EC4899", "position": 5},
        {"name": "Deployed",      "color": "#14B8A6", "position": 6},
        {"name": "Verified",      "color": "#10B981", "position": 7, "is_done": True},
    ],
}

# Pre-migration values, for the reverse migration — exactly what 0023/0029
# left in the table (no is_done anywhere; project_delivery missing "Done";
# legal_compliance ending in "Archived").
OLD_COLUMNS = {
    "sales_pipeline": [
        {"name": "Prospect",      "color": "#6B7280", "position": 0},
        {"name": "Qualified",     "color": "#3B82F6", "position": 1},
        {"name": "Discovery",     "color": "#8B5CF6", "position": 2},
        {"name": "Demo",          "color": "#F59E0B", "position": 3},
        {"name": "Proposal Sent", "color": "#F97316", "position": 4},
        {"name": "Negotiation",   "color": "#EF4444", "position": 5},
        {"name": "Closed Won",    "color": "#10B981", "position": 6},
        {"name": "Closed Lost",   "color": "#9CA3AF", "position": 7},
    ],
    "customer_support": [
        {"name": "New",               "color": "#6B7280", "position": 0},
        {"name": "Triaged",           "color": "#3B82F6", "position": 1},
        {"name": "Investigating",     "color": "#F59E0B", "position": 2},
        {"name": "Awaiting Customer", "color": "#F97316", "position": 3},
        {"name": "Escalated",         "color": "#EF4444", "position": 4},
        {"name": "Resolved",          "color": "#10B981", "position": 5},
        {"name": "Closed",            "color": "#9CA3AF", "position": 6},
    ],
    "customer_success": [
        {"name": "Onboarding", "color": "#3B82F6", "position": 0},
        {"name": "Adoption",   "color": "#8B5CF6", "position": 1},
        {"name": "Healthy",    "color": "#10B981", "position": 2},
        {"name": "Expansion",  "color": "#F59E0B", "position": 3},
        {"name": "Renewal",    "color": "#F97316", "position": 4},
        {"name": "Churned",    "color": "#EF4444", "position": 5},
    ],
    "simple_kanban": [
        {"name": "Backlog", "color": "#6B7280", "position": 0},
        {"name": "To Do",   "color": "#3B82F6", "position": 1},
        {"name": "Doing",   "color": "#F59E0B", "position": 2},
        {"name": "Review",  "color": "#8B5CF6", "position": 3},
        {"name": "Done",    "color": "#10B981", "position": 4},
    ],
    "product_roadmap": [
        {"name": "Idea",        "color": "#8B5CF6", "position": 0},
        {"name": "Validated",   "color": "#6B7280", "position": 1},
        {"name": "Scoped",      "color": "#3B82F6", "position": 2},
        {"name": "Prioritized", "color": "#F97316", "position": 3},
        {"name": "In Build",    "color": "#F59E0B", "position": 4},
        {"name": "Beta",        "color": "#EC4899", "position": 5},
        {"name": "Launched",    "color": "#10B981", "position": 6},
        {"name": "Monitoring",  "color": "#14B8A6", "position": 7},
    ],
    "project_delivery": [
        {"name": "Planning",         "color": "#6B7280", "position": 0},
        {"name": "Kickoff",          "color": "#3B82F6", "position": 1},
        {"name": "Execution",        "color": "#F59E0B", "position": 2},
        {"name": "Milestone Review", "color": "#8B5CF6", "position": 3},
        {"name": "Wrap-up",          "color": "#F97316", "position": 4},
        {"name": "Retro",            "color": "#14B8A6", "position": 5},
    ],
    "content_production": [
        {"name": "Idea",             "color": "#8B5CF6", "position": 0},
        {"name": "Assigned",         "color": "#3B82F6", "position": 1},
        {"name": "Draft",            "color": "#F59E0B", "position": 2},
        {"name": "Internal Review",  "color": "#F97316", "position": 3},
        {"name": "Edits",            "color": "#EF4444", "position": 4},
        {"name": "Final Approval",   "color": "#EC4899", "position": 5},
        {"name": "Scheduled",        "color": "#14B8A6", "position": 6},
        {"name": "Published",        "color": "#10B981", "position": 7},
    ],
    "hiring_recruiting": [
        {"name": "Applied",           "color": "#6B7280", "position": 0},
        {"name": "Phone Screen",      "color": "#3B82F6", "position": 1},
        {"name": "Technical Screen",  "color": "#8B5CF6", "position": 2},
        {"name": "Interview",         "color": "#F59E0B", "position": 3},
        {"name": "Reference Check",   "color": "#F97316", "position": 4},
        {"name": "Offer Extended",    "color": "#EC4899", "position": 5},
        {"name": "Hired",             "color": "#10B981", "position": 6},
        {"name": "Rejected",          "color": "#9CA3AF", "position": 7},
    ],
    "legal_compliance": [
        {"name": "Submitted",           "color": "#6B7280", "position": 0},
        {"name": "Under Review",        "color": "#3B82F6", "position": 1},
        {"name": "Needs Clarification", "color": "#F97316", "position": 2},
        {"name": "Approved",            "color": "#10B981", "position": 3},
        {"name": "Denied",              "color": "#EF4444", "position": 4},
        {"name": "Archived",            "color": "#9CA3AF", "position": 5},
    ],
    "infra_devops": [
        {"name": "Reported",      "color": "#6B7280", "position": 0},
        {"name": "Triaged",       "color": "#3B82F6", "position": 1},
        {"name": "Assigned",      "color": "#8B5CF6", "position": 2},
        {"name": "In Progress",   "color": "#F59E0B", "position": 3},
        {"name": "Testing",       "color": "#F97316", "position": 4},
        {"name": "Change Window", "color": "#EC4899", "position": 5},
        {"name": "Deployed",      "color": "#14B8A6", "position": 6},
        {"name": "Verified",      "color": "#10B981", "position": 7},
    ],
}


def fix_columns(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    for slug, columns_json in NEW_COLUMNS.items():
        BoardTemplate.objects.filter(slug=slug).update(columns_json=columns_json)


def unfix_columns(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    for slug, columns_json in OLD_COLUMNS.items():
        BoardTemplate.objects.filter(slug=slug).update(columns_json=columns_json)


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0052_board_show_wip_at_limit"),
    ]

    operations = [
        migrations.RunPython(fix_columns, unfix_columns),
    ]
