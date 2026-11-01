from types import SimpleNamespace

from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import Http404

from rest_framework.exceptions import NotFound

from groups.broadcast import broadcast_group_event as _broadcast_group_event

from . import broadcast as _broadcast
from .models import (
    Board, BoardMembership, Column, Swimlane, Label, Card, CardMovement,
    CardComment, CardActivity, CardAttachment, CardChecklist, Notification,
)
from .serializers import (
    BoardMembershipSerializer, BoardSerializer, ColumnSerializer, LabelSerializer,
    SwimlaneSerializer,
)
from .permissions import SITE_ADMIN
from .admin_mixins import ContainerChangedAdminMixin
from visiban.admin_row_version import RowVersionAdminMixin, RowVersionField, RowVersionFormMixin
from .services.cards import (
    enforce_column_limits, lock_board_for_card_write, lock_card_cell_entry,
    lock_card_for_write, lock_card_row, lock_cards_for_cascade, require_swimlane_exists,
)
from .services.share_links import revoke_lapsed_share_links
from .services.errors import (
    CardNotFound, SwimlaneNotFound, WeightLimitExceeded, WipHardBlocked, WipLimitExceeded,
)
from .views._helpers import _refetched_card_data, blocked_peers_of, publish_blocked_peers
from .views.boards import _broadcast_board_group_change


def _record_board_and_group_event(board_id, group_id, event_type, payload, *, actor_id):
    """Persist one board event and broadcast it to the board channel and,
    when the board belongs to a group, the group channel too — deferred
    until commit, same as record_board_event().

    Board is the only admin-registered model that needs this: BoardViewSet's
    perform_create/destroy (boards/views/boards.py) dual-broadcast
    board.created/deleted to both channels in one on_commit callback, because
    GroupDetail.tsx's dashboard/boards-list view listens for those events
    exclusively on the group socket, not the board socket. This is
    BoardAdmin's counterpart for a create and a delete. An admin *change* uses
    _record_board_update_event() instead, because it can move the board to
    another group (#1684). See BoardAdmin's docstring for why it doesn't just
    use _BoardEventAdminMixin.
    """
    event_id = _broadcast.persist_board_event(board_id, event_type, payload, actor_id=actor_id)

    def _send(bid=board_id, evt=event_type, pl=payload, gid=group_id, eid=event_id, aid=actor_id):
        _broadcast.broadcast_board_event(bid, evt, pl, event_id=eid, actor_id=aid)
        if gid is not None:
            _broadcast_group_event(gid, evt, pl, actor_id=aid)

    transaction.on_commit(_send)


def _record_board_update_event(board_id, old_group_id, new_group_id, payload, *, actor_id):
    """Persist and broadcast an admin change to a board, as
    BoardViewSet.perform_update does (#1684).

    The admin form edits ``group`` too, so a change can be a group move. The
    group-channel fan-out goes through the same helper as perform_update and
    move_group: ``board.deleted`` to the group the board left,
    ``board.created`` to the one it joined, ``board.updated`` when the group is
    unchanged. The board channel gets ``board.updated`` either way. One
    on_commit callback, so the frames go out together after the commit.
    """
    event_id = _broadcast.persist_board_event(
        board_id, _broadcast.EVT_BOARD_UPDATED, payload, actor_id=actor_id,
    )

    def _send(bid=board_id, pl=payload, og=old_group_id, ng=new_group_id, eid=event_id, aid=actor_id):
        _broadcast.broadcast_board_event(bid, _broadcast.EVT_BOARD_UPDATED, pl, event_id=eid, actor_id=aid)
        _broadcast_board_group_change(bid, pl, og, ng, actor_id=aid)

    transaction.on_commit(_send)


def _limit_error_message(exc):
    """A sentence for the admin form from a card-service limit error."""
    if isinstance(exc, WipHardBlocked):
        return (
            f'Column "{exc.column_name}" is at its WIP limit ({exc.current_count}/'
            f"{exc.wip_limit}) and the board enforces hard WIP limits, so no role "
            "can add a card to it. Move a card out or raise the limit first."
        )
    if isinstance(exc, WipLimitExceeded):
        return (
            f'Column "{exc.column_name}" is at its WIP limit ({exc.current_count}/'
            f"{exc.wip_limit}). Raise the limit, or override it as a board admin "
            "through the API with ?force=true."
        )
    return (
        f'Column "{exc.column_name}" would exceed its weight limit '
        f"({exc.current_weight} + {exc.card_weight} > {exc.weight_limit}). Raise the "
        "limit, or override it as a board admin through the API with ?force=true."
    )


def _require_present_for_admin(*querysets):
    """``require_present_or_404`` for the admin: ``Http404`` instead of the
    DRF ``NotFound``, so an admin delete that queued behind another delete of
    the same object answers the admin's own 404 and records nothing (#1602).
    ``delete_view`` runs inside one transaction, so the deletion log entry
    Django wrote before ``delete_model`` rolls back with it."""
    for qs in querysets:
        if not qs.exists():
            raise Http404("This object was deleted.")


def _lock_board_for_admin_save(board_id, model=None, pk=None):
    """Lock a board row, then optionally one of its rows, before an admin
    save; raise ``Http404`` if either is gone (#1602).

    Every container delete holds the board row ``FOR NO KEY UPDATE`` from
    the start of its cascade. An admin save queued behind one would
    otherwise re-insert the deleted board, column or swimlane (``save()``
    falls back to an INSERT when its UPDATE matches no row) or insert a row
    whose deferred board foreign key fails at COMMIT (a 500). Board -> row
    is column reorder's order; both locks are ``FOR NO KEY UPDATE``, the
    mode the UPDATE takes anyway, so a card insert's ``FOR KEY SHARE`` is
    never blocked. ``changeform_view``'s transaction holds them until the
    save commits. ``Http404``, as the card-child admin hooks answer, because
    the admin cannot return a DRF 404.
    """
    if Board.objects.select_for_update(no_key=True).filter(pk=board_id).first() is None:
        raise Http404("This board was deleted.")
    if pk is not None and (
        model.objects.select_for_update(no_key=True).filter(pk=pk).first() is None
    ):
        raise Http404("This object was deleted.")


