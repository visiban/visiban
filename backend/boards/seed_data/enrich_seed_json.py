"""
One-shot enrichment script: adds schema_version, assignees, and full
CardActivity history to all seed-data JSON files.

Run from the seed_data directory or with the path as an argument:
    python enrich_seed_json.py
"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone

DEMO_USERS = ["demo1", "demo2", "demo3", "demo4", "demo5"]
SCHEMA_VERSION = 1

# Fraction of cards that receive an assignee (skips index multiples of 3)
def _assignee(card_idx):
    if card_idx % 3 == 2:
        return None
    return DEMO_USERS[card_idx % len(DEMO_USERS)]


def _parse_dt(s):
    """Parse ISO datetime string to aware datetime."""
    if not s:
        return None
    s = s.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _iso(dt):
    return dt.isoformat()


def _build_activities(card, card_idx, creation_dt):
    """
    Generate CardActivity records for a card dict.
    Timestamps are anchored to creation_dt and spread over a few hours.
    """
    activities = []
    actor = DEMO_USERS[card_idx % len(DEMO_USERS)]
    ts = creation_dt + timedelta(minutes=5)

    # Assignee set
    assignee = card.get("assignee")
    if assignee:
        activities.append({
            "event_type": "assignee_change",
            "from_value": "",
            "to_value": assignee,
            "actor": actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=3)

    # Labels applied
    labels = card.get("labels", [])
    if labels:
        activities.append({
            "event_type": "label_change",
            "from_value": "",
            "to_value": ", ".join(labels),
            "actor": actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=5)

    # Priority set (if not medium — that's the default)
    priority = card.get("priority", "medium")
    if priority != "medium":
        activities.append({
            "event_type": "priority_change",
            "from_value": "medium",
            "to_value": priority,
            "actor": actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=4)

    # Due date set
    due_date = card.get("due_date")
    if due_date:
        activities.append({
            "event_type": "due_date_change",
            "from_value": "",
            "to_value": due_date,
            "actor": actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=3)

    # Checklist items added
    for item in card.get("checklist", []):
        activities.append({
            "event_type": "checklist_item_added",
            "from_value": "",
            "to_value": item.get("text", ""),
            "actor": actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=2)
        if item.get("is_checked"):
            activities.append({
                "event_type": "checklist_item_checked",
                "from_value": "",
                "to_value": item.get("text", ""),
                "actor": DEMO_USERS[(card_idx + 1) % len(DEMO_USERS)],
                "created_at": _iso(ts),
            })
            ts += timedelta(minutes=1)

    # Comments
    for comment in card.get("comments", []):
        comment_actor = comment.get("author") or actor
        activities.append({
            "event_type": "comment_added",
            "from_value": "",
            "to_value": (comment.get("body", ""))[:120],
            "actor": comment_actor,
            "created_at": _iso(ts),
        })
        ts += timedelta(minutes=15)

    return activities


def enrich_file(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)

    # Already at current version — skip (idempotent)
    if data.get("schema_version") == SCHEMA_VERSION and all(
        "activities" in c for c in data.get("cards", [])
    ):
        print(f"  SKIP (already enriched): {os.path.basename(path)}")
        return

    data["schema_version"] = SCHEMA_VERSION

    columns = [col["name"] for col in data.get("columns", [])]
    col_index = {name: i for i, name in enumerate(columns)}

    cards = data.get("cards", [])
    # Sort cards by swimlane then column position so enrichment order is stable
    cards_sorted = sorted(
        enumerate(cards),
        key=lambda ic: (ic[1].get("swimlane", ""), col_index.get(ic[1].get("column", ""), 999))
    )

    for global_idx, (orig_idx, card) in enumerate(cards_sorted):
        # Assign demo user
        card["assignee"] = _assignee(global_idx)

        # Determine creation date from first movement or fall back
        movements = card.get("movements", [])
        if movements:
            first_mv = sorted(movements, key=lambda m: m.get("moved_at", ""))[0]
            creation_dt = _parse_dt(first_mv.get("moved_at")) or datetime(2026, 2, 1, tzinfo=timezone.utc)
            # Creation is a day before first move
            creation_dt = creation_dt - timedelta(days=1)
        else:
            creation_dt = datetime(2026, 2, 1, tzinfo=timezone.utc)

        # Ensure movements cover every column from 0 to current
        if columns and card.get("column") in col_index:
            current_col_idx = col_index[card["column"]]
            swimlane = card.get("swimlane", "")

            # Build complete movement chain if gaps exist
            if current_col_idx > 0:
                full_movements = []
                mv_date = creation_dt + timedelta(days=1)
                actor = DEMO_USERS[global_idx % len(DEMO_USERS)]

                # First move: null → col0
                if not any(m.get("from_column") is None and m.get("to_column") == columns[0] for m in movements):
                    full_movements.append({
                        "from_column": None,
                        "to_column": columns[0],
                        "from_swimlane": None,
                        "to_swimlane": swimlane,
                        "moved_at": _iso(mv_date),
                        "moved_by": actor,
                    })
                else:
                    # Keep existing first move
                    first = next(m for m in movements if m.get("from_column") is None)
                    full_movements.append(first)
                    mv_date = _parse_dt(first.get("moved_at")) or mv_date

                # Subsequent moves: col_i → col_{i+1}
                for step in range(current_col_idx):
                    from_col = columns[step]
                    to_col = columns[step + 1]
                    mv_date = mv_date + timedelta(days=max(3, (step + 1) * 4))
                    # Reuse existing movement if present
                    existing = next(
                        (m for m in movements if m.get("from_column") == from_col and m.get("to_column") == to_col),
                        None
                    )
                    if existing:
                        full_movements.append(existing)
                        mv_date = _parse_dt(existing.get("moved_at")) or mv_date
                    else:
                        step_actor = DEMO_USERS[(global_idx + step + 1) % len(DEMO_USERS)]
                        full_movements.append({
                            "from_column": from_col,
                            "to_column": to_col,
                            "from_swimlane": swimlane,
                            "to_swimlane": swimlane,
                            "moved_at": _iso(mv_date),
                            "moved_by": step_actor,
                        })
                card["movements"] = full_movements
            elif not movements:
                # Card in column 0 with no movements — add initial placement
                mv_date = creation_dt + timedelta(days=1)
                actor = DEMO_USERS[global_idx % len(DEMO_USERS)]
                card["movements"] = [{
                    "from_column": None,
                    "to_column": columns[0],
                    "from_swimlane": None,
                    "to_swimlane": swimlane,
                    "moved_at": _iso(mv_date),
                    "moved_by": actor,
                }]

        # Generate activities
        card["activities"] = _build_activities(card, global_idx, creation_dt)

    print(f"  OK: {os.path.basename(path)} — {len(cards)} cards enriched")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    target_dir = sys.argv[1] if len(sys.argv) > 1 else script_dir
    files = sorted(
        os.path.join(target_dir, fn)
        for fn in os.listdir(target_dir)
        if fn.endswith(".json") and fn != "enrich_seed_json.py"
    )
    print(f"Enriching {len(files)} JSON files in {target_dir}")
    for path in files:
        enrich_file(path)
    print("Done.")


if __name__ == "__main__":
    main()
