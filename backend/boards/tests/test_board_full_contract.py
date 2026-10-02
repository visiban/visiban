"""Serializer contract tests for GET /api/v1/boards/{id}/full/.

Locks in fields that the frontend `BoardFull` TypeScript interface depends
on. Removing any of these from `BoardFullSerializer.Meta.fields` is a
breaking change for every client and must fail the suite early.

Regression guard for #543 — `owner` was previously missing from BoardFull
even though `Board` exposed it, forcing a second API call for ownership
checks in the frontend.
"""

import datetime
import uuid

from django.test import TestCase
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User
from boards.custom_field_types import CHOICE_COLOR_KEYS
from boards.models import (
    Board,
    BoardMembership,
    Card,
    CardExternalRef,
    CardMovement,
    Column,
    CustomFieldDefinition,
    CustomFieldValue,
    Label,
    Swimlane,
    SwimlaneCustomFieldDefinition,
    SwimlaneCustomFieldValue,
)
from groups.models import Group


class BoardFullSerializerContractTests(TestCase):
    def setUp(self):
        self.owner = User.objects.create_user(username="ownsit", password="pass")
        self.board = Board.objects.create(name="Contract Board", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        Column.objects.create(board=self.board, name="Backlog", position=0, allow_card_creation=True)
        Swimlane.objects.create(board=self.board, name="General", position=0)

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_full_response_exposes_owner(self):
        """`owner` must be present in the /full/ payload so frontend can
        perform ownership checks without a second API call."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("owner", r.data)
        self.assertIsNotNone(r.data["owner"])

    def test_full_response_owner_has_boarduser_shape(self):
        """`owner` must match BoardUserSerializer's shape: id, username,
        display_name, avatar_url — no email or privilege flags leak."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        owner_payload = r.data["owner"]
        self.assertEqual(set(owner_payload.keys()), {"id", "username", "display_name", "avatar_url"})
        self.assertEqual(owner_payload["id"], self.owner.id)
        self.assertEqual(owner_payload["username"], "ownsit")

    def test_full_response_includes_frontend_required_fields(self):
        """Fields the frontend `BoardFull` interface depends on must all
        be present. Missing any of these silently breaks the client."""
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        required = {
            "id", "uid", "name", "description", "owner", "group", "group_name",
            "columns", "swimlanes", "cards", "labels", "members",
            "staleness_threshold_days", "stale_warning_pct", "allowed_priorities",
            "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits",
            "created_at", "updated_at", "current_user_role", "is_starred",
            "share_token", "share_token_expires_at", "capabilities",
        }
        missing = required - set(r.data.keys())
        self.assertFalse(missing, f"BoardFull response is missing fields: {missing}")


# ---------------------------------------------------------------------------
# Type / nullability / enum contract (#1403)
#
# The tests above only check that keys are present. A payload with the right
# keys but a wrong type, an unexpected null, or an enum value the model
# doesn't declare would still pass them. The table-driven spec below closes
# that gap for Board, Card, and User (and their nested objects), reusing the
# same "serializer vs. a declared contract" technique as
# test_ts_serializer_drift.py rather than inventing a parallel one: enum
# values are read off the model's `choices` (never hand-copied), and
# representative fixtures exercise both the null and non-null branch of
# every cheaply-nullable field.
#
# Known, intentionally-deferred inconsistency (#1255): Card.column/swimlane
# are raw PKs while Card.assignee/created_by are nested BoardUser objects.
# Both shapes are asserted here as CURRENT behavior — this suite locks in
# what is, not what #1255 might someday make consistent.
# ---------------------------------------------------------------------------


class _FieldSpec:
    """One field's expected shape: Python type(s), nullability, and enum."""

    __slots__ = ("types", "nullable", "enum")

    def __init__(self, types, nullable=False, enum=None):
        self.types = types
        self.nullable = nullable
        self.enum = enum


def _assert_matches_spec(case, obj, spec_table, label):
    """Assert every field in `spec_table` is present on `obj` with the right
    type, nullability, and (if declared) enum membership.

    Compact alternative to one hand-written assert per field — the `spec`
    table is the single source of truth for a shape, and adding a field to it
    extends every call site that shares it.
    """
    for field, fs in spec_table.items():
        case.assertIn(field, obj, f"{label}.{field} is missing from the payload")
        value = obj[field]
        if value is None:
            case.assertTrue(
                fs.nullable,
                f"{label}.{field} is None, but the field spec says it is never null",
            )
            continue
        case.assertIsInstance(
            value,
            fs.types,
            f"{label}.{field} = {value!r} has type {type(value).__name__}, "
            f"expected one of {fs.types}",
        )
        if fs.enum is not None:
            case.assertIn(
                value,
                fs.enum,
                f"{label}.{field} = {value!r} is not one of the declared enum "
                f"values {sorted(fs.enum)}",
            )


# Every role BoardFull.members / current_user_role can carry: the four real
# BoardMembership roles plus the synthesized "site_admin" (#1137).
_EFFECTIVE_ROLE_ENUM = set(BoardMembership.Role.values) | {"site_admin"}

# "" is the documented "no avatar" sentinel (see frontend/src/types/index.ts)
# — avatar_url is blank=True, not null=True, so it is never nullable here.
_BOARD_USER_SPEC = {
    "id": _FieldSpec((int,)),
    "username": _FieldSpec((str,)),
    "display_name": _FieldSpec((str,)),
    "avatar_url": _FieldSpec((str,)),
}

_LABEL_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "color": _FieldSpec((str,)),
}

