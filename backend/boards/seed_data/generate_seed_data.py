"""
Generate the 11 sample board templates and the gallery manifest with:
  - JSON + manifest.json in backend/boards/sample_boards/ (shipped in the backend image)
  - CSV in sample-boards/ (repo-only)
  - 110-130 cards per template (46 hand-written ones on Sales Overlay)
  - Varied movement histories: stage skipping, backtracks with notes, archives
  - A full audit trail per card: every activity type the format carries
  - Card and swimlane custom fields, WIP/weight limits and MR links
    (the 1.2 feature layer in sample_features.py, #1447)
  - schema_version: 2

Templates 1-5 live here, 6-10 in generate_seed_data_part2.py, the Sales
Overlay sample in sales_overlay.py. Output is deterministic: rerunning with
no source change rewrites identical files.

Usage (from repo root):
    python3 backend/boards/seed_data/generate_seed_data.py

No Django or database connection required.
"""

import csv
import hashlib
import json
import os
import random
import re
import zlib
from datetime import datetime, timedelta, timezone

# ── Constants ────────────────────────────────────────────────────────────────
ANCHOR = datetime(2026, 3, 15, 12, 0, 0, tzinfo=timezone.utc)
DEMO_USERS = ["demo1", "demo2", "demo3", "demo4", "demo5"]
SCHEMA_VERSION = 2

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


# ── Per-card RNG ──────────────────────────────────────────────────────────────
def _card_rng(slug: str, title: str) -> random.Random:
    """A generator private to one card.

    The 1.2 history and field layers draw from this rather than the shared
    ``_rng``, so they can grow without reshuffling any template's columns,
    labels or movements.
    """
    return random.Random(zlib.crc32(f"{slug}|{title}".encode()))


def _parse(ts: str) -> datetime:
    return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S+00:00").replace(tzinfo=timezone.utc)


_LOST_RX = re.compile(r"lost|rejected|denied|churned", re.IGNORECASE)

# Notes a mover leaves on a transition. Backtracks always carry one, since
# "why did this go backwards?" is the question the audit trail exists for.
_BACKTRACK_NOTES = [
    "Sent back: acceptance criteria were not met.",
    "Reopened after review found a gap.",
    "Moved back while we wait on missing information.",
    "Returned for rework after stakeholder feedback.",
]
_FORWARD_NOTES = [
    "Handed off with notes in the description.",
    "Reviewed in standup; moving ahead.",
    "Unblocked after the dependency landed.",
    "Approved by the owner.",
]


def _annotate_movements(movements: list[dict], col_names: list[str],
                        rng: random.Random) -> None:
    """Add ``movement_type`` to every move and ``notes`` to some (schema v2 keys)."""
    for i, mv in enumerate(movements):
        mv["notes"] = ""
        mv["movement_type"] = "move"
        if i == 0:
            continue
        if col_names.index(mv["to_column"]) < col_names.index(mv["from_column"]):
            mv["notes"] = rng.choice(_BACKTRACK_NOTES)
        elif rng.random() < 0.25:
            mv["notes"] = rng.choice(_FORWARD_NOTES)


# ── Activity generation ───────────────────────────────────────────────────────
def _gen_activities(card: dict, movements: list[dict], rng: random.Random,
                    label_pool: list[str]) -> list[dict]:
    """Generate the card's audit trail: one entry for every change it went through.

    Covers every ``CardActivity`` event type the JSON format can carry except
    attachments (the format has no attachment payload, so an
    ``attachment_added`` entry would point at a file that is not there). Values
    use the shapes the live API writes — labels as ``"+A, B"`` / ``"-C"``,
    dates ISO, users by username — so the activity tab reads the same as on a
    board that was used by hand.

    Comments get their ``created_at`` here too, matching their
    ``comment_added`` entry, so the comment list and the activity log agree.
    """
    created = _parse(movements[0]["moved_at"])
    last = _parse(movements[-1]["moved_at"])
    end = max(last, created + timedelta(days=3))
    if end >= ANCHOR:
        end = ANCHOR - timedelta(hours=1)
    span = max(1.0, (end - created).total_seconds())
    actor = movements[0]["moved_by"]
    others = [u for u in DEMO_USERS if u != actor]

    events = []  # (offset fraction, event dict)

    def add(frac, event_type, from_value, to_value, who=None):
        events.append((frac, {
            "event_type": event_type, "from_value": from_value, "to_value": to_value,
            "actor": who or actor,
        }))

    title = card["title"]
    if rng.random() < 0.15:
        draft = title.split(" -- ")[0] if " -- " in title else f"{title} (draft)"
        if draft != title:
            add(0.02, "title_change", draft, title)

    if card.get("description"):
        add(0.04, "description_change", "", "")
        if rng.random() < 0.3:
            add(0.45, "description_change", "", "", rng.choice(others))

    assignee = card.get("assignee")
    if assignee:
        if rng.random() < 0.25:
            first = rng.choice([u for u in DEMO_USERS if u != assignee])
            add(0.05, "assignee_change", "", first)
            add(0.5, "assignee_change", first, assignee, rng.choice(others))
        else:
            add(0.05, "assignee_change", "", assignee)

    labels = card.get("labels", [])
    if labels:
        add(0.08, "label_change", "", f"+{', '.join(labels)}")
    spare = [lb for lb in label_pool if lb not in labels]
    if spare and rng.random() < 0.2:
        temp = rng.choice(spare)
        add(0.2, "label_change", "", f"+{temp}", rng.choice(others))
        add(0.6, "label_change", "", f"-{temp}")

    priority = card.get("priority", "medium")
    if priority == "urgent" and rng.random() < 0.5:
        add(0.1, "priority_change", "medium", "high")
        add(0.55, "priority_change", "high", "urgent", rng.choice(others))
    elif priority not in ("medium", None, ""):
        add(0.1, "priority_change", "medium", priority)

    weight = card.get("weight") or 1
    if weight > 1:
        add(0.12, "weight_change", "1", str(weight))

    due = card.get("due_date")
    if due:
        if rng.random() < 0.25:
            earlier = (datetime.strptime(due, "%Y-%m-%d") - timedelta(days=rng.randint(5, 20))).strftime("%Y-%m-%d")
            add(0.15, "due_date_change", "", earlier)
            add(0.7, "due_date_change", earlier, due, rng.choice(others))
        else:
            add(0.15, "due_date_change", "", due)

    checklist = card.get("checklist", [])
    for i, item in enumerate(checklist):
        add(0.18 + i * 0.02, "checklist_item_added", "", item["text"])
        if item.get("is_checked"):
            add(0.3 + i * 0.08, "checklist_item_checked", "", item["text"], rng.choice(DEMO_USERS))
        elif rng.random() < 0.2:
            # Ticked by mistake, then unticked: the log keeps both.
            add(0.3 + i * 0.08, "checklist_item_checked", "", item["text"])
            add(0.32 + i * 0.08, "checklist_item_unchecked", "", item["text"])
    if checklist and rng.random() < 0.2:
        add(0.25, "checklist_item_added", "", "Duplicate of an existing step")
        add(0.27, "checklist_item_deleted", "Duplicate of an existing step", "")

    comments = card.get("comments", [])
    for i, comment in enumerate(comments):
        frac = 0.35 + 0.6 * (i + 1) / (len(comments) + 1)
        ts = created + timedelta(seconds=span * frac)
        comment["created_at"] = _iso(ts)
        events.append((frac, {
            "event_type": "comment_added", "from_value": "",
            "to_value": comment["body"][:120], "actor": comment.get("author") or actor,
        }))

    events.sort(key=lambda e: e[0])
    acts = []
    for frac, ev in events:
        ev["created_at"] = _iso(created + timedelta(seconds=span * frac))
        acts.append(ev)
    return acts


