"""Erase retained movement and block history on request (#1797, #1149).

Since #1469, hard-deleting a card keeps its ``CardMovement`` rows, including
the ``card_title`` snapshot taken at each move and any movement notes, until
the board itself is deleted. Board members keep seeing them in Board History.
That is the intended audit trail, but it leaves no way to honor a request to
erase a deleted card's title short of deleting the whole board. This command
is that way.

Since #1149 the same holds for manual blocks: a ``CardBlock`` keeps the
card's title snapshot plus the free-text ``reason`` and ``resolution`` after
the card is deleted. Every selector below matches block rows the same way it
matches movements (``--since`` / ``--before`` by ``blocked_at``), and one run
erases both.

It deliberately breaks the append-only rule. ``CardMovement.delete()`` refuses
every call, as a guard against *accidental* application deletes; this command
is a deliberate, operator-initiated erasure, so it deletes with a queryset
``delete()`` (one SQL ``DELETE``, the same path the board-delete cascade uses)
and records that it did so in the admin action log.

Safety rails, each a design decision recorded in #1797:

- **Deleted cards only by default.** Only rows whose card no longer exists
  (``card IS NULL``) are matched. A live card's history feeds its timeline and
  the board's metrics, so erasing it needs ``--include-live-cards`` plus a
  ``--card`` or ``--board`` selector (never a date range alone).
- **No empty selector.** At least one of ``--card``, ``--board``, ``--since``
  or ``--before`` is required, and they combine with AND. There is no
  purge-everything form.
- **Dry run by default.** Without ``--yes`` the command only reports how many
  rows would go.
- **Named superuser.** ``--actor`` must name an active superuser, recorded as
  the entry's actor. This is accountability, not authentication: whoever can
  run ``manage.py`` already has the database, and can name any account.
- **Fails closed.** The delete and the audit entry share one transaction, so
  if the entry cannot be written nothing is deleted.
- **No titles in the record.** The entry stores the selector and the count,
  never a purged title or note, and neither does the command's output.

The board change feed (#1816)
-----------------------------
``BoardEvent`` rows store each broadcast payload verbatim, so the same card
content survives there: ``card.created``, ``card.updated`` and
``card.unarchived`` hold the whole card, and ``card.moved`` holds it under
``card`` plus the movement's ``card_title`` and ``notes``. Since #1149 the card
carries its block's free-text ``blocked_reason``, and blocking publishes
``card.updated``, so the feed holds what the deleted ``CardBlock`` row held
(the ``resolution`` is on no card payload, so it is only ever in that row).
Erasing history without these would leave the text readable to every board
member through ``GET /boards/{id}/events/``. The same selector therefore also **redacts** the
matching feed rows, in the same transaction and the same audit entry:

- **Redact, not delete.** A feed consumer pages by an id cursor, so a deleted
  row is an unexplained gap; and the event contract (CLAUDE.md) never removes a
  payload key. The content values become ``null`` (``title``,
  ``description``, ``blocked_reason``, each custom field entry's ``value``,
  ``external_ref``'s ``ref`` and ``url``, and the movement's ``card_title`` and
  ``notes``), every key stays, and the row's ``redacted_at`` says when. Card ``uid``, ids,
  positions, labels, columns and swimlanes are structure, not content, and are
  kept, which is also what lets a re-run find the same rows (already-redacted
  rows are skipped).
- **Same selector, applied to the event.** ``--card`` matches the card's uid
  inside the payload, ``--board`` the row's ``board_id``, and ``--since`` /
  ``--before`` the row's ``created_at``. Without ``--include-live-cards`` only
  rows whose card no longer exists match. Events are matched on their own, not
  through the movement rows, so a card whose movements an earlier run already
  purged still has its feed rows redacted. Two additions keep the feed and
  the movement delete covering the same cards:

  - rows the MCP tools wrote in 1.2 pre-releases carry no uid, only the
    integer card id, and are matched on that id (``_select_events``);
  - ``--board`` also follows the cards its movement and block rows select
    onto other boards, since a card moved between boards in the Django admin
    takes those rows along but leaves its feed rows on the old board.
- **Filtered in the database.** The feed table grows without bound on a
  default install, so rows are never loaded to be tested in Python: ``--board``
  and the date bounds use the table's ``(board_id, id)`` and ``created_at``
  indexes, and the card is matched with a JSON key lookup. There is no index on
  the payload, so ``--card`` without ``--board``, and the cross-board follow
  of ``--board``, read the table's card events; those are plain reads, which
  do not block concurrent feed writes.
  Only the matching rows are fetched and rewritten, in batches.

Usage::

    python manage.py purge_card_history --actor admin --card 3f9a0c1d2e4b5a69
    python manage.py purge_card_history --actor admin --board 42 --before 2026-01-01 --yes
"""