_CUSTOM_FIELD_VALUE_SPEC = {
    "field_definition": _FieldSpec((int,)),
    "value": _FieldSpec((str,)),
}

_EXTERNAL_REF_SPEC = {
    "provider": _FieldSpec((str,), enum=set(CardExternalRef.Provider.values)),
    "ref": _FieldSpec((str,)),
    "url": _FieldSpec((str,)),
}

_COLUMN_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "position": _FieldSpec((int,)),
    "color": _FieldSpec((str,)),
    "wip_limit": _FieldSpec((int,), nullable=True),
    "weight_limit": _FieldSpec((int,), nullable=True),
    "allow_card_creation": _FieldSpec((bool,)),
    "is_done": _FieldSpec((bool,)),
}

# SwimlaneAdminSerializer's shape — the requester in these tests is always an
# admin/owner, so BoardFullSerializer.get_swimlanes() always picks it over
# the member/viewer-facing SwimlaneSerializer (which omits contact_email and
# notes; not exercised here, see the module docstring for scope).
_SWIMLANE_ADMIN_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "contact_email": _FieldSpec((str,)),
    "notes": _FieldSpec((str,)),
    "position": _FieldSpec((int,)),
    "color": _FieldSpec((str,)),
    "is_collapsed": _FieldSpec((bool,)),
    "created_at": _FieldSpec((str,)),
    "custom_field_values": _FieldSpec((list,)),
}

_CARD_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "column": _FieldSpec((int,)),
    "swimlane": _FieldSpec((int,)),
    "title": _FieldSpec((str,)),
    "description": _FieldSpec((str,)),
    "priority": _FieldSpec((str,), enum=set(Card.Priority.values)),
    "assignee": _FieldSpec((dict,), nullable=True),
    "labels": _FieldSpec((list,)),
    "due_date": _FieldSpec((str,), nullable=True),
    "weight": _FieldSpec((int,)),
    "position": _FieldSpec((int,)),
    "created_by": _FieldSpec((dict,), nullable=True),
    "created_at": _FieldSpec((str,)),
    "updated_at": _FieldSpec((str,)),
    "last_moved_at": _FieldSpec((str,), nullable=True),
    "attachment_count": _FieldSpec((int,)),
    "checklist_total": _FieldSpec((int,)),
    "checklist_done": _FieldSpec((int,)),
    "is_stale": _FieldSpec((bool,)),
    "archived_at": _FieldSpec((str,), nullable=True),
    "version": _FieldSpec((int,)),
    "custom_field_values": _FieldSpec((list,)),
    "blocker_count": _FieldSpec((int,)),
    "external_ref": _FieldSpec((dict,), nullable=True),
}

