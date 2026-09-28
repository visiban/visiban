"""Pins the published schema annotations corrected by #1139.

Companion to ``test_board_schema_contract.py`` (#1123) and
``test_move_schema_contract.py`` (#1108), and a narrower thing than either: those
validate live *responses* against the document, which needs a database and a
request per shape. These assertions only need the document, because every defect
#1139 fixed was a field whose runtime value was always correct and whose
*description* was wrong — an un-hinted ``SerializerMethodField`` defaulting to
``string``, a ``JSONField`` published with no type at all, or a declared nested
field not inheriting its model's ``null=True``.

Why this exists when `scripts/check-serializer-ts-parity.py` already covers it:
that gate compares the schema against `frontend/src/types/index.ts`, so it only
notices a regression here while the TypeScript stays correct. Someone
"fixing" a reintroduced mismatch by editing the interface instead would leave the
gate green and the published contract wrong again. These tests name the intended
schema directly, with no second side to move.

``SimpleTestCase``: schema generation reads serializer and view classes only.
"""

from django.test import SimpleTestCase
from drf_spectacular.generators import SchemaGenerator

from boards.serializers import (
    CardActivitySerializer, CardAttachmentSerializer, PublicCardSerializer,
)
from boards.views.notifications import NotificationSerializer


class SerializerSchemaAnnotationTests(SimpleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.components = SchemaGenerator().get_schema(request=None, public=True)["components"]["schemas"]

    def _prop(self, component, field):
        self.assertIn(component, self.components, f"no `{component}` component in the schema")
        props = self.components[component].get("properties", {})
        self.assertIn(field, props, f"`{component}` has no `{field}` property")
        return props[field]

    def _deref(self, node):
        """Follow a `$ref` into `components.schemas`.

        drf-spectacular hoists an inline enum into a shared component whenever two
        fields declare the same choice set, so `items` here is a `$ref` rather
        than the literal dict the serializer passed to `@extend_schema_field`.
        """
        ref = node.get("$ref")
        if ref is None:
            return node
        prefix = "#/components/schemas/"
        self.assertTrue(ref.startswith(prefix), f"unexpected $ref target: {ref}")
        name = ref[len(prefix):]
        self.assertIn(name, self.components, f"dangling $ref: {ref}")
        return self.components[name]

    # ── nullability on declared nested / traversing fields ────────────────
    # A declared field does not inherit `null=True` from the model the way an
    # auto-generated ModelSerializer field does, so each of these needs an
    # explicit `allow_null=True`. All three are read_only, so this is schema-only.

    def test_card_comment_author_is_nullable(self):
        """CardComment.author is a SET_NULL FK — a deleted author yields null."""
        self.assertTrue(
            self._prop("CardComment", "author").get("nullable"),
            "CardComment.author must be nullable: the FK is SET_NULL with null=True",
        )

    def test_card_checklist_created_by_is_nullable(self):
        """Rows predating the ownership migration carry created_by=null outright."""
        self.assertTrue(
            self._prop("CardChecklist", "created_by").get("nullable"),
            "CardChecklist.created_by must be nullable: SET_NULL, and pre-migration rows are null",
        )

    def test_card_created_by_is_nullable(self):
        """Card.created_by is a SET_NULL FK — a deleted creator yields null (#1138)."""
        self.assertTrue(
            self._prop("Card", "created_by").get("nullable"),
            "Card.created_by must be nullable: the FK is SET_NULL with null=True",
        )

    def test_card_query_assignee_is_nullable(self):
        """CardQuery.assignee (GET /api/v1/cards/, #1112): unassigned cards are
        the common case, same gap CardSerializer.assignee had before #1108 (#1172)."""
        self.assertTrue(
            self._prop("CardQuery", "assignee").get("nullable"),
            "CardQuery.assignee must be nullable: Card.assignee is a nullable FK",
        )

    def test_card_query_created_by_is_nullable(self):
        """CardQuery.created_by is a SET_NULL FK, same gap CardSerializer.created_by
        had before #1138 (#1172)."""
        self.assertTrue(
            self._prop("CardQuery", "created_by").get("nullable"),
            "CardQuery.created_by must be nullable: the FK is SET_NULL with null=True",
        )

    def test_board_export_log_actor_is_nullable(self):
        """BoardExportLog.actor is a SET_NULL FK — an export whose actor has
        since been deleted yields null (#1192)."""
        self.assertTrue(
            self._prop("BoardExportLog", "actor").get("nullable"),
            "BoardExportLog.actor must be nullable: the FK is SET_NULL with null=True",
        )

    def test_group_brief_parent_name_is_nullable(self):
        """A root group has no parent, so `source="parent.name"` resolves to None."""
        self.assertTrue(
            self._prop("GroupBrief", "parent_name").get("nullable"),
            "GroupBrief.parent_name must be nullable: a root group has no parent",
        )

    # ── method fields and JSONFields need their shape spelled out ─────────

    def test_group_brief_ancestors_is_a_list_of_id_name_objects(self):
        """An un-hinted SerializerMethodField is published as `string` (#1135's pattern)."""
        prop = self._prop("GroupBrief", "ancestors")
        self.assertEqual(prop.get("type"), "array")
        item_props = prop.get("items", {}).get("properties", {})
        self.assertEqual(item_props.get("id", {}).get("type"), "integer")
        self.assertEqual(item_props.get("name", {}).get("type"), "string")

    def test_custom_field_definition_choices_is_a_list_of_strings(self):
        """`choices` maps a model JSONField, which drf-spectacular leaves untyped."""
        for component in ("CustomFieldDefinition", "SwimlaneCustomFieldDefinition"):
            with self.subTest(component=component):
                prop = self._prop(component, "choices")
                self.assertEqual(prop.get("type"), "array")
                self.assertEqual(prop.get("items", {}).get("type"), "string")

    def test_group_allowed_priorities_publishes_its_slugs(self):
        """Parity with Board.allowed_priorities, which has published its shape since #1079."""
        prop = self._prop("Group", "allowed_priorities")
        self.assertEqual(prop.get("type"), "array")
        items = self._deref(prop.get("items", {}))
        self.assertEqual(items.get("type"), "string")
        self.assertEqual(
            set(items.get("enum", [])),
            {"low", "medium", "high", "urgent"},
            "must match GroupSerializer.validate_allowed_priorities",
        )

    def test_group_and_board_share_one_priority_enum(self):
        """The two must not drift into separate, silently different enums.

        They currently resolve to the same hoisted component precisely because the
        slug lists are identical; if one gains a priority the other lacks, this
        fails while both fields still look individually well-formed.
        """
        group_items = self._prop("Group", "allowed_priorities").get("items", {})
        board_items = self._prop("Board", "allowed_priorities").get("items", {})
        self.assertEqual(
            set(self._deref(group_items).get("enum", [])),
            set(self._deref(board_items).get("enum", [])),
        )

    # ── a field the gate reports as correct, kept honest here too ─────────

    # ── #1209: the 4 sites #1192 could only assert on the field instance for,
    # now that CardViewSet.activities/.attachments, NotificationListView, and
    # ShareBoardView all publish a real response schema. ─────────────────────

    def test_card_activity_actor_is_nullable(self):
        """CardActivity.actor is a SET_NULL FK — a deleted actor yields null."""
        self.assertTrue(
            self._prop("CardActivity", "actor").get("nullable"),
            "CardActivity.actor must be nullable: the FK is SET_NULL with null=True",
        )

    def test_card_attachment_uploaded_by_is_nullable(self):
        """CardAttachment.uploaded_by is a SET_NULL FK — a deleted uploader yields null."""
        self.assertTrue(
            self._prop("CardAttachment", "uploaded_by").get("nullable"),
            "CardAttachment.uploaded_by must be nullable: the FK is SET_NULL with null=True",
        )

    def test_notification_actor_is_nullable(self):
        """Notification.actor is a SET_NULL FK — system-generated notifications have none."""
        self.assertTrue(
            self._prop("Notification", "actor").get("nullable"),
            "Notification.actor must be nullable: the FK is SET_NULL with null=True",
        )

    def test_public_card_assignee_is_nullable(self):
        """PublicCard.assignee (public share-link view): unassigned cards are the common case."""
        self.assertTrue(
            self._prop("PublicCard", "assignee").get("nullable"),
            "PublicCard.assignee must be nullable: Card.assignee is a SET_NULL FK with null=True",
        )

    def test_card_movement_denormalized_names_are_not_nullable(self):
        """The mirror image: these are `null=False, blank=True` CharFields.

        They return "" and never null, which is why the TypeScript interface
        declares them `string`. Asserted so that "fixing" a future nullability
        finding by adding `allow_null=True` here — the wrong direction — fails.
        """
        for field in ("from_column_name", "to_column_name",
                      "from_swimlane_name", "to_swimlane_name"):
            with self.subTest(field=field):
                prop = self._prop("CardMovement", field)
                self.assertEqual(prop.get("type"), "string")
                self.assertFalse(
                    prop.get("nullable", False),
                    f"CardMovement.{field} is NOT NULL with a '' default; it never returns null",
                )


class UnpublishedSerializerFieldNullabilityTests(SimpleTestCase):
    """#1192 (superseded by #1209): `allow_null=True` on the 4 sites (of the issue's
    original 4, plus a 5th found during the sweep) whose serializers `drf-spectacular`
    did not, at the time, emit as a named schema component at all.

    `CardActivitySerializer`, `CardAttachmentSerializer`, `PublicCardSerializer`, and
    `NotificationSerializer` back endpoints (`CardViewSet.activities`/`.attachments`,
    the public share-link view, and the bare-`APIView` notifications list) that, before
    #1209, had no `serializer_class`/`@extend_schema` response wiring, so
    `SchemaGenerator` either guessed the wrong component entirely (`Card`, for the two
    `@action` endpoints) or published no response body at all. #1209 wired all four
    (`CardActivity`, `CardAttachment`, `Notification`, `PublicCard` are now real
    components), so `SerializerSchemaAnnotationTests` above now has the equivalent
    schema-level assertions for all four fields this class covers.

    Kept as a supplement rather than deleted: these assert directly on the field
    instance, which is what `allow_null=True` actually sets and is exactly what a
    revert (e.g. a bad merge-conflict resolution, or a future endpoint refactor that
    drops the response wiring again) would undo, independent of whatever the schema
    currently reflects.
    """

    def test_card_activity_actor_field_allows_null(self):
        self.assertTrue(
            CardActivitySerializer().fields["actor"].allow_null,
            "CardActivitySerializer.actor must allow_null: CardActivity.actor is SET_NULL, null=True",
        )

    def test_card_attachment_uploaded_by_field_allows_null(self):
        self.assertTrue(
            CardAttachmentSerializer().fields["uploaded_by"].allow_null,
            "CardAttachmentSerializer.uploaded_by must allow_null: CardAttachment.uploaded_by is SET_NULL, null=True",
        )

    def test_public_card_assignee_field_allows_null(self):
        self.assertTrue(
            PublicCardSerializer().fields["assignee"].allow_null,
            "PublicCardSerializer.assignee must allow_null: Card.assignee is SET_NULL, null=True",
        )

    def test_notification_actor_field_allows_null(self):
        self.assertTrue(
            NotificationSerializer().fields["actor"].allow_null,
            "NotificationSerializer.actor must allow_null: Notification.actor is SET_NULL, null=True",
        )
