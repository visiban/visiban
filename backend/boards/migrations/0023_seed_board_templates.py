"""Data migration: seed the 7 canonical BoardTemplate rows.

Slugs are stable identifiers used by BoardViewSet.perform_create to look up
the template. If a template with a given slug already exists (e.g. from a
partial forward migration) it is left unchanged so the migration is idempotent.
"""
import uuid
from django.db import migrations


# Icon values are kept short (≤ 32 chars) as per the model field definition.
TEMPLATES = [
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000001"),
        "name": "Sales Pipeline",
        "slug": "sales_pipeline",
        "description": "Track deals per account from lead to close",
        "icon": "chart-up",
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "columns_json": [
            {"name": "Lead",          "color": "#6B7280", "position": 0},
            {"name": "Qualified",     "color": "#3B82F6", "position": 1},
            {"name": "Proposal Sent", "color": "#F59E0B", "position": 2},
            {"name": "Negotiation",   "color": "#F97316", "position": 3},
            {"name": "Closed Won",    "color": "#10B981", "position": 4},
            {"name": "Closed Lost",   "color": "#9CA3AF", "position": 5},
        ],
        "sort_order": 10,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000002"),
        "name": "Customer Support",
        "slug": "customer_support",
        "description": "Manage support tickets per customer",
        "icon": "headset",
        "lane_label": "Customer",
        "lane_placeholder": "e.g. Acme Corp",
        "columns_json": [
            {"name": "New",               "color": "#6B7280", "position": 0},
            {"name": "Triaged",           "color": "#3B82F6", "position": 1},
            {"name": "Investigating",     "color": "#F59E0B", "position": 2},
            {"name": "Awaiting Customer", "color": "#F97316", "position": 3},
            {"name": "Resolved",          "color": "#10B981", "position": 4},
            {"name": "Closed",            "color": "#9CA3AF", "position": 5},
        ],
        "sort_order": 20,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000003"),
        "name": "Customer Success",
        "slug": "customer_success",
        "description": "Track health and growth of every account",
        "icon": "star",
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "columns_json": [
            {"name": "Onboarding", "color": "#3B82F6", "position": 0},
            {"name": "Adoption",   "color": "#8B5CF6", "position": 1},
            {"name": "Healthy",    "color": "#10B981", "position": 2},
            {"name": "Expansion",  "color": "#F59E0B", "position": 3},
            {"name": "Renewal",    "color": "#F97316", "position": 4},
            {"name": "Churned",    "color": "#EF4444", "position": 5},
        ],
        "sort_order": 30,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000004"),
        "name": "Simple Kanban",
        "slug": "simple_kanban",
        "description": "General task tracking for any team",
        "icon": "columns",
        "lane_label": "Team",
        "lane_placeholder": "e.g. Engineering",
        "columns_json": [
            {"name": "Backlog",     "color": "#6B7280", "position": 0},
            {"name": "To Do",       "color": "#3B82F6", "position": 1},
            {"name": "In Progress", "color": "#F59E0B", "position": 2},
            {"name": "In Review",   "color": "#8B5CF6", "position": 3},
            {"name": "Done",        "color": "#10B981", "position": 4},
        ],
        "sort_order": 40,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000005"),
        "name": "Product Roadmap",
        "slug": "product_roadmap",
        "description": "Feature delivery from idea to GA per product line",
        "icon": "roadmap",
        "lane_label": "Product Line",
        "lane_placeholder": "e.g. Mobile App",
        "columns_json": [
            {"name": "Idea",       "color": "#8B5CF6", "position": 0},
            {"name": "Scored",     "color": "#6B7280", "position": 1},
            {"name": "Roadmapped", "color": "#3B82F6", "position": 2},
            {"name": "In Dev",     "color": "#F59E0B", "position": 3},
            {"name": "Beta/QA",    "color": "#F97316", "position": 4},
            {"name": "GA",         "color": "#10B981", "position": 5},
        ],
        "sort_order": 50,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000006"),
        "name": "Project Delivery",
        "slug": "project_delivery",
        "description": "End-to-end delivery lifecycle per project",
        "icon": "clipboard",
        "lane_label": "Project",
        "lane_placeholder": "e.g. Website Relaunch",
        "columns_json": [
            {"name": "Planning",         "color": "#6B7280", "position": 0},
            {"name": "Kickoff",          "color": "#3B82F6", "position": 1},
            {"name": "Execution",        "color": "#F59E0B", "position": 2},
            {"name": "Milestone Review", "color": "#8B5CF6", "position": 3},
            {"name": "Wrap-up",          "color": "#F97316", "position": 4},
            {"name": "Retro",            "color": "#10B981", "position": 5},
        ],
        "sort_order": 60,
        "is_active": True,
    },
    {
        "id": uuid.UUID("00000001-0000-0000-0000-000000000007"),
        "name": "Blank Board",
        "slug": "blank",
        "description": "Start empty and add columns and swimlanes yourself",
        "icon": "blank",
        "lane_label": "",
        "lane_placeholder": "e.g. General",
        "columns_json": [],
        "sort_order": 70,
        "is_active": True,
    },
]


def seed_templates(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    for data in TEMPLATES:
        BoardTemplate.objects.get_or_create(
            slug=data["slug"],
            defaults=data,
        )


def unseed_templates(apps, schema_editor):
    BoardTemplate = apps.get_model("boards", "BoardTemplate")
    slugs = [t["slug"] for t in TEMPLATES]
    BoardTemplate.objects.filter(slug__in=slugs).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0022_boardtemplate"),
    ]

    operations = [
        migrations.RunPython(seed_templates, unseed_templates),
    ]
