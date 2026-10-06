"""Board invites (#1444): emailed single-use invites and the public join flow.

Admin endpoints are mixed into ``BoardViewSet``:

- ``GET    /boards/<id>/invite-links/``            — list (board admin)
- ``POST   /boards/<id>/invite-links/send/``       — email one invite (board admin)
- ``DELETE /boards/<id>/invite-links/<link_id>/``  — revoke (board admin)

``JoinBoardView`` serves ``/boards/join/<token>/``: a public preview (GET) and
the authenticated redemption (POST). Redemption rules live in
``boards/invites.py``.
"""

import datetime
import logging

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers as drf_serializers, status
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from accounts.permissions import TokenHasScope
from groups.views import JoinGroupRateThrottle
from visiban.invite_email import InviteEmailBadRequestSerializer, InviteEmailErrorSerializer
from visiban.permissions import MustNotHavePendingPasswordChange, MustNotHavePendingUsernameChange
from visiban.utils import get_client_ip

from .. import broadcast as _broadcast
from .. import invites as _invites
from ..models import Board, BoardInviteLink, BoardInviteRedemption, BoardMembership
from ..permissions import SITE_ADMIN, get_board_role
from ..serializers import BoardInviteLinkEmailSerializer, BoardInviteLinkSerializer
from ._helpers import get_board_for_user

logger = logging.getLogger(__name__)

# Pending emailed invites per board — the same ceiling as a group's (#731).
BOARD_MAX_PENDING_EMAILED_INVITES = 50

# Used/expired/revoked invites returned by the list, most recent first.
BOARD_INVITE_LIST_MAX_PAST = 50

_GONE_DETAILS = {
    "revoked": "This invite is no longer valid.",
    "used": "This invite has already been used.",
    "expired": "This invite has expired.",
}

_GoneSerializer = inline_serializer(
    name="BoardInviteGone",
    fields={"code": drf_serializers.CharField(), "detail": drf_serializers.CharField()},
)


def _require_board_admin(pk, user):
    board, role = get_board_for_user(pk, user, slim=True)
    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        raise PermissionDenied("You must be a board admin to manage invites.")
    return board