class CardAdminForm(forms.ModelForm):
    """Applies the card service's placement rules to Django admin saves (#1428).

    ``CardAdmin.save_model`` writes the row directly, so without this form a
    staff user could create a card in a column with ``allow_card_creation``
    off, or put a card into (or grow one inside) a column past its WIP or
    weight limit — including under hard WIP mode, which the API documents as
    "blocked for all roles". The rules are the service's own
    (:func:`boards.services.cards.enforce_column_limits`), evaluated in
    ``clean()`` so a refusal is an ordinary form error rather than a 500.

    There is no override here: the admin form has no ``force`` control, so a
    soft limit is refused too. A site admin who needs to exceed a soft limit
    uses the API's ``?force=true`` or raises the column's limit. This is
    stricter than the API for site admins on purpose — the admin is a repair
    tool, not the place to bypass board policy silently.

    ``changeform_view`` runs validation inside ``transaction.atomic()``, so the
    card and column row locks ``clean()`` takes are held until the save commits.

    Lock order (#1588): every lock this form takes follows ``move_card``'s
    card -> column order. For an existing card the card row is locked first
    and its column, swimlane, archive state and weight are re-read under that
    lock (``lock_card_row``), because ``self.instance`` was read unlocked by
    ``get_object`` and a move may have committed since. Then, if the cell
    changes (column or swimlane, archived cards included — they are still
    cell members) or a limit check runs, the fresh source column and the
    target column are locked in one pk-ordered statement, and
    ``enforce_column_limits`` counts under that lock (``lock=False``). A
    created card has no row yet, so only its target column is locked. The
    effect: an admin edit queues behind a concurrent ``move_card`` that holds
    either column instead of committing into its cell behind its membership
    re-check (#1567), and a restore or weight change cannot deadlock with a
    move of the same card by taking the column before the card.
    """

    class Meta:
        model = Card
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        if self.errors:
            return cleaned
        self._require_live_labels(cleaned)
        column = cleaned.get("column")
        board = cleaned.get("board")
        if column is None or board is None:
            return cleaned
        # The helper counts cards with board=board, so a column from another
        # board would count zero and silently pass every limit. A card in a
        # column of a different board is never valid anyway.
        if column.board_id != board.pk:
            raise ValidationError({"column": "Column belongs to a different board."})
        original = self.instance
        creating = original.pk is None
        if creating and not column.allow_card_creation:
            raise ValidationError({"column": "Card creation is not allowed in this column."})

        if creating:
            current = None
            source_column_id = None
        else:
            # Card row first, then re-read under the lock: ``self.instance``
            # was loaded unlocked and may be stale, and the columns to lock
            # (and whether the card enters a cell at all) must be decided on
            # the state this transaction will actually overwrite (#1588).
            current = lock_card_row(original.pk)
            if current is None:
                raise ValidationError("This card was deleted while you were editing it.")
            source_column_id = current.column_id

        swimlane = cleaned.get("swimlane")
        swimlane_id = swimlane.pk if swimlane is not None else getattr(current, "swimlane_id", None)
        # Evaluated before the archived early return: an archived card is
        # still a member of its cell, so moving one changes a cell's members
        # just like moving an active card does.
        cell_entry = (
            creating
            or current.column_id != column.pk
            or current.swimlane_id != swimlane_id
        )

        archived_at = cleaned.get("archived_at", getattr(current, "archived_at", None))
        weight = cleaned.get("weight", getattr(current, "weight", original.weight))
        entering = (
            creating
            or current.archived_at is not None  # restore
            or current.column_id != column.pk  # move
        )
        weight_up = not entering and weight > current.weight
        enforce = archived_at is None and (entering or weight_up)

        if cell_entry or enforce:
            # Columns after the card row, source and target in one pk-ordered
            # statement — move_card's order. The card row is already held.
            locked_columns = lock_card_cell_entry(
                card_id=None, column_ids={source_column_id, column.pk} - {None},
            )
            # A column, swimlane or board delete holds these column rows
            # across its cascade (#1602). A form that waited on one finds its
            # target gone once the lock is granted: refuse it as a form error
            # rather than save into a deleted column or swimlane and fail the
            # card's deferred foreign-key check at COMMIT (a 500). A swimlane
            # or board delete holds every column of the board, so the swimlane
            # read here sees one that was deleted.
            if column.pk not in locked_columns:
                raise ValidationError({"column": "This column was deleted. Choose another."})
            if cell_entry and swimlane_id is not None:
                try:
                    require_swimlane_exists(swimlane_id)
                except SwimlaneNotFound:
                    raise ValidationError(
                        {"swimlane": "This swimlane was deleted. Choose another."}
                    ) from None
        if not enforce:
            # An archived card does not count toward a column's limits, and an
            # edit that neither enters a column nor grows a card is unchecked.
            return cleaned
        try:
            enforce_column_limits(
                board=board, column=column,
                card=SimpleNamespace(pk=original.pk, weight=weight),
                role=SITE_ADMIN, force=False,
                # A weight change inside the same column does not change its
                # card count, so it is checked against the weight limit only —
                # same rule as the PATCH path.
                check_wip=entering,
                # Locked above, after the card row.
                lock=False,
            )
        except (WipHardBlocked, WipLimitExceeded, WeightLimitExceeded) as exc:
            raise ValidationError(_limit_error_message(exc)) from None
        return cleaned

    def _require_live_labels(self, cleaned):
        """Hold the board row(s) ``FOR SHARE`` and re-read the chosen labels (#1632).

        The ``labels`` field resolved its choices before any lock, and
        ``save_m2m`` inserts them at the end of ``changeform_view``'s
        transaction: a label deleted in between failed the M2M row's deferred
        foreign key at COMMIT (a 500). Same lock the card service takes
        (``lock_board_for_card_write``), and first, before the card and
        column rows ``clean()`` locks next, so the board -> card -> column
        order holds. Every label delete takes the board row ``FOR NO KEY
        UPDATE`` first, so a label read here stays until this save commits;
        one already gone is a form error, not a 500. Both the stored and the
        submitted board are held (a card can be moved between boards here),
        in pk order.
        """
        board = cleaned.get("board")
        board_ids = {self.instance.board_id, getattr(board, "pk", None)} - {None}
        for board_id in sorted(board_ids):
            if not lock_board_for_card_write(board_id):
                raise ValidationError("This board was deleted while you were editing the card.")
        labels = cleaned.get("labels")
        if not labels:
            return
        wanted = {label.pk for label in labels}
        live = set(Label.objects.filter(pk__in=wanted).values_list("pk", flat=True))
        if wanted - live:
            raise ValidationError({
                "labels": "A selected label was deleted. Choose the labels again.",
            })


