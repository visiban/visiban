import datetime
import decimal

from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import models as _db_models
from django.db.models import Prefetch
from django.utils.dateparse import parse_date
from django.utils import timezone
from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers

from accounts.models import User
from accounts.serializers import BoardUserSerializer
# Module-level (not lazy) so ``@extend_schema_field`` can reference it at class-body
# evaluation time — see BoardSerializer.get_group_detail. No import cycle: neither
# groups.serializers nor groups.models imports anything from boards (groups.views
# does, but lazily, inside its methods).
from groups.serializers import GroupBriefSerializer

from .permissions import MODERATOR_BEARING_EVENTS, ROLES_WITH_MODERATOR_VISIBILITY

from .models import (
    Board, BoardEvent, BoardExportLog, BoardMembership, BoardTemplate, Column, Swimlane, Label, Card,
    CardMovement, CardComment, CardActivity, CardAttachment, CardChecklist, CardRelation,
    CustomFieldDefinition, CustomFieldValue, SavedFilter,
    SwimlaneCustomFieldDefinition, SwimlaneCustomFieldValue,
)


class BoardTemplateSerializer(serializers.ModelSerializer):
    class Meta:
        model = BoardTemplate
        fields = [
            "id", "name", "slug", "description", "icon",
            "lane_label", "lane_placeholder", "columns_json",
            "sort_order",
        ]


class BoardMembershipSerializer(serializers.ModelSerializer):
    user = BoardUserSerializer(read_only=True)

    class Meta:
        model = BoardMembership
        fields = ["id", "user", "role", "is_moderator", "joined_at"]

    def to_representation(self, instance):
        """Strip ``is_moderator`` from the response when the requesting user is
        not an admin or site_admin (#920).

        Moderator status is an internal trust tier — admins promote a member to
        moderator so they can edit/delete other members' content.  Exposing the
        flag to viewers and members reveals organisational signal that should
        not be visible at those roles.  Admin reads (members panel, member POST
        response) keep the field.

        The broadcast surface (``member.added`` / ``member.updated`` events)
        does not filter at the serializer layer because it has no
        per-subscriber context; instead ``BoardConsumer.board_event`` strips
        the field per-recipient based on the connection's resolved role
        (#978).

        The serializer reads the role from ``context["role"]`` (set by the
        view) or falls back to ``get_board_role`` when a request and board are
        available in context.  In contexts where the role cannot be resolved
        (e.g. broadcast payloads built without a request) the field is kept —
        the consumer-layer filter is the second line of defense.
        """
        data = super().to_representation(instance)
        from .permissions import get_board_role, SITE_ADMIN
        role = self.context.get("role")
        request = self.context.get("request")
        board = self.context.get("board")
        if role is None and request and board and request.user.is_authenticated:
            role = get_board_role(request.user, board)
        if role is not None and role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            data.pop("is_moderator", None)
        return data



class BoardEventSerializer(serializers.ModelSerializer):
    """One row of a board's change feed (#1114).

    ``data`` is returned verbatim — it is the same object the WebSocket frame
    carried, which is the whole point of the feed: a consumer that reconnects
    replays rows through the identical handler it uses for live frames, with no
    second representation to reconcile.

    ``actor_id`` is a plain integer rather than a nested user object, and
    deliberately so on two counts. It keeps ``BoardEvent`` free of a ForeignKey
    (see that model's docstring on why an append-only table must not cascade),
    and it makes an N+1 on the actor structurally impossible: there is no
    relation to walk, so serializing a 500-row page costs exactly the one query
    that fetched it. Consumers that need a username resolve it once against the
    members list they already hold.
    """

    class Meta:
        model = BoardEvent
        fields = ["id", "event", "data", "actor_id", "created_at"]
        read_only_fields = fields

    def to_representation(self, instance):
        """Apply the same per-recipient stripping the WebSocket consumer applies.

        ``member.added`` / ``member.updated`` rows are stored with
        ``is_moderator`` present, because what is stored is the broadcast payload
        verbatim and the writer has no reader to filter for. The gate therefore
        has to run on read, per reader — exactly as ``BoardConsumer.board_event``
        runs it per subscriber (#978). Without this, the feed would be a way to
        read back a field the socket refuses to send you.

        The reader's role arrives as ``context["role"]``, resolved by the view's
        access check. It **fails closed**: an absent role strips the field rather
        than keeping it. That is the opposite of
        ``BoardMembershipSerializer.to_representation``, which keeps the field
        when the role is unknown — it can afford to, because the consumer layer
        is its second line of defense. The feed has no second line, so an
        unknown role here must mean "show less", never "show more".
        """
        data = super().to_representation(instance)
        if instance.event in MODERATOR_BEARING_EVENTS:
            role = self.context.get("role")
            if role not in ROLES_WITH_MODERATOR_VISIBILITY:
                payload = data.get("data")
                if isinstance(payload, dict) and "is_moderator" in payload:
                    data["data"] = {k: v for k, v in payload.items() if k != "is_moderator"}
        return data


class BoardExportLogSerializer(serializers.ModelSerializer):
    """Read-only payload for the export-history endpoint (#842).

    Exposes the audit row's frozen role string as ``actor_role_label`` rather
    than the model column name ``role_at_export`` (#980).  The audit field
    accepts a 6-value union (viewer | collaborator | member | admin | owner |
    site_admin); ``Board.export_min_role`` accepts only 4.  Surfacing the audit
    string under a distinct API name prevents callers from conflating the two
    enums.
    """

    actor = BoardUserSerializer(read_only=True)
    actor_role_label = serializers.CharField(source="role_at_export", read_only=True)

    class Meta:
        model = BoardExportLog
        fields = ["id", "actor", "actor_role_label", "export_format", "row_count", "created_at"]
        read_only_fields = fields


class ColumnSerializer(serializers.ModelSerializer):
    class Meta:
        model = Column
        fields = ["id", "uid", "name", "position", "color", "wip_limit", "weight_limit", "allow_card_creation", "is_done"]
        read_only_fields = ["uid"]


@extend_schema_field({
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "field_definition": {
                "type": "integer",
                "description": (
                    "SwimlaneCustomFieldDefinition id, scoped to the swimlane's board."
                ),
            },
            "value": {
                "type": "string",
                "description": (
                    "Value as a string; empty string clears the field. Numbers as "
                    "written, dates as YYYY-MM-DD, checkboxes as 'true'/'false'."
                ),
            },
        },
        "required": ["field_definition", "value"],
    },
})
class SwimlaneCustomFieldValuesField(serializers.Field):
    """The ``custom_field_values`` field on the swimlane serializers (#1140).

    The row-level twin of :class:`CustomFieldValuesField`; see that class for
    why one round-trippable field is used rather than a read/write pair, and
    why ``extend_schema_field`` is load-bearing rather than decorative.

    Two things differ, both consequences of the admin-only visibility rule:

    * **Reads are filtered in Python, never by a queryset call.** The read path
      is fed by a ``Prefetch``; a ``.filter()`` here would escape that cache and
      reintroduce an N+1 across every swimlane on the board. ``admin_only``
      comes from the serializer that owns this field, so the public serializer
      shows only ``is_admin_only=False`` values and the admin one shows all.
    * **Writes are never filtered.** Only board admins reach a swimlane write
      at all (``SwimlaneViewSet.perform_update`` raises ``PermissionDenied``
      first), so an admin writing an admin-only field is the expected case, not
      an escalation.
    """

    default_error_messages = {
        "not_a_list": (
            "Expected a list of objects, each with a field_definition and a value."
        ),
        "not_an_object": (
            "Each entry must be an object with a field_definition and a value."
        ),
        "no_board": (
            "Swimlane custom field values cannot be resolved without board context."
        ),
    }

    def __init__(self, *, admin_only=False, **kwargs):
        kwargs.setdefault("required", False)
        #: When False, ``is_admin_only`` definitions are omitted from reads.
        self.admin_only = admin_only
        super().__init__(**kwargs)

    def get_attribute(self, instance):
        # Return the instance itself, not the related manager: to_representation
        # needs the swimlane to reach the prefetched related manager by name.
        return instance

    def to_representation(self, swimlane):
        # .all() reads the prefetch cache populated by the read paths in
        # BoardFullSerializer/SwimlaneViewSet; .filter()/.order_by() here would
        # bypass it and issue one query per swimlane.
        rows = swimlane.custom_field_values.all()
        return [
            {"field_definition": row.field_definition_id, "value": row.value}
            for row in rows
            if self.admin_only or not row.field_definition.is_admin_only
        ]

    def to_internal_value(self, data):
        if not isinstance(data, list):
            self.fail("not_a_list")
        if len(data) > SwimlaneCustomFieldDefinition.MAX_PER_BOARD:
            # A board can never have more than MAX_PER_BOARD definitions, so a
            # longer list cannot be legitimate. Rejected on length before the
            # per-entry loop, same as the card field.
            raise serializers.ValidationError(
                f"At most {SwimlaneCustomFieldDefinition.MAX_PER_BOARD} swimlane "
                "custom field values can be set in one request."
            )
        board = self.context.get("board")
        if board is None:
            self.fail("no_board")

        wanted = {}
        for entry in data:
            if not isinstance(entry, dict) or "field_definition" not in entry:
                self.fail("not_an_object")
            try:
                definition_id = int(entry["field_definition"])
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    f"Invalid field_definition: {entry['field_definition']!r}."
                ) from None
            if definition_id in wanted:
                raise serializers.ValidationError(
                    f"Field {definition_id} appears more than once."
                )
            wanted[definition_id] = entry.get("value")

        if not wanted:
            return []

        # One board-scoped query for the whole submitted set. An id belonging to
        # another board is simply absent from the result, so it reports as
        # unknown rather than confirming it exists somewhere the caller cannot
        # see (IDOR).
        definitions = {
            definition.pk: definition
            for definition in SwimlaneCustomFieldDefinition.objects.filter(
                board=board, pk__in=wanted
            )
        }
        missing = sorted(set(wanted) - set(definitions))
        if missing:
            raise serializers.ValidationError(
                "Unknown swimlane custom field(s) for this board: "
                + ", ".join(str(pk) for pk in missing)
                + "."
            )

        pairs = []
        for definition_id, raw in wanted.items():
            definition = definitions[definition_id]
            # Resolved at call time: both helpers are defined further down this
            # module, alongside the card-level field they were written for.
            # _normalize_custom_field_value is shared outright — it reads only
            # field_type and choices_json, so it is duck-type safe. The
            # validator hooks are not: they run third-party code written
            # against the card definition, so row values get their own list.
            value = _normalize_custom_field_value(definition, raw)
            value = _run_custom_field_validator_hooks(
                definition, value, hook_name="SWIMLANE_CUSTOM_FIELD_VALIDATORS"
            )
            pairs.append((definition, value))
        return pairs


def _swimlane_custom_field_prefetch():
    """The one Prefetch every swimlane read path must apply (#1140).

    Defined once and imported rather than rewritten per call site, because
    getting it wrong is silent: the swimlane serializers read ``is_admin_only``
    off each value's *definition* to decide visibility, so a read path without
    ``select_related("field_definition")`` costs two extra queries per swimlane
    and still returns correct data. Nothing fails; the board just gets slower
    as rows are added.

    Ordering belongs here and not in ``SwimlaneCustomFieldValue.Meta.ordering``
    so only the read path pays for the join — the same trade ``_card_queryset``
    makes for card values.
    """
    return Prefetch(
        "custom_field_values",
        queryset=SwimlaneCustomFieldValue.objects.select_related(
            "field_definition"
        ).order_by("field_definition__position", "field_definition_id"),
    )