# ── 1.2 feature layer (custom fields, row fields, MR links, archive) ─────────
def _definition(spec: dict, pin_key: str) -> dict:
    """Export-shaped definition dict, identical keys to the board exporter."""
    display = spec.get("display", {})
    out = {
        "name": spec["name"],
        "field_type": spec["field_type"],
        "choices": spec["choices"],
        "position": 0,
        pin_key: spec[pin_key],
    }
    if pin_key == "show_on_row":
        out["is_admin_only"] = spec["is_admin_only"]
    out.update({
        "is_required": False,
        "help_text": spec["help_text"],
        "number_prefix": display.get("number_prefix", ""),
        "number_suffix": display.get("number_suffix", ""),
        "number_decimals": display.get("number_decimals"),
        "choice_colors": display.get("choice_colors", {}),
    })
    return out


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _apply_features(data: dict, features: dict, slug: str) -> None:
    """Attach the template's 1.2 features to an already-built board dict."""
    columns = data["columns"]
    col_index = {c["name"]: i for i, c in enumerate(columns)}
    done_cols = {c["name"] for c in columns if c.get("is_done")}
    last_open = max([i for i, c in enumerate(columns) if not c.get("is_done")] or [1])

    card_specs = features.get("card_fields", [])
    lane_specs = features.get("swimlane_fields", [])
    data["custom_fields"] = []
    for i, spec in enumerate(card_specs):
        definition = _definition(spec, "show_on_card")
        definition["position"] = i
        data["custom_fields"].append(definition)
    data["swimlane_custom_fields"] = []
    for i, spec in enumerate(lane_specs):
        definition = _definition(spec, "show_on_row")
        definition["position"] = i
        data["swimlane_custom_fields"].append(definition)

    for i, lane in enumerate(data["swimlanes"]):
        lctx = {"index": i, "name": lane["name"], "slug_name": _slugify(lane["name"]),
                "rng": _card_rng(slug, f"lane:{lane['name']}")}
        values = {}
        for spec in lane_specs:
            value = spec["gen"](lctx)
            if value not in (None, ""):
                values[spec["name"]] = value
        # Hand-written values (the overlay board) win over generated ones.
        values.update(lane.get("custom_field_values", {}))
        # Rebuilt in the board exporter's key order. contact_email is left
        # empty on purpose: the row header prints it under the lane name, and
        # a placeholder team address says nothing about the lane, while the
        # pinned row fields below it do. It stays as a key because an admin
        # export always writes it.
        data["swimlanes"][i] = {
            "name": lane["name"], "position": lane["position"], "color": lane["color"],
            "contact_email": "", "notes": lane.get("notes", ""),
            "custom_field_values": values,
        }

    refs = features.get("external_refs")
    for seq, card in enumerate(data["cards"]):
        rng = _card_rng(slug, "fields:" + card["title"])
        idx = col_index[card["column"]]
        is_done = card["column"] in done_cols
        ctx = {
            "card": card, "rng": rng, "seq": 1000 + seq,
            "is_done": is_done, "lost": bool(_LOST_RX.search(card["column"])),
            "progress": 1.0 if is_done else idx / max(1, last_open),
        }
        values = {}
        for spec in card_specs:
            value = spec["gen"](ctx)
            if value not in (None, ""):
                values[spec["name"]] = value
        values.update(card.pop("custom_field_values", None) or {})
        card["custom_field_values"] = values

        if card.get("external_ref") is None:
            card["external_ref"] = None
            if refs and ctx["progress"] >= refs["from_progress"] and rng.random() < 0.6:
                n = 200 + seq
                card["external_ref"] = {
                    "provider": refs["provider"],
                    "ref": refs["ref"].format(n=n),
                    "url": refs["url"].format(n=n),
                }