@admin.register(Card)
class CardAdmin(admin.ModelAdmin):
    """Admin for Card that broadcasts mutations to connected WebSocket clients.

    Mutations made through the admin site bypass the REST viewset and its
    perform_create/perform_update/perform_destroy hooks. Without this override
    any client viewing the affected board would not see admin edits until a
    full reload. Broadcast is deferred via transaction.on_commit() so clients
    only see events after the DB write is durably committed.

    WIP, weight and ``allow_card_creation`` are enforced by ``CardAdminForm``
    (#1428); the version bump, ``CardMovement`` audit row and hooks are still
    skipped (see ``docs/architecture/service-layer.md``).
    """

    form = CardAdminForm

    def save_model(self, request, obj, form, change):
        peers = {}
        with transaction.atomic():
            stored = self._lock_cell_entry(obj, change)
            # The form edits archived_at (fields="__all__"), so a save can
            # archive or restore the card. That moves the blocker_count of
            # every card it blocks, as archive_card / unarchive_card do, so
            # those cards need their own card.updated (#1634). Decided from
            # the row read under the lock; collected before the save, with
            # archived blockers included because this card's archived state
            # is exactly what changes.
            if stored is not None and (stored.archived_at is None) != (obj.archived_at is None):
                peers = blocked_peers_of(
                    Card.objects.filter(pk=obj.pk), active_blockers_only=False,
                )
            super().save_model(request, obj, form, change)
            if change:
                # This form can move a card to another board (the API cannot).
                # A movement's ``board`` is what History reads and what a board
                # delete cascades through (#1469), so keep the card's history
                # attached to the board the card is on now. A queryset update,
                # so the append-only guard on CardMovement.save() is not hit;
                # it matches no row unless the board changed.
                CardMovement.objects.filter(card=obj).exclude(board_id=obj.board_id).update(
                    board_id=obj.board_id,
                )
                # A row an older release wrote mid-rollout has empty snapshots
                # and the repair paths only look at rows with no board, so fill
                # them here too or they stay empty once the card is deleted.
                CardMovement.objects.filter(card=obj, card_uid="").update(card_uid=obj.uid)
                CardMovement.objects.filter(card=obj, card_title="").update(card_title=obj.title)
        board = obj.board
        event = _broadcast.EVT_CARD_UPDATED if change else _broadcast.EVT_CARD_CREATED
        card_data = _refetched_card_data_or_none(obj, request, board)
        if card_data is None:
            # Deleted meanwhile: its delete already told the peers.
            return
        _broadcast.record_board_event(board.id, event, card_data, actor_id=request.user.pk)
        # After the card's own frame, rendered from the saved state so each
        # peer carries its new count. changeform_view's transaction is still
        # open here, so the feed rows commit with the save and the publish
        # waits for the commit, like the card's own frame above.
        publish_blocked_peers(peers, request)

    @staticmethod
    def _lock_cell_entry(obj, change):
        """Re-take the cell-entry locks in the transaction that saves the card.

        In the admin this is a no-op: ``CardAdminForm.clean`` runs inside the
        same ``changeform_view`` transaction and already holds the card row
        and the same columns, decided on the same locked state. It is defense
        in depth for a save driven some other way (e.g. a form validated in a
        different transaction): it guarantees only that, when the stored cell
        differs from ``obj``'s, the card row and then its source and target
        column rows are held from before the card UPDATE until this
        transaction commits — which is what ``move_card``'s membership
        re-check (#1567) relies on. It does not re-run the limit check.

        Returns the stored row read under the lock (``None`` on add, or when
        the card is gone), so ``save_model`` can tell whether the save
        archives or restores it (#1634).
        """
        if not change:
            lock_card_cell_entry(card_id=None, column_ids={obj.column_id})
            return None
        stored = lock_card_row(obj.pk)
        if stored is not None and (stored.column_id, stored.swimlane_id) != (
            obj.column_id, obj.swimlane_id,
        ):
            lock_card_cell_entry(card_id=None, column_ids={stored.column_id, obj.column_id})
        return stored

    def delete_model(self, request, obj):
        board_id = obj.board_id
        card_uid = obj.uid
        # Lock the card before the collector reads its child rows, in one
        # transaction held across the delete (#1603; see lock_cards_for_cascade).
        with transaction.atomic():
            lock_cards_for_cascade(Card.objects.filter(pk=obj.pk))
            # The cards this one blocks lose a blocker (#1634), as on the
            # REST delete (#449). Read before the delete removes the relations.
            peers = blocked_peers_of(Card.objects.filter(pk=obj.pk))
            super().delete_model(request, obj)
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor_id=request.user.pk
            )
            publish_blocked_peers(peers, request)

    def delete_queryset(self, request, queryset):
        # One outer atomic: a bulk action is not wrapped by Django, so a lock
        # taken per object would not be held across the delete (#1603).
        with transaction.atomic():
            lock_cards_for_cascade(Card.objects.filter(pk__in=queryset.values("pk")))
            # Capture board_id + uid before delete — post-delete the instances are gone.
            deleted = [(c.board_id, c.uid) for c in queryset]
            # Surviving cards the deleted ones blocked (#1634); a peer deleted
            # in the same bulk action gets its card.deleted, not a card.updated.
            peers = blocked_peers_of(Card.objects.filter(pk__in=queryset.values("pk")))
            super().delete_queryset(request, queryset)
            for board_id, card_uid in deleted:
                _broadcast.record_board_event(
                    board_id, _broadcast.EVT_CARD_DELETED, {"card_uid": card_uid}, actor_id=request.user.pk
                )
            publish_blocked_peers(peers, request)