import datetime
import re

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Exists, F, OuterRef, Q
from django.db.models.fields.json import KeyTextTransform, KeyTransform
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from accounts.models import AdminActionLog
from boards import broadcast as _broadcast
from boards.models import Board, BoardEvent, Card, CardBlock, CardMovement

# Card and board uids are 16 lowercase hex characters (boards/uid.py).
_UID_RE = re.compile(r"[0-9a-f]{16}")
# A board id given on the command line: ASCII digits only (str.isdigit() also
# accepts e.g. "²", which int() rejects), short enough to fit a bigint.
_BOARD_ID_RE = re.compile(r"[0-9]{1,18}")


# Feed event types whose stored payload is a whole card (CardSerializer).
# card.deleted and card.archived carry only {card_uid}: nothing to redact.
_CARD_PAYLOAD_EVENTS = (
    _broadcast.EVT_CARD_CREATED,
    _broadcast.EVT_CARD_UPDATED,
    _broadcast.EVT_CARD_UNARCHIVED,
)
# Every feed event type whose payload embeds card content.
_CARD_CONTENT_EVENTS = _CARD_PAYLOAD_EVENTS + (_broadcast.EVT_CARD_MOVED,)
# Card keys whose values are the card's own content. ``blocked_reason`` (#1149)
# is the free text of the block the purge deletes; ``is_blocked`` and
# ``blocked_at`` say only that and when, like a position or a due date, and stay.
_CARD_CONTENT_KEYS = ("title", "description", "blocked_reason")
# Keys of the card's ``external_ref`` object ({provider, ref, url}) that
# identify the linked work; ``provider`` is an enum and is kept, like a custom
# field entry's ``field_definition``.
_EXTERNAL_REF_CONTENT_KEYS = ("ref", "url")
# Movement keys (card.moved's ``movement`` object) holding card content.
_MOVEMENT_CONTENT_KEYS = ("card_title", "notes")
# Rows fetched and rewritten per round trip.
_REDACT_BATCH = 500


def _redact_card(card):
    """Return *card* with its content values nulled and every key kept."""
    if not isinstance(card, dict):
        return card
    out = dict(card)
    for key in _CARD_CONTENT_KEYS:
        if key in out:
            out[key] = None
    ref = out.get("external_ref")
    if isinstance(ref, dict):
        out["external_ref"] = {
            k: (None if k in _EXTERNAL_REF_CONTENT_KEYS else v) for k, v in ref.items()
        }
    elif ref is not None and "external_ref" in out:
        # Not the documented object: nothing to keep, so null it whole.
        out["external_ref"] = None
    values = out.get("custom_field_values")
    if isinstance(values, list):
        # The list keeps its length and each entry its field_definition, so a
        # consumer still sees which fields the card had, not what they said.
        # A malformed entry has no key to keep and is nulled whole.
        out["custom_field_values"] = [
            {**entry, "value": None} if isinstance(entry, dict) else None
            for entry in values
        ]
    return out


