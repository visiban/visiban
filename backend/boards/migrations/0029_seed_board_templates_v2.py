"""Data migration: add 4 new board templates and update column structures for
existing templates to reflect the v2 workflow designs.

Existing templates are updated in-place (columns_json only — slug/name/id are
stable). New templates are inserted using the same get_or_create pattern as
0023 so the migration is safe to re-run.

This migration does NOT alter any board that was already created from a
template — templates are applied once at board creation time.
"""
import uuid
from django.db import migrations


NEW_TEMPLATES = [
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000008"),
        "name": "Content Production",
        "slug": "content_production",
        "description": "Manage content pieces from idea to publication",
        "icon": "pencil",
        "lane_label": "Content Type",
        "lane_placeholder": "e.g. Blog Posts",
        "columns_json": [
            {"name": "Idea",            "color": "#8B5CF6", "position": 0},
            {"name": "Assigned",        "color": "#3B82F6", "position": 1},
            {"name": "Draft",           "color": "#F59E0B", "position": 2},
            {"name": "Internal Review", "color": "#F97316", "position": 3},
            {"name": "Edits",           "color": "#EF4444", "position": 4},
            {"name": "Final Approval",  "color": "#EC4899", "position": 5},
            {"name": "Scheduled",       "color": "#14B8A6", "position": 6},
            {"name": "Published",       "color": "#10B981", "position": 7},
        ],
        "sort_order": 65,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000009"),
        "name": "Hiring & Recruiting",
        "slug": "hiring_recruiting",
        "description": "Track candidates from application to hire per role",
        "icon": "users",
        "lane_label": "Role",
        "lane_placeholder": "e.g. Senior Engineer",
        "columns_json": [
            {"name": "Applied",          "color": "#6B7280", "position": 0},
            {"name": "Phone Screen",     "color": "#3B82F6", "position": 1},
            {"name": "Technical Screen", "color": "#8B5CF6", "position": 2},
            {"name": "Interview",        "color": "#F59E0B", "position": 3},
            {"name": "Reference Check",  "color": "#F97316", "position": 4},
            {"name": "Offer Extended",   "color": "#EC4899", "position": 5},
            {"name": "Hired",            "color": "#10B981", "position": 6},
            {"name": "Rejected",         "color": "#9CA3AF", "position": 7},
        ],
        "sort_order": 75,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000010"),
        "name": "Legal & Compliance",
        "slug": "legal_compliance",
        "description": "Track compliance requests and approvals per department",
        "icon": "shield",
        "lane_label": "Department",
        "lane_placeholder": "e.g. Finance",
        "columns_json": [
            {"name": "Submitted",           "color": "#6B7280", "position": 0},
            {"name": "Under Review",        "color": "#3B82F6", "position": 1},
            {"name": "Needs Clarification", "color": "#F97316", "position": 2},
            {"name": "Approved",            "color": "#10B981", "position": 3},
            {"name": "Denied",              "color": "#EF4444", "position": 4},
            {"name": "Archived",            "color": "#9CA3AF", "position": 5},
        ],
        "sort_order": 85,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000011"),
        "name": "Infrastructure & DevOps",
        "slug": "infra_devops",
        "description": "Track incidents and changes per service from report to verified",
        "icon": "server",
        "lane_label": "Service",
        "lane_placeholder": "e.g. API Gateway",
        "columns_json": [
            {"name": "Reported",      "color": "#6B7280", "position": 0},
            {"name": "Triaged",       "color": "#3B82F6", "position": 1},
            {"name": "Assigned",      "color": "#8B5CF6", "position": 2},
            {"name": "In Progress",   "color": "#F59E0B", "position": 3},
            {"name": "Testing",       "color": "#F97316", "position": 4},
            {"name": "Change Window", "color": "#EC4899", "position": 5},
            {"name": "Deployed",      "color": "#14B8A6", "position": 6},
            {"name": "Verified",      "color": "#10B981", "position": 7},
        ],
        "sort_order": 95,
        "is_active": True,
    },
]

# Column updates for existing templates (slug → new columns_json)
UPDATED_COLUMNS = {
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
}


def seed_templates_v2(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    # Add new templates
    for data in NEW_TEMPLATES:
        BoardTemplate.objects.get_or_create(slug=data["slug"], defaults=data)
    # Update column definitions for existing templates
    for slug, columns_json in UPDATED_COLUMNS.items():
        BoardTemplate.objects.filter(slug=slug).update(columns_json=columns_json)


def unseed_templates_v2(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    # Remove new templates
    new_slugs = [t["slug"] for t in NEW_TEMPLATES]
    BoardTemplate.objects.filter(slug__in=new_slugs).delete()
    # Restore original column definitions (from migration 0023)
    original = {
        "sales_pipeline": [
            {"name": "Lead",          "color": "#6B7280", "position": 0},
            {"name": "Qualified",     "color": "#3B82F6", "position": 1},
            {"name": "Proposal Sent", "color": "#F59E0B", "position": 2},
            {"name": "Negotiation",   "color": "#F97316", "position": 3},
            {"name": "Closed Won",    "color": "#10B981", "position": 4},
            {"name": "Closed Lost",   "color": "#9CA3AF", "position": 5},
        ],
        "customer_support": [
            {"name": "New",               "color": "#6B7280", "position": 0},
            {"name": "Triaged",           "color": "#3B82F6", "position": 1},
            {"name": "Investigating",     "color": "#F59E0B", "position": 2},
            {"name": "Awaiting Customer", "color": "#F97316", "position": 3},
            {"name": "Resolved",          "color": "#10B981", "position": 4},
            {"name": "Closed",            "color": "#9CA3AF", "position": 5},
        ],
        "simple_kanban": [
            {"name": "Backlog",     "color": "#6B7280", "position": 0},
            {"name": "To Do",       "color": "#3B82F6", "position": 1},
            {"name": "In Progress", "color": "#F59E0B", "position": 2},
            {"name": "In Review",   "color": "#8B5CF6", "position": 3},
            {"name": "Done",        "color": "#10B981", "position": 4},
        ],
        "product_roadmap": [
            {"name": "Idea",       "color": "#8B5CF6", "position": 0},
            {"name": "Scored",     "color": "#6B7280", "position": 1},
            {"name": "Roadmapped", "color": "#3B82F6", "position": 2},
            {"name": "In Dev",     "color": "#F59E0B", "position": 3},
            {"name": "Beta/QA",    "color": "#F97316", "position": 4},
            {"name": "GA",         "color": "#10B981", "position": 5},
        ],
    }
    for slug, columns_json in original.items():
        BoardTemplate.objects.filter(slug=slug).update(columns_json=columns_json)


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0028_alter_board_enforce_defaults"),
    ]

    operations = [
        migrations.RunPython(seed_templates_v2, unseed_templates_v2),
    ]
