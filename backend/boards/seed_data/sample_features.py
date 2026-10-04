"""
1.2 feature layer for the sample boards: custom fields, swimlane fields,
column limits and MR links, per template slug.

``column_limits`` maps a column to ``(wip_headroom, weight_headroom)``, each
relative to the column's live (unarchived) load once the cards are placed:
``3`` sets the limit three above the current count, ``-1`` one below it, so
the column renders over its limit. Each board has exactly one column over
on purpose — enough to show the flag, not so many that it reads as broken.
``None`` leaves that limit unset.

Loaded via importlib from generate_seed_data.py — do not run directly.

Kept separate from the card corpora so the original titles, checklists and
comments stay where they were; this module only *adds* to each board. Every
value is derived from the card itself (its column, labels, priority) through
a per-card ``random.Random`` seeded from the slug and title, never from the
generator's shared stream, so adding or editing a field here never reshuffles
another template's cards.

Field values are written in the form the API stores and the exporter emits:
numbers as plain strings, dates as ISO ``YYYY-MM-DD``, checkboxes as
``"true"``/``"false"``, multi-select as a compact JSON array in choice order.
``backend/boards/tests/test_sample_boards.py`` imports every sample through
the real endpoint and fails if any value is dropped, so a value the API would
refuse cannot ship here.
"""

import json
from datetime import datetime, timedelta, timezone

ANCHOR = datetime(2026, 3, 15, 12, 0, 0, tzinfo=timezone.utc)


def d(days_from_anchor):
    return (ANCHOR + timedelta(days=days_from_anchor)).strftime("%Y-%m-%d")


def multi(choices, picked):
    """Canonical multi-select value: choice order, compact JSON, "" when empty."""
    ordered = [c for c in choices if c in set(picked)]
    return json.dumps(ordered, separators=(",", ":")) if ordered else ""


def field(name, field_type, gen, choices=(), show=False, help_text="", **display):
    """A card custom field: its definition plus ``gen(ctx) -> value | None``."""
    return {
        "name": name, "field_type": field_type, "choices": list(choices),
        "show_on_card": show, "help_text": help_text, "display": display, "gen": gen,
    }


def lane_field(name, field_type, gen, choices=(), show=False, admin_only=False,
               help_text="", **display):
    """A swimlane field: definition plus ``gen(lane_ctx) -> value | None``."""
    return {
        "name": name, "field_type": field_type, "choices": list(choices),
        "show_on_row": show, "is_admin_only": admin_only, "help_text": help_text,
        "display": display, "gen": gen,
    }


# ── Shared value helpers (ctx keys: see generate_seed_data._field_ctx) ──────
def _pick(choices):
    return lambda c: c["rng"].choice(choices)


def _some(choices, lo=1, hi=2):
    def gen(c):
        n = c["rng"].randint(lo, min(hi, len(choices)))
        return multi(choices, c["rng"].sample(choices, n))
    return gen


def _money(lo, hi, step=1000):
    return lambda c: str(c["rng"].randrange(lo, hi, step))


def _often(gen, rate=0.8):
    """Leave a field empty on some cards, the way real boards look."""
    return lambda c: gen(c) if c["rng"].random() < rate else None


def _future(lo, hi):
    return lambda c: d(c["rng"].randint(lo, hi))


def _flag(rate):
    return lambda c: "true" if c["rng"].random() < rate else "false"


def _by_progress(choices):
    """Pick from ``choices`` by how far along the board the card is."""
    def gen(c):
        if c["lost"]:
            return choices[-1]
        i = min(int(c["progress"] * (len(choices) - 1) + 0.5), len(choices) - 2)
        return choices[i] if not c["is_done"] else choices[-2]
    return gen


def _lane_pool(pool):
    return lambda lc: pool[lc["index"] % len(pool)]


def _url(base):
    return lambda c: f"{base}{c['seq']:04d}"