@admin.register(Column)
class ColumnAdmin(ContainerChangedAdminMixin, admin.ModelAdmin):
    """Admin for Column that broadcasts mutations (see CardAdmin for rationale)."""

    def save_model(self, request, obj, form, change):
        # Lock the (target) board row first, as ColumnViewSet.perform_create
        # does (#1602): a swimlane or board delete holds it across its
        # cascade, so no column can appear in the board — added here, or
        # re-pointed at it by an edit of its ``board`` — after the delete has
        # snapshotted the columns a card could enter through.
        # changeform_view's transaction holds the lock until the save commits.
        _lock_board_for_admin_save(obj.board_id, Column, obj.pk if change else None)
        super().save_model(request, obj, form, change)
        event = _broadcast.EVT_COLUMN_UPDATED if change else _broadcast.EVT_COLUMN_CREATED
        column_data = ColumnSerializer(obj).data
        board_id = obj.board_id
        _broadcast.record_board_event(board_id, event, column_data, actor_id=request.user.pk)

    def delete_model(self, request, obj):
        board_id = obj.board_id
        column_uid = obj.uid
        # Cards first, then the column row (#1603, #1602; see
        # lock_cards_for_cascade): the column lock keeps a card created or
        # moved into it from committing mid-cascade.
        with transaction.atomic():
            lock_cards_for_cascade(
                Card.objects.filter(column_id=obj.pk),
                entry_columns=Column.objects.filter(pk=obj.pk),
                boards=Board.objects.filter(pk=obj.board_id),
            )
            _require_present_for_admin(
                Board.objects.filter(pk=obj.board_id), Column.objects.filter(pk=obj.pk)
            )
            # Surviving cards this column's cards blocked (#1634), as on the
            # REST delete; read before the delete removes the relations.
            peers = blocked_peers_of(Card.objects.filter(column_id=obj.pk))
            super().delete_model(request, obj)
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=request.user.pk
            )
            publish_blocked_peers(peers, request)

    def delete_queryset(self, request, queryset):
        # One outer atomic across lock + delete (#1603).
        with transaction.atomic():
            lock_cards_for_cascade(
                Card.objects.filter(column__in=queryset.values("pk")),
                entry_columns=Column.objects.filter(pk__in=queryset.values("pk")),
                boards=Board.objects.filter(pk__in=queryset.values("board_id")),
            )
            deleted = [(c.board_id, c.uid) for c in queryset]
            # One read across every selected column, so a card blocked by a
            # card in another selected column is excluded too (#1634).
            peers = blocked_peers_of(Card.objects.filter(column__in=queryset.values("pk")))
            super().delete_queryset(request, queryset)
            for board_id, column_uid in deleted:
                _broadcast.record_board_event(
                    board_id, _broadcast.EVT_COLUMN_DELETED, {"column_uid": column_uid}, actor_id=request.user.pk
                )
            publish_blocked_peers(peers, request)


