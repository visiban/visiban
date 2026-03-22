"""
Seed realistic per-template demo data for all Visiban board templates.

Creates one board per template (or a subset via --template) with domain-specific
swimlanes, cards, labels, checklists, comments, and full CardMovement history.

Cards are placed in their *current* column, and movement history is back-filled
from column 0 through each intermediate stage so the History tab is populated.

Uses a fixed SEED_ANCHOR_DATE so exported JSON/CSV files are git-stable across runs.

Export path: backend/boards/seed_data/<slug>/seed.{json,csv}


Usage:
    python manage.py seed_template_boards --template all
        Seed all 6 templates. Skips any board that already exists.

    python manage.py seed_template_boards --template sales_pipeline
        Seed a single template by slug.

    python manage.py seed_template_boards --template all --wipe
        Delete and recreate all template boards.

    python manage.py seed_template_boards --template all --force
        Override the DEBUG=True guard (for CI / dedicated demo environments).

    python manage.py seed_template_boards --template all --export
        After seeding, write JSON and CSV snapshots to
        backend/boards/seed_data/<slug>/seed.{json,csv}.
        Commit the results when board structure changes so CI does not fail.
"""

import csv
import datetime
import json
import random

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from accounts.models import User
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardChecklist,
    CardComment,
    CardMovement,
    Column,
    Label,
    Swimlane,
)

SEED_ANCHOR_DATE = datetime.date(2026, 3, 15)
BOARD_NAME_PREFIX = "Template:"

DEMO_USERS = [
    {"username": "demo1", "email": "demo1@visiban.example", "first_name": "Alex",   "last_name": "Rivera"},
    {"username": "demo2", "email": "demo2@visiban.example", "first_name": "Sam",    "last_name": "Chen"},
    {"username": "demo3", "email": "demo3@visiban.example", "first_name": "Jordan", "last_name": "Patel"},
    {"username": "demo4", "email": "demo4@visiban.example", "first_name": "Morgan", "last_name": "Wu"},
    {"username": "demo5", "email": "demo5@visiban.example", "first_name": "Casey",  "last_name": "Osei"},
]

# ---------------------------------------------------------------------------
# Template data
# ---------------------------------------------------------------------------
# Each template entry contains:
#   board_name    — display name of the seeded board
#   description   — board description
#   columns       — list of {name, color} dicts (position is index order)
#   labels        — list of {name, color} dicts
#   swimlanes     — list of swimlane dicts, each containing:
#       name, color, contact_email, notes
#       cards — list of card dicts:
#           title        — card title
#           description  — markdown description (can be "")
#           col_idx      — current column index (0 = leftmost)
#           priority     — low | medium | high | urgent
#           due_offset   — int days from SEED_ANCHOR_DATE (neg=overdue), or None
#           weight       — int 1–8
#           labels       — list of label names (must match labels list above)
#           checklist    — list of {text, is_checked} dicts (may be empty)
#           comments     — list of comment body strings (may be empty)
#           assignee_idx — index into DEMO_USERS (0–4), or None

