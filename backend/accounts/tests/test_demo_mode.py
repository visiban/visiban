"""Tests for the hosted-demo write fence (#1179).

The fence is the demo's whole safety guarantee — the published account's role
is not — so these tests are organized around what could silently reopen a
write path:

* the pinned allowlist (fails when it grows or shrinks),
* a route-table sweep over EVERY resolvable route, ``/accounts/`` and
  ``/admin/`` included, so an endpoint added next release is covered with no
  test change (forked from ``test_pat_scopes._iter_api_routes``, which walks
  ``api/`` only and would have missed allauth entirely),
* the negative cases a path/method fence classically gets wrong,
* the positive path: a visitor can still move a card and see it in History.
"""
from __future__ import annotations

import datetime
import re

import pytest
from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase, override_settings
from django.urls import Resolver404, get_resolver, resolve
from rest_framework.test import APIClient

from accounts.models import PersonalAccessToken, User
from boards.models import Board, BoardMembership, Card, CardMovement, Column, Swimlane
from groups.models import Group, GroupMembership
from visiban.demo import (
    DEMO_ALLOWED_WRITES,
    DEMO_READ_ONLY_CODE,
    DEMO_SAFE_METHODS,
    next_reset_at,
    parse_demo_mode,
    parse_demo_reset_schedule,
)

PASSWORD = "demo-visitor-pw-1"
UNSAFE_METHODS = ("POST", "PUT", "PATCH", "DELETE")


# ---------------------------------------------------------------------------
# Route enumeration — forked from accounts/tests/test_pat_scopes.py
# ---------------------------------------------------------------------------

_NAMED_GROUP = re.compile(r"\(\?P<\w+>[^)]*\)")
_CONVERTER = re.compile(r"<(?:\w+:)?\w+>")


def _concretize(route: str) -> str:
    """Turn a URL pattern string into a concrete path that resolves to it.

    Every parameter becomes ``1``: the fence decides before any lookup, so
    the id never has to exist.
    """
    p = route.replace("^", "").replace("?$", "").replace("$", "")
    # The two catch-alls in visiban/urls.py are regexes with no named group.
    p = p.replace(r"[\s\S]*", "zzz-unmatched/").replace(r"v(?!1/)[\w]+/", "v2/")
    p = _NAMED_GROUP.sub("1", p)
    p = _CONVERTER.sub("1", p)
    return "/" + p.replace("\\.", ".").replace("\\", "")


def _iter_all_routes():
    """Yield ``(concrete_path, view_name)`` for EVERY route in the URLconf.

    Unlike ``_iter_api_routes`` this does not filter to ``api/``: the demo
    fence's jurisdiction is everything, and allauth's ``/accounts/`` tree
    (signup, email, password change, 3rd-party connect) is exactly what an
    ``api/``-only sweep would miss. DRF's ``.<format>`` suffix twins resolve
    to the same view as their un-suffixed route and are skipped.
    """
    def walk(patterns, prefix=""):
        for pattern in patterns:
            if hasattr(pattern, "url_patterns"):
                yield from walk(pattern.url_patterns, prefix + str(pattern.pattern))
            else:
                yield prefix + str(pattern.pattern)

    seen = set()
    for route in walk(get_resolver().url_patterns):
        if "format" in route:
            continue
        path = _concretize(route)
        if path in seen:
            continue
        seen.add(path)
        yield path, resolve(path).view_name


_ALL_ROUTES = list(_iter_all_routes())

_REFUSED_CASES = [
    (method, path)
    for path, view_name in _ALL_ROUTES
    for method in UNSAFE_METHODS
    if (method, view_name) not in DEMO_ALLOWED_WRITES
]
_ALLOWED_CASES = [
    (method, path)
    for path, view_name in _ALL_ROUTES
    for method in UNSAFE_METHODS
    if (method, view_name) in DEMO_ALLOWED_WRITES
]


def _is_demo_refusal(response) -> bool:
    if response.status_code != 403:
        return False
    try:
        return response.json().get("code") == DEMO_READ_ONLY_CODE
    except ValueError:
        return False


@pytest.mark.django_db
@pytest.mark.parametrize(("method", "path"), _REFUSED_CASES, ids=[f"{m} {p}" for m, p in _REFUSED_CASES])
def test_route_sweep_refuses_every_unsafe_route_not_allowlisted(method, path, settings):
    """Every unsafe request to every non-allowlisted route answers 403 demo_read_only."""
    settings.DEMO_MODE = True
    response = APIClient().generic(method, path)
    assert _is_demo_refusal(response), (method, path, response.status_code)