class _BoardEventAdminMixin:
    """Shared save/delete broadcast wiring for board-scoped admin models.

    Mutations made through the admin site bypass the REST viewset and its
    perform_create/perform_update/perform_destroy hooks (see CardAdmin above
    for the full rationale). CardAdmin and ColumnAdmin each hand-roll the same
    persist-then-broadcast shape; this mixin factors it out for the other
    board-scoped models the 1.2 pre-release broadcast-check audit flagged as
    silently bypassing it (#1241) — Swimlane, Label, BoardMembership. Each
    concrete admin class below only declares its event names and how to
    build a payload.

    Board is deliberately NOT one of these — its REST viewset dual-broadcasts
    to both the board channel and the board's group channel (a second
    audience the other three models don't have), so BoardAdmin implements its
    own save_model/delete_model/delete_queryset via
    _record_board_and_group_event() above instead of this single-channel
    mixin. Do not fold Board back into this mixin without also adding a
    group-channel branch generically — Swimlane/Label/BoardMembership's own
    REST viewsets never call broadcast_group_event, so a generic group
    broadcast here would be wrong for them.

    Subclasses set ``event_created``/``event_updated``/``event_deleted`` and
    implement ``_board_id``, ``_payload`` (used for both create and update),
    and ``_delete_payload``. ``_delete_payload`` is always called *before* the
    row is actually deleted — ``instance.delete()`` clears the instance's pk,
    the same reason CardAdmin/ColumnAdmin capture their uid up front rather
    than after ``super().delete_model()``.
    """

    event_created = None
    event_updated = None
    event_deleted = None

    def _board_id(self, obj):
        raise NotImplementedError

    def _payload(self, obj, request):
        raise NotImplementedError

    def _delete_payload(self, obj):
        raise NotImplementedError

    def _emit(self, board_id, event, payload, request):
        # `event` arrives as a plain parameter rather than a literal EVT_*
        # expression — the concrete constant lives on the subclass
        # (event_created/event_updated/event_deleted), and the
        # ws-event-reachability gate can only trace a registry constant
        # written directly in the calling function's own body, not through
        # an instance-attribute lookup. This one-line forwarder gets the same
        # pass-through treatment the gate already gives
        # _record_board_and_group_event() above; the events themselves are
        # independently declared/emitted/documented via each model's REST
        # viewset.
        _broadcast.record_board_event(board_id, event, payload, actor_id=request.user.pk)

    def save_model(self, request, obj, form, change):
        # Board row, then (on change) the row itself (#1602; see
        # _lock_board_for_admin_save).
        _lock_board_for_admin_save(
            self._board_id(obj), type(obj), obj.pk if change else None,
        )
        super().save_model(request, obj, form, change)
        event = self.event_updated if change else self.event_created
        self._emit(self._board_id(obj), event, self._payload(obj, request), request)

    def _cards_cascaded_by(self, queryset):
        """Cards a delete of ``queryset`` cascades to, or ``None`` when the
        model has no card cascade (Label, BoardMembership). Swimlane overrides
        it so its delete takes the card-row lock first (#1603)."""
        return None

    def _entry_columns_for(self, queryset):
        """Column rows whose lock keeps a card from entering what ``queryset``
        cascades to (#1602); only meaningful with ``_cards_cascaded_by``."""
        return None

    def _boards_for(self, queryset):
        """Board rows a cascading delete of ``queryset`` locks first (#1602)."""
        return None

    def _lock_cascade(self, queryset):
        cards = self._cards_cascaded_by(queryset)
        if cards is not None:
            lock_cards_for_cascade(
                cards, entry_columns=self._entry_columns_for(queryset),
                boards=self._boards_for(queryset),
            )

    @staticmethod
    def _lock_boards_then_rows(queryset):
        """Bulk delete of rows with no card cascade (label, membership).

        Board rows, then the rows themselves, each in one pk-ordered
        ``FOR NO KEY UPDATE`` statement: the order and mode
        ``_lock_board_for_admin_save`` takes for one row. A bulk label delete
        took no lock before (#1632), so a card write that had re-checked its
        labels under the board row (``lock_board_for_card_write``) could
        still have one deleted under it and fail its deferred foreign key at
        COMMIT; holding the board row makes the two queue.
        """
        model = queryset.model
        pks = list(queryset.values_list("pk", flat=True))
        board_ids = model.objects.filter(pk__in=pks).values("board_id")
        list(
            Board.objects.select_for_update(no_key=True)
            .filter(pk__in=board_ids).order_by("pk").values_list("pk", flat=True)
        )
        list(
            model.objects.select_for_update(no_key=True)
            .filter(pk__in=pks).order_by("pk").values_list("pk", flat=True)
        )

    def delete_model(self, request, obj):
        board_id = self._board_id(obj)
        payload = self._delete_payload(obj)
        with transaction.atomic():
            qs = type(obj).objects.filter(pk=obj.pk)
            cards = self._cards_cascaded_by(qs)
            peers = {}
            if cards is None:
                # No card cascade (label, membership): take the board row and
                # the row itself, so a delete queued behind another delete of
                # it answers 404 rather than recording a second event.
                _lock_board_for_admin_save(board_id, type(obj), obj.pk)
            else:
                self._lock_cascade(qs)
                _require_present_for_admin(Board.objects.filter(pk=board_id), qs)
                # Surviving cards the cascaded cards blocked (#1634); read
                # before the delete removes the relations.
                peers = blocked_peers_of(cards)
            super().delete_model(request, obj)
            self._emit(board_id, self.event_deleted, payload, request)
            publish_blocked_peers(peers, request)

    def delete_queryset(self, request, queryset):
        # One outer atomic across lock + delete: a bulk action is not wrapped
        # by Django, so per-object locks would not be held (#1603).
        with transaction.atomic():
            cards = self._cards_cascaded_by(queryset)
            peers = {}
            if cards is None:
                self._lock_boards_then_rows(queryset)
            else:
                self._lock_cascade(queryset)
                # One read across the whole selection (#1634; see ColumnAdmin).
                peers = blocked_peers_of(cards)
            # Capture identifiers before delete — post-delete each instance's pk is cleared.
            deleted = [(self._board_id(o), self._delete_payload(o)) for o in queryset]
            super().delete_queryset(request, queryset)
            for board_id, payload in deleted:
                self._emit(board_id, self.event_deleted, payload, request)
            publish_blocked_peers(peers, request)