TEMPLATE_DATA: dict[str, dict] = {

    # ── Sales Pipeline ────────────────────────────────────────────────────────
    "sales_pipeline": {
        "board_name": "Template: Sales Pipeline",
        "description": (
            "Track deals from first contact through close. "
            "Each swimlane represents a prospect account."
        ),
        "columns": [
            {"name": "Lead",          "color": "#6B7280", "allow_card_creation": True},
            {"name": "Qualified",     "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Proposal Sent", "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Negotiation",   "color": "#F97316", "allow_card_creation": False},
            {"name": "Closed Won",    "color": "#10B981", "allow_card_creation": False},
            {"name": "Closed Lost",   "color": "#9CA3AF", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Enterprise", "color": "#6366F1"},
            {"name": "SMB",        "color": "#14B8A6"},
            {"name": "Strategic",  "color": "#F59E0B"},
            {"name": "Renewal",    "color": "#10B981"},
        ],
        "swimlanes": [
            {
                "name": "TechNova Inc",
                "color": "#3B82F6",
                "contact_email": "procurement@technova.example",
                "notes": "Series C SaaS company — 500 seats target. Champion: VP Engineering.",
                "cards": [
                    {
                        "title": "Intro call with VP Engineering",
                        "description": (
                            "## Goal\n\nEstablish rapport and identify pain points with current "
                            "project tracking tooling.\n\n## Key questions\n\n"
                            "- How many teams would use Visiban?\n"
                            "- What does the current Jira setup look like?\n"
                            "- Who has budget authority?"
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 5,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send calendar invite", "is_checked": True},
                            {"text": "Prepare discovery questions", "is_checked": True},
                            {"text": "Research company LinkedIn", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed for Thursday 2pm PT. Sam will join as SE.",
                            "They mentioned migrating off Jira — this is a strong signal.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Product demo: board visualization",
                        "description": (
                            "Run the standard board demo tailored to engineering use case. "
                            "Focus on swimlane-per-team, WIP limits, and the analytics view.\n\n"
                            "Time-box to 45 min. Leave 15 min for Q&A."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": -3,
                        "weight": 3,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Customise demo board with TechNova branding", "is_checked": True},
                            {"text": "Prepare engineering-specific use case slides", "is_checked": True},
                            {"text": "Send follow-up summary email", "is_checked": False},
                        ],
                        "comments": [
                            "Demo went well. They loved the card movement history view.",
                            "Action item: send pricing deck by EOD Friday.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Security review questionnaire",
                        "description": (
                            "TechNova InfoSec requires a completed vendor security questionnaire "
                            "before legal can proceed.\n\n"
                            "## Required sections\n\n"
                            "- Data residency and encryption at rest\n"
                            "- SOC 2 Type II report (attach)\n"
                            "- Pen test summary (last 12 months)\n"
                            "- Incident response SLA"
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Complete CAIQ questionnaire", "is_checked": True},
                            {"text": "Attach SOC 2 Type II report", "is_checked": True},
                            {"text": "Get pen test summary signed off", "is_checked": False},
                            {"text": "Return to TechNova InfoSec team", "is_checked": False},
                        ],
                        "comments": [
                            "Jordan filled out sections 1–4. Waiting on InfoSec to countersign the pen test summary.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Legal review of MSA",
                        "description": (
                            "Master Service Agreement sent to TechNova legal on 2026-03-10. "
                            "Their counsel requested two redlines:\n\n"
                            "1. Liability cap: 2× ARR (we proposed 1×)\n"
                            "2. Data deletion timeline: 30 days (we proposed 90 days)\n\n"
                            "Escalate to VP Sales if no resolution by due date."
                        ),
                        "col_idx": 3,
                        "priority": "urgent",
                        "due_offset": 5,
                        "weight": 5,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Review their redlines with legal counsel", "is_checked": True},
                            {"text": "Counter-propose on liability cap", "is_checked": False},
                            {"text": "Agree data deletion timeline", "is_checked": False},
                            {"text": "Execute final MSA", "is_checked": False},
                        ],
                        "comments": [
                            "Legal: we can accept 2× ARR cap. Holding on 30-day deletion — check with engineering.",
                            "Engineering confirmed 30 days is feasible. Updating counter-proposal.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Confirm pilot program (50 seats, 90 days)",
                        "description": (
                            "TechNova signed. Pilot starts 2026-04-01 with the Platform Engineering "
                            "team (50 seats). Success criteria agreed:\n\n"
                            "- ≥70% weekly active users\n"
                            "- NPS ≥ 40 at 45-day check-in\n"
                            "- Expand to full org if criteria met"
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Provision 50 seats", "is_checked": True},
                            {"text": "Schedule kick-off with champion", "is_checked": True},
                            {"text": "Set 45-day check-in calendar reminder", "is_checked": True},
                        ],
                        "comments": [
                            "Pilot confirmed! Handoff to CS team — assign to Casey.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "BlueRidge Financial",
                "color": "#6366F1",
                "contact_email": "vendor@blueridge.example",
                "notes": "Compliance-heavy financial firm. Procurement is slow — expect 90-day cycle.",
                "cards": [
                    {
                        "title": "Cold outreach — CISO intro",
                        "description": (
                            "Initial outreach via LinkedIn to CISO Sarah Ng. "
                            "Referenced their recent SOC 2 certification news.\n\n"
                            "Follow up with email if no response in 5 business days."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send LinkedIn connection request", "is_checked": True},
                            {"text": "Follow up with email", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Discovery call completed",
                        "description": (
                            "30-min call with CISO and IT Director. "
                            "Pain: current spreadsheet tracking breaks down for cross-team work.\n\n"
                            "They need on-prem or private-cloud option — flag for product team."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 3,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send meeting notes", "is_checked": True},
                            {"text": "Flag on-prem requirement to product", "is_checked": False},
                        ],
                        "comments": [
                            "Strong interest but private cloud is a hard requirement for them.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Compliance questionnaire review",
                        "description": (
                            "BlueRidge sent a 47-page compliance questionnaire. "
                            "Sections covering PCI-DSS, GDPR, and FINRA record-keeping.\n\n"
                            "Coordinate with legal and InfoSec to complete."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": -7,
                        "weight": 5,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Route to InfoSec for FINRA section", "is_checked": True},
                            {"text": "Complete GDPR data flow diagram", "is_checked": True},
                            {"text": "PCI-DSS section — confirm scope with engineering", "is_checked": False},
                            {"text": "Return completed questionnaire", "is_checked": False},
                        ],
                        "comments": [
                            "OVERDUE — InfoSec is backed up. Escalated to CTO.",
                            "CTO approved expedited review. Engineering confirmed PCI out-of-scope.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Negotiate SLA terms",
                        "description": (
                            "BlueRidge requires 99.95% uptime SLA with financial penalties. "
                            "Current standard offer is 99.9%.\n\n"
                            "Options:\n"
                            "1. Upgrade to enterprise tier (99.95% SLA included)\n"
                            "2. Custom SLA addendum at +15% ACV"
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 3,
                        "weight": 4,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Get VP approval for 99.95% SLA", "is_checked": True},
                            {"text": "Draft SLA addendum", "is_checked": False},
                            {"text": "Send final pricing with SLA options", "is_checked": False},
                        ],
                        "comments": [
                            "VP approved enterprise tier upgrade path. Drafting addendum.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Apex Retail",
                "color": "#F59E0B",
                "contact_email": "tech@apexretail.example",
                "notes": "Mid-market retail chain. Seasonal budget freeze Dec–Feb. Decision maker: CTO.",
                "cards": [
                    {
                        "title": "Q3 seasonal pitch deck",
                        "description": (
                            "Prepare a retail-focused pitch showing how Visiban tracks "
                            "seasonal campaigns and store rollout projects.\n\n"
                            "Highlight swimlane-per-region use case."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 15,
                        "weight": 3,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Adapt standard deck for retail use case", "is_checked": True},
                            {"text": "Add region swimlane screenshot", "is_checked": False},
                            {"text": "Review with AE before sending", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Proposal for 50 seats",
                        "description": (
                            "Formal proposal sent 2026-03-12. Includes:\n\n"
                            "- 50 seats @ standard SMB pricing\n"
                            "- 30-day free trial extension\n"
                            "- Onboarding package (2 sessions)\n\n"
                            "CTO is reviewing with procurement."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": -2,
                        "weight": 4,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Send proposal PDF", "is_checked": True},
                            {"text": "Follow up after 3 business days", "is_checked": True},
                            {"text": "Book follow-up call", "is_checked": False},
                        ],
                        "comments": [
                            "CTO out of office until Monday. Following up then.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Deal lost — budget frozen until Q4",
                        "description": (
                            "Apex Retail CTO confirmed budget freeze effective immediately. "
                            "Revisit in Q4 (October). Flagged for re-engagement campaign.\n\n"
                            "Reason: parent company M&A activity."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Log reason in CRM", "is_checked": True},
                            {"text": "Set Q4 re-engagement reminder", "is_checked": True},
                        ],
                        "comments": [
                            "Not a product rejection — purely budget. Good candidate for Q4 outreach.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Meridian Health",
                "color": "#10B981",
                "contact_email": "procurement@meridianhealth.example",
                "notes": "Healthcare network — HIPAA BAA required. 200-seat potential. Long procurement cycle.",
                "cards": [
                    {
                        "title": "Identify champion at Meridian",
                        "description": (
                            "Need an internal champion with authority to push the deal. "
                            "Current contact (IT Director) lacks budget sign-off.\n\n"
                            "Candidates: VP of Clinical Operations, CIO."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 20,
                        "weight": 2,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Map org chart via LinkedIn", "is_checked": True},
                            {"text": "Request intro to CIO via IT Director", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "HIPAA Business Associate Agreement",
                        "description": (
                            "Meridian requires a signed HIPAA BAA before any data can be shared "
                            "or a trial provisioned.\n\n"
                            "Our standard BAA covers PHI in transit and at rest. "
                            "Have legal countersign and return within 5 business days."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 7,
                        "weight": 5,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send standard BAA to their legal", "is_checked": True},
                            {"text": "Review any redlines", "is_checked": False},
                            {"text": "Execute and file signed BAA", "is_checked": False},
                        ],
                        "comments": [
                            "Their legal team has a 5-day turnaround. Starting clock today.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Pilot: 10 seats for 90 days",
                        "description": (
                            "Pilot scoped to the Care Coordination team (10 seats). "
                            "Success metrics:\n\n"
                            "- All active projects tracked in Visiban by day 30\n"
                            "- Monthly check-in NPS ≥ 35\n"
                            "- Expand to 200 seats if successful"
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Provision pilot environment", "is_checked": True},
                            {"text": "Schedule onboarding session", "is_checked": False},
                            {"text": "Set 30-day check-in reminder", "is_checked": False},
                        ],
                        "comments": [
                            "CIO approved pilot. Care Coordination team excited to start.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Contract signed — 200 seats",
                        "description": (
                            "Meridian Health signed a 2-year contract for 200 seats. "
                            "Annual value: $48k. Effective 2026-04-01.\n\n"
                            "Handoff to Customer Success for onboarding."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Enterprise", "Strategic", "Renewal"],
                        "checklist": [
                            {"text": "Provision 200 seats", "is_checked": True},
                            {"text": "Schedule onboarding kick-off", "is_checked": True},
                            {"text": "Hand off to CS team", "is_checked": True},
                        ],
                        "comments": [
                            "Closed! 2-year deal. This is our biggest healthcare win to date.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Summit Logistics",
                "color": "#F97316",
                "contact_email": "ops@summitlogistics.example",
                "notes": "Fast-moving mid-market. Decision in < 2 weeks. 25-seat deal.",
                "cards": [
                    {
                        "title": "Inbound lead — website form",
                        "description": (
                            "Lead submitted via the website contact form. "
                            "Message: 'Looking for a Trello replacement for our ops team.'\n\n"
                            "Assign to AE for same-day follow-up."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Respond within 1 business hour", "is_checked": True},
                            {"text": "Qualify via email before booking call", "is_checked": True},
                        ],
                        "comments": [
                            "Responded within 20 min. They're evaluating 3 tools — we're in the mix.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Qualification call",
                        "description": (
                            "15-min discovery call. Confirmed:\n\n"
                            "- 25 users across 3 ops teams\n"
                            "- Budget: ~$5k/year\n"
                            "- Decision by end of month\n"
                            "- Pain: Trello too simple, Jira too complex"
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": -1,
                        "weight": 3,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Log BANT in CRM", "is_checked": True},
                            {"text": "Send trial invite (25 seats)", "is_checked": False},
                        ],
                        "comments": [
                            "Great fit. Sending trial today.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Pricing discussion",
                        "description": (
                            "Summit wants a 10% discount for annual pre-pay. "
                            "Standard ACV for 25 seats is $3,000.\n\n"
                            "Approved to offer 10% for annual. No further discounting."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Send updated pricing PDF", "is_checked": True},
                            {"text": "Confirm decision timeline", "is_checked": False},
                        ],
                        "comments": [
                            "They accepted the 10% annual pre-pay offer. Sending contract.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Closed — 25 seats annual",
                        "description": (
                            "Summit Logistics signed for 25 seats on an annual plan. "
                            "ACV: $2,700. Payment received. Provisioning complete.\n\n"
                            "Time to close: 9 days from inbound lead."
                        ),
                        "col_idx": 4,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["SMB", "Renewal"],
                        "checklist": [
                            {"text": "Provision 25 seats", "is_checked": True},
                            {"text": "Send welcome email", "is_checked": True},
                            {"text": "Set renewal reminder (11 months)", "is_checked": True},
                        ],
                        "comments": [
                            "Fastest close this quarter. Good template for SMB inbound.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
        ],
    },

    # ── Other templates — added in subsequent tasks ───────────────────────────
    # "customer_support": { ... },
    # "customer_success": { ... },
    # "simple_kanban":    { ... },
    # "product_roadmap":  { ... },
    # "project_delivery": { ... },
}

VALID_SLUGS = list(TEMPLATE_DATA.keys())


# ---------------------------------------------------------------------------
# Management command
# ---------------------------------------------------------------------------

class Command(BaseCommand):
    help = "Seed per-template demo boards with domain-specific realistic data."

    def add_arguments(self, parser):
        parser.add_argument(
            "--template",
            required=True,
            metavar="SLUG|all",
            help=(
                f"Template slug to seed, or 'all' for every template. "
                f"Valid slugs: {', '.join(VALID_SLUGS)}."
            ),
        )
        parser.add_argument(
            "--wipe",
            action="store_true",
            help="Delete the existing board for the target template(s) and recreate.",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Override the DEBUG=True guard (CI / dedicated demo environments only).",
        )
        parser.add_argument(
            "--export",
            action="store_true",
            help="Write JSON and CSV snapshots to backend/boards/seed_data/<slug>/ after seeding.",
        )

    def handle(self, *args, **options):
        # Production guard: refuse to run on any non-DEBUG environment unless
        # --force is explicitly passed. Matches the guard in seed_demo_data.
        if not settings.DEBUG and not options["force"]:
            raise CommandError(
                "Refusing to seed: DEBUG is False. "
                "Pass --force to override (only safe on dedicated demo environments)."
            )

        template_arg = options["template"]
        if template_arg == "all":
            slugs = VALID_SLUGS
        elif template_arg in VALID_SLUGS:
            slugs = [template_arg]
        else:
            raise CommandError(
                f"Unknown template '{template_arg}'. "
                f"Valid options: all, {', '.join(VALID_SLUGS)}."
            )

        users = self._ensure_demo_users()

        for slug in slugs:
            self._seed_template(slug, users, options)

    # ── Per-template orchestration ─────────────────────────────────────────

    def _seed_template(self, slug, users, options):
        data = TEMPLATE_DATA[slug]
        board_name = data["board_name"]

        if options["wipe"]:
            deleted, _ = Board.objects.filter(name=board_name).delete()
            if deleted:
                self.stdout.write(f"Deleted existing '{board_name}'.")

        if Board.objects.filter(name=board_name).exists():
            self.stdout.write(
                self.style.WARNING(
                    f"'{board_name}' already exists — skipping. Use --wipe to recreate."
                )
            )
            return

        board = self._create_board(board_name, data["description"], users[0])
        columns = self._create_columns(board, data["columns"])
        labels_map = self._create_labels(board, data["labels"])
        self._add_members(board, users)

        all_cards = []
        for lane_data in data["swimlanes"]:
            swimlane = Swimlane.objects.create(
                board=board,
                name=lane_data["name"],
                color=lane_data["color"],
                contact_email=lane_data.get("contact_email", ""),
                notes=lane_data.get("notes", ""),
                position=data["swimlanes"].index(lane_data),
            )
            cards = self._create_cards_for_swimlane(
                board, columns, swimlane, labels_map, users, lane_data["cards"]
            )
            all_cards.extend(cards)

        self.stdout.write(
            self.style.SUCCESS(
                f"Seeded '{board_name}': "
                f"{len(columns)} columns, {len(data['swimlanes'])} swimlanes, "
                f"{len(all_cards)} cards."
            )
        )

        if options["export"]:
            self._export(slug, board, columns, data["swimlanes"], data["labels"], all_cards)

    # ── DB helpers ─────────────────────────────────────────────────────────

    def _ensure_demo_users(self):
        users = []
        for u in DEMO_USERS:
            user, created = User.objects.get_or_create(
                username=u["username"],
                defaults={
                    "email": u["email"],
                    "first_name": u["first_name"],
                    "last_name": u["last_name"],
                },
            )
            if created:
                user.set_unusable_password()
                user.save()
            users.append(user)
        return users

    def _create_board(self, name, description, owner):
        return Board.objects.create(
            name=name,
            description=description,
            owner=owner,
            staleness_threshold_days=7,
        )

    def _create_columns(self, board, col_specs):
        cols = []
        for i, spec in enumerate(col_specs):
            cols.append(
                Column.objects.create(
                    board=board,
                    position=i,
                    name=spec["name"],
                    color=spec["color"],
                    allow_card_creation=spec.get("allow_card_creation", True),
                )
            )
        return cols

    def _create_labels(self, board, label_specs):
        """Create labels and return a name→Label mapping."""
        label_map = {}
        for spec in label_specs:
            lbl = Label.objects.create(board=board, name=spec["name"], color=spec["color"])
            label_map[spec["name"]] = lbl
        return label_map

    def _add_members(self, board, users):
        BoardMembership.objects.create(board=board, user=users[0], role=BoardMembership.Role.ADMIN)
        for user in users[1:]:
            BoardMembership.objects.create(board=board, user=user, role=BoardMembership.Role.MEMBER)

    def _create_cards_for_swimlane(self, board, columns, swimlane, labels_map, users, card_specs):
        """
        Create cards from per-swimlane card spec dicts. Each card is placed in
        its current column (col_idx) and gets retroactive CardMovement history
        generated from column 0 through each intermediate stage.
        """
        col_positions = {c.id: 0 for c in columns}
        cards = []

        for spec in card_specs:
            col_idx = spec["col_idx"]
            current_col = columns[col_idx]

            assignee_idx = spec.get("assignee_idx")
            assignee = users[assignee_idx] if assignee_idx is not None else None

            due_offset = spec.get("due_offset")
            if due_offset is not None:
                due_date = SEED_ANCHOR_DATE + datetime.timedelta(days=due_offset)
            else:
                due_date = None

            card = Card.objects.create(
                board=board,
                column=current_col,
                swimlane=swimlane,
                title=spec["title"],
                description=spec.get("description", ""),
                priority=spec["priority"],
                assignee=assignee,
                due_date=due_date,
                weight=spec.get("weight", 1),
                position=col_positions[current_col.id],
                created_by=users[0],
            )
            col_positions[current_col.id] += 1

            # Attach labels
            label_names = spec.get("labels", [])
            if label_names:
                card.labels.set(labels_map[n] for n in label_names if n in labels_map)

            # Checklist items
            for pos, item in enumerate(spec.get("checklist", [])):
                CardChecklist.objects.create(
                    card=card,
                    text=item["text"],
                    is_checked=item["is_checked"],
                    position=pos,
                )

            # Comments (authored by demo users in round-robin order)
            for i, body in enumerate(spec.get("comments", [])):
                CardComment.objects.create(
                    card=card,
                    author=users[i % len(users)],
                    body=body,
                )

            # Back-fill movement history from col 0 → current col
            self._add_movement_history(card, col_idx, columns, users)

            cards.append(card)

        return cards

    def _add_movement_history(self, card, col_idx, columns, users):
        """
        Simulate the card having progressed through pipeline stages to reach
        col_idx. Cards in column 0 get a creation record only. Each subsequent
        stage transition gets a backdated CardMovement record.

        auto_now_add=True ignores explicit values at create time, so moved_at is
        back-filled via update() after creation — same pattern as seed_demo_data.

        Date anchoring: all timestamps are relative to SEED_ANCHOR_DATE so that
        regenerated exports are git-stable regardless of when the command runs.
        """
        anchor = datetime.datetime(
            SEED_ANCHOR_DATE.year,
            SEED_ANCHOR_DATE.month,
            SEED_ANCHOR_DATE.day,
            tzinfo=datetime.timezone.utc,
        )

        # Build stage offsets working backwards from the anchor.
        # Most-recent transition lands 2–8 days before anchor; each prior stage
        # adds 5–15 days so that dwell times look realistic.
        cumulative_days = random.randint(2, 8)
        stage_offsets = []
        for _ in range(col_idx):
            stage_offsets.append(cumulative_days)
            cumulative_days += random.randint(5, 15)
        # Reverse so index 0 corresponds to the earliest (largest days_ago) move.
        stage_offsets.reverse()

        # Creation record (from_column=None → col 0)
        created_days_ago = cumulative_days + random.randint(3, 10)
        created_at = anchor - datetime.timedelta(days=created_days_ago)
        mv = CardMovement.objects.create(
            card=card,
            from_column=None,
            to_column=columns[0],
            from_swimlane=None,
            to_swimlane=card.swimlane,
            from_column_name="",
            to_column_name=columns[0].name,
            from_column_uid="",
            to_column_uid=columns[0].uid,
            from_swimlane_name="",
            to_swimlane_name=card.swimlane.name,
            from_swimlane_uid="",
            to_swimlane_uid=card.swimlane.uid,
            moved_by=random.choice(users),
            notes="",
        )
        CardMovement.objects.filter(pk=mv.pk).update(moved_at=created_at)

        # Stage-to-stage transitions
        for i in range(col_idx):
            from_col = columns[i]
            to_col = columns[i + 1]
            moved_at = anchor - datetime.timedelta(days=stage_offsets[i])
            mv = CardMovement.objects.create(
                card=card,
                from_column=from_col,
                to_column=to_col,
                from_swimlane=card.swimlane,
                to_swimlane=card.swimlane,
                from_column_name=from_col.name,
                to_column_name=to_col.name,
                from_column_uid=from_col.uid,
                to_column_uid=to_col.uid,
                from_swimlane_name=card.swimlane.name,
                to_swimlane_name=card.swimlane.name,
                from_swimlane_uid=card.swimlane.uid,
                to_swimlane_uid=card.swimlane.uid,
                moved_by=random.choice(users),
                notes="",
            )
            CardMovement.objects.filter(pk=mv.pk).update(moved_at=moved_at)

    # ── Export ─────────────────────────────────────────────────────────────

    def _export(self, slug, board, columns, swimlane_specs, label_specs, cards):
        """Write JSON and CSV snapshots to backend/boards/seed_data/<slug>/."""
        # Re-fetch with prefetch to avoid N+1 on labels, checklist, comments.
        card_qs = (
            board.cards
            .select_related("column", "swimlane", "assignee")
            .prefetch_related("labels", "checklist_items", "comments__author")
            .order_by("swimlane__position", "column__position", "position")
        )

        # Export path: BASE_DIR = .../backend/, so seed_data lives at
        # .../backend/boards/seed_data/<slug>/
        seed_dir = settings.BASE_DIR / "boards" / "seed_data" / slug
        seed_dir.mkdir(parents=True, exist_ok=True)

        self._export_json(board, columns, swimlane_specs, label_specs, card_qs, seed_dir)
        self._export_csv(card_qs, seed_dir)
        self.stdout.write(self.style.SUCCESS(f"  Exported seed files to {seed_dir}/"))

    def _export_json(self, board, columns, swimlane_specs, label_specs, cards, seed_dir):
        data = {
            "name": board.name,
            "description": board.description,
            "columns": [
                {
                    "name": c.name,
                    "position": c.position,
                    "color": c.color,
                    "wip_limit": c.wip_limit,
                    "allow_card_creation": c.allow_card_creation,
                }
                for c in columns
            ],
            "swimlanes": [
                {
                    "name": s["name"],
                    "position": i,
                    "color": s["color"],
                    "contact_email": s.get("contact_email", ""),
                    "notes": s.get("notes", ""),
                }
                for i, s in enumerate(swimlane_specs)
            ],
            "labels": [
                {"name": lbl["name"], "color": lbl["color"]}
                for lbl in label_specs
            ],
            "cards": [
                {
                    "title": card.title,
                    "description": card.description,
                    "priority": card.priority,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "due_date": card.due_date.isoformat() if card.due_date else None,
                    "weight": card.weight,
                    "labels": [lbl.name for lbl in card.labels.order_by("name")],
                    "checklist": [
                        {"text": item.text, "is_checked": item.is_checked}
                        for item in card.checklist_items.all()
                    ],
                    "comments": [
                        {
                            "body": comment.body,
                            "author": comment.author.username if comment.author else None,
                        }
                        for comment in card.comments.all()
                    ],
                }
                for card in cards
            ],
        }
        out = seed_dir / "seed.json"
        out.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        self.stdout.write(f"    → {out}")

    def _export_csv(self, cards, seed_dir):
        fieldnames = [
            "title", "column", "swimlane", "priority", "due_date",
            "weight", "labels", "assignee", "checklist_total",
            "checklist_done", "comment_count", "description_preview",
        ]
        out = seed_dir / "seed.csv"
        with out.open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            for card in cards:
                checklist = list(card.checklist_items.all())
                comments = list(card.comments.all())
                writer.writerow({
                    "title": card.title,
                    "column": card.column.name,
                    "swimlane": card.swimlane.name,
                    "priority": card.priority,
                    "due_date": card.due_date.isoformat() if card.due_date else "",
                    "weight": card.weight,
                    "labels": ",".join(lbl.name for lbl in card.labels.order_by("name")),
                    "assignee": card.assignee.username if card.assignee else "",
                    "checklist_total": len(checklist),
                    "checklist_done": sum(1 for i in checklist if i.is_checked),
                    "comment_count": len(comments),
                    "description_preview": card.description[:80].replace("\n", " "),
                })
        self.stdout.write(f"    → {out}")