class SwimlaneSerializer(serializers.ModelSerializer):
    """Public swimlane representation — omits contact_email and notes.

    Viewer-role members have read access to the board but must not see PII or
    internal notes stored on swimlanes (customer records). Admin-role members and
    write operations use SwimlaneAdminSerializer which includes those fields.

    ``custom_field_values`` (#1140) reuses exactly this split rather than adding
    a second visibility rule: this serializer emits only values whose definition
    has ``is_admin_only=False``. Because every swimlane broadcast is built from
    this class — never the admin one — that filtering is also what keeps
    admin-only row values out of the WebSocket payload that reaches viewers.
    """

    custom_field_values = SwimlaneCustomFieldValuesField(read_only=True)

    class Meta:
        model = Swimlane
        fields = [
            "id", "uid", "name", "position", "color", "is_collapsed",
            "created_at", "custom_field_values",
        ]
        read_only_fields = ["uid"]


class SwimlaneAdminSerializer(SwimlaneSerializer):
    """Full swimlane representation including contact_email and notes.

    Used for admin/site_admin members only. Never served to viewer-role members,
    and never used to build a broadcast payload — see SwimlaneSerializer.

    ``custom_field_values`` is writable here and read-only on the public
    serializer: swimlane writes are admin-gated in the viewset, so this is the
    only class through which a value can be set.
    """

    custom_field_values = SwimlaneCustomFieldValuesField(admin_only=True, required=False)

    class Meta(SwimlaneSerializer.Meta):
        fields = [
            "id", "uid", "name", "contact_email", "notes", "position", "color",
            "is_collapsed", "created_at", "custom_field_values",
        ]


class PublicSwimlaneSerializer(SwimlaneSerializer):
    """Swimlane representation for anonymous share-link visitors (#1140).

    Drops ``custom_field_values`` entirely rather than relying on the
    ``is_admin_only`` filter that protects authenticated non-admins. The two
    audiences are not the same: a board member who is not an admin has been
    granted access to the board and may legitimately see a field its admin
    marked shareable, whereas a share-link visitor is unauthenticated and the
    board owner may not know who they are. The structural omission is the same
    mechanism ``PublicCardSerializer`` uses for card values — the field simply
    is not there, so no flag can be set wrong and expose it.
    """

    class Meta(SwimlaneSerializer.Meta):
        fields = ["id", "uid", "name", "position", "color", "is_collapsed", "created_at"]


class LabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Label
        fields = ["id", "uid", "name", "color"]
        read_only_fields = ["uid"]


# ---------------------------------------------------------------------------
# Custom fields (#371)
#
# Validation of every custom field value happens here, at the serializer
# boundary, and nowhere else: the model stores one untyped text column, and the
# service layer that writes it is handed values that are already legal. That
# split is the project rule ("validate at the boundary, not in views or
# models"), and it is what lets a value be typed at all.
# ---------------------------------------------------------------------------

def assert_definition_caps(
    board,
    *,
    instance=None,
    show_on_card=False,
    definition_model=CustomFieldDefinition,
    pin_attr="show_on_card",
    pin_surface="the card face",
    field_noun="custom fields",
):
    """Enforce the two per-board custom field caps, or raise ``ValidationError``.

    Neither cap is expressible as a database constraint — both are counts over
    a board's rows — so this is the single place that knows them. It is called
    from :class:`CustomFieldDefinitionSerializer.validate` (so a violation is a
    400 with a field-shaped body) **and** from the viewset inside its
    board-row-locked transaction (so two concurrent creates cannot both observe
    a count of 29 and land a 31st field). One rule, two call sites, no second
    copy to drift.

    ``instance`` excludes the row being updated from both counts, so re-saving
    an already-pinned field does not count itself as the third pin.

    The keyword-only ``definition_model`` / ``pin_attr`` / ``pin_surface`` /
    ``field_noun`` parameters default to the card-level model (#371) so the two
    original call sites are unchanged, and let the swimlane-level model (#1140)
    reuse the same counting and locking logic with its own caps and its own
    ``show_on_row`` pin column. The caps themselves are read off whichever model
    is passed, never hardcoded here.
    """
    siblings = definition_model.objects.filter(board=board)
    if instance is not None and instance.pk is not None:
        siblings = siblings.exclude(pk=instance.pk)
    if instance is None or instance.pk is None:
        if siblings.count() >= definition_model.MAX_PER_BOARD:
            raise serializers.ValidationError({
                "detail": (
                    f"A board may define at most "
                    f"{definition_model.MAX_PER_BOARD} {field_noun}."
                )
            })
    if show_on_card:
        pinned = siblings.filter(**{pin_attr: True}).count()
        if pinned >= definition_model.MAX_PINNED_PER_BOARD:
            raise serializers.ValidationError({
                pin_attr: (
                    f"At most {definition_model.MAX_PINNED_PER_BOARD} "
                    f"{field_noun} can be shown on {pin_surface}."
                )
            })


class CustomFieldDefinitionSerializer(serializers.ModelSerializer):
    """The board-scoped schema half of a custom field.

    ``position`` is read-only: it is assigned on create (append to the end) and
    changed only through the ``reorder`` action, which does the two-pass update
    that ``unique_together(board, position)`` requires. Letting a plain PATCH
    set it would make a unique violation the client's problem to untangle.

    ``choices_json`` is exposed as ``choices`` — the column name records the
    storage decision (a JSON list on the definition, not a separate table); the
    API does not need to repeat it.
    """

    choices = serializers.JSONField(source="choices_json", required=False)

    class Meta:
        model = CustomFieldDefinition
        fields = [
            "id", "uid", "name", "field_type", "choices", "position",
            "show_on_card", "is_required", "help_text", "created_at",
        ]
        read_only_fields = ["id", "uid", "position", "created_at"]

    def validate_name(self, value):
        name = (value or "").strip()
        if not name:
            raise serializers.ValidationError("Name cannot be blank.")
        return name

    def validate_field_type(self, value):
        """Freeze ``field_type`` once a card already holds a value for it (#1121).

        ``field_type`` decides how ``CustomFieldValue.value`` gets validated,
        cast, and rendered (see ``validate_custom_field_value`` below, board
        export, and the future Phase 2 per-type card rendering). None of those
        call sites revalidate or migrate existing rows when the type changes,
        so letting a PATCH flip e.g. ``text`` -> ``number`` after cards have
        free-text values would leave stale rows silently mismatched against
        their own definition — corrupt data that only surfaces later, in a
        crash or a misrender, far from the change that caused it.

        A field with zero values has never had a chance to accumulate that
        mismatch, so it stays freely editable. This intentionally does not
        implement a ``text`` -> ``dropdown`` conversion path: that needs an
        explicit decision on how existing free-text values map onto the new
        choice set, which #1121 defers rather than builds silently.
        """
        if (
            self.instance is not None
            and value != self.instance.field_type
            and self.instance.values.exists()
        ):
            raise serializers.ValidationError(
                "This field already has values; its type cannot be changed."
            )
        return value

    def validate(self, attrs):
        """Cross-field rules: dropdown choices, and the two per-board caps.

        Reads through to the instance for fields the caller did not submit, so
        a PATCH that only flips ``show_on_card`` is still checked against the
        field's actual type rather than against a default.
        """
        instance = self.instance
        field_type = attrs.get(
            "field_type",
            instance.field_type if instance else CustomFieldDefinition.FieldType.TEXT,
        )
        choices_submitted = "choices_json" in attrs
        choices = attrs.get(
            "choices_json", instance.choices_json if instance else []
        )

        if field_type == CustomFieldDefinition.FieldType.DROPDOWN:
            if not isinstance(choices, list) or not choices:
                raise serializers.ValidationError({
                    "choices": "A dropdown field needs at least one choice."
                })
            cleaned = []
            for choice in choices:
                if not isinstance(choice, str) or not choice.strip():
                    raise serializers.ValidationError({
                        "choices": "Every choice must be a non-empty string."
                    })
                cleaned.append(choice.strip())
            if len(set(cleaned)) != len(cleaned):
                raise serializers.ValidationError({
                    "choices": "Choices must be unique."
                })
            if len(cleaned) > 100:
                raise serializers.ValidationError({
                    "choices": "A dropdown field may have at most 100 choices."
                })
            attrs["choices_json"] = cleaned
        elif choices_submitted and choices:
            # Not a silent discard: a client sending choices for a checkbox has
            # misunderstood something, and a 400 says so while an empty list
            # written behind their back would not.
            raise serializers.ValidationError({
                "choices": "Only a dropdown field can have choices."
            })
        else:
            attrs["choices_json"] = []

        board = self.context.get("board") or (instance.board if instance else None)
        if board is not None:
            # unique_together(board, name) is not reachable by DRF's automatic
            # UniqueTogetherValidator — `board` is not a serializer field (it is
            # supplied by the viewset from the URL), so without this check a
            # duplicate name reaches the database and surfaces as a 500 rather
            # than a 400 naming the field.
            name = attrs.get("name", instance.name if instance else None)
            if name is not None:
                clash = CustomFieldDefinition.objects.filter(board=board, name=name)
                if instance is not None and instance.pk is not None:
                    clash = clash.exclude(pk=instance.pk)
                if clash.exists():
                    raise serializers.ValidationError({
                        "name": "A custom field with this name already exists on this board."
                    })
            assert_definition_caps(
                board,
                instance=instance,
                show_on_card=attrs.get(
                    "show_on_card",
                    instance.show_on_card if instance else False,
                ),
            )
        return attrs


class CustomFieldValueSerializer(serializers.ModelSerializer):
    """Read representation of one card's value for one definition.

    Deliberately thin: it carries the definition's **id** and not its name or
    type, because the board's full definition list already reaches the client
    on board load (``BoardFullSerializer.custom_field_definitions``). Inlining
    the schema on every value would repeat it once per card per field.
    """

    class Meta:
        model = CustomFieldValue
        fields = ["field_definition", "value"]
        read_only_fields = fields