@pytest.mark.django_db
@pytest.mark.parametrize(("method", "path"), _ALLOWED_CASES, ids=[f"{m} {p}" for m, p in _ALLOWED_CASES])
def test_route_sweep_allowlisted_writes_reach_the_view(method, path, settings):
    """The allowlisted shapes pass the fence (and then meet the view's own auth)."""
    settings.DEMO_MODE = True
    response = APIClient().generic(method, path)
    assert not _is_demo_refusal(response), (method, path)


def test_route_sweep_is_not_vacuous():
    """Guards the sweep itself: it must see /accounts/, /admin/ and both board-create paths."""
    paths = {p for p, _ in _ALL_ROUTES}
    assert any(p.startswith("/accounts/") for p in paths)
    assert any(p.startswith("/admin/") for p in paths)
    assert "/api/v1/boards/" in paths
    assert "/api/v1/groups/1/boards/" in paths
    assert len(_REFUSED_CASES) > 500


def test_every_allowlisted_entry_matches_a_real_route():
    """A renamed view would leave a dead entry — safe, but it would break the demo silently."""
    view_names = {name for _, name in _ALL_ROUTES}
    for method, view_name in DEMO_ALLOWED_WRITES:
        assert view_name in view_names, (method, view_name)


# ---------------------------------------------------------------------------
# The pin
# ---------------------------------------------------------------------------


class AllowlistPinTests(TestCase):
    def test_allowlist_exact_contents(self):
        """THE PIN. Fails when the allowlist grows or shrinks: every change needs review."""
        self.assertEqual(
            DEMO_ALLOWED_WRITES,
            frozenset({
                ("POST", "accounts.views.ThrottledLoginView"),
                ("POST", "rest_logout"),
                ("POST", "accounts.views.WSTicketView"),
                ("POST", "board-card-list"),
                ("PATCH", "board-card-detail"),
                ("POST", "board-card-move"),
                ("POST", "board-card-archive"),
                ("POST", "board-card-unarchive"),
                ("POST", "board-card-checklist"),
                ("PATCH", "board-card-checklist-item"),
                ("DELETE", "board-card-checklist-item"),
            }),
        )

    def test_safe_methods_exclude_trace(self):
        self.assertEqual(DEMO_SAFE_METHODS, frozenset({"GET", "HEAD", "OPTIONS"}))


# ---------------------------------------------------------------------------
# Negative cases + positive visitor path
# ---------------------------------------------------------------------------


