# WebSocket event contract

Visiban's `{event, data}` WebSocket envelope is a public API contract from 1.0. A
board-channel or group-channel event name may be **added** freely; renaming or removing
one, or removing a field from a payload, is a breaking change that requires a major
version bump.

Every event name lives in three places:

| Place | Where |
|---|---|
| **Emitted** | a constant in `backend/boards/broadcast.py` or `backend/groups/broadcast.py`, drawn on by a `broadcast_*_event()` / `record_board_event()` call site |
| **Documented** | a table row in [`docs/api/websockets.md`](../api/websockets.md) |
| **Handled** | an `event.event === "<name>"` branch in `BoardView.tsx` / `GroupDetail.tsx` (or the matching socket hook) |

The `ws-event-reachability` CI job reconciles all three and fails when a name is missing
from any of them. A name present in only two of the three looks complete from every angle
you would normally check — which is exactly why it needs a machine to check it.

## Adding an event

1. **Declare it.** Add a constant to the registry for the channel it rides, and add that
   constant to `BOARD_CHANNEL_EVENTS` or `GROUP_CHANNEL_EVENTS`.

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

    A bare string at an emit site fails the gate. The registry has to be the authoritative
    list, and a literal is invisible to it — including the ones a grep would miss, like
    `EVT_MEMBER_ADDED if created else EVT_MEMBER_UPDATED`.

3. **Document it** — add a row to the right channel's table in `docs/api/websockets.md`,
   with the real `data` shape.

4. **Handle it** in the frontend, or exempt it with a reason (see below).

## Exempting an event with no frontend handler

Some events are legitimately not acted on by this frontend — for example a board-channel
`board.created`, which can only reach a client already subscribed to a board that did not
exist a moment earlier. Record it in `INTENTIONALLY_UNHANDLED_BOARD_EVENTS` (or the group
equivalent) **with the reason**:

```python
INTENTIONALLY_UNHANDLED_BOARD_EVENTS: dict[str, str] = {
    EVT_BOARD_CREATED: "no client can be subscribed to a board that did not exist ...",
}
```

The reason is not decoration: without it the gate cannot tell a considered omission from a
forgotten one, and the exemption becomes a rubber stamp. An exemption for an event that
now *has* a handler also fails — stale exemptions are removed, not left lying around.

## Retiring an event

Never delete a documented name outright. Move it from the channel frozenset to
`DEPRECATED_BOARD_EVENTS` / `DEPRECATED_GROUP_EVENTS`, mapping the wire name to the
release it was deprecated in, and **keep the docs row** — the deprecation notice has to
stand for at least one minor release before the name can go. The gate enforces both
halves: a deprecated name that is still emitted fails, and so does one whose docs row was
removed early.

## Running the gate locally

```bash
python scripts/check-ws-event-reachability.py            # reconcile this checkout
python scripts/check-ws-event-reachability.py --self-test  # prove the detectors still fire
bash scripts/tests/check-ws-event-reachability.test.sh     # CLI surface + exit codes
```

Exit codes: `0` everything reconciles, `1` findings, `2` the checker could not run (a
missing file or an unparseable registry). It fails closed on purpose — "I could not look"
must never read as "I looked and it was fine".

CI runs `--self-test` immediately before the real invocation, on the same image. A bespoke
gate whose detectors have silently stopped detecting is worse than no gate, because the
green tick still reads as a verdict.

## What the gate does not cover

`CARD_MUTATION_HOOKS` (`backend/boards/hooks.py`) is a *separate* frozen contract for
enterprise add-ons, and it is not the WebSocket surface. The two agree on five card event
names and deliberately diverge on one: unarchiving a card broadcasts `card.unarchived`
over the socket but fires the hook event `card.restored`. Both strings are frozen
independently; neither may be "corrected" to match the other. The mapping table in
`hooks.py` is the only place that correspondence is written down.

The gate also does not check payload *shapes* — only names. A docs row whose `data` column
lies about the payload still passes, so keep the row honest when you change a serializer.