def _normalize_custom_field_value(definition, raw):
    """Cast and validate one submitted value for *definition*.

    Returns the string to store; ``""`` means "clear this field". Raises
    ``serializers.ValidationError`` for anything the type does not accept.

    Every type funnels through one text column, so this is the only thing
    standing between "number" meaning a number and it meaning whatever the
    client typed. Values are normalized to a canonical string form (ISO dates,
    ``"true"``/``"false"``) so that equality comparisons — the change diff in
    the service, and any future value filter — do not have to know the type.
    """
    T = CustomFieldDefinition.FieldType
    if raw is None:
        return ""
    if isinstance(raw, bool):
        # Checked before the str() below: str(True) is "True", which would then
        # have to be special-cased in every branch.
        if definition.field_type != T.CHECKBOX:
            raise serializers.ValidationError(
                f"'{definition.name}' does not accept a boolean."
            )
        return "true" if raw else "false"
    if isinstance(raw, (list, dict)):
        raise serializers.ValidationError(
            f"'{definition.name}' expects a single value."
        )

    text = str(raw).strip()
    if text == "":
        return ""

    if len(text) > CustomFieldDefinition.MAX_VALUE_LENGTH:
        raise serializers.ValidationError(
            f"'{definition.name}' value is longer than "
            f"{CustomFieldDefinition.MAX_VALUE_LENGTH} characters."
        )

    if definition.field_type == T.NUMBER:
        try:
            parsed = decimal.Decimal(text)
        except (decimal.InvalidOperation, ValueError):
            raise serializers.ValidationError(
                f"'{definition.name}' must be a number."
            ) from None
        if not parsed.is_finite():
            # Decimal accepts "NaN" and "Infinity"; neither is a number a user
            # can have meant, and both compare in surprising ways.
            raise serializers.ValidationError(
                f"'{definition.name}' must be a finite number."
            )
        return text

    if definition.field_type == T.DATE:
        try:
            parsed_date = parse_date(text)
        except ValueError:
            # parse_date returns None for a string that is not date-shaped, but
            # raises for one that is well-formed and impossible ("2026-13-01").
            parsed_date = None
        if parsed_date is None:
            raise serializers.ValidationError(
                f"'{definition.name}' must be a date in YYYY-MM-DD format."
            )
        return text

    if definition.field_type == T.CHECKBOX:
        lowered = text.lower()
        if lowered in ("true", "1", "yes"):
            return "true"
        if lowered in ("false", "0", "no"):
            return "false"
        raise serializers.ValidationError(
            f"'{definition.name}' must be true or false."
        )

    if definition.field_type == T.DROPDOWN:
        if text not in (definition.choices_json or []):
            # Note this is also what makes a value referencing a since-removed
            # choice unwritable while leaving the already-stored value readable
            # — the history stays honest, the next write has to be valid.
            raise serializers.ValidationError(
                f"'{text}' is not a choice for '{definition.name}'."
            )
        return text

    return text


def _run_custom_field_validator_hooks(definition, value, *, hook_name="CUSTOM_FIELD_VALIDATORS"):
    """Apply a ``boards.hooks`` validator list to a normalized value.

    Read off the module object on every call, never bound at import time, so an
    enterprise ``AppConfig.ready()`` that appends to the list is honored — the
    stability guarantee in ``boards/hooks.py``.

    ``hook_name`` selects the list: card values use the default
    ``CUSTOM_FIELD_VALIDATORS``; swimlane values pass
    ``SWIMLANE_CUSTOM_FIELD_VALIDATORS``. They are deliberately separate lists
    rather than one list fed both definition types — see the reasoning on the
    hook itself.
    """
    from . import hooks as _hooks

    for validator in getattr(_hooks, hook_name):
        try:
            replacement = validator(definition, value)
        except DjangoValidationError as exc:
            raise serializers.ValidationError(list(exc.messages)) from None
        if replacement is not None:
            value = replacement
    return value


@extend_schema_field({
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "field_definition": {
                "type": "integer",
                "description": "CustomFieldDefinition id, scoped to the card's board.",
            },
            "value": {
                "type": "string",
                "description": (
                    "Value as a string; empty string clears the field. Numbers as "
                    "written, dates as YYYY-MM-DD, checkboxes as 'true'/'false'."
                ),
            },
        },
        "required": ["field_definition", "value"],
    },
})
class CustomFieldValuesField(serializers.Field):
    """The ``custom_field_values`` field on :class:`CardSerializer`.

    The ``extend_schema_field`` above is not decoration: a bare
    ``serializers.Field`` has no type drf-spectacular can infer, so without it
    the generated OpenAPI schema describes this as a plain ``string`` and a
    client generated from that schema rejects every card (#1108 was the same
    class of bug).

    One field rather than the read/write pair used for labels (``labels`` +
    ``label_ids``) because the payload shape is the same in both directions:
    a list of ``{"field_definition": <id>, "value": "<string>"}``. A client can
    therefore round-trip the representation it was given, which the 1.0
    backward-compatibility contract effectively requires of anything embedded
    in the card body.

    A write names only the fields it wants to change; unnamed fields are left
    alone. Sending ``""`` or ``null`` for a field clears it.

    Definitions are resolved **scoped to the card's board**, so a definition id
    belonging to another board is a 400 and never a silent cross-board write
    (IDOR). The board comes from serializer context, and a serializer built
    without it rejects every id rather than falling back to an unscoped lookup
    — the same fail-closed posture as ``label_ids`` and ``assignee_id``.
    """

    # No braces in these strings: DRF runs every message through str.format(),
    # so a literal "{field_definition, value}" is read as a format field and
    # raises KeyError instead of reporting the validation error.
    default_error_messages = {
        "not_a_list": (
            "Expected a list of objects, each with a field_definition and a value."
        ),
        "not_an_object": (
            "Each entry must be an object with a field_definition and a value."
        ),
        "no_board": (
            "Custom field values cannot be resolved without board context."
        ),
    }

    def __init__(self, **kwargs):
        kwargs.setdefault("required", False)
        super().__init__(**kwargs)

    def to_representation(self, value):
        # `value` is the reverse related manager. .all() reads the prefetch
        # cache populated by _card_queryset(); .filter()/.order_by() here would
        # bypass it and issue one query per card.
        return [
            {"field_definition": row.field_definition_id, "value": row.value}
            for row in value.all()
        ]

    def to_internal_value(self, data):
        if not isinstance(data, list):
            self.fail("not_a_list")
        if len(data) > CustomFieldDefinition.MAX_PER_BOARD:
            # A board can never have more than MAX_PER_BOARD definitions, so a
            # longer list cannot be legitimate. Rejected on length before the
            # per-entry loop so an oversized payload costs one comparison rather
            # than a walk over tens of thousands of entries and an `IN` clause
            # of the same size.
            raise serializers.ValidationError(
                f"At most {CustomFieldDefinition.MAX_PER_BOARD} custom field "
                "values can be set in one request."
            )
        board = self.context.get("board")
        if board is None:
            self.fail("no_board")

        wanted = {}
        for entry in data:
            if not isinstance(entry, dict) or "field_definition" not in entry:
                self.fail("not_an_object")
            try:
                definition_id = int(entry["field_definition"])
            except (TypeError, ValueError):
                raise serializers.ValidationError(
                    f"Invalid field_definition: {entry['field_definition']!r}."
                ) from None
            if definition_id in wanted:
                raise serializers.ValidationError(
                    f"Field {definition_id} appears more than once."
                )
            wanted[definition_id] = entry.get("value")

        if not wanted:
            return []

        # One query for the whole submitted set, scoped to the board. An id on
        # another board simply is not in the result, so it reports as unknown
        # rather than confirming that it exists somewhere the caller cannot see.
        definitions = {
            definition.pk: definition
            for definition in CustomFieldDefinition.objects.filter(
                board=board, pk__in=wanted
            )
        }
        missing = sorted(set(wanted) - set(definitions))
        if missing:
            raise serializers.ValidationError(
                "Unknown custom field(s) for this board: "
                + ", ".join(str(pk) for pk in missing)
                + "."
            )

        pairs = []
        for definition_id, raw in wanted.items():
            definition = definitions[definition_id]
            value = _normalize_custom_field_value(definition, raw)
            value = _run_custom_field_validator_hooks(definition, value)
            pairs.append((definition, value))
        return pairs


class SwimlaneCustomFieldDefinitionSerializer(serializers.ModelSerializer):
    """The board-scoped schema half of a swimlane custom field (#1140).

    Mirrors :class:`CustomFieldDefinitionSerializer` — ``position`` read-only
    and changed only through ``reorder``, ``choices_json`` exposed as
    ``choices`` — so that the two field editors behave identically and a reader
    of one understands the other. The differences are the pin column
    (``show_on_row``, capped at 3 rather than 2) and ``is_admin_only``.
    """

    choices = serializers.JSONField(source="choices_json", required=False)

    class Meta:
        model = SwimlaneCustomFieldDefinition
        fields = [
            "id", "uid", "name", "field_type", "choices", "position",
            "show_on_row", "is_admin_only", "is_required", "help_text",
            "created_at",
        ]
        read_only_fields = ["id", "uid", "position", "created_at"]

    def validate_name(self, value):
        name = (value or "").strip()
        if not name:
            raise serializers.ValidationError("Name cannot be blank.")
        return name

    def validate_field_type(self, value):
        """Freeze ``field_type`` once a swimlane already holds a value for it.

        Deliberately the same rule, and the same shape, as the card-level guard
        added for #1121: ``field_type`` decides how the single untyped ``value``
        column is validated, cast and rendered, and nothing revalidates or
        migrates stored rows when it changes. Flipping ``text`` -> ``number``
        after rows carry free text leaves those rows silently mismatched
        against their own definition — corruption that surfaces later, far from
        the change that caused it.

        A definition with zero values has nothing to protect and stays freely
        editable. No ``text`` -> ``dropdown`` conversion path is implied: that
        needs an explicit decision about how existing values map onto the new
        choice set, which this issue defers rather than builds silently.

        Known and accepted: a value written concurrently between this check and
        the save slips through. The card-level guard has the identical gap;
        closing it here alone would make the two diverge for no benefit.
        """
        if (
            self.instance is not None
            and value != self.instance.field_type
            and self.instance.values.exists()
        ):
            raise serializers.ValidationError(
                "This field already has values; its type cannot be changed."
            )
        return value

    def validate(self, attrs):
        """Cross-field rules: dropdown choices, name uniqueness, and the caps."""
        instance = self.instance
        T = CustomFieldDefinition.FieldType
        field_type = attrs.get(
            "field_type", instance.field_type if instance else T.TEXT
        )
        choices_submitted = "choices_json" in attrs
        choices = attrs.get(
            "choices_json", instance.choices_json if instance else []
        )

        if field_type == T.DROPDOWN:
            if not isinstance(choices, list) or not choices:
                raise serializers.ValidationError({
                    "choices": "A dropdown field needs at least one choice."
                })
            cleaned = []
            for choice in choices:
                if not isinstance(choice, str) or not choice.strip():
                    raise serializers.ValidationError({
                        "choices": "Every choice must be a non-empty string."
                    })
                cleaned.append(choice.strip())
            if len(set(cleaned)) != len(cleaned):
                raise serializers.ValidationError({
                    "choices": "Choices must be unique."
                })
            if len(cleaned) > 100:
                raise serializers.ValidationError({
                    "choices": "A dropdown field may have at most 100 choices."
                })
            attrs["choices_json"] = cleaned
        elif choices_submitted and choices:
            raise serializers.ValidationError({
                "choices": "Only a dropdown field can have choices."
            })
        else:
            attrs["choices_json"] = []

        board = self.context.get("board") or (instance.board if instance else None)
        if board is not None:
            # Same reason as the card-level serializer: `board` is not a
            # serializer field, so DRF's UniqueTogetherValidator cannot reach
            # unique_together(board, name) and a duplicate would surface as a
            # 500 instead of a 400 naming the field.
            name = attrs.get("name", instance.name if instance else None)
            if name is not None:
                clash = SwimlaneCustomFieldDefinition.objects.filter(
                    board=board, name=name
                )
                if instance is not None and instance.pk is not None:
                    clash = clash.exclude(pk=instance.pk)
                if clash.exists():
                    raise serializers.ValidationError({
                        "name": (
                            "A swimlane custom field with this name already "
                            "exists on this board."
                        )
                    })
            assert_definition_caps(
                board,
                instance=instance,
                show_on_card=attrs.get(
                    "show_on_row",
                    instance.show_on_row if instance else False,
                ),
                definition_model=SwimlaneCustomFieldDefinition,
                pin_attr="show_on_row",
                pin_surface="the swimlane row",
                field_noun="swimlane custom fields",
            )
        return attrs