def redact_card_event_payload(event, data):
    """Return the stored *data* of a card feed event with card content nulled.

    The key set at every level is unchanged (the payload contract only ever
    adds keys). Any shape this does not recognize is returned as is, since
    the feed holds rows of whatever shape was written at the time.
    """
    if not isinstance(data, dict):
        return data
    if event in _CARD_PAYLOAD_EVENTS:
        return _redact_card(data)
    if event == _broadcast.EVT_CARD_MOVED:
        if "card" not in data:
            # A card.moved the MCP tools wrote in 1.2 pre-releases for a
            # create-at-position: the card itself, flat, with no movement.
            return _redact_card(data)
        out = dict(data)
        out["card"] = _redact_card(out["card"])
        movement = out.get("movement")
        if isinstance(movement, dict):
            out["movement"] = {
                k: (None if k in _MOVEMENT_CONTENT_KEYS else v) for k, v in movement.items()
            }
        return out
    return data


def _parse_moment(value, option):
    """Parse ``YYYY-MM-DD`` or an ISO 8601 datetime; naive values are UTC.

    A bare date means midnight UTC at the start of that day, so
    ``--since 2026-03-01 --before 2026-04-01`` covers exactly March.
    """
    parsed = None
    try:
        parsed = parse_datetime(value)
        if parsed is None:
            day = parse_date(value)
            if day is not None:
                parsed = datetime.datetime.combine(day, datetime.time.min)
    except ValueError:
        parsed = None
    if parsed is None:
        raise CommandError(
            f"{option} must be a date (YYYY-MM-DD) or an ISO 8601 datetime, got {value!r}."
        )
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, datetime.timezone.utc)
    return parsed


