from drf_spectacular.utils import extend_schema_field
from rest_framework import serializers
from accounts.serializers import BoardUserSerializer
from .models import Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite, _GROUP_TRAVERSAL_MAX_DEPTH

# Schema for the root-first ancestor breadcrumb returned by
# GroupDetailSerializer.get_ancestors (#1119) — a plain list-of-``{id, name}`` dict, not
# the `string` drf-spectacular defaults an unhinted SerializerMethodField to.
_ANCESTOR_LIST_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "name": {"type": "string"},
        },
    },
}

# The priority slugs a group may list in ``allowed_priorities``. One constant so
# the published schema below and ``GroupSerializer.validate_allowed_priorities``
# cannot drift apart — before #1139 the validator held this set inline and the
# schema held no type at all.
#
# Not imported from ``boards`` (where ``Card.Priority`` and the matching
# ``AllowedPrioritiesField`` live): ``boards.serializers`` imports
# ``GroupBriefSerializer`` from this module, and it documents "no import cycle:
# neither groups.serializers nor groups.models imports anything from boards" as
# the invariant that makes that safe. A four-slug list is a much smaller cost
# than breaking it.
_ALLOWED_PRIORITY_SLUGS = ["low", "medium", "high", "urgent"]

# Cap on the *raw* length of a submitted ``allowed_priorities`` list, checked
# before any iteration or set-membership test (#1169, hardening note from the
# post-merge security review of !932 / #1165). The field is a bare JSONField
# with no DRF-level bound, reachable by any authenticated user on
# ``POST /api/v1/groups/`` and by group admins on update, and bounded only by
# nginx ``client_max_body_size`` — a list of a million ``"low"`` strings would
# otherwise validate, get stored, get broadcast in group events, and get
# copied onto every board created in the group (GroupViewSet.boards(),
# ~L550-553). No legitimate client sends anywhere near this many entries; 100
# is a generous multiple of the four valid slugs, chosen as a fixed ceiling
# rather than a multiple of len(valid) so it stays constant if slugs are ever
# added.
_MAX_ALLOWED_PRIORITIES_LENGTH = 100

# Cap on how much of an invalid value is echoed back into a 400 error message.
# Without this, a client sending an oversized invalid string sees that string
# reflected in full (up to the same body-size ceiling as above) in the
# response body (#1169 L2).
_ECHO_TRUNCATE_LENGTH = 50


def _truncate_for_error(value, limit=_ECHO_TRUNCATE_LENGTH):
    """Render a client-supplied value for safe inclusion in a 400 message.

    Uses ``repr()`` rather than manual ``f"'{value}'"`` quoting so a value
    containing a quote or control character can't make the surrounding
    message ambiguous, and truncates first so an oversized string is never
    echoed back in full.
    """
    text = str(value)
    if len(text) > limit:
        text = text[:limit] + "…"
    return repr(text)


@extend_schema_field({
    "type": "array",
    "items": {"type": "string", "enum": _ALLOWED_PRIORITY_SLUGS},
})
class AllowedPrioritiesField(serializers.JSONField):
    """``allowed_priorities`` on :class:`GroupSerializer` (#1139).

    Schema-only subclass, the twin of ``boards.serializers.AllowedPrioritiesField``
    and for the same reason: ``Group.allowed_priorities`` is a model
    ``JSONField``, which drf-spectacular describes with no ``type`` at all, so a
    generated client saw ``unknown``/``any`` for a field the frontend has typed
    ``Priority[]`` all along — while the identical field on ``Board`` published
    its real shape.

    Deliberately not a ``ListField(child=ChoiceField(...))``: that would move
    the "invalid priority" rejection out of
    :meth:`GroupSerializer.validate_allowed_priorities` and into DRF's field
    machinery, changing the 400 body's error shape for existing API callers,
    which the backward-compatibility rules in `CLAUDE.md` forbid.
    """


class GroupLabelSerializer(serializers.ModelSerializer):
    class Meta:
        model = GroupLabel
        fields = ["id", "name", "color"]

    def validate_name(self, value):
        # ``group`` isn't a serializer field — it's injected via serializer.save(group=group)
        # after validation — so DRF can't auto-generate a UniqueTogetherValidator for the
        # model's (group, name) constraint. Without this, a colliding name reaches the DB
        # and surfaces as an uncaught IntegrityError / 500 (#1120) instead of a clean 400.
        group = self.context.get("group")
        if group is not None:
            qs = GroupLabel.objects.filter(group=group, name=value)
            if self.instance is not None:
                qs = qs.exclude(pk=self.instance.pk)
            if qs.exists():
                raise serializers.ValidationError("A label with this name already exists in this group.")
        return value