class CardMovementSerializer(serializers.ModelSerializer):
    # allow_null=True (#1108): moved_by is a SET_NULL FK — a movement made by
    # a since-deleted user must still serialize, and the schema must document
    # that `moved_by` can be null rather than defaulting to always-object.
    moved_by = BoardUserSerializer(read_only=True, allow_null=True)
    # card_uid / card_title allow board-level history consumers to identify
    # which card a movement belongs to without a secondary fetch.
    # source="card.*" is safe because the board-level movements queryset
    # always select_related("card"), and the card-level queryset trivially
    # has the card available.
    card_uid = serializers.CharField(source="card.uid", read_only=True)
    card_title = serializers.CharField(source="card.title", read_only=True)

    class Meta:
        model = CardMovement
        fields = [
            "id",
            "card_uid", "card_title",
            "from_column", "from_column_name", "from_column_uid",
            "to_column", "to_column_name", "to_column_uid",
            "from_swimlane", "from_swimlane_name", "from_swimlane_uid",
            "to_swimlane", "to_swimlane_name", "to_swimlane_uid",
            "moved_by", "moved_at", "notes", "movement_type",
        ]


class CardCommentSerializer(serializers.ModelSerializer):
    author = BoardUserSerializer(read_only=True)
    body = serializers.CharField(max_length=10_000)

    class Meta:
        model = CardComment
        fields = ["id", "author", "body", "created_at", "updated_at"]


class CardActivitySerializer(serializers.ModelSerializer):
    actor = BoardUserSerializer(read_only=True)

    class Meta:
        model = CardActivity
        fields = ["id", "event_type", "from_value", "to_value", "actor", "created_at"]


class CardChecklistSerializer(serializers.ModelSerializer):
    created_by = BoardUserSerializer(read_only=True)

    class Meta:
        model = CardChecklist
        fields = ["id", "text", "is_checked", "position", "created_by"]


class LinkedCardSerializer(serializers.ModelSerializer):
    """The other end of a card relation, rendered as a compact reference (#449).

    Deliberately not ``CardSerializer``: a relation row needs just enough to
    render a clickable line in the Relations list, and nesting the full card
    would pull labels, assignee, checklist counts and custom field values for
    every neighbor — and would recurse, since a full card carries its own
    ``blocker_count``.

    ``archived`` is surfaced rather than the relation being hidden, because a
    relation outlives its target's archiving. Suppressing it would leave a
    dangling row the user can neither see nor delete; showing it flagged is
    what makes it actionable. Note this is the one place an archived card's
    title reaches a client that did not ask for archived cards — acceptable
    because the requester is already a member of the board the card is on, and
    the relation is the reference that makes it discoverable.
    """

    archived = serializers.SerializerMethodField()

    class Meta:
        model = Card
        fields = ["id", "uid", "title", "column", "archived"]

    def get_archived(self, obj) -> bool:
        return obj.archived_at is not None


class CardRelationSerializer(serializers.Serializer):
    """One relation, resolved relative to the card being viewed (#449).

    The model stores a single canonical direction (see ``CardRelation``); this
    serializer turns that row into the sentence the viewer needs. Given the
    card in hand, ``direction`` is:

    * ``blocks``     — this card blocks ``card`` (row reached via ``outgoing_relations``)
    * ``blocked_by`` — ``card`` blocks this card  (row reached via ``incoming_relations``)
    * ``relates_to`` — symmetric; reads the same from either end

    Read-only and hand-rolled rather than a ``ModelSerializer``: the output
    shape is a *view* of the row (the neighbor card, not the FK pair), so
    there are no model fields to map, and writes go through
    ``CardRelationCreateSerializer`` instead.
    """

    id = serializers.IntegerField(read_only=True)
    relation_type = serializers.CharField(read_only=True)
    direction = serializers.CharField(read_only=True)
    card = LinkedCardSerializer(read_only=True)
    created_at = serializers.DateTimeField(read_only=True)


class CardRelationCreateSerializer(serializers.Serializer):
    """Validate a new relation between the card in context and another card (#449).

    The request names a **direction**, not a storage layout: ``blocks``,
    ``blocked_by`` or ``relates_to``, always read from the point of view of the
    card in the URL. The serializer maps that onto the single canonical row the
    model stores, deciding which card becomes ``from_card``. Without
    ``blocked_by`` the panel could only ever say "this card blocks X" — "X
    blocks this card" would need the client to post to X's endpoint instead,
    which it has no reason to know about.

    Every invariant that is not a database constraint lives here rather than in
    the view or the model, per the project's "validate at the boundary" rule, so
    each fails as a readable 400 instead of an IntegrityError 500.

    ``to_card`` is resolved by hand against a board-scoped queryset rather than
    declared as a ``PrimaryKeyRelatedField`` — the field's own "invalid pk"
    error cannot carry a top-level ``code``, and these four failures are
    distinct, machine-checkable outcomes a client needs to branch on rather
    than string-match (the ``code``/``detail`` shape follows #1115). The lookup
    **fails closed**: without ``board`` in context nothing matches and every id
    is rejected, rather than falling back to ``Card.objects.all()``. That is the
    IDOR gate — checking only the card in the URL would let a member of board A
    attach a relation to an arbitrary card on board B and learn its id, title
    and column from the response.
    """

    to_card = serializers.IntegerField()
    direction = serializers.ChoiceField(
        choices=["blocks", "blocked_by", "relates_to"]
    )

    @staticmethod
    def _fail(code, detail):
        # Top-level `code` + `detail`, the shape BoardSerializer.validate()
        # established for machine-checkable 400s (#1115). DRF coerces both into
        # single-item lists, so a client reads `"self_relation" in body["code"]`.
        raise serializers.ValidationError({"code": code, "detail": detail})

    def validate(self, attrs):
        board = self.context.get("board")
        from_card = self.context.get("from_card")
        if board is None or from_card is None:
            raise serializers.ValidationError(
                "Relations cannot be resolved without board and card context."
            )

        target_id = attrs["to_card"]
        direction = attrs["direction"]

        if target_id == from_card.pk:
            # Also enforced by the cardrel_no_self_relation check constraint;
            # caught here so the client gets a 400 it can render rather than a
            # 500 from the database.
            self._fail("self_relation", "A card cannot be related to itself.")

        target = Card.objects.filter(board=board, pk=target_id).first()
        if target is None:
            # A card on another board and a card that does not exist at all are
            # deliberately the same answer. Distinguishing them would confirm
            # the existence of a card the caller cannot see — the same
            # IDOR-safe posture ObjectNotFound documents in services/errors.py.
            self._fail(
                "cross_board",
                "That card is not on this board. Relations can only link "
                "cards on the same board.",
            )
        if target.archived_at is not None:
            # Existing relations survive their target being archived (they are
            # listed and flagged so they can be removed); a *new* link to a
            # card that is not on the board would be dead on arrival.
            self._fail(
                "archived_card",
                "That card is archived and cannot be linked.",
            )

        # Map the requested direction onto the one row the model stores.
        if direction == "blocked_by":
            relation_type, low, high = CardRelation.Type.BLOCKS, target, from_card
        elif direction == "blocks":
            relation_type, low, high = CardRelation.Type.BLOCKS, from_card, target
        else:
            relation_type, low, high = CardRelation.Type.RELATES_TO, from_card, target
            # Symmetric types are stored in a canonical order (lower card id
            # first) so unique_together dedupes them. Without this, two people
            # adding "relates to" from opposite ends create two rows that both
            # satisfy the constraint, and each card lists the other twice.
            if low.pk > high.pk:
                low, high = high, low

        if CardRelation.objects.filter(
            from_card=low, to_card=high, relation_type=relation_type
        ).exists():
            self._fail("relation_exists", "That relation already exists.")

        # Reject a direct two-cycle for the asymmetric types: "A blocks B" while
        # "B blocks A" is a logical contradiction and the UI has no coherent way
        # to render it. Longer cycles (A -> B -> C -> A) are deliberately not
        # detected — see the CardRelation docstring for why.
        #
        # The message does not echo the card title back: it is user-controlled
        # text, and the client already knows which card the request named.
        if relation_type not in CardRelation.SYMMETRIC_TYPES and CardRelation.objects.filter(
            from_card=high, to_card=low, relation_type=relation_type
        ).exists():
            self._fail(
                "relation_cycle",
                "Those two cards would block each other. Remove the existing "
                "relation first.",
            )

        attrs["from_card"] = low
        attrs["to_card"] = high
        attrs["relation_type"] = relation_type
        return attrs


def _annotate_is_stale(qs, stale_cutoff):
    """Annotate the queryset with ``_is_stale_annotated`` at the SQL level.

    A card is stale when its most recent movement predates the cutoff, or —
    for never-moved cards — when it was created before the cutoff.  Computing
    the boolean once via a single subquery avoids a per-card ``timezone.now()``
    branch in the serializer (#669).

    Used by both the authenticated ``_card_queryset`` and the public share-link
    queryset (#926) so all read paths share the same stale logic.
    """
    from .models import CardMovement as _CM
    _last_moved_sq = _db_models.Subquery(
        _CM.objects.filter(card=_db_models.OuterRef("pk"))
        .order_by("-moved_at")
        .values("moved_at")[:1]
    )
    return qs.annotate(
        _last_moved_at_for_stale=_last_moved_sq,
        _is_stale_annotated=_db_models.Case(
            # Card has at least one movement and it predates the cutoff.
            _db_models.When(
                _last_moved_at_for_stale__lt=stale_cutoff,
                then=_db_models.Value(True),
            ),
            # Never-moved card: fall back to created_at.
            _db_models.When(
                _last_moved_at_for_stale__isnull=True,
                created_at__lt=stale_cutoff,
                then=_db_models.Value(True),
            ),
            default=_db_models.Value(False),
            output_field=_db_models.BooleanField(),
        )
    )


def _active_blockers_prefetch():
    """Return the Prefetch that feeds ``blocker_count`` (#449).

    Loads, into ``card.active_blockers``, the relations in which this card is
    the *blocked* end (``to_card``) and the blocking card is still on the
    board.

    Three deliberate choices, each of which the obvious alternative gets wrong:

    * **Filtered in SQL, not in Python.** ``relation_type`` is pinned here so
      ``get_blocker_count`` is a bare ``len()``. Filtering the relation type in
      the serializer instead would need every relation row loaded just to throw
      the ``relates_to`` ones away.
    * **``from_card__archived_at__isnull=True``.** A relation survives its
      blocker being archived — ``Card`` has no default manager that hides
      archived rows, so the row is still there and still counts unless it is
      excluded. Without this, a card renders as blocked by a card that is not
      on the board, which the user has no way to act on. Archived blockers are
      still returned by the relations endpoint, flagged, so the relation can be
      found and deleted.
    * **Only ``id`` and ``to_card_id`` are loaded.** Everything the caller needs
      is the row count. Note the consequence: reading any other field on a
      parked row — ``relation_type``, ``created_by``, and ``from_card``
      especially, whose id is not even loaded — costs one query per row. If you
      ever need more than ``len()`` here, widen this ``only()`` deliberately
      rather than letting a deferred field do it silently.
    * **``to_attr``.** Parks the result on a plain list attribute, so
      ``len()`` cannot silently fall through to a fresh COUNT(*) the way
      ``obj.incoming_relations.all()`` would on a queryset that was never
      prefetched. Missing the prefetch becomes an AttributeError, not an N+1.

    Shared by ``_card_queryset`` and ``PublicBoardSerializer.get_cards`` so the
    authenticated and anonymous share-link read paths cannot drift on which
    blockers count — the same reason ``_annotate_is_stale`` is shared (#926).
    """
    return Prefetch(
        "incoming_relations",
        queryset=CardRelation.objects.filter(
            relation_type=CardRelation.Type.BLOCKS,
            from_card__archived_at__isnull=True,
        ).only("id", "to_card_id"),
        to_attr="active_blockers",
    )


