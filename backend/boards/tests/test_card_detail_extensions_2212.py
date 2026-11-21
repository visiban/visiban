"""Card-detail extension sections (#2212): role filter, isolation, validation.

Read-only v1. Covers Security Invariants Rule 12 (one reader of
CARD_DETAIL_EXTENSIONS, filter before the call, fail closed), Rule 7 (404
without access) and the absent-input guards (#1075).
"""

import ast
import logging
import math
import pathlib
from unittest import mock

from django.contrib.auth.models import AnonymousUser
from django.test import TestCase
from rest_framework.test import APIClient

from boards import hooks
from boards.models import BoardMembership
from boards.permissions import (
    CARD_DETAIL_EXTENSION_DEFAULT_MIN_ROLE,
    analytics_extensions_for_role,
    card_detail_extension_min_role,
    card_detail_extensions_for_role,
)
from boards.services import card_extensions
from boards.services.card_extensions import MAX_FIELDS, MAX_SECTIONS, sections_for_card
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane, _make_user

Role = BoardMembership.Role


def _field(**over):
    base = {"key": "amount", "label": "Amount", "type": "number", "value": 12}
    base.update(over)
    return base


class _Ext:
    """A recording extension. ``calls`` counts section() invocations."""

    def __init__(self, ext_id="deal", min_role="viewer", section=None, fields=None):
        self.id = ext_id
        if min_role is not ...:
            self.min_role = min_role
        self.calls = 0
        self._section = section
        self._fields = fields if fields is not None else [_field()]

    def section(self, card, user, role):
        self.calls += 1
        if self._section is not None:
            return self._section(card, user, role) if callable(self._section) else self._section
        return {"title": "Deal", "fields": self._fields}


class _Base(TestCase):
    def setUp(self):
        self.owner = _make_user()
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board)
        self.lane = _make_swimlane(self.board)
        self.card = _make_card(self.col, self.lane)
        self.users = {}
        for role in (Role.VIEWER, Role.COLLABORATOR, Role.MEMBER, Role.ADMIN):
            u = _make_user()
            BoardMembership.objects.create(board=self.board, user=u, role=role)
            self.users[role] = u
        self.outsider = _make_user()

    def _get(self, user, card=None, board=None):
        c = APIClient()
        c.force_authenticate(user)
        return c.get(f"/api/v1/boards/{(board or self.board).pk}/cards/{(card or self.card).pk}/extensions/")

    def _patch(self, *exts):
        return mock.patch.object(hooks, "CARD_DETAIL_EXTENSIONS", list(exts))


