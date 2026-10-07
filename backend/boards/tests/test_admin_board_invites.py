"""Site-admin board invite list and revoke (#439).

- GET    /api/v1/admin/board-invite-links/?status=&offset=&page_size=
- DELETE /api/v1/admin/board-invite-links/{id}/
"""
from datetime import timedelta
from unittest import mock

from django.core.cache import cache
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import SiteSetting, User
from boards import broadcast as board_broadcast
from boards.models import Board, BoardInviteLink, BoardMembership

LIST_URL = "/api/v1/admin/board-invite-links/"


def detail_url(link):
    return f"{LIST_URL}{link.pk}/"


def set_mode(mode):
    s = SiteSetting.get()
    s.registration_mode = mode
    s.save()


class _Fixture:
    def setUp(self):
        cache.clear()
        set_mode(SiteSetting.RegistrationMode.OPEN)
        self.site_admin = User.objects.create_user(username="siteadmin", password="p", is_site_admin=True)
        self.board_admin = User.objects.create_user(username="badmin", password="p")
        self.board = Board.objects.create(name="Launch Plan", owner=self.board_admin)
        self.other_board = Board.objects.create(name="Roadmap", owner=self.board_admin)
        self.client = APIClient()
        self.client.force_authenticate(self.site_admin)

    def tearDown(self):
        set_mode(SiteSetting.RegistrationMode.OPEN)
        cache.clear()

    def make(self, board=None, *, delivery="link", single_use=False, created_by=None, days=7, **state):
        link, _raw = BoardInviteLink.generate(
            board=board or self.board, created_by=created_by or self.board_admin,
            expires_at=timezone.now() + timedelta(days=days), single_use=single_use, delivery=delivery,
        )
        if state:
            BoardInviteLink.objects.filter(pk=link.pk).update(**state)
            link.refresh_from_db()
        return link