_CUSTOM_FIELD_DEFINITION_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "field_type": _FieldSpec((str,), enum=set(CustomFieldDefinition.FieldType.values)),
    "choices": _FieldSpec((list,)),
    # Maps choice text -> a CHOICE_COLOR_KEYS palette key (#1391). A dict, not
    # a list — never confuse with `choices` above. Always present on read
    # (required=False on ChoiceColorsField only affects write); checked
    # against the `list`/`dict` distinction below, with per-value palette-key
    # membership asserted explicitly in the test body.
    "choice_colors": _FieldSpec((dict,)),
    "position": _FieldSpec((int,)),
    "show_on_card": _FieldSpec((bool,)),
    "is_required": _FieldSpec((bool,)),
    "help_text": _FieldSpec((str,)),
    "number_prefix": _FieldSpec((str,)),
    "number_suffix": _FieldSpec((str,)),
    "number_decimals": _FieldSpec((int,), nullable=True),
    "created_at": _FieldSpec((str,)),
}

# Row-field (swimlane custom field) equivalents of the two specs above.
# Mirrors CustomFieldDefinitionSerializer field-for-field except show_on_row
# (not show_on_card) and the added is_admin_only gate — see
# SwimlaneCustomFieldDefinitionSerializer's docstring.
_SWIMLANE_CUSTOM_FIELD_DEFINITION_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "field_type": _FieldSpec((str,), enum=set(CustomFieldDefinition.FieldType.values)),
    "choices": _FieldSpec((list,)),
    "choice_colors": _FieldSpec((dict,)),
    "position": _FieldSpec((int,)),
    "show_on_row": _FieldSpec((bool,)),
    "is_admin_only": _FieldSpec((bool,)),
    "is_required": _FieldSpec((bool,)),
    "help_text": _FieldSpec((str,)),
    "number_prefix": _FieldSpec((str,)),
    "number_suffix": _FieldSpec((str,)),
    "number_decimals": _FieldSpec((int,), nullable=True),
    "created_at": _FieldSpec((str,)),
}

_SWIMLANE_CUSTOM_FIELD_VALUE_SPEC = {
    "field_definition": _FieldSpec((int,)),
    "value": _FieldSpec((str,)),
}

# `id` is null for a row with no BoardMembership on this board (group-
# inherited, board owner, or site admin) — see EffectiveBoardMemberSerializer.
_EFFECTIVE_MEMBER_SPEC = {
    "id": _FieldSpec((int,), nullable=True),
    "user": _FieldSpec((dict,)),
    "role": _FieldSpec((str,), enum=_EFFECTIVE_ROLE_ENUM),
    "joined_at": _FieldSpec((str,)),
}

# export_min_role / card_density are plain CharFields with no model
# `.choices` (see Board.export_min_role / Board.card_density docstrings) —
# the valid-value sets below are read off BoardSerializer.validate_export_min_role
# / .validate_card_density, the only place that enforces them. There is no
# TextChoices to pull these from without hand-copying, so the copy lives here,
# pointed at the validators that are the actual source of truth, rather than
# silently accepting any string (the "right key, wrong value" gap this issue
# exists to close).
_EXPORT_MIN_ROLE_ENUM = {"viewer", "collaborator", "member", "admin"}
_CARD_DENSITY_ENUM = {"comfortable", "standard", "dense"}

