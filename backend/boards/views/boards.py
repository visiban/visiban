"""BoardViewSet — the primary viewset for board CRUD and board-scoped actions."""

import logging

from django.db import IntegrityError, transaction
from django.db.models import Exists, OuterRef
from django.urls import reverse
from rest_framework import serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ErrorDetail, NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    extend_schema, extend_schema_view, inline_serializer, OpenApiParameter, OpenApiResponse,
)

from accounts.models import User
from accounts.permissions import TokenHasScope
from groups.broadcast import broadcast_group_event as _broadcast_group_event
from groups.services import lock_group_for_board_placement
from visiban.permissions import (
    MustNotHavePendingPasswordChange,
    MustNotHavePendingUsernameChange,
)
from visiban.exceptions import INVALID_QUERY_PARAM, INVALID_QUERY_PARAM_SCHEMA, CodedValidationError
from visiban.request_shape import coerce_int_id, optional_text, require_json_object

from .. import broadcast as _broadcast
from ..models import (
    Board, BoardFavorite, BoardMembership, Card, Column, Notification, SavedFilter,
    Swimlane,
)
from ..permissions import (
    GROUP_ANCESTOR_SELECT_RELATED, SITE_ADMIN,
    get_board_role,
)
from ..serializers import (
    EXPAND_QUERY_PARAMETER,
    BoardSerializer, BoardEventSerializer, BoardFullSerializer,
    BoardMembershipSerializer, SavedFilterSerializer,
)
from ..services.feed import (
    cursor_row_visible,
    feed_horizon,
    feed_queryset,
    prune_marks,
    reader_resume_cursor,
    serialize_feed_rows,
)
from ..services.notifications import create_notifications
from ..utils import create_template_columns, resolve_board_template
from ._helpers import (
    CONTAINER_CHANGED_409, annotate_board_counts, blocked_peers_of, get_board_for_user,
    get_accessible_boards_queryset, lock_board_row_or_404, lock_container_cascade,
    publish_blocked_peers, require_present_or_404,
)
from .analytics import BoardAnalyticsMixin
from .import_export import BoardImportExportMixin
from .invites import BoardInviteLinksMixin

logger = logging.getLogger(__name__)


def _broadcast_board_group_change(board_id, board_data, old_group_id, new_group_id, *, actor_id=None):
    """Group-channel half of a board write that may have changed its group.

    Shared by ``move_group`` and ``perform_update`` (#1684) so a group change
    looks the same to group subscribers whichever endpoint made it. A group
    page only knows the boards it has listed: the group the board left must
    be told to evict it (``board.deleted``), and the group it joined must be
    told to insert it (``board.created``). ``board.updated`` there would be a
    patch of a row the page has never seen, which the web client ignores
    (GroupDetail.tsx). So the new group gets ``board.created`` only, not
    ``board.updated`` as well, matching what ``move_group`` has always sent;
    an unchanged group gets a plain ``board.updated``. ``None`` on either
    side is a personal board, which has no group channel.

    Call it from inside the caller's single ``on_commit`` callback, so the
    old- and new-group frames go out together after the commit (#753).
    BoardAdmin's change path calls it too, so its group-channel sends go
    through this module's ``_broadcast_group_event`` (tests patch it as
    ``boards.views.boards._broadcast_group_event``).

    ``actor_id`` is the acting user, passed through so the group consumer
    sends ``is_starred`` (the actor's own value) to the actor only (#1705).
    """
    if old_group_id is not None and old_group_id != new_group_id:
        # board_id is kept on move-out for clients keyed by the integer id
        # (documented in websockets.md); an outright delete sends uid only.
        _broadcast_group_event(old_group_id, _broadcast.EVT_BOARD_DELETED, {
            "board_uid": board_data.get("uid"), "board_id": board_id,
        })
    if new_group_id is not None and new_group_id != old_group_id:
        _broadcast_group_event(new_group_id, _broadcast.EVT_BOARD_CREATED, board_data, actor_id=actor_id)
    elif new_group_id is not None:
        # Same group: a metadata update.
        _broadcast_group_event(new_group_id, _broadcast.EVT_BOARD_UPDATED, board_data, actor_id=actor_id)

# Change-feed paging bounds (#1114). The ceiling exists so one request cannot ask
# the server to serialize an unbounded slice of a busy board's history; a
# consumer that wants more pages the cursor instead.
_EVENTS_DEFAULT_LIMIT = 100
_EVENTS_MAX_LIMIT = 500


def _parse_events_cursor(raw):
    """Coerce the ``after`` query param to a non-negative int, or 400.

    Rejected rather than silently clamped: a client that sends a malformed
    cursor has lost its place, and quietly restarting it from the beginning of
    the feed would replay history it already processed without telling it.
    The 400 is ``{detail, code: "invalid_query_param"}``, the API's shape for a
    bad query parameter (#1832); the feed is new in 1.2, so its field-keyed
    body appeared only in 1.2 pre-releases, never in a GA.
    """
    if raw in (None, ""):
        return 0
    try:
        after = int(raw)
    except (TypeError, ValueError):
        raise CodedValidationError(INVALID_QUERY_PARAM, "after must be an integer event id.") from None
    if after < 0:
        raise CodedValidationError(INVALID_QUERY_PARAM, "after must not be negative.")
    return after


def _parse_events_limit(raw):
    """Coerce the ``limit`` query param, or 400.

    Out-of-range is an error rather than a clamp for the same reason: a consumer
    that asked for 10000 and silently got 500 would read ``len(results) < limit``
    as "caught up" and stop paging with events still unread.
    """
    if raw in (None, ""):
        return _EVENTS_DEFAULT_LIMIT
    try:
        limit = int(raw)
    except (TypeError, ValueError):
        raise CodedValidationError(INVALID_QUERY_PARAM, "limit must be an integer.") from None
    if not 1 <= limit <= _EVENTS_MAX_LIMIT:
        raise CodedValidationError(INVALID_QUERY_PARAM, f"limit must be between 1 and {_EVENTS_MAX_LIMIT}.")
    return limit


def _events_cursor_expired(board_id, after, page_has_rows, marks, *, role, reader_id):
    """Whether a nonzero ``after`` cursor skips past events retention pruned (#2058, #2079, #2126).

    *marks* is ``prune_marks`` for this reader, read after the page. Every input
    is read through the feed's visibility rule (``boards.services.feed``):
    the reader's visible mark, and whether the cursor is a row the reader may
    see. So the answer for an id the reader is not shown is the answer for an
    id that is not on the board.

    Per event type, a cursor is expired only if an event of this board *after*
    it, that this reader could have seen, was pruned; a record with no type
    counts as well. For a cursor at or below the reader's visible mark: below
    it, something the reader could have read is gone (410 even on an empty
    page, because the events it missed may have been the newest ones); at it,
    nothing it could have read was lost, whatever else was pruned (an idle
    consumer on a quiet board keeps reading). ``prune_marks`` says how
    visibility is settled.

    Above the visible mark, or on a board with no mark, a cursor whose row the
    reader may not see, with newer rows the reader may see, is 410:

    * A board with no mark may still have been pruned: installs that pruned
      before #2058 recorded nothing. Treating "no record" as "nothing lost"
      would turn a known-unknown into a silent skip, so such a board keeps
      the old behavior until its next prune writes a mark.
    * A cursor the reader really held above its visible mark is a row it was
      shown (an in-page ``next_cursor``) or the newest such row (a ``410``'s
      ``next_cursor``), and that row was not pruned, or the visible mark would
      cover it. So a missing row there is not a position the reader held
      (another board's id, or a made-up number), and it stays a loud 410
      rather than a page that starts somewhere the consumer never was.

    The limit: a cursor that was never this board's and sits exactly at the
    reader's visible mark reads on. It cannot be told from a resume point the
    feed handed out, and nothing the reader could have read is skipped past it.
    A reader whose role narrowed since it was given a cursor at an admin-only
    row can get one 410 here; that errs toward a re-sync, never a skip.
    """
    if marks.visible is not None and after <= marks.visible:
        return after < marks.visible
    return page_has_rows and not cursor_row_visible(board_id, after, role=role, reader_id=reader_id)