def _set_column_limits(data: dict, limits: dict) -> None:
    """Set WIP / weight limits relative to each column's live load (see sample_features)."""
    live = [c for c in data["cards"] if not c.get("archived_at")]
    for col in data["columns"]:
        if col["name"] not in limits:
            continue
        wip_headroom, weight_headroom = limits[col["name"]]
        here = [c for c in live if c["column"] == col["name"]]
        if wip_headroom is not None:
            col["wip_limit"] = max(1, len(here) + wip_headroom)
        if weight_headroom is not None:
            col["weight_limit"] = max(1, sum(c["weight"] or 1 for c in here) + weight_headroom)


def _archive_some(cards: list[dict], done_cols: set[str], slug: str) -> None:
    """Archive a share of finished cards, the way a team clears its Done column.

    Writes both halves the importer restores: ``archived_at`` on the card and
    an ``archived`` movement (same column, so the card still ends where it
    sits) in its history.
    """
    for card in cards:
        if card["column"] not in done_cols:
            continue
        rng = _card_rng(slug, "archive:" + card["title"])
        if rng.random() >= 0.25:
            continue
        last = _parse(card["movements"][-1]["moved_at"])
        at = min(last + timedelta(days=rng.randint(2, 9)), ANCHOR - timedelta(hours=3))
        card["archived_at"] = _iso(at)
        card["movements"].append({
            "from_column": card["column"], "to_column": card["column"],
            "from_swimlane": card["swimlane"], "to_swimlane": card["swimlane"],
            "moved_at": _iso(at), "moved_by": card["movements"][-1]["moved_by"],
            "notes": "Archived after the weekly board cleanup.",
            "movement_type": "archived",
        })


# ── Card enrichment ───────────────────────────────────────────────────────────
def _enrich(card: dict, col_names: list[str], card_seed: int, slug: str,
            label_pool: list[str], descriptions: list[str]) -> dict:
    """Attach movements, activities, and assignee to a card dict."""
    target_idx = col_names.index(card["column"])
    swimlane = card["swimlane"]
    rng = _card_rng(slug, card["title"])

    # Most generated cards are title-only; give about half a description so
    # boards show both shapes (and description edits show in the history).
    if not card.get("description") and descriptions and rng.random() < 0.5:
        card["description"] = rng.choice(descriptions).format(lane=swimlane)

    # 80 % of cards have an assignee; every 5th card is unassigned. A card
    # that names its assignee (hand-written templates) keeps it.
    if "assignee" not in card:
        card["assignee"] = _user(card_seed) if card_seed % 5 != 4 else None

    movs = _gen_movements(col_names, target_idx, swimlane, card_seed)
    _annotate_movements(movs, col_names, rng)
    card["movements"] = movs
    card["created_by"] = movs[0]["moved_by"]
    card["created_at"] = movs[0]["moved_at"]
    card["activities"] = _gen_activities(card, movs, rng, label_pool)
    return card


