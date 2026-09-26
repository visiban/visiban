# RBAC and broadcast gates

Two CI jobs, `rbac-coverage` and `broadcast-deferral`, assert statically what the
`rbac-check` and `broadcast-check` agent gates previously asserted by reading the diff and
reasoning about it (#1143).

| Job | Script | Asserts |
|---|---|---|
| `rbac-coverage` | `scripts/check-rbac-coverage.py` | Every board/group-scoped endpoint has an authentication gate, resolves the caller's role through the shared resolver, and applies a minimum-role check on every write action |
| `broadcast-deferral` | `scripts/check-broadcast-deferral.py` | Every board/group-scoped write broadcasts; every raw broadcast is deferred to `transaction.on_commit()`; no commit hook holds an ORM row; no emit call sits in a loop over rows of one channel |

Both run in the `test` stage with `needs: []`, take well under a second on the whole
backend, and — like every bespoke gate here — run their own `--self-test` immediately
before the real invocation (see [CI gate self-tests](ci-gates.md)).

## Why these two, and not the agents

Both agents were checking largely mechanical conditions on every relevant MR. The
project already had four precedents for converting exactly that into a deterministic
job — `migration-numbering-check`, `serializer-ts-parity`, `suppressions-check` and
`ws-event-reachability` (#1078) — all grep/AST-based, all comfortably under 30s.

What the conversion actually buys is **not** pipeline time: the sampled pipeline's wall
clock is dominated by `backend-schema-fuzz` and the `backend-test` shards, and two more
sub-second jobs queue into existing slack. What it buys is the agent latency and tokens
removed from the pre-MR gate batch in a development session, plus two things an agent
round-trip cannot give you:

- **It runs on every push, not when someone remembers.** An agent gate fires because a
  human or a harness decided the diff warranted it.
- **Its blind spots are code.** The recorded-exception tables below are grep-able,
  reviewable and blame-able. A paragraph an agent did not write leaves no trace at all.

## What still belongs to the agents

The scripts cover the mechanical conditions and **only** those. These stay with
`rbac-check` and `broadcast-check`, because they require knowing what a resource means:

- Is admin the *right* minimum role for this particular resource? The script asserts that
  *a* gate exists, not that it draws the line in the right place.
- Group-inheritance correctness beyond "the shared resolver was used".
- Cross-board isolation beyond the mechanical lookup-scoping case below.
- The per-recipient field-leak check: does this broadcast payload carry a field the REST
  serializer strips for some roles? That needs the serializer's role logic, not its call
  graph.
- Payload completeness, and whether the right channel was chosen.

Event **naming** and the emitted ↔ documented ↔ handled three-way match are owned by
[`ws-event-reachability`](websocket-event-contract.md) and deliberately not re-checked.

## Exit codes — and why there are four

```
0  clean
1  findings — the gate failed
2  could not run (missing tree, unparseable source, bad usage) — fails closed
3  unhandled pattern — hand it to the agent
```

Exit 2 and exit 3 are the two that matter, and both exist so that *not looking* can never
be mistaken for *looking and finding nothing*. A gate that stops detecting anything does
not fail; it goes green forever and looks exactly like a clean codebase.

**Exit 3 is a failure, not a pass.** It means the script found a view or a broadcast whose
shape it cannot classify — `permission_classes` computed at run time, an
`on_commit(HOOKS[0])` registration, a gate that may live in a module the script does not
read. The CI job fails and tells you which agent to run. After running it you either fix
the gap or record what the agent found in the script's `AGENT_REVIEWED` table. What you
must not do is widen a detector until the defer goes away.

## Recorded exceptions

Neither script carries a suppression comment in the source tree; exceptions live in tables
in the scripts themselves, the same convention `check-serializer-ts-parity.py`'s
`SUPPRESSIONS` follows. Every table is **self-invalidating**: when the condition that made
an entry necessary is gone, the entry itself becomes a finding and asks to be deleted. An
exception cannot outlive its reason.

### `check-rbac-coverage.py`

| Table | Records | The reason must say |
|---|---|---|
| `PUBLIC_BY_DESIGN` | Views with deliberately no authentication gate | What stands in for authentication. "Public" alone is not a design. |
| `VIEWER_PERMITTED_WRITES` | Write actions whose minimum role really is any board member | Why the write is safe for a viewer — in practice, that the row is the caller's own per-user state |
| `AGENT_REVIEWED` | Views the script cannot classify | What the `rbac-check` agent found |

Current entries: the two container health probes and the public share link
(`PUBLIC_BY_DESIGN`); board starring and the two saved-filter actions, all per-user state
(`VIEWER_PERMITTED_WRITES`); the invite-link join flow, where the capability token is the
authorization and no role ladder applies (`AGENT_REVIEWED`).

### `check-broadcast-deferral.py`

| Table | Records | The reason must say |
|---|---|---|
| `NO_BROADCAST_BY_DESIGN` | Writes that deliberately broadcast nothing | Why no other connected client needs to know |
| `LOOP_FANOUT_BY_DESIGN` | Emit calls inside a loop | What the loop iterates — channels, or rows on one channel |
| `AGENT_REVIEWED` | Emit sites the script cannot classify | What the `broadcast-check` agent found |

Current entries: invite-link creation, which has no event type because a group-channel
frame reaches every subscriber and the payload carries the raw token
(`NO_BROADCAST_BY_DESIGN`); and five loops that iterate channels or distinct cards —
admin bulk delete, the blocked-peer fan-out, relation changes, and the post-commit
membership eviction (`LOOP_FANOUT_BY_DESIGN`).

## What `rbac-coverage` checks

Scope: `backend/boards/views/`, `backend/groups/views.py`, `backend/git_lens/views.py`.

`backend/accounts/views.py` is deliberately **out of scope**. It is the
authentication/session surface — login throttles, password reset, email confirmation, PAT
management — governed by per-view rules rather than the admin/member/viewer ladder, with
several views public by design. Auth-surface review stays with `security-review` and the
agent.

1. **Authentication gate.** `permission_classes` resolves to a list containing
   `IsAuthenticated`. A module-level alias (`permission_classes = _BOARD_PERMISSIONS`) is
   resolved; a `get_permissions()` method is read for the same name. Declaring nothing at
   all is a finding: the convention since #989/#1050 is to enumerate the chain explicitly
   so a change to `DEFAULT_PERMISSION_CLASSES` cannot silently drop a gate with no diff.
2. **Membership check.** Every write handler reaches `get_board_for_user`,
   `get_board_role`, `_require_group_*` or another shared resolver — transitively, through
   same-class methods and same-module functions, and through `get_object()` for a viewset
   whose `get_queryset()` is access-scoped. Resolving access from a raw
   `BoardMembership.objects.get()` instead is its own finding: that path skips the
   group-inheritance rungs of the precedence ladder.
3. **Minimum-role check.** Every write action applies a role gate — a comparison against a
   role constant, a `_require_*` helper, or an explicit `role=` hand-off to the services
   layer that owns the ladder (`backend/boards/services/cards.py`).
4. **Cross-board isolation, mechanical slice.** A `get_object_or_404(Card, pk=pk)` on a
   model with a direct `board` or `card` foreign key, with no scoping keyword and no
   pre-filtered queryset, is a cross-board IDOR: the pk space is global, the resource is
   not. The scoped-model set is derived from `backend/boards/models.py` at run time, so a
   new board-scoped model is covered the first time the gate runs after it lands.

Two traps worth knowing, because both produced a *silently clean* gate while it was being
written, which is the exact failure class this page exists to guard against:

- `if self._cached_board_role is None:` — the per-request cache probe every board-scoped
  viewset opens with — mentions `role` and is emphatically not a role gate. A comparison
  whose only comparator is `None`/`True`/`False` is never treated as one.
- `ast.walk` on a `FunctionDef` descends into its `@action(...)` and `@extend_schema(...)`
  decorators. Counting those made every decorated action look as though its gate might be
  hiding inside `action()`.

## What `broadcast-deferral` checks

Scope: `backend/boards`, `backend/groups`, `backend/git_lens`, excluding tests, migrations
and seed data. The call graph is built over all of it, so a view handler that delegates to
the services layer is resolved rather than guessed at.

1. **Every write broadcasts.** A write handler on a board/group-scoped view reaches
   `broadcast_board_event` / `broadcast_group_event` / `record_board_event` on some path.
2. **Every broadcast is deferred.** A raw `broadcast_*_event()` sits inside a callable
   registered with `transaction.on_commit()` — transitively, so
   `on_commit(lambda: _broadcast_star(starred=True))` defers everything `_broadcast_star`
   does. `record_board_event` satisfies this by construction: it persists the feed row in
   the caller's transaction and registers the deferred publish itself, which is why it is
   the preferred form.
3. **No ORM instance in a commit hook.** A hook that reads a live row out of the enclosing
   scope carries an object that may be stale by the time the hook fires. The payload is
   built inside the atomic block and captured through default arguments
   (`def _send(bid=board_id, pl=payload):`). The script only reports a free variable it
   can *show* holds an ORM row — assigned from a manager call, or a handler parameter named
   `board`/`card`/`instance`/… — so a plain int read from the enclosing scope is untidy but
   not a finding.
4. **No broadcast storm.** An emit inside a `for`/`while` is a finding unless the loop is
   recorded in `LOOP_FANOUT_BY_DESIGN` with the channels it iterates.

The trap here: resolving every call by bare name alone made `instance.delete()` in
`LabelViewSet.perform_destroy` edge to `LensConnectionView.delete`, which *does* broadcast
— so a handler that broadcast nothing came back clean. A method on a name the function
itself bound is never a call into the module-level call graph.

## Running them

```bash
python3 scripts/check-rbac-coverage.py                  # scan the real tree
python3 scripts/check-rbac-coverage.py --self-test      # prove the detectors still fire
python3 scripts/check-broadcast-deferral.py
python3 scripts/check-broadcast-deferral.py --self-test

bash scripts/tests/check-rbac-coverage.test.sh          # CLI surface + exit codes
bash scripts/tests/check-broadcast-deferral.test.sh
```

`--root DIR` points either script at a tree other than the checkout it lives in; that is
how the test wrappers build drifted copies without touching the working tree.

`check-broadcast-deferral.py` loads its Django/DRF AST primitives from
`check-rbac-coverage.py` by file path rather than restating them. #1107's lesson in this
repository is explicit about the alternative: `mcp_server/tools.py` once carried a second
copy of the role-precedence rules under a "must be kept in step with it" comment, which
was an admission that nothing enforced it.

## Not done here

The `CLAUDE.md` pre-MR gate cluster still lists `rbac-check` and `broadcast-check` as
agent calls. That instruction lives in the user's global `~/.claude/CLAUDE.md`, not in this
repository, so no merge request against this repo can change it — and #1143 gates the
change on "once both scripts are trusted" in any case. Narrow the agent invocations once
these jobs have a few releases of clean runs behind them; until then, running both is
belt and braces rather than waste.