@override_settings(DEMO_MODE=True)
class DemoFenceTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin = User.objects.create_user(username="admin", password="admin-pw-9")
        self.admin.is_site_admin = True
        self.admin.save(update_fields=["is_site_admin"])
        self.visitor = User.objects.create_user(username="visitor", password=PASSWORD)
        self.board = Board.objects.create(name="Software Team", owner=self.admin)
        BoardMembership.objects.create(board=self.board, user=self.admin, role=BoardMembership.Role.ADMIN)
        BoardMembership.objects.create(board=self.board, user=self.visitor, role=BoardMembership.Role.MEMBER)
        self.backlog = Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        self.doing = Column.objects.create(board=self.board, name="Doing", position=1)
        self.lane = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.card = Card.objects.create(
            board=self.board, column=self.backlog, swimlane=self.lane, title="Seeded", created_by=self.admin,
        )

    def _login(self, username="visitor", password=PASSWORD):
        r = self.client.post("/api/v1/auth/login/", {"username": username, "password": password}, format="json")
        self.assertEqual(r.status_code, 200, r.content)

    def assertRefused(self, response):
        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(response.json()["code"], DEMO_READ_ONLY_CODE)
        self.assertTrue(response.json()["detail"].startswith("This is a shared demo — "))

    # --- the visitor's allowed loop -------------------------------------

    def test_visitor_moves_a_seeded_card_and_sees_it_in_history(self):
        self._login()
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/move/",
            {"column_id": self.doing.pk, "swimlane_id": self.lane.pk, "position": 0},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(
            CardMovement.objects.filter(card=self.card, to_column=self.doing, moved_by=self.visitor).exists()
        )
        history = self.client.get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/movements/")
        self.assertEqual(history.status_code, 200)
        self.assertIn("Doing", history.content.decode())

    def test_visitor_creates_and_edits_cards(self):
        self._login()
        r = self.client.post(
            f"/api/v1/boards/{self.board.pk}/cards/",
            {"title": "Mine", "column": self.backlog.pk, "swimlane": self.lane.pk},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        # Edits a SEEDED card (created by admin): allowed by the DEMO_MODE-gated
        # visitor carve-out in boards.permissions, not by a moderator row.
        r = self.client.patch(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/", {"title": "Edited"}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.card.refresh_from_db()
        self.assertEqual(self.card.title, "Edited")

    def test_visitor_checklist_and_archive(self):
        self._login()
        base = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}"
        r = self.client.post(f"{base}/checklist/", {"text": "step"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        item = r.json()["id"]
        self.assertEqual(self.client.patch(f"{base}/checklist/{item}/", {"checked": True}, format="json").status_code, 200)
        self.assertEqual(self.client.delete(f"{base}/checklist/{item}/").status_code, 204)
        self.assertEqual(self.client.post(f"{base}/archive/").status_code, 200)
        self.assertEqual(self.client.post(f"{base}/unarchive/").status_code, 200)

    def test_put_on_card_is_refused(self):
        self._login()
        self.assertRefused(self.client.put(
            f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/", {"title": "x"}, format="json",
        ))

    # --- everything else is refused, for every caller ---------------------

    def test_visitor_cannot_create_a_board(self):
        self._login()
        self.assertRefused(self.client.post("/api/v1/boards/", {"name": "Owned"}, format="json"))
        self.assertFalse(Board.objects.filter(name="Owned").exists())

    def test_group_board_create_is_refused(self):
        """The SECOND board-ADMIN-on-create path (groups/views.py) — pinned explicitly."""
        group = Group.objects.create(name="G", owner=self.visitor)
        GroupMembership.objects.create(group=group, user=self.visitor, role=GroupMembership.Role.ADMIN)
        self._login()
        self.assertRefused(self.client.post(f"/api/v1/groups/{group.pk}/boards/", {"name": "Via group"}, format="json"))
        self.assertFalse(Board.objects.filter(name="Via group").exists())

    def test_site_admin_is_refused_too(self):
        self._login("admin", "admin-pw-9")
        self.assertRefused(self.client.patch("/api/v1/admin/settings/", {"maintenance_mode": True}, format="json"))
        self.assertRefused(self.client.post("/api/v1/boards/", {"name": "Admin board"}, format="json"))

    def test_refused_surfaces(self):
        self._login()
        base = f"/api/v1/boards/{self.board.pk}"
        for method, path in [
            ("post", f"{base}/cards/{self.card.pk}/comments/"),
            ("post", f"{base}/cards/{self.card.pk}/attachments/"),
            ("delete", f"{base}/cards/{self.card.pk}/"),
            ("post", f"{base}/columns/"),
            ("patch", f"{base}/"),
            ("post", "/api/v1/auth/tokens/"),
            ("patch", "/api/v1/auth/user/"),
            ("post", "/api/v1/auth/password/change/"),
            ("post", "/api/v1/auth/change-password/"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertRefused(getattr(self.client, method)(path, {}, format="json"))

    def test_anonymous_password_reset_is_refused(self):
        """Stops the public demo from being an email relay."""
        self.assertRefused(self.client.post("/api/v1/auth/password/reset/", {"email": "x@example.com"}, format="json"))

    def test_anonymous_registration_and_allauth_writes_are_refused(self):
        self.assertRefused(self.client.post("/api/v1/auth/registration/", {}, format="json"))
        self.assertRefused(self.client.post("/accounts/signup/", {}))
        self.assertRefused(self.client.post("/accounts/password/change/", {}))
        self.assertRefused(self.client.post("/accounts/email/", {}))

    def test_method_override_header_is_ignored(self):
        self._login()
        r = self.client.post("/api/v1/boards/", {"name": "Sneaky"}, format="json", HTTP_X_HTTP_METHOD_OVERRIDE="GET")
        self.assertRefused(r)
        self.assertFalse(Board.objects.filter(name="Sneaky").exists())

    def test_trace_is_refused(self):
        self.assertRefused(self.client.generic("TRACE", "/api/v1/boards/"))

    def test_made_up_method_is_refused(self):
        self.assertRefused(self.client.generic("PROPFIND", "/api/v1/boards/"))

    def test_missing_trailing_slash_is_refused(self):
        self._login()
        self.assertRefused(self.client.post("/api/v1/boards", {"name": "NoSlash"}, format="json"))

    def test_double_leading_slash_is_refused(self):
        self._login()
        self.assertRefused(self.client.post("//api/v1/boards/", {"name": "Double"}, format="json"))
        self.assertFalse(Board.objects.filter(name="Double").exists())

    def test_pat_bearer_is_refused(self):
        _, raw = PersonalAccessToken.generate(self.admin, "ci")
        self.client.credentials(HTTP_AUTHORIZATION=f"Token {raw}")
        self.assertRefused(self.client.post("/api/v1/boards/", {"name": "PAT"}, format="json"))

    def test_reads_still_work(self):
        self._login()
        self.assertEqual(self.client.get(f"/api/v1/boards/{self.board.pk}/").status_code, 200)
        self.assertEqual(self.client.head("/api/v1/auth/site-config/").status_code, 200)

    def test_logout_is_allowed(self):
        self._login()
        self.assertEqual(self.client.post("/api/v1/auth/logout/").status_code, 200)


@override_settings(DEMO_LOGIN_USERNAME="visitor")
class DemoVisitorCarveOutTests(TestCase):
    """boards.permissions._is_demo_visitor: the grant must vanish with DEMO_MODE (#1179)."""

    def setUp(self):
        from boards.permissions import can_modify_others_content

        self.check = can_modify_others_content
        self.admin = User.objects.create_user(username="admin", password="admin-pw-9")
        self.visitor = User.objects.create_user(username="visitor", password=PASSWORD)
        self.other = User.objects.create_user(username="maya", password=PASSWORD)
        self.board = Board.objects.create(name="B", owner=self.admin)
        for user in (self.visitor, self.other):
            BoardMembership.objects.create(board=self.board, user=user, role=BoardMembership.Role.MEMBER)

    def test_visitor_is_granted_only_while_demo_mode_is_on(self):
        with override_settings(DEMO_MODE=True):
            self.assertTrue(self.check(self.board, BoardMembership.Role.MEMBER, self.visitor))
        with override_settings(DEMO_MODE=False):
            self.assertFalse(self.check(self.board, BoardMembership.Role.MEMBER, self.visitor))

    @override_settings(DEMO_MODE=True)
    def test_other_members_are_not_granted(self):
        self.assertFalse(self.check(self.board, BoardMembership.Role.MEMBER, self.other))

    @override_settings(DEMO_MODE=True)
    def test_never_lifts_a_collaborator_or_viewer(self):
        for role in (BoardMembership.Role.COLLABORATOR, BoardMembership.Role.VIEWER):
            with self.subTest(role=role):
                self.assertFalse(self.check(self.board, role, self.visitor))

    @override_settings(DEMO_MODE=False)
    def test_visitor_cannot_edit_seeded_card_when_demo_mode_off(self):
        lane = Swimlane.objects.create(board=self.board, name="L", position=0)
        col = Column.objects.create(board=self.board, name="C", position=0)
        card = Card.objects.create(board=self.board, column=col, swimlane=lane, title="Admin's", created_by=self.admin)
        client = APIClient()
        client.force_authenticate(self.visitor)
        r = client.patch(f"/api/v1/boards/{self.board.pk}/cards/{card.pk}/", {"title": "x"}, format="json")
        self.assertEqual(r.status_code, 403, r.content)


class DemoOffTests(TestCase):
    """With DEMO_MODE unset, behavior is unchanged."""

    def test_board_create_works_when_demo_off(self):
        user = User.objects.create_user(username="u", password=PASSWORD)
        client = APIClient()
        client.force_authenticate(user)
        r = client.post("/api/v1/boards/", {"name": "Normal"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)

    def test_trace_is_not_a_demo_refusal_when_off(self):
        r = APIClient().generic("TRACE", "/api/v1/boards/")
        self.assertFalse(_is_demo_refusal(r))


# ---------------------------------------------------------------------------
# MCP guard (runs without MCP_SERVER_ENABLED: exercises the helper directly)
# ---------------------------------------------------------------------------


class McpDemoGuardTests(TestCase):
    def test_require_demo_off(self):
        from mcp_server.server import _require_demo_off

        with override_settings(DEMO_MODE=False):
            self.assertIsNone(_require_demo_off())
        with override_settings(DEMO_MODE=True):
            self.assertEqual(_require_demo_off()["error"]["code"], DEMO_READ_ONLY_CODE)


# ---------------------------------------------------------------------------
# Settings parsing and the reset schedule
# ---------------------------------------------------------------------------


class ParseDemoModeTests(TestCase):
    def test_recognized_values(self):
        for raw, expected in [
            (None, False), ("", False), ("false", False), ("0", False), ("off", False), ("no", False),
            ("true", True), ("True", True), (" 1 ", True), ("yes", True), ("on", True),
        ]:
            with self.subTest(raw=raw):
                self.assertIs(parse_demo_mode(raw), expected)

    def test_typo_refuses_to_boot(self):
        with self.assertRaises(ImproperlyConfigured):
            parse_demo_mode("ture")


def _utc(*args):
    return datetime.datetime(*args, tzinfo=datetime.timezone.utc)


class ResetScheduleTests(TestCase):
    hourly = parse_demo_reset_schedule("0 * * * *")

    def test_default_is_hourly(self):
        self.assertEqual(parse_demo_reset_schedule(None)[0], "0 * * * *")
        self.assertEqual(parse_demo_reset_schedule("  ")[0], "0 * * * *")

    def test_just_before_the_hour(self):
        self.assertEqual(next_reset_at(self.hourly, _utc(2026, 9, 27, 11, 59, 59)), _utc(2026, 9, 27, 12, 0))

    def test_exactly_on_the_hour_is_the_next_slot(self):
        self.assertEqual(next_reset_at(self.hourly, _utc(2026, 9, 27, 12, 0, 0)), _utc(2026, 9, 27, 13, 0))

    def test_just_after_the_hour(self):
        self.assertEqual(next_reset_at(self.hourly, _utc(2026, 9, 27, 12, 0, 1)), _utc(2026, 9, 27, 13, 0))

    def test_day_rollover(self):
        self.assertEqual(next_reset_at(self.hourly, _utc(2026, 9, 27, 23, 30)), _utc(2026, 9, 28, 0, 0))

    def test_every_two_hours_at_half_past(self):
        sched = parse_demo_reset_schedule("30 */2 * * *")
        self.assertEqual(next_reset_at(sched, _utc(2026, 9, 27, 1, 0)), _utc(2026, 9, 27, 2, 30))

    def test_unsupported_expressions_refuse(self):
        for raw in ["not-a-cron", "0 0 1 * *", "61 * * * *", "0 * * *"]:
            with self.subTest(raw=raw), self.assertRaises(ImproperlyConfigured):
                parse_demo_reset_schedule(raw)


class DemoConfigEndpointTests(TestCase):
    def test_site_config_fields_null_when_off(self):
        body = APIClient().get("/api/v1/auth/site-config/").json()
        self.assertIsNone(body["demo_reset_schedule"])
        self.assertIsNone(body["demo_next_reset_at"])

    @override_settings(DEMO_MODE=True, DEMO_RESET_SCHEDULE="0 * * * *")
    def test_site_config_fields_when_on(self):
        body = APIClient().get("/api/v1/auth/site-config/").json()
        self.assertEqual(body["demo_reset_schedule"], "0 * * * *")
        when = datetime.datetime.fromisoformat(body["demo_next_reset_at"].replace("Z", "+00:00"))
        self.assertEqual((when.minute, when.second), (0, 0))
        now = datetime.datetime.now(datetime.timezone.utc)
        self.assertTrue(now < when <= now + datetime.timedelta(hours=1))

    def test_current_user_demo_fields(self):
        user = User.objects.create_user(username="u", password=PASSWORD)
        client = APIClient()
        client.force_authenticate(user)
        body = client.get("/api/v1/auth/user/").json()
        self.assertIs(body["demo_mode"], False)
        self.assertIsNone(body["demo_next_reset_at"])
        with override_settings(DEMO_MODE=True):
            body = client.get("/api/v1/auth/user/").json()
        self.assertIs(body["demo_mode"], True)
        self.assertTrue(body["demo_next_reset_at"].endswith(":00:00Z"))


def test_resolve_of_unmatched_double_slash_path_is_a_404():
    """Documents why DemoModeMiddleware.__call__ rewrites unresolved 404s."""
    with pytest.raises(Resolver404):
        resolve("//api/v1/boards/")
