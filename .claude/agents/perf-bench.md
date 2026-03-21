---
name: perf-bench
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
| `get_last_moved_at` | `obj.movements.all()[0]` | `obj.movements.first()` |
| `get_attachment_count` | `len(obj.attachments.all())` | `obj.attachments.count()` |
| `get_checklist_total` | `len(obj.checklist_items.all())` | `obj.checklist_items.count()` |
| `get_checklist_done` | `sum(1 for i in obj.checklist_items.all() if i.is_checked)` | `obj.checklist_items.filter(...).count()` |
| `get_is_stale` | `obj.board.staleness_threshold_days` (with `select_related("board")`) | accessing `obj.board` without select_related |

Key rule: **`.first()`, `.count()`, and `.filter()`** on a prefetched relation bypass the cache and issue a new SQL query per object. **`.all()` and `len()`** use the cache.

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

Ensure `_card_queryset()` in `boards/serializers.py` includes all relations accessed by serializer method fields:

```python
def _card_queryset(qs):
    from .models import CardMovement as _CM
    return (
        qs
        .select_related("board", "assignee")
        .prefetch_related(
            "labels",
            "attachments",
            "checklist_items",
            Prefetch("movements", queryset=_CM.objects.order_by("-moved_at")),
        )
    )
```

If a new relation is added to `CardSerializer`, **add it to `_card_queryset` in the same commit**.

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
