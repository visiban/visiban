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
            {"name": "Prospect",      "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Qualified",     "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Discovery",     "color": "#8B5CF6", "position": 2, "allow_card_creation": False},
            {"name": "Demo",          "color": "#F59E0B", "position": 3, "allow_card_creation": False},
            {"name": "Proposal Sent", "color": "#F97316", "position": 4, "allow_card_creation": False},
            {"name": "Negotiation",   "color": "#EF4444", "position": 5, "allow_card_creation": False},
            {"name": "Closed Won",    "color": "#10B981", "position": 6, "allow_card_creation": False, "is_done": True},
            {"name": "Closed Lost",   "color": "#9CA3AF", "position": 7, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,  # user supplies the name via the modal prompt
    },
    "customer_support": {
        "columns": [
            {"name": "New",               "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Triaged",           "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Investigating",     "color": "#F59E0B", "position": 2, "allow_card_creation": False},
            {"name": "Awaiting Customer", "color": "#F97316", "position": 3, "allow_card_creation": False},
            {"name": "Escalated",         "color": "#EF4444", "position": 4, "allow_card_creation": False},
            {"name": "Resolved",          "color": "#10B981", "position": 5, "allow_card_creation": False, "is_done": True},
            {"name": "Closed",            "color": "#9CA3AF", "position": 6, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Customer",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,
    },
    "customer_success": {
        "columns": [
            {"name": "Onboarding", "color": "#3B82F6", "position": 0, "allow_card_creation": True},
            {"name": "Adoption",   "color": "#8B5CF6", "position": 1, "allow_card_creation": False},
            {"name": "Healthy",    "color": "#10B981", "position": 2, "allow_card_creation": False},
            {"name": "Expansion",  "color": "#F59E0B", "position": 3, "allow_card_creation": False},
            {"name": "Renewal",    "color": "#F97316", "position": 4, "allow_card_creation": False},
            {"name": "Churned",    "color": "#EF4444", "position": 5, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Account",
        "lane_placeholder": "e.g. Acme Corp",
        "default_swimlane": None,
    },
    "simple_kanban": {
        "columns": [
            {"name": "Backlog", "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "To Do",   "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Doing",   "color": "#F59E0B", "position": 2, "allow_card_creation": False},
            {"name": "Review",  "color": "#8B5CF6", "position": 3, "allow_card_creation": False},
            {"name": "Done",    "color": "#10B981", "position": 4, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Team",
        "lane_placeholder": "e.g. Engineering",
        "default_swimlane": None,
    },
    "product_roadmap": {
        "columns": [
            {"name": "Idea",       "color": "#8B5CF6", "position": 0, "allow_card_creation": True},
            {"name": "Validated",  "color": "#6B7280", "position": 1, "allow_card_creation": False},
            {"name": "Scoped",     "color": "#3B82F6", "position": 2, "allow_card_creation": False},
            {"name": "Prioritized","color": "#F97316", "position": 3, "allow_card_creation": False},
            {"name": "In Build",   "color": "#F59E0B", "position": 4, "allow_card_creation": False},
            {"name": "Beta",       "color": "#EC4899", "position": 5, "allow_card_creation": False},
            {"name": "Launched",   "color": "#10B981", "position": 6, "allow_card_creation": False, "is_done": True},
            {"name": "Monitoring", "color": "#14B8A6", "position": 7, "allow_card_creation": False},  # Monitoring is intentionally not is_done — cards here are under observation, not complete
        ],
        "lane_label": "Product Line",
        "lane_placeholder": "e.g. Mobile App",
        "default_swimlane": None,
    },
    "project_delivery": {
        "columns": [
            {"name": "Planning",         "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Kickoff",          "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Execution",        "color": "#F59E0B", "position": 2, "allow_card_creation": False},
            {"name": "Milestone Review", "color": "#8B5CF6", "position": 3, "allow_card_creation": False},
            {"name": "Wrap-up",          "color": "#F97316", "position": 4, "allow_card_creation": False},
            {"name": "Retro",            "color": "#14B8A6", "position": 5, "allow_card_creation": False},
            {"name": "Done",             "color": "#10B981", "position": 6, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Project",
        "lane_placeholder": "e.g. Website Relaunch",
        "default_swimlane": None,
    },
    "content_production": {
        "columns": [
            {"name": "Idea",             "color": "#8B5CF6", "position": 0, "allow_card_creation": True},
            {"name": "Assigned",         "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Draft",            "color": "#F59E0B", "position": 2, "allow_card_creation": False},
            {"name": "Internal Review",  "color": "#F97316", "position": 3, "allow_card_creation": False},
            {"name": "Edits",            "color": "#EF4444", "position": 4, "allow_card_creation": False},
            {"name": "Final Approval",   "color": "#EC4899", "position": 5, "allow_card_creation": False},
            {"name": "Scheduled",        "color": "#14B8A6", "position": 6, "allow_card_creation": False},
            {"name": "Published",        "color": "#10B981", "position": 7, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Content Type",
        "lane_placeholder": "e.g. Blog Posts",
        "default_swimlane": None,
    },
    "hiring_recruiting": {
        "columns": [
            {"name": "Applied",           "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Phone Screen",      "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Technical Screen",  "color": "#8B5CF6", "position": 2, "allow_card_creation": False},
            {"name": "Interview",         "color": "#F59E0B", "position": 3, "allow_card_creation": False},
            {"name": "Reference Check",   "color": "#F97316", "position": 4, "allow_card_creation": False},
            {"name": "Offer Extended",    "color": "#EC4899", "position": 5, "allow_card_creation": False},
            {"name": "Hired",             "color": "#10B981", "position": 6, "allow_card_creation": False, "is_done": True},
            {"name": "Rejected",          "color": "#9CA3AF", "position": 7, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Role",
        "lane_placeholder": "e.g. Senior Engineer",
        "default_swimlane": None,
    },
    "legal_compliance": {
        "columns": [
            {"name": "Submitted",          "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Under Review",       "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Needs Clarification","color": "#F97316", "position": 2, "allow_card_creation": False},
            {"name": "Approved",           "color": "#10B981", "position": 3, "allow_card_creation": False, "is_done": True},
            {"name": "Denied",             "color": "#EF4444", "position": 4, "allow_card_creation": False, "is_done": True},
            {"name": "Closed",             "color": "#9CA3AF", "position": 5, "allow_card_creation": False, "is_done": True},
        ],
        "lane_label": "Department",
        "lane_placeholder": "e.g. Finance",
        "default_swimlane": None,
    },
    "infra_devops": {
        "columns": [
            {"name": "Reported",      "color": "#6B7280", "position": 0, "allow_card_creation": True},
            {"name": "Triaged",       "color": "#3B82F6", "position": 1, "allow_card_creation": False},
            {"name": "Assigned",      "color": "#8B5CF6", "position": 2, "allow_card_creation": False},
            {"name": "In Progress",   "color": "#F59E0B", "position": 3, "allow_card_creation": False},
            {"name": "Testing",       "color": "#F97316", "position": 4, "allow_card_creation": False},
            {"name": "Change Window", "color": "#EC4899", "position": 5, "allow_card_creation": False},
            {"name": "Deployed",      "color": "#14B8A6", "position": 6, "allow_card_creation": False},
            {"name": "Verified",      "color": "#10B981", "position": 7, "allow_card_creation": False, "is_done": True},
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