def _group_gone_error():
    """The ``400 {"group": [...]}`` the serializer gives an unknown group (#1638).

    Board create and ``PATCH``/``PUT`` re-check the target group under its
    lock; one deleted since validation is answered exactly as an unknown id
    would have been, so a client sees one documented shape either way.
    """
    from ..serializers import _BOARD_GROUP_NOT_ALLOWED_MSG

    return ValidationError({"group": [ErrorDetail(_BOARD_GROUP_NOT_ALLOWED_MSG, code="does_not_exist")]})

# ``get_queryset()`` reads ``starred`` by hand, so no filter backend publishes
# it (#2031). It is compared to the literal ``"true"`` (case-sensitive) and
# never reaches an ORM text lookup, so ``query_text()`` is not needed.
_BOARDS_STARRED_PARAMETER = OpenApiParameter(
    name="starred",
    type=OpenApiTypes.BOOL,
    location=OpenApiParameter.QUERY,
    required=False,
    description=(
        "`true` returns only the boards the requesting user has starred. "
        "Omitted or any other value returns every board the user can access."
    ),
)


# list and retrieve are the inherited ModelViewSet actions, so their schema is
# set here rather than on a method. Both parse ``expand`` (get_queryset and, on
# list, get_serializer_context); only list documents ``starred`` (#2031).
@extend_schema_view(
    list=extend_schema(parameters=[EXPAND_QUERY_PARAMETER, _BOARDS_STARRED_PARAMETER]),
    retrieve=extend_schema(parameters=[EXPAND_QUERY_PARAMETER]),
)
class BoardViewSet(
    BoardAnalyticsMixin,
    BoardImportExportMixin,
    BoardInviteLinksMixin,
    viewsets.ModelViewSet,
):
    """CRUD endpoints for boards, scoped to boards the requesting user has access to."""

    # Constrains the router-generated `pk` regex to digits, so a non-numeric
    # board id 404s at URL resolution instead of reaching the view and raising
    # an uncaught ValueError from the ORM's int coercion. NestedDefaultRouter
    # derives every `board_pk` segment under boards_router (columns,
    # swimlanes, labels, cards, custom-fields) from *this* viewset's
    # lookup_value_regex, so setting it here also fixes those nested routes.
    lookup_value_regex = r"\d+"

    # Explicitly enumerate the global default permission chain (#989) so that
    # any future @action(permission_classes=[...]) override is visibly diffed
    # against the documented baseline rather than silently dropping the
    # MustNotHavePendingPasswordChange / MustNotHavePendingUsernameChange
    # gates that the global default supplies.
    permission_classes = [
        IsAuthenticated,
        MustNotHavePendingPasswordChange,
        MustNotHavePendingUsernameChange,
        TokenHasScope,
    ]
    serializer_class = BoardSerializer

    def get_serializer_context(self):
        context = super().get_serializer_context()
        # When ?expand=group is requested on a list response, build a one-query
        # ancestor map so GroupBriefSerializer.get_ancestors() can resolve every
        # ancestor without walking parent pointers per board (#919).
        if self.action == "list":
            expand = self.request.query_params.get("expand", "")
            if "group" in {p.strip() for p in expand.split(",") if p.strip()}:
                from groups.models import Group as _Group
                group_ids = set(
                    self.get_queryset()
                    .exclude(group_id=None)
                    .values_list("group_id", flat=True)
                )
                if group_ids:
                    # Include the direct groups AND all their ancestors so the
                    # walker in GroupBriefSerializer.get_ancestors() can traverse
                    # the full chain without issuing per-level FK queries.
                    groups = _Group.objects.filter(pk__in=group_ids).select_related(
                        *["__".join(["parent"] * d) for d in range(1, 7)]
                    )
                    ancestor_map: dict = {}
                    for g in groups:
                        node = g
                        while node is not None:
                            ancestor_map[node.pk] = {
                                "name": node.name,
                                "parent_id": node.parent_id,
                            }
                            node = node.parent  # pre-loaded via select_related
                    context["group_ancestor_map"] = ancestor_map
        return context

    def get_queryset(self):
        user = self.request.user
        # Access-scoping (owner / direct membership / group ancestry / site-admin)
        # is factored out to get_accessible_boards_queryset() so the cross-board
        # card query endpoint (#1112) shares the same rule instead of a second
        # copy that can drift.
        qs = get_accessible_boards_queryset(user)
        if self.request.query_params.get("starred") == "true":
            qs = qs.filter(favorites__user=user)
        # select_related("owner", "group") prevents one JOIN-per-board for the
        # owner and group_name serializer fields. Annotate to avoid 3 further
        # subqueries per board (member_count, card_count, archived_card_count,
        # is_starred). The /full/ endpoint loads card data via its own queryset in
        # get_board_for_user(); BoardSerializer (used by list/retrieve) never
        # reads card fields so prefetching cards__labels / cards__assignee
        # here only loaded data that was immediately discarded.
        # When ?expand=group is requested, pre-load the full 6-level ancestor
        # chain so GroupBriefSerializer.get_ancestors() can walk parent pointers
        # without issuing one FK query per ancestor level per board (#819).
        expand = self.request.query_params.get("expand", "")
        expand_group = "group" in {p.strip() for p in expand.split(",") if p.strip()}
        if expand_group:
            group_related = "__".join(["group"] + ["parent"] * 6)
        else:
            group_related = "group"
        return annotate_board_counts(qs.select_related("owner", group_related)).annotate(
            _is_starred=Exists(
                BoardFavorite.objects.filter(board=OuterRef("pk"), user=user)
            ),
        )

    def perform_create(self, serializer):
        # Wrap the entire creation sequence in a transaction so a failure
        # in any step (e.g. swimlane creation) rolls back the board,
        # membership, and columns — preventing orphaned records.
        # Read before any write so a malformed swimlane_name is a clean 400 (#1669).
        swimlane_name = optional_text(self.request.data, "swimlane_name")
        with transaction.atomic():
            # The target group row before the board insert (#1638): see
            # lock_group_for_board_placement. A create into a group being
            # deleted answers the serializer's unknown-group 400 instead of a
            # 500 at COMMIT.
            target_group = serializer.validated_data.get("group")
            if target_group is not None and not lock_group_for_board_placement(target_group.pk):
                raise _group_gone_error()
            # The serializer checked the caller's standing in the group before
            # this transaction; check it again against the group re-read here,
            # as the PATCH path does (recheck_group_under_lock). A fresh read,
            # not a wait: see security-invariants Rule 6.
            serializer.recheck_group_under_lock(None)
            board = serializer.save(owner=self.request.user)
            BoardMembership.objects.create(board=board, user=self.request.user, role=BoardMembership.Role.ADMIN)

            # `template` was already validated by BoardSerializer (unknown
            # explicit slugs are rejected with a 400 before perform_create
            # ever runs) — resolve_board_template() just looks up the row to
            # apply, defaulting the omitted/blank case to simple_kanban (#1115).
            template = resolve_board_template(serializer.validated_data.get("template", ""))
            create_template_columns(board, template)

            # Prefer the user-supplied swimlane name from the modal prompt;
            # no template currently defines a non-empty default, so an
            # omitted swimlane_name simply creates no swimlane.
            if swimlane_name:
                Swimlane.objects.create(board=board, name=swimlane_name, position=0, color="#6B7280")

            # Broadcast board.created so group members and dashboard subscribers
            # can refresh their board list without a manual reload.
            # NOTE: this event goes to channel board_{id}, which currently has no
            # subscribers at creation time.  A future user-level notification channel
            # will relay it to the dashboard.  The backend broadcast is added now so
            # the event shape is established as a 1.0 contract.
            board_id = board.id
            # Re-fetch through get_queryset() so the broadcast payload uses the
            # annotated row (_member_count, _card_count, _is_starred) rather
            # than the bare post-save instance. Without the annotations,
            # BoardSerializer.get_is_starred() falls through to a live EXISTS
            # query on every board.created broadcast.
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": self.request}).data
            # Group-scoped broadcast powers the boards-list live view (#753). Keyed
            # off the annotated row so the frontend can insert without a refetch.
            group_id = annotated.group_id
            # Persisted here rather than via record_board_event so the board and
            # group channels keep firing from one on_commit callback (#753); the
            # row still lands inside this transaction, which is what #1114 needs.
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_CREATED, board_data, actor_id=self.request.user.id,
            )
            def _broadcast_created(
                bid=board_id, bd=board_data, gid=group_id, eid=event_id, aid=self.request.user.id,
            ):
                _broadcast.broadcast_board_event(
                    bid, _broadcast.EVT_BOARD_CREATED, bd, event_id=eid, actor_id=aid,
                )
                if gid is not None:
                    _broadcast_group_event(gid, _broadcast.EVT_BOARD_CREATED, bd, actor_id=aid)
            transaction.on_commit(_broadcast_created)

    def perform_update(self, serializer):
        """Guard board-level updates: only admins can edit any board field.

        Viewers and collaborators have read-only access. Members and above can
        read but only admins can change the board name, description, settings, or
        enforcement flags. Previously only enforcement flags were guarded, which
        allowed viewers and members to rename boards via PATCH.
        """
        board = serializer.instance
        role = get_board_role(self.request.user, board)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied("Only board admins can edit board settings.")
        with transaction.atomic():
            # A PATCH/PUT that names a group takes that group row before the
            # board row (#1638, lock_group_for_board_placement): group ->
            # board, the order a group delete takes, so a group change inside
            # a subtree being deleted cannot deadlock with the delete. A group
            # deleted meanwhile is the serializer's unknown-group 400, not a
            # 404 (which here means the board itself is gone).
            target_group = serializer.validated_data.get("group")
            if target_group is not None and not lock_group_for_board_placement(target_group.pk):
                raise _group_gone_error()
            # Board row first (#1602): a board delete holds it from the start
            # of its cascade, and a PATCH queued behind one must answer 404,
            # not let save() fall back to an INSERT that resurrects the board.
            lock_board_row_or_404(board, no_key=True)
            # save() writes every column, and ``board`` is the snapshot read
            # before the lock. Reload the row under the lock so the PATCH
            # applies only the fields the request sent; fields another
            # request changed while this one waited keep their values.
            board.refresh_from_db()
            # The group rule was checked against the pre-lock snapshot; check
            # it again against the row as it is now (#1655).
            serializer.recheck_group_under_lock(board)
            # The group the board is in before this write, read from the
            # locked, refreshed row (as move_group does): a PATCH/PUT that
            # changes ``group`` is a group move to group subscribers (#1684).
            old_group_id = board.group_id
            serializer.save()
            board = serializer.instance
            board_id = board.id
            if board.group_id != old_group_id:
                # A group-derived admin role can end with the group change; a
                # share link enabled through it ends with it (#1865), as on
                # move-group.
                from ..services.share_links import revoke_lapsed_share_links
                revoke_lapsed_share_links(board_ids=[board_id])
            # Re-fetch through get_queryset() so the serializer response includes
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": self.request}).data
            new_group_id = annotated.group_id
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_UPDATED, board_data, actor_id=self.request.user.id,
            )
            def _broadcast_updated(
                bid=board_id, bd=board_data,
                og=old_group_id, ng=new_group_id, eid=event_id, aid=self.request.user.id,
            ):
                _broadcast.broadcast_board_event(
                    bid, _broadcast.EVT_BOARD_UPDATED, bd, event_id=eid, actor_id=aid,
                )
                _broadcast_board_group_change(bid, bd, og, ng, actor_id=aid)
            transaction.on_commit(_broadcast_updated)

    @extend_schema(responses={204: None, 409: CONTAINER_CHANGED_409})
    def destroy(self, request, *args, **kwargs):
        board = self.get_object()
        role = get_board_role(request.user, board)
        # Board deletion is intentionally restricted to the owner and site admins.
        # Board admins (non-owners) can manage board structure but cannot delete
        # the board — deletion is irreversible and only the owner should hold that
        # authority. See docs/features/rbac/roles.md for the full role matrix.
        if board.owner != request.user and role != SITE_ADMIN:
            raise PermissionDenied
        board_id = board.id
        board_uid = board.uid
        board_name = board.name
        with transaction.atomic():
            # Lock the board's cards, then its columns, before Django
            # collects the cascade (#1599, #1602): a card child write, or a
            # card created or moved into the board, that commits mid-cascade
            # otherwise fails this delete's deferred FK check at COMMIT (500).
            # See lock_cards_for_cascade for the lock order.
            lock_container_cascade(
                board.cards.all(),
                entry_columns=Column.objects.filter(board_id=board.pk),
                boards=Board.objects.filter(pk=board.pk),
            )
            # Queued behind another delete of this board: nothing is left to
            # delete, so answer 404 rather than a second board.deleted.
            require_present_or_404(Board.objects.filter(pk=board.pk))
            # The group the board is in when it is deleted, read from the row
            # the lock above holds: ``board`` came from get_object() before the
            # lock, so a move-group that committed meanwhile would make
            # board.deleted go to the group the board already left (#1712;
            # same ordering as move_group).
            group_id = (
                Board.objects.filter(pk=board.pk).values_list("group_id", flat=True).first()
            )
            # A board's cards can only block cards on the same board through
            # the API, and those are deleted with it — but the Django admin can
            # move a card, relations and all, to another board, so a card on
            # a *surviving* board can be blocked by one of these (#1634). Its
            # card.updated goes to its own board, never to this one.
            peers = blocked_peers_of(Card.objects.filter(board_id=board.pk))
            board.delete()
            # board_uid is the stable identifier for terminal events (#979).
            # Deletion events for cards, columns, swimlanes and labels carry only
            # the *_uid; board.deleted matches that contract. (saved_filter events
            # are the exception: they carry integer filter_id/user_id.)
            payload = {"board_uid": board_uid}
            # The feed row survives the board it describes: BoardEvent.board_id is
            # a plain integer, not a cascading FK, precisely so a consumer holding
            # a cursor can still read the terminal board.deleted event (#1114).
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_DELETED, payload, actor_id=request.user.id,
            )
            def _broadcast_deleted(bid=board_id, gid=group_id, pl=payload, eid=event_id):
                _broadcast.broadcast_board_event(bid, _broadcast.EVT_BOARD_DELETED, pl, event_id=eid)
                if gid is not None:
                    _broadcast_group_event(gid, _broadcast.EVT_BOARD_DELETED, pl)
            transaction.on_commit(_broadcast_deleted)
            publish_blocked_peers(peers, request)
        # Logged only once the delete has committed: a ContainerChanged 409
        # (#1602) raises out of the block above with nothing deleted.
        logger.info(
            "board.deleted board_id=%d board_name=%s deleted_by=%d deleted_by_username=%s",
            board_id, board_name, request.user.pk, request.user.username,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)

    # Schema only (#1783). Without this both methods inherited the viewset's
    # serializer: POST documented a required BoardRequest body the view never
    # reads, and DELETE documented a bodiless 204 although both branches have
    # always answered 200 with the re-serialized board (so the client can
    # resync is_starred). The response is unchanged.
    @extend_schema(request=None, responses={200: BoardSerializer})
    @action(detail=True, methods=["post", "delete"], url_path="star")
    def star(self, request, pk=None):
        """Star or unstar a board for the requesting user."""
        board = self.get_object()
        with transaction.atomic():
            # Board row first (#1602): a favorite committed between a board
            # delete's cascade read and its DELETE fails the delete's deferred
            # FK check at COMMIT. Queued behind the delete this answers 404.
            lock_board_row_or_404(board, no_key=True)
            if request.method == "POST":
                BoardFavorite.objects.get_or_create(user=request.user, board=board)
                is_starred = True
            else:
                BoardFavorite.objects.filter(user=request.user, board=board).delete()
                is_starred = False
            # Re-fetch via get_queryset() so the _is_starred annotation reflects the
            # change just made — the object fetched by get_object() above is stale.
            board = self.get_queryset().get(pk=board.pk)
            # Star is per-user state, but a user may have multiple tabs open on
            # the same board; broadcast so other sessions of the same user sync
            # without a full refetch (#814). The board and group consumers
            # forward the frame only to this user's own sockets, and the change
            # feed returns the row only to this user (#1677) — actor_id below
            # is what the feed matches on.
            board_uid = board.uid
            board_id = board.pk
            group_id = board.group_id
            user_id = request.user.id
            star_payload = {"uid": board_uid, "user_id": user_id, "is_starred": is_starred}

            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_STAR_CHANGED, star_payload, actor_id=user_id,
            )

            def _broadcast_star() -> None:
                _broadcast.broadcast_board_event(
                    board_id, _broadcast.EVT_BOARD_STAR_CHANGED, star_payload, event_id=event_id
                )
                if group_id is not None:
                    # Also fan out to the group channel so the GroupDetail page
                    # updates the star indicator in real time without a refetch
                    # (#952).  Same per-user filter applies — clients ignore
                    # events whose user_id does not match their own.
                    _broadcast_group_event(group_id, _broadcast.EVT_BOARD_STAR_CHANGED, star_payload)

            transaction.on_commit(_broadcast_star)
        return Response(self.get_serializer(board).data)

    @extend_schema(
        summary="Enable the board's public share link",
        description=(
            "Generates a fresh token, replacing any existing one (this is also how a "
            "link is rotated). Admin only. This response is where clients read the "
            "token: show it to the admin now. The board detail field `share_token` is "
            "deprecated since 1.2 and removed in 2.0."
        ),
        methods=["POST"],
        request=inline_serializer(
            name="ShareBoard",
            fields={
                "expires_in_days": serializers.ChoiceField(
                    choices=[7, 30, 90], required=False, allow_null=True,
                    help_text="Omit or pass null for a link that never expires.",
                ),
            },
        ),
        responses={
            200: inline_serializer(
                name="ShareBoardResponse",
                fields={
                    "share_token": serializers.CharField(
                        allow_null=True,
                        help_text="The new share link token. Show it to the admin now.",
                    ),
                    "share_url": serializers.CharField(allow_null=True),
                    "share_token_expires_at": serializers.DateTimeField(allow_null=True),
                    "share_token_issued_at": serializers.DateTimeField(
                        allow_null=True,
                        help_text=(
                            "When this link was issued (1.3+, #1967). The same value is the "
                            "issued_at of the share_link.updated event for this change, so a "
                            "client can tell its own enable or rotate from another admin's."
                        ),
                    ),
                },
            ),
            400: OpenApiResponse(
                description="`expires_in_days` was not an integer, or not one of 7/30/90.",
                response=inline_serializer(name="ShareBoardBadRequest", fields={"detail": serializers.CharField()}),
            ),
        },
    )
    @extend_schema(
        summary="Revoke the board's public share link",
        description="Clears the token, immediately invalidating any live share link. Admin only.",
        methods=["DELETE"],
        responses={
            200: inline_serializer(
                name="UnshareBoardResponse",
                fields={
                    "share_token": serializers.CharField(allow_null=True),
                    "share_url": serializers.CharField(allow_null=True),
                    "share_token_expires_at": serializers.DateTimeField(allow_null=True),
                    "share_token_issued_at": serializers.DateTimeField(allow_null=True),
                },
            ),
        },
    )
    @action(detail=True, methods=["post", "delete"], url_path="share")
    def share(self, request, pk=None):
        """Enable or revoke the public share link for a board.

        POST  — generates a fresh UUID token (replaces any existing token).
        DELETE — clears the token, immediately invalidating any live share link.
        Both operations are admin-only; the token is a public credential.

        The POST response is the one place clients are meant to read the token
        (#1935): the SPA shows the link once, right after create or rotate, and
        ``BoardFullSerializer.share_token`` is deprecated until its 2.0 removal.
        """
        from datetime import timedelta
        from django.utils import timezone
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Optional TTL (#804). Null or missing means "never expires"; any
        # integer in ALLOWED_TTL_DAYS sets share_token_expires_at to now+N days.
        # Kept as a fixed allowlist rather than an arbitrary int so that UI
        # copy and docs ("Expire in 7/30/90 days / never") stay authoritative.
        ALLOWED_TTL_DAYS = {7, 30, 90}
        with transaction.atomic():
            # Board row first (#1602): a share toggle queued behind a board
            # delete answers 404 instead of a 500 from save(update_fields=...)
            # matching no row.
            lock_board_row_or_404(board, no_key=True)
            if request.method == "POST":
                # Re-derive the caller's standing under the board lock (#1865):
                # the role above was read before it, and a role change or
                # removal that held the lock first has committed by now. The
                # link records its enabler, and must not be issued to one who
                # no longer qualifies. The account is re-read too: request.user
                # carries the active and all-content flags read at sign-in.
                from ..services.share_links import share_enabler_has_standing
                fresh = Board.objects.select_related(GROUP_ANCESTOR_SELECT_RELATED).get(pk=board.pk)
                fresh_user = User.objects.filter(pk=request.user.pk).first()
                if not share_enabler_has_standing(fresh_user, fresh):
                    raise PermissionDenied
                body = request.data
                # A JSON body that parses to a non-object (e.g. `true` or a bare
                # number/string/array) previously reached `.get()` unguarded —
                # `hasattr(request, "data")` is always true, it never actually
                # tested the parsed body's type — and surfaced as a 500 instead
                # of a 400. `body` must be dict-like to have an `expires_in_days`
                # key at all, so anything else is rejected up front.
                if not isinstance(body, dict):
                    return Response(
                        {"detail": "Request body must be a JSON object."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                expires_in_days = body.get("expires_in_days")
                expires_at = None
                if expires_in_days is not None:
                    try:
                        days = int(expires_in_days)
                    except (TypeError, ValueError):
                        return Response(
                            {"detail": "expires_in_days must be an integer or null."},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    if days not in ALLOWED_TTL_DAYS:
                        return Response(
                            {"detail": f"expires_in_days must be one of {sorted(ALLOWED_TTL_DAYS)} or null."},
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    expires_at = timezone.now() + timedelta(days=days)
                # The token and its hash are written together (#1880): the
                # public view resolves the link by the hash.
                board.issue_share_token()
                board.share_token_expires_at = expires_at
                # The link lasts while this admin keeps admin standing on the
                # board (#1865, boards/services/share_links.py).
                board.share_enabled_by = request.user
                board.save(update_fields=Board.SHARE_LINK_FIELDS)
                share_url = request.build_absolute_uri(f"/api/share/{board.share_token}")
                # Rotation signal (#1967): the same value goes out as
                # share_link.updated's ``issued_at``, so the tab that made this
                # request can tell its own echo from another admin's rotation.
                # Not stored, and not derived from the token.
                issued_at = timezone.now()
                response_data = {
                    "share_token": str(board.share_token),
                    "share_url": share_url,
                    "share_token_expires_at": expires_at.isoformat() if expires_at else None,
                    "share_token_issued_at": issued_at.isoformat(),
                }
            else:
                # DELETE — clear both the token and the TTL so re-enabling
                # starts from a clean "never expires" default.
                board.clear_share_link()
                board.save(update_fields=Board.SHARE_LINK_FIELDS)
                # share_url is included as null on DELETE so the response
                # shape matches POST and the TS ShareActionResponse interface
                # does not need a discriminated union (#1005).
                issued_at = None
                response_data = {
                    "share_token": None, "share_url": None, "share_token_expires_at": None,
                    "share_token_issued_at": None,
                }

            # board.updated is kept for clients that treat it as a "board
            # changed" signal, but it cannot carry the share state: the share
            # fields are in ADMIN_ONLY_BOARD_FIELDS and dropped from every
            # payload. Re-fetch through get_queryset() so the payload includes
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            # Recorded with no actor (#2043).
            from ..services.share_links import record_share_link_updated, record_share_state_board_updated
            board_id = board.pk
            annotated = self.get_queryset().get(pk=board_id)
            board_summary = BoardSerializer(annotated, context={"request": request}).data
            record_share_state_board_updated(board_id, board_summary)
            # The share state itself goes out as the admin-only
            # share_link.updated (#1967), so other admin sessions and an open
            # Sharing tab update without a reload. Never carries the token, and
            # is recorded with no actor.
            record_share_link_updated(board, issued_at=issued_at)
        return Response(response_data)

    # Schema only (#1783): the view reads `group_id` alone, not a BoardRequest.
    # Optional because a missing key means the same as null (move to personal).
    @extend_schema(
        request=inline_serializer(
            name="BoardMoveGroup",
            fields={
                "group_id": serializers.IntegerField(
                    required=False, allow_null=True,
                    help_text="Target group id, or null (or omitted) to make the board personal.",
                ),
            },
        ),
        responses={200: BoardSerializer},
    )
    @action(detail=True, methods=["post"], url_path="move-group")
    def move_group(self, request, pk=None):
        """Move a board into a group the requesting user administers (or back to personal)."""
        board, role = get_board_for_user(pk, request.user)
        if board.owner != request.user and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied

        group_id = require_json_object(request).get("group_id")  # None = move to personal
        if group_id is not None:
            from groups.views import resolve_group_for_board_placement
            board.group = resolve_group_for_board_placement(request.user, group_id)
        else:
            board.group = None

        with transaction.atomic():
            # The target group row before the board row (#1638): a group
            # delete holds the group rows of its subtree from the start and
            # reaches this board at its collector's SET_NULL, so a move that
            # held the board row and asked for the group only at COMMIT (the
            # deferred foreign key) deadlocked against it. A move into a group
            # being deleted answers 404. See lock_group_for_board_placement.
            if board.group_id is not None and not lock_group_for_board_placement(board.group_id):
                raise NotFound
            if board.group_id is not None:
                # Resolved above, before this transaction; judge the caller
                # again against the group re-read here (a fresh read, not a
                # wait: see security-invariants Rule 6).
                from groups.views import require_group_admin_reread
                require_group_admin_reread(request.user, board.group)
            # Board row first (#1602): a move queued behind a board delete
            # answers 404 rather than re-inserting the board. update_fields so
            # the write is an UPDATE only and cannot overwrite settings with
            # the snapshot read before the lock.
            locked = lock_board_row_or_404(board, no_key=True)
            # The group the board is leaving, read from the locked row: the
            # snapshot above may predate a move that committed while this one
            # queued, which would send board.deleted to a group the board had
            # already left and leave the real old group unnotified.
            old_group_id = locked.group_id
            board.save(update_fields=["group", "updated_at"])
            board_id = board.id
            # A group-derived admin role can end with the move; a share link
            # enabled through it ends with it (#1865).
            from ..services.share_links import revoke_lapsed_share_links
            revoke_lapsed_share_links(board_ids=[board_id])
            # Re-fetch through get_queryset() so the response and broadcast include
            # annotations (_member_count, _card_count, _is_starred) rather than
            # triggering per-field subqueries from the bare post-save instance (#647).
            annotated = self.get_queryset().get(pk=board_id)
            board_data = BoardSerializer(annotated, context={"request": request}).data
            new_group_id = annotated.group_id
            # Single on_commit callback so subscribers on the old and new group
            # channels observe the move atomically (#753).
            event_id = _broadcast.persist_board_event(
                board_id, _broadcast.EVT_BOARD_UPDATED, board_data, actor_id=request.user.id,
            )
            def _broadcast_move(
                bid=board_id, bd=board_data,
                og=old_group_id, ng=new_group_id, eid=event_id, aid=request.user.id,
            ):
                _broadcast.broadcast_board_event(
                    bid, _broadcast.EVT_BOARD_UPDATED, bd, event_id=eid, actor_id=aid,
                )
                _broadcast_board_group_change(bid, bd, og, ng, actor_id=aid)
            transaction.on_commit(_broadcast_move)
        return Response(board_data)

    # Without this the action inherits the viewset's serializer_class, and the
    # schema described /full/ as a plain `Board` — a shape it does not return
    # (no card_count/member_count; columns, cards, members, ... undocumented).
    # Publishing the real serializer is what lets `members` carry its own
    # effective-roster component (#1137). Schema only; the body is unchanged.
    @extend_schema(responses=BoardFullSerializer, parameters=[EXPAND_QUERY_PARAMETER])
    @action(detail=True, methods=["get"])
    def full(self, request, pk=None):
        """Return the full board state: columns, swimlanes, cards, labels, and members.

        The resolved role is threaded into serializer context so that
        get_current_user_role() and get_swimlanes() can reuse it without
        issuing a second get_board_role() query.
        """
        board, role = get_board_for_user(pk, request.user, with_archived_card_count=True)
        return Response(BoardFullSerializer(board, context={"request": request, "role": role}).data)

    @extend_schema(
        operation_id="api_v1_boards_events_list",
        summary="Read the board's change feed",
        description=(
            "Returns committed board mutation events in ascending `id` order, so an "
            "out-of-process consumer can resume after a dropped WebSocket instead of "
            "re-fetching `/full/`. Each event is the payload that was broadcast, "
            "verbatim.\n\n"
            "Pass the last feed row `id` you processed as `after`. Paging this way never skips "
            "an event: a page stops below any event still committing, so it can come "
            "back empty for a moment while a write commits. WebSocket frames carry the "
            "same value as `event_id`, but they can arrive out of `event_id` order, so "
            "resume only from a feed row `id` (the last row this feed returned, equal to "
            "`next_cursor` when a page has one; after an empty page keep the `after` you sent), "
            "never from a frame's `event_id`, and skip ids already applied (#2159). "
            "`next_cursor` is the cursor for the "
            "following page, or `null` when the caller is caught up. `next` carries "
            "the identical value and is deprecated; use `next_cursor`.\n\n"
            "Events outside the retention window are pruned. A cursor with pruned "
            "events after it returns `410 Gone` — re-sync via `/full/`, then resume "
            "with the 410 body's `next_cursor` as `after`."
        ),
        parameters=[
            OpenApiParameter(
                name="after", type=int, location=OpenApiParameter.QUERY, required=False,
                description="Return events with an id strictly greater than this. Omit or 0 to start at the oldest retained event.",
            ),
            OpenApiParameter(
                name="limit", type=int, location=OpenApiParameter.QUERY, required=False,
                description=f"Maximum events to return (1–{_EVENTS_MAX_LIMIT}). Default {_EVENTS_DEFAULT_LIMIT}.",
            ),
        ],
        responses={
            200: inline_serializer(
                name="BoardEventFeedPage",
                fields={
                    "results": BoardEventSerializer(many=True),
                    "next_cursor": serializers.IntegerField(
                        allow_null=True,
                        help_text=(
                            "Cursor for the next page (pass it as `after`), or null "
                            "when caught up."
                        ),
                    ),
                    # Deprecated duplicate of next_cursor, kept through 1.x (#1869).
                    # The `deprecated` flag is set by schema_hooks.mark_deprecated_fields.
                    "next": serializers.IntegerField(
                        allow_null=True,
                        help_text="Deprecated: use `next_cursor`. Identical value.",
                    ),
                },
            ),
            400: OpenApiResponse(
                description=(
                    "`after` or `limit` is not a valid integer, or is out of range "
                    '(`{"detail": ..., "code": "invalid_query_param"}`).'
                ),
                response=INVALID_QUERY_PARAM_SCHEMA,
            ),
            410: OpenApiResponse(
                description=(
                    "Events after the cursor have been pruned; the caller must re-sync "
                    "via /full/, then resume the feed from `next_cursor`."
                ),
                response=inline_serializer(
                    name="BoardEventCursorExpired",
                    fields={
                        "detail": serializers.CharField(),
                        "code": serializers.CharField(),
                        "resync_url": serializers.CharField(),
                        "next_cursor": serializers.IntegerField(
                            help_text=(
                                "Added in 1.3. After re-syncing via `resync_url`, "
                                "resume the feed with this value as `after`. An event "
                                "written between this response and the re-sync may be "
                                "delivered twice, never skipped."
                            ),
                        ),
                    },
                ),
            ),
        },
    )
    @action(detail=True, methods=["get"])
    def events(self, request, pk=None):
        """Return a page of this board's change feed (#1114).

        Access is the board role, resolved by ``get_board_for_user`` — the same
        gate as ``/full/`` and as the WebSocket handshake. The page holds every
        retained row for the board, whenever the caller joined it, bounded by
        retention. Each row is filtered for the caller by the rules the socket
        applies per subscriber, so the feed is not a way to read something the
        socket would not send: per-user rows, and admin-only rows for a reader
        below admin (#1967), are excluded in the query below, and
        ``BoardEventSerializer`` applies the per-reader field rules
        (``is_moderator``, ``is_site_admin``, ``invite``, admin-only board
        fields, swimlane custom field values). See security-invariants Rule 8.

        Cross-board reads are impossible by construction rather than by check:
        every query is filtered on ``board_id`` first, so an ``after`` cursor
        lifted from another board selects nothing of that board's — it is only
        ever a number compared against this board's rows.
        """
        board, role = get_board_for_user(pk, request.user, slim=True)
        after = _parse_events_cursor(request.query_params.get("after"))
        limit = _parse_events_limit(request.query_params.get("limit"))

        # Both redaction layers live in boards.services.feed (#863) so the
        # webhook dispatcher and enterprise readers apply exactly the same
        # rules: whole-row exclusions here, per-field stripping on serialize.
        # Bound the page by the commit-safe horizon (#2053). Ids are drawn at
        # INSERT, so a row with a higher id can be visible while a lower one is
        # still uncommitted. A page ending past that lower id would move the
        # caller's cursor beyond it for good. The horizon is a point no
        # uncommitted row lies below. When a write is still in flight it is
        # None, and the page holds nothing past `after` this time: a short delay,
        # never a skip.
        ceiling = feed_horizon(board.id)
        if ceiling is None:
            ceiling = after
        qs = feed_queryset(board.id, role=role, reader_id=request.user.id).filter(pk__lte=ceiling)
        if after:
            qs = qs.filter(pk__gt=after)
        rows = list(qs.order_by("id")[:limit])

        # Retention check: a cursor is expired iff an event after it that this
        # reader could have seen was pruned. See _events_cursor_expired for the
        # prune record it reads (#2058, #2079) and the boards that fall back to
        # the older inference.
        #
        # Deliberately ordered AFTER the page fetch. Read the mark first and a
        # prune committing in between could delete events this page then
        # skips, with the stale mark saying nothing was lost: a silent gap.
        # Read it after, and a prune landing in between can only make the mark
        # newer than the page, which errs toward a 410, never toward a skip.
        marks = prune_marks(board.id, role=role, reader_id=request.user.id) if after else None
        if after and _events_cursor_expired(
            board.id, after, bool(rows), marks, role=role, reader_id=request.user.id
        ):
            return Response(
                {
                    "detail": (
                        # Worded for every 410 branch: the cursor's own row may
                        # still exist when a later event was pruned (#2058).
                        "This cursor can no longer be resumed — events after it "
                        "may have been pruned by the retention window. Re-sync the "
                        "board state and resume from the newest event id you see "
                        "after that."
                    ),
                    "code": "cursor_expired",
                    "resync_url": request.build_absolute_uri(
                        reverse("board-full", kwargs={"pk": board.pk})
                    ),
                    # Added in 1.3 (#2058): resume `after=` this once re-synced.
                    # `/full/` carries no event id, so without it a consumer
                    # told to re-sync has no position to resume from. Computed
                    # from this reader's rows and marks (#2126); see
                    # reader_resume_cursor for why it is not board-wide.
                    "next_cursor": reader_resume_cursor(
                        board.id, marks, role=role, reader_id=request.user.id, ceiling=ceiling
                    ),
                },
                status=status.HTTP_410_GONE,
            )

        # `next_cursor` (and its deprecated alias `next`) means "there is probably more", not "the newest id you hold".
        # A full page may or may not be the last one; a short page definitely is.
        next_cursor = rows[-1].pk if len(rows) == limit else None
        # One bulk user fetch for the whole page (#1663), never one per row.
        return Response({
            "results": serialize_feed_rows(
                board.id, rows, role=role, reader_id=request.user.id,
            ),
            "next_cursor": next_cursor,
            # Deprecated alias: 1.2.0-beta.1 shipped `next` as a documented public
            # key, so it stays, with an identical value, until a major bump (#1869).
            "next": next_cursor,
        })

    @extend_schema(
        summary="List saved filter presets on a board",
        methods=["GET"],
        responses=SavedFilterSerializer(many=True),
    )
    @extend_schema(
        summary="Create a saved filter preset on a board",
        methods=["POST"],
        # The request is the preset itself ({name, state_json, state_version?}),
        # not the viewset's BoardRequest it used to inherit (#1783). Schema only:
        # the view still validates the body by hand, below.
        request=SavedFilterSerializer,
        responses={201: SavedFilterSerializer},
    )
    # pagination_class=None (#1359): GET returns the user's full preset list as
    # a bare array, never paginated. Without it drf-spectacular wraps the
    # many=True response in BoardViewSet's default paginated envelope
    # (PaginatedSavedFilterList) and publishes offset/page_size params the action
    # never honors — same bug #1142 fixed for the reorder actions. Schema-only:
    # the action never calls paginate_queryset(), so runtime output is unchanged.
    @action(detail=True, methods=["get", "post"], url_path="saved-filters", pagination_class=None)
    def saved_filters(self, request, pk=None):
        """List or create saved filter presets for the requesting user on this board.

        GET  — returns all saved filters belonging to the requesting user on this board.
        POST — creates a new saved filter; name must be unique per user per board.

        Saved filters are private to the requesting user. Any board member (including
        viewer-role) can save and restore their own filter presets; no shared presets.
        """
        board, _ = get_board_for_user(pk, request.user)

        if request.method == "GET":
            qs = SavedFilter.objects.filter(user=request.user, board=board)
            return Response(SavedFilterSerializer(qs, many=True).data)

        # POST — create a new saved filter for this user on this board.
        # A JSON body that parses to a non-mapping (a bare number/string/array/
        # null/bool — valid JSON, just not a JSON *object*) makes every
        # `request.data.get(...)` below raise AttributeError, uncaught, as an
        # unhandled 500 instead of the documented 400 (#1120 baseline finding —
        # same class as CardViewSet.move and GroupViewSet.transfer_ownership,
        # found separately by schemathesis's negative-data fuzzing on this
        # endpoint). DRF has no built-in "request body must be an object" check
        # for a bare `request.data.get()` call the way a serializer's
        # `is_valid()` would.
        if not isinstance(request.data, dict):
            return Response(
                {"detail": "Request body must be a JSON object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        name = request.data.get("name")
        if not isinstance(name, str):
            return Response({"detail": "name must be a string."}, status=status.HTTP_400_BAD_REQUEST)
        name = name.strip()
        if not name:
            return Response({"detail": "name is required."}, status=status.HTTP_400_BAD_REQUEST)
        if len(name) > 100:
            return Response(
                {"detail": "name must be 100 characters or fewer."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        state_json = request.data.get("state_json")
        if state_json is None:
            return Response({"detail": "state_json is required."}, status=status.HTTP_400_BAD_REQUEST)
        if not isinstance(state_json, dict):
            return Response(
                {"detail": "state_json must be an object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        import json as _json
        if len(_json.dumps(state_json)) > 65_536:
            return Response(
                {"detail": "state_json exceeds the maximum allowed size (64 KB)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Shape-check state_json via the serializer so malformed payloads
        # (unknown keys, wrong types) are rejected in one place — the same
        # validator will protect a future board-import flow (#698).
        try:
            SavedFilterSerializer().validate_state_json(state_json)
        except serializers.ValidationError as exc:
            detail = exc.detail
            if isinstance(detail, list) and detail:
                detail = detail[0]
            return Response({"detail": str(detail)}, status=status.HTTP_400_BAD_REQUEST)

        # state_version is optional on write (defaults to 1 for clients that
        # predate the versioning scheme). We accept unknown higher versions
        # so a mixed-version deploy where a newer client posts v2 to an older
        # server does not silently drop the user's save (#698).
        raw_version = request.data.get("state_version", 1)
        # Upper bound matches SavedFilter.state_version (PositiveSmallIntegerField);
        # without it an oversized value raises DataError at INSERT and returns 500 (#1919).
        if (
            not isinstance(raw_version, int)
            or isinstance(raw_version, bool)
            or not 1 <= raw_version <= 32767
        ):
            return Response(
                {"detail": "state_version must be an integer between 1 and 32767."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        board_id = board.id
        user_id = request.user.id
        try:
            with transaction.atomic():
                # Board row first (#1602), for the same reason as star().
                lock_board_row_or_404(board, no_key=True)
                saved = SavedFilter.objects.create(
                    user=request.user,
                    board=board,
                    name=name,
                    state_json=state_json,
                    state_version=raw_version,
                )
                filter_id = saved.id
                # Broadcast only the filter ID so other members know a new filter exists
                # without receiving the state_json contents (which are that user's personal
                # configuration and should not be pushed to all co-members on the board).
                # The creating user receives the full payload via the HTTP response below.
                _broadcast.record_board_event(
                    board_id, _broadcast.EVT_SAVED_FILTER_CREATED,
                    {"filter_id": filter_id, "user_id": user_id},
                    actor_id=user_id,
                )
        except IntegrityError:
            # unique_together violation — a filter with this name already exists.
            return Response(
                {"detail": "A saved filter with this name already exists on this board."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serialized = SavedFilterSerializer(saved).data
        return Response(serialized, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["delete"], url_path=r"saved-filters/(?P<filter_pk>[0-9]+)")
    def saved_filter_delete(self, request, pk=None, filter_pk=None):
        """Delete a single saved filter preset owned by the requesting user.

        The queryset is scoped to request.user — attempting to delete another
        user's saved filter returns 404, not 403, to avoid confirming existence.
        """
        board, _ = get_board_for_user(pk, request.user)
        try:
            saved = SavedFilter.objects.get(pk=filter_pk, user=request.user, board=board)
        except SavedFilter.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
        board_id = board.id
        filter_id = saved.id
        user_id = request.user.id
        with transaction.atomic():
            saved.delete()
            _broadcast.record_board_event(
                board_id, _broadcast.EVT_SAVED_FILTER_DELETED,
                {"filter_id": filter_id, "user_id": user_id},
                actor_id=user_id,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)

    @extend_schema(
        summary="Add a member to the board, or update an existing member's role",
        description=(
            "Creates a new BoardMembership (201) if `user_id` is not yet a board member, "
            "or updates their role/moderator flag on an existing membership (200). "
            "When `role` is omitted, a new membership gets `member` and an existing one keeps its current role. Admin only."
        ),
        request=inline_serializer(
            name="AddOrUpdateMember",
            fields={
                "user_id": serializers.IntegerField(),
                "role": serializers.ChoiceField(choices=BoardMembership.Role.choices, required=False),
                "is_moderator": serializers.BooleanField(
                    required=False, allow_null=True,
                    help_text="Grant/revoke the moderator entitlement. Only valid for member/admin roles.",
                ),
            },
        ),
        responses={
            200: BoardMembershipSerializer,
            201: BoardMembershipSerializer,
            400: OpenApiResponse(
                description="`role` is not a string within the allowed role set, or moderator entitlement was requested for a collaborator or viewer role.",
                response=inline_serializer(name="AddMemberBadRequest", fields={"detail": serializers.CharField()}),
            ),
            403: OpenApiResponse(
                description="Requester is not a board admin, or attempted to modify a site admin's membership.",
                response=inline_serializer(name="AddMemberPermissionDenied", fields={"detail": serializers.CharField()}),
            ),
        },
    )
    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        """Add or update a member's role on the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        body = require_json_object(request)
        user_id = body.get("user_id")
        if user_id is not None:
            # Missing user_id keeps its existing 404; a present but non-integer
            # one must be a 400, not a ValueError out of the pk lookup (#1669).
            user_id = coerce_int_id(user_id, "user_id")
        # An omitted role means "leave the role alone" on an existing
        # membership and "member" on a new one; resolved after the lookup below.
        role_supplied = "role" in body
        member_role = body.get("role", BoardMembership.Role.MEMBER)
        # Validate at the boundary: only stored membership roles are accepted,
        # and only as strings (an unhashable value must not reach the lookup).
        if not isinstance(member_role, str) or member_role not in BoardMembership.Role.values:
            return Response(
                {"detail": f"Role must be one of: {', '.join(BoardMembership.Role.values)}."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # An existing membership is updated whatever the user's status (member
        # lists include inactive users). A new membership needs an active user,
        # and an unknown id and an inactive id get the same 404.
        existing = (
            BoardMembership.objects.filter(board=board, user_id=user_id)
            .select_related("user")
            .first()
        )
        if existing is not None:
            target_user = existing.user
        else:
            target_user = User.objects.filter(pk=user_id, is_active=True).first()
            if target_user is None:
                raise NotFound
        # Site-admin protection keys on the caller's own site-admin status,
        # matching groups/views.py's update_member. It applies only to a
        # membership that already exists: a target with no membership here is
        # answered as any other active user would be, whatever their site
        # role (#1706).
        if (
            existing is not None
            and target_user.is_site_admin
            and not request.user.is_site_admin
        ):
            raise PermissionDenied("Cannot modify a site admin's board membership.")
        if not role_supplied and existing is not None:
            # Keep the stored role so a request that only touches the
            # moderator flag cannot change what the member can do.
            member_role = existing.role
        raw_mod = body.get("is_moderator")
        # Normalize: None means "not provided", else coerce to bool.
        # Multipart forms send "false"/"true" as strings.
        if raw_mod is None:
            is_moderator = None
        elif isinstance(raw_mod, str):
            is_moderator = raw_mod.lower() not in ("false", "0", "")
        else:
            is_moderator = bool(raw_mod)
        if is_moderator and member_role in (
            BoardMembership.Role.COLLABORATOR,
            BoardMembership.Role.VIEWER,
        ):
            return Response(
                {"detail": "Moderator entitlement can only be granted to members or admins."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # A direct row outranks a group-inherited role, so adding a site admin
        # who has none must not lower what they can already do on this board.
        # The stored role is the higher of the requested and the current
        # effective one; the response is otherwise the ordinary add (#1706).
        if (
            existing is None
            and target_user.is_site_admin
            and not request.user.is_site_admin
        ):
            current = get_board_role(target_user, board)
            order = [
                BoardMembership.Role.VIEWER,
                BoardMembership.Role.COLLABORATOR,
                BoardMembership.Role.MEMBER,
                BoardMembership.Role.ADMIN,
            ]
            if current in order and order.index(current) > order.index(member_role):
                member_role = current
        defaults = {"role": member_role}
        if is_moderator is not None:
            defaults["is_moderator"] = is_moderator
        with transaction.atomic():
            # Board row first (#1602): serializes with remove_member and a
            # board delete. Without it, a role update queued behind a board
            # delete fell back to an INSERT whose board FK failed at COMMIT.
            lock_board_row_or_404(board, no_key=True)
            membership, created = BoardMembership.objects.get_or_create(
                board=board, user=target_user, defaults=defaults
            )
            if not created:
                # `existing` was read before the board lock, so a row created
                # while this request waited is judged here, on the locked row:
                # the refusal for a site admin's membership, and the role
                # floor, must hold on this path too (#1706).
                if target_user.is_site_admin and not request.user.is_site_admin:
                    raise PermissionDenied("Cannot modify a site admin's board membership.")
                # A row created while this request waited keeps its stored role
                # when the request did not name one.
                previous_role = membership.role
                if role_supplied:
                    membership.role = member_role
                elif is_moderator and membership.role in (
                    BoardMembership.Role.COLLABORATOR,
                    BoardMembership.Role.VIEWER,
                ):
                    # Same refusal as the pre-lock check, applied to the row
                    # that appeared meanwhile. Nothing has been written yet,
                    # so returning here leaves no partial change.
                    return Response(
                        {"detail": "Moderator entitlement can only be granted to members or admins."},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if is_moderator is not None:
                    membership.is_moderator = is_moderator
                elif previous_role in (
                    BoardMembership.Role.COLLABORATOR,
                    BoardMembership.Role.VIEWER,
                ) and membership.role in (
                    BoardMembership.Role.MEMBER,
                    BoardMembership.Role.ADMIN,
                ):
                    # Promotion out of a role that cannot moderate: a flag stored
                    # on that row (Django admin or shell; ignored while the role
                    # could not use it, #1944) must not come back to life here,
                    # where the Members checkbox never showed it to an admin.
                    # An explicit is_moderator in the request still wins above.
                    membership.is_moderator = False
                # Clear moderator flag when demoting to collaborator/viewer
                if membership.role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
                    membership.is_moderator = False
                membership.save()
            # A board admin moved to a lower role stops holding a share link
            # they enabled, unless still an admin another way (#1865). On a
            # create too: a direct membership outranks a group-derived role,
            # so adding a group admin as a direct member lowers their role.
            from ..services.share_links import revoke_lapsed_share_links
            revoke_lapsed_share_links(enabler=target_user, board_ids=[board.pk])
            # Assign user directly so BoardMembershipSerializer does not issue a
            # separate query to load the FK — target_user is already in scope.
            membership.user = target_user
            # Thread the resolved role and board into the serializer context
            # so to_representation does not re-issue ``get_board_role`` to
            # decide whether to strip ``is_moderator`` (#992) — the action
            # already resolved the role at the top of the function.
            membership_data = BoardMembershipSerializer(
                membership,
                context={"role": role, "board": board, "request": request},
            ).data
            # A caller who is not a site admin gets no site-admin flag in the
            # response or the stored event payload, so a site-admin target and
            # an ordinary one produce the same shape (#1706). The flag is read
            # from the user, so it is dropped here rather than by role alone.
            if not request.user.is_site_admin:
                membership_data = {
                    k: v for k, v in membership_data.items() if k != "is_site_admin"
                }
            board_id = board.id
            ws_event = _broadcast.EVT_MEMBER_ADDED if created else _broadcast.EVT_MEMBER_UPDATED
            # The stored payload still carries is_moderator; the feed strips it per
            # reader role on read, exactly as the consumer does per subscriber (#978).
            _broadcast.record_board_event(board_id, ws_event, membership_data, actor_id=request.user.id)
            # Notify the invited user when they are newly added (not on role updates).
            # Skipped if they added themselves or have opted out of board invite notifications.
            if created and target_user != request.user and target_user.notif_board_invite:
                # Routed through create_notifications like every other event, so
                # the post_notification_created extension point has no
                # board-invite hole. OSS ships no email for this action_type;
                # an enterprise delivery backend may still want it.
                create_notifications([
                    Notification(
                        recipient=target_user,
                        actor=request.user,
                        action_type=Notification.ActionType.BOARD_INVITE,
                        verb=f"{request.user.username} added you to \"{board.name}\"",
                        board=board,
                    )
                ], context={"role": membership.role})
        # 201 for a new membership, 200 for a role update on an existing one.
        return Response(membership_data, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    @action(detail=True, methods=["delete"], url_path=r"members/(?P<user_id>[0-9]+)")
    def remove_member(self, request, pk=None, user_id=None):
        """Remove a member from the board (admin only)."""
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        # Beyond the 64-bit range no row can exist: same 404, not a DB overflow.
        if int(user_id) > 2**63 - 1:
            raise NotFound
        # Resolve through the membership row: an unknown id, an inactive user
        # and an active user with no membership all get the same 404. An
        # inactive user who has a membership can still be removed.
        membership = (
            BoardMembership.objects.filter(board=board, user_id=user_id)
            .select_related("user")
            .first()
        )
        if membership is None:
            raise NotFound
        # See the same check in `members()` above for why this uses
        # request.user.is_site_admin rather than the resolved `role`, and why
        # it follows the membership lookup (#1706).
        if membership.user.is_site_admin and not request.user.is_site_admin:
            raise PermissionDenied("Cannot remove a site admin from a board.")
        target_user = membership.user
        board_id = board.id
        removed_user_id = target_user.id
        with transaction.atomic():
            # Board row first (#1602): queues with a concurrent role update
            # (members) and a board delete, and answers 404 once the board is
            # gone instead of persisting an event row for it.
            lock_board_row_or_404(board, no_key=True)
            BoardMembership.objects.filter(board=board, user=target_user).delete()
            _broadcast.record_board_event(board_id, _broadcast.EVT_MEMBER_REMOVED, {"user_id": removed_user_id}, actor_id=request.user.id)
            # A removed admin stops holding a share link they enabled, unless
            # still an admin another way (#1865).
            from ..services.share_links import revoke_lapsed_share_links
            revoke_lapsed_share_links(enabler=target_user, board_ids=[board_id])
        return Response(status=status.HTTP_204_NO_CONTENT)
