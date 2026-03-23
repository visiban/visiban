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
        Seed all 10 templates. Skips any board that already exists.

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
            "General-purpose kanban for any team. "
            "Each swimlane is a team or workstream; each card is a work item."
        ),
        "columns": [
            {"name": "Backlog",      "color": "#6B7280", "allow_card_creation": True},
            {"name": "Refined",      "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Sprint Ready", "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "In Dev",       "color": "#F59E0B", "allow_card_creation": False},
            {"name": "In Review",    "color": "#F97316", "allow_card_creation": False},
            {"name": "QA/Testing",   "color": "#EC4899", "allow_card_creation": False},
            {"name": "Done",         "color": "#10B981", "allow_card_creation": False},
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
                "notes": "React + TypeScript. Owns all UI components, pages, and the design system.",
                "cards": [
                    {
                        "title": "Redesign card detail modal layout",
                        "description": (
                            "The card detail modal is crowded on smaller screens.\n\n"
                            "## Proposed layout\n\n"
                            "- Move assignee + due date to a collapsible sidebar\n"
                            "- Give description full-width\n"
                            "- Collapse checklist by default\n\n"
                            "Acceptance: passes WCAG AA at 375px viewport."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["Feature", "Improve"],
                        "checklist": [
                            {"text": "Spike responsive layout options", "is_checked": True},
                            {"text": "Design review from Casey", "is_checked": True},
                            {"text": "Implement sidebar component", "is_checked": True},
                            {"text": "Accessibility audit (axe-core)", "is_checked": False},
                        ],
                        "comments": [
                            "Sidebar prototype looks great on mobile.",
                            "Accessibility pass scheduled for tomorrow.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Fix column header overflow on long names",
                        "description": (
                            "Column names longer than 20 characters overflow the header chip.\n\n"
                            "Fix: truncate with ellipsis and show full name in a tooltip."
                        ),
                        "col_idx": 5,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Bug"],
                        "checklist": [
                            {"text": "Add CSS text-overflow: ellipsis", "is_checked": True},
                            {"text": "Add tooltip on hover", "is_checked": True},
                            {"text": "Verify in all supported browsers", "is_checked": True},
                        ],
                        "comments": [
                            "Fix ready for QA.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Add keyboard shortcut for card creation",
                        "description": (
                            "Power users want to create a new card with Ctrl+N (or Cmd+N on Mac). "
                            "Should focus the first column and open the new card form."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 21,
                        "weight": 2,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Add keybinding handler", "is_checked": False},
                            {"text": "Guard against focus conflicts with modals", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "Backend",
                "color": "#8B5CF6",
                "contact_email": "",
                "notes": "Django + DRF. Owns API, data models, business logic, and background tasks.",
                "cards": [
                    {
                        "title": "Add cursor pagination to /api/boards/ endpoint",
                        "description": (
                            "The boards list endpoint currently returns all boards in one response. "
                            "Users with 100+ boards hit performance issues.\n\n"
                            "Switch to cursor pagination with a default page size of 25."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Improve", "Feature"],
                        "checklist": [
                            {"text": "Add CursorPagination class", "is_checked": True},
                            {"text": "Update BoardViewSet to use it", "is_checked": True},
                            {"text": "Update API docs", "is_checked": True},
                            {"text": "Confirm frontend handles paginated response", "is_checked": False},
                        ],
                        "comments": [
                            "Backend done. Waiting on frontend confirmation.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Refactor CardMovement to use bulk_create",
                        "description": (
                            "Each card drag currently fires one INSERT per movement. "
                            "At high concurrency this creates lock contention.\n\n"
                            "Batch inserts in the drag handler using bulk_create."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 14,
                        "weight": 3,
                        "labels": ["Tech Debt", "Improve"],
                        "checklist": [
                            {"text": "Profile current movement inserts under load", "is_checked": True},
                            {"text": "Implement bulk_create in drag handler", "is_checked": False},
                            {"text": "Load test: 50 concurrent drags", "is_checked": False},
                        ],
                        "comments": [
                            "Profiling shows 8ms per insert at 50 concurrent users.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Write missing tests for board archive endpoint",
                        "description": (
                            "PATCH /api/boards/{id}/ with is_archived=true has no test coverage. "
                            "Add tests: happy path, non-member rejected, already archived."
                        ),
                        "col_idx": 6,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Tech Debt"],
                        "checklist": [
                            {"text": "Happy path test", "is_checked": True},
                            {"text": "Non-member rejection test", "is_checked": True},
                            {"text": "Already-archived idempotency test", "is_checked": True},
                        ],
                        "comments": [
                            "All 3 tests passing. Coverage up from 84% to 87%.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "Mobile",
                "color": "#EC4899",
                "contact_email": "",
                "notes": "React Native. iOS + Android. Syncs with main API.",
                "cards": [
                    {
                        "title": "Offline mode: queue card edits",
                        "description": (
                            "When the user edits a card with no internet connection, "
                            "queue the change and sync when connectivity returns.\n\n"
                            "Use AsyncStorage for the queue. Max queue depth: 50 operations."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 18,
                        "weight": 5,
                        "labels": ["Feature"],
                        "checklist": [
                            {"text": "Design offline queue data model", "is_checked": True},
                            {"text": "Implement AsyncStorage queue", "is_checked": False},
                            {"text": "Implement sync-on-reconnect logic", "is_checked": False},
                            {"text": "Test conflict resolution (server wins)", "is_checked": False},
                        ],
                        "comments": [
                            "Data model approved. Implementation starting this sprint.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Fix drag-drop on iOS Safari",
                        "description": (
                            "Card drag-drop broken on iOS Safari 17.4 — card snaps back on drop. "
                            "Workaround sent to customers. Need permanent fix."
                        ),
                        "col_idx": 3,
                        "priority": "urgent",
                        "due_offset": 3,
                        "weight": 4,
                        "labels": ["Bug", "Blocked"],
                        "checklist": [
                            {"text": "Reproduce on iOS 17.4 Safari", "is_checked": True},
                            {"text": "Patch touch event handler", "is_checked": True},
                            {"text": "Regression test on Chrome iOS and Safari", "is_checked": False},
                        ],
                        "comments": [
                            "BLOCKED: touch event library has an upstream bug. Filed issue with maintainer.",
                        ],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "DevOps",
                "color": "#14B8A6",
                "contact_email": "",
                "notes": "CI/CD, infrastructure, reliability, and monitoring.",
                "cards": [
                    {
                        "title": "Add canary deployment to CI pipeline",
                        "description": (
                            "Before routing 100% of traffic to a new release, route 5% to a "
                            "canary instance for 30 minutes.\n\n"
                            "Promote automatically if error rate stays below 0.1%."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 12,
                        "weight": 4,
                        "labels": ["Feature", "Improve"],
                        "checklist": [
                            {"text": "Define canary traffic split in Nginx config", "is_checked": True},
                            {"text": "Add error rate check to CI gate", "is_checked": False},
                            {"text": "Test canary rollback path", "is_checked": False},
                        ],
                        "comments": [
                            "Nginx config done. Error rate gate in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Migrate secrets from .env files to Vault",
                        "description": (
                            "All app secrets currently live in .env files on each server. "
                            "Migrate to HashiCorp Vault with automatic secret rotation."
                        ),
                        "col_idx": 6,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Tech Debt"],
                        "checklist": [
                            {"text": "Audit all secrets in .env files", "is_checked": True},
                            {"text": "Provision Vault cluster", "is_checked": True},
                            {"text": "Migrate secrets to Vault", "is_checked": True},
                            {"text": "Remove .env files from all servers", "is_checked": True},
                            {"text": "Enable automatic rotation on DB passwords", "is_checked": True},
                        ],
                        "comments": [
                            "Migration complete. All servers using Vault. Rotation active.",
                        ],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Design",
                "color": "#F59E0B",
                "contact_email": "",
                "notes": "UX/UI design, design system, user research.",
                "cards": [
                    {
                        "title": "Define color token spec for dark mode",
                        "description": (
                            "The design system has 12 semantic color tokens that need dark mode variants.\n\n"
                            "Audit: surface, border, text, interactive, and status tokens. "
                            "Produce a Figma page with all light/dark pairs."
                        ),
                        "col_idx": 4,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 3,
                        "labels": ["Feature", "Improve"],
                        "checklist": [
                            {"text": "Audit all 12 semantic tokens", "is_checked": True},
                            {"text": "Draft dark mode variants in Figma", "is_checked": True},
                            {"text": "Review with frontend team", "is_checked": True},
                            {"text": "Publish final token spec", "is_checked": False},
                        ],
                        "comments": [
                            "Token pairs reviewed with frontend. Publishing final spec today.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "User research: onboarding friction points",
                        "description": (
                            "5 moderated sessions with new users (< 7 days active) to identify "
                            "where they get stuck during first-time board setup."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 30,
                        "weight": 2,
                        "labels": ["Improve"],
                        "checklist": [
                            {"text": "Recruit 5 participants", "is_checked": False},
                            {"text": "Write session script", "is_checked": False},
                            {"text": "Run sessions", "is_checked": False},
                            {"text": "Write up findings", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
        ],
    },

    # ── Product Roadmap ───────────────────────────────────────────────────────
    "product_roadmap": {
        "board_name": "Template: Product Roadmap",
        "description": (
            "Track features from idea through launch and monitoring. "
            "Each swimlane is a product area; each card is a feature or initiative."
        ),
        "columns": [
            {"name": "Idea",        "color": "#8B5CF6", "allow_card_creation": True},
            {"name": "Validated",   "color": "#6B7280", "allow_card_creation": True},
            {"name": "Scoped",      "color": "#3B82F6", "allow_card_creation": False},
            {"name": "Prioritized", "color": "#F97316", "allow_card_creation": False},
            {"name": "In Build",    "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Beta",        "color": "#EC4899", "allow_card_creation": False},
            {"name": "Launched",    "color": "#10B981", "allow_card_creation": False},
            {"name": "Monitoring",  "color": "#14B8A6", "allow_card_creation": False},
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
                        "title": "Push notifications for due dates",
                        "description": (
                            "Send a push notification to the card assignee 24h before due date.\n\n"
                            "## Acceptance criteria\n\n"
                            "- Notification delivered within 5 min of threshold\n"
                            "- Tapping opens the card directly\n"
                            "- User can opt out per-board"
                        ),
                        "col_idx": 6,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 4,
                        "labels": ["Core", "UX"],
                        "checklist": [
                            {"text": "FCM + APNs integration", "is_checked": True},
                            {"text": "Notification opt-out setting", "is_checked": True},
                            {"text": "Deep link to card on tap", "is_checked": True},
                            {"text": "Monitor delivery rate post-launch", "is_checked": False},
                        ],
                        "comments": [
                            "Launched to 100% of mobile users. Delivery rate: 97.2%.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Offline card editing",
                        "description": (
                            "Allow users to edit cards without an internet connection. "
                            "Queue changes locally and sync on reconnect."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 21,
                        "weight": 5,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Design conflict resolution strategy", "is_checked": True},
                            {"text": "Implement local queue (AsyncStorage)", "is_checked": True},
                            {"text": "Sync-on-reconnect logic", "is_checked": False},
                            {"text": "Beta test with 10 pilot users", "is_checked": False},
                        ],
                        "comments": [
                            "Queue logic done. Sync handler in progress.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Dark mode",
                        "description": (
                            "Full dark mode support on iOS and Android, "
                            "respecting system preference and offering a manual override in settings."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 35,
                        "weight": 3,
                        "labels": ["UX"],
                        "checklist": [
                            {"text": "Finalize dark token spec with design", "is_checked": True},
                            {"text": "Apply tokens to all screens", "is_checked": False},
                            {"text": "QA pass on all 12 core screens", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Core Platform",
                "color": "#8B5CF6",
                "contact_email": "",
                "notes": "Web app, API, and shared infrastructure features.",
                "cards": [
                    {
                        "title": "Board templates v2",
                        "description": (
                            "Expand the board template library from 6 to 10 templates, "
                            "redesign column structures, and add per-template seed data "
                            "with realistic movement history."
                        ),
                        "col_idx": 7,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Redesign all 6 existing templates", "is_checked": True},
                            {"text": "Add 4 new templates", "is_checked": True},
                            {"text": "Seed data with movement history export", "is_checked": True},
                            {"text": "Monitor adoption in new installs", "is_checked": False},
                        ],
                        "comments": [
                            "All 10 templates live. Early adoption data looks promising.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Cursor pagination on all list endpoints",
                        "description": (
                            "Replace offset pagination with cursor pagination on boards, "
                            "cards, and activity log endpoints for consistent performance at scale."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Boards endpoint", "is_checked": True},
                            {"text": "Cards endpoint", "is_checked": True},
                            {"text": "Activity log endpoint", "is_checked": True},
                            {"text": "Update API docs", "is_checked": True},
                            {"text": "Beta cohort monitoring", "is_checked": False},
                        ],
                        "comments": [
                            "All endpoints migrated. In beta with enterprise cohort.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Card weight & capacity planning",
                        "description": (
                            "Allow teams to set a card weight (story points) and a swimlane "
                            "capacity. Board shows load percentage per swimlane in sprint."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 28,
                        "weight": 4,
                        "labels": ["Core", "UX"],
                        "checklist": [
                            {"text": "Spec approved by PM", "is_checked": True},
                            {"text": "DB migration for weight + capacity fields", "is_checked": True},
                            {"text": "API endpoints", "is_checked": False},
                            {"text": "Frontend capacity bar component", "is_checked": False},
                        ],
                        "comments": [
                            "Migration done. API and frontend work starting next sprint.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "Integrations",
                "color": "#F59E0B",
                "contact_email": "",
                "notes": "Third-party integrations: Slack, GitHub, Jira, Zapier, webhooks.",
                "cards": [
                    {
                        "title": "Slack card notifications",
                        "description": (
                            "Post a Slack message when a card is moved, assigned, or commented on. "
                            "User configures the Slack channel per board."
                        ),
                        "col_idx": 6,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 4,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "OAuth flow for Slack workspace", "is_checked": True},
                            {"text": "Board-level channel config", "is_checked": True},
                            {"text": "Webhook handler for card events", "is_checked": True},
                            {"text": "Monitor message delivery rate", "is_checked": False},
                        ],
                        "comments": [
                            "Launch successful. 340 workspaces connected in week 1.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "GitHub PR → card link",
                        "description": (
                            "Automatically link a GitHub PR to a Visiban card when the PR "
                            "description includes `closes VB-<card-id>`. Show PR status on the card."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 20,
                        "weight": 4,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "GitHub App setup and OAuth", "is_checked": True},
                            {"text": "Webhook listener for PR events", "is_checked": True},
                            {"text": "Card detail: PR status badge", "is_checked": False},
                            {"text": "Docs + announcement blog post", "is_checked": False},
                        ],
                        "comments": [
                            "GitHub App approved by GitHub Marketplace. Card badge in progress.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Zapier integration",
                        "description": (
                            "List Visiban on the Zapier marketplace with triggers (card created, "
                            "moved, commented) and actions (create card, update status)."
                        ),
                        "col_idx": 1,
                        "priority": "low",
                        "due_offset": 45,
                        "weight": 3,
                        "labels": ["Platform"],
                        "checklist": [
                            {"text": "Define triggers and actions spec", "is_checked": True},
                            {"text": "Submit Zapier app for review", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Analytics",
                "color": "#10B981",
                "contact_email": "",
                "notes": "Board analytics, cycle time, throughput, and reporting features.",
                "cards": [
                    {
                        "title": "Cycle time chart per column",
                        "description": (
                            "Show the average time cards spend in each column over a date range. "
                            "Identify bottlenecks at a glance."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 5,
                        "labels": ["Core", "UX"],
                        "checklist": [
                            {"text": "Backend: cycle time aggregation query", "is_checked": True},
                            {"text": "Frontend: column chart component", "is_checked": True},
                            {"text": "Date range filter", "is_checked": False},
                            {"text": "Beta test with analytics-tier customers", "is_checked": False},
                        ],
                        "comments": [
                            "Backend aggregation is fast even on 10k card boards.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "CSV export of board analytics",
                        "description": (
                            "Allow board admins to download cycle time and throughput data as CSV. "
                            "Useful for external reporting in Excel or Google Sheets."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 60,
                        "weight": 2,
                        "labels": ["Core"],
                        "checklist": [
                            {"text": "Define CSV schema", "is_checked": False},
                            {"text": "Backend export endpoint", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Compliance & Security",
                "color": "#EF4444",
                "contact_email": "",
                "notes": "GDPR, SOC 2, audit logging, and security hardening features.",
                "cards": [
                    {
                        "title": "GDPR right-to-erasure pipeline",
                        "description": (
                            "Automate deletion of all user-owned data on erasure request. "
                            "Must cascade across boards, cards, comments, activity logs, and exports."
                        ),
                        "col_idx": 7,
                        "priority": "urgent",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["Compliance"],
                        "checklist": [
                            {"text": "Enumerate all user-owned tables", "is_checked": True},
                            {"text": "Implement cascading deletion", "is_checked": True},
                            {"text": "Legal sign-off on coverage", "is_checked": True},
                            {"text": "Monitor deletion job success rate", "is_checked": False},
                        ],
                        "comments": [
                            "Pipeline live. Legal confirmed full coverage.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Audit log for board membership changes",
                        "description": (
                            "Record all adds, removes, and role changes to board membership "
                            "in an immutable audit log visible to board admins."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 18,
                        "weight": 4,
                        "labels": ["Compliance", "Platform"],
                        "checklist": [
                            {"text": "Extend CardActivity model for membership events", "is_checked": True},
                            {"text": "Backend signals for add/remove/role change", "is_checked": False},
                            {"text": "Audit log UI on board settings page", "is_checked": False},
                        ],
                        "comments": [
                            "Model extension done. Signals and UI in progress.",
                        ],
                        "assignee_idx": 3,
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

    # ── Content Production ───────────────────────────────────────────────────
    "content_production": {
        "board_name": "Template: Content Production",
        "description": (
            "Track content pieces from idea through publication. "
            "Each swimlane is a content type; each card is a piece of content."
        ),
        "columns": [
            {"name": "Idea",            "color": "#8B5CF6", "allow_card_creation": True},
            {"name": "Assigned",        "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Draft",           "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Internal Review", "color": "#F97316", "allow_card_creation": False},
            {"name": "Edits",           "color": "#EF4444", "allow_card_creation": False},
            {"name": "Final Approval",  "color": "#EC4899", "allow_card_creation": False},
            {"name": "Scheduled",       "color": "#14B8A6", "allow_card_creation": False},
            {"name": "Published",       "color": "#10B981", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "SEO",        "color": "#3B82F6"},
            {"name": "Thought Leadership", "color": "#8B5CF6"},
            {"name": "Product",    "color": "#F59E0B"},
            {"name": "Customer Story", "color": "#10B981"},
            {"name": "Evergreen",  "color": "#14B8A6"},
        ],
        "swimlanes": [
            {
                "name": "Blog Posts",
                "color": "#3B82F6",
                "contact_email": "content@internal.example",
                "notes": "Long-form articles. Target: 2 per week. Min length: 1,000 words.",
                "cards": [
                    {
                        "title": "How Visiban's swimlane model reduces handoff delays",
                        "description": (
                            "Thought leadership piece explaining how grouping work by account "
                            "or team in swimlanes reduces the handoff friction common in "
                            "column-only kanban tools.\n\n"
                            "Target keywords: kanban swimlane, reduce handoffs, team kanban."
                        ),
                        "col_idx": 7,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 4,
                        "labels": ["Thought Leadership", "SEO", "Evergreen"],
                        "checklist": [
                            {"text": "Keyword research complete", "is_checked": True},
                            {"text": "Outline approved by marketing lead", "is_checked": True},
                            {"text": "First draft written", "is_checked": True},
                            {"text": "SEO review", "is_checked": True},
                            {"text": "Published and indexed", "is_checked": True},
                        ],
                        "comments": [
                            "Published 2026-03-05. Ranking on page 2 for target keyword after 10 days.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "5 ways to run a better sprint retrospective",
                        "description": (
                            "Practical tips for engineering teams running retros. "
                            "Tie in Visiban retro board template as a CTA."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": 5,
                        "weight": 3,
                        "labels": ["SEO", "Product"],
                        "checklist": [
                            {"text": "Outline approved", "is_checked": True},
                            {"text": "Draft written (1,200 words)", "is_checked": True},
                            {"text": "Internal review by content lead", "is_checked": True},
                            {"text": "SEO edits applied", "is_checked": True},
                            {"text": "Final approval from marketing director", "is_checked": False},
                        ],
                        "comments": [
                            "Good draft. Reviewer requested 2 more concrete examples.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Why your CRM and project tool shouldn't be the same app",
                        "description": (
                            "Opinion piece differentiating Visiban from tools that try to do too much. "
                            "Target audience: ops and sales leaders."
                        ),
                        "col_idx": 2,
                        "priority": "low",
                        "due_offset": 18,
                        "weight": 2,
                        "labels": ["Thought Leadership"],
                        "checklist": [
                            {"text": "Assigned to writer", "is_checked": True},
                            {"text": "Draft due", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "Case Studies",
                "color": "#10B981",
                "contact_email": "content@internal.example",
                "notes": "Customer success stories. Requires customer approval before publishing.",
                "cards": [
                    {
                        "title": "How TechNova cut sprint planning time by 40%",
                        "description": (
                            "Case study featuring TechNova's adoption of Visiban for engineering "
                            "sprint tracking. Interview VP Engineering and 2 team leads.\n\n"
                            "Customer approved. Embargo until 2026-04-01."
                        ),
                        "col_idx": 6,
                        "priority": "high",
                        "due_offset": 15,
                        "weight": 5,
                        "labels": ["Customer Story", "Product"],
                        "checklist": [
                            {"text": "Customer interview recorded", "is_checked": True},
                            {"text": "Draft written", "is_checked": True},
                            {"text": "Customer review and approval", "is_checked": True},
                            {"text": "Legal cleared", "is_checked": True},
                            {"text": "Scheduled for 2026-04-01 publish", "is_checked": True},
                        ],
                        "comments": [
                            "TechNova approved final copy on 2026-03-20. Embargo in place.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Mosaic Creative: managing 12 client campaigns on one board",
                        "description": (
                            "Short-form case study (500 words) on Mosaic Creative's swimlane-per-client "
                            "workflow. Quick win — customer is enthusiastic."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 10,
                        "weight": 3,
                        "labels": ["Customer Story"],
                        "checklist": [
                            {"text": "Phone interview with Mosaic ops manager", "is_checked": True},
                            {"text": "Draft written", "is_checked": True},
                            {"text": "Internal review", "is_checked": True},
                            {"text": "Send to customer for approval", "is_checked": False},
                        ],
                        "comments": [
                            "Great quote in the interview. Sending draft to customer today.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Video & Webinars",
                "color": "#8B5CF6",
                "contact_email": "content@internal.example",
                "notes": "Product demo videos, webinars, and YouTube tutorials.",
                "cards": [
                    {
                        "title": "Getting started with Visiban — 5-min explainer video",
                        "description": (
                            "Onboarding video covering: creating a board, adding swimlanes, "
                            "creating cards, and inviting teammates.\n\n"
                            "Target: YouTube + embedded in the onboarding flow."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["Product", "Evergreen"],
                        "checklist": [
                            {"text": "Script written and approved", "is_checked": True},
                            {"text": "Screen recording completed", "is_checked": True},
                            {"text": "Voiceover recorded", "is_checked": True},
                            {"text": "Edited and captioned", "is_checked": True},
                            {"text": "Awaiting final approval from marketing director", "is_checked": False},
                        ],
                        "comments": [
                            "Video looks great. Awaiting director sign-off before upload.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Live webinar: Kanban for customer success teams",
                        "description": (
                            "60-minute webinar targeting CS leaders. "
                            "Demo Visiban's customer_success template with account health tracking."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 30,
                        "weight": 3,
                        "labels": ["Thought Leadership", "Product"],
                        "checklist": [
                            {"text": "Date confirmed (2026-04-15)", "is_checked": False},
                            {"text": "Speaker lineup confirmed", "is_checked": False},
                            {"text": "Registration page live", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Email & Newsletter",
                "color": "#F59E0B",
                "contact_email": "content@internal.example",
                "notes": "Weekly newsletter (Fri) + product update emails. List: 12k subscribers.",
                "cards": [
                    {
                        "title": "March product update email",
                        "description": (
                            "Monthly product update email covering: template library v2, "
                            "new Slack integration, and cursor pagination improvements."
                        ),
                        "col_idx": 7,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Product"],
                        "checklist": [
                            {"text": "Copy written", "is_checked": True},
                            {"text": "Design reviewed", "is_checked": True},
                            {"text": "A/B subject line test set up", "is_checked": True},
                            {"text": "Sent to 12k subscribers", "is_checked": True},
                        ],
                        "comments": [
                            "Open rate: 34.2% (above 28% benchmark). Click-through: 8.1%.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Weekly newsletter — week of 2026-03-23",
                        "description": (
                            "Friday newsletter: 3 kanban tips, 1 customer spotlight (Mosaic), "
                            "and the upcoming webinar announcement."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": 2,
                        "weight": 2,
                        "labels": ["Evergreen"],
                        "checklist": [
                            {"text": "Tips section written", "is_checked": True},
                            {"text": "Customer spotlight section written", "is_checked": True},
                            {"text": "Internal review", "is_checked": True},
                            {"text": "Scheduled in Mailchimp", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "Social & Short-form",
                "color": "#EC4899",
                "contact_email": "content@internal.example",
                "notes": "LinkedIn, X/Twitter, and short-form posts. Cadence: 3x per week per channel.",
                "cards": [
                    {
                        "title": "LinkedIn carousel: swimlane vs. simple list",
                        "description": (
                            "10-slide LinkedIn carousel explaining when to use swimlanes vs. "
                            "a simple columnar board. "
                            "Visual-first. Each slide = one data point or scenario."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": 4,
                        "weight": 2,
                        "labels": ["SEO", "Thought Leadership"],
                        "checklist": [
                            {"text": "Outline approved", "is_checked": True},
                            {"text": "Slides designed", "is_checked": True},
                            {"text": "Copy written and reviewed", "is_checked": True},
                            {"text": "Final approval", "is_checked": True},
                            {"text": "Scheduled in Buffer", "is_checked": False},
                        ],
                        "comments": [
                            "Ready to schedule. Targeting Tuesday 9am for peak LinkedIn engagement.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "X thread: 5 kanban anti-patterns",
                        "description": (
                            "Thread covering common mistakes teams make on kanban boards: "
                            "infinite WIP, no swimlanes, stale cards, etc."
                        ),
                        "col_idx": 1,
                        "priority": "low",
                        "due_offset": 12,
                        "weight": 1,
                        "labels": ["Thought Leadership"],
                        "checklist": [
                            {"text": "Draft 10-tweet thread", "is_checked": False},
                            {"text": "Review by marketing lead", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
        ],
    },

    # ── Hiring & Recruiting ───────────────────────────────────────────────────
    "hiring_recruiting": {
        "board_name": "Template: Hiring & Recruiting",
        "description": (
            "Track candidates from application through hire or rejection. "
            "Each swimlane is an open role; each card is a candidate."
        ),
        "columns": [
            {"name": "Applied",          "color": "#6B7280", "allow_card_creation": True},
            {"name": "Phone Screen",     "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Technical Screen", "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "Interview",        "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Reference Check",  "color": "#F97316", "allow_card_creation": False},
            {"name": "Offer Extended",   "color": "#EC4899", "allow_card_creation": False},
            {"name": "Hired",            "color": "#10B981", "allow_card_creation": False},
            {"name": "Rejected",         "color": "#9CA3AF", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "Strong Yes",  "color": "#10B981"},
            {"name": "Yes",         "color": "#3B82F6"},
            {"name": "Maybe",       "color": "#F59E0B"},
            {"name": "No",          "color": "#EF4444"},
            {"name": "Referred",    "color": "#8B5CF6"},
        ],
        "swimlanes": [
            {
                "name": "Senior Backend Engineer",
                "color": "#3B82F6",
                "contact_email": "hiring@internal.example",
                "notes": "Django + DRF. 5+ yrs. Hiring manager: Alex Rivera. Target: hire by 2026-05-01.",
                "cards": [
                    {
                        "title": "Priya Sharma",
                        "description": (
                            "7 years Python/Django. Previous: Staff Engineer at FinEdge.\n\n"
                            "Referred by Casey Osei. Strong GitHub presence — Django contrib.\n\n"
                            "**Recruiter note:** Very communicative. Responds within hours."
                        ),
                        "col_idx": 5,
                        "priority": "high",
                        "due_offset": 3,
                        "weight": 5,
                        "labels": ["Strong Yes", "Referred"],
                        "checklist": [
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Technical screen passed (scored 92/100)", "is_checked": True},
                            {"text": "On-site loop completed", "is_checked": True},
                            {"text": "References called (2/3 complete)", "is_checked": True},
                            {"text": "Offer letter sent", "is_checked": True},
                            {"text": "Awaiting candidate response", "is_checked": False},
                        ],
                        "comments": [
                            "Hiring loop unanimous strong yes. References glowing.",
                            "Offer sent 2026-03-18. Response deadline 2026-03-25.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Marcus Jeon",
                        "description": (
                            "5 years Python. Previous: Backend Lead at DataStream.\n\n"
                            "Applied via LinkedIn. Strong system design answers in phone screen."
                        ),
                        "col_idx": 2,
                        "priority": "medium",
                        "due_offset": 7,
                        "weight": 3,
                        "labels": ["Yes"],
                        "checklist": [
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Technical screen scheduled", "is_checked": True},
                            {"text": "Technical screen completed", "is_checked": False},
                        ],
                        "comments": [
                            "Technical screen tomorrow at 2pm. Interviewer: Jordan Patel.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Rachel Torres",
                        "description": (
                            "4 years Python, 2 years Django. Previous: Backend Engineer at Summit.\n\n"
                            "Inbound application. Passed initial resume screen."
                        ),
                        "col_idx": 1,
                        "priority": "low",
                        "due_offset": 10,
                        "weight": 2,
                        "labels": ["Maybe"],
                        "checklist": [
                            {"text": "Resume reviewed", "is_checked": True},
                            {"text": "Phone screen scheduled", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Product Designer (Senior)",
                "color": "#EC4899",
                "contact_email": "hiring@internal.example",
                "notes": "Figma, design systems, user research. Hiring manager: Casey Osei. Urgent fill.",
                "cards": [
                    {
                        "title": "Anika Obi",
                        "description": (
                            "6 years UX/product design. Previous: Lead Designer at Mosaic Creative.\n\n"
                            "Portfolio standout: redesigned Mosaic's client dashboard — NPS +18."
                        ),
                        "col_idx": 6,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["Strong Yes"],
                        "checklist": [
                            {"text": "Portfolio review passed", "is_checked": True},
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Design challenge submitted and scored (94/100)", "is_checked": True},
                            {"text": "Full panel interview passed", "is_checked": True},
                            {"text": "References clear", "is_checked": True},
                            {"text": "Offer accepted", "is_checked": True},
                        ],
                        "comments": [
                            "Hired! Start date 2026-04-14. Exceptional candidate.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Leo Bergman",
                        "description": (
                            "4 years UX. Previous: mid-level designer at a fintech startup.\n\n"
                            "Good craft but portfolio lacks systems-level design thinking."
                        ),
                        "col_idx": 7,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["No"],
                        "checklist": [
                            {"text": "Portfolio review — not moved forward", "is_checked": True},
                            {"text": "Rejection email sent", "is_checked": True},
                        ],
                        "comments": [
                            "Good fundamentals but not at senior level yet. Encourage to apply again in 12 months.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "Fatima Al-Hassan",
                        "description": (
                            "5 years product design. Previous: design systems lead at a B2B SaaS company.\n\n"
                            "Referred by a Visiban customer. Strong design systems background."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Yes", "Referred"],
                        "checklist": [
                            {"text": "Portfolio review passed", "is_checked": True},
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Design challenge submitted", "is_checked": True},
                            {"text": "Panel interview scheduled", "is_checked": False},
                        ],
                        "comments": [
                            "Design challenge score: 88/100. Strong systems thinking.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "Customer Success Manager",
                "color": "#10B981",
                "contact_email": "hiring@internal.example",
                "notes": "B2B SaaS CS experience required. EMEA coverage preferred.",
                "cards": [
                    {
                        "title": "Nour El-Amin",
                        "description": (
                            "4 years CS at a B2B SaaS company. Fluent Arabic, French, English.\n\n"
                            "EMEA-based. Strong renewals track record (98% retention)."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 8,
                        "weight": 4,
                        "labels": ["Strong Yes"],
                        "checklist": [
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Case study interview passed", "is_checked": True},
                            {"text": "Panel interview passed", "is_checked": True},
                            {"text": "Reference check in progress (2/3)", "is_checked": False},
                        ],
                        "comments": [
                            "Panel loved her. Reference check almost done.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "James Okonkwo",
                        "description": (
                            "3 years CS at an enterprise software firm. UK-based.\n\n"
                            "Good phone screen but case study interview was average."
                        ),
                        "col_idx": 7,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Maybe"],
                        "checklist": [
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Case study interview — not progressing", "is_checked": True},
                            {"text": "Rejection sent", "is_checked": True},
                        ],
                        "comments": [
                            "Not strong enough on strategic account planning. Polite rejection sent.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "DevOps Engineer",
                "color": "#14B8A6",
                "contact_email": "hiring@internal.example",
                "notes": "Kubernetes, Terraform, AWS. Ideally 4+ yrs. Hiring manager: Morgan Wu.",
                "cards": [
                    {
                        "title": "Kenji Nakamura",
                        "description": (
                            "5 years DevOps/SRE. Previous: SRE at a high-traffic API company.\n\n"
                            "Kubernetes CKA certified. Strong incident management background."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 6,
                        "weight": 4,
                        "labels": ["Yes"],
                        "checklist": [
                            {"text": "Phone screen passed", "is_checked": True},
                            {"text": "Technical screen: K8s + Terraform — scheduled", "is_checked": True},
                            {"text": "Technical screen completed", "is_checked": False},
                        ],
                        "comments": [
                            "Technical screen tomorrow. Strong phone screen.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Sara Lundqvist",
                        "description": (
                            "3 years DevOps. Previous: cloud infra engineer.\n\n"
                            "Good fundamentals but limited Kubernetes experience."
                        ),
                        "col_idx": 0,
                        "priority": "low",
                        "due_offset": 15,
                        "weight": 1,
                        "labels": ["Maybe"],
                        "checklist": [
                            {"text": "Resume reviewed — moving to phone screen", "is_checked": True},
                            {"text": "Phone screen scheduled", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "Head of Marketing",
                "color": "#F97316",
                "contact_email": "hiring@internal.example",
                "notes": "VP-level. B2B SaaS growth marketing. Reports to CEO. Confidential search.",
                "cards": [
                    {
                        "title": "Diana Ferreira",
                        "description": (
                            "VP Marketing at a Series B SaaS company for 3 years. "
                            "Grew pipeline 4x. Content + demand gen background.\n\n"
                            "Introduced via executive search firm. Confidential — do not reference internally."
                        ),
                        "col_idx": 3,
                        "priority": "urgent",
                        "due_offset": 7,
                        "weight": 5,
                        "labels": ["Strong Yes"],
                        "checklist": [
                            {"text": "Intro call with CEO", "is_checked": True},
                            {"text": "Exec panel (CEO + CTO + VP CS)", "is_checked": True},
                            {"text": "Presentation: 90-day marketing plan", "is_checked": True},
                            {"text": "Reference check (confidential)", "is_checked": False},
                        ],
                        "comments": [
                            "Exec panel strong consensus. References underway (confidential).",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
        ],
    },

    # ── Legal & Compliance ────────────────────────────────────────────────────
    "legal_compliance": {
        "board_name": "Template: Legal & Compliance",
        "description": (
            "Track compliance requests and approvals per department. "
            "Each swimlane is a department; each card is a compliance request or review."
        ),
        "columns": [
            {"name": "Submitted",           "color": "#6B7280", "allow_card_creation": True},
            {"name": "Under Review",        "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Needs Clarification", "color": "#F97316", "allow_card_creation": False},
            {"name": "Approved",            "color": "#10B981", "allow_card_creation": False},
            {"name": "Denied",              "color": "#EF4444", "allow_card_creation": False},
            {"name": "Archived",            "color": "#9CA3AF", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "GDPR",        "color": "#3B82F6"},
            {"name": "SOC 2",       "color": "#8B5CF6"},
            {"name": "Contract",    "color": "#F59E0B"},
            {"name": "Policy",      "color": "#10B981"},
            {"name": "Vendor",      "color": "#F97316"},
        ],
        "swimlanes": [
            {
                "name": "Engineering",
                "color": "#3B82F6",
                "contact_email": "legal@internal.example",
                "notes": "Infra, security, and product engineering compliance requests.",
                "cards": [
                    {
                        "title": "GDPR data deletion pipeline — legal sign-off",
                        "description": (
                            "Request for legal sign-off on the automated GDPR erasure pipeline.\n\n"
                            "Pipeline cascades deletion across boards, cards, comments, "
                            "activity logs, and exports.\n\n"
                            "Legal must confirm full coverage before pipeline goes live."
                        ),
                        "col_idx": 3,
                        "priority": "urgent",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["GDPR", "Policy"],
                        "checklist": [
                            {"text": "Technical spec submitted to legal", "is_checked": True},
                            {"text": "Legal reviewed data flow diagram", "is_checked": True},
                            {"text": "Sign-off received", "is_checked": True},
                            {"text": "Archived in compliance system", "is_checked": False},
                        ],
                        "comments": [
                            "Legal confirmed full GDPR coverage. Pipeline cleared for production.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "New AWS vendor agreement — DPA review",
                        "description": (
                            "AWS updated its Data Processing Addendum. "
                            "Legal must review against current GDPR obligations.\n\n"
                            "Deadline: 2026-04-15 (AWS contract renewal date)."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["GDPR", "Vendor"],
                        "checklist": [
                            {"text": "Receive updated DPA from AWS", "is_checked": True},
                            {"text": "Legal review in progress", "is_checked": False},
                        ],
                        "comments": [
                            "DPA received 2026-03-18. Review started.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Penetration test scope approval",
                        "description": (
                            "Annual pen test scope requires legal review before external firm "
                            "is granted staging access.\n\n"
                            "Scope: web app, API, WebSocket layer, and auth flows."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["SOC 2"],
                        "checklist": [
                            {"text": "Scope document submitted", "is_checked": True},
                            {"text": "Legal approved", "is_checked": True},
                            {"text": "Archived", "is_checked": False},
                        ],
                        "comments": [
                            "Approved same day. Pen test firm granted access.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Finance",
                "color": "#F59E0B",
                "contact_email": "legal@internal.example",
                "notes": "Contract reviews, financial compliance, and vendor agreements.",
                "cards": [
                    {
                        "title": "Customer MSA redline review — TechNova",
                        "description": (
                            "TechNova's legal team proposed two redlines on the MSA:\n\n"
                            "1. Liability cap: 2x ARR (we proposed 1x)\n"
                            "2. Data deletion SLA: 30 days (we proposed 90 days)\n\n"
                            "Finance and legal must agree before counter-proposal is sent."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 3,
                        "weight": 5,
                        "labels": ["Contract"],
                        "checklist": [
                            {"text": "Receive TechNova redlines", "is_checked": True},
                            {"text": "Finance review of liability cap impact", "is_checked": True},
                            {"text": "Engineering confirm 30-day deletion feasibility", "is_checked": False},
                            {"text": "Send counter-proposal", "is_checked": False},
                        ],
                        "comments": [
                            "Finance approved 2x ARR cap. Waiting on engineering for deletion SLA.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Accounts payable policy update",
                        "description": (
                            "Updated AP policy requiring dual approval for any invoice > $10k. "
                            "Policy change requires legal review and board sign-off."
                        ),
                        "col_idx": 3,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Policy"],
                        "checklist": [
                            {"text": "Policy draft submitted", "is_checked": True},
                            {"text": "Legal reviewed", "is_checked": True},
                            {"text": "Board sign-off obtained", "is_checked": True},
                            {"text": "Policy published internally", "is_checked": False},
                        ],
                        "comments": [
                            "Board approved 2026-03-12. Publishing to all staff next week.",
                        ],
                        "assignee_idx": 1,
                    },
                ],
            },
            {
                "name": "HR & People",
                "color": "#10B981",
                "contact_email": "legal@internal.example",
                "notes": "Employment law, policy reviews, and people compliance.",
                "cards": [
                    {
                        "title": "Remote work policy — legal review",
                        "description": (
                            "Updated remote work policy covering 14 countries. "
                            "Legal must confirm compliance with each country's employment law.\n\n"
                            "Focus areas: expense policy, tax nexus, and equipment ownership."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Policy"],
                        "checklist": [
                            {"text": "HR submitted draft policy", "is_checked": True},
                            {"text": "Legal review: UK and EU", "is_checked": True},
                            {"text": "Legal review: APAC", "is_checked": False},
                            {"text": "Final policy approved", "is_checked": False},
                        ],
                        "comments": [
                            "UK and EU sections clear. APAC review (Australia + Japan) in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Employee data retention policy",
                        "description": (
                            "Define and document how long employee records are retained, "
                            "segmented by record type (payroll, performance, disciplinary).\n\n"
                            "Triggered by GDPR audit finding."
                        ),
                        "col_idx": 5,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["GDPR", "Policy"],
                        "checklist": [
                            {"text": "Record types catalogued", "is_checked": True},
                            {"text": "Retention periods defined", "is_checked": True},
                            {"text": "Policy approved and published", "is_checked": True},
                            {"text": "Archived in compliance system", "is_checked": True},
                        ],
                        "comments": [
                            "Policy archived. GDPR audit finding closed.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "Sales & Customer Contracts",
                "color": "#8B5CF6",
                "contact_email": "legal@internal.example",
                "notes": "Enterprise contract reviews, NDA requests, and DPA processing.",
                "cards": [
                    {
                        "title": "NDA request — GlobalBank Corp",
                        "description": (
                            "GlobalBank requires a mutual NDA before sharing their IT architecture "
                            "diagrams for the integration scoping call.\n\n"
                            "Standard mutual NDA template. Turnaround target: 24 hours."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Contract"],
                        "checklist": [
                            {"text": "NDA submitted by account team", "is_checked": True},
                            {"text": "Legal reviewed — standard terms, no issues", "is_checked": True},
                            {"text": "Both parties executed", "is_checked": True},
                            {"text": "Filed in contract management system", "is_checked": False},
                        ],
                        "comments": [
                            "Executed in 18 hours. Filed.",
                        ],
                        "assignee_idx": 4,
                    },
                    {
                        "title": "HIPAA BAA — BlueSky Health",
                        "description": (
                            "BlueSky Health requires a HIPAA Business Associate Agreement "
                            "before any trial data can be provisioned.\n\n"
                            "Standard Visiban BAA covers PHI in transit and at rest."
                        ),
                        "col_idx": 2,
                        "priority": "urgent",
                        "due_offset": 5,
                        "weight": 4,
                        "labels": ["Contract"],
                        "checklist": [
                            {"text": "BAA sent to BlueSky legal", "is_checked": True},
                            {"text": "BlueSky redlines received", "is_checked": True},
                            {"text": "Legal reviewing redlines", "is_checked": False},
                            {"text": "Execute and file signed BAA", "is_checked": False},
                        ],
                        "comments": [
                            "Two minor redlines received. Legal reviewing now.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Product & Engineering Policy",
                "color": "#EC4899",
                "contact_email": "legal@internal.example",
                "notes": "OSS license reviews, open-source contribution policy, IP assignments.",
                "cards": [
                    {
                        "title": "Apache 2.0 vs ELv2 boundary review",
                        "description": (
                            "Annual review of the OSS/enterprise license boundary. "
                            "Confirm all files in enterprise/ have ELv2 headers and "
                            "no Apache 2.0 code has been inadvertently mixed in."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 12,
                        "weight": 3,
                        "labels": ["Policy"],
                        "checklist": [
                            {"text": "Automated license header scan run", "is_checked": True},
                            {"text": "Manual review of enterprise/ directory", "is_checked": False},
                            {"text": "Any mixed-license files corrected", "is_checked": False},
                            {"text": "Legal sign-off on clean state", "is_checked": False},
                        ],
                        "comments": [
                            "Automated scan: 3 files flagged. Manual review in progress.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "New dependency license review — celery 5.4",
                        "description": (
                            "celery 5.4 has been proposed as a dependency. "
                            "BSD 3-Clause license — confirm compatible with Apache 2.0 distribution."
                        ),
                        "col_idx": 3,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 1,
                        "labels": ["Policy"],
                        "checklist": [
                            {"text": "License confirmed: BSD 3-Clause", "is_checked": True},
                            {"text": "Compatible with Apache 2.0 — approved", "is_checked": True},
                            {"text": "Archived", "is_checked": False},
                        ],
                        "comments": [
                            "Approved. BSD 3-Clause is compatible with Apache 2.0.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
        ],
    },

    # ── Infrastructure & DevOps ────────────────────────────────────────────────
    "infra_devops": {
        "board_name": "Template: Infrastructure & DevOps",
        "description": (
            "Track incidents and change requests per service from report through verification. "
            "Each swimlane is a service or system; each card is an incident or change."
        ),
        "columns": [
            {"name": "Reported",      "color": "#6B7280", "allow_card_creation": True},
            {"name": "Triaged",       "color": "#3B82F6", "allow_card_creation": True},
            {"name": "Assigned",      "color": "#8B5CF6", "allow_card_creation": False},
            {"name": "In Progress",   "color": "#F59E0B", "allow_card_creation": False},
            {"name": "Testing",       "color": "#F97316", "allow_card_creation": False},
            {"name": "Change Window", "color": "#EC4899", "allow_card_creation": False},
            {"name": "Deployed",      "color": "#14B8A6", "allow_card_creation": False},
            {"name": "Verified",      "color": "#10B981", "allow_card_creation": False},
        ],
        "labels": [
            {"name": "P0 - Critical", "color": "#EF4444"},
            {"name": "P1 - High",     "color": "#F97316"},
            {"name": "P2 - Medium",   "color": "#F59E0B"},
            {"name": "Change",        "color": "#3B82F6"},
            {"name": "Security",      "color": "#8B5CF6"},
        ],
        "swimlanes": [
            {
                "name": "API Gateway",
                "color": "#3B82F6",
                "contact_email": "ops@internal.example",
                "notes": "Kong API gateway. Handles all external API traffic. SLA: 99.95% uptime.",
                "cards": [
                    {
                        "title": "Rate limit bypass on /api/export/ endpoint",
                        "description": (
                            "Reported by security scan: the /api/export/ endpoint bypasses "
                            "the standard rate limiter. Large boards can be exported in a tight loop "
                            "causing elevated DB load.\n\n"
                            "Severity: P1 — service degradation, not outage."
                        ),
                        "col_idx": 5,
                        "priority": "urgent",
                        "due_offset": 1,
                        "weight": 5,
                        "labels": ["P1 - High", "Security"],
                        "checklist": [
                            {"text": "Confirm rate limit bypass is reproducible", "is_checked": True},
                            {"text": "Add rate limiter to /api/export/ in Kong config", "is_checked": True},
                            {"text": "Test rate limit enforcement in staging", "is_checked": True},
                            {"text": "Deploy during off-peak window", "is_checked": True},
                            {"text": "Verify rate limit is active in production", "is_checked": False},
                        ],
                        "comments": [
                            "Fix tested in staging. Deploying tonight 02:00-04:00 UTC.",
                        ],
                        "assignee_idx": 2,
                    },
                    {
                        "title": "Upgrade Kong from 3.1 to 3.6",
                        "description": (
                            "Kong 3.1 reaches end of life 2026-05-01. "
                            "Upgrade to 3.6 for security patches and performance improvements.\n\n"
                            "Breaking changes: plugin API changes in 3.4. Test all custom plugins."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 14,
                        "weight": 4,
                        "labels": ["Change", "P2 - Medium"],
                        "checklist": [
                            {"text": "Audit custom plugins for 3.4 breaking changes", "is_checked": True},
                            {"text": "Update plugins in staging", "is_checked": True},
                            {"text": "Staging smoke test", "is_checked": False},
                            {"text": "Schedule production change window", "is_checked": False},
                        ],
                        "comments": [
                            "2 custom plugins need minor updates for 3.4 API changes.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Add circuit breaker for downstream DB connections",
                        "description": (
                            "During last month's DB failover, the API gateway continued routing "
                            "traffic, causing request queuing and timeout cascades.\n\n"
                            "Add a circuit breaker that opens after 3 consecutive DB timeouts."
                        ),
                        "col_idx": 1,
                        "priority": "high",
                        "due_offset": 21,
                        "weight": 4,
                        "labels": ["Change"],
                        "checklist": [
                            {"text": "Design circuit breaker logic", "is_checked": True},
                            {"text": "Implement in Kong config", "is_checked": False},
                            {"text": "Chaos test: simulate DB failure", "is_checked": False},
                        ],
                        "comments": [],
                        "assignee_idx": 3,
                    },
                ],
            },
            {
                "name": "PostgreSQL Cluster",
                "color": "#8B5CF6",
                "contact_email": "ops@internal.example",
                "notes": "Primary RDS PostgreSQL 15. Read replica in APAC. WAL streaming to S3.",
                "cards": [
                    {
                        "title": "Unplanned failover — primary DB unreachable",
                        "description": (
                            "2026-03-10 01:47 UTC: Primary RDS instance became unreachable. "
                            "Failover to replica completed in 4m 22s.\n\n"
                            "Root cause: AZ-level network event in us-east-1b. "
                            "Postmortem required."
                        ),
                        "col_idx": 7,
                        "priority": "urgent",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["P0 - Critical"],
                        "checklist": [
                            {"text": "Incident declared and team paged", "is_checked": True},
                            {"text": "Traffic rerouted to replica", "is_checked": True},
                            {"text": "Primary restored", "is_checked": True},
                            {"text": "Postmortem written", "is_checked": True},
                            {"text": "Action items tracked", "is_checked": True},
                        ],
                        "comments": [
                            "Incident resolved. Postmortem published 2026-03-11. 3 action items.",
                            "Action items: (1) lower failover time SLA (2) add AZ redundancy (3) page SRE faster.",
                        ],
                        "assignee_idx": 0,
                    },
                    {
                        "title": "Add connection pooling via PgBouncer",
                        "description": (
                            "During peak traffic (Monday mornings) we approach the max_connections "
                            "limit. Adding PgBouncer in transaction mode will reduce connection overhead.\n\n"
                            "Expected: support 2x current peak traffic without hitting the limit."
                        ),
                        "col_idx": 4,
                        "priority": "high",
                        "due_offset": 7,
                        "weight": 4,
                        "labels": ["Change", "P1 - High"],
                        "checklist": [
                            {"text": "Provision PgBouncer EC2 instance", "is_checked": True},
                            {"text": "Configure transaction pooling mode", "is_checked": True},
                            {"text": "Load test: simulate Monday peak", "is_checked": True},
                            {"text": "Migrate app connections to PgBouncer in staging", "is_checked": True},
                            {"text": "Production deployment scheduled", "is_checked": False},
                        ],
                        "comments": [
                            "Load test passed. Peak connection count down 68%. Ready for prod.",
                        ],
                        "assignee_idx": 2,
                    },
                ],
            },
            {
                "name": "CI/CD Pipeline",
                "color": "#10B981",
                "contact_email": "ops@internal.example",
                "notes": "GitLab CI. Average pipeline: 12 min. Target: < 8 min.",
                "cards": [
                    {
                        "title": "Backend test suite taking 18+ minutes",
                        "description": (
                            "The backend test suite grew from 8 min to 18 min over the last quarter. "
                            "Blocking developer velocity.\n\n"
                            "Investigation: serial test execution, no DB fixtures caching."
                        ),
                        "col_idx": 3,
                        "priority": "high",
                        "due_offset": 10,
                        "weight": 4,
                        "labels": ["P1 - High", "Change"],
                        "checklist": [
                            {"text": "Profile slow tests (> 500ms each)", "is_checked": True},
                            {"text": "Parallelize test runner across 4 workers", "is_checked": True},
                            {"text": "Add setUpTestData for fixture-heavy test classes", "is_checked": False},
                            {"text": "Verify pipeline drops below 8 min target", "is_checked": False},
                        ],
                        "comments": [
                            "Parallelization alone cut from 18 min to 11 min. setUpTestData should get us to ~7.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Add SAST scan (Bandit + semgrep) to all MRs",
                        "description": (
                            "Static analysis security scanning is currently optional. "
                            "Make it a required CI gate that blocks merge on high-severity findings."
                        ),
                        "col_idx": 7,
                        "priority": "medium",
                        "due_offset": None,
                        "weight": 3,
                        "labels": ["Change", "Security"],
                        "checklist": [
                            {"text": "Add bandit job to .gitlab-ci.yml", "is_checked": True},
                            {"text": "Add semgrep job with python ruleset", "is_checked": True},
                            {"text": "Set job as required for merge", "is_checked": True},
                            {"text": "Clear all pre-existing findings", "is_checked": True},
                        ],
                        "comments": [
                            "SAST gate live. 0 pre-existing findings after cleanup sprint.",
                        ],
                        "assignee_idx": 0,
                    },
                ],
            },
            {
                "name": "Object Storage (S3)",
                "color": "#F59E0B",
                "contact_email": "ops@internal.example",
                "notes": "AWS S3. Stores board exports, card attachments, and WAL backups.",
                "cards": [
                    {
                        "title": "WAL backup verification failure",
                        "description": (
                            "Automated WAL backup verification failed on 3 consecutive days. "
                            "Backups are uploading but the checksum verification Lambda is timing out.\n\n"
                            "Actual backups appear intact — this is a monitoring issue, not a data loss risk."
                        ),
                        "col_idx": 2,
                        "priority": "high",
                        "due_offset": 2,
                        "weight": 4,
                        "labels": ["P1 - High"],
                        "checklist": [
                            {"text": "Confirm backups are intact (manual spot check)", "is_checked": True},
                            {"text": "Identify Lambda timeout root cause", "is_checked": True},
                            {"text": "Increase Lambda timeout from 30s to 120s", "is_checked": False},
                            {"text": "Verify verification passes for 3 consecutive runs", "is_checked": False},
                        ],
                        "comments": [
                            "Backups confirmed intact. Lambda timeout is the issue — fix in staging.",
                        ],
                        "assignee_idx": 1,
                    },
                    {
                        "title": "Enable S3 Intelligent-Tiering for attachment bucket",
                        "description": (
                            "Card attachments older than 90 days are rarely accessed. "
                            "Enable Intelligent-Tiering to automatically move cold objects "
                            "to lower-cost storage.\n\n"
                            "Estimated saving: $180/month."
                        ),
                        "col_idx": 7,
                        "priority": "low",
                        "due_offset": None,
                        "weight": 2,
                        "labels": ["Change", "P2 - Medium"],
                        "checklist": [
                            {"text": "Enable Intelligent-Tiering on attachment bucket", "is_checked": True},
                            {"text": "Confirm no access pattern disruption", "is_checked": True},
                            {"text": "Monitor costs for 30 days", "is_checked": True},
                        ],
                        "comments": [
                            "Enabled 2026-02-01. Month 1 saving: $193. Verified complete.",
                        ],
                        "assignee_idx": 4,
                    },
                ],
            },
            {
                "name": "Kubernetes Cluster",
                "color": "#EF4444",
                "contact_email": "ops@internal.example",
                "notes": "EKS on AWS. Runs all backend services. Auto-scaling 3-12 nodes.",
                "cards": [
                    {
                        "title": "Node group OOM kill during Monday traffic spike",
                        "description": (
                            "2026-03-17 08:45 UTC: 2 backend pods OOM-killed during Monday traffic spike.\n\n"
                            "Root cause: default memory limit (512Mi) too low for current board query patterns. "
                            "Increase to 1Gi and add vertical pod autoscaler."
                        ),
                        "col_idx": 6,
                        "priority": "urgent",
                        "due_offset": None,
                        "weight": 5,
                        "labels": ["P0 - Critical", "Change"],
                        "checklist": [
                            {"text": "Increase memory limits to 1Gi in deployment manifest", "is_checked": True},
                            {"text": "Deploy updated manifest", "is_checked": True},
                            {"text": "Install VPA and configure for backend deployment", "is_checked": True},
                            {"text": "Verify no OOM kills in next Monday spike", "is_checked": False},
                        ],
                        "comments": [
                            "Memory limits updated and VPA configured. Monitoring next Monday.",
                        ],
                        "assignee_idx": 3,
                    },
                    {
                        "title": "Upgrade Kubernetes from 1.28 to 1.30",
                        "description": (
                            "EKS 1.28 support ends 2026-11-01. "
                            "Plan the upgrade path: 1.28 → 1.29 → 1.30 in separate change windows.\n\n"
                            "Test all Helm charts and custom operators against 1.30 API changes."
                        ),
                        "col_idx": 0,
                        "priority": "medium",
                        "due_offset": 60,
                        "weight": 4,
                        "labels": ["Change", "P2 - Medium"],
                        "checklist": [
                            {"text": "Audit deprecated APIs in current Helm charts", "is_checked": False},
                            {"text": "Test 1.29 upgrade in staging cluster", "is_checked": False},
                            {"text": "Test 1.30 upgrade in staging cluster", "is_checked": False},
                            {"text": "Schedule 1.29 production change window", "is_checked": False},
                        ],
                        "comments": [],
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