class AdminBoardInvitePermissionTests(_Fixture, TestCase):

    def test_board_admin_who_is_not_site_admin_is_403(self):
        link = self.make()
        client = APIClient()
        client.force_authenticate(self.board_admin)
        self.assertEqual(client.get(LIST_URL).status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(client.delete(detail_url(link)).status_code, status.HTTP_403_FORBIDDEN)
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)

    def test_anonymous_is_401(self):
        link = self.make()
        self.assertEqual(APIClient().get(LIST_URL).status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(APIClient().delete(detail_url(link)).status_code, status.HTTP_401_UNAUTHORIZED)

    def test_all_content_access_without_site_admin_is_403(self):
        link = self.make()
        viewer = User.objects.create_user(username="allcontent", password="p", can_access_all_content=True)
        client = APIClient()
        client.force_authenticate(viewer)
        self.assertEqual(client.get(LIST_URL).status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(client.delete(detail_url(link)).status_code, status.HTTP_403_FORBIDDEN)
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)

    def test_board_member_and_viewer_are_403(self):
        link = self.make()
        for role in ("member", "viewer"):
            with self.subTest(role=role):
                user = User.objects.create_user(username=f"plain_{role}", password="p")
                BoardMembership.objects.create(board=self.board, user=user, role=role)
                client = APIClient()
                client.force_authenticate(user)
                self.assertEqual(client.get(LIST_URL).status_code, status.HTTP_403_FORBIDDEN)
                self.assertEqual(client.delete(detail_url(link)).status_code, status.HTTP_403_FORBIDDEN)
        link.refresh_from_db()
        self.assertIsNone(link.revoked_at)

    def test_non_site_admin_delete_of_unknown_id_is_403_not_404(self):
        # Permission is checked before the lookup, so a non-admin cannot probe ids.
        client = APIClient()
        client.force_authenticate(self.board_admin)
        self.assertEqual(client.delete(f"{LIST_URL}999999/").status_code, status.HTTP_403_FORBIDDEN)


class AdminBoardInviteListTests(_Fixture, TestCase):

    def _rows(self, query=""):
        r = self.client.get(LIST_URL + query)
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        return r.json()

    def test_row_shape_across_boards_both_deliveries(self):
        link = self.make()
        emailed = self.make(self.other_board, delivery="email", single_use=True)
        body = self._rows()
        self.assertEqual(set(body), {"count", "offset", "page_size", "results"})
        self.assertEqual(body["count"], 2)
        rows = {row["id"]: row for row in body["results"]}
        self.assertEqual(set(rows[link.pk]), {
            "id", "board_id", "board_name", "role", "delivery", "status", "prefix", "expires_at",
            "created_at", "created_by_username", "single_use", "use_count", "can_register",
        })
        self.assertEqual(
            (rows[link.pk]["board_id"], rows[link.pk]["board_name"], rows[link.pk]["delivery"]),
            (self.board.pk, "Launch Plan", "link"),
        )
        self.assertEqual((rows[emailed.pk]["board_name"], rows[emailed.pk]["delivery"]), ("Roadmap", "email"))
        self.assertEqual(rows[link.pk]["created_by_username"], "badmin")
        self.assertEqual(rows[link.pk]["prefix"], link.prefix)
        self.assertNotIn("token", rows[link.pk])
        self.assertNotIn("token_hash", rows[link.pk])

    def test_status_filters_follow_model_precedence(self):
        now = timezone.now()
        pending = self.make()
        never_expiring = self.make(expires_at=None)
        used = self.make(single_use=True, used_at=now)
        expired = self.make(expires_at=now - timedelta(minutes=1))
        revoked = self.make(revoked_at=now)
        # Precedence: revoked beats used beats expired.
        revoked_and_used = self.make(single_use=True, used_at=now, revoked_at=now)
        used_and_expired = self.make(single_use=True, used_at=now, expires_at=now - timedelta(days=1))
        expected = {
            "pending": {pending.pk, never_expiring.pk},
            "used": {used.pk, used_and_expired.pk},
            "expired": {expired.pk},
            "revoked": {revoked.pk, revoked_and_used.pk},
        }
        for value, ids in expected.items():
            with self.subTest(status=value):
                body = self._rows(f"?status={value}")
                self.assertEqual({row["id"] for row in body["results"]}, ids)
                self.assertEqual(body["count"], len(ids))
                self.assertTrue(all(row["status"] == value for row in body["results"]))
        self.assertEqual(self._rows("?status=all")["count"], 7)

    def test_default_is_pending(self):
        self.make()
        self.make(revoked_at=timezone.now())
        body = self._rows()
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["results"][0]["status"], "pending")

    def test_invalid_status_is_400(self):
        r = self.client.get(LIST_URL + "?status=bogus")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("status", r.json())

    def test_pagination_count_and_order(self):
        base = timezone.now() - timedelta(days=1)
        links = []
        for i in range(7):
            link = self.make()
            BoardInviteLink.objects.filter(pk=link.pk).update(created_at=base + timedelta(minutes=i))
            links.append(link.pk)
        first = self._rows("?page_size=3")
        self.assertEqual((first["count"], first["offset"], first["page_size"]), (7, 0, 3))
        second = self._rows("?page_size=3&offset=3")
        third = self._rows("?page_size=3&offset=6")
        ids = [r["id"] for page in (first, second, third) for r in page["results"]]
        self.assertEqual(ids, list(reversed(links)))  # newest first, no gaps or repeats

    def test_created_by_null_when_sender_deleted(self):
        self.make(created_by=None)
        BoardInviteLink.objects.update(created_by=None)
        row = self._rows()["results"][0]
        self.assertIsNone(row["created_by_username"])
        self.assertIs(row["can_register"], False)

    def test_can_register_by_mode_and_delivery(self):
        self.board_admin.is_site_admin = True
        self.board_admin.save(update_fields=["is_site_admin"])
        link = self.make()
        emailed = self.make(delivery="email", single_use=True)

        def can(pk):
            return {r["id"]: r["can_register"] for r in self._rows()["results"]}[pk]

        self.assertIs(can(link.pk), True)
        self.assertIs(can(emailed.pk), True)
        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.assertIs(can(link.pk), False)  # shareable links never admit new accounts
        with self.settings(INVITE_EMAIL_ENABLED=True, DEMO_MODE=False):
            self.assertIs(can(emailed.pk), True)
        with self.settings(INVITE_EMAIL_ENABLED=False):
            self.assertIs(can(emailed.pk), False)
        set_mode(SiteSetting.RegistrationMode.CLOSED)
        self.assertIs(can(link.pk), False)
        self.assertIs(can(emailed.pk), False)

    def test_non_pending_rows_never_claim_can_register(self):
        self.make(revoked_at=timezone.now())
        self.assertIs(self._rows("?status=revoked")["results"][0]["can_register"], False)

    def test_query_count_does_not_grow_with_rows_or_boards(self):
        def count():
            cache.clear()  # the registration mode is cached; read it cold both times
            with CaptureQueriesContext(connection) as ctx:
                body = self._rows("?status=all")
            return len(ctx.captured_queries), body

        set_mode(SiteSetting.RegistrationMode.INVITE_ONLY)
        self.make()
        one, _ = count()
        for i in range(12):
            other_sender = User.objects.create_user(username=f"s{i}", password="p", is_site_admin=True)
            board = Board.objects.create(name=f"B{i}", owner=other_sender)
            self.make(board, created_by=other_sender, delivery="email", single_use=True)
        many, body = count()
        self.assertEqual(body["count"], 13)
        self.assertEqual(one, many)


