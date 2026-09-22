"""#1078 — the WebSocket event registries are the frozen wire contract.

``CLAUDE.md`` declares the ``{event, data}`` board_* schema a public 1.0+
contract: a name may be added, never renamed or removed without a major bump.
#1078 moved every call site from a bare string literal onto a registry constant
so a CI gate can read the emitted set as a Python object instead of grepping
for literals — a refactor of *how the name is referenced*, never of what goes
on the wire.

These tests exist so that refactor can never quietly become a rename. The
expected values below are spelled out as literals on purpose: comparing the
registry to itself would prove nothing, and an expectation derived from the
registry would follow any typo straight through. If one of these fails, the
question is not "update the test" — it is whether you just broke every
deployed client.

``scripts/check-ws-event-reachability.py`` covers the other half (that each of
these names is also documented and handled); this file covers the strings.
"""
import json
from unittest.mock import patch

from django.test import SimpleTestCase

from boards import broadcast as board_broadcast
from boards.permissions import MODERATOR_BEARING_EVENTS
from groups import broadcast as group_broadcast

# The board channel's full wire surface, constant name -> exact string.
FROZEN_BOARD_EVENTS = {
    "EVT_BOARD_CREATED": "board.created",
    "EVT_BOARD_UPDATED": "board.updated",
    "EVT_BOARD_DELETED": "board.deleted",
    "EVT_BOARD_STAR_CHANGED": "board.star_changed",
    "EVT_SAVED_FILTER_CREATED": "saved_filter.created",
    "EVT_SAVED_FILTER_DELETED": "saved_filter.deleted",
    "EVT_COLUMN_CREATED": "column.created",
    "EVT_COLUMN_UPDATED": "column.updated",
    "EVT_COLUMN_DELETED": "column.deleted",
    "EVT_COLUMN_REORDERED": "column.reordered",
    "EVT_SWIMLANE_CREATED": "swimlane.created",
    "EVT_SWIMLANE_UPDATED": "swimlane.updated",
    "EVT_SWIMLANE_DELETED": "swimlane.deleted",
    "EVT_SWIMLANE_REORDERED": "swimlane.reordered",
    "EVT_LABEL_CREATED": "label.created",
    "EVT_LABEL_UPDATED": "label.updated",
    "EVT_LABEL_DELETED": "label.deleted",
    "EVT_CUSTOM_FIELD_CREATED": "custom_field.created",
    "EVT_CUSTOM_FIELD_UPDATED": "custom_field.updated",
    "EVT_CUSTOM_FIELD_DELETED": "custom_field.deleted",
    "EVT_CUSTOM_FIELD_REORDERED": "custom_field.reordered",
    "EVT_SWIMLANE_CUSTOM_FIELD_CREATED": "swimlane_custom_field.created",
    "EVT_SWIMLANE_CUSTOM_FIELD_UPDATED": "swimlane_custom_field.updated",
    "EVT_SWIMLANE_CUSTOM_FIELD_DELETED": "swimlane_custom_field.deleted",
    "EVT_SWIMLANE_CUSTOM_FIELD_REORDERED": "swimlane_custom_field.reordered",
    "EVT_CARD_CREATED": "card.created",
    "EVT_CARD_UPDATED": "card.updated",
    "EVT_CARD_DELETED": "card.deleted",
    "EVT_CARD_MOVED": "card.moved",
    "EVT_CARD_ARCHIVED": "card.archived",
    "EVT_CARD_UNARCHIVED": "card.unarchived",
    "EVT_MEMBER_ADDED": "member.added",
    "EVT_MEMBER_UPDATED": "member.updated",
    "EVT_MEMBER_REMOVED": "member.removed",
    "EVT_LENS_CONNECTION_CONFIGURED": "lens_connection.configured",
    "EVT_LENS_CONNECTION_REMOVED": "lens_connection.removed",
    "EVT_PING": "ping",
}

# Group-channel-only names. The overlapping board.* / member.* / ping names are
# imported from the board registry, so they are covered by the dict above.
FROZEN_GROUP_ONLY_EVENTS = {
    "EVT_GROUP_CREATED": "group.created",
    "EVT_GROUP_UPDATED": "group.updated",
    "EVT_GROUP_DELETED": "group.deleted",
    "EVT_GROUP_STAR_CHANGED": "group.star_changed",
    "EVT_GROUP_LABEL_CREATED": "group.label.created",
    "EVT_GROUP_LABEL_UPDATED": "group.label.updated",
    "EVT_GROUP_LABEL_DELETED": "group.label.deleted",
    "EVT_INVITE_LINK_REVOKED": "invite_link.revoked",
}

FROZEN_GROUP_CHANNEL = set(FROZEN_GROUP_ONLY_EVENTS.values()) | {
    "board.created",
    "board.updated",
    "board.deleted",
    "board.star_changed",
    "member.added",
    "member.updated",
    "member.removed",
    "ping",
}