class GroupBriefSerializer(serializers.ModelSerializer):
    """Minimal Group payload for inline expansion on other resources (#817).

    Used by BoardSerializer / BoardFullSerializer when the caller passes
    ``?expand=group``. Deliberately flat and small to avoid adding N+1 risk
    to list endpoints: no counts, no owner, no labels — just enough to render
    a breadcrumb link without a follow-up request.

    ``ancestors`` is root-first ({id, name}, not including the group itself)
    so callers can render a full relative breadcrumb for the group without
    extra requests (#845).
    """

    # allow_null=True (#1139): a root group has no parent, so `source="parent.name"`
    # resolves to the field-level `default=None` and the response carries
    # `parent_name: null`. Identical to the fix #1119 made on GroupSerializer
    # below — this class was simply missed. Schema-only; the field is read_only.
    parent_name = serializers.CharField(
        source="parent.name", default=None, allow_null=True, read_only=True
    )
    ancestors = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = ["id", "name", "parent", "parent_name", "ancestors"]

    # #1139: an undecorated SerializerMethodField has no inferable return type,
    # so drf-spectacular published this list of {id, name} dicts as `string`.
    # GroupDetailSerializer.get_ancestors already carried this decorator for the
    # same return value; annotating it here is a documentation fix, not a change
    # to what the method returns.
    @extend_schema_field(_ANCESTOR_LIST_SCHEMA)
    def get_ancestors(self, obj):
        # A context-provided ``group_ancestor_map`` (id -> {"name", "parent_id"})
        # lets the caller resolve every ancestor with a single bulk query — used
        # by endpoints that render many boards at once (e.g. descendant_boards)
        # to avoid an N+1 walk. Falls back to ``Group.ancestors()`` otherwise.
        group_map = self.context.get("group_ancestor_map") if self.context else None
        if group_map is not None:
            chain = []
            node_id = obj.parent_id
            depth = 0
            while node_id is not None and depth < _GROUP_TRAVERSAL_MAX_DEPTH:
                entry = group_map.get(node_id)
                if entry is None:
                    break
                chain.append({"id": node_id, "name": entry["name"]})
                node_id = entry.get("parent_id")
                depth += 1
            chain.reverse()
            return chain
        return [{"id": g.id, "name": g.name} for g in reversed(obj.ancestors())]


