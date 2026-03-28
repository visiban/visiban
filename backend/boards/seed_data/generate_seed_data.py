"""
Generate all 10 seed template JSON files with:
  - 20-25 cards per template (expands existing 11-14)
  - Varied movement histories: stage skipping + occasional backtracks
  - All fields populated: description, checklist, comments, labels, due_date, weight, assignee
  - schema_version: 1

Existing card content is PRESERVED exactly — only movements and activities are
regenerated. New cards are appended after the existing ones.

Usage (from repo root):
    python3 backend/boards/seed_data/generate_seed_data.py

No Django or database connection required.
"""

import json
import os
import random
from datetime import datetime, timedelta, timezone

# ── Constants ────────────────────────────────────────────────────────────────
ANCHOR = datetime(2026, 3, 15, 12, 0, 0, tzinfo=timezone.utc)
DEMO_USERS = ["demo1", "demo2", "demo3", "demo4", "demo5"]
SCHEMA_VERSION = 1

SEED_DATA_DIR = os.path.dirname(os.path.abspath(__file__))


# ── Reproducible random ───────────────────────────────────────────────────────
_rng = random.Random(42)


def _r():
    return _rng.random()


def _ri(a, b):
    return _rng.randint(a, b)


def _choice(seq):
    return _rng.choice(seq)


def _user(seed: int) -> str:
    return DEMO_USERS[seed % len(DEMO_USERS)]


# ── Date helpers ──────────────────────────────────────────────────────────────
def _date(days_from_anchor: int) -> str:
    """Return YYYY-MM-DD offset from anchor. Negative = past (overdue)."""
    return (ANCHOR + timedelta(days=days_from_anchor)).strftime("%Y-%m-%d")


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S+00:00")


# ── Movement generation ───────────────────────────────────────────────────────
def _varied_path(target_idx: int) -> list[int]:
    """
    Build a list of column indices that leads from 0 to target_idx with
    realistic variation:
      60 % straight sequential (0 -> 1 -> 2 -> ... -> target)
      25 % skip one intermediate stage  (if target >= 3)
      15 % backtrack once then continue (if target >= 2)
    """
    if target_idx == 0:
        return [0]

    r = _r()
    if target_idx >= 3 and r < 0.25:
        # Skip one random intermediate stage
        skip = _ri(1, target_idx - 1)
        return list(range(0, skip)) + list(range(skip + 1, target_idx + 1))
    elif target_idx >= 2 and r < 0.40:
        # Advance to some mid-point, drop back one, then continue
        bt = _ri(1, target_idx - 1)
        return list(range(0, bt + 1)) + [bt - 1] + list(range(bt, target_idx + 1))
    else:
        return list(range(0, target_idx + 1))


