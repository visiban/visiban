"""Prefix dispatch for registration tokens (#1899).

``accounts.registration_tokens`` is the one table every registration path reads
(REST view, OAuth adapter, OAuth middleware). A kind honored on one path and
refused on another is the failure it exists to prevent, so the dispatch itself
is pinned here. The consume-once concurrency of each kind's ``redeem`` is
covered by ``boards/tests/test_board_invite_races.py`` and the group/site
invite race tests.
"""

from django.test import SimpleTestCase

from accounts import registration_tokens as rt


class RegistrationTokenKindDispatchTests(SimpleTestCase):
    def test_each_prefix_selects_its_kind(self):
        for raw, kind in (("vbnl_abc", rt.SITE), ("vbng_abc", rt.GROUP), ("vbnb_abc", rt.BOARD)):
            with self.subTest(raw=raw):
                self.assertIs(rt.registration_token_kind(raw), kind)

    def test_surrounding_whitespace_is_ignored(self):
        self.assertIs(rt.registration_token_kind("  vbnb_abc \n"), rt.BOARD)

    def test_unknown_blank_and_absent_tokens_fall_back_to_the_site_kind(self):
        """Absent input must not select a group or board kind (#1075)."""
        for raw in ("", "   ", None, "garbage", "VBNB_upper", "xvbnb_abc"):
            with self.subTest(raw=raw):
                self.assertIs(rt.registration_token_kind(raw), rt.SITE)

    def test_prefixes_are_unique_and_all_stashable_across_the_oauth_round_trip(self):
        prefixes = [kind.prefix for kind in rt.REGISTRATION_TOKEN_KINDS]
        self.assertEqual(len(prefixes), len(set(prefixes)))
        self.assertEqual(rt.STASHABLE_PREFIXES, tuple(prefixes))
