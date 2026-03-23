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
            "Track open deals from first contact through close. "
            "Each swimlane is an account; each card is a deal or opportunity."
        ),
        "columns": [
            {"name": "Prospect",      "color": "#6B7280", "allow_card_creation": True},
            {"name": "Qualified",     "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Discovery",     "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "Demo",          "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Proposal Sent", "color": "#F97316", "allow_card_creation": False},
            {"name": "Negotiation",   "color": "#EF4444", "allow_card_creation": False},
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
                "notes": "Series C SaaS, 500-seat target. Champion: VP Engineering. Pain: outgrown Jira.",
                "cards": [
                    {
                        "title": "Platform Migration — 500 Seats",
                        "description": (
                            "Opportunity to displace Jira across all engineering teams. "
                            "Champion is the VP Engineering. Budget approved for Q2.\n\n"
                            "## Situation\n\n"
                            "- 12 engineering teams, ~500 users\n"
                            "- Current pain: Jira too rigid for cross-team swimlane workflows\n"
                            "- Decision by 2026-04-30"
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 5,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Send custom proposal deck", "is_checked": True},
                            {"text": "Confirm security questionnaire complete", "is_checked": True},
                            {"text": "Schedule executive sign-off call", "is_checked": False},
                        ],
                        "comments": [
                            "VP Engineering confirmed budget. Legal review starts Monday.",
                            "They want swimlane-level WIP limits — confirm this is on the roadmap.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Engineering Hub Expansion — 200 Seats",
                        "description": (
                            "Expansion deal targeting the infrastructure and platform teams "
                            "not included in the original pilot.\n\n"
                            "Upsell conversation triggered by strong pilot NPS (62)."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 21,
                        "weight": 4,
                        "labels": ["Enterprise", "Renewal"],
                        "checklist": [
                            {"text": "Map out teams not yet on platform", "is_checked": True},
                            {"text": "Book discovery call with infra lead", "is_checked": False},
                        ],
                        "comments": [
                            "Pilot NPS is 62. Good timing to bring up expansion.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Analytics Add-on Upsell",
                        "description": (
                            "TechNova data team interested in the analytics module. "
                            "Current deal is base license only.\n\n"
                            "Estimated uplift: +$12k ARR."
                        ),
                        "col_idx": 1,
                        "priority": "low",
                        "due_offset": 30,
                        "weight": 2,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Identify analytics champion in data team", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Apex Retail Group",
                "color": "#F59E0B",
                "contact_email": "tech@apexretail.example",
                "notes": "200-location retail chain. Decision maker: CTO. Seasonal budget freeze Jan-Mar.",
                "cards": [
                    {
                        "title": "Operations Board Rollout — 200 Locations",
                        "description": (
                            "Each retail location tracks their own ops tasks on a shared board. "
                            "Swimlane-per-region model.\n\n"
                            "Demo focused on the mobile card creation flow and daily standup view."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["SMB", "Strategic"],
                        "checklist": [
                            {"text": "Prepare retail-specific demo board", "is_checked": True},
                            {"text": "Run live demo with CTO", "is_checked": True},
                            {"text": "Send follow-up with pricing options", "is_checked": False},
                        ],
                        "comments": [
                            "Demo landed well. CTO liked the per-region swimlane view.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Seasonal Campaign Tracker Pilot",
                        "description": (
                            "Pilot for the marketing team tracking seasonal campaign tasks. "
                            "10 seats, 60 days. Success criteria: all Q3 campaigns tracked in Visiban."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 20,
                        "weight": 3,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Qualify with marketing lead", "is_checked": True},
                            {"text": "Provision 10 trial seats", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Full Org Rollout — 300 Seats",
                        "description": (
                            "Following successful pilot, Apex wants to roll out to all ops, "
                            "marketing, and logistics teams.\n\n"
                            "Negotiating a 3-year enterprise agreement."
                        ),
                        "col_idx": 5,
                        "priority": "urgent",
                        "due_offset": 5,
                        "weight": 5,
                        "labels": ["SMB", "Strategic", "Renewal"],
                        "checklist": [
                            {"text": "Draft 3-year MSA", "is_checked": True},
                            {"text": "Get legal sign-off on SLA clause", "is_checked": True},
                            {"text": "Confirm seat count with Apex procurement", "is_checked": False},
                            {"text": "Execute agreement", "is_checked": False},
                        ],
                        "comments": [
                            "CTO pushing hard to close before Q2 budget cycle closes.",
                            "Legal flagged the liability cap — escalated to VP Sales.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "FinEdge Ltd",
                "color": "#8B5CF6",
                "contact_email": "procurement@finedge.example",
                "notes": "Fintech startup, 80 staff. Compliance-heavy. VP Product is champion.",
                "cards": [
                    {
                        "title": "Compliance Workflow License — 80 Seats",
                        "description": (
                            "FinEdge tracks regulatory submissions and internal audit cycles. "
                            "Primary use case: legal/compliance boards per regulation.\n\n"
                            "Competing against Notion and a custom Airtable setup."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 12,
                        "weight": 4,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send SOC 2 Type II report", "is_checked": True},
                            {"text": "Complete GDPR data processing addendum", "is_checked": False},
                            {"text": "Book technical deep-dive with their engineering team", "is_checked": False},
                        ],
                        "comments": [
                            "VP Product confirmed Notion is a weak competitor here — they need structure.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Engineering Team Add-on — 40 Seats",
                        "description": (
                            "After closing the compliance deal, the engineering team wants "
                            "to adopt Visiban for sprint planning.\n\n"
                            "Upsell opportunity: +40 seats at standard rate."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": 8,
                        "weight": 3,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Send add-on order form", "is_checked": True},
                            {"text": "Confirm provisioning date", "is_checked": False},
                        ],
                        "comments": [
                            "Engineering lead wants to start before the compliance rollout completes.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Risk Dashboard Integration — Lost",
                        "description": (
                            "FinEdge wanted native integration with their risk management platform. "
                            "We could not commit to a timeline.\n\n"
                            "Deal lost to a competitor with out-of-the-box integration."
                        ),
                        "col_idx": 7,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Log loss reason in CRM", "is_checked": True},
                            {"text": "Flag integration gap to product team", "is_checked": True},
                        ],
                        "comments": [
                            "Loss reason: missing native risk tool integration. Adding to product backlog.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "BlueSky Health",
                "color": "#10B981",
                "contact_email": "procurement@blueskyhealth.example",
                "notes": "Regional healthcare provider. HIPAA BAA required. 200-seat potential.",
                "cards": [
                    {
                        "title": "Clinical Project Tracking — Initial Outreach",
                        "description": (
                            "Inbound inquiry from IT Director. Interested in tracking "
                            "clinical IT projects across 5 hospitals.\n\n"
                            "HIPAA BAA will be required before any data sharing."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 25,
                        "weight": 2,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Respond to inbound inquiry", "is_checked": True},
                            {"text": "Send HIPAA BAA for review", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "IT Operations Board — 50 Seats",
                        "description": (
                            "Opportunity with the IT ops team tracking infrastructure changes. "
                            "Separate from the clinical project deal.\n\n"
                            "Champion: IT Director. Decision maker: CIO."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 18,
                        "weight": 3,
                        "labels": ["Enterprise", "Strategic"],
                        "checklist": [
                            {"text": "Qualify with IT Director", "is_checked": True},
                            {"text": "Request intro to CIO", "is_checked": False},
                        ],
                        "comments": [
                            "IT Director is strong champion. CIO meeting requested for next week.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Enterprise Renewal — 200 Seats",
                        "description": (
                            "Annual renewal coming up for existing 200-seat enterprise contract. "
                            "Opportunity to upsell analytics module (+$18k ARR).\n\n"
                            "Renewal date: 2026-05-01."
                        ),
                        "col_idx": 5,
                        "priority": "urgent",
                        "due_offset": -5,
                        "weight": 5,
                        "labels": ["Enterprise", "Renewal", "Strategic"],
                        "checklist": [
                            {"text": "Send renewal quote with analytics upsell", "is_checked": True},
                            {"text": "Schedule QBR with CIO", "is_checked": True},
                            {"text": "Get signed renewal order form", "is_checked": False},
                        ],
                        "comments": [
                            "QBR went well. CIO open to analytics module — needs board approval.",
                            "OVERDUE — renewal date is in 5 days. Escalated to VP Sales.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Mosaic Creative",
                "color": "#EC4899",
                "contact_email": "ops@mosaiccreative.example",
                "notes": "Creative agency, 30 staff. Fast-moving. Decision in days, not weeks.",
                "cards": [
                    {
                        "title": "Content Calendar Boards — 30 Seats",
                        "description": (
                            "Mosaic tracks every client content campaign on shared boards. "
                            "Use case: one swimlane per client, columns = content stages.\n\n"
                            "Evaluating Trello, Asana, and Visiban."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Send content agency template", "is_checked": True},
                            {"text": "Run 30-min discovery call", "is_checked": True},
                            {"text": "Provide trial access", "is_checked": False},
                        ],
                        "comments": [
                            "They love the swimlane-per-client model. Trello can not do this cleanly.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Campaign Sprint Boards — Closed Won",
                        "description": (
                            "Mosaic signed for 30 seats on a monthly plan. "
                            "Primary use: campaign sprint boards per client.\n\n"
                            "Upsell opportunity at 90-day check-in: annual plan + 10 extra seats."
                        ),
                        "col_idx": 6,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["SMB", "Renewal"],
                        "checklist": [
                            {"text": "Provision 30 seats", "is_checked": True},
                            {"text": "Send onboarding guide", "is_checked": True},
                            {"text": "Set 90-day upsell reminder", "is_checked": True},
                        ],
                        "comments": [
                            "Closed in 4 days from first contact. Fastest close this quarter.",
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
            "Each swimlane is a customer account; each card is an open ticket."
        ),
        "columns": [
            {"name": "New",               "color": "#6B7280", "allow_card_creation": True},
            {"name": "Triaged",           "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Investigating",     "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Awaiting Customer", "color": "#F97316", "allow_card_creation": False},
            {"name": "Escalated",         "color": "#EF4444", "allow_card_creation": False},
            {"name": "Resolved",          "color": "#10B981", "allow_card_creation": False},
            {"name": "Closed",            "color": "#9CA3AF", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Bug",             "color": "#EF4444"},
            {"name": "Feature Request", "color": "#8B5CF6"},
            {"name": "Billing",         "color": "#F59E0B"},
            {"name": "Security",        "color": "#EC4899"},
            {"name": "Performance",     "color": "#14B8A6"},
        ],
        "swimlanes": [
            {
                "name": "TechNova Inc",
                "color": "#3B82F6",
                "contact_email": "support@technova.example",
                "notes": "Enterprise tier. SLA: 4-hour response, 24-hour resolution for P1.",
                "cards": [
                    {
                        "title": "Board loads blank after login on Firefox 124",
                        "description": (
                            "Reported by 3 users. Board appears empty immediately after login "
                            "on Firefox 124.0. Works on Chrome and Safari.\n\n"
                            "## Steps to reproduce\n\n"
                            "1. Log in on Firefox 124\n"
                            "2. Navigate to any board\n"
                            "3. Board renders blank — no columns visible\n"
                            "4. Hard refresh fixes it"
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 1,
                        "weight": 4,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Reproduce locally on Firefox 124", "is_checked": True},
                            {"text": "Check browser console for JS errors", "is_checked": True},
                            {"text": "Confirm fix in staging", "is_checked": False},
                            {"text": "Deploy patch and notify customer", "is_checked": False},
                        ],
                        "comments": [
                            "Reproduced. Root cause: race condition in board hydration on Firefox. Fix in progress.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "CSV export returns 500 for boards with 500+ cards",
                        "description": (
                            "TechNova's largest board has 620 cards. CSV export times out and "
                            "returns HTTP 500.\n\n"
                            "Smaller boards (< 200 cards) export fine. Likely a query timeout."
                        ),
                        "col_idx": 4,
                        "priority": "urgent",
                        "due_offset": -1,
                        "weight": 5,
                        "labels": ["Bug", "Performance"],
                        "checklist": [
                            {"text": "Reproduce with a 500+ card board", "is_checked": True},
                            {"text": "Profile query — identify N+1", "is_checked": True},
                            {"text": "Add select_related and pagination", "is_checked": True},
                            {"text": "Load test fix before deploying", "is_checked": False},
                        ],
                        "comments": [
                            "P1 escalated by account team. Engineering lead assigned.",
                            "Root cause: N+1 on label fetch. Fix ready — deploying tonight.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Column WIP limit not enforcing for board admins",
                        "description": (
                            "Board admins can drag cards into WIP-limited columns beyond the limit. "
                            "Members (non-admins) are blocked correctly.\n\n"
                            "Customer reports this defeats the purpose of WIP limits."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Confirm behavior in prod", "is_checked": True},
                            {"text": "Check permission bypass logic in drag handler", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Apex Retail Group",
                "color": "#F59E0B",
                "contact_email": "support@apexretail.example",
                "notes": "Mid-market. SLA: 8-hour response. Contact: IT Manager.",
                "cards": [
                    {
                        "title": "Card drag-drop broken on iOS Safari",
                        "description": (
                            "Store managers using iPads cannot drag cards between columns. "
                            "The drag starts but the card snaps back on drop.\n\n"
                            "iOS 17.4, Safari. Chrome on iOS works."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 2,
                        "weight": 4,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Reproduce on iOS 17.4 Safari", "is_checked": True},
                            {"text": "Check touch event handling in drag library", "is_checked": True},
                            {"text": "Send workaround to customer (use Chrome iOS)", "is_checked": True},
                            {"text": "Ship permanent fix", "is_checked": False},
                        ],
                        "comments": [
                            "Workaround sent. Permanent fix tracked in eng backlog — ETA 2 sprints.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Email notifications delayed by 2+ hours",
                        "description": (
                            "Apex staff report card assignment notifications arrive hours late. "
                            "Checked our queue — jobs are processing but SMTP relay is slow.\n\n"
                            "Affecting all email notifications, not just assignments."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Identify delay in SMTP relay logs", "is_checked": True},
                            {"text": "Switch to backup relay", "is_checked": True},
                            {"text": "Confirm notifications now timely", "is_checked": True},
                        ],
                        "comments": [
                            "Resolved. SMTP relay was throttling. Switched to backup — delays gone.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Board invite link returns 404",
                        "description": (
                            "Apex is inviting new store managers via board share links. "
                            "Half the links are returning 404.\n\n"
                            "Hypothesis: links generated before the subdomain migration are broken."
                        ),
                        "col_idx": 6,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Confirm old subdomain links are broken", "is_checked": True},
                            {"text": "Add redirect rule for old subdomain", "is_checked": True},
                            {"text": "Re-generate invite links for Apex", "is_checked": True},
                        ],
                        "comments": [
                            "Resolved. Old subdomain redirect added. Existing links now work.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "FinEdge Ltd",
                "color": "#8B5CF6",
                "contact_email": "support@finedge.example",
                "notes": "Compliance-sensitive. All support comms may be audited. Use formal language.",
                "cards": [
                    {
                        "title": "2FA not triggering on new device login",
                        "description": (
                            "FinEdge reports that 2FA challenges are not appearing when users "
                            "log in from a new device.\n\n"
                            "This is a security regression — escalated to security team immediately."
                        ),
                        "col_idx": 4,
                        "priority": "urgent",
                        "due_offset": -2,
                        "weight": 5,
                        "labels": ["Security", "Bug"],
                        "checklist": [
                            {"text": "Confirm 2FA bypass is reproducible", "is_checked": True},
                            {"text": "Identify root cause in session fingerprint logic", "is_checked": True},
                            {"text": "Deploy hotfix to production", "is_checked": True},
                            {"text": "Audit logs for any suspicious logins", "is_checked": False},
                            {"text": "Send customer security incident report", "is_checked": False},
                        ],
                        "comments": [
                            "P0 — Security team engaged immediately. Hotfix deployed at 03:14 UTC.",
                            "Root cause: device fingerprint cache key collision after last deployment.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Webhook events arriving out of order",
                        "description": (
                            "FinEdge's automation pipeline receives card move events out of sequence. "
                            "Their compliance logs then show incorrect state transitions.\n\n"
                            "Events are delivered but not guaranteed ordered — they need ordering."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Confirm event ordering issue in webhook logs", "is_checked": True},
                            {"text": "Discuss sequencing guarantee options with eng", "is_checked": False},
                            {"text": "Provide workaround (use event timestamp to reorder)", "is_checked": False},
                        ],
                        "comments": [
                            "Awaiting engineering input on whether ordered delivery is feasible.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "BlueSky Health",
                "color": "#10B981",
                "contact_email": "support@blueskyhealth.example",
                "notes": "HIPAA environment. Do not share PHI in support threads. Escalate data questions to legal.",
                "cards": [
                    {
                        "title": "Card comments missing after board migration",
                        "description": (
                            "BlueSky migrated boards from their old instance. "
                            "Card comments imported but are not visible in the UI.\n\n"
                            "Data is present in the database — this is a display bug."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 3,
                        "weight": 3,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Confirm comments exist in DB", "is_checked": True},
                            {"text": "Trace why UI is not rendering them", "is_checked": False},
                            {"text": "Deploy fix and validate all comments visible", "is_checked": False},
                        ],
                        "comments": [
                            "Confirmed: comments have a null author_id from migration script. UI filters these out.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Board member cannot see swimlane after role change",
                        "description": (
                            "A user promoted from Member to Admin lost visibility of one swimlane. "
                            "Logging out and back in resolves it — stale session permissions."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 4,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Reproduce role-change permission refresh bug", "is_checked": True},
                            {"text": "Force-clear permission cache on role update", "is_checked": False},
                        ],
                        "comments": [
                            "Workaround: ask user to log out and back in. Permanent fix in progress.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Mosaic Creative",
                "color": "#EC4899",
                "contact_email": "support@mosaiccreative.example",
                "notes": "SMB tier. Self-serve. Generally quick to resolve — low SLA pressure.",
                "cards": [
                    {
                        "title": "Label colors not saving on Safari 17",
                        "description": (
                            "Users on Safari 17 report that custom label colors revert to default "
                            "on page reload. Chrome users are unaffected."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Reproduce on Safari 17", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Due date filter returning no results",
                        "description": (
                            "The due date filter on the board view returns 0 cards even when "
                            "cards have due dates set.\n\n"
                            "Reported after the 2026-03-01 release. Likely a regression."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Confirm regression in 2026-03-01 release", "is_checked": True},
                            {"text": "Fix filter query and deploy", "is_checked": True},
                            {"text": "Confirm fix with customer", "is_checked": True},
                        ],
                        "comments": [
                            "Resolved. Date comparison was using UTC vs local timezone mismatch.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Request: bulk card archive",
                        "description": (
                            "Mosaic wants to archive all cards in a column at once at campaign end. "
                            "Currently must archive one card at a time.\n\n"
                            "Logged as a feature request."
                        ),
                        "col_idx": 6,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Feature Request"],
                        "checklist": [
                            {"text": "Log in product backlog", "is_checked": True},
                            {"text": "Notify customer when shipped", "is_checked": False},
                        ],
                        "comments": [
                            "Feature request acknowledged. Added to backlog — no ETA yet.",
                        ],
                        "assignee_idx": 0,
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
                "name": "Americas",
                "color": "#3B82F6",
                "contact_email": "csm-americas@visiban.example",
                "notes": "US + Canada + LATAM accounts. CSM: Alex Rivera.",
                "cards": [
                    {
                        "title": "TechNova Inc",
                        "description": (
                            "500-seat enterprise account. Onboarding completed ahead of schedule.\n\n"
                            "## Health signals\n\n"
                            "- WAU: 78% (target: 70%)\n"
                            "- NPS: 62\n"
                            "- Open support tickets: 2 (both minor)\n\n"
                            "Expansion conversation in progress — 200 additional seats."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 5,
                        "labels": ["Enterprise", "Expansion"],
                        "checklist": [
                            {"text": "Schedule QBR with VP Engineering", "is_checked": True},
                            {"text": "Present expansion ROI deck", "is_checked": True},
                            {"text": "Get verbal commitment on 200 seat expansion", "is_checked": False},
                            {"text": "Send expansion order form", "is_checked": False},
                        ],
                        "comments": [
                            "QBR went great. VP Engineering openly mentioned expansion plans.",
                            "NPS 62 — best in the Americas portfolio this quarter.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Summit Logistics",
                        "description": (
                            "25-seat SMB account. Month 2 of annual plan.\n\n"
                            "Low engagement — WAU sitting at 35%. Risk of churn at renewal."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Book check-in call with ops manager", "is_checked": True},
                            {"text": "Share adoption guide for mobile card creation", "is_checked": False},
                            {"text": "Set 30-day re-check reminder", "is_checked": False},
                        ],
                        "comments": [
                            "Ops manager on leave until next week. Booking call for return.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "BlueSky Health",
                        "description": (
                            "200-seat healthcare account. In renewal cycle (2026-05-01).\n\n"
                            "Healthy engagement but pushing for analytics add-on at no extra cost."
                        ),
                        "col_idx": 4,
                        "priority": "urgent",
                        "due_offset": -3,
                        "weight": 5,
                        "labels": ["Enterprise", "Renewal"],
                        "checklist": [
                            {"text": "Send renewal quote", "is_checked": True},
                            {"text": "Negotiate analytics add-on pricing", "is_checked": True},
                            {"text": "Get signed renewal form", "is_checked": False},
                        ],
                        "comments": [
                            "OVERDUE — renewal is past due. CIO is travelling. Escalated to VP CS.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "EMEA",
                "color": "#8B5CF6",
                "contact_email": "csm-emea@visiban.example",
                "notes": "Europe, Middle East, Africa. CSM: Jordan Patel.",
                "cards": [
                    {
                        "title": "FinEdge Ltd",
                        "description": (
                            "80-seat compliance-focused account. Adopted Visiban for "
                            "regulatory workflow tracking.\n\n"
                            "Engineering team (40 seats) just provisioned — still in onboarding."
                        ),
                        "col_idx": 0,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Run onboarding session 1: board setup", "is_checked": True},
                            {"text": "Run onboarding session 2: workflows and WIP limits", "is_checked": False},
                            {"text": "Confirm all 80 users have logged in", "is_checked": False},
                        ],
                        "comments": [
                            "Session 1 complete. Engineering lead very engaged.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Mosaic Creative",
                        "description": (
                            "30-seat creative agency. 3 months post-close, strong adoption.\n\n"
                            "WAU: 88%. Using swimlane-per-client model effectively."
                        ),
                        "col_idx": 2,
                        "priority": "low",
                        "due_offset": 30,
                        "weight": 2,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Send 90-day check-in survey", "is_checked": True},
                            {"text": "Propose annual plan upgrade (currently monthly)", "is_checked": False},
                        ],
                        "comments": [
                            "Happy account. Good candidate for a case study.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Apex Retail Group",
                        "description": (
                            "300-seat enterprise account, newly signed. Rollout across 200 locations.\n\n"
                            "Complex onboarding — need swimlane template for each region."
                        ),
                        "col_idx": 0,
                        "priority": "urgent",
                        "due_offset": 5,
                        "weight": 5,
                        "labels": ["Enterprise"],
                        "checklist": [
                            {"text": "Assign dedicated onboarding specialist", "is_checked": True},
                            {"text": "Create region swimlane template", "is_checked": False},
                            {"text": "Run kickoff session with Apex ops leadership", "is_checked": False},
                            {"text": "Provision all 300 seats", "is_checked": False},
                        ],
                        "comments": [
                            "Large rollout — dedicated onboarding specialist assigned.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "APAC",
                "color": "#10B981",
                "contact_email": "csm-apac@visiban.example",
                "notes": "Australia, Japan, SE Asia. CSM: Morgan Wu.",
                "cards": [
                    {
                        "title": "DataStream AU",
                        "description": (
                            "45-seat analytics firm. Adopted Visiban for sprint tracking.\n\n"
                            "Healthy engagement. Champion is Head of Engineering."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 21,
                        "weight": 2,
                        "labels": ["SMB"],
                        "checklist": [
                            {"text": "Send quarterly product update digest", "is_checked": True},
                            {"text": "Invite to APAC customer roundtable", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "NexGen Fintech JP",
                        "description": (
                            "60-seat Japanese fintech. Churned from previous provider.\n\n"
                            "Still in early adoption — ensuring they see value before 90 days."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 8,
                        "weight": 4,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Complete onboarding checklist with eng lead", "is_checked": True},
                            {"text": "Set up weekly check-in for first 90 days", "is_checked": True},
                            {"text": "Confirm WAU target met by day 60", "is_checked": False},
                        ],
                        "comments": [
                            "Previous provider churned them due to poor support. We need to overcommunicate.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Enterprise Accounts",
                "color": "#F59E0B",
                "contact_email": "enterprise-cs@visiban.example",
                "notes": "200+ seat strategic accounts managed directly by VP CS.",
                "cards": [
                    {
                        "title": "GlobalBank Corp",
                        "description": (
                            "400-seat banking enterprise. Year 2 of a 3-year agreement.\n\n"
                            "Renewal not at risk but annual business review is overdue."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Enterprise", "Renewal"],
                        "checklist": [
                            {"text": "Schedule annual business review", "is_checked": True},
                            {"text": "Prepare YoY usage and ROI report", "is_checked": False},
                            {"text": "Present roadmap preview", "is_checked": False},
                        ],
                        "comments": [
                            "ABR overdue by 3 weeks. CIO has been traveling. Meeting confirmed for Friday.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "PharmaCo Ltd",
                        "description": (
                            "350-seat pharma enterprise. Clinical and regulatory teams on separate boards.\n\n"
                            "Expansion conversation for 150 additional seats (R&D division)."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 20,
                        "weight": 3,
                        "labels": ["Enterprise", "Expansion"],
                        "checklist": [
                            {"text": "Map R&D team use cases", "is_checked": True},
                            {"text": "Send expansion proposal", "is_checked": False},
                        ],
                        "comments": [
                            "R&D director wants Visiban — IT procurement is the gatekeeper.",
                        ],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "Mid-Market",
                "color": "#EF4444",
                "contact_email": "midmarket-cs@visiban.example",
                "notes": "20-200 seat accounts. CSM coverage pooled.",
                "cards": [
                    {
                        "title": "GreenLeaf Agency",
                        "description": (
                            "50-seat digital marketing agency. Strong adoption, all teams active.\n\n"
                            "Renewal in 4 months. Low risk."
                        ),
                        "col_idx": 2,
                        "priority": "low",
                        "due_offset": 45,
                        "weight": 1,
                        "labels": ["SMB", "Renewal"],
                        "checklist": [
                            {"text": "Send renewal reminder at T-60", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Ironclad Manufacturing",
                        "description": (
                            "80-seat industrial firm. Low product adoption — WAU at 22%.\n\n"
                            "Risk: renewal in 60 days. Operations team not fully onboarded."
                        ),
                        "col_idx": 5,
                        "priority": "urgent",
                        "due_offset": None,
                        "weight": 4,
                        "labels": ["At Risk"],
                        "checklist": [
                            {"text": "Identify adoption blockers in ops team", "is_checked": True},
                            {"text": "Offer complimentary re-onboarding session", "is_checked": True},
                            {"text": "Set 2-week re-engagement goal", "is_checked": False},
                        ],
                        "comments": [
                            "Account manager says ops team resists new tools. Need exec sponsor.",
                        ],
                        "assignee_idx": 4,
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

    # ── Product Roadmap ───────────────────────────────────────────────────────
    "product_roadmap": {
        "board_name": "Template: Product Roadmap",
        "description": (
            "Track features from idea through general availability. "
            "Each swimlane represents a product line or area."
        ),
        "columns": [
            {"name": "Idea",       "color": "#8B5CF6", "allow_card_creation": True},
            {"name": "Scored",     "color": "#6B7280", "allow_card_creation": True},
            {"name": "Roadmapped", "color": "#3B82F6", "allow_card_creation": False},
            {"name": "In Dev",     "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Beta / QA",  "color": "#F97316", "allow_card_creation": False},
            {"name": "GA",         "color": "#10B981", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Core",       "color": "#3B82F6"},
            {"name": "Platform",   "color": "#8B5CF6"},
            {"name": "UX",         "color": "#EC4899"},
            {"name": "Compliance", "color": "#EF4444"},
            {"name": "AI / ML",    "color": "#10B981"},
        ],
        "swimlanes": [
            {
                "name": "Mobile App",
                "color": "#3B82F6",
                "contact_email": "",
                "notes": "iOS and Android. Targets field workers and on-the-go board access.",
                "cards": [
                    {
                        "title": "Push notifications for due date approaching",
                        "description": (
                            "Send a push notification to the card assignee 24h before the due date.\n\n"
                            "## Acceptance criteria\n\n"
                            "- Notification delivered within 5 min of the 24h threshold\n"
                            "- Tapping notification opens the card directly\n"
                            "- Users can opt out per-notification type in Settings"
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Backend: due-date notification Celery task", "is_checked": True},
                            {"text": "Mobile: register for push via FCM/APNs", "is_checked": True},
                            {"text": "Deep link: open card from notification", "is_checked": False},
                            {"text": "Settings: per-type opt-out toggles", "is_checked": False},
                        ],
                        "comments": [
                            "Backend task done. Mobile registration in progress.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Offline mode: optimistic updates + sync on reconnect",
                        "description": (
                            "Allow users to move cards and add comments while offline. "
                            "Changes are queued locally (IndexedDB) and synced when connectivity resumes.\n\n"
                            "Conflict resolution: server wins for concurrent edits."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 30,
                        "weight": 5,
                        "labels": ["Core", "Platform"],
                        "checklist": [
                            {"text": "Design offline queue data model", "is_checked": True},
                            {"text": "Implement IndexedDB queue", "is_checked": False},
                            {"text": "Implement sync-on-reconnect", "is_checked": False},
                            {"text": "Conflict resolution strategy documented", "is_checked": False},
                        ],
                        "comments": [
                            "Data model designed. Complex feature — will take 2 sprints.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Drag-to-reorder cards on mobile (touch DnD)",
                        "description": (
                            "Desktop drag-and-drop uses pointer events. Touch devices need a separate "
                            "touch sensor with a 250ms long-press to initiate drag.\n\n"
                            "Use `@dnd-kit/core` `TouchSensor` with appropriate activation constraints."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["UX"],
                        "checklist": [
                            {"text": "Configure TouchSensor in useDraggable", "is_checked": True},
                            {"text": "Test on iOS Safari and Android Chrome", "is_checked": False},
                            {"text": "Handle scroll lock during drag", "is_checked": False},
                        ],
                        "comments": [
                            "TouchSensor configured. iOS Safari scroll lock conflict to resolve.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Deep link: open card from push notification",
                        "description": (
                            "Push notifications should deep-link directly to the relevant card. "
                            "URL scheme: `visiban://boards/{board_id}/cards/{card_id}`\n\n"
                            "Handle both cold-start (app not running) and warm-start (app in background)."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": -3,
                        "weight": 3,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Register URL scheme in iOS/Android manifests", "is_checked": True},
                            {"text": "Handle cold-start deep link", "is_checked": True},
                            {"text": "Handle warm-start deep link", "is_checked": False},
                        ],
                        "comments": [
                            "Cold-start works. Warm-start has a navigation timing issue.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Dark mode support on iOS 17",
                        "description": (
                            "iOS 17 users reported the app ignores system dark mode preference. "
                            "The web view background renders white behind the app chrome.\n\n"
                            "Fix: add `color-scheme: dark` meta tag and ensure all surfaces use "
                            "the dark token palette."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["UX"],
                        "checklist": [
                            {"text": "Add color-scheme meta tag", "is_checked": True},
                            {"text": "Audit surface colors in dark mode", "is_checked": True},
                            {"text": "Test on iPhone 15 iOS 17", "is_checked": True},
                        ],
                        "comments": [
                            "Released in v1.2.1. No further reports.",
                        ],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "API Platform",
                "color": "#8B5CF6",
                "contact_email": "",
                "notes": "Public REST API, webhooks, OAuth, and developer experience.",
                "cards": [
                    {
                        "title": "Webhook delivery retries with exponential backoff",
                        "description": (
                            "Currently, failed webhook deliveries are retried immediately 3× with no delay. "
                            "Replace with exponential backoff: 1min, 5min, 30min, then give up.\n\n"
                            "Store delivery attempts and status in a `WebhookDelivery` model for debugging."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Add WebhookDelivery model and migration", "is_checked": True},
                            {"text": "Implement exponential backoff in Celery task", "is_checked": True},
                            {"text": "Add delivery log to developer dashboard", "is_checked": False},
                        ],
                        "comments": [
                            "Model and backoff logic done. Dashboard view in progress.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "GraphQL endpoint for board data",
                        "description": (
                            "Some enterprise customers want a GraphQL API to query specific card fields "
                            "without loading the full board payload.\n\n"
                            "Use `strawberry-graphql`. Expose: boards, columns, swimlanes, cards (read-only)."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Evaluate strawberry-graphql vs graphene", "is_checked": False},
                            {"text": "Design schema", "is_checked": False},
                            {"text": "Prototype with board + card types", "is_checked": False},
                        ],
                        "comments": [
                            "Backlogged — REST API covers most use cases. Revisit based on demand.",
                        ],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Per-token rate limiting on public API",
                        "description": (
                            "Apply per-API-token rate limits to all public endpoints. "
                            "Default: 1,000 req/hour. Enterprise: 10,000 req/hour.\n\n"
                            "Return `X-RateLimit-Remaining` and `Retry-After` headers."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["Platform", "Compliance"],
                        "checklist": [
                            {"text": "Implement rate limit middleware", "is_checked": True},
                            {"text": "Add X-RateLimit headers", "is_checked": True},
                            {"text": "Test 429 response format", "is_checked": True},
                            {"text": "Document limits in API reference", "is_checked": False},
                        ],
                        "comments": [
                            "Middleware done and tested. Docs update in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "API v2 planning: deprecate v1 field naming",
                        "description": (
                            "Several v1 field names are inconsistent (e.g. `last_moved` vs `last_moved_at`). "
                            "v2 will standardise naming and clean up deprecated fields.\n\n"
                            "v1 must remain fully functional for at least 2 minor releases after v2 GA."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 60,
                        "weight": 5,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Audit all v1 field names for inconsistencies", "is_checked": False},
                            {"text": "Draft v2 schema RFC", "is_checked": False},
                            {"text": "Get team sign-off on v2 schema", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "OpenAPI spec auto-generation from DRF viewsets",
                        "description": (
                            "Add `drf-spectacular` to auto-generate an OpenAPI 3.1 spec from "
                            "DRF viewsets and serializers.\n\n"
                            "Serve the spec at `/api/schema/` and a Swagger UI at `/api/docs/`."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 21,
                        "weight": 3,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Install drf-spectacular", "is_checked": True},
                            {"text": "Add @extend_schema annotations to key endpoints", "is_checked": False},
                            {"text": "Verify generated spec completeness", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "Analytics",
                "color": "#10B981",
                "contact_email": "",
                "notes": "Board analytics, throughput charts, cycle time, and reporting views.",
                "cards": [
                    {
                        "title": "Board throughput chart (cards completed per week)",
                        "description": (
                            "Add a throughput chart to the Analytics tab showing how many cards "
                            "entered the Done column per week over the last 12 weeks.\n\n"
                            "Use Recharts. Filter by swimlane and label."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": -5,
                        "weight": 4,
                        "labels": ["Core", "UX"],
                        "checklist": [
                            {"text": "Backend: throughput aggregation endpoint", "is_checked": True},
                            {"text": "Frontend: Recharts bar chart component", "is_checked": True},
                            {"text": "Swimlane and label filter wiring", "is_checked": False},
                        ],
                        "comments": [
                            "Chart renders. Filter wiring is the last piece.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Cumulative flow diagram",
                        "description": (
                            "Cumulative flow diagram (CFD) shows card counts per column over time. "
                            "Key insight: widening bands indicate bottlenecks.\n\n"
                            "Requires daily snapshots of column card counts — add a scheduled task."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Daily snapshot Celery task", "is_checked": True},
                            {"text": "BoardSnapshot model and migration", "is_checked": True},
                            {"text": "CFD endpoint with date range filter", "is_checked": False},
                            {"text": "Frontend: stacked area chart", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "CSV export: card movement history",
                        "description": (
                            "Allow board admins to download a CSV of all card movements.\n\n"
                            "Columns: card_id, title, from_column, to_column, from_swimlane, "
                            "to_swimlane, moved_by, moved_at.\n\n"
                            "Scoped to boards the requesting user has access to."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Add export endpoint to BoardMovementViewSet", "is_checked": True},
                            {"text": "Stream CSV with chunked response", "is_checked": True},
                            {"text": "Add download button to Analytics tab", "is_checked": True},
                        ],
                        "comments": [
                            "Released in v1.2. Used heavily by enterprise customers.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Cycle time by priority",
                        "description": (
                            "Show average cycle time (first move → Done) broken down by priority. "
                            "Helps teams see whether high-priority cards are actually moving faster."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 30,
                        "weight": 3,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Calculate cycle time from CardMovement records", "is_checked": False},
                            {"text": "Group by priority in backend endpoint", "is_checked": False},
                            {"text": "Display as grouped bar chart", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Stale card heatmap on board view",
                        "description": (
                            "Overlay a heatmap on the board grid showing which cells have the most "
                            "stale cards. Cell colour intensity = stale card count.\n\n"
                            "Toggle: 'Show stale heatmap' button in board toolbar."
                        ),
                        "col_idx": 1,
                        "priority": "low",
                        "due_offset": 45,
                        "weight": 3,
                        "labels": ["UX"],
                        "checklist": [
                            {"text": "Design heatmap colour scale", "is_checked": False},
                            {"text": "Backend: stale count per cell endpoint", "is_checked": False},
                            {"text": "Frontend: overlay on board grid", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                ],
            },
            {
                "name": "Integrations",
                "color": "#F59E0B",
                "contact_email": "",
                "notes": "Third-party integrations: Slack, GitHub, Jira, Zapier, Linear.",
                "cards": [
                    {
                        "title": "Slack: card move notifications to channel",
                        "description": (
                            "When a card is moved to a configured column, post a Slack message "
                            "to a designated channel.\n\n"
                            "Config: per-board, select trigger column and Slack channel. "
                            "Use Slack Incoming Webhooks."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Slack Incoming Webhook integration config UI", "is_checked": True},
                            {"text": "Backend: send webhook on card move signal", "is_checked": True},
                            {"text": "Test with real Slack workspace", "is_checked": False},
                            {"text": "Docs: Slack integration setup guide", "is_checked": False},
                        ],
                        "comments": [
                            "Backend wired. Testing with Slack workspace now.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "GitHub: link pull request to card",
                        "description": (
                            "Allow users to link a GitHub PR to a card. When the PR is merged, "
                            "move the card to the configured 'merged' column automatically.\n\n"
                            "Use GitHub webhooks. Store PR link in card metadata."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 21,
                        "weight": 4,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "GitHub OAuth app registration", "is_checked": True},
                            {"text": "PR link UI on card detail", "is_checked": False},
                            {"text": "Webhook receiver for PR merged event", "is_checked": False},
                            {"text": "Auto-move card on merge", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Jira importer: migrate boards and cards",
                        "description": (
                            "One-time import from Jira Cloud.\n\n"
                            "Mapping: Jira Project → Board, Jira Issue Status → Column, "
                            "Jira Epic → Swimlane, Jira Labels → Visiban Labels.\n\n"
                            "Use Jira REST API with OAuth 2.0."
                        ),
                        "col_idx": 1,
                        "priority": "medium",
                        "due_offset": 45,
                        "weight": 5,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Jira OAuth flow", "is_checked": False},
                            {"text": "Mapping configuration UI", "is_checked": False},
                            {"text": "Dry-run mode (preview before import)", "is_checked": False},
                            {"text": "Full import with progress indicator", "is_checked": False},
                        ],
                        "comments": [
                            "High customer demand — 12 requests this quarter. Prioritising in Q3.",
                        ],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Zapier connector (trigger + action)",
                        "description": (
                            "Publish a Visiban app on Zapier with:\n\n"
                            "**Triggers**: Card moved, Card created, Due date approaching\n\n"
                            "**Actions**: Create card, Move card, Add comment"
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Register Zapier developer app", "is_checked": False},
                            {"text": "Implement trigger endpoints", "is_checked": False},
                            {"text": "Implement action endpoints", "is_checked": False},
                            {"text": "Submit for Zapier review", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "Linear sync (two-way card ↔ issue)",
                        "description": (
                            "Two-way sync between Visiban cards and Linear issues:\n\n"
                            "- Linear issue created → Visiban card created\n"
                            "- Visiban card moved → Linear issue status updated\n\n"
                            "Use Linear webhooks + API."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": -1,
                        "weight": 5,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Linear OAuth integration", "is_checked": True},
                            {"text": "Inbound webhook: Linear → Visiban", "is_checked": True},
                            {"text": "Outbound sync: Visiban → Linear", "is_checked": False},
                            {"text": "Conflict resolution for simultaneous edits", "is_checked": False},
                        ],
                        "comments": [
                            "Inbound sync working. Outbound has a race condition — investigating.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Enterprise",
                "color": "#EF4444",
                "contact_email": "",
                "notes": "Enterprise-tier features: SSO, audit logs, SCIM, multi-tenancy.",
                "cards": [
                    {
                        "title": "SAML / SSO integration",
                        "description": (
                            "Support SAML 2.0 SSO for enterprise customers using IdPs such as "
                            "Okta, Azure AD, and Google Workspace.\n\n"
                            "Use `python3-saml`. Configure per-organisation IdP metadata.\n\n"
                            "Required by 6 enterprise prospects."
                        ),
                        "col_idx": 4,
                        "priority": "urgent",
                        "due_offset": 3,
                        "weight": 5,
                        "labels": ["Compliance", "Platform"],
                        "checklist": [
                            {"text": "Integrate python3-saml", "is_checked": True},
                            {"text": "Per-org IdP metadata storage", "is_checked": True},
                            {"text": "Test with Okta and Azure AD", "is_checked": True},
                            {"text": "Docs: SSO setup guide for admins", "is_checked": False},
                        ],
                        "comments": [
                            "Okta and Azure AD both tested. Docs in progress.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Audit log export (admin panel)",
                        "description": (
                            "Enterprise admins need to export a complete audit log for compliance. "
                            "Fields: timestamp, actor, action, resource_type, resource_id, details.\n\n"
                            "Export formats: JSON and CSV. Date-range filter required."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Compliance"],
                        "checklist": [
                            {"text": "AuditLog model and migration", "is_checked": True},
                            {"text": "Wire signals for all auditable events", "is_checked": False},
                            {"text": "Export endpoint with date-range filter", "is_checked": False},
                            {"text": "Admin panel download button", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Multi-tenancy: strict org isolation",
                        "description": (
                            "Ensure data from one organisation is never accessible from another.\n\n"
                            "Implementation: row-level security via `org_id` FK on all resources. "
                            "Middleware enforces org scope on every request."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 14,
                        "weight": 5,
                        "labels": ["Compliance", "Platform"],
                        "checklist": [
                            {"text": "Add Organisation model", "is_checked": True},
                            {"text": "Add org_id FK to Board, User, Label", "is_checked": False},
                            {"text": "Org-scoping middleware", "is_checked": False},
                            {"text": "Cross-org access tests (must all return 403)", "is_checked": False},
                        ],
                        "comments": [
                            "Organisation model done. FK migrations complex — planning zero-downtime approach.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "SCIM 2.0 user provisioning",
                        "description": (
                            "Allow enterprise IdPs to automatically provision and deprovision users "
                            "via SCIM 2.0.\n\n"
                            "Endpoints: `/scim/v2/Users` (CRUD) and `/scim/v2/Groups`.\n\n"
                            "Test with Okta SCIM provisioning."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 30,
                        "weight": 5,
                        "labels": ["Compliance", "Platform"],
                        "checklist": [
                            {"text": "SCIM Users endpoint (create, update, deactivate)", "is_checked": False},
                            {"text": "SCIM Groups endpoint", "is_checked": False},
                            {"text": "Test with Okta provisioning", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": None,
                    },
                    {
                        "title": "White-label theming (logo + primary colour)",
                        "description": (
                            "Allow enterprise customers to set their own logo and primary brand colour. "
                            "Config stored per-organisation. Applied at render time via CSS variables."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["UX"],
                        "checklist": [
                            {"text": "Add logo_url and primary_color to Organisation", "is_checked": False},
                            {"text": "CSS variable injection on page load", "is_checked": False},
                            {"text": "Admin UI for branding settings", "is_checked": False},
                        ],
                        "comments": [
                            "Lower priority than SSO/SCIM — scheduled for Q4.",
                        ],
                        "assignee_idx": None,
                    },
                ],
            },
        ],
    },

    # ── Project Delivery ──────────────────────────────────────────────────────
    "project_delivery": {
        "board_name": "Template: Project Delivery",
        "description": (
            "Track projects from planning through retrospective. "
            "Each swimlane represents an active project."
        ),
        "columns": [
            {"name": "Planning",         "color": "#6B7280", "allow_card_creation": True},
            {"name": "Kickoff",          "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Execution",        "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Milestone Review", "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "Wrap-up",          "color": "#F97316", "allow_card_creation": False},
            {"name": "Retro",            "color": "#10B981", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Blocked",             "color": "#EF4444"},
            {"name": "On Track",            "color": "#10B981"},
            {"name": "External Dependency", "color": "#F97316"},
            {"name": "Milestone",           "color": "#8B5CF6"},
            {"name": "Budget Risk",         "color": "#DC2626"},
        ],
        "swimlanes": [
            {
                "name": "Mobile App Relaunch",
                "color": "#3B82F6",
                "contact_email": "mobile-team@internal.example",
                "notes": "Full redesign of iOS and Android apps. Target launch: 2026-06-01.",
                "cards": [
                    {
                        "title": "UX Research & Design",
                        "description": (
                            "User research, wireframing, and final design system for the relaunched app.\n\n"
                            "## Scope\n\n"
                            "- 8 user interviews (existing customers)\n"
                            "- Wireframes for all 12 core screens\n"
                            "- Design system tokens aligned to web platform\n"
                            "- Handoff to engineering via Figma"
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": -5,
                        "weight": 4,
                        "labels": ["Design", "On Track"],
                        "checklist": [
                            {"text": "Complete 8 user interviews", "is_checked": True},
                            {"text": "Wireframes reviewed by PM", "is_checked": True},
                            {"text": "Final designs approved", "is_checked": True},
                            {"text": "Figma handoff to engineering", "is_checked": False},
                        ],
                        "comments": [
                            "Designs approved. Engineering handoff scheduled for Monday.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "API v3 Integration",
                        "description": (
                            "Migrate the mobile app from REST API v2 to the new v3 GraphQL API.\n\n"
                            "Breaking changes in auth token format and pagination. "
                            "Requires coordinated release with backend team."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 10,
                        "weight": 5,
                        "labels": ["Engineering", "Blocked"],
                        "checklist": [
                            {"text": "Map v2 → v3 endpoint changes", "is_checked": True},
                            {"text": "Update auth token handler", "is_checked": True},
                            {"text": "Update pagination across all list views", "is_checked": False},
                            {"text": "End-to-end smoke tests on staging", "is_checked": False},
                        ],
                        "comments": [
                            "BLOCKED: waiting on backend team to finalize v3 pagination spec.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "App Store Submission",
                        "description": (
                            "Submit updated app to Apple App Store and Google Play.\n\n"
                            "Apple review typically 3-5 business days. "
                            "Coordinate marketing announcement timing with comms team."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 35,
                        "weight": 3,
                        "labels": ["Release"],
                        "checklist": [
                            {"text": "Prepare App Store screenshots", "is_checked": False},
                            {"text": "Write release notes", "is_checked": False},
                            {"text": "Submit to TestFlight first", "is_checked": False},
                            {"text": "Submit to production stores", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Data Platform Migration",
                "color": "#8B5CF6",
                "contact_email": "data-team@internal.example",
                "notes": "Migrate from legacy Redshift to Snowflake. Zero-downtime required.",
                "cards": [
                    {
                        "title": "Schema Mapping & Data Audit",
                        "description": (
                            "Audit all 340 tables in Redshift and map each to Snowflake schema.\n\n"
                            "Identify tables with breaking type changes, deprecated tables, and backfill needs."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["Engineering", "On Track"],
                        "checklist": [
                            {"text": "Export Redshift schema", "is_checked": True},
                            {"text": "Flag type-change tables to DBA", "is_checked": True},
                            {"text": "Confirm drop list with data owners", "is_checked": False},
                            {"text": "Final schema mapping signed off", "is_checked": False},
                        ],
                        "comments": [
                            "280/340 tables mapped. 12 have breaking type changes.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Dual-Write Validation Phase",
                        "description": (
                            "Run Redshift and Snowflake in parallel for 2 weeks. "
                            "Compare row counts and checksums. "
                            "Cutover only after 5 consecutive days of zero discrepancies."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 21,
                        "weight": 5,
                        "labels": ["Engineering"],
                        "checklist": [
                            {"text": "Deploy dual-write middleware", "is_checked": False},
                            {"text": "Build checksum comparison dashboard", "is_checked": False},
                            {"text": "Define discrepancy alert thresholds", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Production Cutover",
                        "description": (
                            "Zero-downtime cutover from Redshift to Snowflake.\n\n"
                            "Plan: dual-write phase complete → route 10% reads → 100% reads → "
                            "decommission Redshift writes."
                        ),
                        "col_idx": 0,
                        "priority": "urgent",
                        "due_offset": 42,
                        "weight": 5,
                        "labels": ["Engineering", "Release"],
                        "checklist": [
                            {"text": "Cutover runbook written and reviewed", "is_checked": False},
                            {"text": "Rollback plan documented", "is_checked": False},
                            {"text": "Schedule maintenance window with ops", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Security Compliance Audit",
                "color": "#EF4444",
                "contact_email": "security@internal.example",
                "notes": "Annual SOC 2 Type II + pen test. Audit window: 2026-04-01 to 2026-04-30.",
                "cards": [
                    {
                        "title": "SOC 2 Type II Evidence Collection",
                        "description": (
                            "Collect all evidence for the SOC 2 Type II audit.\n\n"
                            "Evidence categories: access control logs (90 days), change management, "
                            "incident response logs, vendor assessments, backup test results."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Compliance", "On Track"],
                        "checklist": [
                            {"text": "Pull access control logs from IAM", "is_checked": True},
                            {"text": "Compile change management records", "is_checked": True},
                            {"text": "Document incident response log", "is_checked": False},
                            {"text": "Vendor security assessment summary", "is_checked": False},
                        ],
                        "comments": [
                            "IAM logs and change records complete. Incident log in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "External Penetration Test",
                        "description": (
                            "Annual pen test scoped to public web app, API, WebSocket layer, and auth flows."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["Compliance"],
                        "checklist": [
                            {"text": "Agree scope with vendor", "is_checked": True},
                            {"text": "Provide staging access", "is_checked": True},
                            {"text": "Receive final report", "is_checked": True},
                            {"text": "Remediate findings", "is_checked": False},
                        ],
                        "comments": [
                            "Report received — 2 medium findings, 0 critical. Remediation underway.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Customer Portal v2",
                "color": "#F59E0B",
                "contact_email": "portal-team@internal.example",
                "notes": "Self-service portal for enterprise customers. Target launch: 2026-07-01.",
                "cards": [
                    {
                        "title": "Requirements & Stakeholder Sign-off",
                        "description": (
                            "Capture all requirements from account management, support, and enterprise customers.\n\n"
                            "Key stakeholders: VP CS, Head of Support, 3 enterprise customer advisors."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 3,
                        "weight": 3,
                        "labels": ["On Track"],
                        "checklist": [
                            {"text": "Stakeholder workshops complete", "is_checked": True},
                            {"text": "Requirements document written", "is_checked": True},
                            {"text": "Sign-off from VP CS and Head of Support", "is_checked": False},
                        ],
                        "comments": [
                            "47 requirements captured. Sign-off call Thursday.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Frontend Development",
                        "description": (
                            "Build the React frontend: dashboard, board list, user management, billing, support."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 45,
                        "weight": 4,
                        "labels": ["Engineering"],
                        "checklist": [
                            {"text": "Design handoff received", "is_checked": False},
                            {"text": "Component library setup", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "GDPR Deletion Pipeline",
                "color": "#14B8A6",
                "contact_email": "legal-eng@internal.example",
                "notes": "Automate right-to-erasure workflow. Legal deadline: 2026-05-25.",
                "cards": [
                    {
                        "title": "Deletion Request API",
                        "description": (
                            "API endpoint to process GDPR erasure requests.\n\n"
                            "Must cascade across all user-owned data: boards, cards, comments, "
                            "activity logs, and exports."
                        ),
                        "col_idx": 5,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["Engineering", "On Track"],
                        "checklist": [
                            {"text": "Enumerate all user-owned tables", "is_checked": True},
                            {"text": "Implement cascading deletion logic", "is_checked": True},
                            {"text": "Write unit tests covering all table deletes", "is_checked": True},
                            {"text": "Legal review of deletion coverage", "is_checked": True},
                            {"text": "Deploy to production", "is_checked": True},
                        ],
                        "comments": [
                            "Deployed. Legal confirmed full coverage. Retro scheduled.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
        ],
    },
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
            .prefetch_related(
                "labels",
                "checklist_items",
                "comments__author",
                "movements__moved_by",
                "movements__from_column",
                "movements__to_column",
                "movements__from_swimlane",
                "movements__to_swimlane",
            )
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
                    "movements": [
                        {
                            "from_column": mv.from_column_name or None,
                            "to_column": mv.to_column_name,
                            "from_swimlane": mv.from_swimlane_name or None,
                            "to_swimlane": mv.to_swimlane_name,
                            "moved_at": mv.moved_at.isoformat(),
                            "moved_by": mv.moved_by.username if mv.moved_by else None,
                        }
                        for mv in card.movements.order_by("moved_at")
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
