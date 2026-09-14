# Built-in board template seed data.
#
# This is seed data only (#1115) — it is no longer read directly by
# board-creation code. It is consumed by:
#   1. boards.template_sync.sync_board_templates(), which inserts these as
#      BoardTemplate rows (insert-only — see that module for the conflict
#      policy) at every `migrate`.
#   2. boards/migrations/0023_seed_board_templates.py and
#      0029_seed_board_templates_v2.py, which independently seeded the table
#      before this module's role was formalized (they inline their own
#      literal copies rather than importing this module, per the usual
#      "don't import live app code into a historical migration" rule).
#
# BoardViewSet.perform_create, GroupViewSet.boards(), and
# BoardTemplateListView all read the BoardTemplate table exclusively —
# never this dict. Editing a template here only affects installs where the
# table doesn't already have that slug's row (a fresh install, or a new
# slug added here for the first time); it has no effect on an existing
# deployment's row. To change a built-in template for existing installs,
# ship a data migration that updates that slug's row explicitly (see 0029
# and 0054 for the pattern).
#
# Each entry maps a slug to its column list and first-swimlane metadata.
# Templates are applied once at board creation and have no ongoing effect —
# columns and swimlanes are fully editable afterward.
#
# Column colors use the same hex tokens as the Tailwind palette referenced
# throughout the codebase (slate/blue/amber/green/red/violet/orange).

BOARD_TEMPLATES: dict[str, dict] = {
    "sales_pipeline": {
        "name": "Sales Pipeline",
        "description": "Track deals per account from lead to close",
        "icon": "chart-up",
        "sort_order": 10,
        "is_active": True,
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
        "name": "Customer Support",
        "description": "Manage support tickets per customer",
        "icon": "headset",
        "sort_order": 20,
        "is_active": True,
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
        "name": "Customer Success",
        "description": "Track health and growth of every account",
        "icon": "star",
        "sort_order": 30,
        "is_active": True,
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
        "name": "Simple Kanban",
        "description": "General task tracking for any team",
        "icon": "columns",
        "sort_order": 40,
        "is_active": True,
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
        "name": "Product Roadmap",
        "description": "Feature delivery from idea to GA per product line",
        "icon": "roadmap",
        "sort_order": 50,
        "is_active": True,
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
        "name": "Project Delivery",
        "description": "End-to-end delivery lifecycle per project",
        "icon": "clipboard",
        "sort_order": 60,
        "is_active": True,
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
        "name": "Content Production",
        "description": "Manage content pieces from idea to publication",
        "icon": "pencil",
        "sort_order": 65,
        "is_active": True,
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
        "name": "Hiring & Recruiting",
        "description": "Track candidates from application to hire per role",
        "icon": "users",
        "sort_order": 75,
        "is_active": True,
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
        "name": "Legal & Compliance",
        "description": "Track compliance requests and approvals per department",
        "icon": "shield",
        "sort_order": 85,
        "is_active": True,
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
        "name": "Infrastructure & DevOps",
        "description": "Track incidents and changes per service from report to verified",
        "icon": "server",
        "sort_order": 95,
        "is_active": True,
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
        "name": "Blank Board",
        "description": "Start empty and add columns and swimlanes yourself",
        "icon": "blank",
        "sort_order": 70,
        "is_active": True,
        "columns": [],
        "lane_label": "",
        "lane_placeholder": "e.g. General",
        "default_swimlane": None,
    },
}
