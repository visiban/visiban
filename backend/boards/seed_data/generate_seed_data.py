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
      60 % straight sequential (0 → 1 → 2 → … → target)
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
    """Full movement chain from null → col[0] → … → col[target_idx]."""
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
                "actor": _user(card_seed + 1), "created_at": _iso(ts),
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
    All card content is authoritative from the template definition — the
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


# ═════════════════════════════════════════════════════════════════════════════
# TEMPLATE DEFINITIONS
# ═════════════════════════════════════════════════════════════════════════════

# ── 1. Sales Pipeline ─────────────────────────────────────────────────────────
SALES_PIPELINE = {
    "slug": "sales_pipeline",
    "name": "Template: Sales Pipeline",
    "description": "Track open deals from first contact through close. Each swimlane is a sales region; each card is a deal or opportunity.",
    "columns": [
        {"name": "Prospect",      "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Qualified",     "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Discovery",     "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Demo",          "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Proposal Sent", "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Negotiation",   "position": 5, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
        {"name": "Closed Won",    "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Closed Lost",   "position": 7, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "North America", "position": 0, "color": "#3B82F6", "contact_email": "na-sales@example.com",   "notes": "Primary market. Enterprise and Mid-Market focus. Q2 pipeline target: $2.4M ARR."},
        {"name": "APAC",          "position": 1, "color": "#F59E0B", "contact_email": "apac-sales@example.com", "notes": "Partner-led motion in several subregions. Retail and ops-heavy accounts. Longer procurement cycles."},
        {"name": "EMEA",          "position": 2, "color": "#8B5CF6", "contact_email": "emea-sales@example.com", "notes": "Fintech and compliance-heavy accounts dominant. GDPR and DPA required on most enterprise deals."},
        {"name": "LATAM",         "position": 3, "color": "#10B981", "contact_email": "latam-sales@example.com","notes": "Healthcare and government verticals. Longer sales cycles. HIPAA-equivalent local data regulations."},
        {"name": "ANZ",           "position": 4, "color": "#EC4899", "contact_email": "anz-sales@example.com",  "notes": "SMB and creative agency accounts. Fast decision cycles — typically days, not weeks."},
    ],
    "labels": [
        {"name": "Enterprise", "color": "#3B82F6"},
        {"name": "SMB",        "color": "#10B981"},
        {"name": "Strategic",  "color": "#8B5CF6"},
        {"name": "Renewal",    "color": "#F97316"},
        {"name": "Upsell",     "color": "#F59E0B"},
    ],
    "extra_cards": [
        # North America (Enterprise SaaS: Prospect → Discovery → Proposal Sent → Closed Won)
        _c("Initial Outreach — Enterprise Platform", "Prospect", "North America", "medium", 21, 3, ["Enterprise"],
           _chk("Research account on LinkedIn", "Find champion contact", "Send intro email"),
           desc="First contact with a Series C SaaS company's procurement team. VP Engineering expressed interest after outgrowing their current tool. 500-seat target."),
        _c("Platform Migration — 500 Seats", "Discovery", "North America", "high", 14, 6, ["Enterprise", "Strategic"],
           _chk("+Map current Jira workflow", "+Identify pain points", "Define migration scope", "Schedule technical review"),
           [_cmt("Pain is clear: 500 users on Jira Cloud, $180k/year. They want swimlane-based boards.", "demo2"),
            _cmt("Champion confirmed: VP Engineering. Budget owner is CFO — need CFO intro.", "demo1")],
           desc="Full platform migration for a Series C SaaS account with 3 Jira instances to consolidate. Discovery call revealed strong swimlane requirement for customer tracking."),
        _c("Analytics Add-on Proposal", "Proposal Sent", "North America", "high", 7, 4, ["Enterprise", "Upsell"],
           _chk("+Draft SOW", "+Pricing approved by CS", "Send to procurement", "Follow up after 3 days"),
           [_cmt("Proposal sent Friday. Procurement said they'll respond within 5 business days.", "demo3")],
           desc="Add-on proposal for Analytics module on top of the base platform deal. Combined deal value significantly higher than base license alone."),
        _c("500-Seat Enterprise Deal — Closed Won", "Closed Won", "North America", "high", -5, 8, ["Enterprise", "Strategic"],
           _chk("+Procurement approved", "+Legal signed MSA", "+Onboarding scheduled", "+CS handoff completed"),
           [_cmt("MSA signed. 500 seats, 2-year term. CS onboarding starts Monday.", "demo1"),
            _cmt("Biggest win this quarter. Will feature as a Q2 launch case study.", "demo4")],
           desc="500-seat enterprise deal closed after 60-day sales cycle. Includes platform + analytics module. 2-year commit."),

        # APAC (Retail chain: Qualified → Demo → Negotiation → Closed Lost)
        _c("Ops Board Pilot — 50 Stores", "Qualified", "APAC", "medium", 28, 3, ["SMB"],
           _chk("+ICP confirmed", "+Budget holder identified", "Schedule discovery call"),
           desc="200-location retail chain flagged as qualified after inbound inquiry. Ops team wants to track store maintenance tasks on a kanban board. Piloting with 50 stores."),
        _c("Operations Board Demo — CTO", "Demo", "APAC", "high", 10, 5, ["SMB", "Strategic"],
           _chk("+Prepared demo board with retail template", "+CTO confirmed attendance", "Capture follow-up questions", "Send recording"),
           [_cmt("Demo went well. CTO loved the swimlane-per-store concept. Wants a 2-week trial.", "demo2")],
           desc="Live demo for CTO and ops director showing the retail-specific board template. Focus on swimlane-per-store structure and mobile card creation for field workers."),
        _c("Contract Review — Budget Objection", "Negotiation", "APAC", "urgent", 3, 6, ["SMB"],
           _chk("+Sent revised pricing", "Awaiting legal review", "Follow up with CTO"),
           [_cmt("Budget freeze lifted March 15. Back in active negotiation — CTO wants 10% discount for 2-year commit.", "demo3"),
            _cmt("Legal flagged data residency clause. Need to confirm APAC data processing requirements.", "demo5")],
           desc="Deal stalled on seasonal budget freeze. Now active again with CFO involved. Negotiating annual vs multi-year terms. Legal review in progress."),
        _c("Retail Pilot — Lost to Competitor", "Closed Lost", "APAC", "medium", -15, 3, ["SMB"],
           _chk("+Post-mortem completed", "+Added to lost-deal analysis"),
           [_cmt("Lost on price. Competitor offered 40% lower for year 1. Need to revisit SMB pricing model.", "demo1"),
            _cmt("Champion left company. New IT manager not familiar with the pain.", "demo4")],
           desc="Pilot converted to full evaluation but lost to a lower-cost competitor. Champion attrition contributed. Scheduled 6-month re-engage."),

        # EMEA (Fintech/compliance: Qualified → Discovery → Proposal Sent → Closed Won)
        _c("Compliance Workflow License — 80 Seats", "Qualified", "EMEA", "high", 25, 4, ["Enterprise", "Strategic"],
           _chk("+GDPR/SOC2 requirements confirmed", "+Champion is VP Product", "Invite to webinar"),
           desc="Fintech prospect focused on compliance workflows. SOC 2 requirement is non-negotiable. VP Product is a strong champion and has been using Visiban personally."),
        _c("Engineering Team Discovery Call", "Discovery", "EMEA", "high", 18, 5, ["Enterprise"],
           _chk("+Mapped current Trello usage", "+Identified audit trail requirement", "Draft custom template", "Share security whitepaper"),
           [_cmt("Key insight: they need a full audit log of card movements for compliance. Our History tab is a differentiator.", "demo2")],
           desc="Deep-dive discovery with VP Product and two senior engineers. Compliance audit trail is top priority — CardMovement history is a key differentiator over competitors."),
        _c("Compliance Platform Proposal — 80 Seats", "Proposal Sent", "EMEA", "urgent", 5, 6, ["Enterprise", "Strategic"],
           _chk("+Proposal drafted", "+Legal reviewed GDPR addendum", "+Sent to VP Product", "Awaiting sign-off"),
           [_cmt("Proposal includes DPA and GDPR addendum. VP Product very positive — escalating to CTO.", "demo3")],
           desc="Full commercial proposal including DPA, GDPR data processing addendum, and SOC 2 compliance documentation. VP Product championing internally."),
        _c("80-Seat Fintech Deal — Closed Won", "Closed Won", "EMEA", "high", -10, 7, ["Enterprise"],
           _chk("+Contract signed", "+Data processing addendum executed", "+Onboarding session booked", "+CS assigned"),
           [_cmt("Closed! 80 seats, 1-year term with renewal option. DPA signed. CS starting onboarding next week.", "demo1"),
            _cmt("Great reference account for the EMEA fintech vertical. Happy to be a case study.", "demo4")],
           desc="80-seat deal closed with GDPR DPA and SOC 2 compliance documentation. Strong fintech reference account for the EMEA region."),

        # LATAM (Healthcare: Prospect → Demo → Negotiation → Closed Won)
        _c("Healthcare Platform — Initial Outreach", "Prospect", "LATAM", "low", 35, 2, ["Enterprise"],
           _chk("Confirm local data compliance requirements", "Research healthcare use case", "Send intro deck"),
           desc="Inbound lead from a regional healthcare provider exploring project tracking for clinical ops. Local data compliance equivalent to HIPAA will be required."),
        _c("Patient Care Workflow Demo — VP Operations", "Demo", "LATAM", "high", 12, 5, ["Enterprise", "Strategic"],
           _chk("+Prepared healthcare board template", "+Compliance review completed by legal", "Capture clinical workflow requirements", "Schedule follow-up"),
           [_cmt("Demo completed. VP Ops was impressed by the swimlane-per-department structure. Compliance agreement required before next steps.", "demo2")],
           desc="Demo for VP Operations showing a healthcare-specific workflow template. Data compliance agreement is a prerequisite for moving forward — legal team engaged."),
        _c("Data Processing Agreement Negotiation", "Negotiation", "LATAM", "urgent", 6, 7, ["Enterprise", "Strategic"],
           _chk("+Legal drafted data processing agreement", "+Sent to account legal team", "Awaiting redlines", "Final sign-off"),
           [_cmt("Their legal team has 3 redlines. None are blockers — we can accept all of them.", "demo3"),
            _cmt("VP Ops is pushing their legal to expedite. Deal is ready to close pending agreement.", "demo5")],
           desc="Data processing agreement in final legal review on both sides. VP Operations is the deal sponsor and is actively pushing their legal team to close. Deal value: 200 seats."),
        _c("200-Seat Healthcare Deal — Closed Won", "Closed Won", "LATAM", "high", -3, 8, ["Enterprise", "Strategic"],
           _chk("+Data processing agreement signed", "+MSA executed", "+Onboarding kickoff scheduled", "+CS team notified"),
           [_cmt("Agreement signed — that was the last blocker. 200-seat deal, 3-year term, closed!", "demo1"),
            _cmt("First major healthcare enterprise win in LATAM. Adding to the regional case study pipeline.", "demo2")],
           desc="200-seat 3-year deal closed with full compliance documentation and enterprise MSA. First major healthcare vertical win in the region."),

        # ANZ (Creative agency/SMB: Qualified → Demo → Closed Won + Closed Lost upsell)
        _c("Creative Agency Sprint Boards — 30 Seats", "Qualified", "ANZ", "medium", 20, 3, ["SMB"],
           _chk("+Decision maker identified (Ops Director)", "+30-seat count confirmed", "Schedule demo this week"),
           desc="Small creative agency looking for a lightweight kanban for campaign sprint tracking. Decision cycles are short — Ops Director can approve on the spot."),
        _c("Agency Workflow Demo — Ops Director", "Demo", "ANZ", "high", 8, 4, ["SMB"],
           _chk("+Demo prepared with content production template", "+Ops Director confirmed", "Capture content calendar requirements", "Send follow-up same day"),
           [_cmt("Great energy in the demo. They loved the content production template. Follow-up sent same afternoon.", "demo2")],
           desc="30-minute demo focused on the content production board template. Ops Director has authority to approve. Follow-up sent within 2 hours."),
        _c("Campaign Sprint Boards — Closed Won", "Closed Won", "ANZ", "medium", -8, 4, ["SMB"],
           _chk("+Contract signed (same day)", "+Seats activated", "+Onboarding completed"),
           [_cmt("Closed same day as demo. Fastest deal cycle this quarter — 8 days from first contact to close.", "demo1"),
            _cmt("Great SMB reference. They're already telling other agencies about us.", "demo4")],
           desc="30-seat SMB deal closed 8 days after initial contact. Content production template was the key differentiator. Short, clean deal cycle."),
        _c("Video Production Add-on — Lost", "Closed Lost", "ANZ", "low", -20, 2, ["SMB", "Upsell"],
           _chk("+Sent add-on proposal", "+Post-mortem completed"),
           [_cmt("Lost the add-on upsell — they built a custom Notion template instead. Revisit in 6 months.", "demo3")],
           desc="Upsell attempt for video production workflow add-on. Lost to a Notion template built internally. Base deal retained. Re-engage at renewal."),
    ],
}


# ── 2. Customer Support ───────────────────────────────────────────────────────
CUSTOMER_SUPPORT = {
    "slug": "customer_support",
    "name": "Template: Customer Support",
    "description": "Track support tickets from first report through resolution. Each swimlane is a customer account; each card is an open ticket.",
    "columns": [
        {"name": "New",               "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Triaged",           "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Investigating",     "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Awaiting Customer", "position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Escalated",         "position": 4, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
        {"name": "Resolved",          "position": 5, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Closed",            "position": 6, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "TechNova Inc",      "position": 0, "color": "#3B82F6", "contact_email": "support@technova.example",    "notes": "Enterprise tier. SLA: 4-hour response, 24-hour resolution for P1."},
        {"name": "Apex Retail Group", "position": 1, "color": "#F59E0B", "contact_email": "support@apexretail.example",  "notes": "Mid-market. SLA: 8-hour response. Contact: IT Manager."},
        {"name": "FinEdge Ltd",       "position": 2, "color": "#8B5CF6", "contact_email": "support@finedge.example",    "notes": "Compliance-sensitive. All support comms may be audited. Use formal language."},
        {"name": "BlueSky Health",    "position": 3, "color": "#10B981", "contact_email": "support@blueskyhealth.example","notes": "HIPAA environment. Do not share PHI in support threads. Escalate data questions to legal."},
        {"name": "Mosaic Creative",   "position": 4, "color": "#EC4899", "contact_email": "support@mosaiccreative.example","notes": "SMB tier. Self-serve. Generally quick to resolve — low SLA pressure."},
    ],
    "labels": [
        {"name": "Bug",             "color": "#EF4444"},
        {"name": "Feature Request", "color": "#3B82F6"},
        {"name": "Billing",         "color": "#F59E0B"},
        {"name": "Security",        "color": "#8B5CF6"},
        {"name": "Performance",     "color": "#10B981"},
    ],
    "extra_cards": [
        # TechNova
        _c("TKT-1041: Board load hangs after 300+ cards", "New", "TechNova Inc", "urgent", 1, 5, ["Performance"],
           _chk("Reproduce with >300 cards", "Check query plan for full/ endpoint", "Profile API response time"),
           desc="Enterprise board with 340 cards takes 18s to load. Browser DevTools shows the /full/ endpoint is returning a 2.8MB JSON payload. Reported by VP Engineering directly."),
        _c("TKT-1028: Webhook not firing on card archive", "Investigating", "TechNova Inc", "high", 3, 4, ["Bug"],
           _chk("+Reproduced in staging", "+Identified missing signal in archive view", "Write fix + regression test", "Deploy to staging"),
           [_cmt("Root cause found: archive endpoint calls card.save() but doesn't emit the post_save signal. Fix is small.", "demo2")],
           desc="Outbound webhook for `card.archived` event never fires. Customer confirmed their Zapier automation is broken. Isolated to the archive endpoint — signal not emitted."),
        _c("TKT-1015: SSO login loop on Safari 17.4", "Resolved", "TechNova Inc", "high", -2, 5, ["Bug"],
           _chk("+Reproduced on Safari 17.4", "+Root cause: SameSite cookie issue", "+Fix deployed to production", "+Customer confirmed resolved"),
           [_cmt("Safari 17.4 changed SameSite=Lax handling. Fixed by setting SameSite=None; Secure on session cookie.", "demo1"),
            _cmt("Customer confirmed fix working. All 500 users back on Safari.", "demo4")],
           desc="500 TechNova users on Safari 17.4 unable to complete SSO login — infinite redirect loop. Root cause: SameSite cookie attribute incompatible with Safari 17.4 strict mode."),
        _c("TKT-1009: Export CSV missing swimlane column", "Closed", "TechNova Inc", "medium", -12, 3, ["Bug"],
           _chk("+Bug confirmed", "+Fix merged", "+Deployment verified", "+Customer notified"),
           [_cmt("CSV export was omitting the swimlane field for boards with >10 swimlanes. Fixed. Closed.", "demo3")],
           desc="CSV export for boards with more than 10 swimlanes was omitting the swimlane_name column. Fixed in v1.2.1. Customer confirmed resolved."),

        # Apex Retail
        _c("TKT-2033: Cards not syncing across browser tabs", "Triaged", "Apex Retail Group", "medium", 5, 3, ["Bug"],
           _chk("+Reproduced in Chrome", "Check WebSocket broadcast logic", "Verify card.updated event payload"),
           desc="IT Manager reports that opening the same board in two browser tabs shows different card states after a drag-drop. WebSocket event not reaching second tab."),
        _c("TKT-2027: Swimlane collapse state not persisting", "Awaiting Customer", "Apex Retail Group", "low", 8, 2, ["Bug"],
           _chk("+Confirmed is localStorage-based", "+Asked customer for repro steps", "Waiting for screen recording"),
           [_cmt("Asked customer to confirm which browser and whether they clear localStorage. Awaiting response.", "demo2")],
           desc="Customer reports that collapsed swimlanes revert to expanded on page reload. localStorage key `swimlane-collapsed` should persist. Awaiting confirmation of browser version."),
        _c("TKT-2019: Request — bulk card move between swimlanes", "Resolved", "Apex Retail Group", "medium", -5, 4, ["Feature Request"],
           _chk("+Confirmed as feature request", "+Linked to roadmap item #FR-088", "+Customer informed of timeline"),
           [_cmt("Not a bug — bulk move is on the roadmap for Q3. Customer accepted the timeline.", "demo1")],
           desc="Customer wants to select multiple cards and move them to a different swimlane in one action. This is a feature request, not a bug. Linked to roadmap item FR-088."),
        _c("TKT-2011: Board permissions not applying to new members", "Closed", "Apex Retail Group", "high", -18, 5, ["Bug"],
           _chk("+Reproduced", "+Root cause: role cache not invalidated on invite accept", "+Fix deployed", "+Closed"),
           [_cmt("Cache invalidation bug. Board role was cached for 15 min — new members had stale 'viewer' role for up to 15 min after accepting invite. Fixed.", "demo3"),
            _cmt("Customer confirmed resolved. No further issues reported.", "demo5")],
           desc="New board members added via invite link had viewer-only access for up to 15 minutes after accepting, even when invited as members. Root cause: role cache invalidation bug."),

        # FinEdge
        _c("TKT-3044: Audit log export missing movement events", "Triaged", "FinEdge Ltd", "urgent", 2, 6, ["Bug", "Security"],
           _chk("+Confirmed gap in activity export", "Check CardMovement vs CardActivity join", "Legal informed of issue"),
           [_cmt("CardMovement events (History tab) are not appearing in the compliance export. This is critical for FinEdge's audit requirements.", "demo2")],
           desc="FinEdge compliance export is missing CardMovement records — only CardActivity events appear. This breaks their SOC 2 audit trail. High-priority fix required."),
        _c("TKT-3038: 2FA enforcement not applying to SSO users", "Escalated", "FinEdge Ltd", "urgent", 1, 7, ["Security"],
           _chk("+Reproduced", "+Escalated to security team", "Draft fix for SSO bypass", "Security review required"),
           [_cmt("SSO users can bypass 2FA enforcement because the allauth SSO pipeline doesn't trigger the 2FA check middleware. Escalated to security.", "demo1"),
            _cmt("Fix drafted. Requires security review before deployment. Scheduling review for tomorrow.", "demo3")],
           desc="Board admin's 2FA enforcement setting is not applied to users who log in via SSO. SSO pipeline bypasses the 2FA middleware. Security-critical fix in progress."),
        _c("TKT-3025: API rate limit headers missing from responses", "Resolved", "FinEdge Ltd", "medium", -4, 3, ["Bug"],
           _chk("+Confirmed: X-RateLimit-* headers not set", "+Fix deployed", "+Verified in production"),
           [_cmt("throttle_classes was set but the response header middleware wasn't adding headers. One-line fix.", "demo2")],
           desc="X-RateLimit-Limit and X-RateLimit-Remaining headers missing from API responses. Required by FinEdge's API gateway for rate-limit-aware routing. Fixed."),
        _c("TKT-3014: Webhook HMAC signature docs incorrect", "Closed", "FinEdge Ltd", "low", -22, 2, ["Bug"],
           _chk("+Docs error confirmed", "+Docs updated", "+Customer notified"),
           [_cmt("Docs showed SHA-256 but implementation uses HMAC-SHA256 with the secret as key. Fixed docs. No code change needed.", "demo4")],
           desc="Documentation for webhook HMAC signature verification had an error — showed SHA-256 hash but correct implementation is HMAC-SHA256. Docs updated."),

        # BlueSky Health
        _c("TKT-4029: Card attachments not uploading for HIPAA users", "New", "BlueSky Health", "urgent", 1, 6, ["Bug", "Security"],
           _chk("Confirm HIPAA S3 bucket policy", "Check IAM role on upload path", "Do not access attachment content"),
           desc="BlueSky users in the HIPAA-segregated tenant are getting 403 on all attachment uploads. HIPAA-specific S3 bucket may have restrictive IAM policy. Do not access any uploaded content."),
        _c("TKT-4021: Board export failing for HIPAA tenant", "Escalated", "BlueSky Health", "high", 3, 5, ["Bug"],
           _chk("+Reproduced in HIPAA tenant", "+Escalated to infra team", "Check S3 export permissions", "Do not share export content"),
           [_cmt("HIPAA tenant export path requires explicit KMS key. Not set on export lambda. Escalated to infra.", "demo2"),
            _cmt("Do not open exported files — may contain PHI. Route via legal if content access needed.", "demo5")],
           desc="CSV and JSON board exports fail with 500 for BlueSky's HIPAA tenant. Likely KMS key permission issue on the export S3 path. PHI sensitivity — do not open exported content."),
        _c("TKT-4018: Resolved — Email notification delays in HIPAA tenant", "Resolved", "BlueSky Health", "medium", -6, 3, ["Bug", "Performance"],
           _chk("+Root cause: SES sandbox limit in HIPAA region", "+Moved to production SES", "+Notifications confirmed working"),
           [_cmt("HIPAA region SES was in sandbox mode (200 emails/day limit). Moved to production SES. Delays resolved.", "demo1")],
           desc="Email notifications delayed by 2-4 hours for BlueSky users. Root cause: SES sandbox limit in the HIPAA-compliant AWS region. Production SES now active."),
        _c("TKT-4005: Closed — Board member cannot see swimlane", "Closed", "BlueSky Health", "high", -30, 4, ["Bug"],
           _chk("+Root cause: role cache race condition", "+Fix deployed", "+All affected users confirmed restored", "+Post-mortem filed"),
           [_cmt("Newly invited board members saw empty swimlane list for up to 30s after joining. Race condition in role cache population. Fixed.", "demo3"),
            _cmt("Closed. 12 users were affected. All confirmed normal access now.", "demo4")],
           desc="Board members added to BlueSky boards could not see swimlanes for up to 30 seconds after accepting invite. Role cache race condition. Fixed and verified."),

        # Mosaic Creative
        _c("TKT-5018: Colors not saving on card labels", "New", "Mosaic Creative", "medium", 4, 2, ["Bug"],
           _chk("Reproduce on Chrome and Safari", "Check label update API response", "Verify localStorage cache"),
           desc="Customer reports that when they change a label color in board settings, cards already using that label don't update to the new color until page refresh. Expected: live update."),
        _c("TKT-5014: Request — keyboard shortcut to archive card", "Triaged", "Mosaic Creative", "low", 12, 2, ["Feature Request"],
           _chk("+Logged as feature request FR-091", "+Shared current keyboard shortcut guide", "Estimate implementation effort"),
           [_cmt("Currently no shortcut for archive. Logged FR-091. Low priority — will review for next keyboard shortcut batch.", "demo1")],
           desc="Customer wants a keyboard shortcut (e.g. Shift+A) to archive a card from the board view without opening the card detail modal."),
        _c("TKT-5009: Resolved — Import CSV failing on special characters", "Resolved", "Mosaic Creative", "medium", -8, 3, ["Bug"],
           _chk("+Reproduced with UTF-8 em-dash in title", "+Fix: explicit UTF-8-sig encoding on CSV parse", "+Deployed", "+Verified"),
           [_cmt("CSV import was using default encoding — failed on non-ASCII characters. Fixed with explicit UTF-8-sig detection. Closed.", "demo2")],
           desc="CSV import failed for any file containing non-ASCII characters (em-dashes, smart quotes, accented chars). Fixed by adding explicit UTF-8-sig encoding detection."),
        _c("TKT-5003: Closed — Due date filter returning no results", "Closed", "Mosaic Creative", "low", -25, 2, ["Bug"],
           _chk("+Root cause: timezone offset in date comparison", "+Fix deployed", "+Customer confirmed"),
           [_cmt("Due date filter compared UTC date with user's local YYYY-MM-DD string. Off-by-one around midnight. Fixed.", "demo3")],
           desc="Due date filter was returning zero results for same-day queries in timezones west of UTC. Fixed timezone-aware date comparison."),
    ],
}


# ── 3. Customer Success ───────────────────────────────────────────────────────
CUSTOMER_SUCCESS = {
    "slug": "customer_success",
    "name": "Template: Customer Success",
    "description": "Track account health from onboarding through expansion and renewal. Each swimlane represents a customer segment.",
    "columns": [
        {"name": "Onboarding",  "position": 0, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Adoption",    "position": 1, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Healthy",     "position": 2, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Expansion",   "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Renewal",     "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Churned",     "position": 5, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Americas",           "position": 0, "color": "#3B82F6", "contact_email": "csm-americas@visiban.example",  "notes": "US + Canada + LATAM accounts. CSM: Alex Rivera."},
        {"name": "EMEA",               "position": 1, "color": "#8B5CF6", "contact_email": "csm-emea@visiban.example",      "notes": "Europe, Middle East, Africa. CSM: Jordan Patel."},
        {"name": "APAC",               "position": 2, "color": "#10B981", "contact_email": "csm-apac@visiban.example",      "notes": "Australia, Japan, SE Asia. CSM: Morgan Wu."},
        {"name": "Enterprise Accounts","position": 3, "color": "#F59E0B", "contact_email": "enterprise-cs@visiban.example", "notes": "200+ seat strategic accounts managed directly by VP CS."},
        {"name": "Mid-Market",         "position": 4, "color": "#EF4444", "contact_email": "midmarket-cs@visiban.example",  "notes": "20-200 seat accounts. CSM coverage pooled."},
    ],
    "labels": [
        {"name": "At Risk",               "color": "#EF4444"},
        {"name": "Champion",              "color": "#10B981"},
        {"name": "Expansion Opportunity", "color": "#F59E0B"},
        {"name": "Renewal Due",           "color": "#F97316"},
        {"name": "QBR Needed",            "color": "#8B5CF6"},
    ],
    "extra_cards": [
        # Americas
        _c("Bright Solutions Inc — Onboarding", "Onboarding", "Americas", "high", 14, 4, ["Champion"],
           _chk("+Kickoff call completed", "+Admin users set up", "Board templates configured", "Training session scheduled"),
           [_cmt("Kickoff went great. Primary admin is Taylor Chen — very technical, will be self-sufficient quickly.", "demo1")],
           desc="New 150-seat account in onboarding phase. Strong champion in Taylor Chen (Head of Engineering). Technical team is eager to self-configure."),
        _c("RocketOps LLC — Adoption", "Adoption", "Americas", "medium", 21, 3, ["QBR Needed"],
           _chk("+Initial boards created", "+Team training completed", "Review board utilization metrics", "Schedule QBR"),
           desc="60-seat account in adoption. Board creation is good (12 boards) but only 30% of seats have been active in the last 30 days. QBR scheduled to review adoption blockers."),
        _c("Cirrus Analytics — Healthy", "Healthy", "Americas", "medium", None, 3, ["Champion"],
           _chk("+Onboarding completed", "+DAU/MAU above 70%", "+Champion identified: VP Product"),
           desc="80-seat account in healthy state. VP Product (Jordan Lee) is an active champion and has recommended Visiban to two other companies in their portfolio."),
        _c("Vertex Media — Expansion", "Expansion", "Americas", "high", 10, 5, ["Expansion Opportunity"],
           _chk("+Current usage at 95% seat capacity", "+Expansion proposal drafted", "Present to CFO", "Update commercial terms"),
           [_cmt("They've grown from 40 to 75 active users. Seat expansion from 80 to 150 is the right next step.", "demo2")],
           desc="80-seat account is nearly at full capacity with 75 active users. Expansion to 150 seats in discussion. CFO meeting scheduled."),

        # EMEA
        _c("Polaris Engineering GmbH — Onboarding", "Onboarding", "EMEA", "medium", 18, 3, ["Champion"],
           _chk("+GDPR DPA signed", "+SSO configured", "Admin training completed", "First boards live"),
           desc="New 120-seat German engineering firm. GDPR DPA signed. SSO configured via Azure AD. First boards going live this week."),
        _c("Meridian Consulting UK — Adoption", "Adoption", "EMEA", "high", 7, 4, ["At Risk", "QBR Needed"],
           _chk("+Training session completed", "Investigate low adoption (35% DAU)", "Identify internal champion", "QBR within 2 weeks"),
           [_cmt("Adoption is low — only 35% of seats active. Likely an internal champion problem. Need to identify a power user.", "demo3")],
           desc="100-seat UK consulting firm. 60 days post-onboarding and adoption is at 35% DAU. Risk of churn if we don't identify an internal champion quickly."),
        _c("Solaris Digital — Healthy", "Healthy", "EMEA", "low", None, 2, [],
           _chk("+Fully onboarded", "+85% seat utilization", "+Self-service"),
           desc="40-seat digital agency in healthy state. Self-sufficient — no CSM intervention needed. Utilization is strong at 85%."),
        _c("Atlas Logistics BV — Renewal", "Renewal", "EMEA", "urgent", 8, 6, ["Renewal Due", "Expansion Opportunity"],
           _chk("+Renewal proposal sent", "+Champion confirmed continuation", "Legal review in progress", "Close before end of month"),
           [_cmt("1-year renewal + 30-seat expansion. Champion is pushing hard internally. Legal review is the only remaining blocker.", "demo1"),
            _cmt("Need to close this month — affects Q1 revenue target.", "demo4")],
           desc="200-seat logistics company renewal due in 10 days. Champion wants to add 30 seats. Legal review is the only open item."),

        # APAC
        _c("Nexus Software — Onboarding", "Onboarding", "APAC", "medium", 21, 3, [],
           _chk("+Kickoff call done", "+Admin setup complete", "Board templates configured", "Technical training scheduled"),
           desc="50-seat Singapore software firm. Smooth onboarding — CTO is doing all admin setup personally, which is a great sign."),
        _c("Harbor Tech — Adoption", "Adoption", "APAC", "medium", None, 3, ["QBR Needed"],
           _chk("+Boards created", "Check feature adoption breadth", "Schedule QBR to review Analytics tab usage"),
           desc="80-seat Sydney firm 45 days post-onboarding. Board creation strong but advanced features (Analytics, History) underutilized. QBR to drive feature depth."),
        _c("Pacific Ventures — Healthy", "Healthy", "APAC", "low", None, 2, ["Champion"],
           _chk("+NPS score: 9", "+Champion: Head of Product"),
           desc="30-seat VC fund in healthy state. Head of Product is an NPS 9. Will ask for reference call next quarter."),
        _c("Koala Systems — Churned", "Churned", "APAC", "medium", -30, 4, ["At Risk"],
           _chk("+Exit interview completed", "+Churn reason logged: price", "+Feedback shared with product team"),
           [_cmt("Churned to a cheaper tool. Price was the stated reason but low adoption was the real issue. Logged feedback.", "demo2"),
            _cmt("Will re-engage in 12 months when contract with competitor expires.", "demo5")],
           desc="40-seat Melbourne firm churned at renewal. Low adoption (25% DAU) meant low perceived value. Price sensitivity was the stated objection."),

        # Enterprise Accounts
        _c("TechNova Inc — Healthy", "Healthy", "Enterprise Accounts", "low", None, 4, ["Champion"],
           _chk("+500 seats active", "+Executive sponsor confirmed", "+QBR completed Q1"),
           desc="500-seat enterprise account in healthy state. Executive sponsor is CTO. QBR completed with high satisfaction scores."),
        _c("BlueSky Health — Adoption", "Adoption", "Enterprise Accounts", "high", 14, 5, ["QBR Needed"],
           _chk("+Onboarding completed", "Drive adoption across clinical teams", "QBR with VP Operations", "Review HIPAA feature usage"),
           [_cmt("200 seats active but mostly in IT. Clinical teams haven't adopted yet. QBR with VP Ops next week.", "demo1")],
           desc="200-seat healthcare enterprise 60 days post-onboarding. IT adoption is strong but clinical team adoption is lagging. QBR scheduled."),
        _c("Global Freight Co — Expansion", "Expansion", "Enterprise Accounts", "high", 12, 6, ["Expansion Opportunity"],
           _chk("+Current: 300 seats at 97% utilization", "+Expansion proposal: 500 seats", "VP CS presenting to CFO", "Update commercial agreement"),
           [_cmt("Growing fast — they've added 3 new business units since signing. 500-seat expansion is justified by headcount alone.", "demo3")],
           desc="300-seat freight company at 97% seat utilization. Headcount growth of 3 new business units makes 500-seat expansion a natural next step."),
        _c("Pinnacle Finance — Renewal", "Renewal", "Enterprise Accounts", "urgent", 5, 7, ["Renewal Due", "Expansion Opportunity"],
           _chk("+3-year renewal proposal sent", "+Champion confirmed", "CFO review in progress", "SOC 2 report sent to procurement"),
           [_cmt("CFO wants a 3-year deal with locked pricing. Working with RevOps on multi-year discount model.", "demo2"),
            _cmt("SOC 2 Type II report sent — last open legal item resolved.", "demo4")],
           desc="400-seat financial services firm renewal. Proposing a 3-year deal. CFO is actively involved. SOC 2 compliance documentation provided."),

        # Mid-Market
        _c("Redwood Agency — Onboarding", "Onboarding", "Mid-Market", "medium", 14, 3, [],
           _chk("+Welcome email sent", "+Admin onboarding call done", "Team invites sent", "First board created"),
           desc="25-seat creative agency. Quick onboarding — CEO and two managers are the primary users. First board live."),
        _c("Ironside Manufacturing — Adoption", "Adoption", "Mid-Market", "medium", 21, 3, ["At Risk"],
           _chk("+Training done", "Identify a champion in ops team", "Check for support tickets", "Follow-up call in 1 week"),
           [_cmt("Low login rate 30 days after onboarding. No assigned champion. Needs proactive outreach.", "demo1")],
           desc="75-seat manufacturing company with low adoption 30 days post-onboarding. No clear champion identified yet. At-risk of churning at 90 days."),
        _c("Skyline Retail — Healthy", "Healthy", "Mid-Market", "low", None, 2, [],
           _chk("+60% DAU", "+Champion: Ops Manager", "+Last NPS: 8"),
           desc="50-seat retail company in healthy state. Ops Manager is an engaged power user. Consistent 60% DAU for 3+ months."),
        _c("Fusion Labs — Churned", "Churned", "Mid-Market", "medium", -45, 3, ["At Risk"],
           _chk("+Exit survey completed", "+Churn reason: consolidating to Notion", "+Feedback logged"),
           [_cmt("Consolidating their toolset to Notion. Not a price issue — they want a single tool for docs + boards. We don't have a docs offering.", "demo3")],
           desc="35-seat startup churned mid-term. Consolidating to Notion for combined docs and boards. Product feedback logged for roadmap consideration."),
    ],
}


# ── 4. Simple Kanban ──────────────────────────────────────────────────────────
SIMPLE_KANBAN = {
    "slug": "simple_kanban",
    "name": "Template: Simple Kanban",
    "description": "General-purpose kanban for any team. Each swimlane is a team or workstream; each card is a work item.",
    "columns": [
        {"name": "Backlog", "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "To Do",   "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Doing",   "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Review",  "position": 3, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Done",    "position": 4, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Frontend", "position": 0, "color": "#3B82F6", "contact_email": "", "notes": "React + TypeScript. Owns all UI components, pages, and the design system."},
        {"name": "Backend",  "position": 1, "color": "#8B5CF6", "contact_email": "", "notes": "Django + DRF. Owns API, data models, business logic, and background tasks."},
        {"name": "Mobile",   "position": 2, "color": "#EC4899", "contact_email": "", "notes": "React Native. iOS + Android. Syncs with main API."},
        {"name": "DevOps",   "position": 3, "color": "#14B8A6", "contact_email": "", "notes": "CI/CD, infrastructure, reliability, and monitoring."},
        {"name": "Design",   "position": 4, "color": "#F59E0B", "contact_email": "", "notes": "UX/UI design, design system, user research."},
    ],
    "labels": [
        {"name": "Bug",       "color": "#EF4444"},
        {"name": "Feature",   "color": "#3B82F6"},
        {"name": "Improve",   "color": "#10B981"},
        {"name": "Tech Debt", "color": "#9CA3AF"},
        {"name": "Blocked",   "color": "#F97316"},
    ],
    "extra_cards": [
        # Frontend extras (existing has ~4; add 4 more)
        _c("Accessible focus rings on all interactive elements", "To Do", "Frontend", "medium", 15, 2, ["Improve"],
           _chk("Audit all buttons and links", "Add focus-visible ring via Tailwind", "Test with keyboard navigation"),
           desc="Several interactive elements (dropdown items, modal close buttons) are missing visible focus rings. Fails WCAG 2.1 AA for keyboard users."),
        _c("Implement card search with debounce", "Doing", "Frontend", "high", 6, 3, ["Feature"],
           _chk("+Wire up search input to API", "+Debounce at 300ms", "Handle empty state", "Add loading indicator"),
           [_cmt("API endpoint is ready. Just need to wire up the frontend debounce and empty state.", "demo2")],
           desc="Card search input needs proper debouncing to avoid spamming the API on every keystroke. Backend endpoint is already live."),
        _c("Extract color token constants to design-system package", "Backlog", "Frontend", "low", 45, 2, ["Tech Debt"],
           _chk("Audit all hardcoded hex values in components", "Move to tokens.ts", "Update all import sites"),
           desc="Several components still use hardcoded hex color strings instead of importing from the design system token file. Low priority cleanup."),
        _c("Optimistic update for card weight field", "Review", "Frontend", "medium", 4, 3, ["Improve"],
           _chk("+Implement optimistic update on weight change", "+Rollback on API error", "Write test"),
           [_cmt("Weight field was the last field without optimistic update. Good to close this gap.", "demo1")],
           desc="The weight field on card detail was the last non-optimistic editable field. Change is now reflected immediately in the UI, with rollback on API error."),

        # Backend extras
        _c("Add cursor-based pagination to card list endpoint", "To Do", "Backend", "medium", 18, 4, ["Improve"],
           _chk("Implement cursor pagination in DRF", "Update API docs", "Add test for large result sets"),
           desc="The card list endpoint uses page-number pagination which breaks under concurrent mutations. Cursor-based pagination is required for stable infinite scroll."),
        _c("Rate limiting on public invite accept endpoint", "Backlog", "Backend", "high", 25, 3, ["Improve"],
           _chk("Add throttle class to invite accept view", "Set limit: 10/min per IP", "Return 429 with Retry-After"),
           desc="The public invite accept endpoint has no rate limiting, making it a vector for scraping valid invite tokens. Need throttle at 10 requests/min per IP."),
        _c("Bulk card archive endpoint", "Doing", "Backend", "medium", 8, 3, ["Feature"],
           _chk("+Design endpoint schema", "+Implement POST /cards/bulk-archive/", "Add permission check", "Write tests"),
           [_cmt("FR-077 from customer support. Endpoint design approved. Implementing now.", "demo3")],
           desc="New bulk archive endpoint: `POST /api/boards/{id}/cards/bulk-archive/` accepts a list of card IDs. Required by the bulk action toolbar feature."),
        _c("N+1 fix on /api/boards/ list endpoint", "Done", "Backend", "high", -5, 4, ["Improve"],
           _chk("+Profiled with django-debug-toolbar", "+Added select_related for owner and group", "+Reduced queries from 48 to 3", "+Performance test added"),
           [_cmt("Was doing 48 queries for a list of 20 boards. Now 3 queries. 200ms → 12ms on staging.", "demo1"),
            _cmt("Impressive improvement. Merging.", "demo4")],
           desc="Board list endpoint was issuing 48 SQL queries for 20 boards due to missing select_related on owner and group FKs. Reduced to 3 queries."),

        # Mobile extras
        _c("Card swipe gestures for quick archive", "Backlog", "Mobile", "low", 40, 3, ["Feature"],
           _chk("Design swipe gesture UX", "Implement left-swipe to archive", "Add undo toast"),
           desc="Power users on mobile want to quickly archive a card by swiping left, similar to email apps. Undo toast required."),
        _c("Fix card drag on iOS 17 with new UIKit scroll fix", "Doing", "Mobile", "high", 5, 5, ["Bug"],
           _chk("+Confirmed bug on iOS 17.4", "Test React Native gesture handler v2.16", "Check dnd-kit mobile branch"),
           [_cmt("iOS 17.4 changed how UIScrollView interacts with custom gesture recognizers. React Native Gesture Handler 2.16 has a fix.", "demo2")],
           desc="Card drag-and-drop is broken on iOS 17.4 — the card lifts but immediately drops to its original position. Confirmed React Native Gesture Handler regression."),
        _c("Push notification for card assignment", "Review", "Mobile", "medium", 7, 4, ["Feature"],
           _chk("+APNs integration complete", "+FCM integration complete", "+Notification payload implemented", "End-to-end test on device"),
           [_cmt("Both APNs and FCM are wired up. Just need a real-device E2E test before merging.", "demo3")],
           desc="Push notifications for card assignment events. APNs (iOS) and FCM (Android) both integrated. Awaiting final E2E device test."),
        _c("Offline mode: queue moves while disconnected", "Doing", "Mobile", "high", 10, 6, ["Feature"],
           _chk("+Design offline queue schema", "+Persist to AsyncStorage", "Sync on reconnect with conflict detection", "Handle stale-move error"),
           [_cmt("Storage layer done. The tricky part is handling the 409 conflict case when a card was moved by someone else while offline.", "demo1")],
           desc="Mobile users on patchy networks need to queue card moves locally and sync when connectivity is restored. Conflict detection on sync is the main challenge."),

        # DevOps extras
        _c("Rotate CI/CD secrets — 90-day policy", "To Do", "DevOps", "medium", 12, 2, ["Improve"],
           _chk("Audit all secrets in GitLab CI variables", "Rotate AWS keys and update CI", "Rotate DB credentials", "Update runbook"),
           desc="90-day secret rotation is due. All CI/CD secrets (AWS access keys, DB credentials, S3 keys) need rotation per security policy."),
        _c("Add Prometheus metrics to API gateway", "Backlog", "DevOps", "medium", 30, 4, ["Feature"],
           _chk("Define SLI metrics (p50, p95, p99 latency)", "Add prometheus_client to Django", "Configure scrape in Prometheus", "Build Grafana dashboard"),
           desc="API gateway latency and error rate metrics are currently only visible in CloudWatch. Need Prometheus-compatible metrics endpoint for unified observability."),
        _c("Kubernetes pod autoscaling HPA tuning", "Doing", "DevOps", "high", 5, 5, ["Improve"],
           _chk("+Analyze CPU/memory usage patterns over 30 days", "+Set HPA minReplicas=2, maxReplicas=10", "Load test with k6", "Deploy to production"),
           [_cmt("Current HPA is scaling too aggressively — pods spinning up on minor traffic spikes. Tuning CPU threshold from 50% to 70%.", "demo2")],
           desc="Kubernetes HPA is over-scaling on minor traffic spikes, increasing costs. Tuning CPU utilization threshold and smoothing window based on 30-day usage analysis."),
        _c("Zero-downtime deployment runbook", "Done", "DevOps", "medium", -10, 3, ["Improve"],
           _chk("+Documented blue-green deployment steps", "+Added health check verification step", "+Reviewed by backend team", "+Committed to ops runbook repo"),
           [_cmt("Runbook covers blue-green deploy, DB migration safety, and rollback procedure. Reviewed and approved.", "demo4")],
           desc="Zero-downtime deployment runbook written and reviewed. Covers blue-green deployment, pre-deploy DB migration check, and rollback procedure."),

        # Design extras
        _c("Component audit — identify inconsistent spacing", "Backlog", "Design", "low", 35, 2, ["Improve"],
           _chk("Audit all components in Figma", "Document spacing violations", "Propose standard 4/8/16/24px grid"),
           desc="Spacing across components is inconsistent — some use 6px gaps, others 8px, others 12px. Audit needed to propose a consistent 4px baseline grid."),
        _c("Redesign empty state illustrations", "To Do", "Design", "medium", 20, 3, ["Improve"],
           _chk("Define 5 empty state scenarios", "Sketch illustration concepts", "Get team feedback", "Export to design system"),
           desc="Current empty states use generic text only. Replacing with lightweight illustrations will improve first-time user experience and onboarding perception."),
        _c("User research: onboarding friction study", "Review", "Design", "high", 8, 4, ["Improve"],
           _chk("+Recruited 8 participants", "+Ran 6 moderated sessions", "+Synthesized findings", "Present to product team"),
           [_cmt("Key finding: 4 of 6 participants didn't discover swimlanes until prompted. Onboarding needs a swimlane-first framing.", "demo2"),
            _cmt("Also found that the 'Add column' button is frequently missed. Need stronger visual hierarchy.", "demo1")],
           desc="Moderated usability sessions with 6 new users. Key findings: swimlane discovery is poor, and the add-column affordance is missed. Presenting recommendations to product."),
        _c("Dark mode color system — token audit", "Done", "Design", "medium", -7, 3, ["Improve"],
           _chk("+Audited all 140 color tokens", "+Removed 23 duplicate tokens", "+Published updated token set", "+Dev handoff complete"),
           [_cmt("Token count down from 140 to 117. All slate variants now consistent. Figma tokens plugin synced.", "demo3")],
           desc="Full audit of dark mode color tokens. Removed 23 redundant tokens, standardized all slate variants, and published the updated token set to the design system."),
    ],
}


# ── 5. Product Roadmap ────────────────────────────────────────────────────────
PRODUCT_ROADMAP = {
    "slug": "product_roadmap",
    "name": "Template: Product Roadmap",
    "description": "Track features from idea through launch and monitoring. Each swimlane is a product area; each card is a feature or initiative.",
    "columns": [
        {"name": "Idea",       "position": 0, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Validated",  "position": 1, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Scoped",     "position": 2, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Prioritized","position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "In Build",   "position": 4, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Beta",       "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
        {"name": "Launched",   "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Monitoring", "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Mobile App",            "position": 0, "color": "#EC4899", "contact_email": "", "notes": "iOS and Android. Targets field workers and on-the-go board access."},
        {"name": "Core Platform",         "position": 1, "color": "#3B82F6", "contact_email": "", "notes": "Web app, API, and shared infrastructure features."},
        {"name": "Integrations",          "position": 2, "color": "#10B981", "contact_email": "", "notes": "Third-party integrations: Slack, GitHub, Jira, Zapier, webhooks."},
        {"name": "Analytics",             "position": 3, "color": "#F59E0B", "contact_email": "", "notes": "Board analytics, cycle time, throughput, and reporting features."},
        {"name": "Compliance & Security", "position": 4, "color": "#8B5CF6", "contact_email": "", "notes": "GDPR, SOC 2, audit logging, and security hardening features."},
    ],
    "labels": [
        {"name": "Core",       "color": "#3B82F6"},
        {"name": "Platform",   "color": "#8B5CF6"},
        {"name": "UX",         "color": "#EC4899"},
        {"name": "Compliance", "color": "#F97316"},
        {"name": "AI / ML",    "color": "#10B981"},
    ],
    "extra_cards": [
        # Mobile App
        _c("Offline-first card editing", "Idea", "Mobile App", "high", 45, 5, ["Core"],
           _chk("User research: how often users lose work on flaky networks", "Feasibility spike: conflict resolution strategy"),
           desc="Cards edited while offline should be queued locally and synced on reconnect. Conflict resolution strategy needs design."),
        _c("Apple Watch complication — card due dates", "Validated", "Mobile App", "low", 60, 2, ["UX"],
           _chk("+Validated with 5 user interviews", "+watchOS feasibility confirmed", "Scope design for complication"),
           desc="5 power users requested glanceable due-date reminders on Apple Watch. Technically feasible via watchOS complication. Low priority but high delight."),
        _c("Barcode scanner for card attachment", "Scoped", "Mobile App", "medium", 30, 3, ["Core"],
           _chk("+Scope document written", "+API upload endpoint confirmed compatible", "UX mockup for scan-to-attach flow"),
           desc="Field workers want to scan a barcode (asset ID, serial number) and attach it to a card. Scoped to use device camera via React Native Vision Camera."),
        _c("Push notification preferences", "Launched", "Mobile App", "medium", -10, 4, ["UX"],
           _chk("+APNs/FCM integrated", "+Per-notification-type preferences UI built", "+Launched to all mobile users"),
           [_cmt("Notification preferences are live. DAU increase of 8% week-over-week since launch.", "demo1")],
           desc="Per-type push notification preferences (card assigned, mentioned, due soon). Launched with APNs and FCM support."),

        # Core Platform
        _c("AI card description generator", "Idea", "Core Platform", "medium", 50, 4, ["AI / ML"],
           _chk("Define prompt engineering approach", "Prototype with Claude API", "Estimate cost per generation"),
           desc="Use AI to generate a card description from a short title. Early prototype with Claude API looks promising — cost per generation is negligible."),
        _c("Card templates library", "Scoped", "Core Platform", "high", 25, 5, ["Core", "UX"],
           _chk("+Defined template schema", "+5 built-in templates designed", "Backend endpoint for template CRUD", "Frontend picker UI"),
           desc="Allow users to save a card as a template (pre-filled title, description, checklist, labels) and apply it when creating new cards."),
        _c("Multi-board card linking", "In Build", "Core Platform", "high", 14, 7, ["Core"],
           _chk("+DB schema: CardLink model added", "+API endpoints implemented", "Frontend: link picker in card detail", "Test cross-board reference UI"),
           [_cmt("Backend done. Frontend picker is the remaining work — targeting completion next sprint.", "demo2")],
           desc="Allow a card to link to one or more cards on other boards. Backend schema and API are done; frontend link picker UI is in progress."),
        _c("Board activity feed", "Monitoring", "Core Platform", "medium", -15, 4, ["Core"],
           _chk("+Launched to all users", "+Monitoring p95 latency (<80ms)", "+No rollback events in 7 days"),
           [_cmt("Activity feed launched 2 weeks ago. p95 latency stable at 65ms. No issues.", "demo3")],
           desc="Real-time board activity feed showing all card changes, movements, and comments in chronological order. Launched and stable."),

        # Integrations
        _c("Slack /visiban command", "Validated", "Integrations", "medium", 35, 4, ["Platform"],
           _chk("+10 customers interviewed", "+Slack Slash Command API reviewed", "Define command schema (/visiban add <title> <board>)"),
           [_cmt("Strong demand from 10 surveyed customers. They want to create cards from Slack without context-switching.", "demo1")],
           desc="Slack Slash Command `/visiban add` to create a card on a specified board from any Slack channel. Strong customer demand validated."),
        _c("GitHub PR → card status sync", "In Build", "Integrations", "high", 10, 6, ["Platform"],
           _chk("+Webhook receiver implemented", "+PR open → 'In Review' column mapping logic done", "Frontend: connect board to GitHub repo", "Test with real repo"),
           [_cmt("The webhook receiver is solid. The tricky part is letting admins map GitHub PR states to board columns — building the mapping UI now.", "demo2")],
           desc="Bidirectional sync: opening a GitHub PR linked to a card auto-moves it to the mapped column. Column mapping is configurable per board."),
        _c("Zapier integration — GA", "Launched", "Integrations", "medium", -20, 5, ["Platform"],
           _chk("+100 Zap templates published", "+GA launch announcement sent", "+Monitoring error rate"),
           [_cmt("Zapier integration is live. 340 active Zaps in first week. Error rate <0.1%.", "demo4")],
           desc="General availability of the Zapier integration with 100 published Zap templates. 340 active Zaps in the first week. Error rate well below SLA."),
        _c("CSV import with column mapping UI", "Monitoring", "Integrations", "medium", -30, 4, ["Platform"],
           _chk("+Column mapping UI shipped", "+Launched to all accounts", "+Monitoring import error rate"),
           [_cmt("Import error rate down to 0.3% after the mapping UI launch. Customers report significantly easier imports.", "demo1")],
           desc="CSV import with an interactive column-mapping step that lets users drag-and-drop CSV columns to card fields. Error rate dropped from 8% to 0.3%."),

        # Analytics
        _c("Cumulative flow diagram", "Idea", "Analytics", "medium", 50, 4, ["Platform"],
           _chk("Validate with 3 scrum master interviews", "Research D3.js vs Recharts for CFD"),
           desc="A cumulative flow diagram showing card counts per column over time. Popular request from engineering teams running sprints."),
        _c("Cycle time histogram", "Prioritized", "Analytics", "high", 20, 5, ["Platform"],
           _chk("+Validated with 8 users", "+Scoped: median and 85th percentile lines", "Backend: cycle time query", "Frontend: Recharts histogram"),
           [_cmt("Prioritized for Q2. Users want cycle time broken down by label and swimlane. Scoping that as v1.1.", "demo2")],
           desc="Histogram of card cycle times (first move to last move). Includes median and 85th percentile lines. Breakdowns by label and swimlane planned for v1.1."),
        _c("Throughput report — weekly/monthly", "In Build", "Analytics", "medium", 8, 4, ["Platform"],
           _chk("+Backend aggregate query implemented", "+Export to CSV working", "Build chart UI (bar chart)", "Add period filter"),
           [_cmt("Query is fast even for boards with 1000+ card movements. Chart UI is next.", "demo3")],
           desc="Weekly and monthly throughput report: cards completed per time period. Exportable as CSV. Chart UI in progress."),
        _c("Analytics API — public endpoints", "Monitoring", "Analytics", "medium", -12, 5, ["Platform"],
           _chk("+GET /api/boards/{id}/analytics/ launched", "+Docs published", "+Rate limiting applied"),
           [_cmt("Analytics API live for 2 weeks. Being used by 3 enterprise customers already. No issues.", "demo4")],
           desc="Public API endpoints for analytics data: cycle time, throughput, WIP snapshots. Rate limited at 100 req/min per board. Docs published."),

        # Compliance & Security
        _c("GDPR right-to-erasure automation", "Scoped", "Compliance & Security", "urgent", 20, 7, ["Compliance"],
           _chk("+Legal requirements mapped to data model", "+Erasure scope defined (cards, comments, activities)", "Implement erasure task", "Test with synthetic data"),
           desc="Automate the right-to-erasure workflow: when a user requests deletion, anonymize or delete all their PII across cards, comments, and activity records."),
        _c("SOC 2 Type II — audit logging", "In Build", "Compliance & Security", "high", 12, 6, ["Compliance"],
           _chk("+Audit log model designed", "+Admin, board admin, and member events captured", "Admin UI for audit log export", "Legal review of log schema"),
           [_cmt("Log capture is complete. Building the export UI now — legal wants to review the schema before we ship.", "demo1")],
           desc="SOC 2 Type II compliance requires immutable audit logs of admin and board-level actions. Log capture is complete; admin export UI in progress."),
        _c("Mandatory 2FA for site admins", "Beta", "Compliance & Security", "high", 5, 4, ["Compliance"],
           _chk("+Enforcement middleware added", "+Beta with 3 enterprise accounts", "Resolve edge case: SSO + 2FA", "GA launch"),
           [_cmt("SSO users are excluded from enforcement for now — need to design the SSO+2FA flow first.", "demo2"),
            _cmt("3 beta accounts all confirmed working. One edge case: recovery codes not emailed on first setup.", "demo3")],
           desc="Site admins are required to enable 2FA. In beta with 3 enterprise accounts. SSO+2FA interaction needs design before GA."),
        _c("Content Security Policy headers", "Monitoring", "Compliance & Security", "medium", -8, 3, ["Compliance"],
           _chk("+CSP headers deployed in report-only mode", "+Violations monitored for 14 days", "+Tightened to enforcement mode", "+Zero violations in 7 days"),
           [_cmt("CSP in enforcement mode for 7 days with zero violations. Closing this item.", "demo4")],
           desc="Content Security Policy headers deployed in report-only mode, violations monitored for 2 weeks, then tightened to enforcement. Zero violations in 7 days."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 2 — loaded from generate_seed_data_part2.py
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
        print(f"  ✓  {slug}.json  ({len(data['cards'])} cards)")

    print(f"\nDone — {len(ALL_TEMPLATES)} templates regenerated.")


if __name__ == "__main__":
    main()
