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

Usage::

    python manage.py purge_card_history --actor admin --card 3f9a0c1d2e4b5a69
    python manage.py purge_card_history --actor admin --board 42 --before 2026-01-01 --yes
"""

import datetime
import re

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import F, Q
from django.db.models.functions import Coalesce
from django.utils import timezone
from django.utils.dateparse import parse_date, parse_datetime

from accounts.models import AdminActionLog
from boards.models import Board, Card, CardBlock, CardMovement

# Card and board uids are 16 lowercase hex characters (boards/uid.py).
_UID_RE = re.compile(r"[0-9a-f]{16}")
# A board id given on the command line: ASCII digits only (str.isdigit() also
# accepts e.g. "²", which int() rejects), short enough to fit a bigint.
_BOARD_ID_RE = re.compile(r"[0-9]{1,18}")


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
        "board and/or date range, and record the purge in the admin action log. "
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
                "Only movements at or after this moment: YYYY-MM-DD (midnight UTC) "
                "or an ISO 8601 datetime (UTC when it has no offset)."
            ),
        )
        parser.add_argument(
            "--before",
            metavar="DATE",
            help="Only movements strictly before this moment; same formats as --since.",
        )
        parser.add_argument(
            "--include-live-cards",
            action="store_true",
            help=(
                "Also delete matching history of cards that still exist. Without "
                "it, only history of deleted cards is touched."
            ),
        )
        parser.add_argument(
            "--yes",
            action="store_true",
            help="Delete. Without it the command only reports what would be deleted.",
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

        if not options["yes"]:
            count = rows.count()
            cards = (
                rows.annotate(_uid=Coalesce(F("card__uid"), F("card_uid")))
                .values("_uid").distinct().count()
            )
            boards = rows.values("board_id").distinct().count()
            self.stdout.write(
                f"Dry run: would delete {count} {scope} and {blocks.count()} block row(s) "
                f"({cards} card(s), {boards} board(s)). Re-run with --yes to delete."
            )
            return

        selector = {
            "card_uid": card_uid,
            "board_id": board.pk if board else None,
            "board_uid": board.uid if board else None,
            "since": since.isoformat() if since else None,
            "before": before.isoformat() if before else None,
            "include_live_cards": include_live,
        }

        # One transaction: the delete and its audit entry land together or not
        # at all. A purge that left no record would be an unexplained hole in
        # an append-only history, so a failed log write must undo the delete.
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
            if deleted or deleted_blocks:
                AdminActionLog.record(
                    action=AdminActionLog.Action.CARD_HISTORY_PURGED,
                    source=AdminActionLog.Source.CLI,
                    actor=actor,
                    # deleted_count keeps meaning movement rows (#1797);
                    # deleted_block_count is additive.
                    metadata={
                        "selector": selector, "deleted_count": deleted,
                        "deleted_block_count": deleted_blocks,
                    },
                )

        if deleted or deleted_blocks:
            self.stdout.write(
                self.style.SUCCESS(
                    f"Deleted {deleted} {scope} and {deleted_blocks} block row(s); "
                    "recorded in the admin action log."
                )
            )
        else:
            # Nothing changed, so nothing is recorded: the action log holds
            # real changes, not no-op runs (same rule as SiteSetting changes).
            self.stdout.write(
                f"No {scope} or block row(s) matched; nothing deleted, nothing recorded."
            )

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