class RoleFilterTests(_Base):
    def test_role_matrix_with_call_counts(self):
        ext = _Ext(min_role="member")
        with self._patch(ext):
            for role, visible in (
                (Role.VIEWER, False), (Role.COLLABORATOR, False), (Role.MEMBER, True), (Role.ADMIN, True),
            ):
                before = ext.calls
                res = self._get(self.users[role])
                self.assertEqual(res.status_code, 200)
                self.assertEqual(len(res.json()["sections"]), 1 if visible else 0, role)
                # Filtered BEFORE the call: a hidden extension is never invoked.
                self.assertEqual(ext.calls - before, 1 if visible else 0, role)
            self.assertEqual(len(self._get(self.owner).json()["sections"]), 1)

    def test_site_admin_without_membership_sees_site_admin_extension(self):
        su = _make_user()
        su.is_superuser = True
        su.save(update_fields=["is_superuser"])
        ext = _Ext(min_role="site_admin")
        with self._patch(ext):
            self.assertEqual(len(self._get(su).json()["sections"]), 1)
            before = ext.calls
            self.assertEqual(self._get(self.users[Role.ADMIN]).json()["sections"], [])
            self.assertEqual(ext.calls, before)

    def test_undeclared_min_role_fails_closed_to_admin(self):
        ext = _Ext(min_role=...)
        self.assertFalse(hasattr(ext, "min_role"))
        self.assertEqual(card_detail_extension_min_role(ext), CARD_DETAIL_EXTENSION_DEFAULT_MIN_ROLE)
        with self._patch(ext):
            self.assertEqual(self._get(self.users[Role.MEMBER]).json()["sections"], [])
            self.assertEqual(ext.calls, 0)
            self.assertEqual(len(self._get(self.users[Role.ADMIN]).json()["sections"]), 1)

    def test_invalid_min_role_fails_closed_to_admin(self):
        for bad in ("Viewer", "owner", 3, None):
            ext = _Ext(min_role=bad)
            self.assertEqual(card_detail_extension_min_role(ext), Role.ADMIN, bad)
            with self._patch(ext):
                self.assertEqual(card_detail_extensions_for_role(Role.MEMBER), [])
                self.assertEqual(card_detail_extensions_for_role(Role.ADMIN), [ext])

    def test_raising_min_role_is_skipped_for_everyone(self):
        class Boom(_Ext):
            @property
            def min_role(self):
                raise RuntimeError("no")

            @min_role.setter
            def min_role(self, v):
                pass

        ext = Boom()
        with self._patch(ext):
            self.assertEqual(card_detail_extensions_for_role("site_admin"), [])

    def test_absent_or_unknown_role_gets_nothing(self):
        """#1075: the absent-input branch, next to the populated case above."""
        ext = _Ext()
        with self._patch(ext):
            self.assertEqual(card_detail_extensions_for_role(Role.VIEWER), [ext])
            self.assertEqual(card_detail_extensions_for_role(None), [])
            self.assertEqual(card_detail_extensions_for_role("owner"), [])
            self.assertEqual(card_detail_extensions_for_role(""), [])

    def test_analytics_filter_still_fails_closed_after_the_shared_helper(self):
        def panel(board, request):
            return {}

        with mock.patch.object(hooks, "ANALYTICS_EXTENSIONS", [panel]):
            self.assertEqual(analytics_extensions_for_role(Role.MEMBER), [])
            self.assertEqual(analytics_extensions_for_role(Role.ADMIN), [panel])
            self.assertEqual(analytics_extensions_for_role(None), [])