# ── Template expander ─────────────────────────────────────────────────────────
def _build(tpl: dict, features: dict | None = None) -> dict:
    """
    Build the final template dict from the cards defined in extra_cards.
    All card content is authoritative from the template definition -- the
    script is idempotent and safe to run multiple times.
    """
    slug = tpl["slug"]
    col_names = [c["name"] for c in tpl["columns"]]
    label_pool = [lb["name"] for lb in tpl["labels"]]

    all_cards = tpl.get("extra_cards", [])

    descriptions = (features or {}).get("descriptions", [])
    enriched = []
    for i, card in enumerate(all_cards):
        enriched.append(_enrich(dict(card), col_names, i * 7 + zlib.crc32(slug.encode()) % 100,
                                slug, label_pool, descriptions))

    data = {
        "schema_version": SCHEMA_VERSION,
        "name": tpl["name"],
        "description": tpl["description"],
        "columns": [dict(c) for c in tpl["columns"]],
        "swimlanes": [dict(s) for s in tpl["swimlanes"]],
        "labels": tpl["labels"],
        "cards": enriched,
    }
    for col in data["columns"]:
        col.setdefault("is_done", False)
        col.setdefault("weight_limit", None)
    _apply_features(data, features or {}, slug)
    _archive_some(enriched, {c["name"] for c in data["columns"] if c["is_done"]}, slug)
    _set_column_limits(data, (features or {}).get("column_limits", {}))
    # Key order matches the board exporter, so a sample diffs cleanly
    # against an export of the board it produces.
    order = ["schema_version", "name", "description", "columns", "swimlanes",
             "labels", "custom_fields", "swimlane_custom_fields", "cards"]
    return {k: data[k] for k in order}


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
    stage_rules: list[tuple[str, list[tuple[str, float]]]] | None = None,
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
        stage_rules: Optional ordered (regex, [(column, weight), ...]) pairs for
            templates whose titles name a stage (e.g. "Churned: ..." or
            "Phone screen -- ..."). The first regex that matches a title decides
            its column, so a card never contradicts the column it sits in.
            Titles with no match fall back to the weighted random pick.

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

    compiled_rules = [(re.compile(rx, re.IGNORECASE), opts) for rx, opts in (stage_rules or [])]

    cards = []
    for idx, title in enumerate(titles):
        # Round-robin swimlane assignment
        lane = lane_names[idx % len(lane_names)]

        # Weighted column selection. Always drawn, even when a stage rule
        # overrides it, so the shared RNG stream (and therefore every other
        # template's output) is unchanged by adding rules to one template.
        col = _rng.choices(col_names, weights=col_weights, k=1)[0]

        # Title-derived column. Uses its own RNG keyed on the title so a
        # split rule (e.g. offer -> Offer Extended or Hired) is stable.
        for rx, opts in compiled_rules:
            if rx.search(title):
                names = [n for n, _ in opts]
                assert all(n in col_names for n in names), (title, names)
                pick = random.Random(zlib.crc32(title.encode()))
                col = pick.choices(names, weights=[w for _, w in opts], k=1)[0]
                break

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
    {"name": "North America",   "position": 0,  "color": "#3B82F6", "notes": "Primary market. Enterprise and Mid-Market focus. Q2 pipeline target: $2.4M ARR."},
    {"name": "APAC",            "position": 1,  "color": "#F59E0B", "notes": "Partner-led motion in several subregions. Retail and ops-heavy accounts. Longer procurement cycles."},
    {"name": "EMEA",            "position": 2,  "color": "#8B5CF6", "notes": "Fintech and compliance-heavy accounts dominant. GDPR and DPA required on most enterprise deals."},
    {"name": "LATAM",           "position": 3,  "color": "#10B981", "notes": "Healthcare and government verticals. Longer sales cycles. HIPAA-equivalent local data regulations."},
    {"name": "ANZ",             "position": 4,  "color": "#EC4899", "notes": "SMB and creative agency accounts. Fast decision cycles -- typically days, not weeks."},
    {"name": "UK & Ireland",    "position": 5,  "color": "#14B8A6", "notes": "Financial services and professional services verticals. GDPR applies. Q2 target: 420k GBP."},
    {"name": "DACH",            "position": 6,  "color": "#6366F1", "notes": "Germany, Austria, Switzerland. Manufacturing and engineering firms. German-language demos available."},
    {"name": "Nordics",         "position": 7,  "color": "#0EA5E9", "notes": "Sweden, Norway, Denmark, Finland. Tech-forward accounts. Short procurement cycles."},
    {"name": "Middle East",     "position": 8,  "color": "#F43F5E", "notes": "UAE, Saudi Arabia, Qatar. Large enterprise and government. Data residency requirements common."},
    {"name": "Southeast Asia",  "position": 9,  "color": "#A855F7", "notes": "Singapore, Indonesia, Philippines, Thailand. Mix of tech startups and traditional enterprises."},
    {"name": "Japan & Korea",   "position": 10, "color": "#EAB308", "notes": "Large enterprise accounts. Localization required. Partner-led sales motion."},
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
    {"name": "TechNova Inc",          "position": 0,  "color": "#3B82F6", "notes": "Enterprise tier. SLA: 4-hour response, 24-hour resolution for P1."},
    {"name": "Apex Retail Group",     "position": 1,  "color": "#F59E0B", "notes": "Mid-market. SLA: 8-hour response. Contact: IT Manager."},
    {"name": "FinEdge Ltd",           "position": 2,  "color": "#8B5CF6", "notes": "Compliance-sensitive. All support comms may be audited. Use formal language."},
    {"name": "BlueSky Health",        "position": 3,  "color": "#10B981", "notes": "HIPAA environment. Do not share PHI in support threads. Escalate data questions to legal."},
    {"name": "Mosaic Creative",       "position": 4,  "color": "#EC4899", "notes": "SMB tier. Self-serve. Generally quick to resolve -- low SLA pressure."},
    {"name": "Global Freight Co",     "position": 5,  "color": "#14B8A6", "notes": "Enterprise tier. 300 seats. Logistics-heavy workflows. SLA: 4-hour response."},
    {"name": "Pinnacle Finance",      "position": 6,  "color": "#6366F1", "notes": "Financial services. SOC 2 environment. Audit trail exports are critical."},
    {"name": "Redwood Agency",        "position": 7,  "color": "#0EA5E9", "notes": "SMB creative agency. 25 seats. Fast response expected but no formal SLA."},
    {"name": "Atlas Logistics BV",    "position": 8,  "color": "#F43F5E", "notes": "EMEA mid-market. 200 seats. GDPR-sensitive. Dutch business hours only."},
    {"name": "Vertex Media",          "position": 9,  "color": "#A855F7", "notes": "Growing account. 75 seats approaching 150. High feature request volume."},
    {"name": "Ironside Manufacturing","position": 10, "color": "#EAB308", "notes": "Manufacturing. Shop floor workers with limited tech literacy. Extra patience needed."},
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
    {"name": "Americas",            "position": 0,  "color": "#3B82F6", "notes": "US + Canada + LATAM accounts. CSM: Alex Rivera."},
    {"name": "EMEA",                "position": 1,  "color": "#8B5CF6", "notes": "Europe, Middle East, Africa. CSM: Jordan Patel."},
    {"name": "APAC",                "position": 2,  "color": "#10B981", "notes": "Australia, Japan, SE Asia. CSM: Morgan Wu."},
    {"name": "Enterprise Accounts", "position": 3,  "color": "#F59E0B", "notes": "200+ seat strategic accounts managed directly by VP CS."},
    {"name": "Mid-Market",          "position": 4,  "color": "#EF4444", "notes": "20-200 seat accounts. CSM coverage pooled."},
    {"name": "Strategic Partners",  "position": 5,  "color": "#14B8A6", "notes": "Channel and technology partners. Joint success plans. CSM: Riley Kim."},
    {"name": "Government & Edu",    "position": 6,  "color": "#6366F1", "notes": "Public sector accounts. Longer procurement, stricter compliance. CSM: Sam Torres."},
    {"name": "Healthcare",          "position": 7,  "color": "#0EA5E9", "notes": "HIPAA-compliant accounts. PHI handling required. CSM: Casey Park."},
    {"name": "Financial Services",  "position": 8,  "color": "#F43F5E", "notes": "SOC 2 and regulatory compliance required. CSM: Drew Martinez."},
    {"name": "Startup & SMB",       "position": 9,  "color": "#A855F7", "notes": "Sub-20-seat accounts. Tech-touch CSM model. Automated health scoring."},
    {"name": "Agency & Creative",   "position": 10, "color": "#EAB308", "notes": "Creative agencies and studios. High board count, low seat count. CSM: Avery Chen."},
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