def _gen_movements(col_names: list[str], target_idx: int,
                   swimlane: str, card_seed: int) -> list[dict]:
    """Full movement chain from null -> col[0] -> ... -> col[target_idx]."""
    total_days_back = _ri(30, 95)
    create_dt = ANCHOR - timedelta(days=total_days_back)

    movements = [{
        "from_column": None,
        "to_column": col_names[0],
        "from_swimlane": None,
        "to_swimlane": swimlane,
        "moved_at": _iso(create_dt),
        "moved_by": _user(card_seed),
    }]

    if target_idx == 0:
        return movements

    path = _varied_path(target_idx)
    days_per_step = max(2, total_days_back // (len(path) + 1))
    cur_dt = create_dt + timedelta(days=_ri(2, 5))

    for i in range(1, len(path)):
        from_col = col_names[path[i - 1]]
        to_col = col_names[path[i]]
        cur_dt = cur_dt + timedelta(days=_ri(2, max(3, days_per_step)))
        if cur_dt >= ANCHOR:
            cur_dt = ANCHOR - timedelta(hours=_ri(2, 72))
        movements.append({
            "from_column": from_col,
            "to_column": to_col,
            "from_swimlane": swimlane,
            "to_swimlane": swimlane,
            "moved_at": _iso(cur_dt),
            "moved_by": _user(card_seed + i),
        })

    return movements


# ── Activity generation ───────────────────────────────────────────────────────
def _gen_activities(card: dict, card_seed: int, movements: list[dict]) -> list[dict]:
    """Generate CardActivity records for a card."""
    acts = []
    if movements:
        ts = datetime.strptime(
            movements[0]["moved_at"], "%Y-%m-%dT%H:%M:%S+00:00"
        ).replace(tzinfo=timezone.utc) + timedelta(hours=1)
    else:
        ts = ANCHOR - timedelta(days=30)

    actor = _user(card_seed)

    assignee = card.get("assignee")
    if assignee:
        acts.append({
            "event_type": "assignee_change",
            "from_value": "", "to_value": assignee,
            "actor": actor, "created_at": _iso(ts),
        })
        ts += timedelta(hours=2)

    labels = card.get("labels", [])
    if labels:
        acts.append({
            "event_type": "label_change",
            "from_value": "", "to_value": ", ".join(labels),
            "actor": actor, "created_at": _iso(ts),
        })
        ts += timedelta(hours=3)

    priority = card.get("priority", "medium")
    if priority not in ("medium", None, ""):
        acts.append({
            "event_type": "priority_change",
            "from_value": "medium", "to_value": priority,
            "actor": actor, "created_at": _iso(ts),
        })
        ts += timedelta(hours=2)

    due_date = card.get("due_date")
    if due_date:
        acts.append({
            "event_type": "due_date_change",
            "from_value": "", "to_value": due_date,
            "actor": actor, "created_at": _iso(ts),
        })
        ts += timedelta(hours=1)

    for item in card.get("checklist", []):
        acts.append({
            "event_type": "checklist_item_added",
            "from_value": "", "to_value": item["text"],
            "actor": actor, "created_at": _iso(ts),
        })
        ts += timedelta(minutes=20)
        if item.get("is_checked"):
            acts.append({
                "event_type": "checklist_item_checked",
                "from_value": "", "to_value": item["text"],
                "actor": actor, "created_at": _iso(ts),
            })
            ts += timedelta(minutes=15)

    for comment in card.get("comments", []):
        c_actor = comment.get("author") or actor
        acts.append({
            "event_type": "comment_added",
            "from_value": "", "to_value": comment["body"][:120],
            "actor": c_actor, "created_at": _iso(ts),
        })
        ts += timedelta(hours=_ri(2, 10))

    return acts


# ── Card enrichment ───────────────────────────────────────────────────────────
def _enrich(card: dict, col_names: list[str], card_seed: int) -> dict:
    """Attach movements, activities, and assignee to a card dict."""
    target_idx = col_names.index(card["column"])
    swimlane = card["swimlane"]

    # 80 % of cards have an assignee; every 5th card is unassigned
    card["assignee"] = _user(card_seed) if card_seed % 5 != 4 else None

    movs = _gen_movements(col_names, target_idx, swimlane, card_seed)
    card["movements"] = movs
    card["activities"] = _gen_activities(card, card_seed, movs)
    return card


# ── Template expander ─────────────────────────────────────────────────────────
def _build(tpl: dict) -> dict:
    """
    Build the final template dict from the cards defined in extra_cards.
    All card content is authoritative from the template definition -- the
    script is idempotent and safe to run multiple times.
    """
    slug = tpl["slug"]
    col_names = [c["name"] for c in tpl["columns"]]

    all_cards = tpl.get("extra_cards", [])

    enriched = []
    for i, card in enumerate(all_cards):
        enriched.append(_enrich(dict(card), col_names, i * 7 + hash(slug) % 100))

    return {
        "schema_version": SCHEMA_VERSION,
        "name": tpl["name"],
        "description": tpl["description"],
        "columns": tpl["columns"],
        "swimlanes": tpl["swimlanes"],
        "labels": tpl["labels"],
        "cards": enriched,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helper shorthand for new card definitions
# ─────────────────────────────────────────────────────────────────────────────
def _c(title, col, lane, pri, due_offset, weight, labels, checklist, comments=None, desc=""):
    return {
        "title": title,
        "description": desc,
        "priority": pri,
        "column": col,
        "swimlane": lane,
        "due_date": _date(due_offset) if due_offset is not None else None,
        "weight": weight,
        "labels": list(labels),
        "checklist": list(checklist),
        "comments": list(comments or []),
    }


def _chk(*items):
    """Build checklist. Items starting with '+' are checked."""
    out = []
    for item in items:
        if item.startswith("+"):
            out.append({"text": item[1:].strip(), "is_checked": True})
        else:
            out.append({"text": item.strip(), "is_checked": False})
    return out


def _cmt(body, author="demo1"):
    return {"body": body, "author": author}


# ── Auto-card generation ────────────────────────────────────────────────────
# Generic checklist items and comments by template theme, used by _auto_cards()
# to generate realistic card metadata without repeating exact titles.

_GENERIC_CHECKLIST_ITEMS = {
    "sales": [
        "Research account background", "Identify decision maker",
        "Prepare tailored pitch deck", "Send intro email",
        "Schedule discovery call", "Map procurement process",
        "Draft pricing proposal", "Legal review of terms",
        "Send follow-up email", "Update CRM record",
        "Confirm budget availability", "Present ROI analysis",
    ],
    "support": [
        "Reproduce issue on staging", "Check server logs",
        "Identify root cause", "Write regression test",
        "Deploy fix to staging", "Verify fix in production",
        "Notify customer of resolution", "Update knowledge base",
        "Check related tickets", "Escalate to engineering if needed",
    ],
    "success": [
        "Schedule QBR call", "Review account health metrics",
        "Prepare adoption report", "Identify expansion signals",
        "Draft renewal proposal", "Share product roadmap updates",
        "Coordinate with support on open tickets",
        "Collect NPS feedback", "Update account notes",
        "Send check-in email",
    ],
    "kanban": [
        "Write unit tests", "Update documentation",
        "Review pull request", "Run integration tests",
        "Update API docs", "Verify on staging",
        "Get code review approval", "Check accessibility",
        "Update changelog", "Profile for performance",
    ],
    "roadmap": [
        "Validate with user interviews", "Write design spec",
        "Create technical RFC", "Estimate effort",
        "Build prototype", "Run beta test",
        "Collect feedback from beta users", "Write migration plan",
        "Update public changelog", "Monitor post-launch metrics",
    ],
    "delivery": [
        "Define acceptance criteria", "Assign DRI",
        "Create Gantt chart", "Set up weekly status cadence",
        "Prepare stakeholder update", "Conduct risk assessment",
        "Run go/no-go decision meeting", "Write postmortem",
        "Capture lessons learned", "Archive project artifacts",
    ],
    "content": [
        "Research target keywords", "Draft outline",
        "Write first draft", "Peer review",
        "SEO optimization pass", "Add visuals and diagrams",
        "Final proofread", "Schedule publication",
        "Share on social channels", "Track engagement metrics",
    ],
    "hiring": [
        "Review resume and portfolio", "Schedule phone screen",
        "Send take-home exercise", "Review submission",
        "Schedule panel interview", "Collect interviewer scorecards",
        "Check references", "Draft offer letter",
        "Send offer and follow up", "File onboarding paperwork",
    ],
    "infra": [
        "Check monitoring dashboards", "Review alert thresholds",
        "Run load test", "Validate backup restore",
        "Update runbook", "Test failover procedure",
        "Review security patches", "Apply configuration change",
        "Verify rollback plan", "Post-change monitoring",
    ],
    "legal": [
        "Review submitted documents", "Check compliance requirements",
        "Draft response memo", "Consult external counsel",
        "Circulate for internal review", "Incorporate feedback",
        "Obtain final sign-off", "File in contract system",
        "Set review reminder", "Notify requestor of outcome",
    ],
}

_GENERIC_COMMENTS = {
    "sales": [
        "Pipeline meeting update: deal progressing on schedule.",
        "Champion is engaged and pushing internally.",
        "Procurement process slower than expected -- adjusting timeline.",
        "Competitor mentioned in conversation -- sent comparison deck.",
        "Budget confirmed for this quarter. Moving to next stage.",
        "Legal review flagged one clause -- minor, will resolve this week.",
    ],
    "support": [
        "Customer confirmed the repro steps. Investigating now.",
        "Root cause identified -- fix in progress.",
        "Deployed to staging. Waiting for customer to verify.",
        "Customer confirmed resolution. Closing ticket.",
        "Escalated to engineering -- this affects the core API.",
        "Workaround shared with customer while fix is in progress.",
    ],
    "success": [
        "Account health score trending up this month.",
        "Champion mentioned interest in expanding seats.",
        "QBR went well -- no concerns raised.",
        "Adoption is below target. Scheduling enablement session.",
        "Renewal conversation started. Positive signals so far.",
        "Feature request logged and shared with product team.",
    ],
    "kanban": [
        "PR submitted. Waiting for review.",
        "Tests are passing. Ready for staging deploy.",
        "Found an edge case during testing -- fixing now.",
        "Refactored to reduce complexity. Much cleaner.",
        "Blocked on upstream API change. Following up.",
        "Merged and deployed. Monitoring for regressions.",
    ],
    "roadmap": [
        "User interviews confirmed strong demand for this.",
        "Design spec complete. Moving to implementation.",
        "Beta feedback is overwhelmingly positive.",
        "One edge case found in beta -- patching before GA.",
        "Launched successfully. Monitoring adoption metrics.",
        "Feature usage is 30% above forecast. Great reception.",
    ],
    "delivery": [
        "Kickoff completed. All stakeholders aligned.",
        "On track for the Q2 milestone deadline.",
        "Dependency on vendor API is blocking progress.",
        "Risk mitigated -- fallback plan activated successfully.",
        "Deliverable accepted by sponsor. Moving to next phase.",
        "Retro identified 3 process improvements for next project.",
    ],
    "content": [
        "Outline approved by editor. Starting draft.",
        "First draft complete -- 2,100 words. Sending for review.",
        "SEO review done. Added 2 target keywords to headers.",
        "Published and shared on social. Tracking engagement.",
        "Strong performance -- 3,500 views in first 48 hours.",
        "Repurposing as a LinkedIn carousel and email excerpt.",
    ],
    "hiring": [
        "Strong resume. Moving to phone screen.",
        "Phone screen went well -- scheduling technical round.",
        "Take-home submission is solid. Panel interview next.",
        "Panel was unanimous. Moving to references.",
        "References came back positive. Preparing offer.",
        "Offer accepted. Start date confirmed.",
    ],
    "infra": [
        "Incident resolved. Root cause documented.",
        "Change tested on staging. Scheduling production window.",
        "Post-deploy monitoring shows no regressions.",
        "Alert thresholds updated based on 30-day analysis.",
        "Failover test completed successfully in 12 seconds.",
        "Capacity planning reviewed. Scaling scheduled for Q2.",
    ],
    "legal": [
        "Document received and assigned for review.",
        "Initial review complete. Two clauses need clarification.",
        "External counsel agrees with our interpretation.",
        "Revised version received. Reviewing changes.",
        "All parties have signed. Filing in contract system.",
        "Compliance deadline met. No further action needed.",
    ],
}


def _auto_cards(
    titles: list[str],
    columns: list[dict],
    swimlanes: list[dict],
    labels: list[dict],
    theme: str,
) -> list[dict]:
    """
    Generate cards from a list of unique titles, distributing them across
    swimlanes and columns with randomized but deterministic metadata.

    Args:
        titles: Unique card titles (NEVER duplicated).
        columns: Template column defs (list of dicts with 'name').
        swimlanes: Template swimlane defs (list of dicts with 'name').
        labels: Template label defs (list of dicts with 'name').
        theme: Key into _GENERIC_CHECKLIST_ITEMS / _GENERIC_COMMENTS.

    Returns:
        List of card dicts compatible with extra_cards / _c() format.
    """
    col_names = [c["name"] for c in columns]
    lane_names = [s["name"] for s in swimlanes]
    label_names = [lb["name"] for lb in labels]
    num_cols = len(col_names)

    # Terminal columns (last 1-2) get fewer cards; middle columns get more.
    # Build column weights: first col gets moderate weight, middle columns
    # get the most, terminal columns get less.
    col_weights = []
    for i in range(num_cols):
        if i == 0:
            col_weights.append(1.5)
        elif columns[i].get("is_done"):
            col_weights.append(0.7)
        elif i >= num_cols - 2:
            col_weights.append(0.8)
        else:
            col_weights.append(2.0)

    priorities = ["low", "medium", "medium", "medium", "high", "high", "urgent"]
    chk_items = _GENERIC_CHECKLIST_ITEMS.get(theme, _GENERIC_CHECKLIST_ITEMS["kanban"])
    cmt_pool = _GENERIC_COMMENTS.get(theme, _GENERIC_COMMENTS["kanban"])

    cards = []
    for idx, title in enumerate(titles):
        # Round-robin swimlane assignment
        lane = lane_names[idx % len(lane_names)]

        # Weighted column selection
        col = _rng.choices(col_names, weights=col_weights, k=1)[0]

        pri = _choice(priorities)

        # Due date: 70% of cards have one, offset -30 to +45 days
        due_offset = _ri(-30, 45) if _r() < 0.7 else None

        weight = _ri(1, 8)

        # Labels: 1-2 random labels, ~80% of cards get at least one
        if _r() < 0.8 and label_names:
            n_labels = _ri(1, min(2, len(label_names)))
            card_labels = _rng.sample(label_names, n_labels)
        else:
            card_labels = []

        # Checklist: ~40% of cards
        checklist = []
        if _r() < 0.4:
            n_items = _ri(2, 5)
            selected_items = _rng.sample(chk_items, min(n_items, len(chk_items)))
            for item in selected_items:
                is_checked = _r() < 0.5
                if is_checked:
                    checklist.append({"text": item, "is_checked": True})
                else:
                    checklist.append({"text": item, "is_checked": False})

        # Comments: ~60% of cards
        comments = []
        if _r() < 0.6:
            n_cmts = _ri(1, 2)
            selected_cmts = _rng.sample(cmt_pool, min(n_cmts, len(cmt_pool)))
            for body in selected_cmts:
                author = _choice(DEMO_USERS)
                comments.append({"body": body, "author": author})

        cards.append({
            "title": title,
            "description": "",
            "priority": pri,
            "column": col,
            "swimlane": lane,
            "due_date": _date(due_offset) if due_offset is not None else None,
            "weight": weight,
            "labels": card_labels,
            "checklist": checklist,
            "comments": comments,
        })

    return cards


# ═════════════════════════════════════════════════════════════════════════════
# TEMPLATE DEFINITIONS
# ═════════════════════════════════════════════════════════════════════════════

# ── 1. Sales Pipeline ─────────────────────────────────────────────────────────

_SALES_COLUMNS = [
    {"name": "Prospect",      "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Qualified",     "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Discovery",     "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Demo",          "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Proposal Sent", "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Negotiation",   "position": 5, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
    {"name": "Closed Won",    "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Closed Lost",   "position": 7, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_SALES_SWIMLANES = [
    {"name": "North America",   "position": 0,  "color": "#3B82F6", "contact_email": "na-sales@example.com",       "notes": "Primary market. Enterprise and Mid-Market focus. Q2 pipeline target: $2.4M ARR."},
    {"name": "APAC",            "position": 1,  "color": "#F59E0B", "contact_email": "apac-sales@example.com",     "notes": "Partner-led motion in several subregions. Retail and ops-heavy accounts. Longer procurement cycles."},
    {"name": "EMEA",            "position": 2,  "color": "#8B5CF6", "contact_email": "emea-sales@example.com",     "notes": "Fintech and compliance-heavy accounts dominant. GDPR and DPA required on most enterprise deals."},
    {"name": "LATAM",           "position": 3,  "color": "#10B981", "contact_email": "latam-sales@example.com",    "notes": "Healthcare and government verticals. Longer sales cycles. HIPAA-equivalent local data regulations."},
    {"name": "ANZ",             "position": 4,  "color": "#EC4899", "contact_email": "anz-sales@example.com",      "notes": "SMB and creative agency accounts. Fast decision cycles -- typically days, not weeks."},
    {"name": "UK & Ireland",    "position": 5,  "color": "#14B8A6", "contact_email": "uki-sales@example.com",      "notes": "Financial services and professional services verticals. GDPR applies. Q2 target: 420k GBP."},
    {"name": "DACH",            "position": 6,  "color": "#6366F1", "contact_email": "dach-sales@example.com",     "notes": "Germany, Austria, Switzerland. Manufacturing and engineering firms. German-language demos available."},
    {"name": "Nordics",         "position": 7,  "color": "#0EA5E9", "contact_email": "nordics-sales@example.com",  "notes": "Sweden, Norway, Denmark, Finland. Tech-forward accounts. Short procurement cycles."},
    {"name": "Middle East",     "position": 8,  "color": "#F43F5E", "contact_email": "me-sales@example.com",       "notes": "UAE, Saudi Arabia, Qatar. Large enterprise and government. Data residency requirements common."},
    {"name": "Southeast Asia",  "position": 9,  "color": "#A855F7", "contact_email": "sea-sales@example.com",      "notes": "Singapore, Indonesia, Philippines, Thailand. Mix of tech startups and traditional enterprises."},
    {"name": "Japan & Korea",   "position": 10, "color": "#EAB308", "contact_email": "jpkr-sales@example.com",     "notes": "Large enterprise accounts. Localization required. Partner-led sales motion."},
]

_SALES_LABELS = [
    {"name": "Enterprise", "color": "#3B82F6"},
    {"name": "SMB",        "color": "#10B981"},
    {"name": "Strategic",  "color": "#8B5CF6"},
    {"name": "Renewal",    "color": "#F97316"},
    {"name": "Upsell",     "color": "#F59E0B"},
]

_SALES_TITLES = [
    # North America
    "Acme Corp -- Annual Platform License",
    "Pinnacle Health -- HIPAA Module Add-on",
    "Brightwave Systems -- 300-Seat Migration from Jira",
    "Forge Analytics -- Enterprise Analytics Bundle",
    "Redwood Therapeutics -- Clinical Ops Board License",
    "Summit Financial -- Compliance Workflow Package",
    "Vanguard Logistics -- 150-Seat Renewal + Expansion",
    "NovaGen Biotech -- Lab Management Board Pilot",
    "Apex Manufacturing -- Factory Floor Kanban",
    "Cirrus Cloud -- DevOps Pipeline Board License",
    "Atlas Retail Group -- 200-Store Operations Deal",
    # APAC
    "Sakura Electronics -- 100-Seat Engineering Board",
    "Dragon Logistics -- Cross-Border Shipping Tracker",
    "Coral Bay Resorts -- Property Management Board",
    "Harbour Tech -- 80-Seat SaaS Startup Deal",
    "Phoenix Manufacturing -- QA Workflow License",
    "Jade Capital -- Investment Pipeline Board",
    "Tidal Wave Media -- Content Production License",
    "Pacific Rim Insurance -- Claims Workflow Board",
    "Golden Gate Trading -- Supply Chain Board",
    "Orient Express Travel -- Operations Board Pilot",
    "Bamboo Health Systems -- Patient Tracking License",
    # EMEA
    "Meridian Consulting -- 120-Seat Strategic Deal",
    "EuroTech Solutions -- Engineering Workflow License",
    "Nordic Finance Group -- SOC 2 Compliance Package",
    "Baltic Shipping -- Logistics Board Bundle",
    "Alpine Engineering GmbH -- Manufacturing Board",
    "Iberian Software -- Platform Migration 200 Seats",
    "Benelux Pharma -- Clinical Trial Board License",
    "Danube Data -- Analytics Platform Package",
    "Celtic Insurance -- Claims Processing Board",
    "Aegean Hospitality -- Resort Operations License",
    "Rhine Industrial -- Factory Kanban 150 Seats",
    # LATAM
    "Rio Health Network -- Hospital Operations Board",
    "Andean Mining Corp -- Safety Compliance Board",
    "Pampa Agritech -- Field Operations Tracker",
    "Amazonia Logistics -- Last-Mile Delivery Board",
    "Patagonia Energy -- Renewable Project Tracker",
    "Caribe Tourism Group -- Property Management Board",
    "Andes Pharmaceuticals -- Drug Development Pipeline",
    "Plata Financial -- Banking Compliance Board",
    "Cono Sur Retail -- 300-Store Ops Board",
    "Mayan Software -- Engineering Team License",
    "Quetzal Healthcare -- Clinic Management Board",
    # ANZ
    "Southern Cross Media -- Content Calendar License",
    "Outback Mining -- Safety Incident Board",
    "Harbour Digital -- 40-Seat Startup Deal",
    "Kiwi Creative -- Campaign Sprint Board",
    "Reef Tourism -- Guest Experience Tracker",
    "Bushland Agriculture -- Farm Operations Board",
    "Wallaby Fintech -- Compliance Workflow License",
    "Tasman Engineering -- Project Delivery Board",
    "Coral Coast Health -- Patient Journey Board",
    "Wombat Software -- 60-Seat Engineering Deal",
    "Blue Mountains Consulting -- Advisory Board License",
    # UK & Ireland
    "Thames Capital -- Investment Pipeline Board",
    "Clyde Engineering -- Manufacturing Workflow License",
    "Dublin Analytics -- Data Team Kanban",
    "Avon Insurance -- Claims Processing Board",
    "Severn Healthcare -- NHS Trust Operations Board",
    "Mersey Digital -- Agency Campaign Tracker",
    "Belfast Tech -- 50-Seat SaaS Startup Deal",
    "Trent Consulting -- Professional Services Board",
    "Cotswold Publishing -- Editorial Workflow License",
    "Highland Logistics -- Distribution Board",
    "Windsor Pharmaceuticals -- Drug Approval Pipeline",
    # DACH
    "Bayern Maschinenbau -- Factory Floor Board",
    "Wien Consulting -- Project Delivery License",
    "Zurich Insurance AG -- Claims Workflow Board",
    "Rhein Software -- 100-Seat Engineering Deal",
    "Alpen Logistics -- Cross-Border Shipping Board",
    "Hamburg Pharma -- Clinical Trial Tracker",
    "Dresden Automotive -- QA Pipeline Board",
    "Salzburg Tourism -- Guest Operations License",
    "Bern Data Systems -- Analytics Board Package",
    "Frankfurt Finance -- Compliance Workflow Deal",
    "Stuttgart Manufacturing -- Production Kanban",
    # Nordics
    "Stockholm SaaS -- 80-Seat Platform Migration",
    "Oslo Energy -- Renewable Project Board",
    "Helsinki Gaming -- Sprint Board License",
    "Copenhagen Design -- Creative Workflow Board",
    "Gothenburg Shipping -- Fleet Operations Board",
    "Reykjavik Biotech -- Lab Management Board",
    "Malmo Retail -- 50-Store Ops Board",
    "Bergen Consulting -- Advisory Pipeline Board",
    "Tampere Automotive -- QA Workflow License",
    "Aarhus Digital -- Agency Board 30 Seats",
    # Middle East
    "Dubai Properties -- Real Estate Project Board",
    "Riyadh Oil -- Operations Compliance Board",
    "Abu Dhabi Finance -- Investment Pipeline License",
    "Qatar Airways Cargo -- Logistics Board Deal",
    "Doha Healthcare -- Hospital Operations Board",
    "Jeddah Retail -- 200-Store Operations License",
    "Muscat Engineering -- Infrastructure Project Board",
    "Bahrain Fintech -- Compliance Workflow License",
    "Kuwait Petroleum -- Safety Tracking Board",
    "Sharjah Education -- Academic Operations Board",
    # Southeast Asia
    "Singapore Fintech -- 60-Seat Compliance Board",
    "Jakarta Logistics -- Last-Mile Delivery Board",
    "Manila BPO -- Operations Kanban 200 Seats",
    "Bangkok Retail -- Store Operations Board",
    "Ho Chi Minh Tech -- Engineering Board License",
    "Kuala Lumpur Media -- Content Production Board",
    "Cebu Software -- 40-Seat Startup Deal",
    "Bali Tourism -- Resort Management Board",
    "Hanoi Manufacturing -- Factory Kanban Board",
    "Phnom Penh NGO -- Program Operations Board",
    # Japan & Korea
    "Tokyo Electronics -- 500-Seat Enterprise Deal",
    "Seoul Gaming -- Sprint Board License",
    "Osaka Manufacturing -- Quality Board Package",
    "Busan Shipping -- Fleet Operations Board",
    "Kyoto Pharmaceuticals -- Drug Pipeline Board",
    "Incheon Logistics -- Airport Operations License",
    "Nagoya Automotive -- Production Kanban 300 Seats",
    "Daegu Retail -- Store Operations Board",
    "Fukuoka Software -- Engineering Board 80 Seats",
    "Jeju Tourism -- Guest Experience Board",
]

SALES_PIPELINE = {
    "slug": "sales_pipeline",
    "name": "Template: Sales Pipeline",
    "description": "Track open deals from first contact through close. Each swimlane is a sales region; each card is a deal or opportunity.",
    "columns": _SALES_COLUMNS,
    "swimlanes": _SALES_SWIMLANES,
    "labels": _SALES_LABELS,
    "extra_cards": _auto_cards(_SALES_TITLES, _SALES_COLUMNS, _SALES_SWIMLANES, _SALES_LABELS, "sales"),
}


# ── 2. Customer Support ───────────────────────────────────────────────────────

_SUPPORT_COLUMNS = [
    {"name": "New",               "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Triaged",           "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Investigating",     "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Awaiting Customer", "position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Escalated",         "position": 4, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
    {"name": "Resolved",          "position": 5, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Closed",            "position": 6, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_SUPPORT_SWIMLANES = [
    {"name": "TechNova Inc",          "position": 0,  "color": "#3B82F6", "contact_email": "support@technova.example",        "notes": "Enterprise tier. SLA: 4-hour response, 24-hour resolution for P1."},
    {"name": "Apex Retail Group",     "position": 1,  "color": "#F59E0B", "contact_email": "support@apexretail.example",      "notes": "Mid-market. SLA: 8-hour response. Contact: IT Manager."},
    {"name": "FinEdge Ltd",           "position": 2,  "color": "#8B5CF6", "contact_email": "support@finedge.example",         "notes": "Compliance-sensitive. All support comms may be audited. Use formal language."},
    {"name": "BlueSky Health",        "position": 3,  "color": "#10B981", "contact_email": "support@blueskyhealth.example",   "notes": "HIPAA environment. Do not share PHI in support threads. Escalate data questions to legal."},
    {"name": "Mosaic Creative",       "position": 4,  "color": "#EC4899", "contact_email": "support@mosaiccreative.example",  "notes": "SMB tier. Self-serve. Generally quick to resolve -- low SLA pressure."},
    {"name": "Global Freight Co",     "position": 5,  "color": "#14B8A6", "contact_email": "support@globalfreight.example",   "notes": "Enterprise tier. 300 seats. Logistics-heavy workflows. SLA: 4-hour response."},
    {"name": "Pinnacle Finance",      "position": 6,  "color": "#6366F1", "contact_email": "support@pinnaclefin.example",     "notes": "Financial services. SOC 2 environment. Audit trail exports are critical."},
    {"name": "Redwood Agency",        "position": 7,  "color": "#0EA5E9", "contact_email": "support@redwoodagency.example",   "notes": "SMB creative agency. 25 seats. Fast response expected but no formal SLA."},
    {"name": "Atlas Logistics BV",    "position": 8,  "color": "#F43F5E", "contact_email": "support@atlaslogistics.example",  "notes": "EMEA mid-market. 200 seats. GDPR-sensitive. Dutch business hours only."},
    {"name": "Vertex Media",          "position": 9,  "color": "#A855F7", "contact_email": "support@vertexmedia.example",     "notes": "Growing account. 75 seats approaching 150. High feature request volume."},
    {"name": "Ironside Manufacturing","position": 10, "color": "#EAB308", "contact_email": "support@ironsidemfg.example",     "notes": "Manufacturing. Shop floor workers with limited tech literacy. Extra patience needed."},
]

_SUPPORT_LABELS = [
    {"name": "Bug",             "color": "#EF4444"},
    {"name": "Feature Request", "color": "#3B82F6"},
    {"name": "Billing",         "color": "#F59E0B"},
    {"name": "Security",        "color": "#8B5CF6"},
    {"name": "Performance",     "color": "#10B981"},
]

_SUPPORT_TITLES = [
    # TechNova Inc
    "TKT-1041: Board load hangs after 300+ cards",
    "TKT-1028: Webhook not firing on card archive",
    "TKT-1015: SSO login loop on Safari 17.4",
    "TKT-1009: Export CSV missing swimlane column",
    "TKT-1052: Board duplication fails silently for boards with 50+ cards",
    "TKT-1058: Card weight not included in webhook payload",
    "TKT-1063: Due date reminder email sent twice",
    "TKT-1067: Board settings modal blank on Firefox 124",
    "TKT-1071: Card description markdown preview not rendering tables",
    "TKT-1074: Swimlane reorder drag handle unresponsive on touch devices",
    # Apex Retail Group
    "TKT-2033: Cards not syncing across browser tabs",
    "TKT-2027: Swimlane collapse state not persisting",
    "TKT-2019: Request -- bulk card move between swimlanes",
    "TKT-2011: Board permissions not applying to new members",
    "TKT-2041: Card filter by label returns stale results",
    "TKT-2046: Mobile web board view cuts off last swimlane",
    "TKT-2049: CSV import maps columns incorrectly on retry",
    "TKT-2053: Email notification for card comment mentions wrong board name",
    "TKT-2058: Request -- custom card fields for store number",
    "TKT-2062: Board archive button missing for admin users on mobile",
    # FinEdge Ltd
    "TKT-3044: Audit log export missing movement events",
    "TKT-3038: 2FA enforcement not applying to SSO users",
    "TKT-3025: API rate limit headers missing from responses",
    "TKT-3014: Webhook HMAC signature docs incorrect",
    "TKT-3051: Board export includes archived cards despite filter",
    "TKT-3056: Activity feed not loading for boards with 1000+ activities",
    "TKT-3061: API token scope too broad for read-only integrations",
    "TKT-3065: Card movement audit trail missing timezone info",
    "TKT-3069: Request -- scheduled board export to SFTP",
    "TKT-3073: Column WIP limit enforcement off by one",
    # BlueSky Health
    "TKT-4029: Card attachments not uploading for HIPAA users",
    "TKT-4021: Board export failing for HIPAA tenant",
    "TKT-4018: Email notification delays in HIPAA tenant",
    "TKT-4005: Board member cannot see swimlane after invite",
    "TKT-4035: Card comment @mention autocomplete not filtering HIPAA users",
    "TKT-4039: Board template creation fails with 500 for HIPAA tenant",
    "TKT-4043: Request -- PHI redaction on board export",
    "TKT-4047: Checklist completion percentage rounds incorrectly",
    "TKT-4051: Card due date reminder goes to wrong timezone",
    "TKT-4055: Request -- HIPAA audit log retention policy setting",
    # Mosaic Creative
    "TKT-5018: Colors not saving on card labels",
    "TKT-5014: Request -- keyboard shortcut to archive card",
    "TKT-5009: Import CSV failing on special characters",
    "TKT-5003: Due date filter returning no results",
    "TKT-5023: Card drag ghost image too small on 4K displays",
    "TKT-5027: Board background color resets after page reload",
    "TKT-5031: Request -- card cover images from attachments",
    "TKT-5035: Swimlane color picker doesn't show current color",
    "TKT-5039: Request -- recurring card due dates",
    "TKT-5043: Board member list not sorted alphabetically",
    # Global Freight Co
    "TKT-6001: Board load timeout on boards with 15+ swimlanes",
    "TKT-6005: Card movement history truncated at 100 entries",
    "TKT-6009: Webhook delivery retries not respecting exponential backoff",
    "TKT-6013: Request -- swimlane-level WIP limits",
    "TKT-6017: CSV export encoding issue with non-Latin characters in card titles",
    "TKT-6021: Board member role change not reflected until re-login",
    "TKT-6025: Card search does not match checklist item text",
    "TKT-6029: Request -- API endpoint for bulk card creation",
    "TKT-6033: Board duplication loses label colors",
    "TKT-6037: Notification email subject line truncated at 80 characters",
    # Pinnacle Finance
    "TKT-7001: Compliance export PDF formatting broken on A3 paper size",
    "TKT-7005: SSO session timeout too aggressive for long review sessions",
    "TKT-7009: Card comment edit history not available via API",
    "TKT-7013: Request -- board-level audit log filtering by date range",
    "TKT-7017: Webhook payload missing card weight field",
    "TKT-7021: Board settings save button disabled after label delete",
    "TKT-7025: Request -- mandatory card fields per column",
    "TKT-7029: Activity export CSV date format inconsistent with ISO 8601",
    "TKT-7033: Card description character limit not documented in API docs",
    "TKT-7037: Request -- two-person approval for card movement to final column",
    # Redwood Agency
    "TKT-8001: Board sharing link expiry not configurable",
    "TKT-8005: Card due date not showing in board calendar view",
    "TKT-8009: Swimlane notes field truncated in board settings modal",
    "TKT-8013: Request -- card time tracking integration",
    "TKT-8017: Label delete confirmation dialog missing",
    "TKT-8021: Board export JSON schema undocumented",
    "TKT-8025: Card comment notification arrives 10 minutes late",
    "TKT-8029: Request -- board templates marketplace",
    "TKT-8033: Mobile web: card detail modal does not scroll on iOS",
    "TKT-8037: Request -- Slack notification for card due date",
    # Atlas Logistics BV
    "TKT-9001: Board load slow during EU business hours peak",
    "TKT-9005: GDPR data export missing card comment attachments",
    "TKT-9009: Swimlane position reset after board duplicate",
    "TKT-9013: Request -- multi-language card title support validation",
    "TKT-9017: Card movement via API not triggering webhook",
    "TKT-9021: Board member invite email landing in spam (DKIM issue)",
    "TKT-9025: Column color not visible in high-contrast mode",
    "TKT-9029: Request -- board access audit report for GDPR compliance",
    "TKT-9033: CSV import timeout on files over 5 MB",
    "TKT-9037: Card checklist reorder not persisting",
    # Vertex Media
    "TKT-10001: Board activity feed missing card label change events",
    "TKT-10005: Request -- card dependencies and blocking visualization",
    "TKT-10009: Swimlane contact email field validation too strict",
    "TKT-10013: Card search results do not highlight match text",
    "TKT-10017: Board settings changes not synced via WebSocket",
    "TKT-10021: Request -- board-level custom fields",
    "TKT-10025: Notification preferences reset after password change",
    "TKT-10029: Card weight field accepts negative values via API",
    "TKT-10033: Request -- card aging visualization by column dwell time",
    "TKT-10037: Board calendar view does not respect swimlane filter",
    # Ironside Manufacturing
    "TKT-11001: Card title font too small on shop floor tablets",
    "TKT-11005: Board does not work offline on factory floor WiFi dead zones",
    "TKT-11009: Request -- barcode scan to open card on mobile",
    "TKT-11013: Column header wraps incorrectly on narrow tablet screens",
    "TKT-11017: Card due date notification not sent for unassigned cards",
    "TKT-11021: Board invitation QR code too small to scan",
    "TKT-11025: Request -- simplified card view for non-technical users",
    "TKT-11029: Swimlane collapse all button not working",
    "TKT-11033: Card attachment upload fails on files with spaces in name",
    "TKT-11037: Request -- read-only board view for TV dashboards",
]

CUSTOMER_SUPPORT = {
    "slug": "customer_support",
    "name": "Template: Customer Support",
    "description": "Track support tickets from first report through resolution. Each swimlane is a customer account; each card is an open ticket.",
    "columns": _SUPPORT_COLUMNS,
    "swimlanes": _SUPPORT_SWIMLANES,
    "labels": _SUPPORT_LABELS,
    "extra_cards": _auto_cards(_SUPPORT_TITLES, _SUPPORT_COLUMNS, _SUPPORT_SWIMLANES, _SUPPORT_LABELS, "support"),
}


# ── 3. Customer Success ───────────────────────────────────────────────────────

_SUCCESS_COLUMNS = [
    {"name": "Onboarding",  "position": 0, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Adoption",    "position": 1, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Healthy",     "position": 2, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
    {"name": "Expansion",   "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Renewal",     "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Churned",     "position": 5, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_SUCCESS_SWIMLANES = [
    {"name": "Americas",            "position": 0,  "color": "#3B82F6", "contact_email": "csm-americas@visiban.example",  "notes": "US + Canada + LATAM accounts. CSM: Alex Rivera."},
    {"name": "EMEA",                "position": 1,  "color": "#8B5CF6", "contact_email": "csm-emea@visiban.example",      "notes": "Europe, Middle East, Africa. CSM: Jordan Patel."},
    {"name": "APAC",                "position": 2,  "color": "#10B981", "contact_email": "csm-apac@visiban.example",      "notes": "Australia, Japan, SE Asia. CSM: Morgan Wu."},
    {"name": "Enterprise Accounts", "position": 3,  "color": "#F59E0B", "contact_email": "enterprise-cs@visiban.example", "notes": "200+ seat strategic accounts managed directly by VP CS."},
    {"name": "Mid-Market",          "position": 4,  "color": "#EF4444", "contact_email": "midmarket-cs@visiban.example",  "notes": "20-200 seat accounts. CSM coverage pooled."},
    {"name": "Strategic Partners",  "position": 5,  "color": "#14B8A6", "contact_email": "partners-cs@visiban.example",   "notes": "Channel and technology partners. Joint success plans. CSM: Riley Kim."},
    {"name": "Government & Edu",    "position": 6,  "color": "#6366F1", "contact_email": "gov-cs@visiban.example",        "notes": "Public sector accounts. Longer procurement, stricter compliance. CSM: Sam Torres."},
    {"name": "Healthcare",          "position": 7,  "color": "#0EA5E9", "contact_email": "health-cs@visiban.example",     "notes": "HIPAA-compliant accounts. PHI handling required. CSM: Casey Park."},
    {"name": "Financial Services",  "position": 8,  "color": "#F43F5E", "contact_email": "fin-cs@visiban.example",        "notes": "SOC 2 and regulatory compliance required. CSM: Drew Martinez."},
    {"name": "Startup & SMB",       "position": 9,  "color": "#A855F7", "contact_email": "smb-cs@visiban.example",        "notes": "Sub-20-seat accounts. Tech-touch CSM model. Automated health scoring."},
    {"name": "Agency & Creative",   "position": 10, "color": "#EAB308", "contact_email": "agency-cs@visiban.example",     "notes": "Creative agencies and studios. High board count, low seat count. CSM: Avery Chen."},
]

_SUCCESS_LABELS = [
    {"name": "At Risk",               "color": "#EF4444"},
    {"name": "Champion",              "color": "#10B981"},
    {"name": "Expansion Opportunity", "color": "#F59E0B"},
    {"name": "Renewal Due",           "color": "#F97316"},
    {"name": "QBR Needed",            "color": "#8B5CF6"},
]

_SUCCESS_TITLES = [
    # Americas
    "Bright Solutions Inc -- Kickoff onboarding 150 seats",
    "RocketOps LLC -- Adoption review at 30 days",
    "Cirrus Analytics -- Healthy: 80% DAU, champion VP Product",
    "Vertex Media -- Expansion proposal 80 to 150 seats",
    "GreenLeaf Energy -- QBR preparation Q2",
    "Maple Creek Software -- Onboarding technical training",
    "Ironclad Legal -- Renewal negotiation 2-year deal",
    "Cascade Consulting -- At-risk: 22% DAU at day 60",
    "Frontier Retail -- Expansion to 5 new store regions",
    "Silver Ridge Analytics -- Healthy: NPS 9, reference candidate",
    "Horizon Aerospace -- Onboarding ITAR-compliant environment",
    "Lakewood Media Group -- Adoption enablement session",
    # EMEA
    "Polaris Engineering GmbH -- Onboarding SSO and DPA",
    "Meridian Consulting UK -- At-risk: 35% DAU at day 60",
    "Solaris Digital -- Healthy: self-service, 85% utilization",
    "Atlas Logistics BV -- Renewal + 30-seat expansion",
    "Nordic Ventures -- QBR with board of directors",
    "Rhine Pharma AG -- Adoption across clinical teams",
    "Celtic Insurance Group -- Renewal due end of quarter",
    "Aegean Maritime -- Onboarding 200-seat fleet ops",
    "Danube Fintech -- Expansion from 40 to 100 seats",
    "Alpine Retail GmbH -- Healthy: champion is VP Operations",
    "Baltic Shipping Corp -- Adoption: logistics teams lagging",
    "Iberian Software SL -- Churned: migrated to competitor",
    # APAC
    "Nexus Software -- Onboarding 50-seat Singapore firm",
    "Harbor Tech -- Adoption review: advanced features underused",
    "Pacific Ventures -- Healthy: NPS 9, Head of Product champion",
    "Koala Systems -- Churned: price sensitivity, low adoption",
    "Sakura Robotics -- Expansion from 60 to 120 seats",
    "Coral Bay Hotels -- Onboarding property management boards",
    "Dragon Fintech -- QBR preparation quarterly review",
    "Jade Capital Partners -- Healthy: 90% utilization",
    "Orient Express Travel -- Adoption: ops team training needed",
    "Bamboo Health Systems -- Renewal 1-year extension",
    "Phoenix Manufacturing -- At-risk: champion departed",
    "Tidal Wave Media -- Expansion: content team growing",
    # Enterprise Accounts
    "TechNova Inc -- Healthy: 500 seats, CTO sponsor",
    "BlueSky Health -- Adoption across clinical teams",
    "Global Freight Co -- Expansion 300 to 500 seats",
    "Pinnacle Finance -- Renewal 3-year deal with locked pricing",
    "Acme Corp -- QBR Q2 executive review",
    "Summit Financial -- Onboarding compliance workflow",
    "Brightwave Systems -- Healthy: 95% seat utilization",
    "Redwood Therapeutics -- Expansion into lab division",
    "Forge Analytics -- At-risk: stakeholder turnover",
    "NovaGen Biotech -- Renewal discussion started",
    "Vanguard Logistics -- Adoption: warehouse teams onboarding",
    "Apex Manufacturing -- Healthy: factory floor adoption strong",
    # Mid-Market
    "Redwood Agency -- Onboarding 25-seat creative agency",
    "Ironside Manufacturing -- Adoption: no champion identified",
    "Skyline Retail -- Healthy: 60% DAU, Ops Manager champion",
    "Fusion Labs -- Churned: consolidated to Notion",
    "Prism Design Studio -- Onboarding: 30-seat design team",
    "Cobalt Engineering -- Expansion from 50 to 80 seats",
    "Ember Analytics -- Renewal: annual contract due",
    "Driftwood Hospitality -- Adoption: restaurant teams training",
    "Granite Construction -- At-risk: low engagement after onboarding",
    "Velvet Media -- Healthy: strong board activity metrics",
    "Sapphire Tech -- QBR: discuss product roadmap alignment",
    "Copper Hill Logistics -- Expansion: 3 new warehouses",
    # Strategic Partners
    "Zenith Consulting Partners -- Joint success plan review",
    "Orbit Technology Alliance -- Partner enablement training",
    "Catalyst Integration Partners -- Co-sell pipeline review",
    "Nexus Reseller Network -- QBR partner performance metrics",
    "Prism SI Partners -- Onboarding partner technical team",
    "Keystone Channel Partners -- Renewal: 2-year agreement",
    "Beacon Advisory Group -- Expansion into new vertical",
    "Compass Technology Partners -- At-risk: low co-sell activity",
    "Pinnacle Resellers -- Healthy: 12 joint deals closed",
    "Summit Integration Co -- Adoption: partner portal underused",
    "Lighthouse Consulting -- Joint roadmap alignment session",
    "Meridian MSP Partners -- Partner certification program launch",
    # Government & Edu
    "State DOT Highway Division -- Onboarding project boards",
    "Metro School District -- Adoption: curriculum planning boards",
    "Federal Research Lab -- Renewal: FedRAMP compliance review",
    "County Public Health -- Expansion: 3 additional departments",
    "University of Westfield -- Healthy: IT and admissions boards",
    "City Transit Authority -- At-risk: procurement delays",
    "National Parks Service -- Onboarding: maintenance tracking",
    "State Education Board -- QBR: academic year planning review",
    "Military Base Operations -- Adoption: security clearance bottleneck",
    "Public Library System -- Healthy: cataloging workflow active",
    "Community College Network -- Expansion: 12 new campuses",
    "Municipal Water Authority -- Renewal: annual contract due",
    # Healthcare
    "Sunrise Medical Center -- Onboarding patient flow boards",
    "Coastal Clinic Network -- Adoption: nurse scheduling boards",
    "Valley Health System -- Healthy: 88% utilization, HIPAA compliant",
    "Metro Hospital Group -- Expansion: add 3 new facilities",
    "Lakeside Urgent Care -- Renewal: 2-year deal discussion",
    "Mountain View Rehab -- At-risk: HIPAA audit finding open",
    "Bayshore Pediatrics -- Onboarding: intake workflow boards",
    "Prairie Home Health -- Adoption: field nurse team training",
    "Riverdale Oncology -- QBR: treatment pathway board review",
    "Harbor Dental Group -- Healthy: appointment scheduling active",
    "Westside Cardiology -- Expansion: research division onboarding",
    "Northshore Elder Care -- Churned: switched to EMR-integrated tool",
    # Financial Services
    "Continental Bank -- Onboarding: compliance workflow boards",
    "Pacific Credit Union -- Adoption: loan processing boards",
    "Apex Wealth Management -- Healthy: portfolio review boards active",
    "Northern Trust Services -- Expansion: add private banking division",
    "Coastal Insurance Group -- Renewal: SOC 2 audit passed",
    "Metro Mortgage Lending -- At-risk: key stakeholder departed",
    "Summit Investment Partners -- QBR: regulatory change impact review",
    "Valley Savings Bank -- Adoption: branch operations lagging",
    "Harborview Financial -- Healthy: 92% utilization, strong champion",
    "Redwood Capital Group -- Expansion: M&A integration boards",
    "Evergreen Insurance -- Renewal: multi-year proposal sent",
    "Crestview Advisors -- Churned: acquired by larger firm",
    # Startup & SMB
    "ByteForge -- Onboarding: 8-seat engineering team",
    "PixelCraft Studios -- Adoption: sprint board underused",
    "CloudNine SaaS -- Healthy: 95% DAU, founder is champion",
    "GigaStack -- Expansion from 10 to 20 seats",
    "NanoTech Labs -- Churned: team dissolved after pivot",
    "QuickShip Logistics -- Onboarding: 15-seat ops team",
    "DataSpark Analytics -- Healthy: power user in every department",
    "MicroBrew Software -- Adoption: only founder is active",
    "RapidForm Inc -- QBR: discuss upgrade to mid-market tier",
    "TinyCloud Hosting -- Renewal: annual plan due",
    "SwiftCode Dev -- At-risk: switched to free tier competitor",
    "BrightNode AI -- Expansion: ML team wants dedicated boards",
    # Agency & Creative
    "Wildfire Creative -- Onboarding: campaign sprint boards",
    "Neon Studios -- Adoption: design team training session",
    "Ember & Oak Design -- Healthy: 15 active boards, strong usage",
    "Prism Motion Graphics -- Expansion: add video production team",
    "Cobalt Content Agency -- Renewal: 1-year extension discussion",
    "Driftwood Branding -- At-risk: CEO questioning ROI",
    "Sapphire Social Media -- Onboarding: content calendar boards",
    "Granite Publishing -- Adoption: editorial workflow underused",
    "Velvet Photography -- Healthy: client project boards active",
    "Copper Ink Creative -- QBR: discuss board template needs",
    "Sterling Advertising -- Expansion: 2 new client teams",
    "Jade Marketing Group -- Churned: consolidated to project management suite",
]

CUSTOMER_SUCCESS = {
    "slug": "customer_success",
    "name": "Template: Customer Success",
    "description": "Track account health from onboarding through expansion and renewal. Each swimlane represents a customer segment.",
    "columns": _SUCCESS_COLUMNS,
    "swimlanes": _SUCCESS_SWIMLANES,
    "labels": _SUCCESS_LABELS,
    "extra_cards": _auto_cards(_SUCCESS_TITLES, _SUCCESS_COLUMNS, _SUCCESS_SWIMLANES, _SUCCESS_LABELS, "success"),
}


# ── 4. Simple Kanban ──────────────────────────────────────────────────────────

_KANBAN_COLUMNS = [
    {"name": "Backlog", "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "To Do",   "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Doing",   "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Review",  "position": 3, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Done",    "position": 4, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_KANBAN_SWIMLANES = [
    {"name": "Frontend",      "position": 0,  "color": "#3B82F6", "contact_email": "", "notes": "React + TypeScript. Owns all UI components, pages, and the design system."},
    {"name": "Backend",       "position": 1,  "color": "#8B5CF6", "contact_email": "", "notes": "Django + DRF. Owns API, data models, business logic, and background tasks."},
    {"name": "Mobile",        "position": 2,  "color": "#EC4899", "contact_email": "", "notes": "React Native. iOS + Android. Syncs with main API."},
    {"name": "DevOps",        "position": 3,  "color": "#14B8A6", "contact_email": "", "notes": "CI/CD, infrastructure, reliability, and monitoring."},
    {"name": "Design",        "position": 4,  "color": "#F59E0B", "contact_email": "", "notes": "UX/UI design, design system, user research."},
    {"name": "QA",            "position": 5,  "color": "#EF4444", "contact_email": "", "notes": "Manual and automated testing. Regression suites and exploratory testing."},
    {"name": "Data",          "position": 6,  "color": "#10B981", "contact_email": "", "notes": "Data engineering and analytics. Pipelines, dashboards, and reporting."},
    {"name": "Security",      "position": 7,  "color": "#6366F1", "contact_email": "", "notes": "Application security, penetration testing, and compliance audits."},
    {"name": "Platform",      "position": 8,  "color": "#0EA5E9", "contact_email": "", "notes": "Shared libraries, SDKs, developer tooling, and internal APIs."},
    {"name": "Documentation", "position": 9,  "color": "#F43F5E", "contact_email": "", "notes": "Technical writing, API docs, user guides, and onboarding materials."},
]

_KANBAN_LABELS = [
    {"name": "Bug",       "color": "#EF4444"},
    {"name": "Feature",   "color": "#3B82F6"},
    {"name": "Improve",   "color": "#10B981"},
    {"name": "Tech Debt", "color": "#9CA3AF"},
    {"name": "Blocked",   "color": "#F97316"},
]

_KANBAN_TITLES = [
    # Frontend
    "Accessible focus rings on all interactive elements",
    "Implement card search with debounce",
    "Extract color token constants to design-system package",
    "Optimistic update for card weight field",
    "Responsive board layout for tablet breakpoints",
    "Keyboard shortcut overlay modal",
    "Virtualized card list for boards with 500+ cards",
    "Dark mode toggle persistence across sessions",
    "Drag preview ghost image polish for Safari",
    "Card detail modal transition animation",
    "Swimlane header sticky positioning on scroll",
    "Board skeleton loader during initial fetch",
    # Backend
    "Add cursor-based pagination to card list endpoint",
    "Rate limiting on public invite accept endpoint",
    "Bulk card archive endpoint",
    "N+1 fix on /api/boards/ list endpoint",
    "WebSocket reconnection with exponential backoff",
    "Card movement audit trail compression for old records",
    "Background task for stale card due date notifications",
    "Database index on card.position for sort performance",
    "API versioning header support for v2 endpoints",
    "Soft delete for archived boards with 30-day retention",
    "Batch webhook delivery for high-frequency board events",
    "Rate limit middleware per-user token bucket",
    # Mobile
    "Card swipe gestures for quick archive",
    "Fix card drag on iOS 17 with new UIKit scroll fix",
    "Push notification for card assignment",
    "Offline mode: queue moves while disconnected",
    "Biometric authentication for app unlock",
    "Pull-to-refresh on board view",
    "Haptic feedback on card drop",
    "Deep link to specific card from notification",
    "Widget for due-date cards on home screen",
    "Camera attachment flow from card detail",
    "Landscape mode layout for tablets",
    "App size reduction: remove unused assets",
    # DevOps
    "Rotate CI/CD secrets -- 90-day policy",
    "Add Prometheus metrics to API gateway",
    "Kubernetes pod autoscaling HPA tuning",
    "Zero-downtime deployment runbook",
    "Set up staging environment auto-teardown after 7 days",
    "Migrate CI runners to ARM64 for cost savings",
    "Implement canary deployment pipeline stage",
    "Database backup verification cron job",
    "Log aggregation: ship to Loki instead of CloudWatch",
    "Terraform state locking with DynamoDB",
    "Container image vulnerability scanning in CI",
    "CDN cache invalidation automation on deploy",
    # Design
    "Component audit -- identify inconsistent spacing",
    "Redesign empty state illustrations",
    "User research: onboarding friction study",
    "Dark mode color system -- token audit",
    "Card priority badge redesign for color-blind users",
    "Swimlane collapse animation prototype",
    "Board settings modal layout overhaul",
    "Typography scale standardization across all pages",
    "Icon set migration from Heroicons v1 to v2",
    "Mobile navigation bottom sheet pattern",
    "Loading state skeleton design tokens",
    "Accessibility audit report and remediation plan",
    # QA
    "End-to-end test suite for card move flow",
    "Visual regression testing with Playwright screenshots",
    "API contract testing with Pact",
    "Load testing board view with 1000 cards using k6",
    "Cross-browser smoke test matrix for board drag-and-drop",
    "Accessibility automated scan with axe-core in CI",
    "Regression test for CSV import edge cases",
    "Mobile device farm testing on BrowserStack",
    "Performance benchmark: board load time p95 tracking",
    "Chaos engineering: simulate WebSocket disconnects",
    "Test data factory for seed board generation",
    "Flaky test quarantine and auto-retry pipeline",
    # Data
    "ETL pipeline for board analytics warehouse",
    "Real-time dashboard for card throughput metrics",
    "User cohort analysis: retention by signup month",
    "Board activity heatmap aggregation job",
    "Data quality checks for movement audit trail",
    "Anomaly detection on card cycle time outliers",
    "Weekly email digest: board health scorecard",
    "Migration from Redshift to ClickHouse for analytics",
    "GDPR data deletion pipeline for churned accounts",
    "A/B test framework for onboarding flow experiments",
    "Custom event tracking for swimlane interactions",
    "Data catalog documentation for analytics tables",
    # Security
    "Penetration test remediation: XSS in card description",
    "CSRF token rotation policy enforcement",
    "API key scope restriction for third-party integrations",
    "Dependency vulnerability scan and patch cycle",
    "Security headers audit: HSTS, CSP, X-Frame-Options",
    "Rate limit bypass investigation on auth endpoints",
    "Secret scanning in CI for accidentally committed tokens",
    "OAuth token refresh flow hardening",
    "IP allowlisting for admin panel access",
    "Audit log tamper detection with hash chaining",
    "RBAC permission matrix documentation and test",
    "Incident response runbook update for data breach scenario",
    # Platform
    "Shared TypeScript SDK for API consumers",
    "Internal CLI tool for seed data generation",
    "GraphQL gateway proof of concept",
    "Feature flag service integration with LaunchDarkly",
    "Shared error boundary component for micro-frontends",
    "API client retry logic with idempotency keys",
    "Event bus abstraction for cross-service messaging",
    "Shared date/time utility library with timezone handling",
    "Developer onboarding script: one-command local setup",
    "Internal package registry for shared npm modules",
    "OpenAPI spec generation from DRF serializers",
    "Monorepo migration feasibility study",
    # Documentation
    "API reference overhaul with interactive examples",
    "Getting started guide for new self-hosted users",
    "Webhook event catalog with payload schemas",
    "Architecture decision records for major choices",
    "Runbook: how to restore a deleted board",
    "FAQ page for common support questions",
    "Video tutorial: setting up your first board",
    "Migration guide from Trello to Visiban",
    "Admin configuration reference for all env vars",
    "Changelog writing guidelines for contributors",
    "Glossary of Visiban-specific terms",
    "Release notes template for minor and major versions",
]

SIMPLE_KANBAN = {
    "slug": "simple_kanban",
    "name": "Template: Simple Kanban",
    "description": "General-purpose kanban for any team. Each swimlane is a team or workstream; each card is a work item.",
    "columns": _KANBAN_COLUMNS,
    "swimlanes": _KANBAN_SWIMLANES,
    "labels": _KANBAN_LABELS,
    "extra_cards": _auto_cards(_KANBAN_TITLES, _KANBAN_COLUMNS, _KANBAN_SWIMLANES, _KANBAN_LABELS, "kanban"),
}


# ── 5. Product Roadmap ────────────────────────────────────────────────────────

_ROADMAP_COLUMNS = [
    {"name": "Idea",       "position": 0, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Validated",  "position": 1, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Scoped",     "position": 2, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Prioritized","position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "In Build",   "position": 4, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Beta",       "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
    {"name": "Launched",   "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Monitoring", "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False},
]

_ROADMAP_SWIMLANES = [
    {"name": "Mobile App",            "position": 0,  "color": "#EC4899", "contact_email": "", "notes": "iOS and Android. Targets field workers and on-the-go board access."},
    {"name": "Core Platform",         "position": 1,  "color": "#3B82F6", "contact_email": "", "notes": "Web app, API, and shared infrastructure features."},
    {"name": "Integrations",          "position": 2,  "color": "#10B981", "contact_email": "", "notes": "Third-party integrations: Slack, GitHub, Jira, Zapier, webhooks."},
    {"name": "Analytics",             "position": 3,  "color": "#F59E0B", "contact_email": "", "notes": "Board analytics, cycle time, throughput, and reporting features."},
    {"name": "Compliance & Security", "position": 4,  "color": "#8B5CF6", "contact_email": "", "notes": "GDPR, SOC 2, audit logging, and security hardening features."},
    {"name": "Collaboration",         "position": 5,  "color": "#14B8A6", "contact_email": "", "notes": "Real-time collaboration, comments, mentions, and notification features."},
    {"name": "Import & Export",       "position": 6,  "color": "#6366F1", "contact_email": "", "notes": "Data portability: CSV, JSON, API bulk operations, and migration tools."},
    {"name": "Automation",            "position": 7,  "color": "#0EA5E9", "contact_email": "", "notes": "Rule-based automation: auto-move, auto-assign, scheduled actions."},
    {"name": "Admin & Settings",      "position": 8,  "color": "#F43F5E", "contact_email": "", "notes": "Board and site administration, user management, billing, and configuration."},
    {"name": "Search & Discovery",    "position": 9,  "color": "#EAB308", "contact_email": "", "notes": "Full-text search, filtering, saved views, and cross-board discovery."},
]

_ROADMAP_LABELS = [
    {"name": "Core",       "color": "#3B82F6"},
    {"name": "Platform",   "color": "#8B5CF6"},
    {"name": "UX",         "color": "#EC4899"},
    {"name": "Compliance", "color": "#F97316"},
    {"name": "AI / ML",    "color": "#10B981"},
]

_ROADMAP_TITLES = [
    # Mobile App
    "Offline-first card editing",
    "Apple Watch complication -- card due dates",
    "Barcode scanner for card attachment",
    "Push notification preferences",
    "Mobile board creation wizard",
    "Gesture-based card priority change",
    "Mobile-optimized analytics dashboard",
    "Voice-to-card creation via Siri Shortcuts",
    "Tablet split-view for board and card detail",
    "Mobile app widget for assigned cards count",
    "Biometric lock for sensitive boards",
    "Camera-to-checklist OCR for handwritten lists",
    # Core Platform
    "AI card description generator",
    "Card templates library",
    "Multi-board card linking",
    "Board activity feed",
    "Real-time collaboration cursors",
    "Card dependency graph visualization",
    "Board versioning and snapshot restore",
    "Custom card fields per board",
    "Bulk card operations toolbar",
    "Board cloning with selective content",
    "Card cover images from attachments",
    "Recurring cards on a schedule",
    # Integrations
    "Slack /visiban command",
    "GitHub PR to card status sync",
    "Zapier integration -- GA",
    "CSV import with column mapping UI",
    "Jira two-way sync for hybrid teams",
    "Microsoft Teams bot for card notifications",
    "Linear import tool for migrating teams",
    "Webhook retry dashboard with manual replay",
    "Google Calendar sync for card due dates",
    "Figma embed in card description",
    "PagerDuty integration for incident boards",
    "Notion page link preview in card comments",
    # Analytics
    "Cumulative flow diagram",
    "Cycle time histogram",
    "Throughput report -- weekly/monthly",
    "Analytics API -- public endpoints",
    "Swimlane dwell time heatmap",
    "Card aging distribution chart",
    "WIP limit violation trend report",
    "Team velocity comparison across boards",
    "Bottleneck detection with AI recommendations",
    "Custom date range selector for all analytics",
    "Exportable analytics PDF report",
    "Lead time vs cycle time breakdown",
    # Compliance & Security
    "GDPR right-to-erasure automation",
    "SOC 2 Type II -- audit logging",
    "Mandatory 2FA for site admins",
    "Content Security Policy headers",
    "Data residency region selector",
    "Session management dashboard for admins",
    "IP allowlisting for board access",
    "Encrypted card attachments at rest",
    "Compliance export with chain-of-custody metadata",
    "Role-based API key scoping",
    "Automated vulnerability disclosure page",
    "Password policy enforcement for local accounts",
    # Collaboration
    "Real-time card editing with conflict resolution",
    "@mention autocomplete in card comments",
    "Thread replies on card comments",
    "Card watchers with selective notifications",
    "Board-level announcement banner",
    "Emoji reactions on card comments",
    "Shared board templates marketplace",
    "Guest access with time-limited invites",
    "Activity digest email -- daily summary",
    "Inline image paste in card description",
    "Card handoff protocol between swimlanes",
    "Team presence indicators on board view",
    # Import & Export
    "Trello board importer",
    "Asana project importer",
    "Monday.com board importer",
    "Board export to PDF with layout preservation",
    "Bulk card export with movement history",
    "API bulk create endpoint for programmatic imports",
    "Scheduled automatic board backup to S3",
    "Board archive export as ZIP with attachments",
    "Cross-board card migration tool",
    "Import validation report with error details",
    "Export board as static HTML for sharing",
    "Migration dry-run mode with preview",
    # Automation
    "Auto-move card when all checklist items checked",
    "Auto-assign based on swimlane routing rules",
    "Scheduled card creation for recurring tasks",
    "SLA timer with automatic escalation column move",
    "Auto-archive cards after 30 days in Done column",
    "Trigger webhook on card field change",
    "Auto-label based on card title keywords",
    "Due date auto-set based on column entry",
    "Card priority auto-escalation as due date approaches",
    "Auto-notify assignee when card enters Review column",
    "Rule builder UI for custom automation workflows",
    "Automation audit log with undo capability",
    # Admin & Settings
    "Board-level permission templates",
    "User provisioning via SCIM",
    "Custom domain for self-hosted instances",
    "Billing dashboard with seat usage analytics",
    "Admin audit log with search and export",
    "Board archival policy with auto-archive after inactivity",
    "Global notification settings override for admins",
    "Customizable card detail layout per board",
    "Site-wide announcement system for maintenance windows",
    "User deactivation with data reassignment workflow",
    "Multi-tenant isolation for managed hosting",
    "Admin dashboard: system health and usage overview",
    # Search & Discovery
    "Full-text search across all boards and cards",
    "Saved filter views per board",
    "Cross-board card search with unified results",
    "Search by card movement history",
    "Filter cards by assignee across all boards",
    "Smart suggestions: recently viewed cards",
    "Search within card comments and checklists",
    "Keyboard-driven command palette for navigation",
    "Saved search alerts with email notifications",
    "Board directory with search and categorization",
    "Tag-based card grouping across swimlanes",
    "AI-powered search with natural language queries",
]

PRODUCT_ROADMAP = {
    "slug": "product_roadmap",
    "name": "Template: Product Roadmap",
    "description": "Track features from idea through launch and monitoring. Each swimlane is a product area; each card is a feature or initiative.",
    "columns": _ROADMAP_COLUMNS,
    "swimlanes": _ROADMAP_SWIMLANES,
    "labels": _ROADMAP_LABELS,
    "extra_cards": _auto_cards(_ROADMAP_TITLES, _ROADMAP_COLUMNS, _ROADMAP_SWIMLANES, _ROADMAP_LABELS, "roadmap"),
}


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 2 -- loaded from generate_seed_data_part2.py
# ═════════════════════════════════════════════════════════════════════════════
# Templates 6-10 are defined in generate_seed_data_part2.py and imported below.
# This split keeps each file manageable.


def _load_part2():
    part2_path = os.path.join(SEED_DATA_DIR, "generate_seed_data_part2.py")
    import importlib.util
    spec = importlib.util.spec_from_file_location("part2", part2_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.TEMPLATES_PART2


# ── Main ──────────────────────────────────────────────────────────────────────
ALL_TEMPLATES = [
    SALES_PIPELINE,
    CUSTOMER_SUPPORT,
    CUSTOMER_SUCCESS,
    SIMPLE_KANBAN,
    PRODUCT_ROADMAP,
]


def main():
    global ALL_TEMPLATES
    part2 = _load_part2()
    ALL_TEMPLATES = ALL_TEMPLATES + part2

    for tpl in ALL_TEMPLATES:
        slug = tpl["slug"]
        data = _build(tpl)
        out_path = os.path.join(SEED_DATA_DIR, f"{slug}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"  \u2713  {slug}.json  ({len(data['cards'])} cards)")

    print(f"\nDone -- {len(ALL_TEMPLATES)} templates regenerated.")


if __name__ == "__main__":
    main()