class BoardEventRegistryTests(SimpleTestCase):
    def test_every_board_constant_holds_its_frozen_string(self):
        for name, wire in FROZEN_BOARD_EVENTS.items():
            with self.subTest(constant=name):
                self.assertEqual(getattr(board_broadcast, name), wire)

    def test_board_channel_set_is_exactly_the_frozen_surface(self):
        """No name silently added to or dropped from the public contract."""
        self.assertEqual(
            board_broadcast.BOARD_CHANNEL_EVENTS,
            frozenset(FROZEN_BOARD_EVENTS.values()),
        )

    def test_constants_are_plain_str(self):
        """Not an Enum member, not a lazy string.

        The value is handed to msgpack (the channel layer codec) and stored in a
        CharField. A str subclass that stringifies to anything but the wire name
        would break both without failing an equality assertion.
        """
        for name in FROZEN_BOARD_EVENTS:
            with self.subTest(constant=name):
                self.assertIs(type(getattr(board_broadcast, name)), str)

    def test_card_unarchived_is_not_card_restored(self):
        """The WS name and the CARD_MUTATION_HOOKS name diverge deliberately.

        ``unarchive_card`` broadcasts ``card.unarchived`` but fires the hook
        ``card.restored``. Both are frozen independently — the WS name by this
        contract, the hook name by the 1.0+ extension guarantee. Neither may be
        "corrected" to match the other; see boards/hooks.py.
        """
        self.assertEqual(board_broadcast.EVT_CARD_UNARCHIVED, "card.unarchived")
        self.assertNotIn("card.restored", board_broadcast.BOARD_CHANNEL_EVENTS)


class GroupEventRegistryTests(SimpleTestCase):
    def test_every_group_constant_holds_its_frozen_string(self):
        for name, wire in FROZEN_GROUP_ONLY_EVENTS.items():
            with self.subTest(constant=name):
                self.assertEqual(getattr(group_broadcast, name), wire)

    def test_group_channel_set_is_exactly_the_frozen_surface(self):
        self.assertEqual(group_broadcast.GROUP_CHANNEL_EVENTS, frozenset(FROZEN_GROUP_CHANNEL))

    def test_shared_names_are_the_same_object_as_the_board_registry(self):
        """Re-exported, not restated — the two channels cannot drift to two
        different strings for what clients see as one name."""
        for name in ("EVT_BOARD_CREATED", "EVT_MEMBER_REMOVED", "EVT_PING"):
            with self.subTest(constant=name):
                self.assertIs(getattr(group_broadcast, name), getattr(board_broadcast, name))


class ExemptionHygieneTests(SimpleTestCase):
    """The exemption maps are load-bearing, so they get the same scrutiny.

    An exemption whose event no longer exists, or which carries no reason, turns
    the gate from an assertion into a rubber stamp for that name.
    """

    def test_unhandled_exemptions_reference_declared_events_with_a_reason(self):
        for registry, exemptions, declared in (
            ("boards", board_broadcast.INTENTIONALLY_UNHANDLED_BOARD_EVENTS,
             board_broadcast.BOARD_CHANNEL_EVENTS),
            ("groups", group_broadcast.INTENTIONALLY_UNHANDLED_GROUP_EVENTS,
             group_broadcast.GROUP_CHANNEL_EVENTS),
        ):
            for name, reason in exemptions.items():
                with self.subTest(registry=registry, event=name):
                    self.assertIn(name, declared)
                    self.assertTrue(reason.strip(), "an exemption without a reason is a rubber stamp")

    def test_deprecated_names_are_not_also_declared_as_live(self):
        for registry, deprecated, declared in (
            ("boards", board_broadcast.DEPRECATED_BOARD_EVENTS, board_broadcast.BOARD_CHANNEL_EVENTS),
            ("groups", group_broadcast.DEPRECATED_GROUP_EVENTS, group_broadcast.GROUP_CHANNEL_EVENTS),
        ):
            for name in deprecated:
                with self.subTest(registry=registry, event=name):
                    self.assertNotIn(name, declared)


class EnvelopeShapeTests(SimpleTestCase):
    def test_broadcast_envelope_is_unchanged_by_the_registry_refactor(self):
        """Still {event, data} carrying the exact wire string — never {type, ...}."""
        sent = {}

        class _Layer:
            async def group_send(self, group, message):
                sent["group"] = group
                sent["message"] = message

        with patch("boards.broadcast.get_channel_layer", return_value=_Layer()):
            board_broadcast.broadcast_board_event(7, board_broadcast.EVT_CARD_MOVED, {"card_uid": "abc"})

        self.assertEqual(sent["group"], "board_7")
        self.assertEqual(sent["message"]["type"], "board_event")
        self.assertEqual(
            sent["message"]["payload"],
            {"event": "card.moved", "data": {"card_uid": "abc"}},
        )
        # Round-trips to the literal name, not an enum repr.
        self.assertIn('"event": "card.moved"', json.dumps(sent["message"]["payload"]))

    def test_group_envelope_is_unchanged(self):
        sent = {}

        class _Layer:
            async def group_send(self, group, message):
                sent["group"] = group
                sent["message"] = message

        with patch("groups.broadcast.get_channel_layer", return_value=_Layer()):
            group_broadcast.broadcast_group_event(3, group_broadcast.EVT_GROUP_UPDATED, {"id": 3})

        self.assertEqual(sent["group"], "group_3")
        self.assertEqual(
            sent["message"]["payload"],
            {"event": "group.updated", "data": {"id": 3}},
        )

    def test_moderator_bearing_events_still_names_the_two_member_events(self):
        """#978's per-subscriber is_moderator gate keys off these exact strings."""
        self.assertEqual(MODERATOR_BEARING_EVENTS, ("member.added", "member.updated"))