# Fictional people for owner-style row fields. Distinct per template slot so
# two boards never read like the same org chart.
_PEOPLE = [
    "Avery Brooks", "Priya Raman", "Marcus Hale", "Elena Petrova", "Kwame Mensah",
    "Hana Kobayashi", "Lucas Ferreira", "Nadia Haddad", "Owen Gallagher",
    "Sofia Marino", "Tariq Aziz", "Mei Lin", "Jonas Berg", "Isabel Ortiz",
]


def _people(offset):
    return lambda lc: _PEOPLE[(lc["index"] + offset) % len(_PEOPLE)]


# ═════════════════════════════════════════════════════════════════════════════
FEATURES = {
    "sales_pipeline": {
        "descriptions": ["Opportunity in the {lane} territory. Keep the forecast category and close date current before Monday's pipeline call.", '{lane} deal. Track buyer steps in the checklist; log every customer touch as a comment.'],
        "column_limits": {"Negotiation": (-1, None), "Proposal Sent": (3, 10)},
        "card_fields": [
            field("Deal value", "number", _money(15000, 480000, 5000), show=True,
                  help_text="Annual contract value of the opportunity.",
                  number_prefix="$", number_decimals=0),
            field("Forecast", "dropdown",
                  _by_progress(["Pipeline", "Best case", "Commit", "Closed won", "Closed lost"]),
                  choices=["Pipeline", "Best case", "Commit", "Closed won", "Closed lost"], show=True,
                  help_text="Forecast category the rep is calling.",
                  choice_colors={"Pipeline": "slate", "Best case": "blue", "Commit": "amber",
                                 "Closed won": "green", "Closed lost": "red"}),
            field("Win probability", "number",
                  lambda c: "0" if c["lost"] else str(min(100, 10 + int(c["progress"] * 90))),
                  help_text="Stage-weighted likelihood of closing.", number_suffix="%", number_decimals=0),
            field("Expected close", "date", _often(_future(-20, 120), 0.85),
                  help_text="When the rep expects signature."),
            field("Competitors", "multi_select", _often(_some(["Incumbent", "Low-cost rival", "Build in-house", "Regional reseller"]), 0.6),
                  choices=["Incumbent", "Low-cost rival", "Build in-house", "Regional reseller"],
                  help_text="Who else is in the deal.",
                  choice_colors={"Incumbent": "red", "Low-cost rival": "amber", "Build in-house": "violet"}),
            field("Multi-year", "checkbox", _flag(0.3), help_text="Contract term longer than 12 months."),
            field("CRM opportunity", "url", _url("https://crm.example.com/opportunities/OPP-"),
                  help_text="Link to the opportunity record (fictional)."),
        ],
        "swimlane_fields": [
            lane_field("Regional VP", "text", _people(0), show=True, help_text="Leader accountable for the region's number."),
            lane_field("Quarterly quota", "number", lambda lc: str(600000 + lc["index"] * 150000), show=True,
                       help_text="Bookings target for the quarter.", number_prefix="$", number_decimals=0),
            lane_field("Currency", "dropdown", _lane_pool(["USD", "SGD", "EUR", "BRL", "AUD", "GBP", "EUR", "SEK", "AED", "SGD", "JPY"]),
                       choices=["USD", "EUR", "GBP", "AUD", "SGD", "JPY", "BRL", "SEK", "AED"],
                       help_text="Currency the region books in."),
            lane_field("Discount authority", "number", lambda lc: str(10 + (lc["index"] % 3) * 5), admin_only=True,
                       help_text="Maximum discount the RVP can approve without deal desk. Admins only.",
                       number_suffix="%", number_decimals=0),
        ],
    },
    "customer_support": {
        "descriptions": ['Reported by {lane}. Capture reproduction steps and the affected component before escalating.', 'Ticket for {lane}. Update the customer in the helpdesk thread whenever the status changes.'],
        "column_limits": {"Escalated": (-2, None), "Investigating": (4, 12)},
        "card_fields": [
            field("Severity", "dropdown",
                  lambda c: {"urgent": "S1", "high": "S2", "medium": "S3"}.get(c["card"]["priority"], "S4"),
                  choices=["S1", "S2", "S3", "S4"], show=True, help_text="Customer-facing impact level.",
                  choice_colors={"S1": "red", "S2": "amber", "S3": "blue", "S4": "slate"}),
            field("Ticket", "url", _url("https://help.example.com/tickets/"), show=True,
                  help_text="Ticket in the helpdesk (fictional)."),
            field("Users affected", "number", _often(lambda c: str(c["rng"].choice([1, 3, 12, 40, 250, 1200])), 0.7),
                  help_text="Approximate number of end users hit.", number_decimals=0),
            field("SLA due", "date", _often(_future(-5, 10), 0.8), help_text="Next response or resolution SLA."),
            field("Components", "multi_select", _some(["Web app", "API", "Mobile", "SSO", "Billing", "Notifications"]),
                  choices=["Web app", "API", "Mobile", "SSO", "Billing", "Notifications"],
                  help_text="Product areas involved."),
            field("Reproduced", "checkbox", lambda c: "true" if c["progress"] > 0.3 else "false",
                  help_text="Support has reproduced the issue."),
        ],
        "swimlane_fields": [
            lane_field("Support plan", "dropdown", _lane_pool(["Premier", "Business", "Standard", "Premier", "Business"]),
                       choices=["Standard", "Business", "Premier"], show=True, help_text="Contracted support tier.",
                       choice_colors={"Standard": "slate", "Business": "blue", "Premier": "violet"}),
            lane_field("CSM", "text", _people(3), show=True, help_text="Customer success manager."),
            lane_field("ARR", "number", lambda lc: str(48000 + lc["index"] * 23000), help_text="Annual recurring revenue.",
                       number_prefix="$", number_decimals=0),
            lane_field("Renewal date", "date", lambda lc: d(30 + lc["index"] * 17), help_text="Next contract renewal."),
            lane_field("Escalation contact", "text", lambda lc: f"VP Support ({_PEOPLE[(lc['index'] + 7) % len(_PEOPLE)]})",
                       admin_only=True, help_text="Who to call for an S1. Admins only."),
        ],
    },
    "customer_success": {
        "descriptions": ['{lane} segment motion. Review the health score and adoption before the next customer touchpoint.', "Lifecycle work for a {lane} account. Note risk drivers and the executive sponsor's position in comments."],
        "column_limits": {"Renewal": (-1, None), "Expansion": (3, 8)},
        "card_fields": [
            field("Health score", "number",
                  lambda c: str(c["rng"].randint(15, 40) if c["lost"] or "At Risk" in c["card"]["labels"] else c["rng"].randint(55, 96)),
                  show=True, help_text="Composite of usage, support and sentiment.", number_suffix="/100", number_decimals=0),
            field("ARR at stake", "number", _money(12000, 360000, 2000), show=True,
                  help_text="Recurring revenue tied to this motion.", number_prefix="$", number_decimals=0),
            field("Next QBR", "date", _often(_future(3, 90), 0.7), help_text="Next quarterly business review."),
            field("Products adopted", "multi_select", _some(["Boards", "Analytics", "Automation", "SSO", "API"], 1, 4),
                  choices=["Boards", "Analytics", "Automation", "SSO", "API"], help_text="Modules in active use."),
            field("Risk driver", "dropdown",
                  lambda c: c["rng"].choice(["Low usage", "Champion left", "Budget cut", "Product gap"]) if c["lost"] or "At Risk" in c["card"]["labels"] else None,
                  choices=["Low usage", "Champion left", "Budget cut", "Product gap"],
                  help_text="Primary reason the account is at risk.",
                  choice_colors={"Low usage": "amber", "Champion left": "red", "Budget cut": "red", "Product gap": "violet"}),
            field("Exec sponsor engaged", "checkbox", _flag(0.55), help_text="An executive sponsor attended the last review."),
        ],
        "swimlane_fields": [
            lane_field("CS lead", "text", _people(5), show=True, help_text="Team lead for this book of business."),
            lane_field("Book of business", "number", lambda lc: str(1200000 + lc["index"] * 310000), show=True,
                       help_text="Total ARR managed in this segment.", number_prefix="$", number_decimals=0),
            lane_field("Gross retention target", "number", lambda lc: str(90 + lc["index"] % 4), help_text="Target GRR for the year.",
                       number_suffix="%", number_decimals=0),
        ],
    },
    "simple_kanban": {
        "descriptions": ['{lane} work item. Link the merge request once a branch exists; move to Review when it is ready.', 'Owned by the {lane} team. Break anything larger than five points into separate cards.'],
        "column_limits": {"Doing": (-2, 6), "Review": (2, None)},
        "external_refs": {"provider": "gitlab", "from_progress": 0.6,
                          "url": "https://gitlab.example.com/acme/app/-/merge_requests/{n}", "ref": "!{n}"},
        "card_fields": [
            field("Story points", "number", lambda c: str(c["rng"].choice([1, 2, 3, 5, 8, 13])), show=True,
                  help_text="Relative effort, Fibonacci scale."),
            field("Sprint", "dropdown", _pick(["Sprint 41", "Sprint 42", "Sprint 43", "Next"]),
                  choices=["Sprint 41", "Sprint 42", "Sprint 43", "Next"], show=True,
                  help_text="Sprint the work is committed to.",
                  choice_colors={"Sprint 41": "slate", "Sprint 42": "blue", "Sprint 43": "teal", "Next": "violet"}),
            field("Areas", "multi_select", _some(["UI", "API", "Database", "Auth", "Infra"]),
                  choices=["UI", "API", "Database", "Auth", "Infra"], help_text="Parts of the system touched."),
            field("Needs design", "checkbox", _flag(0.25), help_text="Waiting on a design decision."),
            field("Spec", "url", _often(_url("https://wiki.example.com/specs/"), 0.4), help_text="Design or spec doc."),
            field("Target date", "date", _often(_future(-7, 45), 0.5), help_text="Date someone outside the team is relying on."),
        ],
        "swimlane_fields": [
            lane_field("Team lead", "text", _people(1), show=True, help_text="Lead for this workstream."),
            lane_field("On-call", "text", _people(8), show=True, help_text="This week's on-call engineer."),
            lane_field("Runbook", "url", lambda lc: f"https://wiki.example.com/runbooks/{lc['slug_name']}",
                       help_text="Operational runbook for the area."),
        ],
    },
    "product_roadmap": {
        "descriptions": ['{lane} initiative. The PRD carries the problem statement; this card tracks delivery.', 'Roadmap item for {lane}. Update the RICE score when reach or effort estimates change.'],
        "column_limits": {"Beta": (-1, None), "In Build": (3, 12)},
        "external_refs": {"provider": "github", "from_progress": 0.5,
                          "url": "https://github.com/example/product/issues/{n}", "ref": "#{n}"},
        "card_fields": [
            field("RICE score", "number", lambda c: f"{c['rng'].uniform(2, 48):.1f}", show=True,
                  help_text="Reach x Impact x Confidence / Effort.", number_decimals=1),
            field("Target quarter", "dropdown", _pick(["Q2 2026", "Q3 2026", "Q4 2026", "2027"]),
                  choices=["Q2 2026", "Q3 2026", "Q4 2026", "2027"], show=True, help_text="Planned release quarter.",
                  choice_colors={"Q2 2026": "green", "Q3 2026": "blue", "Q4 2026": "violet", "2027": "slate"}),
            field("Platforms", "multi_select", _some(["Web", "iOS", "Android", "API", "Self-hosted"], 1, 3),
                  choices=["Web", "iOS", "Android", "API", "Self-hosted"], help_text="Where the feature ships."),
            field("Customer requests", "number", _often(lambda c: str(c["rng"].randint(1, 140)), 0.75),
                  help_text="Linked customer requests."),
            field("Beta start", "date", _often(_future(-30, 150), 0.6), help_text="When beta customers get access."),
            field("PRD", "url", _often(_url("https://docs.example.com/prd/"), 0.7), help_text="Product requirements doc."),
            field("Enterprise only", "checkbox", _flag(0.2), help_text="Ships only in the enterprise edition."),
        ],
        "swimlane_fields": [
            lane_field("PM", "text", _people(2), show=True, help_text="Product manager for the area."),
            lane_field("Eng lead", "text", _people(9), show=True, help_text="Engineering lead."),
            lane_field("Theme", "dropdown", _lane_pool(["Grow", "Retain", "Scale", "Comply"]),
                       choices=["Grow", "Retain", "Scale", "Comply"], show=True, help_text="Strategic theme.",
                       choice_colors={"Grow": "green", "Retain": "blue", "Scale": "violet", "Comply": "amber"}),
        ],
    },
    "project_delivery": {
        "descriptions": ['Deliverable for {lane}. RAG status is reviewed at the weekly steering meeting.', '{lane} workstream task. Raise blockers as comments so the sponsor sees them.'],
        "column_limits": {"Execution": (-2, None), "Milestone Review": (3, 10)},
        "card_fields": [
            field("RAG", "dropdown",
                  lambda c: "Red" if "Blocked" in c["card"]["labels"] else ("Amber" if "At Risk" in c["card"]["labels"] else "Green"),
                  choices=["Green", "Amber", "Red"], show=True, help_text="Status reported to the steering group.",
                  choice_colors={"Green": "green", "Amber": "amber", "Red": "red"}),
            field("Percent complete", "number", lambda c: str(100 if c["is_done"] else int(c["progress"] * 90)), show=True,
                  help_text="Share of the deliverable finished.", number_suffix="%", number_decimals=0),
            field("Budget", "number", _often(_money(5000, 250000, 2500), 0.7), help_text="Approved budget for the deliverable.",
                  number_prefix="$", number_decimals=0),
            field("Milestone date", "date", _often(_future(-10, 100), 0.85), help_text="Committed milestone date."),
            field("Workstreams", "multi_select", _some(["Engineering", "Design", "Legal", "Vendor", "Change mgmt"]),
                  choices=["Engineering", "Design", "Legal", "Vendor", "Change mgmt"], help_text="Teams involved."),
            field("Needs sponsor sign-off", "checkbox", _flag(0.3), help_text="Requires the sponsor's approval."),
        ],
        "swimlane_fields": [
            lane_field("Sponsor", "text", _people(4), show=True, help_text="Executive sponsor."),
            lane_field("Project manager", "text", _people(10), show=True, help_text="Delivery owner."),
            lane_field("Go-live", "date", lambda lc: d(20 + lc["index"] * 21), show=True, help_text="Planned go-live."),
            lane_field("Total budget", "number", lambda lc: str(250000 + lc["index"] * 90000), admin_only=True,
                       help_text="Admins only.", number_prefix="$", number_decimals=0),
        ],
    },
    "content_production": {
        "descriptions": ['{lane} piece. Draft lives in the linked doc; edits happen there, status happens here.', 'Content for {lane}. Confirm channels and the publish date before final approval.'],
        "column_limits": {"Internal Review": (-1, None), "Draft": (3, 10)},
        "card_fields": [
            field("Content type", "dropdown", _pick(["Article", "Video", "Newsletter", "Guide", "Social post"]),
                  choices=["Article", "Video", "Newsletter", "Guide", "Social post"], show=True,
                  help_text="Format of the piece."),
            field("Publish date", "date", _often(_future(-15, 60), 0.8), show=True, help_text="Planned publish date."),
            field("Word count", "number", _often(lambda c: str(c["rng"].randrange(300, 3200, 100)), 0.7),
                  help_text="Target length.", number_suffix=" words", number_decimals=0),
            field("Channels", "multi_select", _some(["Blog", "LinkedIn", "YouTube", "Email", "Docs site"]),
                  choices=["Blog", "LinkedIn", "YouTube", "Email", "Docs site"], help_text="Where it is distributed."),
            field("Draft doc", "url", _often(_url("https://docs.example.com/drafts/"), 0.6), help_text="Working draft."),
            field("SEO reviewed", "checkbox", lambda c: "true" if c["progress"] > 0.5 else "false",
                  help_text="Keyword and metadata review done."),
        ],
        "swimlane_fields": [
            lane_field("Channel owner", "text", _people(6), show=True, help_text="Editor accountable for the channel."),
            lane_field("Monthly target", "number", lambda lc: str(4 + lc["index"] % 6), show=True,
                       help_text="Pieces per month.", number_suffix=" pieces", number_decimals=0),
            lane_field("Cadence", "dropdown", _lane_pool(["Weekly", "Biweekly", "Monthly"]),
                       choices=["Weekly", "Biweekly", "Monthly"], help_text="Publishing rhythm."),
        ],
    },
    "hiring_recruiting": {
        "descriptions": ['Candidate for the {lane} team. Interview feedback goes in comments within 24 hours.', '{lane} pipeline. Keep the interview loop field current so the debrief is scheduled on time.'],
        "column_limits": {"Interview": (-2, None), "Reference Check": (2, 8)},
        "card_fields": [
            field("Level", "dropdown", _pick(["L3", "L4", "L5", "L6", "Director"]),
                  choices=["L3", "L4", "L5", "L6", "Director"], show=True, help_text="Leveling target."),
            field("Source", "dropdown", lambda c: "Referral" if "Referral" in c["card"]["labels"] else c["rng"].choice(["Inbound", "Sourced", "Agency"]),
                  choices=["Inbound", "Sourced", "Referral", "Agency"], show=True, help_text="Where the candidate came from.",
                  choice_colors={"Referral": "green", "Agency": "amber"}),
            field("Interview loop", "multi_select", _some(["Hiring manager", "Technical", "System design", "Values", "Exec"], 1, 4),
                  choices=["Hiring manager", "Technical", "System design", "Values", "Exec"], help_text="Interviews scheduled or done."),
            field("Available from", "date", _often(_future(14, 90), 0.5), help_text="Earliest start date."),
            field("Visa sponsorship", "checkbox", _flag(0.15), help_text="Candidate needs sponsorship."),
            field("Candidate profile", "url", _url("https://ats.example.com/candidates/"), help_text="Profile in the ATS (fictional)."),
        ],
        "swimlane_fields": [
            lane_field("Hiring manager", "text", _people(11), show=True, help_text="Owns the hiring decision."),
            lane_field("Recruiter", "text", _people(12), show=True, help_text="Recruiting partner."),
            lane_field("Open reqs", "number", lambda lc: str(1 + lc["index"] % 5), show=True, help_text="Approved headcount still open."),
            lane_field("Comp budget", "number", lambda lc: str(180000 + lc["index"] * 15000), admin_only=True,
                       help_text="Top of band. Admins only.", number_prefix="$", number_decimals=0),
        ],
    },
    "infra_devops": {
        "descriptions": ['{lane} change. Attach the change ticket and MR; note rollback steps before the window.', 'Work on {lane}. Record the blast radius and the environments touched before deploying.'],
        "column_limits": {"Change Window": (-1, None), "In Progress": (3, 10)},
        "external_refs": {"provider": "gitlab", "from_progress": 0.4,
                          "url": "https://gitlab.example.com/platform/infra/-/merge_requests/{n}", "ref": "!{n}"},
        "card_fields": [
            field("Severity", "dropdown",
                  lambda c: {"urgent": "SEV1", "high": "SEV2"}.get(c["card"]["priority"], "SEV3"),
                  choices=["SEV1", "SEV2", "SEV3"], show=True, help_text="Operational severity.",
                  choice_colors={"SEV1": "red", "SEV2": "amber", "SEV3": "slate"}),
            field("Environments", "multi_select", _some(["Production", "Staging", "DR site", "Dev"], 1, 3),
                  choices=["Production", "Staging", "DR site", "Dev"], show=True, help_text="Where the change lands."),
            field("Change ticket", "url", _often(_url("https://itsm.example.com/changes/CHG"), 0.7), help_text="Change record."),
            field("Maintenance window", "date", _often(_future(-3, 30), 0.5), help_text="Scheduled window."),
            field("Requires downtime", "checkbox", _flag(0.2), help_text="User-visible downtime expected."),
            field("Estimate", "number", lambda c: str(c["rng"].choice([2, 4, 8, 16, 24, 40])), help_text="Engineering hours.",
                  number_suffix=" h", number_decimals=0),
        ],
        "swimlane_fields": [
            lane_field("Owning team", "text", _lane_pool(["Platform", "Release Eng", "Data Infra", "Edge", "Observability",
                                                          "SecOps", "Platform", "Data Infra", "Network", "Resilience"]),
                       show=True, help_text="Team that owns the system."),
            lane_field("Tier", "dropdown", _lane_pool(["Tier 1", "Tier 1", "Tier 1", "Tier 2", "Tier 2", "Tier 1", "Tier 3", "Tier 2", "Tier 1", "Tier 1"]),
                       choices=["Tier 1", "Tier 2", "Tier 3"], show=True, help_text="Criticality tier.",
                       choice_colors={"Tier 1": "red", "Tier 2": "amber", "Tier 3": "slate"}),
            lane_field("SLO", "number", _lane_pool(["99.95", "99.5", "99.99", "99.9", "99.5", "99.9", "99", "99.5", "99.99", "99.9"]),
                       show=True, help_text="Availability objective.", number_suffix="%", number_decimals=2),
            lane_field("Dashboard", "url", lambda lc: f"https://grafana.example.com/d/{lc['slug_name']}", help_text="Primary dashboard."),
        ],
    },
    "legal_compliance": {
        "descriptions": ['{lane} matter. Privileged discussion stays in the DMS; this card tracks status and deadlines.', "Request for the {lane} team. Note the counterparty's position and the next filing date."],
        "column_limits": {"Under Review": (-2, None), "Needs Clarification": (3, 8)},
        "card_fields": [
            field("Risk", "dropdown", lambda c: {"urgent": "High", "high": "High", "medium": "Medium"}.get(c["card"]["priority"], "Low"),
                  choices=["Low", "Medium", "High"], show=True, help_text="Legal risk rating.",
                  choice_colors={"Low": "green", "Medium": "amber", "High": "red"}),
            field("Deadline", "date", _often(_future(-10, 60), 0.85), show=True, help_text="Filing or signature deadline."),
            field("Matter value", "number", _often(_money(5000, 900000, 5000), 0.6), help_text="Financial exposure or contract value.",
                  number_prefix="$", number_decimals=0),
            field("Jurisdictions", "multi_select", _some(["US", "EU", "UK", "Canada", "APAC"]),
                  choices=["US", "EU", "UK", "Canada", "APAC"], help_text="Governing jurisdictions."),
            field("Counterparty", "text", _often(_pick(["Northgate Supplies", "Brightline Analytics", "Harbor Leasing", "Civic Data Office", "Orchid Software"]), 0.6),
                  help_text="Other party to the matter."),
            field("Outside counsel", "checkbox", _flag(0.25), help_text="External firm engaged."),
            field("Document", "url", _often(_url("https://dms.example.com/matters/M-"), 0.75), help_text="Matter file in the DMS."),
        ],
        "swimlane_fields": [
            lane_field("Lead counsel", "text", _people(13), show=True, help_text="Attorney responsible for the practice area."),
            lane_field("Annual budget", "number", lambda lc: str(80000 + lc["index"] * 25000), help_text="Outside spend budget.",
                       number_prefix="$", number_decimals=0),
            lane_field("Privilege note", "text", lambda lc: "Attorney-client privileged; do not forward.", admin_only=True,
                       help_text="Admins only."),
        ],
    },
}
