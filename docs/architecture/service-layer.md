# Service Layer

Board mutations that carry invariants live in `backend/boards/services/`, not in the DRF views that expose them over HTTP.

## Why the layer exists

Until Visiban 1.2 every card state transition was implemented inline in `CardViewSet`. That was fine while the REST API was the only writer. It stopped being fine as soon as a second consumer appeared, because an invariant that lives inside an HTTP handler can only be reached by making an HTTP request — so any second code path has to either re-implement the rules or skip them.

Both failure modes had already happened:

- The MCP tool scaffold carried its own copy of the board-role precedence ladder, with a comment saying it "must be kept in step with" the original. Nothing enforced that.
- A `PATCH` that changed a card's `column` bypassed WIP enforcement and the movement audit trail entirely, because only the move endpoint evaluated them.

The API now has several writers in view — a second front end, MCP write tools, import, and webhooks — so the invariants need a home that is not a request handler.

## What a service function owns

For one state transition:

| Concern | Example |
|---|---|
| Role allow-list | only `member`, `admin`, `site_admin` may mutate a card |
| Ownership / assignment gate | a member may edit only cards they created, unless they hold the moderator entitlement |
| Optimistic concurrency | compare the caller's `version` against the stored row |
| Row locks, in a fixed order | card row → target column row → source cell rows by pk → target cell rows by pk |
| Limit enforcement | WIP soft, WIP hard, weight, and the `force` override authorization |
| Audit trail | the `CardMovement` row and the `CardActivity` diff |
| The transaction | one `atomic()` block per transition |
| Deferred side effects | the `transaction.on_commit()` WebSocket broadcast and `CARD_MUTATION_HOOKS` |

The lock order is a deadlock-avoidance contract, not an implementation detail: concurrent moves queue behind each other only because every caller takes the same locks in the same sequence.

## What stays in the view

Nothing under `boards/services/` imports `rest_framework`, reads a request, or builds a response. The view adapter keeps:

- **Parsing**, mostly. `?force` becomes a `bool`. The exception is `version`, which the adapter passes through raw: *when* the "version must be an integer" `400` is raised is part of the frozen contract — it comes after the role allow-list, the card lookup, and the assignment gate — so the coercion lives in the service. Parsing it in the adapter turns a `403` into a `400` for a caller who sent both a bad version and a request they were not allowed to make.
- **Field validation.** Per the project rule that input is validated at the serializer boundary, `create_card` and `update_card` take a callable that performs the already-validated write — `serializer.save()` for the HTTP adapter. `CardSerializer`'s querysets are board-scoped, so a cross-board column, swimlane, label, or assignee id is already a `400` before the service is reached.
- **Serialization.** Each function takes a `render` callable and invokes it *inside* the transaction, because the REST response body and the WebSocket payload are deliberately the same dict. Re-serializing in the adapter after commit would cost a second multi-query fetch and would let a concurrent writer land between the write and the read.

That last point is the one place the boundary is a compromise rather than a clean cut, and it is deliberate: the service stays serializer-agnostic, and the adapter decides what a payload looks like.

## Errors

`boards/services/errors.py` holds one class per failure mode, each carrying the exact HTTP status and response body its endpoint returned before the extraction. A view adapter is therefore a single clause:

```python
def handle_exception(self, exc):
    if isinstance(exc, CardServiceError):
        return Response(exc.body(), status=exc.status)
    return super().handle_exception(exc)
```

The bodies live in that module, rather than being reassembled in the views, because they are a frozen contract and one home for them is the only way to keep them frozen. The card API returns five mutually incompatible `409`/`403` shapes — `wip_limit_exceeded` and `weight_limit_exceeded` carry no `detail` key at all, `wip_hard_blocked` carries both `detail` and `code`, and the move assignee gate is the only `403` in the card API with a `code`. The web client reads those field names directly, so converging the shapes needs a major version bump. `backend/boards/tests/test_card_error_bodies.py` pins every one by exact dictionary equality.

Note that the adapter does **not** wrap these in a DRF `APIException`. DRF coerces every value in an exception detail to a string, which would turn `current_count`, `wip_limit`, `card_weight`, and `current_version` into strings and break clients that compare them numerically.

`boards/services/errors.py` is **not** an extension point and carries no stability guarantee — unlike `boards/hooks.py`. The hierarchy is expected to change when the error bodies are converged.