class AccessTests(_Base):
    def test_no_extension_registered_is_empty_sections(self):
        with self._patch():
            res = self._get(self.users[Role.VIEWER])
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"sections": []})

    def test_outsider_gets_404_and_extension_is_not_called(self):
        ext = _Ext()
        with self._patch(ext):
            res = self._get(self.outsider)
            missing = self._get(self.users[Role.VIEWER], board=mock.Mock(pk=999999))
        self.assertEqual(res.status_code, 404)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(res.json(), missing.json())  # Rule 7: one body
        self.assertEqual(ext.calls, 0)

    def test_card_on_another_board_is_404(self):
        other_owner = _make_user()
        other = _make_board(other_owner)
        other_card = _make_card(_make_column(other), _make_swimlane(other))
        BoardMembership.objects.create(board=other, user=self.users[Role.VIEWER], role=Role.VIEWER)
        ext = _Ext()
        with self._patch(ext):
            res = self._get(self.users[Role.VIEWER], card=other_card)
        self.assertEqual(res.status_code, 404)
        self.assertEqual(ext.calls, 0)

    def test_unauthenticated_is_refused(self):
        res = APIClient().get(f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/extensions/")
        self.assertIn(res.status_code, (401, 403))

    def test_only_get(self):
        c = APIClient()
        c.force_authenticate(self.owner)
        url = f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/extensions/"
        for method in ("post", "patch", "put", "delete"):
            self.assertEqual(getattr(c, method)(url, {}, format="json").status_code, 405, method)


class IsolationAndValidationTests(_Base):
    def _sections(self, *exts, role=Role.ADMIN):
        with self._patch(*exts):
            return sections_for_card(self.card, self.owner, role)

    def test_valid_section_shape_and_id_stamped_by_oss(self):
        ext = _Ext(section={"id": "someone-else", "title": " Deal ", "fields": [
            _field(),
            _field(key="stage", label="Stage", type="choice", value="Won", choices=["Open", "Won"]),
            _field(key="close", label="Close", type="date", value="2026-12-01"),
            _field(key="notes", label="Notes", type="text", value="line1\nline2", display="Two lines"),
            _field(key="empty", label="Empty", type="text", value=""),
        ]})
        [section] = self._sections(ext)
        self.assertEqual(section["id"], "deal")
        self.assertEqual(section["title"], "Deal")
        self.assertEqual([f["key"] for f in section["fields"]], ["amount", "stage", "close", "notes", "empty"])
        self.assertIsNone(section["fields"][4]["value"])
        self.assertEqual(section["fields"][3]["display"], "Two lines")
        self.assertNotIn("editable", section["fields"][0])

    def test_extra_field_keys_are_not_passed_through(self):
        ext = _Ext(fields=[_field(editable=True, html="<b>x</b>")])
        [section] = self._sections(ext)
        self.assertEqual(set(section["fields"][0]), {"key", "label", "type", "value"})

    def test_none_section_means_not_for_this_card(self):
        self.assertEqual(self._sections(_Ext(section=lambda *a: None)), [])

    def test_bad_shapes_are_dropped_whole_and_others_survive(self):
        bad_fields = [
            [_field(key="Bad")],
            [_field(type="url", value="https://x")],
            [_field(type="html")],
            [_field(value=math.nan)],
            [_field(value=math.inf)],
            [_field(value=True)],
            [_field(type="text", value="x" * 501)],
            [_field(type="text", value="a\x00b")],
            [_field(type="text", value="\ud800")],
            [_field(label="Am‮ount")],
            [_field(label="")],
            [_field(type="date", value="2026-13-01")],
            [_field(type="date", value="12/01/2026")],
            [_field(type="choice", value="Lost", choices=["Won"])],
            [_field(type="choice", value="Won", choices="Won")],
            [_field(), _field()],  # duplicate key
            [_field(key=f"f{i}") for i in range(MAX_FIELDS + 1)],
            [],
            ["not a dict"],
        ]
        for i, fields in enumerate(bad_fields):
            with self.subTest(i=i):
                with self.assertLogs("boards.services.card_extensions", logging.WARNING) as logs:
                    out = self._sections(_Ext(ext_id="bad", fields=fields), _Ext(ext_id="good"))
                self.assertEqual([s["id"] for s in out], ["good"])
                self.assertEqual(len(logs.output), 1)
                self.assertIn("CARD_DETAIL_EXTENSIONS", logs.output[0])

    def test_non_dict_section_and_bad_title_dropped(self):
        for raw in ("text", ["list"], {"title": "x" * 121, "fields": [_field()]}, {"fields": [_field()]}):
            self.assertEqual(self._sections(_Ext(section=raw)), [], raw)

    def test_exactly_max_fields_is_kept(self):
        [section] = self._sections(_Ext(fields=[_field(key=f"f{i}") for i in range(MAX_FIELDS)]))
        self.assertEqual(len(section["fields"]), MAX_FIELDS)

    def test_crashing_extension_is_isolated_and_log_carries_no_content(self):
        def boom(card, user, role):
            raise ValueError(f"secret {user.email}")

        crash = _Ext(ext_id="crash", section=boom)
        ok = _Ext(ext_id="ok")
        with self.assertLogs("boards.services.card_extensions", logging.WARNING) as logs:
            out = self._sections(crash, ok)
        self.assertEqual([s["id"] for s in out], ["ok"])
        joined = "\n".join(logs.output)
        self.assertIn("ValueError", joined)
        self.assertNotIn("secret", joined)

    def test_crash_does_not_500_the_endpoint(self):
        crash = _Ext(section=lambda *a: 1 / 0)
        with self._patch(crash):
            res = self._get(self.owner)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json(), {"sections": []})

    def test_bad_and_duplicate_ids(self):
        first, dup = _Ext(ext_id="same"), _Ext(ext_id="same")
        bad = _Ext(ext_id="Bad Id")
        out = self._sections(bad, first, dup)
        self.assertEqual([s["id"] for s in out], ["same"])
        self.assertEqual((bad.calls, first.calls, dup.calls), (0, 1, 0))

    def test_at_most_max_sections_extensions_are_called(self):
        exts = [_Ext(ext_id=f"e{i}") for i in range(MAX_SECTIONS + 2)]
        out = self._sections(*exts)
        self.assertEqual(len(out), MAX_SECTIONS)
        self.assertEqual(sum(e.calls for e in exts), MAX_SECTIONS)

    def test_receives_card_user_and_role_but_no_request(self):
        seen = {}

        def capture(card, user, role):
            seen.update(card=card, user=user, role=role)
            return None

        with self._patch(_Ext(section=capture)):
            self._get(self.users[Role.VIEWER])
        self.assertEqual(seen["card"].pk, self.card.pk)
        self.assertEqual(seen["user"], self.users[Role.VIEWER])
        self.assertEqual(seen["role"], Role.VIEWER)

    def test_absent_inputs_fail_closed(self):
        """#1075: no card, no user, anonymous user or no role -> [] and no call."""
        ext = _Ext()
        with self._patch(ext):
            self.assertEqual(len(sections_for_card(self.card, self.owner, Role.ADMIN)), 1)
            self.assertEqual(sections_for_card(None, self.owner, Role.ADMIN), [])
            self.assertEqual(sections_for_card(self.card, None, Role.ADMIN), [])
            self.assertEqual(sections_for_card(self.card, AnonymousUser(), Role.ADMIN), [])
            self.assertEqual(sections_for_card(self.card, self.owner, None), [])
        self.assertEqual(ext.calls, 1)


