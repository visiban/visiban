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

    # ── Customer Support ──────────────────────────────────────────────────────
    "customer_support": {
        "board_name": "Template: Customer Support",
        "description": (
            "Track support tickets from first report through resolution. "
            "Each swimlane represents a customer account."
        ),
        "columns": [
            {"name": "New",               "color": "#6B7280", "allow_card_creation": True},
            {"name": "Triaged",           "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Investigating",     "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Awaiting Customer", "color": "#F97316", "allow_card_creation": False},
            {"name": "Resolved",          "color": "#10B981", "allow_card_creation": False},
            {"name": "Closed",            "color": "#9CA3AF", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "P1 Critical", "color": "#EF4444"},
            {"name": "P2 High",     "color": "#F97316"},
            {"name": "P3 Normal",   "color": "#3B82F6"},
            {"name": "Data Loss",   "color": "#7C3AED"},
            {"name": "Integration", "color": "#0891B2"},
            {"name": "Billing",     "color": "#D97706"},
        ],
        "swimlanes": [
            {
                "name": "Globex Corp",
                "color": "#EF4444",
                "contact_email": "support@globex.example",
                "notes": "Enterprise SLA — 4h response, 24h resolution for P1. Primary contact: IT Director.",
                "cards": [
                    {
                        "title": "API returns 500 on bulk card export",
                        "description": (
                            "## Reported\n\nPOST `/api/boards/{id}/export/` returns HTTP 500 when "
                            "the board has more than 500 cards.\n\n"
                            "## Steps to reproduce\n\n"
                            "1. Open board with 600+ cards\n"
                            "2. Click Export → CSV\n"
                            "3. Response: `500 Internal Server Error`\n\n"
                            "## Impact\n\nBlocks weekly reporting for all 12 teams."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": -1,
                        "weight": 5,
                        "labels": ["P1 Critical"],
                        "checklist": [
                            {"text": "Reproduce in staging", "is_checked": True},
                            {"text": "Identify root cause (query timeout?)", "is_checked": True},
                            {"text": "Deploy fix to production", "is_checked": False},
                            {"text": "Confirm resolution with customer", "is_checked": False},
                        ],
                        "comments": [
                            "Reproduced. The export query times out at 30s — no pagination on that endpoint.",
                            "Fix: stream the CSV in chunks. MR open, awaiting review.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "SSO login fails for new users after v1.2 deploy",
                        "description": (
                            "New users provisioned via SAML after the v1.2 deploy cannot log in. "
                            "Existing users are unaffected.\n\n"
                            "Error in browser: `Invalid SAML assertion — missing NameID format`\n\n"
                            "Regression introduced in v1.2 — NameID format handling changed."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 2,
                        "weight": 4,
                        "labels": ["P2 High", "Integration"],
                        "checklist": [
                            {"text": "Confirm affected user count", "is_checked": True},
                            {"text": "Check SAML assertion diff between v1.1 and v1.2", "is_checked": False},
                            {"text": "Deploy hotfix", "is_checked": False},
                        ],
                        "comments": [
                            "Affects ~30 new users provisioned since Monday. Existing users unaffected.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Webhooks not firing on card moves",
                        "description": (
                            "Globex has a Zapier integration that listens for `card.moved` webhook events. "
                            "Since Tuesday, events are not being delivered.\n\n"
                            "Webhook logs show events queued but not dispatched. "
                            "Worker appears healthy."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["P2 High", "Integration"],
                        "checklist": [
                            {"text": "Check webhook worker logs", "is_checked": True},
                            {"text": "Test webhook delivery in staging", "is_checked": True},
                            {"text": "Send test payload to Globex endpoint", "is_checked": False},
                        ],
                        "comments": [
                            "Worker is running but Redis queue is backed up — unrelated deploy caused slowdown.",
                            "Awaiting Globex to confirm their endpoint is ready to receive test payload.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Feature request: CSV export include archived cards",
                        "description": (
                            "Customer requests that the CSV export include archived cards "
                            "with an `is_archived` column.\n\n"
                            "Currently, archived cards are silently excluded from all exports."
                        ),
                        "col_idx": 4,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Log as feature request in backlog", "is_checked": True},
                            {"text": "Confirm workaround (restore → export → re-archive)", "is_checked": True},
                        ],
                        "comments": [
                            "Workaround communicated. Feature filed as #287 in backlog.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Board load time regression after v1.2",
                        "description": (
                            "Large boards (800+ cards) are taking 4–6 s to load since v1.2. "
                            "Previous baseline was ~1.5 s.\n\n"
                            "Profiling points to a new `get_member_roles()` call in "
                            "`BoardFullSerializer` that runs once per member."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": -3,
                        "weight": 4,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Profile with django-silk on staging", "is_checked": True},
                            {"text": "Add prefetch_related for member roles", "is_checked": False},
                            {"text": "Benchmark before/after", "is_checked": False},
                            {"text": "Deploy and confirm with customer", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed N+1: 14 extra queries for a 14-member board. Fix is straightforward.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Pinnacle Media",
                "color": "#F97316",
                "contact_email": "helpdesk@pinnaclemedia.example",
                "notes": "Mid-market. Standard SLA. Primary contact: Project Manager.",
                "cards": [
                    {
                        "title": "Permission error when creating swimlanes",
                        "description": (
                            "Board members with Member role get a 403 when trying to add a swimlane, "
                            "even though the board is configured to allow member-level swimlane creation.\n\n"
                            "Regression: this worked before v1.1."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 1,
                        "weight": 3,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Reproduce with member-role test account", "is_checked": True},
                            {"text": "Check permission check in SwimlaneViewSet", "is_checked": False},
                            {"text": "Fix and deploy", "is_checked": False},
                        ],
                        "comments": [
                            "Reproduced. The v1.1 permission refactor accidentally tightened swimlane creation to Admin-only.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Labels not persisting on card edit",
                        "description": (
                            "When a card is edited and saved, labels are cleared. "
                            "The UI shows them momentarily but they disappear after the API response.\n\n"
                            "Observed in Chrome and Firefox. Not reproducible in Safari."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": -5,
                        "weight": 3,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Check PATCH payload includes label IDs", "is_checked": True},
                            {"text": "Verify serializer handles partial update for M2M", "is_checked": False},
                        ],
                        "comments": [
                            "The PATCH payload is correct. The serializer is not saving M2M on partial=True — known Django quirk.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Email notifications for @mentions not delivered",
                        "description": (
                            "Users are not receiving email notifications when @mentioned in card comments. "
                            "In-app notifications work correctly.\n\n"
                            "Mail logs show the notification task is enqueued but no SMTP activity."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Check Celery worker is running email tasks", "is_checked": True},
                            {"text": "Test SMTP connection from worker host", "is_checked": True},
                            {"text": "Confirm customer SMTP allowlist includes our IP", "is_checked": False},
                        ],
                        "comments": [
                            "SMTP test from worker succeeds. Suspecting IP allowlist issue on their side.",
                            "Awaiting Pinnacle IT to confirm their allowlist — sent instructions.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Resolved: browser cache causing stale board state",
                        "description": (
                            "Customer reported boards showing cards in wrong columns. "
                            "Root cause: browser cached the old board snapshot.\n\n"
                            "Resolution: hard-refresh clears the issue. Added cache-busting "
                            "headers to the board API response."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Add Cache-Control: no-store to board endpoint", "is_checked": True},
                            {"text": "Communicate workaround to customer", "is_checked": True},
                            {"text": "Verify fix in v1.2.1", "is_checked": True},
                        ],
                        "comments": [
                            "Deployed in v1.2.1. Customer confirmed resolved.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Orion Software",
                "color": "#8B5CF6",
                "contact_email": "ops@orionsoftware.example",
                "notes": "Technical team — prefers async communication. Escalate P1s to Slack #orion-support.",
                "cards": [
                    {
                        "title": "SAML assertion fails intermittently (1 in 20 logins)",
                        "description": (
                            "~5% of SAML logins fail with `InResponseTo mismatch`. "
                            "Affects all users, not just new ones.\n\n"
                            "Suspicion: clock skew between their IdP and our service. "
                            "Their IdP is on-prem; NTP sync uncertain."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": -2,
                        "weight": 5,
                        "labels": ["P1 Critical", "Integration"],
                        "checklist": [
                            {"text": "Check NTP sync on their IdP", "is_checked": True},
                            {"text": "Widen our SAML clock tolerance to ±5 min", "is_checked": False},
                            {"text": "Deploy and monitor error rate", "is_checked": False},
                        ],
                        "comments": [
                            "Their IdP has a 4-min clock drift. Widening tolerance is the right fix.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Board export missing checklist data",
                        "description": (
                            "CSV and JSON exports do not include checklist items. "
                            "The API response includes them, but the export serializer omits them.\n\n"
                            "Impacting their reporting workflow."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 3,
                        "weight": 3,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Add checklist_items to export serializer", "is_checked": False},
                            {"text": "Update CSV fieldnames", "is_checked": False},
                            {"text": "Test with 200-item checklist", "is_checked": False},
                        ],
                        "comments": [
                            "Quick fix — checklist_items just needs to be added to the prefetch and serializer.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "WIP limit not enforced when dragging from archived view",
                        "description": (
                            "Cards restored from the archived panel bypass WIP limit checks "
                            "and are placed in the destination column even when the limit is exceeded.\n\n"
                            "The restore endpoint does not call the column's WIP validation."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Add WIP check to restore endpoint", "is_checked": True},
                            {"text": "Add test for restore-to-full-column", "is_checked": True},
                            {"text": "Deploy", "is_checked": True},
                        ],
                        "comments": [
                            "Fixed in v1.2.1. Restore now respects WIP limits.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Vertex Trading",
                "color": "#0891B2",
                "contact_email": "compliance@vertextrading.example",
                "notes": "Financial sector — strict data residency. All data must stay in EU region.",
                "cards": [
                    {
                        "title": "Compliance audit — provide access logs for Q1",
                        "description": (
                            "Vertex requires a full access log export for Q1 2026 for their "
                            "internal compliance audit.\n\n"
                            "Needed: timestamp, user, action, resource for all board operations.\n\n"
                            "CardMovement history covers moves; other actions need a separate pull."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 5,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Confirm scope with Vertex compliance team", "is_checked": True},
                            {"text": "Export CardMovement records for Q1", "is_checked": False},
                            {"text": "Export CardActivity records for Q1", "is_checked": False},
                            {"text": "Deliver via encrypted file share", "is_checked": False},
                        ],
                        "comments": [
                            "They need the raw data, not a UI report. Will export directly from DB.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Historical card movements not visible in History tab",
                        "description": (
                            "Cards moved before 2026-01-01 show no movement history. "
                            "The History tab displays 'No history yet' for these cards.\n\n"
                            "Root cause: the CardMovement table was introduced in v1.0 — "
                            "older moves have no records."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": -4,
                        "weight": 3,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Explain data limitation to customer", "is_checked": True},
                            {"text": "Check if any legacy activity logs can be imported", "is_checked": False},
                        ],
                        "comments": [
                            "Expected behaviour — pre-v1.0 moves were not tracked. Communicated to customer.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Data export times out on board with 2,000+ cards",
                        "description": (
                            "The JSON export endpoint times out (30s Nginx limit) for their "
                            "largest board. The board has 2,100 cards across 8 swimlanes.\n\n"
                            "Fix: implement streaming export with chunked transfer encoding."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Implement StreamingHttpResponse for export", "is_checked": True},
                            {"text": "Test with 2,000-card board in staging", "is_checked": False},
                            {"text": "Increase Nginx timeout as temporary mitigation", "is_checked": False},
                        ],
                        "comments": [
                            "Temporary mitigation: bumped Nginx timeout to 120s. Streaming fix in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Resolved: increased Nginx timeout for large exports",
                        "description": (
                            "Interim resolution applied: Nginx proxy timeout increased from 30s to 120s "
                            "for the export endpoint.\n\n"
                            "Permanent fix (streaming export) tracked in engineering backlog."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Deploy Nginx config change", "is_checked": True},
                            {"text": "Confirm export completes for 2,000-card board", "is_checked": True},
                            {"text": "File permanent fix as engineering ticket", "is_checked": True},
                        ],
                        "comments": [
                            "Customer confirmed export now completes (~45s). Permanent fix tracked separately.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Cascade Dynamics",
                "color": "#10B981",
                "contact_email": "it@cascadedynamics.example",
                "notes": "New customer — onboarded 2026-02-15. Mostly onboarding questions so far.",
                "cards": [
                    {
                        "title": "Onboarding: how to bulk-import cards from CSV?",
                        "description": (
                            "New customer asking about the bulk import feature. "
                            "They have 300 cards in a spreadsheet they want to load.\n\n"
                            "Point to: Settings → Import → CSV template."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Send import documentation link", "is_checked": False},
                            {"text": "Offer 30-min onboarding call if needed", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Mobile: cards overlap on small screens (< 375px)",
                        "description": (
                            "On iPhone SE (375px wide), cards in the board view overflow and overlap "
                            "adjacent cards in the same column.\n\n"
                            "Reproducible in Chrome DevTools mobile emulation."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["P3 Normal"],
                        "checklist": [
                            {"text": "Reproduce in DevTools at 375px", "is_checked": True},
                            {"text": "Fix column min-width on mobile breakpoint", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed. The column grid doesn't collapse below 400px. CSS fix needed.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Drag handle unresponsive in Firefox 124",
                        "description": (
                            "Card drag-and-drop stops working after the first successful drop in "
                            "Firefox 124. Subsequent drag attempts do nothing.\n\n"
                            "Root cause: Firefox handles `pointermove` differently when a CSS "
                            "transition is active on the column."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": -8,
                        "weight": 3,
                        "labels": ["P2 High"],
                        "checklist": [
                            {"text": "Reproduce in Firefox 124", "is_checked": True},
                            {"text": "Disable column transition during drag", "is_checked": False},
                            {"text": "Test on Firefox + Chrome + Safari", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed in FF 124. Disabling the column resize transition during drag fixes it.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
        ],
    },

    # ── Customer Success ──────────────────────────────────────────────────────
    "customer_success": {
        "board_name": "Template: Customer Success",
        "description": (
            "Track account health from onboarding through expansion and renewal. "
            "Each swimlane represents a customer account."
        ),
        "columns": [
            {"name": "Onboarding", "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Adoption",   "color": "#8B5CF6", "allow_card_creation": True},
            {"name": "Healthy",    "color": "#10B981", "allow_card_creation": False},
            {"name": "Expansion",  "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Renewal",    "color": "#F97316", "allow_card_creation": False},
            {"name": "Churned",    "color": "#EF4444", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "At Risk",               "color": "#EF4444"},
            {"name": "Champion",              "color": "#10B981"},
            {"name": "Expansion Opportunity", "color": "#F59E0B"},
            {"name": "Renewal Due",           "color": "#F97316"},
            {"name": "QBR Needed",            "color": "#8B5CF6"},
        ],
        "swimlanes": [
            {
                "name": "Acme Corp",
                "color": "#3B82F6",
                "contact_email": "ops@acme.example",
                "notes": "Mid-market. 50 seats. Champion: Head of Ops. 90-day onboarding started 2026-02-01.",
                "cards": [
                    {
                        "title": "Admin training session — 2 teams",
                        "description": (
                            "Schedule and deliver two 60-min admin training sessions covering:\n\n"
                            "- Board setup and swimlane configuration\n"
                            "- User management and roles\n"
                            "- Integrations (Slack, webhooks)\n\n"
                            "Target: Ops team (25 users) and Engineering team (25 users)."
                        ),
                        "col_idx": 0,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": [],
                        "checklist": [
                            {"text": "Book session 1 (Ops team)", "is_checked": True},
                            {"text": "Book session 2 (Engineering team)", "is_checked": False},
                            {"text": "Send pre-session setup checklist", "is_checked": True},
                            {"text": "Share recording after each session", "is_checked": False},
                        ],
                        "comments": [
                            "Session 1 done — great turnout (22/25 attended). Session 2 booked for next Tuesday.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Import historical project data from Trello",
                        "description": (
                            "Acme has 3 years of project history in Trello they want imported. "
                            "Estimated: 800 cards across 6 boards.\n\n"
                            "Use the CSV import tool. Map Trello lists → Visiban columns."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": [],
                        "checklist": [
                            {"text": "Export Trello JSON", "is_checked": True},
                            {"text": "Convert to Visiban CSV format", "is_checked": False},
                            {"text": "Test import with 50-card sample", "is_checked": False},
                            {"text": "Full import and verify", "is_checked": False},
                        ],
                        "comments": [
                            "Trello JSON exported. Working on conversion script.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "First board created and team invited",
                        "description": (
                            "Acme Ops team has created their first board and invited all 25 members. "
                            "Initial adoption looks strong — 18/25 users active in week 1.\n\n"
                            "Next: ensure Engineering team mirrors the structure."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Champion"],
                        "checklist": [
                            {"text": "Confirm all users can log in", "is_checked": True},
                            {"text": "Review board structure with champion", "is_checked": True},
                        ],
                        "comments": [
                            "Head of Ops is a strong champion — already coaching colleagues on WIP limits.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "45-day QBR — health check",
                        "description": (
                            "Quarterly Business Review at the 45-day mark.\n\n"
                            "## Agenda\n\n"
                            "1. Usage metrics review (WAU, boards created, cards moved)\n"
                            "2. Feedback on pain points\n"
                            "3. Expansion discussion (5 additional seats for Design team)\n"
                            "4. Renewal timeline (due 2026-08-01)"
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 30,
                        "weight": 3,
                        "labels": ["QBR Needed", "Expansion Opportunity"],
                        "checklist": [
                            {"text": "Pull usage report from admin panel", "is_checked": False},
                            {"text": "Prepare QBR deck", "is_checked": False},
                            {"text": "Book 60-min call with champion", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Brightfield Energy",
                "color": "#F59E0B",
                "contact_email": "digital@brightfield.example",
                "notes": "At-risk account. Usage dropped 40% MoM. Champion: Lisa Markov (Digital Director).",
                "cards": [
                    {
                        "title": "Usage dropped 40% — intervention needed",
                        "description": (
                            "Monthly active users fell from 35 to 21 between February and March. "
                            "No boards created in the last 3 weeks.\n\n"
                            "Hypothesis: team restructure following M&A activity. "
                            "Champion Lisa Markov is still in role — schedule urgent call."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 3,
                        "weight": 5,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Confirm champion is still in role", "is_checked": True},
                            {"text": "Pull full usage breakdown by user", "is_checked": True},
                            {"text": "Schedule intervention call within 48h", "is_checked": False},
                            {"text": "Prepare re-engagement plan", "is_checked": False},
                        ],
                        "comments": [
                            "Lisa confirmed she's still in role but team reorg has slowed adoption.",
                            "Call booked for Thursday. Preparing tailored re-engagement deck.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Re-engagement call with Lisa Markov",
                        "description": (
                            "Outcome of intervention call:\n\n"
                            "- Reorg is complete — 3 new team leads added\n"
                            "- Lisa will personally onboard the new leads\n"
                            "- Usage expected to recover within 30 days\n\n"
                            "Risk level: reduced from Critical to Watch."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": -2,
                        "weight": 3,
                        "labels": ["Champion"],
                        "checklist": [
                            {"text": "Send onboarding resources to new leads", "is_checked": True},
                            {"text": "Set 2-week follow-up reminder", "is_checked": False},
                        ],
                        "comments": [
                            "Call went well. Lisa is re-engaged and confident in recovery.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "At-risk recovery plan — 30-day milestones",
                        "description": (
                            "Documented recovery plan agreed with Lisa Markov:\n\n"
                            "- Week 1: New team leads onboarded\n"
                            "- Week 2: First board created by each new lead\n"
                            "- Week 4: WAU back to ≥ 30\n\n"
                            "CS will check in weekly."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Week 1: onboard 3 new leads", "is_checked": False},
                            {"text": "Week 2: first board per lead", "is_checked": False},
                            {"text": "Week 4: WAU check", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Expansion: 3 additional teams (60 seats)",
                        "description": (
                            "Following recovery, Brightfield wants to expand to 3 additional teams. "
                            "Current: 35 seats. Proposed: 95 seats.\n\n"
                            "Opportunity ACV uplift: +$14,400."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 45,
                        "weight": 3,
                        "labels": ["Expansion Opportunity"],
                        "checklist": [
                            {"text": "Send expansion proposal", "is_checked": False},
                            {"text": "Get procurement approval", "is_checked": False},
                            {"text": "Provision additional seats", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "NovaTech Solutions",
                "color": "#10B981",
                "contact_email": "cto@novatech.example",
                "notes": "Healthy account. Expanding organically. CTO is a vocal advocate.",
                "cards": [
                    {
                        "title": "Onboarding complete — all 3 teams active",
                        "description": (
                            "NovaTech completed onboarding ahead of schedule. "
                            "All 3 teams (Engineering, Product, Design) have active boards.\n\n"
                            "WAU: 42/45 users. NPS at 30-day mark: 67."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Champion"],
                        "checklist": [
                            {"text": "Complete onboarding survey", "is_checked": True},
                            {"text": "Confirm all users activated", "is_checked": True},
                        ],
                        "comments": [
                            "CTO mentioned Visiban in a company all-hands. Great advocate.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Expansion: 3 new teams want access",
                        "description": (
                            "Inbound request from CTO: Sales, Support, and HR teams want Visiban boards. "
                            "Current contract: 45 seats. New request: 90 seats total.\n\n"
                            "Route to AE for expansion proposal."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 14,
                        "weight": 3,
                        "labels": ["Expansion Opportunity"],
                        "checklist": [
                            {"text": "Brief AE on expansion opportunity", "is_checked": True},
                            {"text": "Send pricing for additional 45 seats", "is_checked": False},
                        ],
                        "comments": [
                            "AE briefed. Sending expansion proposal this week.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Renewal — 2-year deal discussion",
                        "description": (
                            "Current contract expires 2026-09-01. CTO interested in a 2-year deal "
                            "with the expanded seat count.\n\n"
                            "Potential ACV: $28,800/year for 90 seats on 2-year term."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 60,
                        "weight": 4,
                        "labels": ["Renewal Due", "Expansion Opportunity"],
                        "checklist": [
                            {"text": "Prepare 2-year renewal proposal", "is_checked": False},
                            {"text": "Include expansion seats in proposal", "is_checked": False},
                            {"text": "Present to CTO and CFO", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Clearwater Bank",
                "color": "#6366F1",
                "contact_email": "vendor-mgmt@clearwaterbank.example",
                "notes": "Financial sector — slow procurement. CISO approval required for all vendor tools.",
                "cards": [
                    {
                        "title": "CISO approval for data residency",
                        "description": (
                            "Clearwater Bank requires CISO sign-off before any data is entered. "
                            "Key requirement: all data must reside in their approved AWS region (us-east-1).\n\n"
                            "Provide architecture diagram and data flow documentation."
                        ),
                        "col_idx": 0,
                        "priority": "urgent",
                        "due_offset": 7,
                        "weight": 5,
                        "labels": [],
                        "checklist": [
                            {"text": "Share architecture diagram", "is_checked": True},
                            {"text": "Confirm us-east-1 data residency in writing", "is_checked": False},
                            {"text": "Schedule CISO review call", "is_checked": False},
                        ],
                        "comments": [
                            "CISO review call booked for next Wednesday.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Security questionnaire (47 questions)",
                        "description": (
                            "Clearwater InfoSec sent their standard 47-question vendor security form. "
                            "Deadline: 2026-03-10 (OVERDUE).\n\n"
                            "Coordinate with InfoSec lead to complete within 2 business days."
                        ),
                        "col_idx": 0,
                        "priority": "high",
                        "due_offset": -5,
                        "weight": 4,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Sections 1–10: infrastructure", "is_checked": True},
                            {"text": "Sections 11–20: access controls", "is_checked": True},
                            {"text": "Sections 21–47: compliance", "is_checked": False},
                        ],
                        "comments": [
                            "OVERDUE by 5 days. Escalated to InfoSec lead — expediting.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Adoption stalled at 30% — new team leads not onboarded",
                        "description": (
                            "3 weeks post-launch, only 15/50 users are active (30%). "
                            "Root cause: 4 team leads have not completed setup, so their teams are waiting.\n\n"
                            "Action: direct outreach to each team lead with a personalised setup guide."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Identify the 4 blocked team leads", "is_checked": True},
                            {"text": "Send personalised setup guides", "is_checked": False},
                            {"text": "Offer 1:1 setup calls", "is_checked": False},
                            {"text": "Check adoption rate at 2-week mark", "is_checked": False},
                        ],
                        "comments": [
                            "Outreach sent to all 4 leads. Two have responded and booked setup calls.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Executive sponsor re-engaged after champion call",
                        "description": (
                            "The Head of Digital Banking (executive sponsor) attended the recovery call "
                            "and is now actively promoting Visiban internally.\n\n"
                            "He has mandated all 8 project teams adopt Visiban by end of Q2."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Champion"],
                        "checklist": [
                            {"text": "Send executive overview deck", "is_checked": True},
                            {"text": "Book Q2 rollout planning session", "is_checked": False},
                        ],
                        "comments": [
                            "This changes the trajectory. Q2 mandate will drive adoption without CS intervention.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Zephyr Logistics",
                "color": "#EF4444",
                "contact_email": "it@zephyrlogistics.example",
                "notes": "Churned 2026-02-28. Contract not renewed. Re-engagement planned for Q4.",
                "cards": [
                    {
                        "title": "Contract not renewed — churn confirmed",
                        "description": (
                            "Zephyr Logistics did not renew their contract (expired 2026-02-28). "
                            "Primary reason given: 'Tool too complex for our ops team.'\n\n"
                            "Secondary reason: budget cuts across the company."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": [],
                        "checklist": [
                            {"text": "Log churn reason in CRM", "is_checked": True},
                            {"text": "Deprovision accounts", "is_checked": True},
                            {"text": "Archive board data per retention policy", "is_checked": True},
                        ],
                        "comments": [
                            "Churn logged. Primary reason: complexity. Consider flagging UX feedback to product.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Exit interview completed",
                        "description": (
                            "30-min exit interview with IT Manager.\n\n"
                            "Key feedback:\n"
                            "- Onboarding was too long (took 6 weeks)\n"
                            "- Mobile experience was poor for field workers\n"
                            "- Would consider returning if mobile UX improves\n\n"
                            "Filed UX feedback for product team: issues #312, #313."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": [],
                        "checklist": [
                            {"text": "Document feedback verbatim", "is_checked": True},
                            {"text": "File product issues from feedback", "is_checked": True},
                        ],
                        "comments": [
                            "Good feedback. Mobile UX is a known gap — this reinforces the priority.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Q4 re-engagement campaign",
                        "description": (
                            "Plan outreach to Zephyr for Q4 2026 based on:\n\n"
                            "1. Improved mobile UX (roadmap item for Q3)\n"
                            "2. New simplified onboarding flow\n"
                            "3. Pricing flexibility for logistics sector\n\n"
                            "Target contact: same IT Manager who gave positive exit feedback."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 90,
                        "weight": 2,
                        "labels": [],
                        "checklist": [
                            {"text": "Monitor mobile UX roadmap progress", "is_checked": False},
                            {"text": "Draft re-engagement email template", "is_checked": False},
                            {"text": "Set Q4 calendar reminder", "is_checked": True},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
        ],
    },

    # ── Simple Kanban ─────────────────────────────────────────────────────────
    "simple_kanban": {
        "board_name": "Template: Simple Kanban",
        "description": (
            "General-purpose kanban board for engineering teams. "
            "Each swimlane represents a team or workstream."
        ),
        "columns": [
            {"name": "Backlog",     "color": "#6B7280", "allow_card_creation": True},
            {"name": "To Do",       "color": "#3B82F6", "allow_card_creation": True},
            {"name": "In Progress", "color": "#F59E0B", "allow_card_creation": False},
            {"name": "In Review",   "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "Done",        "color": "#10B981", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Bug",       "color": "#EF4444"},
            {"name": "Feature",   "color": "#3B82F6"},
            {"name": "Improve",   "color": "#10B981"},
            {"name": "Tech Debt", "color": "#9CA3AF"},
            {"name": "Blocked",   "color": "#F97316"},
        ],
        "swimlanes": [
            {
                "name": "Frontend",
                "color": "#3B82F6",
                "contact_email": "",
                "notes": "React / TypeScript. Owns all UI components, pages, and the design system.",
                "cards": [
                    {
                        "title": "Redesign card detail modal layout",
                        "description": (
                            "The card detail modal is crowded on smaller screens. "
                            "Proposed layout:\n\n"
                            "- Move assignee + due date to a sidebar\n"
                            "- Give description full-width space\n"
                            "- Collapse checklist by default"
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Design review sign-off", "is_checked": True},
                            {"text": "Implement new layout", "is_checked": True},
                            {"text": "Responsive test at 375px and 1280px", "is_checked": False},
                        ],
                        "comments": [
                            "Design approved. Implementation underway.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Fix focus trap in dropdown menus",
                        "description": (
                            "Tab key escapes the dropdown menu when it reaches the last item. "
                            "Should cycle back to the first item.\n\n"
                            "Affects: FilterBar, SelectDropdown, column header menu."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 3,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Add focus trap to SelectDropdown", "is_checked": True},
                            {"text": "Add focus trap to FilterBar", "is_checked": False},
                            {"text": "Accessibility audit after fix", "is_checked": False},
                        ],
                        "comments": [
                            "SelectDropdown fixed. FilterBar next.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Accessibility audit: WCAG 2.1 AA compliance",
                        "description": (
                            "Run a full WCAG 2.1 AA audit on the board view and card detail. "
                            "Use axe-core and manual keyboard navigation testing.\n\n"
                            "File individual issues for each violation found."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 21,
                        "weight": 5,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Run axe-core on board view", "is_checked": False},
                            {"text": "Manual keyboard navigation test", "is_checked": False},
                            {"text": "File issues for each violation", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Dark mode flicker on page load",
                        "description": (
                            "When the OS is in dark mode, there is a brief white flash before "
                            "the dark theme is applied. Caused by: theme class applied after "
                            "first paint.\n\n"
                            "Fix: inline theme script in `<head>` before `<body>` renders."
                        ),
                        "col_idx": 3,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Add inline theme detection script to index.html", "is_checked": True},
                            {"text": "Test on Chrome, Firefox, Safari", "is_checked": True},
                            {"text": "Verify no flash on cold load", "is_checked": False},
                        ],
                        "comments": [
                            "Inline script added. Testing in progress.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Keyboard shortcut N to open quick-add card",
                        "description": (
                            "Pressing `N` (when no input is focused) should open a quick-add modal "
                            "pre-scoped to the last focused column/swimlane cell.\n\n"
                            "Implementation:\n"
                            "- Listen for `keydown` on `BoardView`\n"
                            "- Track last focused cell in a ref\n"
                            "- Open `CreateCardModal` with column + swimlane pre-filled"
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 3,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Implement keydown listener in BoardView", "is_checked": True},
                            {"text": "Track last focused cell in ref", "is_checked": False},
                            {"text": "Wire up CreateCardModal", "is_checked": False},
                            {"text": "Test: N does nothing when input focused", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Backend",
                "color": "#10B981",
                "contact_email": "",
                "notes": "Django / Python. Owns API, models, background tasks, and WebSocket layer.",
                "cards": [
                    {
                        "title": "Rate limiting on authentication endpoints",
                        "description": (
                            "Add per-IP and per-user rate limiting to `POST /api/auth/login/` "
                            "and `POST /api/auth/token/refresh/`.\n\n"
                            "Use `django-ratelimit`. Limits: 10 req/min per IP, 5 req/min per user."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Install django-ratelimit", "is_checked": True},
                            {"text": "Apply to login endpoint", "is_checked": True},
                            {"text": "Apply to token refresh endpoint", "is_checked": False},
                            {"text": "Add integration tests for limit exceeded (429)", "is_checked": False},
                        ],
                        "comments": [
                            "Login endpoint rate-limited. Refresh endpoint next.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Refactor card move endpoint to use a serializer",
                        "description": (
                            "The `POST /api/cards/{id}/move/` view contains too much business logic. "
                            "Move validation and WIP check logic into a `CardMoveSerializer`.\n\n"
                            "This makes the logic unit-testable and removes the view's fat."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Tech Debt"],
                        "checklist": [
                            {"text": "Write CardMoveSerializer with validation", "is_checked": False},
                            {"text": "Move WIP check into serializer", "is_checked": False},
                            {"text": "Update view to use serializer", "is_checked": False},
                            {"text": "Add unit tests for serializer", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "N+1 query in BoardFullSerializer.get_members()",
                        "description": (
                            "Loading `/api/boards/{id}/full/` issues one query per member to "
                            "resolve inherited group roles. On a 15-member board this is 15 extra queries.\n\n"
                            "Fix: add `prefetch_related('memberships__user__groups')` to the viewset queryset."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": -2,
                        "weight": 5,
                        "labels": ["Bug", "Tech Debt"],
                        "checklist": [
                            {"text": "Profile with django-silk to confirm N+1", "is_checked": True},
                            {"text": "Add prefetch_related", "is_checked": True},
                            {"text": "Benchmark: confirm query count drops", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed: 15 extra queries on a 15-member board.",
                            "prefetch_related added — down to 4 total queries. Benchmarking.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Email notification Celery worker",
                        "description": (
                            "Build the Celery task that sends email notifications for:\n\n"
                            "- Card assigned to me\n"
                            "- @mention in comment\n"
                            "- Due date approaching (< 24h)\n\n"
                            "Idempotent: skip if notification already sent today."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 30,
                        "weight": 4,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Define Notification model", "is_checked": False},
                            {"text": "Write send_notification Celery task", "is_checked": False},
                            {"text": "Wire signals for assignment + mention", "is_checked": False},
                            {"text": "Test with real SMTP in staging", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Audit log pagination (cursor-based)",
                        "description": (
                            "The `GET /api/boards/{id}/movements/` endpoint returns all records "
                            "without pagination. On active boards this can be 10,000+ records.\n\n"
                            "Implement cursor-based pagination using `created_at` as the cursor."
                        ),
                        "col_idx": 4,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Implement CursorPagination on movements endpoint", "is_checked": True},
                            {"text": "Update frontend to use cursor token", "is_checked": True},
                            {"text": "Test with 10,000-record board", "is_checked": True},
                        ],
                        "comments": [
                            "Done. Frontend updated to load-more pattern.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "DevOps",
                "color": "#F59E0B",
                "contact_email": "",
                "notes": "Owns CI/CD, Docker, Helm, infrastructure, and deployment pipelines.",
                "cards": [
                    {
                        "title": "Add readiness probe to Helm chart",
                        "description": (
                            "The Django service has no readiness probe — Kubernetes routes traffic "
                            "to pods before migrations have finished running.\n\n"
                            "Add an HTTP readiness probe on `/api/health/` that returns 200 only "
                            "when migrations are complete."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 2,
                        "weight": 3,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Add /api/health/ endpoint", "is_checked": True},
                            {"text": "Wire migration check into health endpoint", "is_checked": True},
                            {"text": "Update Helm chart with readinessProbe", "is_checked": False},
                        ],
                        "comments": [
                            "Health endpoint done. Helm chart update in PR.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Postgres upgrade from 14 to 16",
                        "description": (
                            "Postgres 14 reaches EOL in November 2026. Plan and execute upgrade:\n\n"
                            "1. Test on staging with pg_upgrade\n"
                            "2. Verify all queries still work\n"
                            "3. Coordinate downtime window with team\n"
                            "4. Upgrade production"
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 45,
                        "weight": 5,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Test pg_upgrade on staging DB dump", "is_checked": False},
                            {"text": "Run full test suite on PG16", "is_checked": False},
                            {"text": "Schedule maintenance window", "is_checked": False},
                            {"text": "Upgrade production", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Add Bandit security scan to CI pipeline",
                        "description": (
                            "Run `bandit -r backend/` on every MR. Fail the pipeline on HIGH severity findings.\n\n"
                            "Add to `.gitlab-ci.yml` as a new `security` stage job."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Add bandit to requirements-dev.txt", "is_checked": True},
                            {"text": "Add security stage to .gitlab-ci.yml", "is_checked": True},
                            {"text": "Fix any existing HIGH findings", "is_checked": True},
                        ],
                        "comments": [
                            "Bandit added. 2 HIGH findings fixed (shell=True, hardcoded secret in test).",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Reduce Docker image size (current: 1.2 GB)",
                        "description": (
                            "The production Docker image is 1.2 GB. Target: < 400 MB.\n\n"
                            "Quick wins:\n"
                            "- Multi-stage build (separate build and runtime stages)\n"
                            "- Use `python:3.12-slim` as base\n"
                            "- Remove dev dependencies from final image"
                        ),
                        "col_idx": 2,
                        "priority": "low",
                        "due_offset": 14,
                        "weight": 3,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Switch to multi-stage Dockerfile", "is_checked": True},
                            {"text": "Use python:3.12-slim base", "is_checked": True},
                            {"text": "Measure final image size", "is_checked": False},
                        ],
                        "comments": [
                            "Multi-stage done. Image now 380 MB.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Staging environment auto-refresh on main merge",
                        "description": (
                            "Staging should automatically deploy the latest `main` branch on every merge. "
                            "Currently requires a manual trigger.\n\n"
                            "Add a GitLab CI deploy stage targeting `staging` environment."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Add staging deploy job to CI", "is_checked": False},
                            {"text": "Configure GitLab environment for staging", "is_checked": False},
                            {"text": "Test auto-deploy on a test merge", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "QA",
                "color": "#8B5CF6",
                "contact_email": "",
                "notes": "Owns test strategy, Playwright E2E suite, and release sign-off.",
                "cards": [
                    {
                        "title": "E2E test: card drag and drop across columns",
                        "description": (
                            "Write a Playwright E2E test covering:\n\n"
                            "1. Drag card from column A to column B\n"
                            "2. Verify card appears in column B\n"
                            "3. Verify CardMovement record is created\n"
                            "4. Verify WIP count updates in column headers"
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Write drag helper utility", "is_checked": True},
                            {"text": "Write happy-path drag test", "is_checked": True},
                            {"text": "Write WIP limit exceeded test", "is_checked": False},
                        ],
                        "comments": [
                            "Happy path done. WIP limit test in progress.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Regression suite for v1.1 release",
                        "description": (
                            "Build a regression test suite covering the core flows changed in v1.1:\n\n"
                            "- Card create / edit / delete\n"
                            "- Swimlane reorder\n"
                            "- Label management\n"
                            "- Board member invite\n\n"
                            "Target: 20 tests, all passing before v1.1 ships."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Card CRUD tests", "is_checked": False},
                            {"text": "Swimlane reorder test", "is_checked": False},
                            {"text": "Label management tests", "is_checked": False},
                            {"text": "Board member invite test", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Load test: 100 concurrent users on board view",
                        "description": (
                            "Run a Locust load test simulating 100 concurrent users loading the board view. "
                            "Acceptance criteria:\n\n"
                            "- p95 response time < 800ms\n"
                            "- No 5xx errors under load\n"
                            "- Memory usage < 512MB per worker"
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": -1,
                        "weight": 5,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Write Locust scenario for board load", "is_checked": True},
                            {"text": "Run 100-user test on staging", "is_checked": True},
                            {"text": "Document results and recommendations", "is_checked": False},
                        ],
                        "comments": [
                            "p95: 650ms. No 5xx. Memory OK. Writing up results.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Mobile browser testing matrix",
                        "description": (
                            "Define and execute a manual test matrix across:\n\n"
                            "| Device | Browser |\n"
                            "| --- | --- |\n"
                            "| iPhone 15 | Safari |\n"
                            "| iPhone SE | Safari |\n"
                            "| Pixel 7 | Chrome |\n"
                            "| Samsung Galaxy | Samsung Internet |"
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 21,
                        "weight": 3,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "iPhone 15 Safari", "is_checked": False},
                            {"text": "iPhone SE Safari", "is_checked": False},
                            {"text": "Pixel 7 Chrome", "is_checked": False},
                            {"text": "Samsung Galaxy Samsung Internet", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Fix flaky Playwright test #148 (swimlane reorder)",
                        "description": (
                            "Test #148 fails intermittently (~1 in 8 runs) because it clicks "
                            "the drag handle before the animation from the previous test completes.\n\n"
                            "Fix: add `await page.waitForSelector('.drag-handle:visible')` before the drag."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Add waitForSelector before drag", "is_checked": True},
                            {"text": "Run test 20 times to confirm stability", "is_checked": True},
                        ],
                        "comments": [
                            "Ran 25 times — 0 failures. Considered fixed.",
                        ],
                        "assignee_idx": 1,
                    },
                ],
            },
        ],
    },

    # ── Other templates — added in subsequent tasks ───────────────────────────
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