@admin.register(Swimlane)
class SwimlaneAdmin(ContainerChangedAdminMixin, _BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for Swimlane that broadcasts mutations (see CardAdmin for rationale)."""

    event_created = _broadcast.EVT_SWIMLANE_CREATED
    event_updated = _broadcast.EVT_SWIMLANE_UPDATED
    event_deleted = _broadcast.EVT_SWIMLANE_DELETED

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        # SwimlaneSerializer, never SwimlaneAdminSerializer: every swimlane
        # broadcast must go through the public serializer so contact_email
        # and notes (admin-only PII) never reach viewer-role WebSocket
        # subscribers — the same rule SwimlaneViewSet follows (see
        # SwimlaneSerializer's docstring in serializers.py).
        return SwimlaneSerializer(obj).data

    def _delete_payload(self, obj):
        return {"swimlane_uid": obj.uid}

    def _cards_cascaded_by(self, queryset):
        return Card.objects.filter(swimlane__in=queryset.values("pk"))

    def _entry_columns_for(self, queryset):
        # A card enters a swimlane through any column of its board, and every
        # such writer holds that column's row (#1602).
        return Column.objects.filter(board__in=queryset.values("board_id"))

    def _boards_for(self, queryset):
        return Board.objects.filter(pk__in=queryset.values("board_id"))


@admin.register(Label)
class LabelAdmin(_BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for Label that broadcasts mutations (see CardAdmin for rationale)."""

    event_created = _broadcast.EVT_LABEL_CREATED
    event_updated = _broadcast.EVT_LABEL_UPDATED
    event_deleted = _broadcast.EVT_LABEL_DELETED

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        return LabelSerializer(obj).data

    def _delete_payload(self, obj):
        return {"label_uid": obj.uid}


class BoardAdminForm(RowVersionFormMixin, forms.ModelForm):
    """The board form with the rendered-state check.

    ``row_version`` covers every field the form writes, ``owner`` and
    ``group`` included; see ``visiban/admin_row_version.py``.
    """

    row_version = RowVersionField(required=False)
    stale_form_message = (
        "This board was changed after this page was opened. Reload the page and "
        "make your changes again."
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # #1429: allowed_priorities is deprecated and never enforced. Override
        # the help text on the form only; changing the model help_text would
        # emit an AlterField migration for a documentation-only change.
        if "allowed_priorities" in self.fields:
            self.fields["allowed_priorities"].help_text = (
                "Deprecated. This setting has no effect: card priorities are not restricted."
            )
        # #1725: a stored export_min_role outside the allowed set (only a
        # direct ORM or shell write can leave one) has no matching <option>,
        # so the browser would submit the first option, ``viewer``, on an
        # unrelated save. Show the value the export gate applies instead, so
        # the form round-trips it.
        if self.instance.pk and "export_min_role" in self.fields:
            from .views.import_export import _effective_export_min_role

            self.initial["export_min_role"] = _effective_export_min_role(self.instance)

    class Meta:
        model = Board
        fields = "__all__"


@admin.register(Board)
class BoardAdmin(RowVersionAdminMixin, ContainerChangedAdminMixin, admin.ModelAdmin):
    """Admin for Board that broadcasts mutations to both the board channel and
    the board's group channel.

    Board is the one board-scoped model in this file with a second broadcast
    audience: GroupDetail.tsx's dashboard/boards-list view listens for
    board.created/board.updated/board.deleted exclusively on the group socket
    (useGroupSocket), not the board socket. BoardViewSet's REST handlers in
    boards/views/boards.py broadcast to both channels in one on_commit
    callback, and this admin does the same: a create or delete goes to the
    board's group, and a change goes through the group-move helper that
    perform_update and move_group use, so a change of ``group`` tells the old
    group the board left (``board.deleted``) and the new group it arrived
    (``board.created``) (#1684). A board created, renamed, moved or deleted
    via /admin/ must still reach that view without a manual reload, so this
    class does not use _BoardEventAdminMixin's single-channel pattern —
    Swimlane/Label/BoardMembership have no group-channel counterpart (their
    REST viewsets never call broadcast_group_event either) and stay on that
    mixin below.

    A save writes only the fields the administrator changed, and a form
    rendered against an older state of the board is refused with nothing
    written or broadcast (``RowVersionAdminMixin``).
    """

    form = BoardAdminForm
    stale_save_message = (
        "This board was changed after this page was opened, so nothing was saved. "
        "The page now shows the current state of the board; make your changes again."
    )

    def save_model(self, request, obj, form, change):
        old_group_id = None
        if obj.group_id is not None:
            # The target group before the board row (#1719), the group ->
            # board order every board placement takes (#1638): a save into a
            # group deleted meanwhile raises Http404 instead of failing the
            # deferred group foreign key at COMMIT, and a group change no
            # longer holds the board row while asking for the group at COMMIT.
            from groups.services import lock_group_for_board_placement

            if not lock_group_for_board_placement(obj.group_id):
                raise Http404("The selected group no longer exists.")
        if change:
            # Board row first (#1602; see _lock_board_for_admin_save).
            _lock_board_for_admin_save(obj.pk)
            # The group the board is leaving, read from the locked row rather
            # than ``obj`` (the form's target), as perform_update does (#1684).
            old_group_id = (
                Board.objects.filter(pk=obj.pk).values_list("group_id", flat=True).first()
            )
            if form is not None:
                # BoardAdmin.save_model re-reads fields that are not on the
                # form from the locked row (and form fields the administrator
                # did not change), so a concurrent change to them is not
                # reverted by the earlier read held in ``obj``. The share-link
                # fields (token, token hash, expiry, enabler) are editable=False, so they
                # are never on the form and always come from the locked row.
                # A submitted row_version is compared with the locked row
                # first, so a form rendered against an older owner or group
                # is refused before anything is written or broadcast.
                stored = Board.objects.get(pk=obj.pk)
                self.check_row_version(form, stored)
                self.keep_unchanged_fields(obj, form, stored)
        super().save_model(request, obj, form, change)
        if change:
            # An owner or group change can end the admin standing of the
            # share link's enabler (#1865). The refresh is defensive: it keeps
            # ``obj`` in step with the row for anything that reads it after
            # this point (the payload below carries no share fields).
            revoke_lapsed_share_links(board_ids=[obj.pk], actor_id=request.user.pk)
            obj.refresh_from_db(fields=Board.SHARE_LINK_FIELDS)
        # No request in context: BoardSerializer.get_group_detail() reads
        # request.query_params (a DRF Request attribute) to resolve
        # ?expand=group, which the plain Django admin HttpRequest does not
        # have — passing it through would raise AttributeError. Omitting
        # context falls back to is_starred=False / group_detail=None, both
        # of which are documented fallbacks on a bare instance, not a crash.
        board_data = BoardSerializer(obj).data
        if change:
            _record_board_update_event(
                obj.id, old_group_id, obj.group_id, board_data, actor_id=request.user.pk
            )
        else:
            _record_board_and_group_event(
                obj.id, obj.group_id, _broadcast.EVT_BOARD_CREATED, board_data,
                actor_id=request.user.pk,
            )

    def delete_model(self, request, obj):
        board_id = obj.id
        board_uid = obj.uid
        # Cards first, then the board's columns, then the board (#1603,
        # #1602; see lock_cards_for_cascade).
        with transaction.atomic():
            lock_cards_for_cascade(
                Card.objects.filter(board_id=obj.pk),
                entry_columns=Column.objects.filter(board_id=obj.pk),
                boards=Board.objects.filter(pk=obj.pk),
            )
            _require_present_for_admin(Board.objects.filter(pk=obj.pk))
            # The group the board is in when it is deleted, read from the row
            # the lock above now holds rather than from ``obj``: ``obj`` was
            # read before the lock, so a move-group that committed in between
            # would make ``board.deleted`` go to the group the board already
            # left (#1712; same ordering as save_model, #1684).
            group_id = (
                Board.objects.filter(pk=obj.pk).values_list("group_id", flat=True).first()
            )
            # Cards on other boards this board's cards blocked (#1634) — only
            # reachable through this admin's cross-board card move; see
            # BoardViewSet.destroy. Each goes to its own board's channel.
            peers = blocked_peers_of(Card.objects.filter(board_id=obj.pk))
            super().delete_model(request, obj)
            _record_board_and_group_event(
                board_id, group_id, _broadcast.EVT_BOARD_DELETED, {"board_uid": board_uid},
                actor_id=request.user.pk,
            )
            publish_blocked_peers(peers, request)

    def get_deleted_objects(self, objs, request):
        """Let a board delete cascade its movement history (#1469).

        ``CardMovementAdmin`` grants no delete permission, and the admin's
        confirmation step checks that permission on every collected object, so
        without this a board with any history could not be deleted here.
        Deleting the whole board is the one sanctioned way movements leave;
        the board's own delete permission is what authorizes it. Also used by
        the ``delete_selected`` action.
        """
        to_delete, model_count, perms_needed, protected = super().get_deleted_objects(objs, request)
        perms_needed.discard(CardMovement._meta.verbose_name)
        return to_delete, model_count, perms_needed, protected

    def delete_queryset(self, request, queryset):
        # One outer atomic across lock + delete (#1603).
        with transaction.atomic():
            lock_cards_for_cascade(
                Card.objects.filter(board__in=queryset.values("pk")),
                entry_columns=Column.objects.filter(board__in=queryset.values("pk")),
                boards=Board.objects.filter(pk__in=queryset.values("pk")),
            )
            # Capture identifiers before delete — post-delete each instance's pk is cleared.
            # Read through a fresh query, not by iterating ``queryset``: the
            # admin action has already evaluated it (to build the confirmation
            # page), so iterating would replay the cached pre-lock rows and
            # send ``board.deleted`` to a group the board has since left (#1712).
            deleted = list(
                Board.objects.filter(pk__in=queryset.values("pk")).values_list(
                    "id", "uid", "group_id"
                )
            )
            # One read across every selected board, so a peer on another
            # selected board (deleted too) gets no frame (#1634).
            peers = blocked_peers_of(Card.objects.filter(board__in=queryset.values("pk")))
            super().delete_queryset(request, queryset)
            for board_id, board_uid, group_id in deleted:
                _record_board_and_group_event(
                    board_id, group_id, _broadcast.EVT_BOARD_DELETED, {"board_uid": board_uid},
                    actor_id=request.user.pk,
                )
            publish_blocked_peers(peers, request)


class BoardMembershipAdminForm(RowVersionFormMixin, forms.ModelForm):
    """The membership form with the rendered-state check.

    ``row_version`` covers every field the form writes, ``role`` and
    ``is_moderator`` included; see ``visiban/admin_row_version.py``.
    """

    row_version = RowVersionField(required=False)
    stale_form_message = (
        "This membership was changed after this page was opened. Reload the page "
        "and make your changes again."
    )

    class Meta:
        model = BoardMembership
        fields = "__all__"


@admin.register(BoardMembership)
class BoardMembershipAdmin(RowVersionAdminMixin, _BoardEventAdminMixin, admin.ModelAdmin):
    """Admin for BoardMembership that broadcasts mutations (see CardAdmin for rationale).

    A save writes only the fields the administrator changed, and a form
    rendered against an older state of the membership is refused with nothing
    written or broadcast (``RowVersionAdminMixin``).
    """

    form = BoardMembershipAdminForm
    stale_save_message = (
        "This membership was changed after this page was opened, so nothing was "
        "saved. The page now shows its current state; make your changes again."
    )

    event_created = _broadcast.EVT_MEMBER_ADDED
    event_updated = _broadcast.EVT_MEMBER_UPDATED
    event_deleted = _broadcast.EVT_MEMBER_REMOVED

    def save_model(self, request, obj, form, change):
        """Judge the submission against the membership read under its lock.

        Board row, then the membership row, as ``_BoardEventAdminMixin.save_model``
        locks them (it takes the same locks again, which this transaction
        already holds). The row_version check and the unchanged-field merge
        run before that save, so a refused submission records and broadcasts
        nothing; the change view's transaction holds the locks until commit.
        """
        stored_board_id = None
        if change:
            # Both boards the save touches, in one pk-ordered statement: the
            # stored board (the form may move the membership off it) and the
            # submitted one, which the mixin's save locks again below.
            stored_board_id = (
                BoardMembership.objects.filter(pk=obj.pk)
                .values_list("board_id", flat=True).first()
            )
            if stored_board_id is not None and stored_board_id != obj.board_id:
                list(
                    Board.objects.select_for_update(no_key=True)
                    .filter(pk__in={stored_board_id, obj.board_id}).order_by("pk")
                    .values_list("pk", flat=True)
                )
            _lock_board_for_admin_save(obj.board_id, BoardMembership, obj.pk)
            stored = BoardMembership.objects.get(pk=obj.pk)
            self.check_row_version(form, stored)
            self.keep_unchanged_fields(obj, form, stored)
        super().save_model(request, obj, form, change)
        # A role change (or a membership moved to another user or board) can
        # end the standing a share link's enabler held (#1865). So can an add:
        # a direct membership outranks a group-derived admin role.
        revoke_lapsed_share_links(
            board_ids={stored_board_id, obj.board_id}, actor_id=request.user.pk,
        )

    def delete_model(self, request, obj):
        board_id = obj.board_id
        with transaction.atomic():
            super().delete_model(request, obj)
            # A removed admin stops holding a share link they enabled (#1865).
            revoke_lapsed_share_links(board_ids=[board_id], actor_id=request.user.pk)

    def delete_queryset(self, request, queryset):
        with transaction.atomic():
            board_ids = set(queryset.values_list("board_id", flat=True))
            super().delete_queryset(request, queryset)
            revoke_lapsed_share_links(board_ids=board_ids, actor_id=request.user.pk)

    def _board_id(self, obj):
        return obj.board_id

    def _payload(self, obj, request):
        return BoardMembershipSerializer(obj, context={"board": obj.board, "request": request}).data

    def _delete_payload(self, obj):
        return {"user_id": obj.user_id}


def _refetched_card_data_or_none(card, request, board):
    """``_refetched_card_data``, or ``None`` when the card was deleted meanwhile.

    The helper raises a DRF ``NotFound`` (#1584), which the Django admin does
    not translate — it would surface as a 500 (#1585). In the admin the write
    the caller just made has already been applied and there is no response body
    to carry a 404, so a vanished card simply has nothing to broadcast: the
    ``card.deleted`` frame from whoever deleted it already told clients.
    """
    try:
        return _refetched_card_data(card, request, board)
    except NotFound:
        return None


class _CardChildBroadcastAdminMixin:
    """Shared broadcast wiring for admin models that hang off a Card.

    CardComment and CardChecklist have no WebSocket event of their own — the
    REST endpoints for comments and checklist items (see
    ``boards/views/cards.py``'s ``comments``/``checklist``/``checklist_item``
    actions) always re-broadcast the *card's* full ``card.updated`` payload
    rather than a comment/checklist-specific event, because the frontend
    renders both inline on the open card panel. This mixin matches that: any
    admin mutation re-broadcasts a freshly refetched ``card.updated`` for the
    parent card (see CardAdmin above for why admin needs this at all).
    """

    def get_readonly_fields(self, request, obj=None):
        # The parent card is chosen when the row is added and fixed afterwards:
        # the broadcast targets the card the row belongs to, and a child moved
        # between cards would leave the previous card's clients out of date.
        fields = tuple(super().get_readonly_fields(request, obj))
        if obj is not None and "card" not in fields:
            fields += ("card",)
        return fields

    def save_model(self, request, obj, form, change):
        if change and obj.pk is not None:
            # Defense in depth next to get_readonly_fields: keep the stored
            # parent card regardless of what the submitted form carried. This
            # read precedes the card lock by necessity (the id is needed to know
            # which card to lock). It is safe unlocked because card is read-only
            # on change and no other path can re-parent the row.
            stored_card_id = (
                type(obj).objects.filter(pk=obj.pk).values_list("card_id", flat=True).first()
            )
            if stored_card_id is not None:
                obj.card_id = stored_card_id
        # Lock the parent card row for the rest of the transaction, as the REST
        # comment/checklist endpoints do (#1587). The child's card foreign key is
        # DEFERRABLE INITIALLY DEFERRED on PostgreSQL, so without the lock a card
        # delete committing before this transaction's COMMIT fails the FK check
        # there, as a 500. A card that is already gone answers 404 instead; the
        # admin's changeform transaction rolls the unsaved row back.
        with transaction.atomic():
            try:
                lock_card_for_write(obj.card_id)
            except CardNotFound:
                raise Http404("Card not found.") from None
            super().save_model(request, obj, form, change)
        card = Card.objects.select_related("board").filter(pk=obj.card_id).first()
        if card is not None:
            self._broadcast_card(request, card)

    @staticmethod
    def _broadcast_card(request, card):
        """Re-broadcast ``card.updated``, or nothing if the card has vanished."""
        card_data = _refetched_card_data_or_none(card, request, card.board)
        if card_data is not None:
            _broadcast.record_board_event(
                card.board_id, _broadcast.EVT_CARD_UPDATED, card_data, actor_id=request.user.pk
            )

    def delete_model(self, request, obj):
        # Capture the card before deleting obj. It is looked up by id rather
        # than through ``obj.card``, whose lazy FK read raises if the card was
        # deleted since the admin loaded ``obj`` (#1585); a vanished card has
        # nothing to broadcast. The refetch happens after the delete so the
        # broadcast reflects the item's removal, same ordering CardViewSet's
        # comment/checklist endpoints use.
        card = Card.objects.select_related("board").filter(pk=obj.card_id).first()
        super().delete_model(request, obj)
        if card is not None:
            self._broadcast_card(request, card)

    def delete_queryset(self, request, queryset):
        # Dedupe by card: a bulk delete can select several rows on the same
        # card, and each card only needs one post-delete broadcast reflecting
        # its final state, not one per deleted row. Cards are looked up by id so
        # a card deleted since the admin loaded the rows is skipped, not a 500.
        card_ids = {o.card_id for o in queryset}
        cards = list(Card.objects.select_related("board").filter(pk__in=card_ids))
        super().delete_queryset(request, queryset)
        # Refetch every card first, then record: a card deleted part-way
        # through is skipped, instead of leaving the earlier cards' events
        # emitted and the later ones' never emitted (#1585).
        refetched = [
            (card, _refetched_card_data_or_none(card, request, card.board))
            for card in cards
        ]
        for card, card_data in refetched:
            if card_data is None:
                continue
            _broadcast.record_board_event(
                card.board_id, _broadcast.EVT_CARD_UPDATED, card_data, actor_id=request.user.pk
            )


@admin.register(CardComment)
class CardCommentAdmin(_CardChildBroadcastAdminMixin, admin.ModelAdmin):
    """Admin for CardComment that broadcasts mutations (see CardAdmin for rationale)."""


@admin.register(CardChecklist)
class CardChecklistAdmin(_CardChildBroadcastAdminMixin, admin.ModelAdmin):
    """Admin for CardChecklist that broadcasts mutations (see CardAdmin for rationale)."""


@admin.register(CardMovement)
class CardMovementAdmin(admin.ModelAdmin):
    """The movement audit trail, view-only (#1469).

    No add, change or delete: the history is a record of who moved what, and
    an admin edit would rewrite it silently. View permission is Django's
    default, so who can browse it is unchanged. Movements leave only with
    their board (``BoardAdmin.get_deleted_objects``).
    """

    list_display = ("moved_at", "card_title", "card_uid", "from_column_name", "to_column_name",
                    "movement_type", "moved_by")
    list_select_related = ("moved_by",)
    list_filter = ("movement_type",)
    search_fields = ("card_uid", "card_title")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False

    def get_readonly_fields(self, request, obj=None):
        return [f.name for f in self.model._meta.fields]

    def get_actions(self, request):
        actions = super().get_actions(request)
        actions.pop("delete_selected", None)
        return actions


# CardActivity is an append-only audit-trail row too (no update path, and
# deletion is not part of any documented workflow) — the #1241 audit flagged
# it and CardMovement as the same gap in principle but lower priority than the
# six models above; CardMovement is read-only above since #1469.
# CardAttachment and Notification were not flagged by the audit. The three
# remain plain registrations; broadcasting admin mutations to them can follow
# the same _BoardEventAdminMixin/_CardChildBroadcastAdminMixin pattern if a
# future audit asks for it.
admin.site.register(CardActivity)
admin.site.register(CardAttachment)
admin.site.register(Notification)
