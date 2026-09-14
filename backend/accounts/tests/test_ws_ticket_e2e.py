"""End-to-end WebSocket ticket handshakes through the real ASGI stack (#1109).

Every other test in this change exercises one layer in isolation. These drive
``visiban.asgi.application`` itself — CookieMiddleware, SessionMiddleware,
AuthMiddleware, TicketAuthMiddleware, URLRouter and the consumer — so they prove
the acceptance criteria end to end and would catch a middleware wiring
regression that a unit test cannot see.

TransactionTestCase, not TestCase: the consumer and the ticket middleware both
reach the ORM from a worker thread via ``database_sync_to_async``, which cannot
see a TestCase's uncommitted transaction. ``channels.db`` closes those
thread-local connections itself (``close_old_connections`` in a ``finally``), so
no explicit ``connections.close_all()`` is required here — cf. CLAUDE.md
§ Backend test conventions.
"""
import asyncio

from channels.testing import WebsocketCommunicator
from django.core.cache import cache
from django.test import TransactionTestCase

from accounts.models import User
from accounts.ws_auth import issue_ws_ticket
from boards.models import Board, BoardMembership
from groups.models import Group, GroupMembership


def _make_board(owner, name="E2E Board"):
    board = Board.objects.create(name=name, owner=owner)
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN
    )
    return board


def _make_group(owner, name="E2E Group"):
    group = Group.objects.create(name=name, owner=owner)
    GroupMembership.objects.create(
        group=group, user=owner, role=GroupMembership.Role.ADMIN
    )
    return group


def _connect(path):
    """Open *path* against the real ASGI app; return (accepted, close_code)."""
    from visiban import asgi

    async def run():
        communicator = WebsocketCommunicator(asgi.application, path)
        connected, detail = await communicator.connect()
        if connected:
            await communicator.disconnect()
            return True, None
        return False, detail

    return asyncio.run(run())


class WSTicketBoardChannelTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="e2e_member", password="pass")
        self.board = _make_board(self.user)

    def test_valid_ticket_connects_to_the_board_channel(self):
        """AC: a token-authenticated client reaches ws/boards/<id>/."""
        ticket, _ = issue_ws_ticket(self.user)
        accepted, _ = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertTrue(accepted)

    def test_no_credential_at_all_is_closed_with_4001(self):
        accepted, code = _connect(f"/ws/boards/{self.board.id}/")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_reused_ticket_is_closed_with_4001(self):
        ticket, _ = issue_ws_ticket(self.user)
        first, _ = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertTrue(first)

        accepted, code = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_expired_ticket_is_closed_with_4001(self):
        from accounts.ws_auth import _ticket_cache_key

        ticket, _ = issue_ws_ticket(self.user)
        cache.delete(_ticket_cache_key(ticket))  # Simulate the TTL elapsing.
        accepted, code = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_tampered_ticket_is_closed_with_4001(self):
        ticket, _ = issue_ws_ticket(self.user)
        accepted, code = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}x")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_valid_ticket_for_a_non_member_is_closed_with_4003(self):
        """AC: the ticket authenticates; it does not authorize."""
        outsider = User.objects.create_user(username="e2e_outsider", password="pass")
        ticket, _ = issue_ws_ticket(outsider)
        accepted, code = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4003)

    def test_ticket_for_a_deactivated_user_is_closed_with_4001(self):
        """An account disabled between issuance and connect must not get in.

        Proven at the middleware level too, but this is a realistic operational
        sequence and the point of this file is that the real stack agrees.
        """
        ticket, _ = issue_ws_ticket(self.user)
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        accepted, code = _connect(f"/ws/boards/{self.board.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_ticket_does_not_grant_access_to_an_unrelated_board(self):
        other_owner = User.objects.create_user(username="e2e_other", password="pass")
        other_board = _make_board(other_owner, name="Someone else's board")
        ticket, _ = issue_ws_ticket(self.user)
        accepted, code = _connect(f"/ws/boards/{other_board.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4003)


class WSTicketGroupChannelTests(TransactionTestCase):
    def setUp(self):
        cache.clear()
        self.user = User.objects.create_user(username="e2e_gmember", password="pass")
        self.group = _make_group(self.user)

    def test_valid_ticket_connects_to_the_group_channel(self):
        """AC: one ticket serves the group channel too, not just boards."""
        ticket, _ = issue_ws_ticket(self.user)
        accepted, _ = _connect(f"/ws/groups/{self.group.id}/?ticket={ticket}")
        self.assertTrue(accepted)

    def test_no_credential_at_all_is_closed_with_4001(self):
        accepted, code = _connect(f"/ws/groups/{self.group.id}/")
        self.assertFalse(accepted)
        self.assertEqual(code, 4001)

    def test_valid_ticket_for_a_non_member_is_closed_with_4003(self):
        outsider = User.objects.create_user(username="e2e_goutsider", password="pass")
        ticket, _ = issue_ws_ticket(outsider)
        accepted, code = _connect(f"/ws/groups/{self.group.id}/?ticket={ticket}")
        self.assertFalse(accepted)
        self.assertEqual(code, 4003)