def _blocker_count(card) -> int:
    """Number of active cards blocking ``card`` (#449).

    Reads the ``active_blockers`` list parked by
    :func:`_active_blockers_prefetch`. ``len()`` on that list is one Python
    operation; ``card.incoming_relations.filter(...).count()`` would issue a
    fresh COUNT(*) **per card**, which on ``/full/`` is exactly the N+1 the
    prefetch exists to prevent.

    The cold path — a card serialized from a queryset built without the
    prefetch — falls back to a real query rather than raising, because a
    single-card response can afford one query and a 500 here would be worse
    than a slow row. It is kept narrow on purpose: every list path goes through
    ``_card_queryset``, so if this fallback ever starts firing in bulk, the
    ``*_budget_scales_with_cards`` guards in ``test_query_counts.py`` fail.
    """
    blockers = getattr(card, "active_blockers", None)
    if blockers is not None:
        return len(blockers)
    return card.incoming_relations.filter(
        relation_type=CardRelation.Type.BLOCKS,
        from_card__archived_at__isnull=True,
    ).count()


def _card_queryset(qs, stale_cutoff=None):
    """Apply the standard prefetch chain required by CardSerializer.

    Centralised here so CardViewSet, BoardFullSerializer, and the archived
    action all use identical prefetches — avoids drift that reintroduces N+1s.

    Movements are prefetched ordered by -moved_at so that serializer methods
    that need the most-recent movement can use movements.all()[0] without
    issuing an additional ORDER BY + LIMIT 1 query per card.

    When ``stale_cutoff`` is provided, an ``is_stale`` boolean annotation is
    added at the SQL level (one query, not one per card) so
    CardSerializer.get_is_stale() can read the pre-computed value instead of
    calling timezone.now() per row (#669).  Pass ``stale_cutoff=None`` only
    when the board's staleness_threshold_days is not yet known (e.g. nested
    serializers that do not have access to the board settings) — in that case
    the serializer falls back to per-row logic.
    """
    from .models import CardMovement as _CM
    qs = (
        qs
        .select_related("board", "column", "swimlane", "assignee", "created_by")
        .prefetch_related(
            "labels",
            "attachments",
            Prefetch("checklist_items", queryset=CardChecklist.objects.select_related("created_by")),
            Prefetch(
                "movements",
                queryset=_CM.objects.select_related(
                    "moved_by", "from_column", "to_column", "from_swimlane", "to_swimlane"
                ).order_by("-moved_at"),
            ),
            # Custom field values (#371). One query for the whole page, with the
            # definition joined so CardSerializer never resolves a per-row FK,
            # and ordered by the definition's display position so the client
            # renders them in board order without sorting. Ordering lives here
            # rather than on CustomFieldValue.Meta so only this read path pays
            # for the join. EAV makes the row count cards x fields, which is
            # why the field count is capped at 30 per board.
            Prefetch(
                "custom_field_values",
                queryset=CustomFieldValue.objects.select_related(
                    "field_definition"
                ).order_by("field_definition__position", "field_definition_id"),
            ),
            # Card relations (#449). One query for the whole page, feeding the
            # scalar `blocker_count` on the card face. Only the *blocked*
            # direction is loaded: the full relation list is served by
            # GET /cards/<pk>/relations/ rather than riding on every card in
            # the board payload, so there is deliberately no
            # `outgoing_relations` prefetch here.
            _active_blockers_prefetch(),
        )
    )
    if stale_cutoff is not None:
        qs = _annotate_is_stale(qs, stale_cutoff)
    return qs


class CardSerializer(serializers.ModelSerializer):
    labels = LabelSerializer(many=True, read_only=True)
    label_ids = serializers.PrimaryKeyRelatedField(
        many=True, write_only=True, queryset=Label.objects.all(), source="labels", required=False
    )
    # allow_null=True (#1108): Card.assignee is nullable (unassigned cards are
    # the common case) — without it drf-spectacular documents this field as
    # always an object, which is wrong for every unassigned card in the response.
    assignee = BoardUserSerializer(read_only=True, allow_null=True)
    assignee_id = serializers.PrimaryKeyRelatedField(
        # Fail closed: the queryset is re-scoped to the board's assignable members
        # in __init__ when `board` is in context. Defaulting to none() (not all())
        # means a caller that forgets to pass `board` rejects every assignee with a
        # validation error rather than exposing all users as candidates (#1050).
        write_only=True, read_only=False, queryset=User.objects.none(), source="assignee", required=False, allow_null=True
    )
    # Explicitly declared (rather than left to auto-generation from the model
    # FK) so the queryset can be scoped to the current board in __init__, and
    # a cross-board id fails validation with 400 instead of silently
    # attaching the card to another board's column/swimlane (#1106). Fail
    # closed to none() like assignee_id above — a caller that forgets to pass
    # `board` rejects every column/swimlane rather than exposing all rows.
    column = serializers.PrimaryKeyRelatedField(queryset=Column.objects.none())
    swimlane = serializers.PrimaryKeyRelatedField(queryset=Swimlane.objects.none())
    created_by = BoardUserSerializer(read_only=True)
    description = serializers.CharField(max_length=50_000, allow_blank=True, required=False)
    last_moved_at = serializers.SerializerMethodField()
    # Read-and-write, same shape both ways — see CustomFieldValuesField (#371).
    custom_field_values = CustomFieldValuesField()

    def __init__(self, *args, **kwargs):
        """Scope label_ids, assignee_id, column and swimlane querysets to the current board.

        Without this, a client could assign labels, a column, or a swimlane from
        another board, or assign a user who is not a member of the board — all
        are cross-board IDOR vulnerabilities.  The board must be passed via
        serializer context.

        When called from BoardFullSerializer.get_cards() or CardViewSet, the
        context may contain pre-computed _member_ids and _board_labels_qs to
        avoid re-querying per card instance (N+1 fix — see #490).
        """
        super().__init__(*args, **kwargs)
        board = self.context.get("board")
        if board:
            labels_qs = self.context.get("_board_labels_qs") or Label.objects.filter(board=board)
            self.fields["label_ids"].child_relation.queryset = labels_qs
            from .utils import _get_assignable_member_ids
            # Use _assignable_member_ids if pre-computed (viewers excluded); fall
            # back to computing it now.  _member_ids is NOT used here because it
            # includes viewer-role users who must not appear as assignee options.
            assignable_ids = self.context.get("_assignable_member_ids") or _get_assignable_member_ids(board)
            self.fields["assignee_id"].queryset = User.objects.filter(
                pk__in=assignable_ids
            )
            self.fields["column"].queryset = Column.objects.filter(board=board)
            self.fields["swimlane"].queryset = Swimlane.objects.filter(board=board)

    attachment_count = serializers.SerializerMethodField()
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()
    blocker_count = serializers.SerializerMethodField()

    class Meta:
        model = Card
        fields = [
            "id", "uid", "column", "swimlane", "title", "description", "priority",
            "assignee", "assignee_id", "labels", "label_ids", "due_date",
            "weight", "position", "created_by", "created_at", "updated_at",
            "last_moved_at", "attachment_count", "checklist_total", "checklist_done",
            "is_stale", "archived_at", "version", "custom_field_values",
            "blocker_count",
        ]
        read_only_fields = ["uid", "created_by", "created_at", "updated_at", "archived_at", "version"]

    # -- custom field values -------------------------------------------------
    #
    # Popped out of validated_data and applied after the row exists, because
    # they live in their own table and a create has no PK to hang them off
    # until super() has run. Both paths run inside the card service's
    # transaction (the service calls save() from within it), so a failure here
    # rolls the card write back with them, and the service's deferred
    # `card.updated` / `card.created` broadcast already reflects them — the
    # payload is re-rendered through _card_queryset() after this returns.

    def create(self, validated_data):
        pairs = validated_data.pop("custom_field_values", None)
        card = super().create(validated_data)
        self._apply_custom_field_values(card, pairs)
        return card

    def update(self, instance, validated_data):
        pairs = validated_data.pop("custom_field_values", None)
        card = super().update(instance, validated_data)
        self._apply_custom_field_values(card, pairs)
        return card

    def _apply_custom_field_values(self, card, pairs):
        if not pairs:
            return
        from .services.custom_fields import apply_custom_field_values

        request = self.context.get("request")
        actor = getattr(request, "user", None) if request else None
        apply_custom_field_values(
            card=card,
            pairs=pairs,
            actor=actor if getattr(actor, "is_authenticated", False) else None,
        )
        # Drop the prefetch cache this serializer instance was built with: it
        # was loaded before the write and would render the pre-edit values back
        # to the client.
        if hasattr(card, "_prefetched_objects_cache"):
            card._prefetched_objects_cache.pop("custom_field_values", None)

    def get_last_moved_at(self, obj) -> datetime.datetime | None:
        # Use .all() not .first() — .first() bypasses the prefetch cache and
        # issues a new query with ORDER BY + LIMIT 1 for every card.
        # Return type is annotated (#1108): a never-moved card returns None,
        # and without the hint drf-spectacular defaulted this to a
        # non-nullable "string", producing a schema that a strict client
        # (e.g. a generated TS type) would reject on every unmoved card.
        movements = obj.movements.all()
        return movements[0].moved_at if movements else None

    def get_attachment_count(self, obj) -> int:
        # len() on a prefetched relation uses the in-memory cache; .count() does not.
        return len(obj.attachments.all())

    def get_blocker_count(self, obj) -> int:
        return _blocker_count(obj)

    def get_checklist_total(self, obj) -> int:
        return len(obj.checklist_items.all())

    def get_checklist_done(self, obj) -> int:
        return sum(1 for item in obj.checklist_items.all() if item.is_checked)

    def get_is_stale(self, obj) -> bool:
        # Fast path: use the queryset-level annotation when it was pre-computed
        # by _card_queryset(stale_cutoff=...) — avoids a timezone.now() call per
        # card and mirrors the per-row fallback exactly (#669).
        if hasattr(obj, "_is_stale_annotated"):
            return obj._is_stale_annotated
        # Fallback: per-row logic for callers that built the queryset without a
        # stale_cutoff (e.g. single-card re-fetch after a move or archive).
        # obj.board requires select_related("board") on the queryset.
        # obj.movements.all() uses the prefetch cache (ordered by -moved_at).
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


class CardAttachmentSerializer(serializers.ModelSerializer):
    uploaded_by = BoardUserSerializer(read_only=True)
    url = serializers.SerializerMethodField()

    class Meta:
        model = CardAttachment
        fields = ["id", "filename", "size", "url", "uploaded_by", "uploaded_at"]

    def get_url(self, obj):
        request = self.context.get("request")
        if request:
            return request.build_absolute_uri(obj.file.url)
        return obj.file.url