# Titles read "<Account> -- <Stage>: ..." so the lead word names the lifecycle
# stage. There is no At Risk column; at-risk accounts are still being adopted.
_SUCCESS_STAGE_RULES = [
    (r"-- (Kickoff|Onboarding|Partner enablement)", [("Onboarding", 1)]),
    (r"-- Adoption", [("Adoption", 1)]),
    (r"-- At-risk", [("Adoption", 1)]),
    (r"-- Healthy", [("Healthy", 1)]),
    (r"-- QBR", [("Healthy", 1)]),
    (r"-- Expansion", [("Expansion", 1)]),
    (r"-- Renewal", [("Renewal", 1)]),
    (r"-- Churned", [("Churned", 1)]),
]

CUSTOMER_SUCCESS = {
    "slug": "customer_success",
    "name": "Template: Customer Success",
    "description": "Track account health from onboarding through expansion and renewal. Each swimlane represents a customer segment.",
    "columns": _SUCCESS_COLUMNS,
    "swimlanes": _SUCCESS_SWIMLANES,
    "labels": _SUCCESS_LABELS,
    "extra_cards": _auto_cards(_SUCCESS_TITLES, _SUCCESS_COLUMNS, _SUCCESS_SWIMLANES, _SUCCESS_LABELS, "success", _SUCCESS_STAGE_RULES),
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
    {"name": "Frontend",      "position": 0,  "color": "#3B82F6", "notes": "React + TypeScript. Owns all UI components, pages, and the design system."},
    {"name": "Backend",       "position": 1,  "color": "#8B5CF6", "notes": "Django + DRF. Owns API, data models, business logic, and background tasks."},
    {"name": "Mobile",        "position": 2,  "color": "#EC4899", "notes": "React Native. iOS + Android. Syncs with main API."},
    {"name": "DevOps",        "position": 3,  "color": "#14B8A6", "notes": "CI/CD, infrastructure, reliability, and monitoring."},
    {"name": "Design",        "position": 4,  "color": "#F59E0B", "notes": "UX/UI design, design system, user research."},
    {"name": "QA",            "position": 5,  "color": "#EF4444", "notes": "Manual and automated testing. Regression suites and exploratory testing."},
    {"name": "Data",          "position": 6,  "color": "#10B981", "notes": "Data engineering and analytics. Pipelines, dashboards, and reporting."},
    {"name": "Security",      "position": 7,  "color": "#6366F1", "notes": "Application security, penetration testing, and compliance audits."},
    {"name": "Platform",      "position": 8,  "color": "#0EA5E9", "notes": "Shared libraries, SDKs, developer tooling, and internal APIs."},
    {"name": "Documentation", "position": 9,  "color": "#F43F5E", "notes": "Technical writing, API docs, user guides, and onboarding materials."},
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
    {"name": "Mobile App",            "position": 0,  "color": "#EC4899", "notes": "iOS and Android. Targets field workers and on-the-go board access."},
    {"name": "Core Platform",         "position": 1,  "color": "#3B82F6", "notes": "Web app, API, and shared infrastructure features."},
    {"name": "Integrations",          "position": 2,  "color": "#10B981", "notes": "Third-party integrations: Slack, GitHub, Jira, Zapier, webhooks."},
    {"name": "Analytics",             "position": 3,  "color": "#F59E0B", "notes": "Board analytics, cycle time, throughput, and reporting features."},
    {"name": "Compliance & Security", "position": 4,  "color": "#8B5CF6", "notes": "GDPR, SOC 2, audit logging, and security hardening features."},
    {"name": "Collaboration",         "position": 5,  "color": "#14B8A6", "notes": "Real-time collaboration, comments, mentions, and notification features."},
    {"name": "Import & Export",       "position": 6,  "color": "#6366F1", "notes": "Data portability: CSV, JSON, API bulk operations, and migration tools."},
    {"name": "Automation",            "position": 7,  "color": "#0EA5E9", "notes": "Rule-based automation: auto-move, auto-assign, scheduled actions."},
    {"name": "Admin & Settings",      "position": 8,  "color": "#F43F5E", "notes": "Board and site administration, user management, billing, and configuration."},
    {"name": "Search & Discovery",    "position": 9,  "color": "#EAB308", "notes": "Full-text search, filtering, saved views, and cross-board discovery."},
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
# ── 6. Software Development ───────────────────────────────────────────────────
# _auto_cards and _build draw from this module's shared RNG stream, so this
# template is expanded from its own saved stream state here, and built last in
# main(). Either alone would reshuffle every other sample's cards and dates.

_SOFTDEV_COLUMNS = [
    {"name": "Backlog",     "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Ready",       "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": False},
    {"name": "In Progress", "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "In Review",   "position": 3, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Testing",     "position": 4, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
    {"name": "Done",        "position": 5, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_SOFTDEV_SWIMLANES = [
    {"name": "Web App",         "position": 0, "color": "#3B82F6", "notes": "Browser client: boards, cards, and everything users click. Owns the component library."},
    {"name": "Mobile",          "position": 1, "color": "#EC4899", "notes": "iOS and Android apps. Ships on the two-week store release train."},
    {"name": "API",             "position": 2, "color": "#8B5CF6", "notes": "Public REST API, background jobs, and the data model behind them."},
    {"name": "Platform",        "position": 3, "color": "#0EA5E9", "notes": "Shared services, SDKs, and internal tooling other squads build on."},
    {"name": "Infrastructure",  "position": 4, "color": "#14B8A6", "notes": "CI/CD, hosting, observability, and on-call tooling."},
    {"name": "Quality",         "position": 5, "color": "#EF4444", "notes": "Test automation, release verification, and flaky-test triage."},
    {"name": "Security",        "position": 6, "color": "#6366F1", "notes": "Application security, dependency hygiene, and compliance evidence."},
    {"name": "Developer Docs",  "position": 7, "color": "#F43F5E", "notes": "API reference, guides, and release notes."},
]

_SOFTDEV_LABELS = [
    {"name": "Bug",         "color": "#EF4444"},
    {"name": "Feature",     "color": "#3B82F6"},
    {"name": "Improvement", "color": "#10B981"},
    {"name": "Tech Debt",   "color": "#9CA3AF"},
    {"name": "Blocked",     "color": "#F97316"},
    {"name": "Hotfix",      "color": "#DC2626"},
]

_SOFTDEV_TITLES = [
    # Web App
    "Keyboard shortcut cheat sheet overlay",
    "Fix card drag ghost image flicker in Safari",
    "Inline editing for card titles on the board",
    "Move board filters into a saveable view",
    "Reduce initial bundle size below 250 KB",
    "Empty state for boards with no swimlanes",
    "Respect reduced-motion preference in drag animations",
    "Fix focus loss after closing the card modal",
    "Column header collapse remembers its state",
    "Virtualize long columns to keep scrolling smooth",
    # Mobile
    "Offline queue for card edits on flaky connections",
    "Push notification for cards assigned to me",
    "Fix crash when opening a card with a deleted label",
    "Swipe to move a card to the next column",
    "Biometric unlock for the saved session",
    "Tablet layout for the board view",
    "Upgrade React Native to the current stable release",
    "Share a card link from the native share sheet",
    "Fix keyboard covering the comment box on small phones",
    "Crash reporting with source maps for release builds",
    # API
    "Cursor pagination on the card list endpoint",
    "Fix N+1 query on the board summary endpoint",
    "Idempotency keys for card creation",
    "Webhook retry with exponential backoff",
    "Return 410 Gone for the retired v0 endpoints",
    "Rate limit the invite accept endpoint",
    "Add an updated_since filter to the card list",
    "Bulk archive endpoint for finished cards",
    "Fix timezone handling in due date filters",
    "Deprecation headers on legacy query parameters",
    # Platform
    "Extract the shared date picker into the component library",
    "Typed client SDK generated from the OpenAPI schema",
    "Feature flag service with percentage rollouts",
    "Centralize error codes in one registry",
    "Replace hand-rolled retry loops with one helper",
    "Audit log writer shared by every service",
    "Local development seed command for new engineers",
    "Deprecate the legacy event bus adapter",
    "Structured logging format across services",
    "Background job dashboard for stuck tasks",
    # Infrastructure
    "Cache dependencies between CI pipeline runs",
    "Blue-green deploy for the API tier",
    "Alert on queue depth before it backs up",
    "Rotate database credentials without downtime",
    "Autoscale workers on job latency instead of CPU",
    "Terraform module for the staging environment",
    "Nightly database backup restore drill",
    "Move container builds to the new runner pool",
    "Dashboards for p95 latency by endpoint",
    "Runbook for failing over the primary database",
    # Quality
    "Quarantine and fix the five flakiest end-to-end tests",
    "Smoke test suite that gates every deploy",
    "Visual regression checks for the board view",
    "Load test the card move endpoint at 500 concurrent users",
    "Contract tests between the web app and the API",
    "Test data factory for multi-board scenarios",
    "Release checklist automation",
    "Accessibility audit of the card modal",
    "Reproduce and triage the intermittent websocket drop",
    "Raise backend coverage on the import path",
    # Security
    "Upgrade the dependency flagged by the weekly scan",
    "Add CSP headers to the web app",
    "Review file upload limits and allowed types",
    "Penetration test findings: triage and assign",
    "Session timeout and forced logout after password change",
    "Secrets scanning in pre-commit and CI",
    "Threat model for the new sharing feature",
    "Audit API tokens older than one year",
    "Fix IDOR on the attachment download route",
    "SOC 2 evidence collection for access reviews",
    # Developer Docs
    "Document the pagination change in the API reference",
    "Quickstart: your first webhook in five minutes",
    "Changelog entries for the last three releases",
    "Document the idempotency key header",
    "Migration guide for the retired v0 endpoints",
    "Troubleshooting page for common import errors",
    "Add curl examples to every endpoint page",
    "Architecture overview diagram refresh",
    "Style guide for release notes",
    "Contributor guide: running the test suite locally",
]

_rng_state = _rng.getstate()
_softdev_cards = _auto_cards(_SOFTDEV_TITLES, _SOFTDEV_COLUMNS, _SOFTDEV_SWIMLANES, _SOFTDEV_LABELS, "kanban")
_rng.setstate(_rng_state)

SOFTWARE_DEVELOPMENT = {
    "slug": "software_development",
    "name": "Template: Software Development",
    "description": "A product engineering board from backlog to done. Each swimlane is a squad; each card is a story, bug, or chore.",
    "columns": _SOFTDEV_COLUMNS,
    "swimlanes": _SOFTDEV_SWIMLANES,
    "labels": _SOFTDEV_LABELS,
    "extra_cards": _softdev_cards,
}


# ═════════════════════════════════════════════════════════════════════════════
# Templates 6-10 are defined in generate_seed_data_part2.py and imported below.
# This split keeps each file manageable.


def _load_module(filename: str, name: str):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, os.path.join(SEED_DATA_DIR, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _load_part2():
    return _load_module("generate_seed_data_part2.py", "part2").TEMPLATES_PART2


# ── CSV ───────────────────────────────────────────────────────────────────────
def _csv_cell(definition: dict, value: str) -> str:
    """Same rendering as the board exporter: multi-select entries joined by "; "."""
    if definition["field_type"] == "multi_select" and value:
        return "; ".join(json.loads(value))
    return value


def _write_csv(path: str, data: dict) -> None:
    """Write the board in the exact column layout ``GET /export/?format=csv`` emits.

    So the CSV is importable through the same Import dialog (the importer
    reads Title, Description, Column, Swimlane, Priority, Assignee, Labels,
    Due Date and Weight) and reads like a real export in a spreadsheet. Rows
    are ordered by column then swimlane: CSV import creates columns and
    swimlanes in first-appearance order, so this keeps the board's order.
    """
    col_pos = {c["name"]: c["position"] for c in data["columns"]}
    lane_pos = {s["name"]: s["position"] for s in data["swimlanes"]}
    lanes = {s["name"]: s for s in data["swimlanes"]}
    cards = sorted(
        enumerate(data["cards"]),
        key=lambda ic: (col_pos[ic[1]["column"]], lane_pos[ic[1]["swimlane"]], ic[0]),
    )
    with open(path, "w", encoding="utf-8", newline="") as f:
        # LF, not the csv module's default CRLF: .gitattributes normalizes
        # text to LF, and test_sample_boards byte-compares a regeneration
        # against the checked-out files.
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow([
            "Card ID", "Title", "Description", "Column", "Swimlane",
            "Priority", "Assignee", "Labels", "Due Date", "Weight",
            "Created At", "Created By", "Last Moved At", "Movement Count",
            "Movement History",
            *[f"Custom: {cf['name']}" for cf in data["custom_fields"]],
            *[f"Swimlane Custom: {sf['name']}" for sf in data["swimlane_custom_fields"]],
        ])
        for card_id, (_, card) in enumerate(cards, start=1):
            movs = card["movements"]
            history = "; ".join(
                f"{m['moved_at']}|{m['from_column'] or ''}|{m['to_column'] or ''}|{m['moved_by'] or ''}"
                for m in movs
            )
            values = card["custom_field_values"]
            lane_values = lanes[card["swimlane"]]["custom_field_values"]
            writer.writerow([
                card_id, card["title"], card.get("description", ""), card["column"],
                card["swimlane"], card["priority"], card.get("assignee") or "",
                ", ".join(card["labels"]), card.get("due_date") or "", card["weight"],
                card["created_at"], card["created_by"] or "", movs[-1]["moved_at"], len(movs),
                history,
                *[_csv_cell(cf, values.get(cf["name"], "")) for cf in data["custom_fields"]],
                *[_csv_cell(sf, lane_values.get(sf["name"], "")) for sf in data["swimlane_custom_fields"]],
            ])


# ── Main ──────────────────────────────────────────────────────────────────────
ALL_TEMPLATES = [
    SALES_PIPELINE,
    CUSTOMER_SUPPORT,
    CUSTOMER_SUCCESS,
    SIMPLE_KANBAN,
    PRODUCT_ROADMAP,
]


# Where the output lands. The JSON files and the manifest live inside the
# backend package so the backend image ships them (the Docker build context is
# ``backend/``, so a repo-root directory can never reach the image, #1452). The
# CSVs are repo-only reading material and stay at the repo root.
JSON_DIR = os.path.normpath(os.path.join(SEED_DATA_DIR, "..", "sample_boards"))
CSV_DIR = os.path.normpath(os.path.join(SEED_DATA_DIR, "..", "..", "..", "sample-boards"))
MANIFEST_NAME = "manifest.json"
DOCS_PAGE = os.path.normpath(
    os.path.join(SEED_DATA_DIR, "..", "..", "..", "docs", "getting-started", "sample-boards.md")
)
README_PAGE = os.path.join(CSV_DIR, "README.md")
TABLE_BEGIN = "<!-- BEGIN sample-table (generated by generate_seed_data.py; do not edit) -->"
TABLE_END = "<!-- END sample-table -->"
JSON_PATH_IN_REPO = "backend/boards/sample_boards"


def _includes(data: dict) -> list[str]:
    """Which optional board features this board actually carries.

    Derived from the generated content, never hand-written, so a thinner
    sample cannot claim something it does not have. ``history`` means cards
    with more than their creation move.
    """
    cards = data["cards"]
    found = []
    if data["labels"] and any(c["labels"] for c in cards):
        found.append("labels")
    if any(c.get("checklist") for c in cards):
        found.append("checklists")
    if any(c.get("comments") for c in cards):
        found.append("comments")
    if any(len(c["movements"]) > 1 for c in cards):
        found.append("history")
    return found


def _manifest_entry(meta: dict, data: dict, json_bytes: bytes) -> dict:
    return {
        "id": meta["slug"],
        "title": meta["title"],
        "description": meta["summary"],
        "swimlane_theme": meta["swimlane_theme"],
        # Active cards only: archived cards are not on the board after import.
        "card_count": sum(1 for c in data["cards"] if not c.get("archived_at")),
        "includes": _includes(data),
        "file": f"{meta['slug']}.json",
        "order": meta["order"],
        "sha256": hashlib.sha256(json_bytes).hexdigest(),
        "schema_version": data["schema_version"],
        # The day the sample's relative dates are measured from. The import
        # option ``shift_dates_from`` takes this so an imported sample is dated
        # around the import day instead of mostly overdue.
        "date_anchor": ANCHOR.date().isoformat(),
    }


def render_readme_table(manifest: list[dict]) -> str:
    rows = ["| File | Board | Swimlane = | Cards |", "|------|-------|-----------|------:|"]
    for e in manifest:
        rows.append(
            f"| `{e['file']}` | {e['title']} | {e['swimlane_theme'].capitalize()} | {e['card_count']} |"
        )
    return "\n".join(rows)


def render_docs_table(manifest: list[dict], highlights: dict[str, str]) -> str:
    rows = [
        "| File | Board | Swimlane = | Cards | Highlights |",
        "|------|-------|-----------|------:|-----------|",
    ]
    for e in manifest:
        rows.append(
            f"| `{e['file']}` | {e['title']} | {e['swimlane_theme'].capitalize()} "
            f"| {e['card_count']} | {highlights[e['id']]} |"
        )
    return "\n".join(rows)


def splice_table(text: str, table: str) -> str:
    """Replace the generated region between the BEGIN/END markers."""
    start = text.index(TABLE_BEGIN) + len(TABLE_BEGIN)
    end = text.index(TABLE_END)
    return text[:start] + "\n\n" + table + "\n\n" + text[end:]


def main(json_dir: str | None = None, csv_dir: str | None = None):
    """Write every template, ``manifest.json`` and the generated docs tables.

    ``json_dir`` and ``csv_dir`` exist for ``test_sample_boards``, which
    regenerates into temporary directories and compares byte-for-byte with the
    committed files. The docs tables are only rewritten on a default run.
    """
    global ALL_TEMPLATES
    part2 = _load_part2()
    overlay = _load_module("sales_overlay.py", "sales_overlay")
    # Appended last: _build draws from the shared RNG stream in list order, so a
    # template added at the end leaves every earlier sample byte-identical.
    ALL_TEMPLATES = ALL_TEMPLATES + part2 + [overlay.SALES_OVERLAY, SOFTWARE_DEVELOPMENT]
    features = _load_module("sample_features.py", "sample_features").FEATURES
    features = {**features, overlay.SALES_OVERLAY["slug"]: overlay.FEATURES}
    gallery = {g["slug"]: g for g in _load_module("sample_gallery.py", "sample_gallery").GALLERY}
    if set(gallery) != {t["slug"] for t in ALL_TEMPLATES}:
        raise SystemExit("sample_gallery.GALLERY and ALL_TEMPLATES list different slugs")

    default_run = json_dir is None and csv_dir is None
    json_dir = json_dir or JSON_DIR
    csv_dir = csv_dir or CSV_DIR
    os.makedirs(json_dir, exist_ok=True)
    os.makedirs(csv_dir, exist_ok=True)

    manifest = []
    for tpl in ALL_TEMPLATES:
        slug = tpl["slug"]
        data = _build(tpl, features.get(slug))
        # The file's own name is the clean gallery title, so an import lands as
        # "Imported: Sales Pipeline" (#1446) rather than "Imported: Template: ...".
        data["name"] = gallery[slug]["title"]

        # Cards enter a board at its first column; allowing creation anywhere
        # else shows extra "+ Add card" cells and invites mis-staged cards.
        for i, col in enumerate(data["columns"]):
            col["allow_card_creation"] = i == 0

        json_bytes = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        with open(os.path.join(json_dir, f"{slug}.json"), "wb") as f:
            f.write(json_bytes)

        _write_csv(os.path.join(csv_dir, f"{slug}.csv"), data)
        manifest.append(_manifest_entry(gallery[slug], data, json_bytes))

        print(f"  ✓  {slug}.json + .csv  ({len(data['cards'])} cards)")

    manifest.sort(key=lambda e: e["order"])
    with open(os.path.join(json_dir, MANIFEST_NAME), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    if default_run:
        highlights = {g["slug"]: g["highlights"] for g in gallery.values()}
        for page, table in (
            (DOCS_PAGE, render_docs_table(manifest, highlights)),
            (README_PAGE, render_readme_table(manifest)),
        ):
            with open(page, encoding="utf-8") as f:
                text = f.read()
            with open(page, "w", encoding="utf-8") as f:
                f.write(splice_table(text, table))

    print(f"\nDone -- {len(ALL_TEMPLATES)} templates written to {json_dir} (CSVs in {csv_dir})")


if __name__ == "__main__":
    main()