class GroupSerializer(serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    # allow_null=True: a root group has no parent, so `source="parent.name"` resolves to
    # the field-level `default=None` — declaring the field non-nullable made every
    # top-level group's response fail schema conformance (#1119).
    parent_name = serializers.CharField(
        source="parent.name", default=None, allow_null=True, read_only=True
    )
    member_count = serializers.SerializerMethodField()
    board_count = serializers.SerializerMethodField()
    subgroup_count = serializers.SerializerMethodField()
    shared_labels = GroupLabelSerializer(source="labels", many=True, read_only=True)
    is_starred = serializers.SerializerMethodField()
    # Schema-only declaration — see AllowedPrioritiesField. Mirrors the kwargs
    # DRF derives for the model field (it has a default, so it is not required),
    # so the runtime field behaves exactly as the auto-generated one did.
    allowed_priorities = AllowedPrioritiesField(
        required=False,
        help_text=Group._meta.get_field("allowed_priorities").help_text,
    )

    class Meta:
        model = Group
        fields = [
            "id", "name", "description", "owner", "parent", "parent_name",
            "member_count", "board_count", "subgroup_count", "created_at",
            "default_board_member_role", "allowed_priorities", "shared_labels",
            "is_starred",
        ]
        read_only_fields = ["owner", "created_at", "shared_labels", "is_starred"]

    def get_member_count(self, obj) -> int:
        # Use annotation from GroupViewSet.get_queryset() when available to avoid
        # an extra COUNT query per group in list responses.
        if hasattr(obj, "_member_count"):
            return obj._member_count
        return obj.memberships.count()

    def get_board_count(self, obj) -> int:
        if hasattr(obj, "_board_count"):
            return obj._board_count
        return obj.boards.count()

    def get_subgroup_count(self, obj) -> int:
        if hasattr(obj, "_subgroup_count"):
            return obj._subgroup_count
        return obj.subgroups.count()

    def get_is_starred(self, obj) -> bool:
        if hasattr(obj, "_is_starred"):
            return obj._is_starred
        request = self.context.get("request")
        if not request or not request.user.is_authenticated:
            return False
        # Footgun: live query fires when _is_starred annotation is absent (i.e. the group
        # was not fetched through GroupViewSet.get_queryset()). Always use get_queryset()
        # to ensure the annotation is present and avoid a per-group EXISTS query.
        return GroupFavorite.objects.filter(user=request.user, group=obj).exists()

    def validate_allowed_priorities(self, value):
        valid = set(_ALLOWED_PRIORITY_SLUGS)
        # The field is a bare JSONField, so ``value`` is whatever JSON the client
        # sent. Without this guard an int/dict/bool is not iterable and a nested
        # list/dict item is unhashable in the ``in valid`` test below — both raise
        # TypeError, which surfaces as a 500 instead of a 400 (#1165).
        if not isinstance(value, list):
            raise serializers.ValidationError("Expected a list of priority strings.")
        # Reject an absurdly long list before iterating it at all (#1169 L1) —
        # see _MAX_ALLOWED_PRIORITIES_LENGTH above for why. This must run
        # before the per-item loop so the cost of rejecting is O(1), not O(n).
        if len(value) > _MAX_ALLOWED_PRIORITIES_LENGTH:
            raise serializers.ValidationError(
                "allowed_priorities may have at most "
                f"{_MAX_ALLOWED_PRIORITIES_LENGTH} entries."
            )
        # De-duplicate, preserving first-occurrence order. A request with
        # duplicates validated and stored as-is before this change (backward
        # compatibility — CLAUDE.md), so it must keep returning 200 rather
        # than start rejecting; only the *stored* list shrinks, which also
        # bounds it by len(_ALLOWED_PRIORITY_SLUGS) regardless of how many
        # times a client repeats one entry (#1169 L1).
        seen = set()
        deduped = []
        for p in value:
            if not isinstance(p, str):
                raise serializers.ValidationError(
                    "Every priority must be a string. "
                    f"Choose from: {', '.join(sorted(valid))}."
                )
            if p not in valid:
                # Truncate before echoing — an invalid value can be up to the
                # same size as the request body (#1169 L2).
                raise serializers.ValidationError(
                    f"{_truncate_for_error(p)} is not a valid priority. "
                    f"Choose from: {', '.join(sorted(valid))}."
                )
            if p not in seen:
                seen.add(p)
                deduped.append(p)
        return deduped

    def validate_default_board_member_role(self, value):
        valid = {c[0] for c in Group.DefaultMemberRole.choices}
        if value not in valid:
            raise serializers.ValidationError(
                f"'{value}' is not a valid role. Choose from: {', '.join(sorted(valid))}."
            )
        return value


class GroupMembershipSerializer(serializers.ModelSerializer):
    user = BoardUserSerializer(read_only=True)
    # is_inherited and inherited_from are not model fields — they are set
    # dynamically by the members action in GroupViewSet when building the
    # combined direct + inherited membership list. Declared here so that
    # drf-spectacular generates an accurate schema for the members endpoint.
    is_inherited = serializers.BooleanField(read_only=True, required=False)
    inherited_from = serializers.CharField(read_only=True, required=False, allow_null=True)

    class Meta:
        model = GroupMembership
        fields = ["id", "user", "role", "joined_at", "is_inherited", "inherited_from"]


class GroupDetailSerializer(GroupSerializer):
    """Extended serializer for the group retrieve endpoint.

    Adds an `ancestors` field (root-first list of {id, name} dicts) so the
    frontend can render a full ancestor breadcrumb chain without extra requests.
    This field is intentionally absent from the list serializer to avoid N+1
    queries when returning many groups at once.
    """

    ancestors = serializers.SerializerMethodField()

    class Meta(GroupSerializer.Meta):
        fields = GroupSerializer.Meta.fields + ["ancestors"]
        read_only_fields = list(GroupSerializer.Meta.read_only_fields) + ["ancestors"]

    @extend_schema_field(_ANCESTOR_LIST_SCHEMA)
    def get_ancestors(self, obj):
        # ancestors() returns [immediate_parent, grandparent, …, root].
        # Reverse so the breadcrumb renders root-first (left-to-right).
        return [{"id": g.id, "name": g.name} for g in reversed(obj.ancestors())]


class GroupInviteLinkSerializer(serializers.ModelSerializer):
    is_expired = serializers.BooleanField(read_only=True)
    status = serializers.CharField(read_only=True)
    # Audit field (#1008) — matches AdminInviteLink.created_by_username so
    # group admins can see who created an invite link, parity with the
    # admin-level invite UI.  Use a CharField with source so we don't have
    # to nest a User serializer for one string.
    created_by_username = serializers.CharField(source="created_by.username", read_only=True, default=None)

    class Meta:
        model = GroupInviteLink
        fields = [
            "id", "prefix", "is_active", "created_at", "created_by_username", "name", "role",
            "expires_at", "is_expired", "single_use", "used_at", "status",
        ]
        read_only_fields = ["id", "prefix", "is_active", "created_at", "created_by_username", "is_expired", "single_use", "used_at", "status"]


class GroupInviteLinkCreateSerializer(serializers.Serializer):
    """Validates input for creating a new GroupInviteLink."""

    name = serializers.CharField(max_length=100, required=False, default="", allow_blank=True)
    role = serializers.ChoiceField(
        choices=GroupInviteLink.Role.choices,
        required=False,
        default=GroupInviteLink.Role.MEMBER,
    )
    expiry_days = serializers.IntegerField(required=False, allow_null=True, default=None, min_value=1)
    single_use = serializers.BooleanField(required=False, default=False)