def _expand_requested(context, name):
    """Return True when the caller passed ``?expand=<name>`` (or a CSV containing it).

    Gates nested object expansion on serializers that would otherwise return only
    a foreign-key id. Keeping existing flat fields unchanged preserves the 1.0
    contract; the nested payload is additive. See #817.

    Internal callers (viewsets rendering a pre-bulked payload for their own UI)
    can inject ``_force_expand`` as a set in context to opt-in without polluting
    the public ``expand`` query-param API (#845).
    """
    if context:
        force = context.get("_force_expand")
        if force and name in force:
            return True
    request = context.get("request") if context else None
    if request is None:
        return False
    raw = request.query_params.get("expand", "")
    if not raw:
        return False
    return name in {p.strip() for p in raw.split(",") if p.strip()}


@extend_schema_field({
    "type": "array",
    "items": {"type": "string", "enum": [p[0] for p in Card.Priority.choices]},
})
class AllowedPrioritiesField(serializers.JSONField):
    """``allowed_priorities`` on :class:`BoardSerializer`.

    Schema-only subclass, deliberately *not* a ``ListField(child=ChoiceField)``.
    ``Board.allowed_priorities`` is a ``JSONField``, which drf-spectacular
    describes with no ``type`` at all — so a client generated from the schema
    gets ``unknown``/``any`` for a field the 1.0 contract says is a list of
    priority slugs (#1079). Declaring the real shape here fixes the schema
    without touching validation: swapping in a ``ListField`` would move the
    "invalid priority" rejection from :meth:`BoardSerializer.validate_allowed_priorities`
    into DRF's own field machinery, changing the 400 body's error shape for
    existing API callers — which the backward-compatibility rules don't allow.
    Same schema-only pattern as :class:`CustomFieldValuesField` above.
    """


class BoardSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    member_count = serializers.SerializerMethodField()
    card_count = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True, allow_null=True)
    group_detail = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()
    allowed_priorities = AllowedPrioritiesField(
        required=False,
        help_text=Board._meta.get_field("allowed_priorities").help_text,
    )
    # Write-only and not a Board model field — it exists only to be validated
    # here and read back off `serializer.validated_data["template"]` by the
    # view (BoardViewSet.perform_create / GroupViewSet.boards()) to pick the
    # BoardTemplate row to apply at creation. Never appears in a response, so
    # this does not change the read shape of any Board endpoint (#1115).
    template = serializers.CharField(write_only=True, required=False, allow_blank=True, allow_null=True, max_length=100)

    class Meta:
        model = Board
        fields = ["id", "uid", "name", "description", "owner", "group", "group_name", "group_detail", "member_count", "card_count", "staleness_threshold_days", "stale_warning_pct", "allowed_priorities", "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits", "export_min_role", "card_density", "show_wip_at_limit", "created_at", "updated_at", "is_starred", "template"]
        read_only_fields = ["uid", "created_at", "updated_at"]

    @extend_schema_field(GroupBriefSerializer(allow_null=True))
    def get_group_detail(self, obj):
        # Nested expansion is opt-in via ``?expand=group`` so the default response
        # shape stays unchanged — list endpoints do not pay for a join they didn't
        # ask for. See #817.
        #
        # The key is always present; its *value* is null unless expansion was
        # requested. The ``@extend_schema_field`` above says exactly that — an
        # undecorated SerializerMethodField is described as ``string`` in the
        # schema, which is how a generated client ends up with the wrong type
        # for a nested object (#1079).
        if not _expand_requested(self.context, "group") or obj.group_id is None:
            return None
        # Forward context so nested serializers can see ``group_ancestor_map``
        # (when the viewset pre-bulked ancestors to avoid N+1) — see #845.
        return GroupBriefSerializer(obj.group, context=self.context).data

    def validate_stale_warning_pct(self, value):
        if value < 0 or value > 100:
            raise serializers.ValidationError("stale_warning_pct must be between 0 and 100.")
        return value

    def validate_export_min_role(self, value):
        # #843: whitelist only the board-relative role hierarchy. ``site_admin``
        # is rejected because it is a cross-cutting identity, not a board-level
        # threshold — conflating the two would confuse the gate logic.
        # ``owner`` is not a BoardMembership.Role; the owner always bypasses
        # the threshold, so admitting it as a setting value would be
        # meaningless.
        allowed = {"viewer", "collaborator", "member", "admin"}
        if value not in allowed:
            raise serializers.ValidationError(
                f"export_min_role must be one of: {sorted(allowed)}."
            )
        return value

    def validate_card_density(self, value):
        # #961: gate the choice set at the serializer so the DB column stays a
        # plain CharField that will accept future tiers (e.g. ``relaxed``)
        # without a schema migration. Middle tier is named ``standard`` rather
        # than ``compact`` to avoid colliding with the per-user "Card layout:
        # Compact / Expanded" toolbar pref.
        allowed = {"comfortable", "standard", "dense"}
        if value not in allowed:
            raise serializers.ValidationError(
                f"card_density must be one of: {sorted(allowed)}."
            )
        return value

    def validate_allowed_priorities(self, value):
        if not value:
            return value
        # allowed_priorities is a bare JSONField (any JSON value is valid input
        # at the field level) — a non-list truthy value like `true` reaches here
        # and `any(v not in valid for v in value)` crashes with an unhandled 500
        # (`'bool' object is not iterable`) instead of a normal 400 (found by
        # backend-schema-fuzz).
        if not isinstance(value, list):
            raise serializers.ValidationError(
                "allowed_priorities must be a list of priority values."
            )
        valid = {p[0] for p in Card.Priority.choices}
        if any(v not in valid for v in value):
            raise serializers.ValidationError(
                f"Invalid priority value. Must be one of: {sorted(valid)}."
            )
        return value

    def validate(self, attrs):
        # `template` is validated at the object level (rather than a normal
        # `validate_template` field validator) so an unknown slug's error
        # body carries a top-level `code` key — `{"code": ["unknown_template"],
        # "detail": [...]}` — instead of this codebase's usual
        # `{"template": ["..."]}` shape nested under the field name. DRF's
        # `as_serializer_error()` always coerces a `.validate()` dict's
        # scalar values into single-item lists (the same as every other DRF
        # field error), so `code` still comes back as a list — a caller
        # checks `"unknown_template" in body["code"]`. `template` is a
        # public, documented request field (docs/api/boards.md) and an
        # unknown slug is a distinct, machine-checkable failure mode a
        # caller needs to branch on (e.g. a stale client's saved slug vs.
        # any other 400) — not a message it should have to string-match
        # (#1115).
        #
        # `template` only selects columns at board *creation* time — it has
        # no effect on an existing board. Before this field was declared,
        # DRF silently dropped an unrecognized `template` key on PUT/PATCH
        # (unknown input keys are ignored); this serializer is also used by
        # BoardViewSet.perform_update (backend/boards/views/boards.py), so
        # without this guard a stray or mistyped `template` in an update
        # body would start rejecting an otherwise-valid update with a 400 —
        # a regression this codebase's backward-compatibility rules don't
        # allow. `self.instance` is only set on an update (see
        # UpdateModelMixin.update() / get_serializer(instance, ...)), so
        # this drops the field as a no-op rather than validating it.
        if self.instance is not None:
            attrs.pop("template", None)
            return attrs

        template_slug = (attrs.get("template") or "").strip()
        if template_slug:
            if not BoardTemplate.objects.filter(slug=template_slug, is_active=True).exists():
                raise serializers.ValidationError({
                    "code": "unknown_template",
                    "detail": f"Unknown board template: {template_slug!r}.",
                })
            attrs["template"] = template_slug
        else:
            # Omitted, blank, or null all mean "use the default" — only an
            # explicit, non-matching slug is rejected. This keeps the 1.0
            # contract for clients that never send `template` at all.
            attrs["template"] = ""
        return attrs

    def create(self, validated_data):
        # `template` is not a Board model field (see the field's docstring
        # above) — pop it from this *local* merged copy before delegating to
        # ModelSerializer.create(), which would otherwise pass it straight
        # into Board(...) and crash. This does not affect
        # `self.validated_data`: DRF's Serializer.save() builds
        # `{**self.validated_data, **kwargs}` — a new dict — before calling
        # create(), so the view can still read
        # `serializer.validated_data["template"]` after `.save()` returns.
        validated_data.pop("template", None)
        return super().create(validated_data)

    def get_member_count(self, obj) -> int:
        # Use the annotation injected by BoardViewSet.get_queryset() when available
        # to avoid a subquery per board on the list endpoint.
        if hasattr(obj, "_member_count"):
            return obj._member_count
        return obj.memberships.count()

    def get_card_count(self, obj) -> int:
        if hasattr(obj, "_card_count"):
            return obj._card_count
        return obj.cards.count()

    def get_is_starred(self, obj) -> bool:
        if hasattr(obj, "_is_starred"):
            return obj._is_starred
        # _user_favorites is prefetched by get_board_for_user() — use it when present
        # to avoid a live EXISTS query on mutation responses (share, move_group, etc.).
        if hasattr(obj, "_user_favorites"):
            return bool(obj._user_favorites)
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        # Footgun: this live EXISTS query fires when BoardSerializer is used with a bare
        # Board.objects.get() that carries neither annotation. Always fetch boards through
        # BoardViewSet.get_queryset() or get_board_for_user() to avoid the extra query.
        return obj.favorites.filter(user=request.user).exists()


class BoardFullSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = serializers.SerializerMethodField()
    cards = serializers.SerializerMethodField()
    labels = LabelSerializer(many=True, read_only=True)
    members = serializers.SerializerMethodField()
    group_name = serializers.CharField(source="group.name", default=None, read_only=True, allow_null=True)
    group_detail = serializers.SerializerMethodField()
    current_user_role = serializers.SerializerMethodField()
    is_starred = serializers.SerializerMethodField()
    share_token = serializers.SerializerMethodField()
    share_token_expires_at = serializers.SerializerMethodField()
    capabilities = serializers.SerializerMethodField()
    # The board's custom field schema, shipped with the board so the client can
    # render and edit values without a second round trip (#371). Read-only here:
    # definitions are managed through /boards/{id}/custom-fields/, which is
    # admin-gated, while /full/ is readable by every role.
    custom_field_definitions = CustomFieldDefinitionSerializer(many=True, read_only=True)
    # The board's swimlane (row) field schema (#1140), shipped with the board for
    # the same reason as the card schema above: the client renders and edits row
    # values without a second round trip. Read-only here; definitions are managed
    # through the admin-gated /boards/{id}/swimlane-custom-fields/. A definition
    # discloses nothing a board reader does not already have — whether a given
    # row *value* is readable is decided per definition by is_admin_only on the
    # swimlane serializers, not here.
    swimlane_custom_field_definitions = SwimlaneCustomFieldDefinitionSerializer(
        many=True, read_only=True
    )

    class Meta:
        model = Board
        fields = [
            "id", "uid", "name", "description", "owner", "group", "group_name", "group_detail", "columns", "swimlanes",
            "cards", "labels", "members", "custom_field_definitions",
            "swimlane_custom_field_definitions", "staleness_threshold_days", "stale_warning_pct",
            "allowed_priorities", "enforce_wip_limits", "enforce_wip_hard", "enforce_weight_limits", "export_min_role", "card_density", "show_wip_at_limit", "created_at", "updated_at", "current_user_role", "is_starred", "share_token", "share_token_expires_at", "capabilities",
        ]
        read_only_fields = ["uid"]

    @extend_schema_field(GroupBriefSerializer(allow_null=True))
    def get_group_detail(self, obj):
        # See BoardSerializer.get_group_detail — same gating rule (#817).
        if not _expand_requested(self.context, "group") or obj.group_id is None:
            return None
        from groups.serializers import GroupBriefSerializer
        return GroupBriefSerializer(obj.group, context=self.context).data

    def to_representation(self, instance):
        """Pre-compute board-scoped caches before delegating to field serialization.

        Effective member IDs are used by both get_cards() (via
        _get_effective_member_ids) and get_members() for the group-inherited
        membership block. Computing the GroupMembership set once here and
        caching on the board instance avoids a redundant GroupMembership query
        the second time either field accesses the ancestor chain (#695).

        Caches the full GroupMembership rows (with ``select_related("user")``)
        on ``_cached_group_memberships`` so that ``get_members()`` can iterate
        them directly without issuing a second query for the same group_id
        filter (#927).  The user-id set required by ``_get_effective_member_ids``
        is derived from the same list and stored on
        ``_cached_group_member_ids`` to preserve the existing utils.py contract.
        """
        if instance.group_id and not hasattr(instance, "_cached_group_member_ids"):
            from groups.models import GroupMembership as _GM, Group as _Group
            from groups.models import _GROUP_TRAVERSAL_MAX_DEPTH
            group_obj = instance.group
            # Ensure the ancestor chain is loaded — mirrors the guard in
            # get_members() so cold-cache callers don't trigger per-level FK
            # queries during the while-loop below (#650).
            if group_obj.parent_id is not None and "parent" not in group_obj.__dict__:
                _ancestor_related = ["__".join(["parent"] * d) for d in range(1, 7)]
                group_obj = _Group.objects.select_related(*_ancestor_related).get(pk=instance.group_id)
            ancestor_ids = []
            node = group_obj
            depth = 0
            while node and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
                ancestor_ids.append(node.pk)
                node = node.parent
                depth += 1
            if ancestor_ids:
                instance._cached_group_memberships = list(
                    _GM.objects.filter(group_id__in=ancestor_ids).select_related("user")
                )
            else:
                instance._cached_group_memberships = []
            instance._cached_group_member_ids = {
                gm.user_id for gm in instance._cached_group_memberships
            }
        return super().to_representation(instance)

    def get_swimlanes(self, obj):
        """Serialize swimlanes with role-appropriate field exposure.

        Admin and site_admin members see contact_email and notes.
        Member and viewer roles receive the public serializer which omits those fields.

        get_board_role() is used (not a direct memberships lookup) so group-inherited
        admin roles are handled correctly.
        """
        from .permissions import get_board_role, SITE_ADMIN
        from .models import BoardMembership as BM

        request = self.context.get("request")
        role = self.context.get("role")
        if role is None and request and request.user.is_authenticated:
            role = get_board_role(request.user, obj)
        use_admin = role in (BM.Role.ADMIN, SITE_ADMIN)
        serializer_class = SwimlaneAdminSerializer if use_admin else SwimlaneSerializer
        # obj.swimlanes.all() is not prefetched by get_board_for_user, and both
        # serializers now read each value's definition for is_admin_only, so
        # without this the /full/ payload costs 1 + 2N queries in swimlane count
        # (#1140). .all() on the prefetched manager keeps the cache; a .filter()
        # here would escape it.
        lanes = obj.swimlanes.prefetch_related(_swimlane_custom_field_prefetch())
        return serializer_class(lanes, many=True, context=self.context).data

    def get_cards(self, obj):
        """Return only active (non-archived) cards for the board view.

        Archived cards are excluded here; they are fetched separately via the
        /cards/archived/ action when the user opens the archived panel.

        Member IDs and board labels are pre-computed once here and threaded
        through context so CardSerializer.__init__ does not re-query them
        for every card instance (N+1 fix — see #490).

        Site-admin users are pre-fetched here and cached in context so
        get_members() can reuse the same objects without a second identical
        query. ("cards" precedes "members" in Meta.fields so this runs first.)
        """
        from accounts.models import User
        from .utils import _get_effective_member_ids, _get_assignable_member_ids
        # Pre-fetch site admins once; get_members() will read from context.
        site_admin_users = self.context.get("_site_admin_users")
        if site_admin_users is None:
            site_admin_users = list(
                User.objects.filter(can_access_all_content=True).only(
                    "id", "username", "display_name", "avatar_url"
                )
            )
            self.context["_site_admin_users"] = site_admin_users
        site_admin_ids = {u.pk for u in site_admin_users}
        # Compute the stale cutoff once here so _card_queryset can annotate
        # is_stale at the SQL level rather than calling timezone.now() per card
        # in get_is_stale() (#669).
        stale_cutoff = timezone.now() - datetime.timedelta(days=obj.staleness_threshold_days)
        qs = _card_queryset(obj.cards.filter(archived_at__isnull=True), stale_cutoff=stale_cutoff)
        member_ids = _get_effective_member_ids(obj, site_admin_ids=site_admin_ids)
        assignable_ids = _get_assignable_member_ids(obj, site_admin_ids=site_admin_ids)
        # Reuse the labels prefetch loaded by get_board_for_user() rather than
        # issuing a second Label query.  The board must be fetched via
        # get_board_for_user() (which prefetches "labels") for this to hit the
        # cache; a bare Board.objects.get() would fall back to a live query.
        board_labels_qs = obj.labels.all()
        ctx = {**self.context, "board": obj, "_member_ids": member_ids, "_assignable_member_ids": assignable_ids, "_board_labels_qs": board_labels_qs}
        return CardSerializer(qs, many=True, context=ctx).data

    def get_members(self, obj):
        """Return the effective member list for @mention autocomplete and the members panel.

        Combines four sources, in precedence order (first writer wins per user):
          1. Direct BoardMembership rows — authoritative; override any group role.
          2. Group-inherited memberships — walk the group ancestor chain (capped at
             6 levels) and include each user not already seen from step 1.
          3. Board owner — always included as admin even without an explicit row.
          4. Site admins — included so they appear in @mention autocomplete on all boards.

        The ``id`` field is None for inherited/implicit members (they have no
        BoardMembership row on this board).
        """
        # Direct board members keyed by user_id.
        # Use the prefetch loaded by get_board_for_user() when available to avoid
        # a live select_related query on every /full/ request.
        seen = {}
        memberships = getattr(obj, "_prefetched_memberships", None)
        if memberships is None:
            # Footgun: cold-path fallback fires a live select_related query for every
            # member. BoardFullSerializer requires a board fetched via get_board_for_user()
            # so that _prefetched_memberships is populated. A bare Board.objects.get()
            # caller will silently take this path and issue an extra query.
            memberships = list(obj.memberships.select_related("user").all())
        for m in memberships:
            seen[m.user_id] = {"id": m.id, "user": m.user, "role": m.role, "is_moderator": m.is_moderator, "joined_at": m.joined_at}

        # Group-inherited members — collect ancestor group IDs in a single
        # traversal (parent FK only, no memberships fetched yet), then load
        # all group memberships for those IDs in one query instead of one
        # query per ancestor level.
        if obj.group_id:
            # Guard: ensure the full ancestor chain is loaded before traversal.
            # The normal entry point (get_board_for_user) pre-loads up to 6
            # parent levels via select_related("group__parent__parent...") so
            # no extra queries are issued on the happy path.
            # Cold-cache callers (e.g. tests that fetch the board with a bare
            # Board.objects.get()) would otherwise trigger up to 6 live FK
            # queries during the while-loop below — one per unresolved parent
            # FK — which is the N+1 being fixed here (#650).
            # Detect a cold-cache situation by checking whether the group's
            # parent FK has already been resolved in Django's instance cache.
            # If it hasn't, re-fetch the group with the full ancestor chain in
            # a single query before starting the traversal.
            from groups.models import Group as _Group
            group_obj = obj.group
            if group_obj.parent_id is not None and "parent" not in group_obj.__dict__:
                _ancestor_related = ["__".join(["parent"] * d) for d in range(1, 7)]
                group_obj = _Group.objects.select_related(*_ancestor_related).get(pk=obj.group_id)
            ancestor_ids = []
            node = group_obj
            depth = 0
            while node and depth < 6:
                ancestor_ids.append(node.pk)
                node = node.parent
                depth += 1
            if ancestor_ids:
                # Reuse the GroupMembership list pre-fetched by to_representation()
                # rather than re-issuing the same filter+select_related query (#927).
                # The cold-cache fallback (no _cached_group_memberships attribute)
                # only kicks in for callers that bypass to_representation() — e.g.
                # tests or non-standard call paths.
                cached_gms = getattr(obj, "_cached_group_memberships", None)
                if cached_gms is None:
                    from groups.models import GroupMembership
                    cached_gms = list(
                        GroupMembership.objects
                        .filter(group_id__in=ancestor_ids)
                        .select_related("user")
                    )
                for gm in cached_gms:
                    if gm.user_id not in seen:
                        seen[gm.user_id] = {"id": None, "user": gm.user, "role": gm.role, "is_moderator": False, "joined_at": gm.joined_at}

        # Include the board owner if not already present
        if obj.owner_id and obj.owner_id not in seen:
            seen[obj.owner_id] = {"id": None, "user": obj.owner, "role": "admin", "is_moderator": False, "joined_at": obj.created_at}

        # Include users with can_access_all_content so they appear in @mention autocomplete.
        # Reuse the list pre-fetched by get_cards() when available (cached in context so
        # the can_access_all_content query runs at most once per /full/ request — #651/#538).
        # Write back to context on a cold-cache call so repeated get_members() calls
        # (e.g. from tests or non-standard call order) also benefit from the cache.
        site_admin_users = self.context.get("_site_admin_users")
        if site_admin_users is None:
            from accounts.models import User as _User
            site_admin_users = list(
                _User.objects.filter(can_access_all_content=True).only(
                    "id", "username", "display_name", "avatar_url"
                )
            )
            self.context["_site_admin_users"] = site_admin_users
        for u in site_admin_users:
            if u.pk not in seen:
                seen[u.pk] = {"id": None, "user": u, "role": "site_admin", "is_moderator": False, "joined_at": obj.created_at}

        # Hide is_moderator from non-admin viewers (#920).  Resolve the
        # requesting user's role once here rather than in the per-row loop.
        from .permissions import get_board_role, SITE_ADMIN
        viewer_role = self.context.get("role")
        request = self.context.get("request")
        if viewer_role is None and request and request.user.is_authenticated:
            viewer_role = get_board_role(request.user, obj)
        is_admin_viewer = viewer_role in (BoardMembership.Role.ADMIN, SITE_ADMIN)

        result = []
        for entry in seen.values():
            # Use BoardUserSerializer so private per-user fields (notification prefs,
            # UI prefs, can_access_all_content) are not exposed to other board members.
            row = {
                "id": entry["id"],
                "user": BoardUserSerializer(entry["user"], context=self.context).data,
                "role": entry["role"],
                "joined_at": entry["joined_at"],
            }
            if is_admin_viewer:
                row["is_moderator"] = entry["is_moderator"]
            result.append(row)
        return result

    def get_current_user_role(self, obj):
        # Reuse the role already resolved by the view (threaded via context) to
        # avoid a second get_board_role() call on the same request.
        role = self.context.get("role")
        if role is not None:
            return role
        request = self.context.get("request")
        if not request:
            return None
        from .permissions import get_board_role
        return get_board_role(request.user, obj)

    def get_is_starred(self, obj) -> bool:
        # Use the prefetched _user_favorites attr when available (set by
        # get_board_for_user via Prefetch(to_attr="_user_favorites")) to avoid
        # a per-request favorites query on the full board endpoint.
        if hasattr(obj, "_user_favorites"):
            return len(obj._user_favorites) > 0
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        return obj.favorites.filter(user=request.user).exists()

    def _resolved_role(self, obj):
        """Return the current user's role, reading from context or resolving live.

        Both get_share_token and get_share_token_expires_at need the role to
        gate admin-only fields. Centralising the resolution here avoids two
        independent get_board_role() calls per /full/ response when role is
        absent from context.
        """
        from .permissions import get_board_role
        role = self.context.get("role")
        if role is None:
            request = self.context.get("request")
            if request and request.user.is_authenticated:
                role = get_board_role(request.user, obj)
        return role

    def get_share_token(self, obj):
        """Return the share token only to board admins; return null for all other roles.

        The token is a secret credential — exposing it to members/viewers would
        let them share the board publicly without admin intent.
        """
        from .models import BoardMembership as BM
        from .permissions import SITE_ADMIN
        if self._resolved_role(obj) in (BM.Role.ADMIN, SITE_ADMIN):
            return str(obj.share_token) if obj.share_token else None
        return None

    def get_share_token_expires_at(self, obj):
        """Expose the share-link TTL only to board admins; null for all others.

        Mirrors the visibility rules of get_share_token — the expiry timestamp
        is only meaningful alongside the token itself, and both are admin-only
        state.
        """
        from .models import BoardMembership as BM
        from .permissions import SITE_ADMIN
        if self._resolved_role(obj) in (BM.Role.ADMIN, SITE_ADMIN):
            return obj.share_token_expires_at.isoformat() if obj.share_token_expires_at else None
        return None

    def get_capabilities(self, obj):
        """Return feature flags for enterprise-registered extension points.

        OSS always returns False for all keys; enterprise registers backends
        (e.g. MOVEMENT_EXPORT_BACKENDS) to flip the relevant flag.
        """
        from .hooks import MOVEMENT_EXPORT_BACKENDS
        return {"movement_export": bool(MOVEMENT_EXPORT_BACKENDS)}