class AdminBoardInviteRevokeTests(_Fixture, TestCase):

    def test_revoke_any_board_invite_returns_row_and_broadcasts(self):
        link = self.make(self.other_board)
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                r = self.client.delete(detail_url(link))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.content)
        body = r.json()
        self.assertEqual((body["id"], body["status"], body["board_name"]), (link.pk, "revoked", "Roadmap"))
        self.assertIs(body["can_register"], False)
        link.refresh_from_db()
        self.assertIsNotNone(link.revoked_at)
        self.assertEqual(link.revoked_by, self.site_admin)
        bcast.assert_called_once()
        self.assertEqual(
            bcast.call_args.args[:3], (self.other_board.pk, board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link.pk}),
        )
        # The site admin is not a member of that board: nothing granted them access.
        self.assertFalse(BoardMembership.objects.filter(user=self.site_admin).exists())

    def test_revoke_expired_invite_is_allowed(self):
        link = self.make(expires_at=timezone.now() - timedelta(days=1))
        self.assertEqual(self.client.delete(detail_url(link)).status_code, status.HTTP_200_OK)

    def test_revoke_used_or_already_revoked_is_400(self):
        used = self.make(single_use=True, used_at=timezone.now())
        revoked = self.make(revoked_at=timezone.now())
        with mock.patch("boards.broadcast.broadcast_board_event") as bcast:
            with self.captureOnCommitCallbacks(execute=True):
                for link in (used, revoked):
                    with self.subTest(link=link.pk):
                        r = self.client.delete(detail_url(link))
                        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                        self.assertIn("detail", r.json())
        bcast.assert_not_called()
        used.refresh_from_db()
        self.assertEqual(used.status, "used")
        self.assertIsNone(used.revoked_at)

    def test_revoke_query_count_is_bounded(self):
        link = self.make(self.other_board)
        cache.clear()
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.delete(detail_url(link))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        # 7 today: lock, update, event row, savepoint pair, reload, registration
        # mode. A per-board role walk or an N+1 would break the bound.
        self.assertLessEqual(len(ctx.captured_queries), 8, [q["sql"] for q in ctx.captured_queries])

    def test_unknown_invite_is_404(self):
        self.assertEqual(self.client.delete(f"{LIST_URL}999999/").status_code, status.HTTP_404_NOT_FOUND)

    def test_revoked_link_stops_working(self):
        link, raw = BoardInviteLink.generate(
            board=self.board, created_by=self.board_admin, expires_at=timezone.now() + timedelta(days=1),
        )
        self.client.delete(detail_url(link))
        joiner = User.objects.create_user(username="joiner", password="p")
        client = APIClient()
        client.force_authenticate(joiner)
        r = client.post(f"/api/v1/boards/join/{raw}/")
        self.assertEqual(r.status_code, status.HTTP_410_GONE)
        self.assertEqual(r.json()["code"], "revoked")
