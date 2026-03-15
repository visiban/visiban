# Broadcast Check

You are verifying that real-time WebSocket broadcast events are correctly wired for new or modified mutations. Missing a broadcast means the UI goes stale silently — other connected users won't see the change until they reload.

## How broadcasting works in this codebase

```python
# boards/broadcast.py
broadcast_board_event(board_id, event_type, payload)
# → channel_layer.group_send(f"board_{board_id}", {...})
# → all connected BoardConsumer instances receive and forward to clients
```

Called via `async_to_sync` from synchronous Django views. The frontend `useBoardSocket` hook receives events and updates local state.

## What to do

Given the new or modified viewset, view, or model method in `$ARGUMENTS` (or infer from the current git diff if no argument is provided):

### 1. Identify mutations that require a broadcast

Every write operation that changes board state visible to other users must broadcast. Check:

| Mutation | Expected event type |
|---|---|
| Card created | `card_created` |
| Card updated (field change) | `card_updated` |
| Card moved (column/swimlane) | `card_moved` |
| Card deleted | `card_deleted` |
| Column created/updated/deleted | `column_updated` |
| Swimlane created/updated/deleted | `swimlane_updated` |
| Label created/updated/deleted | `label_updated` |
| Board settings changed | `board_updated` |
| Member added/removed/role changed | `membership_updated` |
| Comment added/deleted | `comment_updated` |
| Checklist item changed | `card_updated` |

### 2. Verify broadcast placement

- Is `broadcast_board_event()` called after every successful write in `perform_create`, `perform_update`, `perform_destroy`, and custom actions?
- Is the broadcast **inside** `@transaction.atomic` blocks — or better, deferred with `transaction.on_commit()`?
  - Prefer `transaction.on_commit(lambda: broadcast_board_event(...))` so the broadcast only fires if the transaction commits successfully
  - A broadcast inside a transaction that later rolls back will push stale/invalid state to clients
- Is the correct `board_id` being passed? (Not a card ID or column ID)

### 3. Verify payload completeness

The broadcast payload should contain enough data for the frontend to update its state without a refetch:
- For card mutations: include the full serialized card (with labels, assignee, movements)
- For structural mutations (columns, swimlanes): include the updated object
- For deletes: include the deleted object's ID so the frontend can remove it from state

### 4. Check for broadcast storms

- Is `broadcast_board_event()` called inside a loop? One call per mutation is correct; N calls per request is a problem.
- For bulk operations (e.g. reordering multiple cards), broadcast once with the full updated list — not once per card.

### 5. Verify frontend handler

Check `frontend/src/hooks/useBoardSocket.ts` (or equivalent):
- Is there a handler for the new event type?
- Does the handler correctly update the relevant slice of board state?
- Does the handler handle the case where the event references an object not currently in local state (e.g. a card in a collapsed swimlane)?

### 6. Output

Produce a summary:
- ✅ All mutations correctly broadcast
- 🟡 Missing or misplaced broadcast (list each — UI will go stale but no crash)
- 🔴 Broadcast inside transaction without `on_commit` (list each — risk of pushing rolled-back state)

For each issue, give the specific fix:
```python
# Incorrect — broadcast may fire even if transaction rolls back
with transaction.atomic():
    card.save()
    broadcast_board_event(board.id, "card_updated", payload)

# Correct — broadcast deferred until after commit
with transaction.atomic():
    card.save()
    transaction.on_commit(
        lambda: broadcast_board_event(board.id, "card_updated", payload)
    )
```
