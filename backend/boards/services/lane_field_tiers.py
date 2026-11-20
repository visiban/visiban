"""Swimlane field tiers: Band, Details, Hidden (#2439).

One rule, two implementations: this module and ``resolveLaneTiers`` in
``frontend/src/utils/laneBand.ts``. ``boards/tests/fixtures/lane_field_tiers.json``
pins both to the same answers, so a change to one that the other does not
follow fails a test on each side.

``band_visibility`` is NULL on every row written before #2439. Three board
states follow from that:

* **Legacy** (every row NULL): the band keeps today's per-lane rule (the first
  two non-empty values), so an existing board renders identically. For the
  settings panel the tiers are derived from position: the first two are Band and
  the rest Details, with no cap, since nothing has been capped yet.
* **Materialized** (no row NULL): every row says where it goes, and a reorder
  never moves a field between tiers.
* **Mixed** (an older pod created a NULL row on a materialized board during a
  rolling deploy): a NULL row is never Band, because that could silently push the
  band over two. It fills Details in position order up to the cap, then Hidden.

The first write that affects tiers (a ``band_visibility`` PATCH or a cap change)
calls :func:`materialize` under the board row lock, writing an explicit tier to
every NULL row, so the board leaves the legacy state exactly once.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from rest_framework import serializers

BAND = "band"
DETAILS = "details"
HIDDEN = "hidden"
TIERS = (BAND, DETAILS, HIDDEN)
#: The band's slot count; the same number as ``INLINE_FIELD_COUNT`` on the frontend.
BAND_MAX = 2

BAND_FULL_MESSAGE = "The band holds 2 fields. Move one to Details first."


def details_full_message(cap: int) -> str:
    return f"Lane details hold {cap} fields. Move one to Hidden first, or raise the limit."


def _get(d: Any, attr: str):
    return d[attr] if isinstance(d, dict) else getattr(d, attr)


def _ordered(defs: Iterable[Any]) -> list[Any]:
    # (position, id): the model's Meta.ordering, so a tie (never legal, but a
    # fixture can state one) breaks the same way on both sides.
    return sorted(defs, key=lambda d: (_get(d, "position"), _get(d, "id")))


def is_legacy(defs: Iterable[Any]) -> bool:
    """True when no row carries an explicit tier (an empty board is legacy too)."""
    return all(_get(d, "band_visibility") is None for d in defs)


def resolve_tiers(defs: Iterable[Any], cap: int) -> dict[Any, str]:
    """The effective tier of every definition, keyed by id.

    Read-only: what the settings panel and a materialized band show. See the
    module docstring for the legacy and mixed rules.
    """
    ordered = _ordered(defs)
    if is_legacy(ordered):
        return {_get(d, "id"): (BAND if i < BAND_MAX else DETAILS) for i, d in enumerate(ordered)}
    details_used = sum(1 for d in ordered if _get(d, "band_visibility") == DETAILS)
    out: dict[Any, str] = {}
    for d in ordered:
        tier = _get(d, "band_visibility")
        if tier is None:
            # Never Band (see the mixed rule above).
            if details_used < cap:
                tier = DETAILS
                details_used += 1
            else:
                tier = HIDDEN
        out[_get(d, "id")] = tier
    return out


def materialized_tiers(defs: Iterable[Any], cap: int) -> dict[Any, str]:
    """The tiers :func:`materialize` writes: unlike :func:`resolve_tiers`, a
    legacy board is capped (first two Band, the next up to *cap* Details, the
    rest Hidden), because once tiers are explicit the cap is enforced."""
    ordered = _ordered(defs)
    if not is_legacy(ordered):
        return resolve_tiers(ordered, cap)
    out = {}
    for i, d in enumerate(ordered):
        if i < BAND_MAX:
            out[_get(d, "id")] = BAND
        elif i < BAND_MAX + cap:
            out[_get(d, "id")] = DETAILS
        else:
            out[_get(d, "id")] = HIDDEN
    return out


def materialize(board, *, cap: int | None = None, actor_id=None) -> list:
    """Write an explicit tier to every NULL row of *board*; return the changed rows.

    The caller holds the board row lock: every definition create, update,
    delete and reorder takes it first, so the set of rows cannot change between
    the read and the writes here. Each changed row emits one
    ``swimlane_custom_field.updated`` event (at most ``MAX_PER_BOARD``) through
    ``record_board_event``, which defers to ``on_commit``, so a request that
    materializes and then fails its own check (a 400 after this) rolls the
    writes and the events back together.
    """
    from boards import broadcast as _broadcast
    from boards.models import SwimlaneCustomFieldDefinition
    from boards.serializers import SwimlaneCustomFieldDefinitionSerializer

    defs = list(SwimlaneCustomFieldDefinition.objects.filter(board=board))
    if not any(d.band_visibility is None for d in defs):
        return []
    tiers = materialized_tiers(defs, board.lane_details_cap if cap is None else cap)
    changed = []
    for d in defs:
        if d.band_visibility is None:
            d.band_visibility = tiers[d.id]
            changed.append(d)
    SwimlaneCustomFieldDefinition.objects.bulk_update(changed, ["band_visibility"])
    for d in changed:
        _broadcast.record_board_event(
            board.id,
            _broadcast.EVT_SWIMLANE_CUSTOM_FIELD_UPDATED,
            SwimlaneCustomFieldDefinitionSerializer(d).data,
            actor_id=actor_id,
        )
    return changed


def check_tier_counts(tiers: Iterable[str], cap: int, *, field: str = "band_visibility") -> None:
    """Raise a 400 when *tiers* put more than two fields on the band or more than *cap* in details."""
    tiers = list(tiers)
    if tiers.count(BAND) > BAND_MAX:
        raise serializers.ValidationError({field: BAND_FULL_MESSAGE})
    if tiers.count(DETAILS) > cap:
        raise serializers.ValidationError({field: details_full_message(cap)})


def assert_band_tiers(board, *, instance, band_visibility) -> None:
    """At most two Band fields and at most ``lane_details_cap`` Details (#2439).

    One rule, two call sites: the serializer's ``validate()`` (an early 400
    against a pre-lock snapshot) and the viewset's locked recheck (exact). The
    board's rows are projected as if materialized, then *instance* (None for a
    create) takes *band_visibility*. A NULL *band_visibility* is the derived
    tier, so it can never break the rule by itself; it is still projected, to
    catch a board already over (which a pre-#2439 board can be after a cap
    change elsewhere).

    *board* is required: a caller without one cannot count, and this raises
    rather than passing (#1075).
    """
    from boards.models import SwimlaneCustomFieldDefinition

    if board is None:
        raise serializers.ValidationError(
            {"band_visibility": "A board is required to check swimlane field tiers."}
        )
    rows = [
        {"id": d.pk, "position": d.position, "band_visibility": d.band_visibility}
        for d in SwimlaneCustomFieldDefinition.objects.filter(board=board)
        if instance is None or d.pk != instance.pk
    ]
    cap = board.lane_details_cap
    projected = materialized_tiers(rows, cap)
    if band_visibility is None:
        return
    check_tier_counts([*projected.values(), band_visibility], cap)


def default_tier_for_create(board) -> str | None:
    """The tier a create that sends none gets (#2439).

    NULL on a legacy board (the board stays legacy). On a materialized board,
    Details while there is room, else Hidden: never a 400, so an older client
    that does not know the field can still add one.
    """
    from boards.models import SwimlaneCustomFieldDefinition

    rows = list(SwimlaneCustomFieldDefinition.objects.filter(board=board).values("id", "position", "band_visibility"))
    if is_legacy(rows):
        return None
    tiers = resolve_tiers(rows, board.lane_details_cap)
    return DETAILS if list(tiers.values()).count(DETAILS) < board.lane_details_cap else HIDDEN


def recheck_lane_details_cap(board, new_cap: int, *, actor_id=None) -> None:
    """A board cap change, under the board row lock: materialize, then refuse a
    cap below the current Details count (the settings select disables those
    options, so this is the race and old-client path)."""
    from boards.models import SwimlaneCustomFieldDefinition

    materialize(board, cap=new_cap, actor_id=actor_id)
    details = SwimlaneCustomFieldDefinition.objects.filter(
        board=board, band_visibility=DETAILS
    ).count()
    if details > new_cap:
        raise serializers.ValidationError({
            "lane_details_cap": (
                f"{details} fields are in lane details. Move some to Hidden "
                f"before lowering the limit to {new_cap}."
            )
        })
