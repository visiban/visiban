"""Swimlane field tiers: Band, Details, Hidden (#2439).

One rule, two implementations: this module and ``resolveLaneTiers`` in
``frontend/src/utils/laneBand.ts``. ``boards/tests/fixtures/lane_field_tiers.json``
pins both to the same answers, so a change to one that the other does not
follow fails a test on each side.

``band_visibility`` is NULL on every row written before #2439. Three board
states follow from that:

* **Unset** (every row NULL, #2658): tiers derive from position, the first two
  Band and the rest Details. The owner decided on !1979 ("Yes, switch now") that
  such a board shows the tiered band at once, not the pre-#2439 band, and ("Grow
  cap to fit") that nothing goes to Hidden on the way: the cap it resolves with is
  :func:`effective_cap`, the smallest of ``LANE_DETAILS_CAP_OPTIONS`` that holds
  every field past the first two (never below the stored cap). Only past 2 + 16
  fields does the rest go to Hidden.
* **Materialized** (no row NULL): every row says where it goes, and a reorder
  never moves a field between tiers.
* **Mixed** (an older pod created a NULL row on a materialized board during a
  rolling deploy): a NULL row is never Band, because that could silently push the
  band without an admin choosing it. It fills Details in position order up to the cap, then Hidden.

#2658 resolves an unset board at read time (approach b) rather than with a data
migration: there is no lock on any table, no migration, and ``band_visibility``
and ``lane_details_cap`` keep their types. The first write that affects tiers (a
``band_visibility`` PATCH, a field create or a cap change) calls
:func:`materialize` under the board row lock, which writes exactly what the read
resolved (every NULL row's tier, and the grown cap), so the board leaves the
unset state once and looks the same before and after.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from rest_framework import serializers

BAND = "band"
DETAILS = "details"
HIDDEN = "hidden"
TIERS = (BAND, DETAILS, HIDDEN)
#: How many fields are Band with no admin choice (a legacy board, and what
#: materializing one writes); ``BAND_DEFAULT_COUNT`` on the frontend.
BAND_DEFAULT = 2
#: The most fields an admin may mark Band (#2663); ``BAND_MAX_COUNT`` on the
#: frontend. How many of them a screen shows is a client-side, width-based
#: choice that never changes a stored tier.
BAND_MAX = 6

#: The lane details cap choices, ``Board.LANE_DETAILS_CAP_CHOICES``;
#: ``LANE_DETAILS_CAP_OPTIONS`` on the frontend.
LANE_DETAILS_CAP_OPTIONS = (4, 6, 9, 12, 16)

BAND_FULL_MESSAGE = f"The band holds {BAND_MAX} fields. Move one to Details first."


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


def cap_to_fit(details_count: int, cap: int) -> int:
    """The smallest cap option that holds *details_count*, never below *cap* (#2658).

    Past the largest option the largest one: the rest go to Hidden. The cap only
    grows here, so a cap an admin set higher is kept.
    """
    fit = next((o for o in LANE_DETAILS_CAP_OPTIONS if o >= details_count), LANE_DETAILS_CAP_OPTIONS[-1])
    return max(cap, fit)


def effective_cap(defs: Iterable[Any], cap: int) -> int:
    """The cap *defs* resolve with: grown to fit on an unset board, else *cap*.

    ``effectiveLaneDetailsCap`` on the frontend. Counts every definition, admin
    only or not, so every viewer resolves the same tiers.
    """
    defs = list(defs)
    if not is_legacy(defs):
        return cap
    return cap_to_fit(max(0, len(defs) - BAND_DEFAULT), cap)


def resolve_tiers(defs: Iterable[Any], cap: int) -> dict[Any, str]:
    """The effective tier of every definition, keyed by id.

    Read-only, and exactly what :func:`materialize` writes. An unset board: the
    first two Band, the next :func:`effective_cap` Details, the rest Hidden. See
    the module docstring for the mixed rule.
    """
    ordered = _ordered(defs)
    if is_legacy(ordered):
        grown = effective_cap(ordered, cap)
        return {
            _get(d, "id"): (BAND if i < BAND_DEFAULT else DETAILS if i < BAND_DEFAULT + grown else HIDDEN)
            for i, d in enumerate(ordered)
        }
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


def materialize(board, *, cap: int | None = None, actor_id=None) -> list:
    """Write an explicit tier to every NULL row of *board*; return the changed rows.

    The caller holds the board row lock: every definition create, update,
    delete and reorder takes it first, so the set of rows cannot change between
    the read and the writes here. Each changed row emits one
    ``swimlane_custom_field.updated`` event (at most ``MAX_PER_BOARD``) through
    ``record_board_event``, which defers to ``on_commit``, so a request that
    materializes and then fails its own check (a 400 after this) rolls the
    writes and the events back together.

    "Grow cap to fit" (#2658): on an unset board the tiers are resolved with
    :func:`effective_cap`, and when that is above the stored cap this writes it
    to ``Board.lane_details_cap`` and sends ``board.updated`` on commit, so the
    cap the board read with is the cap it keeps. ``board.updated`` is recorded
    before the row events, so other clients never apply a row with the old cap. With *cap* given (a cap change,
    whose caller saves *cap* itself) the cap is not written here: either it
    already fits, or the caller's Details-count recheck refuses it.
    """
    from boards import broadcast as _broadcast
    from boards.models import Board, SwimlaneCustomFieldDefinition
    from boards.serializers import SwimlaneCustomFieldDefinitionSerializer

    defs = list(SwimlaneCustomFieldDefinition.objects.filter(board=board))
    if not any(d.band_visibility is None for d in defs):
        return []
    # Re-read under the caller's lock: *board* may predate it, and growing from
    # a stale cap could lower one an admin raised meanwhile.
    stored = Board.objects.filter(pk=board.pk).values_list("lane_details_cap", flat=True).get()
    board.lane_details_cap = stored
    tiers = resolve_tiers(defs, stored if cap is None else cap)
    # Read before the rows get their tiers: grows only on an unset board.
    grown = effective_cap(defs, stored) if cap is None else stored
    if grown > stored:
        # Before the row events: a client applies each frame as it arrives, so the
        # grown cap must already be there when the first row leaves the unset state,
        # or the rows past the stored cap would show as Hidden in between.
        from .board_events import record_board_updated, system_board_payload

        # A queryset update: no save() side effects, and the instance follows
        # so a later check (assert_band_tiers) counts against the grown cap.
        Board.objects.filter(pk=board.pk).update(lane_details_cap=grown)
        board.lane_details_cap = grown
        record_board_updated(
            board.pk, system_board_payload(board.pk),
            old_group_id=board.group_id, new_group_id=board.group_id, actor_id=actor_id,
        )
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
    """Raise a 400 when *tiers* put more than ``BAND_MAX`` fields on the band or more than *cap* in details."""
    tiers = list(tiers)
    if tiers.count(BAND) > BAND_MAX:
        raise serializers.ValidationError({field: BAND_FULL_MESSAGE})
    if tiers.count(DETAILS) > cap:
        raise serializers.ValidationError({field: details_full_message(cap)})


def assert_band_tiers(board, *, instance, band_visibility) -> None:
    """At most ``BAND_MAX`` Band fields and at most ``lane_details_cap`` Details (#2439).

    One rule, two call sites: the serializer's ``validate()`` (an early 400
    against a pre-lock snapshot) and the viewset's locked recheck (exact). The
    board's rows are projected as if materialized, then *instance* (None for a
    create) takes *band_visibility*. A NULL *band_visibility* is the derived
    tier, which is never Band and fills Details only while there is room, so it
    cannot break the rule and is not checked.

    *board* is required: a caller without one cannot count, and this raises
    rather than passing (#1075).
    """
    from boards.models import SwimlaneCustomFieldDefinition

    if board is None:
        raise serializers.ValidationError(
            {"band_visibility": "A board is required to check swimlane field tiers."}
        )
    if band_visibility is None:
        return
    rows = [
        {"id": d.pk, "position": d.position, "band_visibility": d.band_visibility}
        for d in SwimlaneCustomFieldDefinition.objects.filter(board=board)
    ]
    # Project every row as materialize() would (an unset board's cap grows to
    # fit, #2658), then let *instance* take the new tier.
    cap = effective_cap(rows, board.lane_details_cap)
    projected = resolve_tiers(rows, cap)
    others = [t for pk, t in projected.items() if instance is None or pk != instance.pk]
    check_tier_counts([*others, band_visibility], cap)


def default_tier_for_create(board) -> str:
    """The tier a create that sends none gets (#2439, #2658).

    Never NULL: the caller has just materialized the board, so the new row is
    explicit too. Band while the board is still in its default shape, fewer than
    ``BAND_DEFAULT`` fields and all of them Band (an empty board's first two
    fields, which position would make Band); otherwise Details while there is
    room, else Hidden: never a 400, so an older client that does not know the
    field can still add one. The rule is the board's current shape only: a board
    with fewer than ``BAND_DEFAULT`` fields that are all Band gets Band, even if
    an admin made it so; it cannot tell that from the default shape.
    """
    from boards.models import SwimlaneCustomFieldDefinition

    rows = list(SwimlaneCustomFieldDefinition.objects.filter(board=board).values("id", "position", "band_visibility"))
    tiers = list(resolve_tiers(rows, board.lane_details_cap).values())
    if len(tiers) < BAND_DEFAULT and tiers.count(BAND) == len(tiers):
        return BAND
    return DETAILS if tiers.count(DETAILS) < board.lane_details_cap else HIDDEN


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