class TransportParityTests(_Base):
    """Rule 10: extension code runs only on the extensions endpoint."""

    def test_no_other_read_calls_an_extension(self):
        ext = _Ext()
        c = APIClient()
        c.force_authenticate(self.owner)
        with self._patch(ext):
            for url in (
                f"/api/v1/boards/{self.board.pk}/full/",
                f"/api/v1/boards/{self.board.pk}/cards/",
                f"/api/v1/boards/{self.board.pk}/cards/{self.card.pk}/",
                f"/api/v1/boards/{self.board.pk}/",
                f"/api/v1/boards/{self.board.pk}/summary/",
            ):
                res = c.get(url)
                self.assertEqual(res.status_code, 200, url)
                self.assertNotIn(b'"sections"', res.content, url)
        self.assertEqual(ext.calls, 0)


class CardDetailExtensionsEntryPointTests(TestCase):
    """Security Invariants Rule 12: one reader of CARD_DETAIL_EXTENSIONS."""

    ALLOWED = {
        "boards/hooks.py": "defines the list",
        "boards/permissions.py": "card_detail_extensions_for_role, the shared filter",
    }

    def test_only_the_shared_filter_reads_the_list(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        offenders = []
        for path in root.rglob("*.py"):
            rel = path.relative_to(root).as_posix()
            parts = set(path.relative_to(root).parts)
            if parts & {"tests", "migrations", ".venv", "node_modules"} or rel in self.ALLOWED:
                continue
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if (
                    (isinstance(node, ast.Attribute) and node.attr == "CARD_DETAIL_EXTENSIONS")
                    or (isinstance(node, ast.Name) and node.id == "CARD_DETAIL_EXTENSIONS")
                    or (isinstance(node, ast.alias) and node.name == "CARD_DETAIL_EXTENSIONS")
                ):
                    offenders.append(f"{rel}:{getattr(node, 'lineno', '?')}")
        self.assertEqual(
            offenders, [],
            "Read CARD_DETAIL_EXTENSIONS through boards.permissions.card_detail_extensions_for_role",
        )

    def test_service_reads_through_the_filter(self):
        self.assertIs(card_extensions.card_detail_extensions_for_role, card_detail_extensions_for_role)

    def test_registry_is_a_list_on_hooks(self):
        self.assertIsInstance(hooks.CARD_DETAIL_EXTENSIONS, list)
