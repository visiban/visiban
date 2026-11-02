# Add a WebSocket event without breaking the contract
<a id="websocket-event-contract"></a>

Add a board-channel or group-channel event name freely. Renaming or removing one, or removing a field from a payload, needs a major version bump.

**Why it matters:** Visiban's `{event, data}` WebSocket envelope is a public API contract from 1.0, and the `ws-event-reachability` CI job fails when a name is missing from any of the three places below.

**The big picture:** Every event name lives in three places:

| Place | Where |
|---|---|
| **Emitted** | a constant in `backend/boards/broadcast.py` or `backend/groups/broadcast.py`, drawn on by a `broadcast_*_event()` / `record_board_event()` call site |
| **Documented** | a table row in [`docs/api/websockets.md`](../api/websockets.md) |
| **Handled** | an `event.event === "<name>"` branch in `BoardView.tsx` / `GroupDetail.tsx` (or the matching socket hook) |

The `ws-event-reachability` CI job reconciles all three and fails when a name is missing from any of them. A name present in only two of the three looks complete from every angle you would normally check, which is why a machine has to check it.

## Naming rule

Name an event `<subject>.<past-tense verb>`: the subject is snake_case (`invite_link`, `custom_field`), a nested subject adds a dot segment (`group.label.created`), and the verb says what already happened (`created`, `updated`, `deleted`, `revoked`, `removed`). `member.removed` and `invite_link.revoked` follow it. Two kinds of name do not: `board.star_changed` and `group.star_changed` use a compound verb segment (`star_changed`) rather than a single past-tense verb, and `ping` is a bare keepalive. Don't copy these into new names, and don't rename them (a rename is a breaking change). `maintenance_mode.enabled` is not a WebSocket event at all: it is an admin audit-log action name that happens to share the `<subject>.<verb>` shape.

## Adding an event

1. **Declare it.** Add a constant to the registry for the channel it rides, and add that constant to `BOARD_CHANNEL_EVENTS` or `GROUP_CHANNEL_EVENTS`.

    ```python
    # backend/boards/broadcast.py
    EVT_CARD_PINNED = "card.pinned"

    BOARD_CHANNEL_EVENTS: frozenset[str] = frozenset({
        ...,
        EVT_CARD_PINNED,
    })
    ```

2. **Emit it** through the constant, never a literal:

    ```python
    _broadcast.record_board_event(board_id, _broadcast.EVT_CARD_PINNED, payload,
                                 actor_id=request.user.id)
    ```

    A bare string at an emit site fails the gate. The registry has to be the authoritative list, and a literal is invisible to it, including the ones a grep would miss, like `EVT_MEMBER_ADDED if created else EVT_MEMBER_UPDATED`.

3. **Document it.** Add a row to the right channel's table in `docs/api/websockets.md`, with the real `data` shape.

4. **Handle it** in the frontend, or exempt it with a reason (see below).

5. **Decide who may receive it.** Every board-channel frame goes to every subscriber and its feed row to every reader, unless the event is in one of the recipient sets in `backend/boards/permissions.py`:

    - `PER_USER_EVENTS`: one user's own state (stars, saved filters), sent only to the user in `data.user_id`.
    - `ADMIN_ONLY_EVENTS` (since 1.3): admin-only state, sent only to board `admin` and `site_admin` recipients. `share_link.updated` is the first such event.

    The consumer and the change-feed view both read these sets, so adding a name to one covers both surfaces. Keep an admin-only payload's keys out of `ADMIN_ONLY_BOARD_FIELDS`, because those keys are stripped from every payload. See [security invariants Rule 8](security-invariants.md).

## Exempting an event with no frontend handler

Some events are legitimately not acted on by this frontend. For example, a board-channel `board.created` can only reach a client already subscribed to a board that didn't exist a moment earlier. Record it in `INTENTIONALLY_UNHANDLED_BOARD_EVENTS` (or the group equivalent) **with the reason**:

```python
INTENTIONALLY_UNHANDLED_BOARD_EVENTS: dict[str, str] = {
    EVT_BOARD_CREATED: "no client can be subscribed to a board that did not exist ...",
}
```

- **The reason is required:** without it the gate can't tell a considered omission from a forgotten one, and the exemption becomes a rubber stamp.
- **Stale exemptions fail:** an exemption for an event that now *has* a handler fails too. Remove stale exemptions.

## Retiring an event

Never delete a documented name outright. Move it from the channel frozenset to `DEPRECATED_BOARD_EVENTS` / `DEPRECATED_GROUP_EVENTS`, mapping the wire name to the release it was deprecated in, and **keep the docs row**. The deprecation notice has to stand for at least one minor release before the name can go.

The gate enforces both halves: a deprecated name that's still emitted fails, and so does one whose docs row was removed early.

## Running the gate locally

```bash
python scripts/check-ws-event-reachability.py            # reconcile this checkout
python scripts/check-ws-event-reachability.py --self-test  # prove the detectors still fire
bash scripts/tests/check-ws-event-reachability.test.sh     # CLI surface + exit codes
```

Exit codes: `0` everything reconciles, `1` findings, `2` the checker couldn't run (a missing file or an unparseable registry). It fails closed on purpose: "I could not look" must never read as "I looked and it was fine".

CI runs `--self-test` immediately before the real invocation, on the same image. A bespoke gate whose detectors have silently stopped detecting is worse than no gate, because the green tick still reads as a verdict.

## Eviction must not depend on a frame

Every publish is best-effort (#1462). A lost *data* frame is recoverable, because the client resyncs or replays the change feed. A lost frame that the **consumer** acts on isn't, because no client-side resync runs consumer code.

`member.removed` is that kind of frame: it closes the removed user's own socket. So it's only the fast path for eviction:

- `BoardConsumer` and `GroupConsumer` also re-check access before they forward any frame (`_access_close_code`, cached per socket for `ACCESS_RECHECK_SECONDS` plus up to `ACCESS_RECHECK_JITTER_SECONDS` of jitter, so about 7 s at most).
- They use the same predicate as `connect()`, and they close with `4003` when access is gone (#1477).
- A check that raises fails closed too: the frame is dropped and the socket closes with `1011`, which clients reconnect on. With database-backed sessions (the default), `4003` therefore means a definitive denial (#2003).
- **Cache-only sessions** (since 1.3, #2014): the re-check reads the session straight from the cache, so a cache outage on an open socket also closes with `1011`, not `4003`. The handshake is not covered; see #2086.

See [Access re-check and eviction](../api/websockets.md#access-re-check-and-eviction).

**Watch out:** If you add an event that the consumer acts on, and especially one that revokes something, it needs the same backstop. Make sure the consumer reaches a correct state on its own when the frame never arrives.

## What the gate does not cover

- **`CARD_MUTATION_HOOKS`** (`backend/boards/hooks.py`) is a *separate* frozen contract for enterprise add-ons, not the WebSocket surface. The two agree on five card event names and deliberately diverge on one: unarchiving a card broadcasts `card.unarchived` over the socket but fires the hook event `card.restored`. Both strings are frozen independently; neither may be "corrected" to match the other. The mapping table in `hooks.py` is the only place that correspondence is written down.
    - Hook handlers run after commit. A raising handler is logged and swallowed and can't veto or roll back the write.
    - `card.deleted` hooks fire only from `services.cards.delete_card`. Admin card deletes and container cascades fire no hook; consume the [change feed](../api/events.md) to observe them (see [Deleting a container deletes its cards](../api/websockets.md#deleting-a-container-deletes-its-cards)).
- **Payload shapes.** The gate checks only names. A docs row whose `data` column lies about the payload still passes, so keep the row honest when you change a serializer.