class Command(BaseCommand):
    help = (
        "Delete the retained movement and block history of deleted cards, by card uid, "
        "board and/or date range, redact the same cards' content in the board "
        "change feed, and record the purge in the admin action log. "
        "Dry run unless --yes is given."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--actor",
            required=True,
            help=(
                "Username of the active superuser authorizing the purge. Recorded "
                "as the actor of the admin action log entry."
            ),
        )
        parser.add_argument(
            "--card",
            metavar="CARD_UID",
            help="Only history of the card with this uid (16 hex characters).",
        )
        parser.add_argument(
            "--board",
            metavar="BOARD",
            help="Only history on this board, given as its numeric id or its uid.",
        )
        parser.add_argument(
            "--since",
            metavar="DATE",
            help=(
                "Only movements (and change-feed events) at or after this moment: "
                "YYYY-MM-DD (midnight UTC) or an ISO 8601 datetime (UTC when it has "
                "no offset)."
            ),
        )
        parser.add_argument(
            "--before",
            metavar="DATE",
            help=(
                "Only movements (and change-feed events) strictly before this "
                "moment; same formats as --since."
            ),
        )
        parser.add_argument(
            "--include-live-cards",
            action="store_true",
            help=(
                "Also delete matching history, and redact matching change-feed "
                "events, of cards that still exist. Without it, only deleted "
                "cards are touched."
            ),
        )
        parser.add_argument(
            "--yes",
            action="store_true",
            help=(
                "Delete and redact. Without it the command only reports what "
                "would be deleted and redacted."
            ),
        )

    def handle(self, *args, **options):
        actor = self._resolve_actor(options["actor"])

        card_uid = options["card"]
        board_value = options["board"]
        since_raw = options["since"]
        before_raw = options["before"]
        include_live = options["include_live_cards"]

        if not any(v is not None for v in (card_uid, board_value, since_raw, before_raw)):
            raise CommandError(
                "Refusing to run without a selector: give at least one of --card, "
                "--board, --since or --before."
            )
        if include_live and card_uid is None and board_value is None:
            # A date range alone spans every board. For deleted cards' history
            # that is a legitimate retention sweep; for live cards it would
            # erase active timelines and metrics instance-wide on one mistyped
            # date, so live history must be narrowed to a card or a board.
            raise CommandError(
                "--include-live-cards needs --card or --board; a date range alone "
                "would erase live cards' history on every board."
            )

        rows = CardMovement.objects.all()
        blocks = CardBlock.objects.all()
        if not include_live:
            rows = rows.filter(card__isnull=True)
            blocks = blocks.filter(card__isnull=True)

        if card_uid is not None:
            card_uid = card_uid.strip().lower()
            if not _UID_RE.fullmatch(card_uid):
                raise CommandError("--card must be a card uid (16 hex characters).")
            if include_live:
                # A live card is matched through its FK as well as the
                # snapshot, which rows written before migration 0080 may lack.
                rows = rows.filter(
                    Q(card__uid=card_uid) | Q(card__isnull=True, card_uid=card_uid)
                )
                blocks = blocks.filter(
                    Q(card__uid=card_uid) | Q(card__isnull=True, card_uid=card_uid)
                )
            else:
                if Card.objects.filter(uid=card_uid).exists():
                    raise CommandError(
                        f"Card {card_uid} still exists; its history is not retained "
                        "deleted-card history. Delete the card first, or pass "
                        "--include-live-cards to erase a live card's history."
                    )
                rows = rows.filter(card_uid=card_uid)
                blocks = blocks.filter(card_uid=card_uid)

        board = None
        if board_value is not None:
            board = self._resolve_board(board_value)
            rows = rows.filter(board_id=board.pk)
            blocks = blocks.filter(board_id=board.pk)

        since = before = None
        if since_raw is not None:
            since = _parse_moment(since_raw, "--since")
            rows = rows.filter(moved_at__gte=since)
            blocks = blocks.filter(blocked_at__gte=since)
        if before_raw is not None:
            before = _parse_moment(before_raw, "--before")
            rows = rows.filter(moved_at__lt=before)
            blocks = blocks.filter(blocked_at__lt=before)
        if since is not None and before is not None and since >= before:
            raise CommandError("--since must be earlier than --before.")

        scope = "movement row(s)" + ("" if include_live else " of deleted cards")
        events, uidless = self._select_events(
            rows=rows, blocks=blocks, card_uid=card_uid, board=board, since=since, before=before,
            include_live=include_live,
        )

        if not options["yes"]:
            count = rows.count()
            # One UNION query each, over movements and blocks together: a
            # selection can hold only block rows, and a card with both counts
            # once. The ordering is cleared because a UNION arm cannot have one.
            cards = (
                rows.annotate(_uid=Coalesce(F("card__uid"), F("card_uid")))
                .order_by().values("_uid")
                .union(
                    blocks.annotate(_uid=Coalesce(F("card__uid"), F("card_uid")))
                    .order_by().values("_uid")
                )
                .count()
            )
            boards = (
                rows.order_by().values("board_id")
                .union(blocks.order_by().values("board_id"))
                .count()
            )
            event_count = events.count()
            self.stdout.write(
                f"Dry run: would delete {count} {scope} and {blocks.count()} block row(s) "
                f"({cards} card(s), {boards} board(s)) and redact {event_count} "
                "change-feed event(s). Re-run with --yes to delete."
            )
            self._warn_uidless(uidless)
            return

        selector = {
            "card_uid": card_uid,
            "board_id": board.pk if board else None,
            "board_uid": board.uid if board else None,
            "since": since.isoformat() if since else None,
            "before": before.isoformat() if before else None,
            "include_live_cards": include_live,
        }

        # One transaction: the delete, the feed redaction and their audit
        # entry land together or not at all. A purge that left no record would
        # be an unexplained hole in an append-only history, so a failed log
        # write must undo both; and a redaction that committed without the
        # delete (or the reverse) would be half an erasure.
        with transaction.atomic():
            # Deliberate append-only break (module docstring): a queryset
            # delete, which never calls the refusing CardMovement.delete().
            _, per_model = rows.order_by().delete()
            deleted = per_model.get(CardMovement._meta.label, 0)
            # Block rows (#1149) carry the same title snapshot plus free text.
            # CardBlock has no refusing delete(), but a queryset delete keeps
            # it one statement, like the movements above.
            _, per_model = blocks.order_by().delete()
            deleted_blocks = per_model.get(CardBlock._meta.label, 0)
            redacted = self._redact(events)
            if deleted or deleted_blocks or redacted:
                AdminActionLog.record(
                    action=AdminActionLog.Action.CARD_HISTORY_PURGED,
                    source=AdminActionLog.Source.CLI,
                    actor=actor,
                    # deleted_count keeps meaning movement rows (#1797);
                    # deleted_block_count and redacted_event_count are additive.
                    metadata={
                        "selector": selector,
                        "deleted_count": deleted,
                        "deleted_block_count": deleted_blocks,
                        "redacted_event_count": redacted,
                    },
                )

        if deleted or deleted_blocks or redacted:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Deleted {deleted} {scope} and {deleted_blocks} block row(s), and "
                    f"redacted {redacted} change-feed event(s); recorded in the admin "
                    "action log."
                )
            )
        else:
            # Nothing changed, so nothing is recorded: the action log holds
            # real changes, not no-op runs (same rule as SiteSetting changes).
            self.stdout.write(
                f"No {scope}, block row(s) or change-feed events matched; nothing "
                "deleted, nothing recorded."
            )
        self._warn_uidless(uidless)

    def _feed_scope(self, *, since, before):
        """Unredacted card-content feed rows within the date bounds, any board.

        Annotated with ``_card_uid``, the card uid read out of the payload.
        Every condition is a database filter (module docstring): ``created_at``
        is indexed, and callers add the indexed ``board_id`` where they can.
        """
        events = BoardEvent.objects.filter(
            event__in=_CARD_CONTENT_EVENTS, redacted_at__isnull=True,
        )
        if since is not None:
            events = events.filter(created_at__gte=since)
        if before is not None:
            events = events.filter(created_at__lt=before)
        # A card payload event carries its card at the top level; card.moved
        # nests it under "card". Neither has the other's key, so the first
        # non-null of the two is the row's card uid.
        return events.annotate(
            _card_uid=Coalesce(
                KeyTextTransform("uid", "data"),
                KeyTextTransform("uid", KeyTransform("card", "data")),
            )
        )

    @staticmethod
    def _card_id_of(top_id, nested_id):
        """The integer card id a payload carries, or None.

        ``top_id`` is ``data.id`` (a card payload, or a legacy flat
        ``card.moved``), ``nested_id`` is ``data.card.id`` (``card.moved``).
        Anything but a plain int (a bool, a string, a missing key) is None.
        """
        for value in (top_id, nested_id):
            if isinstance(value, int) and not isinstance(value, bool):
                return value
        return None

    def _card_ids_for_uids(self, uids):
        """Integer ids of the cards with these uids, read from feed payloads.

        A deleted card's id survives nowhere else (``CardMovement`` keeps only
        the uid), but every REST-shaped card payload carries both ``uid`` and
        ``id``. Redacted rows are included: redaction keeps both keys.
        """
        if not uids:
            return set()
        pairs = (
            BoardEvent.objects.filter(event__in=_CARD_CONTENT_EVENTS)
            .annotate(
                _card_uid=Coalesce(
                    KeyTextTransform("uid", "data"),
                    KeyTextTransform("uid", KeyTransform("card", "data")),
                )
            )
            .filter(_card_uid__in=list(uids))
            .values_list("data__id", "data__card__id")
            .distinct()
        )
        return {cid for cid in (self._card_id_of(a, b) for a, b in pairs) if cid is not None}

    @staticmethod
    def _without_live_ids(ids):
        """*ids* minus those a live card has.

        Ids resolved from a deleted card's payloads name that deleted card.
        Visiban never reuses an id, but a database restored with its id
        sequence reset can, and then a live card would inherit one; dropping
        live ids keeps such a card's rows out of a deleted-card purge.
        """
        if not ids:
            return set()
        live = set(Card.objects.filter(pk__in=ids).values_list("pk", flat=True))
        return set(ids) - live

    def _select_events(self, *, rows, blocks, card_uid, board, since, before, include_live):
        """The feed rows to redact, and how many in-scope rows stay unmatchable.

        Returns ``(events, unmatchable)``. Must run before ``rows`` and
        ``blocks`` are deleted: ``--board`` reads the selected cards off them.

        Rows are matched on the card uid in the payload. Rows written by the
        MCP tools in 1.2 pre-releases (before #1926) carry no uid but do carry
        the integer card id, so those are matched on the id: the live card's
        pk, or for a deleted card the id its REST-shaped payloads recorded
        next to its uid. Card ids are not reused (a PostgreSQL sequence, and
        Django's SQLite AUTOINCREMENT key, only move forward), so an id that
        matches no live card belongs to a deleted card, and a known id names
        exactly one card. A restore that reset the sequence could break that,
        so ids resolved for a deleted card that a live card now has are
        dropped (``_without_live_ids``).
        """
        dated = self._feed_scope(since=since, before=before)
        in_board = dated.filter(board_id=board.pk) if board is not None else dated

        # The uid-less rows in scope, each with the card id it carries. Only
        # three scalars per row leave the database, and only for this subset
        # (pre-release writes). Their deleted-or-live test is done here rather
        # than as a SQL anti-join on cards.id: that would need the JSON value
        # cast to bigint in SQL, and one malformed row would then abort the
        # whole purge instead of being reported as unmatchable.
        # Not needed for --board with --include-live-cards, which matches
        # every card row on the board whatever its payload carries.
        legacy = {} if (include_live and card_uid is None) else {
            pk: self._card_id_of(top, nested)
            for pk, top, nested in in_board.filter(_card_uid__isnull=True)
            .values_list("pk", "data__id", "data__card__id")
        }
        no_id = sum(1 for cid in legacy.values() if cid is None)

        if card_uid is not None:
            live = Card.objects.filter(uid=card_uid).values_list("pk", flat=True).first()
            card_ids = (
                {live} if live is not None
                else self._without_live_ids(self._card_ids_for_uids({card_uid}))
            )
            matched = [pk for pk, cid in legacy.items() if cid is not None and cid in card_ids]
            # Without a known id, any uid-less row in scope could be this card's.
            unmatchable = no_id if card_ids else len(legacy)
            q = Q(_card_uid=card_uid) | Q(pk__in=matched)
        elif not include_live:
            ids = {cid for cid in legacy.values() if cid is not None}
            live_ids = set(Card.objects.filter(pk__in=ids).values_list("pk", flat=True))
            matched = [
                pk for pk, cid in legacy.items() if cid is not None and cid not in live_ids
            ]
            unmatchable = no_id
            # Deleted cards only, as for movements: a uid row matches when no
            # card with its uid exists (an anti-join on the unique cards.uid).
            q = (
                Q(_card_uid__isnull=False)
                & ~Exists(Card.objects.filter(uid=OuterRef("_card_uid")))
            ) | Q(pk__in=matched)
        else:
            # --board with --include-live-cards: every card row on the board.
            unmatchable = 0
            q = Q()

        if board is None:
            return dated.filter(q).order_by("pk"), unmatchable

        # --board selects cards through their movement and block rows, and a
        # card moved to another board in the Django admin takes both with it
        # (BoardEvent rows keep the board they were written on). Follow the
        # selected cards' rows onto every board, so the deletes and the feed
        # redaction always cover the same cards. Blocks count on their own: a
        # card can have a block row in scope and no movement row (a 1.2 purge
        # removed its movements, or a date range selects only the block).
        uids = set()
        deleted_uids = set()
        ids = set()
        for history in (rows, blocks):
            uids.update(
                uid for uid in history.annotate(_uid=Coalesce(F("card__uid"), F("card_uid")))
                .values_list("_uid", flat=True).distinct()
                if uid
            )
            # A live card's id is on its history row; only deleted cards' ids
            # need the feed lookup, so a run selecting none skips that scan.
            deleted_uids.update(
                uid for uid in history.filter(card__isnull=True)
                .values_list("card_uid", flat=True).distinct()
                if uid
            )
            ids.update(
                history.filter(card__isnull=False).values_list("card_id", flat=True).distinct()
            )
        ids |= self._without_live_ids(self._card_ids_for_uids(deleted_uids))
        followed = Q(pk__in=[])
        if uids:
            uid_q = Q(_card_uid__in=list(uids))
            if not include_live:
                # Belt and braces: the history rows are deleted-only here, so
                # no uid should be live, but a live card's rows must never be
                # redacted without --include-live-cards.
                uid_q &= ~Exists(Card.objects.filter(uid=OuterRef("_card_uid")))
            followed |= uid_q
        if ids:
            # Id matching is for uid-less legacy rows only. A row that carries
            # a uid is attributed by that uid alone, so a uid-bearing row of an
            # unselected card can never be pulled in through an id.
            followed |= Q(_card_uid__isnull=True) & (
                Q(data__id__in=list(ids)) | Q(data__card__id__in=list(ids))
            )
        return dated.filter((Q(board_id=board.pk) & q) | followed).order_by("pk"), unmatchable

    def _warn_uidless(self, count):
        if count:
            self.stdout.write(
                f"Note: {count} change-feed card event(s) in this scope carry "
                "neither a card uid nor a known card id and were not matched. See "
                "docs/administration/card-history-retention.md."
            )

    def _redact(self, events):
        """Null the card content of every row in *events*; return the count.

        Ids are collected first (small integers), then rows are fetched,
        rewritten and saved in batches, so neither the read nor the write ever
        holds more than one batch of payloads in memory. Runs inside the
        caller's transaction. ``bulk_update`` writes only ``data`` and
        ``redacted_at``; ``board_id``, ``event``, ``actor_id`` and
        ``created_at`` are never touched.
        """
        ids = list(events.values_list("pk", flat=True))
        now = timezone.now()
        redacted = 0
        for start in range(0, len(ids), _REDACT_BATCH):
            batch = list(
                BoardEvent.objects.filter(pk__in=ids[start:start + _REDACT_BATCH])
                .only("pk", "event", "data")
            )
            for row in batch:
                row.data = redact_card_event_payload(row.event, row.data)
                row.redacted_at = now
            BoardEvent.objects.bulk_update(batch, ["data", "redacted_at"])
            redacted += len(batch)
        return redacted

    def _resolve_actor(self, username):
        user_model = get_user_model()
        try:
            user = user_model._default_manager.get(**{user_model.USERNAME_FIELD: username})
        except user_model.DoesNotExist:
            raise CommandError(f"--actor: user {username!r} does not exist.")
        if not (user.is_active and user.is_superuser):
            raise CommandError(
                f"--actor: user {username!r} is not an active superuser; only a "
                "superuser can authorize a history purge."
            )
        return user

    def _resolve_board(self, value):
        value = value.strip()
        # A 16-character value is read as a uid first; ids that long do not
        # occur, so an all-digit uid is not mistaken for one.
        if _UID_RE.fullmatch(value.lower()):
            board = Board.objects.filter(uid=value.lower()).first()
        elif _BOARD_ID_RE.fullmatch(value):
            board = Board.objects.filter(pk=int(value)).first()
        else:
            board = None
        if board is None:
            raise CommandError(f"--board: no board with id or uid {value!r}.")
        return board
