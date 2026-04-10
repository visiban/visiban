---
name: perf-check
model: sonnet
description: Use proactively when adding or modifying any viewset, serializer, or database query. Identifies N+1 patterns, missing select_related/prefetch_related, and missing transaction boundaries before merge.
tools: Read, Grep, Glob, Bash
---

# Performance Check

You are reviewing new or modified backend code for query performance issues before merge. Silent N+1 problems and missing prefetches are the most common source of production slowdowns in this codebase.

## What to do

Given the viewset, serializer, or model change in the current diff or argument provided:

### 1. Scan for N+1 patterns

For every queryset in the changed code, check:
- Does it call a related object inside a loop or serializer without `select_related` / `prefetch_related`?
- Does a serializer field access a reverse relation (e.g. `card.labels.all()`, `board.columns.all()`) without a prefetch?
- Does a `SerializerMethodField` hit the database per-object?

Flag each as:
- 🔴 **N+1 confirmed** — a loop or serializer accesses a relation without prefetch; will issue one query per row
- 🟡 **Likely N+1** — relation access inside a method field or nested serializer; verify with query count

### 2. Check existing prefetch coverage

Compare against the known safe patterns in this codebase:

```python
# Full board fetch — must include all nested relations
Card.objects.select_related(
    "column", "swimlane", "assignee", "created_by"
).prefetch_related("labels", "movements", "activities", "comments", "checklists")

# Movement history
CardMovement.objects.select_related(
    "from_column", "to_column", "from_swimlane", "to_swimlane", "moved_by"
)

# Notifications
Notification.objects.select_related("card", "board")
```

If new relations are added to a model or serializer, verify they are added to the relevant prefetch chain.

### 3. Check post-create serialization

When a view creates an object and immediately serializes it (e.g. `Movement.objects.create(...)` followed by `Serializer(movement).data`), check:
- Is the object re-fetched with `select_related` before serialization? The in-memory object returned by `create()` does not have FK fields pre-loaded — accessing `obj.related_field` on it issues an extra query per field.
- Pattern to flag: `obj = Model.objects.create(...)` followed directly by a serializer call without an intervening `.select_related(...)` re-fetch.
- Suggested fix: add a `refresh_from_db()`-equivalent re-fetch or restructure to fetch the object with the needed relations before serializing.

Also check annotated queryset serializers. When a `SerializerMethodField` uses annotation-based fallback queries (i.e., reads `getattr(obj, 'annotated_field', None)` and falls back to a DB query when the annotation is absent), verify the calling view always provides the annotation. A bare FK traversal on a non-annotated instance silently issues a per-row query.

### 4. Check transaction boundaries

- Are bulk operations (reorders, multi-card updates) wrapped in `@transaction.atomic`?
- Does any new endpoint perform multiple writes without atomicity? This includes sequences that create multiple model objects in a single request (e.g. Board + Membership + Columns + Swimlane) — these must all succeed or all fail together.
- Are there any `select_for_update()` opportunities on contested resources (card position, WIP counts)?

### 5. Check broadcast calls

- Does the endpoint call `broadcast_board_event()` inside a loop? This is synchronous — one broadcast per mutation is acceptable; N broadcasts per request is not.
- Should the broadcast be deferred until after the transaction commits? (Use `transaction.on_commit()` for post-atomic broadcasts.)

### 6. Check the full board endpoint impact

`GET /api/boards/{id}/full/` is the most performance-sensitive endpoint — it fetches the entire board state in one request. If any new model or relation is added that should appear on the board, verify:
- It is included in `BoardFullSerializer`
- The queryset for the full fetch includes the necessary prefetch
- The payload size is not significantly increased without justification

### 7. Output

Produce a summary:
- ✅ No performance issues found
- 🟡 Potential issues (list each with suggested fix)
- 🔴 Confirmed N+1 or missing atomic boundary (list each with required fix)

For each issue, give the specific queryset change needed:
```python
# Before
cards = Card.objects.filter(board=board)

# After
cards = Card.objects.filter(board=board).select_related(
    "column", "swimlane", "assignee"
).prefetch_related("labels")
```