class BoardInviteLinksMixin:
    """Invite endpoints for ``BoardViewSet`` (#1444)."""

    @extend_schema(
        summary="List a board's invites",
        responses=BoardInviteLinkSerializer(many=True),
    )
    # pagination_class=None: a bare array, like the group invite list (#1359).
    @action(detail=True, methods=["get"], url_path="invite-links", pagination_class=None)
    def invite_links(self, request, pk=None):
        board = _require_board_admin(pk, request.user)
        now = timezone.now()
        base = BoardInviteLink.objects.filter(board=board).select_related("created_by")
        pending_q = Q(revoked_at__isnull=True, used_at__isnull=True) & (
            Q(expires_at__isnull=True) | Q(expires_at__gt=now)
        )
        # Every pending invite (bounded by the send cap) plus only the most
        # recent past ones: the history otherwise grows without bound.
        pending = list(base.filter(pending_q).order_by("-created_at", "-pk"))
        past = list(base.exclude(pending_q).order_by("-created_at", "-pk")[:BOARD_INVITE_LIST_MAX_PAST])
        links = sorted(pending + past, key=lambda link: (link.created_at, link.pk), reverse=True)
        context = {"board": board, "sender_admits_memo": {}}
        return Response(BoardInviteLinkSerializer(links, many=True, context=context).data)

    @extend_schema(
        summary="Email a single-use board invite to one address",
        request=BoardInviteLinkEmailSerializer,
        responses={
            202: inline_serializer(
                name="BoardInviteEmailSent",
                fields={
                    "detail": drf_serializers.CharField(),
                    "sent_to": drf_serializers.CharField(),
                    "delivery": drf_serializers.CharField(required=False),
                },
            ),
            400: InviteEmailBadRequestSerializer,
            403: InviteEmailErrorSerializer,
            502: InviteEmailErrorSerializer,
        },
    )
    @action(detail=True, methods=["post"], url_path="invite-links/send")
    def invite_link_send(self, request, pk=None):
        """Mint a single-use invite and email it to one address.

        Same order as the group send (#731): feature gate, permission,
        validation, cap under a board row lock, throttles last (so a refused
        request spends no budget), mint, send after commit, and on a failed
        send revoke the invite and refund the throttles. The response is
        identical whatever the address — member, existing user, or nobody — so
        the endpoint cannot be used to probe which addresses have accounts.
        The raw token travels only in the email.
        """
        from visiban import invite_email

        if not invite_email.invite_email_enabled():
            return Response(
                {
                    "code": invite_email.CODE_INVITE_EMAIL_DISABLED,
                    "detail": "Sending invites by email is disabled on this instance.",
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        board = _require_board_admin(pk, request.user)

        serializer = BoardInviteLinkEmailSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
        validated = serializer.validated_data

        with transaction.atomic():
            # Lock the board row so two concurrent sends cannot both read 49.
            Board.objects.select_for_update().filter(pk=board.pk).first()
            pending = BoardInviteLink.objects.filter(
                board=board,
                delivery=BoardInviteLink.Delivery.EMAIL,
                revoked_at__isnull=True,
                used_at__isnull=True,
                expires_at__gt=timezone.now(),
            ).count()
            if pending >= BOARD_MAX_PENDING_EMAILED_INVITES:
                return Response(
                    {
                        "code": "invite_email_cap_reached",
                        "detail": (
                            f"Maximum of {BOARD_MAX_PENDING_EMAILED_INVITES} pending emailed "
                            "invites per board. Revoke some or wait for them to expire."
                        ),
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            recorded_throttles = invite_email.check_send_throttles(request, self, board_id=board.pk)
            link, raw_token = BoardInviteLink.generate(
                board=board,
                created_by=request.user,
                role=validated["role"],
                expires_at=timezone.now() + datetime.timedelta(days=int(validated["expiry_days"])),
                single_use=True,
                delivery=BoardInviteLink.Delivery.EMAIL,
            )
            # Minimal {id}: non-admin subscribers receive it too, so
            # clients refetch the admin-only list.
            _broadcast.record_board_event(
                board.pk, _broadcast.EVT_INVITE_LINK_CREATED, {"id": link.pk}, actor_id=request.user.pk,
            )

        # After the commit: an SMTP session must never run under the row lock.
        message = invite_email.build_board_invite_message(
            board_name=board.name,
            inviter_name=request.user.username,
            raw_token=raw_token,
            expires_at=link.expires_at,
            to=validated["email"],
        )
        error_code = invite_email.send_invite_message(
            message, link_pk=link.pk, prefix=link.prefix, actor_id=request.user.pk, kind="board",
        )
        if error_code is not None:
            invite_email.refund_send_throttles(recorded_throttles)
            # An invite whose email never left would sit in the list as a live
            # credential nobody holds — revoke it so the admin can retry.
            with transaction.atomic():
                BoardInviteLink.objects.filter(pk=link.pk).update(
                    revoked_at=timezone.now(), revoked_by=request.user,
                )
                # Minimal {id}: non-admin subscribers receive it too, so
                # clients refetch the admin-only list.
                _broadcast.record_board_event(
                    board.pk, _broadcast.EVT_INVITE_LINK_REVOKED, {"id": link.pk}, actor_id=request.user.pk,
                )
            return Response(
                {
                    "code": error_code,
                    "detail": "The invite email could not be sent. The invite was revoked.",
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )

        body = {"detail": "Invite sent", "sent_to": validated["email"]}
        if invite_email.delivers_to_console():
            body["delivery"] = "console"
        return Response(body, status=status.HTTP_202_ACCEPTED)

    @extend_schema(
        summary="Revoke a board invite",
        responses={204: None, 400: inline_serializer(
            name="BoardInviteRevokeRefused", fields={"detail": drf_serializers.CharField()},
        )},
    )
    # Digits-only link_id, so this pattern can never match invite-links/send/.
    @action(detail=True, methods=["delete"], url_path=r"invite-links/(?P<link_id>\d+)")
    def revoke_invite_link(self, request, pk=None, link_id=None):
        """Revoke a pending invite. Any board admin may revoke any admin's invite."""
        board = _require_board_admin(pk, request.user)
        with transaction.atomic():
            link = get_object_or_404(
                BoardInviteLink.objects.select_for_update(),
                pk=link_id, board=board, revoked_at__isnull=True,
            )
            # Revoking a consumed invite would flip its status from "used" to
            # "revoked" and lose the record that it was redeemed.
            if link.used_at is not None:
                return Response(
                    {"detail": "This invite has already been used and cannot be revoked."},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            link.revoked_at = timezone.now()
            link.revoked_by = request.user
            link.save(update_fields=["revoked_at", "revoked_by"])
            # Minimal {id}: non-admin subscribers receive it too, so
            # clients refetch the admin-only list.
            _broadcast.record_board_event(
                board.pk, _broadcast.EVT_INVITE_LINK_REVOKED, {"id": link.pk}, actor_id=request.user.pk,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


def _gone(code):
    return Response({"code": code, "detail": _GONE_DETAILS[code]}, status=status.HTTP_410_GONE)


def _not_found():
    return Response({"detail": "Not found."}, status=status.HTTP_404_NOT_FOUND)


class JoinBoardView(APIView):
    """Board invite join flow (#1444).

    GET  /boards/join/<token>/ — public; what the invite grants.
    POST /boards/join/<token>/ — authenticated; redeem it.

    Shares the ``join_group`` per-IP throttle bucket with the group join view:
    board and group join attempts from one address draw from one budget, so an
    attacker cannot double their token-scanning rate by alternating kinds.
    """

    throttle_classes = [JoinGroupRateThrottle]

    def get_permissions(self):
        if self.request.method == "GET":
            return [AllowAny()]
        return [
            IsAuthenticated(),
            MustNotHavePendingPasswordChange(),
            MustNotHavePendingUsernameChange(),
            TokenHasScope(),
        ]

    @extend_schema(
        summary="Preview a board invite",
        responses={
            200: inline_serializer(
                name="BoardJoinPreview",
                fields={
                    "board_id": drf_serializers.IntegerField(),
                    "board_name": drf_serializers.CharField(),
                    "role": drf_serializers.CharField(),
                    "can_register": drf_serializers.BooleanField(),
                },
            ),
            404: inline_serializer(name="BoardJoinNotFound", fields={"detail": drf_serializers.CharField()}),
            410: _GoneSerializer,
        },
    )
    def get(self, request, token):
        # Intentionally public: the token is a capability (160 bits from
        # secrets.token_hex(20), rate-limited per IP, invalidated by revocation,
        # use or expiry). Disclosing the board name and role to its holder is
        # by design so an invitee can see what they are joining before signing
        # in — the same #801 capability model as the group join preview.
        link = BoardInviteLink.lookup_by_token(str(token))
        if link is None:
            return _not_found()
        board = _invites.load_board(link.board_id)
        has_access = request.user.is_authenticated and get_board_role(request.user, board) is not None
        code = _invites.unusable_code(link, caller_has_access=has_access)
        if code is None and not _invites.sender_is_board_admin(link, board):
            # The sender can no longer add people (deactivated, or no longer an
            # admin of this board): to the holder the invite is simply dead.
            code = "revoked"
        if code is not None:
            logger.info(
                "Board invite preview refused. token=%s code=%s ip=%s",
                link.prefix, code, get_client_ip(request),
            )
            return _gone(code)
        # can_register: advisory bit only, never the reason — see
        # groups.views.JoinGroupView.get for the disclosure reasoning (#1481).
        return Response({
            "board_id": board.pk,
            "board_name": board.name,
            "role": link.role,
            "can_register": _invites.board_link_can_register(link),
        })

    @extend_schema(
        summary="Join a board with an invite",
        request=None,
        responses={
            200: inline_serializer(
                name="BoardJoinResult",
                fields={
                    "board_id": drf_serializers.IntegerField(),
                    "board_name": drf_serializers.CharField(),
                    "role": drf_serializers.CharField(),
                    "created": drf_serializers.BooleanField(),
                },
            ),
            201: inline_serializer(
                name="BoardJoinCreated",
                fields={
                    "board_id": drf_serializers.IntegerField(),
                    "board_name": drf_serializers.CharField(),
                    "role": drf_serializers.CharField(),
                    "created": drf_serializers.BooleanField(),
                },
            ),
            404: inline_serializer(name="BoardJoinPostNotFound", fields={"detail": drf_serializers.CharField()}),
            410: _GoneSerializer,
        },
    )
    def post(self, request, token):
        user = request.user
        ip = get_client_ip(request)
        with transaction.atomic():
            try:
                link = BoardInviteLink.objects.select_for_update().get(
                    token_hash=BoardInviteLink._hash_token(str(token)),
                )
            except BoardInviteLink.DoesNotExist:
                return _not_found()
            # The lock is taken on the bare row (select_for_update cannot lock
            # the nullable side of an outer join); relations load afterwards.
            board = _invites.load_board(link.board_id)
            has_access = get_board_role(user, board) is not None
            code = _invites.unusable_code(link, caller_has_access=has_access)
            if code is None and not _invites.sender_is_board_admin(link, board):
                code = "revoked"
            if code is not None:
                logger.info(
                    "Board invite redemption refused. token=%s code=%s user_id=%s ip=%s",
                    link.prefix, code, user.pk, ip,
                )
                return _gone(code)

            if link.single_use and link.used_at is not None:
                # Already consumed, and the caller already has access (else
                # unusable_code would have refused): typically the account
                # whose registration redeemed it, following up from the SPA.
                # Grant nothing; report whether this invite created their
                # membership so the SPA shows "joined" rather than "already
                # had access" after sign-up.
                prior = BoardInviteRedemption.objects.filter(invite=link, user=user).first()
                created = bool(prior and prior.membership_created)
                http_status = status.HTTP_200_OK
            else:
                created = _invites.redeem(link, user, board, via=BoardInviteRedemption.Via.JOIN)
                http_status = status.HTTP_201_CREATED if created else status.HTTP_200_OK

        logger.info(
            "Board invite redeemed. token=%s board_id=%s user_id=%s created=%s ip=%s",
            link.prefix, board.pk, user.pk, created, ip,
        )
        return Response(
            {"board_id": board.pk, "board_name": board.name, "role": link.role, "created": created},
            status=http_status,
        )
