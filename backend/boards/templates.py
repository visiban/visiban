# Static board template definitions.
# These constants are used by:
#   1. board creation (BoardViewSet.perform_create) to apply columns/swimlane
#   2. data migrations that seed the BoardTemplate table
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
            {"name": "Prospect",      "color": "#6B7280", "position": 0},
            {"name": "Qualified",     "color": "#3B82F6", "position": 1},
            {"name": "Discovery",     "color": "#8B5CF6", "position": 2},
            {"name": "Demo",          "color": "#F59E0B", "position": 3},
            {"name": "Proposal Sent", "color": "#F97316", "position": 4},
            {"name": "Negotiation",   "color": "#EF4444", "position": 5},
            {"name": "Closed Won",    "color": "#10B981", "position": 6, "is_done": True},
            {"name": "Closed Lost",   "color": "#9CA3AF", "position": 7, "is_done": True},
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
            {"name": "Escalated",         "color": "#EF4444", "position": 4},
            {"name": "Resolved",          "color": "#10B981", "position": 5, "is_done": True},
            {"name": "Closed",            "color": "#9CA3AF", "position": 6, "is_done": True},
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
            {"name": "Churned",    "color": "#EF4444", "position": 5, "is_done": True},
        ],
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,
    },
    "simple_kanban": {
        "columns": [
            {"name": "Backlog", "color": "#6B7280", "position": 0},
            {"name": "To Do",   "color": "#3B82F6", "position": 1},
            {"name": "Doing",   "color": "#F59E0B", "position": 2},
            {"name": "Review",  "color": "#8B5CF6", "position": 3},
            {"name": "Done",    "color": "#10B981", "position": 4, "is_done": True},
        ],
        "lane_label": "Team",
        "lane_placeholder": "e.g. Engineering",
        "default_swimlane": None,
    },
    "product_roadmap": {
        "columns": [
            {"name": "Idea",       "color": "#8B5CF6", "position": 0},
            {"name": "Validated",  "color": "#6B7280", "position": 1},
            {"name": "Scoped",     "color": "#3B82F6", "position": 2},
            {"name": "Prioritized","color": "#F97316", "position": 3},
            {"name": "In Build",   "color": "#F59E0B", "position": 4},
            {"name": "Beta",       "color": "#EC4899", "position": 5},
            {"name": "Launched",   "color": "#10B981", "position": 6, "is_done": True},
            {"name": "Monitoring", "color": "#14B8A6", "position": 7},
        ],
        "lane_label": "Product Line",
        "lane_placeholder": "e.g. Mobile App",
        "default_swimlane": None,
    },
    "project_delivery": {
        "columns": [
            {"name": "Planning",         "color": "#6B7280", "position": 0},
            {"name": "Kickoff",          "color": "#3B82F6", "position": 1},
            {"name": "Execution",        "color": "#F59E0B", "position": 2},
            {"name": "Milestone Review", "color": "#8B5CF6", "position": 3},
            {"name": "Wrap-up",          "color": "#F97316", "position": 4},
            {"name": "Retro",            "color": "#10B981", "position": 5, "is_done": True},
        ],
        "lane_label": "Project",
        "lane_placeholder": "e.g. Website Relaunch",
        "default_swimlane": None,
    },
    "content_production": {
        "columns": [
            {"name": "Idea",             "color": "#8B5CF6", "position": 0},
            {"name": "Assigned",         "color": "#3B82F6", "position": 1},
            {"name": "Draft",            "color": "#F59E0B", "position": 2},
            {"name": "Internal Review",  "color": "#F97316", "position": 3},
            {"name": "Edits",            "color": "#EF4444", "position": 4},
            {"name": "Final Approval",   "color": "#EC4899", "position": 5},
            {"name": "Scheduled",        "color": "#14B8A6", "position": 6},
            {"name": "Published",        "color": "#10B981", "position": 7, "is_done": True},
        ],
        "lane_label": "Content Type",
        "lane_placeholder": "e.g. Blog Posts",
        "default_swimlane": None,
    },
    "hiring_recruiting": {
        "columns": [
            {"name": "Applied",           "color": "#6B7280", "position": 0},
            {"name": "Phone Screen",      "color": "#3B82F6", "position": 1},
            {"name": "Technical Screen",  "color": "#8B5CF6", "position": 2},
            {"name": "Interview",         "color": "#F59E0B", "position": 3},
            {"name": "Reference Check",   "color": "#F97316", "position": 4},
            {"name": "Offer Extended",    "color": "#EC4899", "position": 5},
            {"name": "Hired",             "color": "#10B981", "position": 6, "is_done": True},
            {"name": "Rejected",          "color": "#9CA3AF", "position": 7, "is_done": True},
        ],
        "lane_label": "Role",
        "lane_placeholder": "e.g. Senior Engineer",
        "default_swimlane": None,
    },
    "legal_compliance": {
        "columns": [
            {"name": "Submitted",          "color": "#6B7280", "position": 0},
            {"name": "Under Review",       "color": "#3B82F6", "position": 1},
            {"name": "Needs Clarification","color": "#F97316", "position": 2},
            {"name": "Approved",           "color": "#10B981", "position": 3, "is_done": True},
            {"name": "Denied",             "color": "#EF4444", "position": 4, "is_done": True},
            {"name": "Archived",           "color": "#9CA3AF", "position": 5, "is_done": True},
        ],
        "lane_label": "Department",
        "lane_placeholder": "e.g. Finance",
        "default_swimlane": None,
    },
    "infra_devops": {
        "columns": [
            {"name": "Reported",      "color": "#6B7280", "position": 0},
            {"name": "Triaged",       "color": "#3B82F6", "position": 1},
            {"name": "Assigned",      "color": "#8B5CF6", "position": 2},
            {"name": "In Progress",   "color": "#F59E0B", "position": 3},
            {"name": "Testing",       "color": "#F97316", "position": 4},
            {"name": "Change Window", "color": "#EC4899", "position": 5},
            {"name": "Deployed",      "color": "#14B8A6", "position": 6},
            {"name": "Verified",      "color": "#10B981", "position": 7, "is_done": True},
        ],
        "lane_label": "Service",
        "lane_placeholder": "e.g. API Gateway",
        "default_swimlane": None,
    },
    "blank": {
        "columns": [],
        "lane_label": "",
        "lane_placeholder": "e.g. General",
        "default_swimlane": None,
    },
}
