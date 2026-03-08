# Static board template definitions.
# No database model — templates are applied once at board creation and have
# no ongoing effect. Columns and swimlanes are fully editable afterward.

BOARD_TEMPLATES: dict[str, dict] = {
    "simple_kanban": {
        "columns": [
            {"name": "Backlog",  "color": "#6B7280"},
            {"name": "To Do",    "color": "#3B82F6"},
            {"name": "Doing",    "color": "#F59E0B"},
            {"name": "Done",     "color": "#10B981"},
        ],
        "default_swimlane": "General",
    },
    "sales_pipeline": {
        "columns": [
            {"name": "Lead",          "color": "#6B7280"},
            {"name": "Qualified",     "color": "#3B82F6"},
            {"name": "Proposal Sent", "color": "#F59E0B"},
            {"name": "Negotiation",   "color": "#EF4444"},
            {"name": "Closed Won",    "color": "#10B981"},
            {"name": "Closed Lost",   "color": "#9CA3AF"},
        ],
        "default_swimlane": "New Prospect",
    },
    "bug_tracker": {
        "columns": [
            {"name": "Reported",    "color": "#EF4444"},
            {"name": "Triaged",     "color": "#F59E0B"},
            {"name": "In Progress", "color": "#3B82F6"},
            {"name": "In Review",   "color": "#8B5CF6"},
            {"name": "Resolved",    "color": "#10B981"},
            {"name": "Closed",      "color": "#6B7280"},
        ],
        "default_swimlane": "General",
    },
    "product_roadmap": {
        "columns": [
            {"name": "Ideas",       "color": "#8B5CF6"},
            {"name": "Backlog",     "color": "#6B7280"},
            {"name": "In Progress", "color": "#3B82F6"},
            {"name": "In Review",   "color": "#F59E0B"},
            {"name": "Shipped",     "color": "#10B981"},
        ],
        "default_swimlane": "General",
    },
    "hiring_pipeline": {
        "columns": [
            {"name": "Applied",      "color": "#6B7280"},
            {"name": "Phone Screen", "color": "#3B82F6"},
            {"name": "Interview",    "color": "#F59E0B"},
            {"name": "Offer Sent",   "color": "#8B5CF6"},
            {"name": "Hired",        "color": "#10B981"},
        ],
        "default_swimlane": "New Role",
    },
    "customer_onboarding": {
        "columns": [
            {"name": "Signed",         "color": "#3B82F6"},
            {"name": "Kickoff",        "color": "#8B5CF6"},
            {"name": "Implementation", "color": "#F59E0B"},
            {"name": "Training",       "color": "#F97316"},
            {"name": "Go Live",        "color": "#EF4444"},
            {"name": "Complete",       "color": "#10B981"},
        ],
        "default_swimlane": "New Customer",
    },
    "content_pipeline": {
        "columns": [
            {"name": "Ideas",     "color": "#8B5CF6"},
            {"name": "Drafting",  "color": "#3B82F6"},
            {"name": "Review",    "color": "#F59E0B"},
            {"name": "Approved",  "color": "#10B981"},
            {"name": "Scheduled", "color": "#F97316"},
            {"name": "Published", "color": "#6B7280"},
        ],
        "default_swimlane": "New Author",
    },
    "blank": {
        "columns": [],
        "default_swimlane": None,
    },
}