_BOARD_FULL_SPEC = {
    "id": _FieldSpec((int,)),
    "uid": _FieldSpec((str,)),
    "name": _FieldSpec((str,)),
    "description": _FieldSpec((str,)),
    "owner": _FieldSpec((dict,)),
    "group": _FieldSpec((int,), nullable=True),
    "group_name": _FieldSpec((str,), nullable=True),
    # Null unless ?expand=group is requested — the key is always present, per
    # BoardFullSerializer.get_group_detail's docstring. Not requested by any
    # fixture here, so only the null branch is exercised.
    "group_detail": _FieldSpec((dict,), nullable=True),
    "columns": _FieldSpec((list,)),
    "swimlanes": _FieldSpec((list,)),
    "cards": _FieldSpec((list,)),
    "labels": _FieldSpec((list,)),
    "members": _FieldSpec((list,)),
    "custom_field_definitions": _FieldSpec((list,)),
    "swimlane_custom_field_definitions": _FieldSpec((list,)),
    "staleness_threshold_days": _FieldSpec((int,)),
    "stale_warning_pct": _FieldSpec((int,)),
    "allowed_priorities": _FieldSpec((list,)),
    "enforce_wip_limits": _FieldSpec((bool,)),
    "enforce_wip_hard": _FieldSpec((bool,)),
    "enforce_weight_limits": _FieldSpec((bool,)),
    "show_wip_at_limit": _FieldSpec((bool,)),
    "export_min_role": _FieldSpec((str,), enum=_EXPORT_MIN_ROLE_ENUM),
    "card_density": _FieldSpec((str,), enum=_CARD_DENSITY_ENUM),
    "created_at": _FieldSpec((str,)),
    "updated_at": _FieldSpec((str,)),
    "current_user_role": _FieldSpec((str,), nullable=True, enum=_EFFECTIVE_ROLE_ENUM),
    "is_starred": _FieldSpec((bool,)),
    "share_token": _FieldSpec((str,), nullable=True),
    "share_token_expires_at": _FieldSpec((str,), nullable=True),
    "capabilities": _FieldSpec((dict,)),
    "archived_card_count": _FieldSpec((int,)),
}


