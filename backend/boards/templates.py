# Static board template definitions.
# These constants are used by:
#   1. board creation (BoardViewSet.perform_create) to apply columns/swimlane
#   2. the data migration that seeds the BoardTemplate table
#
# Each entry maps a slug to its column list and first-swimlane metadata.
# Templates are applied once at board creation and have no ongoing effect —
# columns and swimlanes are fully editable afterward.
#
# Column colors use the same hex tokens as the Tailwind palette referenced
# throughout the codebase (slate/blue/amber/green/red/violet/orange).

BOARD_TEMPLATES: dict[str, dict] = {
    "sales_pipeline": {
        "columns": [
            {"name": "Lead",          "color": "#6B7280", "position": 0},
            {"name": "Qualified",     "color": "#3B82F6", "position": 1},
            {"name": "Proposal Sent", "color": "#F59E0B", "position": 2},
            {"name": "Negotiation",   "color": "#F97316", "position": 3},
            {"name": "Closed Won",    "color": "#10B981", "position": 4},
            {"name": "Closed Lost",   "color": "#9CA3AF", "position": 5},
        ],
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,  # user supplies the name via the modal prompt
    },
    "customer_support": {
        "columns": [
            {"name": "New",               "color": "#6B7280", "position": 0},
            {"name": "Triaged",           "color": "#3B82F6", "position": 1},
            {"name": "Investigating",     "color": "#F59E0B", "position": 2},
            {"name": "Awaiting Customer", "color": "#F97316", "position": 3},
            {"name": "Resolved",          "color": "#10B981", "position": 4},
            {"name": "Closed",            "color": "#9CA3AF", "position": 5},
        ],
        "lane_label": "Customer",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,
    },
    "customer_success": {
        "columns": [
            {"name": "Onboarding", "color": "#3B82F6", "position": 0},
            {"name": "Adoption",   "color": "#8B5CF6", "position": 1},
            {"name": "Healthy",    "color": "#10B981", "position": 2},
            {"name": "Expansion",  "color": "#F59E0B", "position": 3},
            {"name": "Renewal",    "color": "#F97316", "position": 4},
            {"name": "Churned",    "color": "#EF4444", "position": 5},
        ],
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,
    },
    "simple_kanban": {
        "columns": [
            {"name": "Backlog",     "color": "#6B7280", "position": 0},
            {"name": "To Do",       "color": "#3B82F6", "position": 1},
            {"name": "In Progress", "color": "#F59E0B", "position": 2},
            {"name": "In Review",   "color": "#8B5CF6", "position": 3},
            {"name": "Done",        "color": "#10B981", "position": 4},
        ],
        "lane_label": "Team",
        "lane_placeholder": "e.g. Engineering",
        "default_swimlane": None,
    },
    "product_roadmap": {
        "columns": [
            {"name": "Idea",       "color": "#8B5CF6", "position": 0},
            {"name": "Scored",     "color": "#6B7280", "position": 1},
            {"name": "Roadmapped", "color": "#3B82F6", "position": 2},
            {"name": "In Dev",     "color": "#F59E0B", "position": 3},
            {"name": "Beta/QA",    "color": "#F97316", "position": 4},
            {"name": "GA",         "color": "#10B981", "position": 5},
        ],
        "lane_label": "Product Line",
        "lane_placeholder": "e.g. Mobile App",
        "default_swimlane": None,
    },
    "project_delivery": {
        "columns": [
            {"name": "Planning",          "color": "#6B7280", "position": 0},
            {"name": "Kickoff",           "color": "#3B82F6", "position": 1},
            {"name": "Execution",         "color": "#F59E0B", "position": 2},
            {"name": "Milestone Review",  "color": "#8B5CF6", "position": 3},
            {"name": "Wrap-up",           "color": "#F97316", "position": 4},
            {"name": "Retro",             "color": "#10B981", "position": 5},
        ],
        "lane_label": "Project",
        "lane_placeholder": "e.g. Website Relaunch",
        "default_swimlane": None,
    },
    "blank": {
        "columns": [],
        "lane_label": "",
        "lane_placeholder": "e.g. General",
        "default_swimlane": None,
    },
}
