---
name: perf-bench
model: sonnet
description: Use proactively when adding a SerializerMethodField to CardSerializer, adding a new relation to Card/Board/CardMovement models, modifying the summary or analytics endpoint, or when perf-check flags a potential N+1 that needs verification with actual query counts.
tools: Read, Grep, Glob, Bash
---

# Performance Benchmark

You are running the performance benchmark suite for Visiban, measuring SQL query counts for the most performance-sensitive endpoints, identifying regressions, and fixing root causes.

## What to do

Given the optional argument provided (e.g. "after adding CardChecklist relation") or the current diff context:

---

### 1. Run the benchmark management command

```bash
docker compose exec backend python manage.py benchmark
```

This measures query counts for:
- `GET /api/boards/{id}/cards/` — budget ≤ 12
- `GET /api/boards/{id}/full/` — budget ≤ 20
- `GET /api/boards/{id}/summary/` — budget ≤ 10

If any endpoint **exceeds its budget**, that is a confirmed N+1. Do not proceed to the next step until you understand why.

---

### 2. Run the query-count regression tests

```bash
docker compose exec backend python manage.py test boards.tests.test_query_counts --verbosity=2 --keepdb
```

These tests assert two invariants per endpoint:
1. **Budget** — query count is below the ceiling
2. **Scale** — query count stays *constant* when more cards/swimlanes are added

A "scales" failure is the most important: it means the count grew proportionally with data, which is the definition of an N+1.

---

### 3. Profile slow queries

If the benchmark or tests flag a regression, identify the source:

**Step 1 — Enable query logging** in the benchmark output. The command automatically prints the last 5 queries when a budget is exceeded.

**Step 2 — Check `CardSerializer` method fields** — these are the most common source of N+1s in this codebase:

| Method | Safe pattern | Unsafe pattern |
|---|---|---|
| `get_last_moved_at` | `_card_movements(obj)[0]` | `obj.movements.first()`, `obj.movements.all()[0]` |
| `get_attachment_count` | `len(_card_attachments(obj))` | `obj.attachments.count()`, `len(obj.attachments.all())` |
| `get_checklist_total` | `len(_card_checklist_items(obj))` | `obj.checklist_items.count()`, `len(obj.checklist_items.all())` |
| `get_checklist_done` | `sum(1 for i in _card_checklist_items(obj) if i.is_checked)` | `obj.checklist_items.filter(...).count()` |
| `get_is_stale` | `obj.board.staleness_threshold_days` (with `select_related("board")`) | accessing `obj.board` without select_related |

Key rules:

- **`.first()`, `.count()`, `.filter()`, and `.order_by()`** on a prefetched relation bypass the cache and issue a new SQL query per object.
- **`.all()` on a prefetched manager avoids the SQL but is not free.** Every call still runs `RelatedManager.get_queryset()` -> `_apply_rel_filters()`, which clones and filters a new QuerySet *before* it checks the prefetch cache. On a hot per-instance path that is real CPU: on `/full/` (~2,400 cards x several relations) it was ~300ms of p95 with zero extra queries (#1212). **A query-count guard cannot see this cost.**
- **This codebase's pattern for a hot per-instance read is `Prefetch(..., to_attr=...)` plus a plain-list accessor.** The rows are parked on a list attribute and read directly, skipping the manager. `_card_queryset()` in `boards/serializers.py` is the canonical example: it parks `attachments`, `checklist_items`, `movements`, and `custom_field_values`, and the `_card_attachments` / `_card_checklist_items` / `_card_movements` / `_card_custom_field_values` accessors read them, falling back to the manager for cards not built by `_card_queryset()`. `_active_blockers_prefetch()` is the same pattern. A reader that goes back to `obj.<relation>.all()` on a `_card_queryset()` card misses the parked list and issues **one query per card**.

**Step 3 — Check the queryset** — confirm `_card_queryset()` is applied everywhere `CardSerializer` is used:
- `CardViewSet.get_queryset()`
- `BoardFullSerializer.get_cards()`
- The `archived` action
- The `unarchive` action

**Step 4 — Check `summary` endpoint** — this endpoint must use aggregate queries (`Count` with `.values()`) rather than per-swimlane loops. The pattern:

```python
# ✅ Correct: 2 queries total regardless of board size
card_counts = (
    board.cards.filter(archived_at__isnull=True)
    .values("swimlane_id", "column_id")
    .annotate(cnt=Count("id"))
)

# ❌ Wrong: 1 + S×(C+4) queries (S=swimlanes, C=columns)
for swimlane in swimlanes:
    cards = board.cards.filter(swimlane=swimlane)
    {col.name: cards.filter(column=col).count() for col in columns}
```

---

### 4. Fix the root cause

**For N+1 in CardSerializer:**

Ensure `_card_queryset()` in `boards/serializers.py` includes all relations accessed by serializer method fields, parked with `to_attr` and read through an accessor (abridged; read the real function for the full chain):

```python
_PARKED_MOVEMENTS = "_prefetched_movements"

def _card_movements(card):
    # Parked list when present; manager fallback for cold single-card paths.
    return _parked_or_manager(card, _PARKED_MOVEMENTS, "movements")

def _card_queryset(qs, stale_cutoff=None):
    from .models import CardMovement as _CM
    return (
        qs
        .select_related("board", "column", "swimlane", "assignee", "created_by", "external_ref")
        .prefetch_related(
            "labels",
            Prefetch("attachments", to_attr=_PARKED_ATTACHMENTS),
            Prefetch("movements", queryset=_CM.objects.order_by("-moved_at"),
                     to_attr=_PARKED_MOVEMENTS),
            # ...checklist_items, custom_field_values, _active_blockers_prefetch()
        )
    )
```

If a new relation is added to `CardSerializer`, **add it to `_card_queryset` in the same commit**, parked with `to_attr` and read through an accessor. Update every other reader of `_card_queryset()` cards (`CardQuerySerializer`, the MCP `card_detail` tool) to use that accessor too. A nested `many=True` serializer field reads the manager by default; see `ParkedCustomFieldValueListSerializer` for the `get_attribute` override that points it at the parked list. `ParkedPrefetchQueryCountTests` in `test_query_counts.py` asserts the parked attributes are actually present.

---

### 5. Re-run to verify the fix

```bash
docker compose exec backend python manage.py benchmark
docker compose exec backend python manage.py test boards.tests.test_query_counts --verbosity=2 --keepdb
```

All three benchmarks and all 6 tests must pass before proceeding.

---

### 6. Update query budgets if they legitimately change

If a new relation is intentionally added to `CardSerializer` (e.g. a new prefetch that adds 1 query to the fixed cost), update the budgets in:
- `benchmark.py` — the `budget=` arguments in `_bench_*` methods
- `test_query_counts.py` — the `BUDGET` class constants

Document the change in the commit message with the before/after counts.

---

## File map

| Purpose | Path |
|---|---|
| Benchmark command | `backend/boards/management/commands/benchmark.py` |
| Query-count tests | `backend/boards/tests/test_query_counts.py` |
| Prefetch helper | `backend/boards/serializers.py` → `_card_queryset()` |
| Summary endpoint | `backend/boards/views.py` → `BoardViewSet.summary()` |