## Roles

`boards/permissions.py` exposes two resolvers over one shared precedence ladder:

| Function | Use |
|---|---|
| `get_board_role(user, board)` | one board |
| `get_board_roles(user, boards)` | a list of boards, in a fixed two queries |

Resolving a role per board is an N+1 on any board that derives its role from a group, which is why the bulk form exists — and why re-implementing the ladder to dodge that N+1 is what produced the MCP fork. Both resolvers now delegate to the same private helpers; only the way they *load* memberships differs. Boards passed to `get_board_roles` must be loaded with `GROUP_ANCESTOR_SELECT_RELATED` applied, or the ancestor walk reintroduces the N+1 one level down.

`can_modify_others_content()` — the ownership gate — also lives in `permissions.py` rather than in the views package, so a service can call it without importing from `boards.views`.

### The `role` parameter fails closed

Every service function takes an optional `role`, so an adapter that has just resolved the role — `get_board_for_user()` does, as part of its own access check — does not pay for it twice. On a group-inherited board that second resolution is a real query.

A parameter that carries authorization state is only safe if a wrong value cannot be believed, so both resolvers leave a memo on the board instance recording which role they resolved and for whom, and the service accepts a supplied role only when it matches that memo. Anything else is discarded, logged, and the role is derived from the database instead. Two mistakes are therefore impossible rather than merely discouraged: passing `"admin"` outright, and — the likelier one, now that `get_board_roles` returns a `{board_id: role}` dict — indexing that dict with the wrong board id. Both just cost the query the parameter existed to save.

The memo is set by the resolvers alone and is never an input. A caller with no already-resolved role passes `None`, which is always correct.

## Write paths that remain divergent

Two paths deliberately do **not** go through the card service. Both are documented divergences, not oversights.

**Import / export** (`boards/views/import_export.py`) creates cards with `bulk_create` into a board it has just created. It does not enforce WIP or weight limits, does not compact positions, writes one `board.created` broadcast instead of per-card events, and fires no card mutation hooks. Calling a per-card service in a loop would mean O(n) round trips and a row lock per card on a 500-card import. There is a second reason to leave it alone: `bulk_create` does not emit `post_save`, so importing movement history does not notify assignees — routing import through a service that creates `CardMovement` rows individually would send a notification per imported movement.

**Django admin** (`boards/admin.py`, `CardAdmin.save_model`) broadcasts card events but skips the version bump, the `CardMovement` audit trail, WIP and weight enforcement, the board-level RBAC check, and the hooks. An admin moving a card between columns therefore leaves no audit trail. This is the strongest candidate to migrate next — it is a single call site.

## Adding to this layer

Swimlane and column reorder and the other structural mutations are slated to follow in this package, which is why `boards/services/` is a package rather than a single module. When adding a transition:

1. Put the invariants in a service function; leave parsing, validation, and rendering to the caller.
2. Add a class to `errors.py` for each new failure mode — never build a response body in a view.
3. Reach `broadcast` and `hooks` through the **module object** (`from .. import broadcast as _broadcast`). The test suite patches `boards.broadcast.broadcast_board_event` at its source module, and a direct-name import binds a reference the patch cannot reach — so tests that patch only to suppress the channel layer would silently start broadcasting for real.
4. Register hook callbacks by reading `hooks.CARD_MUTATION_HOOKS` inside the `on_commit` callback. Enterprise code appends to that list in place; a copy taken at import time would miss late registrations, and rebinding the attribute would drop every enterprise handler.
5. Add a query budget to `CardMutationQueryCountTests`. Mutation budgets are `measured + 3`, tighter than the 2× used for read endpoints, because they have to catch a constant regression rather than a row-scaling one.

## Frozen asymmetries

Three things in this layer look like bugs and are contract. Do not "fix" them without a major version bump:

- `unarchive` broadcasts the WebSocket event `card.unarchived` but fires the hook event `card.restored`. Both names are independently frozen.
- `card.archived` broadcasts only `{"card_uid": ...}` while `card.unarchived` broadcasts the whole card. A client only needs to drop an archived card from its view.
- `update_card` and `delete_card` reject an archived card; `move_card` accepts one. The move endpoint has always read through the unfiltered manager, so archiving never froze a card's position — a restored card returns to wherever it was put.
- The error bodies described above.