class BoardFullTypeContractTests(TestCase):
    """Type/nullability/enum assertions for GET /boards/{id}/full/.

    Fixtures deliberately populate one "full" card and one "empty" card so
    every cheaply-nullable field (assignee, due_date, created_by,
    external_ref, custom field values, last_moved_at) is exercised in both
    its null and non-null branch, and one real member plus one
    can_access_all_content user not on the board so EffectiveBoardMember.id
    is exercised both non-null and null.
    """

    def setUp(self):
        self.owner = User.objects.create_user(username="owner1403", password="pass")
        self.site_admin = User.objects.create_user(
            username="siteadmin1403", password="pass", can_access_all_content=True
        )
        self.board = Board.objects.create(name="Type Contract Board", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        # Admin gets to see the share token/expiry fields non-null below.
        self.board.share_token = uuid.uuid4()
        self.board.share_token_expires_at = timezone.now() + datetime.timedelta(days=7)
        self.board.save()

        self.column_with_limits = Column.objects.create(
            board=self.board, name="Backlog", position=0, wip_limit=5, weight_limit=10,
        )
        self.column_without_limits = Column.objects.create(
            board=self.board, name="Done", position=1, is_done=True,
        )
        self.swimlane = Swimlane.objects.create(board=self.board, name="General", position=0)
        self.label = Label.objects.create(board=self.board, name="bug", color="#FF0000")
        self.custom_field = CustomFieldDefinition.objects.create(
            board=self.board, name="Points", field_type=CustomFieldDefinition.FieldType.NUMBER,
        )
        self.swimlane_custom_field = SwimlaneCustomFieldDefinition.objects.create(
            board=self.board, name="Tier", field_type=CustomFieldDefinition.FieldType.NUMBER,
        )
        SwimlaneCustomFieldValue.objects.create(
            swimlane=self.swimlane, field_definition=self.swimlane_custom_field, value="7",
        )

        self.card_full = Card.objects.create(
            board=self.board,
            column=self.column_with_limits,
            swimlane=self.swimlane,
            title="Full card",
            priority=Card.Priority.URGENT,
            assignee=self.owner,
            created_by=self.owner,
            due_date=datetime.date(2026, 1, 1),
            weight=3,
        )
        self.card_full.labels.add(self.label)
        CustomFieldValue.objects.create(card=self.card_full, field_definition=self.custom_field, value="42")
        CardExternalRef.objects.create(
            card=self.card_full, provider=CardExternalRef.Provider.GITLAB,
            ref="group/proj!1", url="https://gitlab.example.com/group/proj/-/merge_requests/1",
        )
        CardMovement.objects.create(
            card=self.card_full, to_column=self.column_with_limits, moved_by=self.owner,
        )

        self.card_empty = Card.objects.create(
            board=self.board,
            column=self.column_without_limits,
            swimlane=self.swimlane,
            title="Empty card",
            priority=Card.Priority.LOW,
            assignee=None,
            created_by=None,
            due_date=None,
        )

        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def _get_full(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return r.json()

    def test_board_full_top_level_type_contract(self):
        body = self._get_full()
        _assert_matches_spec(self, body, _BOARD_FULL_SPEC, "BoardFull")
        # share_token/share_token_expires_at are admin-only and non-null here
        # (set in setUp) — exercise the non-null branch explicitly; the null
        # branch (sharing disabled) is already covered by
        # BoardFullSerializerContractTests above, which never sets a token.
        self.assertIsInstance(body["share_token"], str)
        self.assertIsInstance(body["share_token_expires_at"], str)

    def test_board_full_owner_type_contract(self):
        body = self._get_full()
        _assert_matches_spec(self, body["owner"], _BOARD_USER_SPEC, "BoardFull.owner")

    def test_board_full_columns_type_contract_exercises_nullable_limits(self):
        body = self._get_full()
        by_name = {c["name"]: c for c in body["columns"]}
        for column in body["columns"]:
            _assert_matches_spec(self, column, _COLUMN_SPEC, f"Column[{column['name']}]")
        # wip_limit/weight_limit are null=True, blank=True — assert both branches.
        self.assertIsNotNone(by_name["Backlog"]["wip_limit"])
        self.assertIsNotNone(by_name["Backlog"]["weight_limit"])
        self.assertIsNone(by_name["Done"]["wip_limit"])
        self.assertIsNone(by_name["Done"]["weight_limit"])

    def test_board_full_swimlanes_type_contract(self):
        body = self._get_full()
        for swimlane in body["swimlanes"]:
            _assert_matches_spec(self, swimlane, _SWIMLANE_ADMIN_SPEC, f"Swimlane[{swimlane['name']}]")
            for value in swimlane["custom_field_values"]:
                _assert_matches_spec(
                    self, value, _SWIMLANE_CUSTOM_FIELD_VALUE_SPEC,
                    f"Swimlane[{swimlane['name']}].custom_field_values[]",
                )
        # The row-field value set in setUp -> at least one non-empty list, so
        # the nested check above actually ran against a real row, not just an
        # empty list.
        self.assertTrue(any(s["custom_field_values"] for s in body["swimlanes"]))

    def _assert_choice_colors_values_valid(self, choice_colors, label):
        """Every value in a `choice_colors` dict must be a real palette key.

        Tightens the bare `dict` type check in the spec table: keys are
        free-text choice strings (nothing to validate against), but values
        are drawn from the closed CHOICE_COLOR_KEYS palette (#1391) — a
        drifted or stale color key would otherwise pass as "it's a dict".
        """
        for choice_text, color_key in choice_colors.items():
            self.assertIsInstance(color_key, str, f"{label}[{choice_text!r}] is not a string")
            self.assertIn(
                color_key, CHOICE_COLOR_KEYS,
                f"{label}[{choice_text!r}] = {color_key!r} is not one of CHOICE_COLOR_KEYS",
            )

    def test_board_full_custom_field_definitions_type_contract(self):
        body = self._get_full()
        self.assertEqual(len(body["custom_field_definitions"]), 1)
        for defn in body["custom_field_definitions"]:
            _assert_matches_spec(
                self, defn, _CUSTOM_FIELD_DEFINITION_SPEC, f"CustomFieldDefinition[{defn['name']}]"
            )
            self._assert_choice_colors_values_valid(
                defn["choice_colors"], f"CustomFieldDefinition[{defn['name']}].choice_colors"
            )

    def test_board_full_swimlane_custom_field_definitions_type_contract(self):
        body = self._get_full()
        self.assertEqual(len(body["swimlane_custom_field_definitions"]), 1)
        for defn in body["swimlane_custom_field_definitions"]:
            _assert_matches_spec(
                self, defn, _SWIMLANE_CUSTOM_FIELD_DEFINITION_SPEC,
                f"SwimlaneCustomFieldDefinition[{defn['name']}]",
            )
            self._assert_choice_colors_values_valid(
                defn["choice_colors"], f"SwimlaneCustomFieldDefinition[{defn['name']}].choice_colors"
            )

    def test_board_full_members_type_contract_exercises_nullable_id(self):
        body = self._get_full()
        by_role = {}
        for member in body["members"]:
            _assert_matches_spec(self, member, _EFFECTIVE_MEMBER_SPEC, f"EffectiveBoardMember[{member['role']}]")
            _assert_matches_spec(self, member["user"], _BOARD_USER_SPEC, f"EffectiveBoardMember[{member['role']}].user")
            by_role[member["role"]] = member
        # A real BoardMembership row (the owner/admin) -> id non-null.
        self.assertIsNotNone(by_role["admin"]["id"])
        # A can_access_all_content user with no membership row -> id null (#1137).
        self.assertIsNone(by_role["site_admin"]["id"])
        # The requester is an admin, so both visibility-gated flags are present
        # on every row (#920/#1290) — type-checked explicitly since the spec
        # table above does not mark them required.
        for member in body["members"]:
            self.assertIsInstance(member["is_moderator"], bool)
            self.assertIsInstance(member["is_site_admin"], bool)

    def test_board_full_cards_type_contract_exercises_nullable_fields(self):
        body = self._get_full()
        by_title = {c["title"]: c for c in body["cards"]}
        for card in body["cards"]:
            _assert_matches_spec(self, card, _CARD_SPEC, f"Card[{card['title']}]")

        full = by_title["Full card"]
        empty = by_title["Empty card"]

        # Non-null branch: assignee, created_by, due_date, external_ref,
        # custom_field_values, last_moved_at, labels.
        _assert_matches_spec(self, full["assignee"], _BOARD_USER_SPEC, "Card[Full card].assignee")
        _assert_matches_spec(self, full["created_by"], _BOARD_USER_SPEC, "Card[Full card].created_by")
        self.assertIsNotNone(full["due_date"])
        self.assertIsNotNone(full["last_moved_at"])
        _assert_matches_spec(self, full["external_ref"], _EXTERNAL_REF_SPEC, "Card[Full card].external_ref")
        self.assertEqual(len(full["labels"]), 1)
        _assert_matches_spec(self, full["labels"][0], _LABEL_SPEC, "Card[Full card].labels[0]")
        self.assertEqual(len(full["custom_field_values"]), 1)
        _assert_matches_spec(
            self, full["custom_field_values"][0], _CUSTOM_FIELD_VALUE_SPEC, "Card[Full card].custom_field_values[0]"
        )

        # Null branch: assignee, created_by, due_date, external_ref,
        # last_moved_at (never moved), empty labels/custom_field_values lists.
        self.assertIsNone(empty["assignee"])
        self.assertIsNone(empty["created_by"])
        self.assertIsNone(empty["due_date"])
        self.assertIsNone(empty["last_moved_at"])
        self.assertIsNone(empty["external_ref"])
        self.assertEqual(empty["labels"], [])
        self.assertEqual(empty["custom_field_values"], [])


class BoardFullGroupFieldTypeContractTests(TestCase):
    """`group`/`group_name` non-null branch — kept separate from
    BoardFullTypeContractTests because it needs its own grouped board;
    the null branch is already exercised there."""

    def setUp(self):
        self.owner = User.objects.create_user(username="groupowner1403", password="pass")
        self.group = Group.objects.create(name="Engineering", owner=self.owner)
        self.board = Board.objects.create(
            name="Grouped Board", owner=self.owner, group=self.group
        )
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_group_fields_are_non_null_with_correct_types(self):
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = r.json()
        self.assertIsInstance(body["group"], int)
        self.assertEqual(body["group"], self.group.id)
        self.assertIsInstance(body["group_name"], str)
        self.assertEqual(body["group_name"], "Engineering")


# ---------------------------------------------------------------------------
# User (CurrentUserSerializer, GET /api/v1/auth/me/) — the TS `User`
# interface pairs with both UserSerializer and CurrentUserSerializer (see
# test_ts_serializer_drift.py's _DRIFT_PAIRS); CurrentUserSerializer is the
# strict superset actually returned by this endpoint.
# ---------------------------------------------------------------------------

_USER_SPEC = {
    "id": _FieldSpec((int,)),
    "username": _FieldSpec((str,)),
    "email": _FieldSpec((str,)),
    "first_name": _FieldSpec((str,)),
    "last_name": _FieldSpec((str,)),
    "avatar_url": _FieldSpec((str,)),
    "display_name": _FieldSpec((str,)),
    "is_site_admin": _FieldSpec((bool,)),
    "can_access_all_content": _FieldSpec((bool,)),
    "must_change_password": _FieldSpec((bool,)),
    "must_change_username": _FieldSpec((bool,)),
    "has_usable_password": _FieldSpec((bool,)),
    "timezone": _FieldSpec((str,)),
    "date_format": _FieldSpec((str,)),
    "time_format": _FieldSpec((str,)),
    "number_locale": _FieldSpec((str,)),
    "notif_card_assigned": _FieldSpec((bool,)),
    "notif_mentioned": _FieldSpec((bool,)),
    "notif_due_soon": _FieldSpec((bool,)),
    "notif_card_moved": _FieldSpec((bool,)),
    "notif_comment_added": _FieldSpec((bool,)),
    "notif_board_invite": _FieldSpec((bool,)),
    "notif_stale": _FieldSpec((bool,)),
    "email_notif_card_assigned": _FieldSpec((bool,)),
    "email_notif_mentioned": _FieldSpec((bool,)),
    "email_notif_due_soon": _FieldSpec((bool,)),
    "email_notif_card_moved": _FieldSpec((bool,)),
    "email_notif_comment_added": _FieldSpec((bool,)),
    "close_editor_on_enter": _FieldSpec((bool,)),
    "has_completed_tour": _FieldSpec((bool,)),
    "theme": _FieldSpec((str,), enum=set(User.Theme.values)),
    "default_board_id": _FieldSpec((int,), nullable=True),
    "uploads_enabled": _FieldSpec((bool,)),
    "git_lens_enabled": _FieldSpec((bool,)),
    "maintenance_mode": _FieldSpec((bool,)),
    "maintenance_message": _FieldSpec((str,)),
    "demo_mode": _FieldSpec((bool,)),
    "demo_next_reset_at": _FieldSpec((str,), nullable=True),
    "pending_email": _FieldSpec((str,), nullable=True),
    "pending_connect_provider": _FieldSpec((str,), nullable=True),
    "pending_connect_identity": _FieldSpec((str,), nullable=True),
}


class CurrentUserTypeContractTests(TestCase):
    """Type/nullability/enum assertions for GET /api/v1/auth/me/.

    Two users exercise default_board_id's null/non-null branches: a plain
    user with no default board, and a member of a board who has set one.
    """

    def setUp(self):
        self.client = APIClient()

    def test_user_without_default_board_type_contract(self):
        user = User.objects.create_user(username="plainuser1403", password="pass")
        self.client.force_authenticate(user)
        r = self.client.get("/api/v1/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = r.json()
        _assert_matches_spec(self, body, _USER_SPEC, "User")
        self.assertIsNone(body["default_board_id"])

    def test_user_with_default_board_type_contract(self):
        user = User.objects.create_user(
            username="defaultboarduser1403", password="pass", theme=User.Theme.DARK
        )
        board = Board.objects.create(name="Default Board", owner=user)
        BoardMembership.objects.create(board=board, user=user, role=BoardMembership.Role.ADMIN)
        user.default_board = board
        user.save()
        self.client.force_authenticate(user)
        r = self.client.get("/api/v1/auth/me/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        body = r.json()
        _assert_matches_spec(self, body, _USER_SPEC, "User")
        self.assertEqual(body["default_board_id"], board.id)
        self.assertEqual(body["theme"], "dark")
