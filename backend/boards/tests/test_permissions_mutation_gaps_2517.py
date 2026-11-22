"""Gap tests for the ``boards/permissions.py`` mutants that survived 2026-11-22 (#2517).

Covers the card-detail extension registry (#2212), the admin-only event
predicate, ``_registered_for_role``'s zero-rank boundary, and the
absent-subject denial of the two board permission classes (#1075).
"""
import logging
from types import SimpleNamespace
from unittest import mock

from django.test import SimpleTestCase, TestCase

from boards import permissions as perms
from boards.invites import ROLE_RANK
from boards.models import BoardMembership
from boards.permissions import (
    SITE_ADMIN, IsBoardAdminOrOwner, IsBoardMember, admin_only_event_visible,
    card_detail_extension_min_role, card_detail_extensions_for_role,
)
from boards.tests.conftest import _make_board, _make_user

ADMIN = BoardMembership.Role.ADMIN
MEMBER = BoardMembership.Role.MEMBER
VIEWER = BoardMembership.Role.VIEWER


def _ext(**attrs):
    def ext(*args, **kwargs):  # pragma: no cover - never called here
        return None

    for key, value in attrs.items():
        setattr(ext, key, value)
    return ext


class AdminOnlyEventVisibleTests(SimpleTestCase):
    # #2517: ids 31 (constant -> None) and 32 (``in`` -> ``not in``).
    def test_only_admin_and_site_admin_see_admin_only_events(self):
        self.assertIs(admin_only_event_visible(ADMIN), True)
        self.assertIs(admin_only_event_visible(SITE_ADMIN), True)
        for role in (MEMBER, VIEWER, BoardMembership.Role.COLLABORATOR, None, "bogus"):
            self.assertIs(admin_only_event_visible(role), False)


class CardDetailExtensionRegistryTests(SimpleTestCase):
    # #2517: ids 170 (default -> None), 171 and 172 (registry label).
    def test_default_min_role_is_admin(self):
        self.assertEqual(perms.CARD_DETAIL_EXTENSION_DEFAULT_MIN_ROLE, ADMIN)
        self.assertEqual(card_detail_extension_min_role(_ext()), ADMIN)

    def test_extension_without_min_role_reaches_admin_but_not_member(self):
        ext = _ext()
        with mock.patch("boards.hooks.CARD_DETAIL_EXTENSIONS", [ext]):
            self.assertEqual(card_detail_extensions_for_role(ADMIN), [ext])
            self.assertEqual(card_detail_extensions_for_role(SITE_ADMIN), [ext])
            self.assertEqual(card_detail_extensions_for_role(MEMBER), [])

    def test_invalid_min_role_log_names_the_card_detail_registry(self):
        with self.assertLogs("boards.permissions", logging.WARNING) as logs:
            self.assertEqual(card_detail_extension_min_role(_ext(min_role="nope")), ADMIN)
        # Exact prefix, not assertIn: a label wrapped in extra text must fail.
        self.assertIn(":CARD_DETAIL_EXTENSIONS callable ", logs.output[0])

    def test_unreadable_min_role_log_names_the_card_detail_registry(self):
        class Raising:
            @property
            def min_role(self):
                raise RuntimeError("boom")

        with mock.patch("boards.hooks.CARD_DETAIL_EXTENSIONS", [Raising()]):
            with self.assertLogs("boards.permissions", logging.WARNING) as logs:
                self.assertEqual(card_detail_extensions_for_role(ADMIN), [])
        # Exact prefix, not assertIn: a label wrapped in extra text must fail.
        self.assertIn(":CARD_DETAIL_EXTENSIONS callable ", logs.output[0])


class RegisteredForRoleZeroRankTests(SimpleTestCase):
    # #2517: id 158 (``caller_rank <= 0`` -> ``< 0``).
    def test_absent_or_unknown_role_gets_nothing_even_from_a_rank_zero_entry(self):
        entry = _ext()
        ranks = {**ROLE_RANK, "rank_zero": 0}
        with mock.patch.dict(ROLE_RANK, ranks):
            for role in (None, "bogus"):
                self.assertEqual(
                    perms._registered_for_role([entry], "X", lambda e: "rank_zero", role), []
                )


class RegisteredForRoleLowestRankTests(SimpleTestCase):
    # #2517: the lowest real rank (viewer) is still admitted to a viewer entry.
    def test_viewer_reaches_a_viewer_entry_but_not_a_member_entry(self):
        low, high = _ext(min_role=VIEWER), _ext(min_role=MEMBER)
        with mock.patch("boards.hooks.CARD_DETAIL_EXTENSIONS", [low, high]):
            self.assertEqual(card_detail_extensions_for_role(VIEWER), [low])


class BoardPermissionClassesDenyAbsentSubjectTests(TestCase):
    # #2517: ids 177 and 181 (``return False`` -> ``return True``), #1075.
    def test_both_classes_deny_a_subject_that_is_not_a_board(self):
        request = SimpleNamespace(user=_make_user())
        for subject in (object(), SimpleNamespace(board=None), SimpleNamespace(board="x")):
            self.assertIs(IsBoardMember().has_object_permission(request, None, subject), False)
            self.assertIs(IsBoardAdminOrOwner().has_object_permission(request, None, subject), False)

    def test_a_real_board_is_still_judged_by_role(self):
        owner = _make_user()
        board = _make_board(owner)
        stranger = SimpleNamespace(user=_make_user())
        self.assertIs(IsBoardMember().has_object_permission(stranger, None, board), False)
        self.assertIs(IsBoardAdminOrOwner().has_object_permission(stranger, None, board), False)