class CardTimelineEntrySerializer(serializers.Serializer):
    """Read-only serializer for unified card timeline entries (movements + activities).

    Each entry has a common envelope (id, kind, ts, actor, event_type, data) so the
    frontend can render heterogeneous entry types from a single list response.
    """

    id = serializers.IntegerField()
    kind = serializers.CharField()
    ts = serializers.DateTimeField()
    actor = BoardUserSerializer(allow_null=True)
    event_type = serializers.CharField()
    data = serializers.DictField()


class SavedFilterSerializer(serializers.ModelSerializer):
    """Serializer for user-scoped saved filter presets on a board.

    ``state_json`` shape is validated here (not only on the frontend) so
    malformed payloads — including ones constructed by a future board-import
    flow — never reach the database. The validation is intentionally shallow:
    it checks keys and types without enforcing value ranges, so additive
    schema changes don't require an MR to unblock new clients.

    ``state_version`` is optional on write (defaults to 1 for callers that
    predate the versioning scheme) and always present on read. Forward-compat:
    we do not reject ``state_version`` values higher than the current server
    knows about — a mixed-version deploy where a newer client posts v2 to an
    older server would otherwise lose the user's save.
    """

    # Known top-level keys in the v1 FilterState shape. Extra keys are
    # rejected so typos and accidental payload bloat fail loudly rather than
    # piling up as stale state in the DB.
    _STATE_V1_KEYS = {"search", "assigneeIds", "labelIds", "priorities", "dueDate"}
    _STATE_V1_DUE_DATE = {"overdue", "today", "this_week", "none"}
    _STATE_V1_PRIORITIES = {"low", "medium", "high", "urgent"}

    class Meta:
        model = SavedFilter
        fields = ["id", "name", "state_json", "state_version", "created_at"]
        read_only_fields = ["id", "created_at"]
        extra_kwargs = {
            # Keep state_version optional on write so existing clients that
            # don't know about it still succeed; model default (1) fills in.
            "state_version": {"required": False, "default": 1, "min_value": 1},
        }

    def validate_state_json(self, value):
        """Shape check for v1 FilterState. Rejects unknown keys and wrong
        types. Values inside recognized keys get a light type check only —
        the frontend remains responsible for semantic validity (e.g. that
        an assigneeId corresponds to a real user)."""
        if not isinstance(value, dict):
            raise serializers.ValidationError("state_json must be an object.")

        unknown = set(value.keys()) - self._STATE_V1_KEYS
        if unknown:
            raise serializers.ValidationError(
                f"Unknown keys in state_json: {sorted(unknown)}."
            )

        if "search" in value and not isinstance(value["search"], str):
            raise serializers.ValidationError("state_json.search must be a string.")
        for list_key in ("assigneeIds", "labelIds"):
            if list_key in value:
                items = value[list_key]
                if not isinstance(items, list) or not all(isinstance(x, int) and not isinstance(x, bool) for x in items):
                    raise serializers.ValidationError(
                        f"state_json.{list_key} must be a list of integers."
                    )
        if "priorities" in value:
            prios = value["priorities"]
            if not isinstance(prios, list) or not all(p in self._STATE_V1_PRIORITIES for p in prios):
                raise serializers.ValidationError(
                    f"state_json.priorities must be a list with values from {sorted(self._STATE_V1_PRIORITIES)}."
                )
        if "dueDate" in value:
            # None is the "no filter" value in the frontend FilterState type;
            # it round-trips through saved presets so we must accept it here.
            if value["dueDate"] is not None and value["dueDate"] not in self._STATE_V1_DUE_DATE:
                raise serializers.ValidationError(
                    f"state_json.dueDate must be null or one of {sorted(self._STATE_V1_DUE_DATE)}."
                )

        return value


# ---------------------------------------------------------------------------
# Public (unauthenticated) share-link serializers
# ---------------------------------------------------------------------------

class PublicAssigneeSerializer(serializers.Serializer):
    """Minimal user representation for public board views — display_name only.

    Intentionally omits id, username, and email to prevent PII leakage on
    publicly accessible share-link endpoints.
    """
    display_name = serializers.CharField()


class PublicCardSerializer(serializers.ModelSerializer):
    """Read-only card representation for public share-link views.

    Excludes comments, movement history, attachments, and any field that
    could expose PII or sensitive board-internal data.

    Requires the card queryset to be built via PublicBoardSerializer.get_cards()
    which sets up the necessary prefetches (checklist_items, movements) and
    select_related(board) so that no per-card queries are issued.
    """
    labels = LabelSerializer(many=True, read_only=True)
    assignee = PublicAssigneeSerializer(read_only=True)
    checklist_total = serializers.SerializerMethodField()
    checklist_done = serializers.SerializerMethodField()
    last_moved_at = serializers.SerializerMethodField()
    is_stale = serializers.SerializerMethodField()
    blocker_count = serializers.SerializerMethodField()

    class Meta:
        model = Card
        # `blocker_count` is included but the relation *list* deliberately is
        # not (#449). The count discloses nothing new: relations are
        # same-board-only, so every blocker is itself a card this payload
        # already serves in full, and the count is a derived fact over data
        # that is on the wire regardless. The relation rows are a different
        # matter — CardRelation carries `created_by` and `created_at`, and this
        # serializer is a deliberate whitelist that excludes actor identity and
        # timestamps (#926, #371). Anonymous visitors get the blocked signal,
        # not who created the link or when.
        fields = [
            "uid", "column", "swimlane", "title", "priority", "labels",
            "due_date", "weight", "position",
            "checklist_total", "checklist_done", "assignee",
            "last_moved_at", "is_stale", "blocker_count",
        ]

    def get_checklist_total(self, obj):
        # len() on a prefetched relation uses the in-memory cache; .count() does not.
        return len(obj.checklist_items.all())

    def get_checklist_done(self, obj):
        return sum(1 for item in obj.checklist_items.all() if item.is_checked)

    def get_blocker_count(self, obj) -> int:
        # Same helper as CardSerializer so the authenticated and anonymous
        # boards cannot disagree about which blockers count (#449).
        return _blocker_count(obj)

    def get_last_moved_at(self, obj):
        # movements are prefetched ordered by -moved_at; index [0] is the most recent.
        movements = obj.movements.all()
        return movements[0].moved_at if movements else None

    def get_is_stale(self, obj):
        # Read the SQL-level annotation when PublicBoardSerializer.get_cards()
        # passes stale_cutoff (#926) — avoids a per-card timezone.now() branch.
        if hasattr(obj, "_is_stale_annotated"):
            return obj._is_stale_annotated
        # Fallback for cold-cache callers that did not annotate (e.g. tests
        # that build a public card queryset by hand).  obj.board is available
        # via select_related("board") in the public get_cards() prefetch.
        threshold = obj.board.staleness_threshold_days
        cutoff = timezone.now() - datetime.timedelta(days=threshold)
        movements = obj.movements.all()
        if movements:
            return movements[0].moved_at < cutoff
        return (timezone.now() - obj.created_at).days >= threshold


class PublicBoardSerializer(serializers.ModelSerializer):
    """Board payload served to unauthenticated share-link visitors.

    Includes only the data required to render the static read-only board grid.
    Excluded: members list, share_token, swimlane contact_email/notes,
    card comments, card movements, and any user PK/email fields.
    """
    columns = ColumnSerializer(many=True, read_only=True)
    swimlanes = PublicSwimlaneSerializer(many=True, read_only=True)  # no contact_email/notes/custom fields
    labels = LabelSerializer(many=True, read_only=True)
    cards = serializers.SerializerMethodField()

    class Meta:
        model = Board
        # staleness_threshold_days intentionally omitted: it is an internal board
        # configuration value; is_stale is computed server-side so the threshold
        # does not need to be exposed to anonymous share-link visitors.
        fields = ["uid", "name", "columns", "swimlanes", "labels", "cards"]

    def get_cards(self, obj):
        qs = (
            obj.cards
            .filter(archived_at__isnull=True)
            .select_related("assignee", "board")
            .prefetch_related(
                "labels",
                "checklist_items",
                # Ordered newest-first so index [0] gives the most recent movement,
                # matching the logic in get_last_moved_at / get_is_stale.
                Prefetch("movements", queryset=CardMovement.objects.order_by("-moved_at")),
                # Shared with _card_queryset so the public board's blocked
                # indicator matches the authenticated one exactly (#449).
                # Without this the public path would issue one COUNT(*) per
                # card through _blocker_count's cold-path fallback.
                _active_blockers_prefetch(),
            )
        )
        # Annotate is_stale at the SQL level so PublicCardSerializer.get_is_stale()
        # reads a pre-computed boolean rather than calling timezone.now() per
        # card (#926, mirrors CardSerializer at line 524).
        stale_cutoff = timezone.now() - datetime.timedelta(days=obj.staleness_threshold_days)
        qs = _annotate_is_stale(qs, stale_cutoff)
        return PublicCardSerializer(qs, many=True).data
