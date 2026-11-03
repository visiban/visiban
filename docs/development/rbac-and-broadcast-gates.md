# Two CI jobs now check RBAC coverage and broadcast deferral
<a id="rbac-and-broadcast-gates"></a>

Run `python3 scripts/check-rbac-coverage.py` and `python3 scripts/check-broadcast-deferral.py` to run what `rbac-coverage` and `broadcast-deferral` run in CI. They assert statically what the `rbac-check` and `broadcast-check` agent gates previously asserted by reading the diff and reasoning about it (#1143).

**Why it matters:** They run on every push, in well under a second, instead of when someone remembers to invoke an agent.

**Yes, but:** The scripts cover the mechanical conditions **only**. Judgment calls stay with the agents; see [What still belongs to the agents](#what-still-belongs-to-the-agents).

| Job | Script | Asserts |
|---|---|---|
| `rbac-coverage` | `scripts/check-rbac-coverage.py` | Every board/group-scoped endpoint has an authentication gate, resolves the caller's role through the shared resolver, and applies a minimum-role check on every write action |
| `broadcast-deferral` | `scripts/check-broadcast-deferral.py` | Every board/group-scoped write broadcasts; every raw broadcast is deferred to `transaction.on_commit()`; no commit hook holds an ORM row; no emit call sits in a loop over rows of one channel |

Both run in the `test` stage with `needs: []`, and, like every bespoke gate here, run their own `--self-test` immediately before the real invocation (see [CI gate self-tests](ci-gates.md)). Each script takes well under a second on the whole backend. The `rbac-coverage` job also runs `scripts/tests/check-rbac-coverage.test.sh`, which adds a few seconds.

## Running them

```bash
python3 scripts/check-rbac-coverage.py                  # scan the real tree
python3 scripts/check-rbac-coverage.py --self-test      # prove the detectors still fire
python3 scripts/check-broadcast-deferral.py
python3 scripts/check-broadcast-deferral.py --self-test

bash scripts/tests/check-rbac-coverage.test.sh          # CLI surface + exit codes
bash scripts/tests/check-broadcast-deferral.test.sh
```

- **`--root DIR`** points either script at a tree other than the checkout it lives in. The test wrappers use it to build drifted copies without touching the working tree.
- **Shared primitives:** `check-broadcast-deferral.py` loads its Django/DRF AST primitives from `check-rbac-coverage.py` by file path rather than restating them. #1107's lesson: `mcp_server/tools.py` once carried a second copy of the role-precedence rules under a "must be kept in step with it" comment, which was an admission that nothing enforced it.

## Why these two, and not the agents

Both agents were checking largely mechanical conditions on every relevant MR. The project already had four precedents for converting exactly that into a deterministic job: `migration-numbering-check`, `serializer-ts-parity`, `suppressions-check` and `ws-event-reachability` (#1078). All are grep/AST-based, all comfortably under 30s.

The conversion does **not** buy pipeline time. The sampled pipeline's wall clock is dominated by `backend-schema-fuzz` and the `backend-test` shards, and two more sub-second jobs queue into existing slack. It buys the agent latency and tokens removed from the pre-MR gate batch in a development session, plus two things an agent round-trip can't give you:

- **It runs on every push, not when someone remembers.** An agent gate fires because a human or a harness decided the diff warranted it.
- **Its blind spots are code.** The recorded-exception tables below are grep-able, reviewable and blame-able. A paragraph an agent didn't write leaves no trace at all.

## What still belongs to the agents

The scripts cover the mechanical conditions and **only** those. These stay with `rbac-check` and `broadcast-check`, because they require knowing what a resource means:

- Is admin the *right* minimum role for this particular resource? The script asserts that *a* gate exists, not that it draws the line in the right place.
- Group-inheritance correctness beyond "the shared resolver was used".
- Cross-board isolation beyond the mechanical lookup-scoping case below.
- The per-recipient field-leak check: does this broadcast payload carry a field the REST serializer strips for some roles? That needs the serializer's role logic, not its call graph.
- Payload completeness, and whether the right channel was chosen.

Event **naming** and the emitted ↔ documented ↔ handled three-way match are owned by [`ws-event-reachability`](websocket-event-contract.md) and deliberately not re-checked.

## Exit codes — and why there are four

```
0  clean
1  findings — the gate failed
2  could not run (missing tree, unparseable source, bad usage) — fails closed
3  unhandled pattern — hand it to the agent
```

Exit 2 and exit 3 exist so that *not looking* can never be mistaken for *looking and finding nothing*. A gate that stops detecting anything doesn't fail; it goes green forever and looks exactly like a clean codebase.

**Exit 3 is a failure, not a pass.** It means the script found a view or a broadcast whose shape it can't classify: `permission_classes` computed at run time, an `on_commit(HOOKS[0])` registration, a gate that may live in a module the script doesn't read.

- The CI job fails and tells you which agent to run.
- After running it, either fix the gap or record what the agent found in the script's `AGENT_REVIEWED` table.
- **Never** widen a detector until the defer goes away.

## Recorded exceptions

Neither script carries a suppression comment in the source tree. Exceptions live in tables in the scripts themselves, the same convention `check-serializer-ts-parity.py`'s `SUPPRESSIONS` follows. Every table is **self-invalidating**: when the condition that made an entry necessary is gone, the entry itself becomes a finding and asks to be deleted. An exception can't outlive its reason.

### `check-rbac-coverage.py`

| Table | Records | The reason must say |
|---|---|---|
| `PUBLIC_BY_DESIGN` | Views with deliberately no authentication gate | What stands in for authentication. "Public" alone isn't a design. |
| `VIEWER_PERMITTED_WRITES` | Write actions whose minimum role is any board member | Why the write is safe for a viewer — in practice, that the row is the caller's own per-user state |
| `AGENT_REVIEWED` | Views or handlers the script can't classify, or reports a finding on although the role ladder doesn't apply | Who reviewed it and what they found |

Current entries:

- **`PUBLIC_BY_DESIGN`:** the two container health probes and the public share link.
- **`VIEWER_PERMITTED_WRITES`:** board and group starring and the two saved-filter actions, all per-user state.
- **`AGENT_REVIEWED`:** the invite-link join flows, where the capability token is the authorization and no role ladder applies; site-admin lens usage telemetry; and board creation and the two board imports, which write only to a board they create and gate group placement on group admin.

### `check-broadcast-deferral.py`

| Table | Records | The reason must say |
|---|---|---|
| `NO_BROADCAST_BY_DESIGN` | Writes that deliberately broadcast nothing | Why no other connected client needs to know |
| `LOOP_FANOUT_BY_DESIGN` | Emit calls inside a loop | What the loop iterates — channels, or rows on one channel |
| `AGENT_REVIEWED` | Emit sites the script can't classify | What the `broadcast-check` agent found |

Current entries:

- **`NO_BROADCAST_BY_DESIGN`:** invite-link creation, which has no event type because a group-channel frame reaches every subscriber and the payload carries the raw token.
- **`LOOP_FANOUT_BY_DESIGN`:** loops that iterate channels or distinct rows, each frame carrying that row's own payload: admin bulk delete, the blocked-peer fan-out, relation changes, the post-commit membership eviction, the invite-link and share-link revocations, and the column-delete swimlane prune (one `swimlane.updated` per swimlane whose counted columns lost the column, #1150).

## What `rbac-coverage` checks

Scope: `backend/boards/views/`, `backend/groups/views.py`, `backend/git_lens/views.py`, `backend/webhooks/views.py`. That includes plain mixins that contribute handlers to a viewset, such as `BoardImportExportMixin` and `BoardInviteLinksMixin`. A class counts as one if its name ends in `Mixin` or it carries an `@action`. Its authentication gate is the viewset's, so only checks 2 and 3 apply to it.

`backend/accounts/views.py` is deliberately **out of scope**. It's the authentication/session surface (login throttles, password reset, email confirmation, PAT management), governed by per-view rules rather than the admin/member/viewer ladder, with several views public by design. Auth-surface review stays with `security-review` and the agent.

1. **Authentication gate.** `permission_classes` resolves to a list containing `IsAuthenticated`.
    - A module-level alias (`permission_classes = _BOARD_PERMISSIONS`) is resolved; a `get_permissions()` method is read for the same name.
    - Declaring nothing at all is a finding. The convention since #989/#1050 is to enumerate the chain explicitly, so a change to `DEFAULT_PERMISSION_CLASSES` can't silently drop a gate with no diff.
2. **Membership check.** Every write handler reaches `get_board_for_user`, `get_board_role`, `_require_group_*` or another shared resolver. The search is transitive, through same-class methods and same-module functions, and through `get_object()` for a viewset whose `get_queryset()` is access-scoped. Resolving access from a raw `BoardMembership.objects.get()` instead is its own finding, because that path skips the group-inheritance rungs of the precedence ladder.
3. **Minimum-role check.** Every write action applies a role gate: a comparison against a role constant, an imported helper named in `GATE_CALL_NAMES`, or an explicit `role=` hand-off to the services layer that owns the ladder (`backend/boards/services/cards.py`).
    - Imported helpers count by exact name, not by a `require_` prefix: `require_json_object` and `_require_session` start the same way as a role gate and check nothing about the caller's role.
    - A same-module helper never counts on its name. It is walked, so its own comparison counts and an emptied one doesn't. An imported helper off the list defers to the agent.
    - `_require_group_member` doesn't satisfy this check, because a group viewer passes it. A write whose minimum role really is any member belongs in `VIEWER_PERMITTED_WRITES`.
    - `role=` is a hand-off only on a callee in `ROLE_DELEGATION_ROOTS` (`card_services`). `BoardMembership.objects.create(role=...)` and `GroupInviteLink.generate(role=...)` write a row's role and aren't.
4. **Cross-board isolation, mechanical slice.** A `get_object_or_404(Card, pk=pk)` on a model with a direct `board` or `card` foreign key, with no scoping keyword and no pre-filtered queryset, is a cross-board IDOR: the pk space is global, the resource isn't. The scoped-model set is derived from `backend/boards/models.py` at run time, so a new board-scoped model is covered the first time the gate runs after it lands.

**Watch out:** Two traps produced a *silently clean* gate while it was being written, the exact failure class this page exists to guard against:

- `if self._cached_board_role is None:` is the per-request cache probe every board-scoped viewset opens with. It mentions `role` and is emphatically not a role gate. A comparison whose only comparator is `None`/`True`/`False` is never treated as one.
- `ast.walk` on a `FunctionDef` descends into its `@action(...)` and `@extend_schema(...)` decorators. Counting those made every decorated action look as though its gate might be hiding inside `action()`.

## What `broadcast-deferral` checks

Scope: `backend/boards`, `backend/groups`, `backend/git_lens`, excluding tests, migrations and seed data. The call graph is built over all of it, so a view handler that delegates to the services layer is resolved rather than guessed at.

1. **Every write broadcasts.** A write handler on a board/group-scoped view reaches `broadcast_board_event` / `broadcast_group_event` / `record_board_event` on some path.
2. **Every broadcast is deferred.** A raw `broadcast_*_event()` sits inside a callable registered with `transaction.on_commit()`. The check is transitive, so `on_commit(lambda: _broadcast_star(starred=True))` defers everything `_broadcast_star` does. `record_board_event` satisfies this by construction: it persists the feed row in the caller's transaction and registers the deferred publish itself, which is why it's the preferred form.
3. **No ORM instance in a commit hook.** A hook that reads a live row out of the enclosing scope carries an object that may be stale by the time the hook fires. Build the payload inside the atomic block and capture it through default arguments (`def _send(bid=board_id, pl=payload):`). The script only reports a free variable it can *show* holds an ORM row (assigned from a manager call, or a handler parameter named `board`/`card`/`instance`/…), so a plain int read from the enclosing scope is untidy but not a finding.
4. **No broadcast storm.** An emit inside a `for`/`while` is a finding unless the loop is recorded in `LOOP_FANOUT_BY_DESIGN` with the channels it iterates.

**Watch out:** Resolving every call by bare name alone made `instance.delete()` in `LabelViewSet.perform_destroy` edge to `LensConnectionView.delete`, which *does* broadcast, so a handler that broadcast nothing came back clean. A method on a name the function itself bound is never a call into the module-level call graph.

## Not done here

The `CLAUDE.md` pre-MR gate cluster still lists `rbac-check` and `broadcast-check` as agent calls. That instruction lives in the user's global `~/.claude/CLAUDE.md`, not in this repository, so no merge request against this repo can change it. #1143 also gates the change on "once both scripts are trusted". Narrow the agent invocations once these jobs have a few releases of clean runs behind them. Until then, running both is belt and braces rather than waste.
