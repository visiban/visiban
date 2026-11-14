from django.db.models import Manager
from drf_spectacular.utils import extend_schema_field, extend_schema_serializer
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from accounts.serializers import BoardUserSerializer
from visiban import field_enforcement
from visiban.colors import ColorValidationMixin
from visiban.utils import MAX_ALLOWED_PRIORITIES_LENGTH, check_allowed_priorities_length
from visiban.invite_email import InviteEmailField
from visiban.query_fallbacks import fk_chain_loaded, note_fallback
from .models import (
    HEALTH_NOTE_MAX_LENGTH,
    Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite,
    _GROUP_TRAVERSAL_MAX_DEPTH, user_has_group_access,
    user_is_group_admin,
)
from .health import HealthStatus, build_health_map, resolve_health, valid_health_status

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
#
# The value itself lives in ``visiban.utils`` (#1186) — shared with
# ``boards.serializers``' identical cap, which independently duplicated this
# same constant after #1169 with nothing keeping the two in sync. Re-exported
# under this module's original private name because ``groups/views.py``
# imports it from here (``_sanitize_group_allowed_priorities``); do not
# rename without updating that import too.
_MAX_ALLOWED_PRIORITIES_LENGTH = MAX_ALLOWED_PRIORITIES_LENGTH

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


def _parent_name_for_group(group) -> str | None:
    """Shared by GroupSerializer.get_parent_name (and GroupDetailSerializer, which
    inherits it).

    A SerializerMethodField, not a dotted-source ``CharField(source="parent.name",
    default=None)`` — DRF's ``Field.get_default()`` raises ``SkipField()``
    unconditionally whenever the root serializer is bound ``partial=True``,
    regardless of whether ``default`` is set. A dotted source through a nullable
    ``parent`` FK falls back to ``get_default()`` to resolve the ``None``
    traversal, so on every ``PATCH`` (``GroupViewSet.update`` with ``partial=True``, and
    ``board_defaults``, both of which bind ``GroupSerializer(..., partial=True)``)
    the field silently vanished from the response instead of serializing as
    ``null`` for a top-level group (#1225 — same mechanism as #1166's
    ``BoardSerializer.group_name`` and #1189's ``BoardFullSerializer.group_name``;
    see ``boards.serializers._group_name_for_board``). A
    ``SerializerMethodField`` calls the method directly and never consults
    ``get_default()``, so it is immune to it.

    ``group.parent_id`` reads the already-loaded FK column (no query); when it
    is set, ``group.parent`` resolves from the ``select_related("parent", ...)``
    chain every caller of ``GroupSerializer`` already loads
    (``GroupViewSet.get_queryset``), so this never issues an extra query.
    """
    return group.parent.name if group.parent_id else None


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


# One message, with DRF's own error code, for both an unknown parent id and a
# parent the caller may not use, so the two update responses are identical.
_PARENT_NOT_ALLOWED = "Select a parent group you administer."
_MOVE_REQUIRES = (
    "Only the group owner or an admin of a parent group can change this group's parent."
)

# Same ancestor depth GroupViewSet.get_queryset() loads, so walking a parent's
# chain reads already-loaded objects instead of one lazy query per level.
_PARENT_CHAIN_RELATED = ["__".join(["parent"] * d) for d in range(1, _GROUP_TRAVERSAL_MAX_DEPTH + 1)]


def _parent_not_allowed():
    return serializers.ValidationError(_PARENT_NOT_ALLOWED, code="does_not_exist")


# Stand-in for a ``parent`` id that does not resolve to a group. It never
# reaches save(): ``GroupSerializer.validate_parent`` always raises for it, on
# create and update alike, so it answers like a parent the caller may not use.
_UNKNOWN_PARENT = object()


class ParentGroupField(serializers.PrimaryKeyRelatedField):
    """``parent`` on :class:`GroupSerializer`.

    An id that does not resolve to a group is passed on as ``_UNKNOWN_PARENT``
    so ``GroupSerializer.validate_parent`` answers it exactly as it answers a
    group the caller may not use. On update that is 403 when the caller may
    not change this group's parent at all, otherwise the 400 body (message and
    code) shared with create.
    """

    def to_internal_value(self, data):
        try:
            return super().to_internal_value(data)
        except serializers.ValidationError as exc:
            if exc.get_codes() == ["does_not_exist"]:
                return _UNKNOWN_PARENT
            raise


def _ancestor_chain(parent):
    """[parent, grandparent, ...] up to the root, capped at the traversal depth.

    Returns ``(chain, reached_root)``; ``reached_root`` is False when the walk
    stopped at the cap with ancestors remaining.
    """
    chain = []
    node = parent
    while node is not None and len(chain) < _GROUP_TRAVERSAL_MAX_DEPTH:
        chain.append(node)
        node = node.parent
    return chain, node is None


def _subtree_height(group, limit):
    """Levels of subgroups below ``group``, counting at most ``limit + 1`` levels.

    One query per level, bounded by ``limit``; a result above ``limit`` means
    "deeper than allowed" without walking the rest of the subtree.
    """
    frontier = [group.pk]
    seen = {group.pk}
    for height in range(limit + 1):
        children = list(
            Group.objects.filter(parent_id__in=frontier)
            .exclude(pk__in=seen)
            .values_list("pk", flat=True)
        )
        if not children:
            return height
        seen.update(children)
        frontier = children
    return limit + 1


HEALTH_STATUS_HELP = (
    "This entity's own health status, or null to inherit from the nearest "
    "group above it that sets one (#1133). Writable by the same role that "
    "edits the entity's other settings."
)
_EFFECTIVE_HEALTH_STATUS_HELP = (
    "The health status that applies: health_status when set, otherwise the "
    "value of the nearest ancestor group that sets one (at most six groups "
    "up), otherwise null. Computed on every read, so a group change reaches "
    "every descendant that does not set its own value."
)
_HEALTH_STATUS_SOURCE_HELP = (
    "The group that supplies effective_health_status, as {id, name}. Null "
    "when health_status is set on this entity itself, or when no ancestor "
    "sets one."
)


_HEALTH_CHANGED_AT_HELP = (
    "When this entity's own health_status was last set or confirmed (#2242), "
    "or null if never recorded (including a status set before history existed)."
)
_HEALTH_CHANGED_BY_HELP = (
    "Who last set or confirmed this entity's own health_status (#2242), or "
    "null for a removed account, a system change, or no recorded change."
)
_HEALTH_NOTE_HELP = (
    "The optional note given with the last set or confirm (#2242), at most "
    "280 characters, or null."
)

#: The three read-only last-change fields (#2242), for Meta.fields lists.
HEALTH_HISTORY_FIELDS = ["health_status_changed_at", "health_status_changed_by", "health_status_note"]


class HealthStatusSourceSerializer(serializers.Serializer):
    """Schema of ``health_status_source`` (#1133): the ancestor group supplying the value."""

    id = serializers.IntegerField(read_only=True)
    name = serializers.CharField(read_only=True)
    changed_at = serializers.DateTimeField(
        read_only=True, allow_null=True,
        help_text="When the source group's own status was last set (#2242); null if never recorded.",
    )


class HealthStatusListSerializer(serializers.ListSerializer):
    """List serializer that resolves every row's effective health in one batch.

    Before serializing, collects where each row's ancestor walk starts and
    builds one shared ``id -> node`` map (``build_health_map``): loaded
    ``parent`` chains cost nothing and the rest costs one query for the whole
    list. Without this each row would walk its own chain (#1133, no N+1).
    """

    def to_representation(self, data):
        iterable = data.all() if isinstance(data, Manager) else data
        items = list(iterable)
        self.child.prime_health_map(items)
        return [self.child.to_representation(item) for item in items]


# ``health_status``, ``effective_health_status`` and ``health_status_source``
# (#1133), shared by the board and group serializers so the three fields, their
# validation and their resolution are written once. A subclass supplies
# ``_health_start(obj)``: where the ancestor walk begins when ``obj`` sets no
# value of its own (a board's group, a group's parent), as
# ``(loaded_group_or_None, group_id)``. Set
# ``Meta.list_serializer_class = HealthStatusListSerializer`` so lists resolve
# in one batch.
#
# No docstring on purpose: drf-spectacular publishes the first docstring in a
# serializer's MRO as its component description, and Board/Group have none.
class HealthStatusFieldsMixin(serializers.Serializer):

    # Choices enforced here, at the boundary, not with a database constraint.
    health_status = serializers.ChoiceField(
        choices=HealthStatus.choices, allow_null=True, required=False,
        help_text=HEALTH_STATUS_HELP,
    )
    effective_health_status = serializers.SerializerMethodField(help_text=_EFFECTIVE_HEALTH_STATUS_HELP)
    health_status_source = serializers.SerializerMethodField(help_text=_HEALTH_STATUS_SOURCE_HELP)
    # Last change of this entity's own health_status (#2242). Read-only: only
    # groups.health_history writes them. Null when never recorded.
    health_status_changed_at = serializers.DateTimeField(
        read_only=True, allow_null=True, help_text=_HEALTH_CHANGED_AT_HELP,
    )
    health_status_changed_by = BoardUserSerializer(
        read_only=True, allow_null=True, help_text=_HEALTH_CHANGED_BY_HELP,
    )
    health_status_note = serializers.CharField(
        read_only=True, allow_null=True, help_text=_HEALTH_NOTE_HELP,
    )

    def _health_start(self, obj):  # pragma: no cover - abstract
        raise NotImplementedError

    def prime_health_map(self, items):
        """Build one ancestor map for every row of a list (see HealthStatusListSerializer)."""
        self._health_map = build_health_map(
            self._health_start(obj) for obj in items
            if not valid_health_status(obj.health_status)
        )

    def _health(self, obj):
        # Memoized per serializer for the two method fields of one row. Keyed
        # by the inputs, not just the pk, so a row re-serialized after a write
        # in the same request is never answered from a stale entry.
        start = self._health_start(obj)
        key = (obj.pk, obj.health_status, start[1])
        cache = self.__dict__.setdefault("_health_cache", {})
        if key not in cache:
            health_map = self.__dict__.get("_health_map")
            if health_map is None:
                health_map = {} if valid_health_status(obj.health_status) else build_health_map([start])
            cache[key] = resolve_health(obj.health_status, start[1], health_map)
        return cache[key]

    @extend_schema_field(serializers.ChoiceField(choices=HealthStatus.choices, allow_null=True))
    def get_effective_health_status(self, obj):
        return self._health(obj)[0]

    @extend_schema_field(HealthStatusSourceSerializer(allow_null=True))
    def get_health_status_source(self, obj):
        return self._health(obj)[1]


def full_group_access(group):
    """``group_access`` context value for a caller already cleared for full detail.

    ``GroupSerializer`` withholds non-navigation fields unless it can tell the
    viewer may see them (see ``GroupSerializer._is_navigation_only``). Pass
    this only where the code has already established that every recipient of
    the payload is a member or admin of the group, and say why at the call.
    """
    return True


class GroupLabelSerializer(ColorValidationMixin, serializers.ModelSerializer):
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
    # A SerializerMethodField, not a dotted-source CharField with default=None —
    # see _parent_name_for_group() for the partial=True SkipField trap (#1226,
    # same mechanism as #1166/#1225). Dormant here today (never bound partial),
    # converted so a future partial bind cannot silently drop the key.
    parent_name = serializers.SerializerMethodField(allow_null=True)
    ancestors = serializers.SerializerMethodField()

    class Meta:
        model = Group
        fields = ["id", "name", "parent", "parent_name", "ancestors"]

    def get_parent_name(self, obj) -> str | None:
        return _parent_name_for_group(obj)

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


# default_board_member_role (#1430) and allowed_priorities (#1429) are
# deprecated: kept for API compatibility (1.0 contract forbids removing a
# serializer field), flagged in the schema.
@extend_schema_serializer(deprecate_fields=["default_board_member_role", "allowed_priorities"])
class GroupSerializer(HealthStatusFieldsMixin, serializers.ModelSerializer):
    owner = BoardUserSerializer(read_only=True)
    # A SerializerMethodField, not `CharField(source="parent.name", default=None)`
    # — see _parent_name_for_group() above for why the dotted-source form
    # silently drops the field from PATCH responses for a top-level group
    # (#1225). allow_null=True: a root group has no parent, so the method
    # returns None — declaring the field non-nullable made every top-level
    # group's response fail schema conformance (#1119).
    parent_name = serializers.SerializerMethodField(allow_null=True)
    member_count = serializers.SerializerMethodField()
    board_count = serializers.SerializerMethodField()
    subgroup_count = serializers.SerializerMethodField()
    shared_labels = GroupLabelSerializer(source="labels", many=True, read_only=True)
    is_starred = serializers.SerializerMethodField()
    navigation_only = serializers.SerializerMethodField(
        help_text=(
            "True when the requesting user has no access to this group itself "
            "(no membership in it or in one of its ancestors within the capped "
            "walk) and it is returned only so navigation (tree, breadcrumbs) "
            "keeps working, e.g. an ancestor of a group they belong to. Fields "
            "are withheld: description is empty, shared_labels and "
            "allowed_priorities are empty arrays, and the counts are 0."
        ),
    )
    can_place_boards = serializers.SerializerMethodField(
        help_text=(
            "True when the requesting user may place a board in this group "
            "(create, move or import a board into it): they are a group admin "
            "of it or of one of its ancestors, or have can_access_all_content. "
            "Same predicate the server enforces on those writes."
        ),
    )
    # Schema-only declaration — see AllowedPrioritiesField. Mirrors the kwargs
    # DRF derives for the model field (it has a default, so it is not required),
    # so the runtime field behaves exactly as the auto-generated one did.
    allowed_priorities = AllowedPrioritiesField(
        required=False,
        help_text=field_enforcement.GROUP_ALLOWED_PRIORITIES,
    )
    # Same kwargs ModelSerializer derives for the nullable FK; see
    # ParentGroupField for how an unresolvable id is answered.
    parent = ParentGroupField(
        queryset=Group.objects.all(), allow_null=True, required=False,
    )

    class Meta:
        model = Group
        fields = [
            "id", "name", "description", "owner", "parent", "parent_name",
            "member_count", "board_count", "subgroup_count", "created_at",
            "default_board_member_role", "allowed_priorities", "shared_labels",
            "is_starred", "navigation_only", "can_place_boards",
            "health_status", "effective_health_status", "health_status_source",
            *HEALTH_HISTORY_FIELDS,
        ]
        read_only_fields = [
            "owner", "created_at", "shared_labels", "is_starred", "navigation_only",
            "can_place_boards",
        ]
        list_serializer_class = HealthStatusListSerializer
        # Schema-only (#1077): see visiban/field_enforcement.py.
        extra_kwargs = {
            "default_board_member_role": {
                "help_text": field_enforcement.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
            },
        }

    def get_parent_name(self, obj) -> str | None:
        return _parent_name_for_group(obj)

    def _health_start(self, obj):
        # A group inherits from its parent. ``GroupViewSet`` loads the parent
        # chain with select_related, so the walk usually reads loaded rows.
        parent_field = Group._meta.get_field("parent")
        return (obj.parent if obj.parent_id and parent_field.is_cached(obj) else None, obj.parent_id)

    # Fields withheld from a navigation-only group, with the empty value each
    # one takes. The keys stay in the response, with empty values of their
    # declared types, rather than being dropped: the TypeScript ``Group``
    # interface and schema-generated clients treat every one as required, and
    # removing or retyping a response field is a breaking change (CLAUDE.md,
    # backward compatibility). ``navigation_only`` tells a client that these
    # values are withheld, not real zeros. ``owner``, ``created_at``,
    # ``parent``/``parent_name``, ``ancestors`` and ``is_starred`` (the
    # caller's own flag) stay: the sidebar tree and breadcrumbs use them.
    # ``owner`` (BoardUserSerializer: id, username, display_name, avatar_url;
    # no email) stays because the client's ``Group`` type requires it, and an
    # ancestor's owner normally holds an admin membership there (member
    # removal and demotion now refuse the owner), so they already appear as an
    # inherited member of the caller's own group.
    # ``default_board_member_role`` stays too: it is a
    # required enum in the client contract (no empty value of its type
    # exists), it is deprecated with no effect (#1430), and it is
    # non-sensitive ancestor configuration.
    _NAVIGATION_ONLY_EMPTY = {
        "description": "",
        "member_count": 0,
        "board_count": 0,
        "subgroup_count": 0,
        "allowed_priorities": [],
        "shared_labels": [],
        # Health (#1133) is the group's own configuration, withheld like its
        # description. Null is the declared empty value of all three.
        "health_status": None,
        "effective_health_status": None,
        "health_status_source": None,
        "health_status_changed_at": None,
        "health_status_changed_by": None,
        "health_status_note": None,
    }

    def _is_navigation_only(self, obj) -> bool:
        """True when the viewer has no membership-based access to ``obj`` itself.

        That is: no membership on ``obj`` or on one of its ancestors within the
        capped walk, and no ``can_access_all_content`` bypass. Such a group is
        returned for navigation only, with its fields withheld; this includes a
        group the caller owns without being a member of it.

        ``get_accessible_group_ids`` lists ancestors so the sidebar can show the
        path to a user's subgroup, but access inherits downward only
        (``user_has_group_access``): a subgroup-only member gets 403 on the
        ancestor's members, boards and labels routes and is not subscribed to
        its WebSocket channel (#1656). The group payload follows the same rule.

        The view passes ``group_access`` (``group_access_resolver``) in the
        context so a list costs one membership query in total. A caller that
        has already authorized the viewer for full detail (a group admin on a
        write path, a broadcast to the group's own channel) passes
        ``full_group_access`` instead. Without ``group_access`` the
        single-group predicate runs for an authenticated request user (one
        query). With neither, there is no viewer to judge, so the fields are
        withheld: a serializer built without context fails closed.
        """
        # Memoized per serializer (a ``many=True`` list reuses one child), not
        # on ``obj``: the answer depends on the viewer, and one instance may be
        # serialized for another viewer's context.
        cache = self.__dict__.setdefault("_navigation_only_cache", {})
        if obj.pk in cache:
            return cache[obj.pk]
        context = self.context or {}
        has_access = context.get("group_access")
        if has_access is not None:
            result = not has_access(obj)
        else:
            request = context.get("request")
            user = getattr(request, "user", None)
            if user is None or not user.is_authenticated:
                result = True
            else:
                result = not user_has_group_access(user, obj)
        cache[obj.pk] = result
        return result

    def get_navigation_only(self, obj) -> bool:
        return self._is_navigation_only(obj)

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if self._is_navigation_only(instance):
            for key, empty in self._NAVIGATION_ONLY_EMPTY.items():
                if key in data:
                    # A fresh copy of a mutable empty; None is used as is.
                    data[key] = None if empty is None else type(empty)(empty)
        return data

    def get_can_place_boards(self, obj) -> bool:
        """The caller's board-placement right on ``obj`` (#1692).

        Uses ``user_is_group_admin`` (via its bulk form when the view passes
        ``group_admin`` = ``group_admin_resolver`` in the context), the same
        predicate ``_require_group_admin`` enforces on board create, move and
        import, so the flag and the enforcement cannot drift. Without a
        resolver the single-group predicate runs for an authenticated request
        user (one query); with no viewer it fails closed.
        """
        context = self.context or {}
        is_admin = context.get("group_admin")
        if is_admin is not None:
            return bool(is_admin(obj))
        request = context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            return False
        return user_is_group_admin(user, obj)

    def get_member_count(self, obj) -> int:
        # Use annotation from GroupViewSet.get_queryset() when available to avoid
        # an extra COUNT query per group in list responses.
        if hasattr(obj, "_member_count"):
            return obj._member_count
        note_fallback(self, "get_member_count")
        return obj.memberships.count()

    def get_board_count(self, obj) -> int:
        if hasattr(obj, "_board_count"):
            return obj._board_count
        note_fallback(self, "get_board_count")
        return obj.boards.count()

    def get_subgroup_count(self, obj) -> int:
        if hasattr(obj, "_subgroup_count"):
            return obj._subgroup_count
        note_fallback(self, "get_subgroup_count")
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
        note_fallback(self, "get_is_starred")
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
        # Shared with BoardSerializer's identical check (#1186).
        check_allowed_priorities_length(value)
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

    def validate_parent(self, value):
        """Check ``parent`` on create, or a change of it on an existing group.

        On create the caller must administer the parent (directly or through an
        ancestor); an unknown id and a parent the caller may not use get the
        same 400 body, matching update and the board ``group`` field (#1691).
        ``GroupViewSet.perform_create`` still enforces the admin check as a
        backstop. A new subgroup may not sit deeper than
        ``_GROUP_TRAVERSAL_MAX_DEPTH`` levels (400), the same bound a parent
        change enforces (#1690). On update this applies the rules in
        ``_check_parent_change`` to the instance the serializer was bound to.
        ``GroupViewSet.perform_update`` applies them
        again to the row re-read under its lock (``recheck_parent_under_lock``)
        before saving.
        """
        if self.instance is None:
            if value is None:
                return value
            user = getattr(self.context.get("request"), "user", None)
            parent = (
                None
                if value is _UNKNOWN_PARENT
                else Group.objects.select_related(*_PARENT_CHAIN_RELATED).filter(pk=value.pk).first()
            )
            if parent is None or user is None or not user_is_group_admin(user, parent):
                raise _parent_not_allowed()
            # The same bound a parent change enforces (#1690): the new leaf
            # sits at level len(chain) + 1, so a parent already
            # _GROUP_TRAVERSAL_MAX_DEPTH levels deep (or deeper than the walk
            # reaches) leaves no room. Reuses the chain loaded above.
            self._check_create_depth(parent)
            return value
        self._check_parent_change(value, self.instance)
        return value

    def _check_parent_change(self, value, group):
        """Raise unless the caller may set ``group.parent`` to ``value``.

        The view has already required group admin on ``group``. A value equal
        to the current parent is not a change. Otherwise, in this order:

        - Any change of parent (to another group or to top level) requires the
          group owner, an admin of one of the group's current ancestors, or
          ``can_access_all_content`` (403): admin on the group alone does not
          confer authority over its place in the tree. A top-level group has
          no ancestors, so only its owner (or ``can_access_all_content``) may
          move it.
        - Moving under a new parent also requires admin on that parent (or one
          of its ancestors), the same check create applies, because the moved
          subtree inherits the new parent chain's roles. A parent the caller
          may not use answers like an unknown id: 400 on ``parent``.
        - The new parent may not be the group or one of its subgroups, and the
          resulting tree may not be deeper than ``_GROUP_TRAVERSAL_MAX_DEPTH``
          levels, the depth every ancestor walk covers (400).

        Under ``recheck_parent_under_lock`` ``group`` is the reloaded, locked
        row, so every rule is evaluated against its current owner and parent.
        """
        unknown = value is _UNKNOWN_PARENT
        if not unknown:
            new_parent_id = value.pk if value is not None else None
            if new_parent_id == group.parent_id:
                return

        request = self.context.get("request")
        user = getattr(request, "user", None)
        if user is None or not user.is_authenticated:
            raise PermissionDenied(_MOVE_REQUIRES)

        if not (
            getattr(user, "can_access_all_content", False)
            or group.owner_id == user.pk
            or (group.parent is not None and user_is_group_admin(user, group.parent))
        ):
            raise PermissionDenied(_MOVE_REQUIRES)

        if value is None:
            return
        if unknown:
            raise _parent_not_allowed()

        parent = Group.objects.select_related(*_PARENT_CHAIN_RELATED).filter(pk=value.pk).first()
        if parent is None or not user_is_group_admin(user, parent):
            raise _parent_not_allowed()

        chain, reached_root = _ancestor_chain(parent)
        if any(g.pk == group.pk for g in chain):
            raise serializers.ValidationError(
                "A group cannot be moved under itself or one of its subgroups."
            )
        # The moved group sits at level len(chain) + 1; its subgroups add
        # their own height below it.
        room_below = _GROUP_TRAVERSAL_MAX_DEPTH - (len(chain) + 1)
        if not reached_root or room_below < 0 or _subtree_height(group, room_below) > room_below:
            raise serializers.ValidationError(
                f"Groups can be nested at most {_GROUP_TRAVERSAL_MAX_DEPTH} levels deep."
            )

    @staticmethod
    def _check_create_depth(parent):
        """Refuse a new subgroup under ``parent`` when it would exceed the depth cap (#1690)."""
        chain, reached_root = _ancestor_chain(parent)
        # `not reached_root` is a defensive guard in case the walk cap and
        # the depth cap ever diverge; today `len(chain) + 1 > cap` covers it.
        if not reached_root or len(chain) + 1 > _GROUP_TRAVERSAL_MAX_DEPTH:
            raise serializers.ValidationError(
                f"Groups can be nested at most {_GROUP_TRAVERSAL_MAX_DEPTH} levels deep."
            )

    def recheck_create_parent_under_lock(self, parent):
        """Lock a new subgroup's parent chain, reload the parent, re-check the depth.

        Call inside ``transaction.atomic()`` before ``save()``. validate_parent
        judged a snapshot read before the lock; a concurrent move of the
        parent or one of its ancestors (which holds the moved group's row)
        could deepen the chain after that. The chain is locked in one
        pk-ordered statement, the same shape ``recheck_parent_under_lock``
        uses, so a create and a move serialize without lock-order inversion,
        then the depth is judged again on the reloaded parent. Returns the
        reloaded, chain-loaded parent.

        Limitation: only the ancestors read before the lock are locked. If one
        of them is moved while this request waits, the new ancestors above it
        are not locked, so a move that lands entirely in that gap can still
        deepen the chain after the re-check. The re-check closes the common
        window (a move committing between validation and save), not this one.
        """
        chain, _ = _ancestor_chain(parent)
        list(
            Group.objects.select_for_update()
            .filter(pk__in={g.pk for g in chain})
            .order_by("pk")
            .values_list("pk", flat=True)
        )
        fresh = Group.objects.select_related(*_PARENT_CHAIN_RELATED).filter(pk=parent.pk).first()
        if fresh is None:
            # Deleted while this create queued on the chain lock (#1719): the
            # same {"parent": [...]} 400 validate_parent gives an unknown id.
            raise serializers.ValidationError({"parent": _parent_not_allowed().detail})
        try:
            self._check_create_depth(fresh)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"parent": exc.detail})
        return fresh

    def recheck_parent_under_lock(self, group):
        """Lock ``group`` (and a requested new parent's chain), reload it, re-check.

        Call inside ``transaction.atomic()`` before ``save()``. validate_parent
        judged the snapshot read before the lock; another request may have
        changed this group's parent, or the new parent's chain, since. The
        group row and the new parent's ancestor rows are locked in one
        pk-ordered statement, so two requests moving groups in the same chain
        are serialized without lock-order inversion; every decision is then
        made again against the reloaded state. Reloading also keeps ``save()``
        from writing a stale ``parent`` back when the request did not send one.
        """
        lock_ids = {group.pk}
        value = self.validated_data.get("parent")
        if isinstance(value, Group):
            current = Group.objects.select_related(*_PARENT_CHAIN_RELATED).filter(pk=value.pk).first()
            if current is not None:
                lock_ids |= {g.pk for g in _ancestor_chain(current)[0]}
        locked = set(
            Group.objects.select_for_update()
            .filter(pk__in=lock_ids)
            .order_by("pk")
            .values_list("pk", flat=True)
        )
        if group.pk not in locked:
            # Deleted while this request queued on the lock (#1719): 404, not
            # the DoesNotExist (a 500) refresh_from_db would raise.
            from rest_framework.exceptions import NotFound

            raise NotFound
        group.refresh_from_db()
        if "parent" not in self.validated_data:
            return
        try:
            self._check_parent_change(self.validated_data["parent"], group)
        except serializers.ValidationError as exc:
            raise serializers.ValidationError({"parent": exc.detail})


class GroupMembershipSerializer(serializers.ModelSerializer):
    user = BoardUserSerializer(read_only=True)
    # is_inherited and inherited_from are not model fields — they are set
    # dynamically by the members action in GroupViewSet when building the
    # combined direct + inherited membership list. Declared here so that
    # drf-spectacular generates an accurate schema for the members endpoint.
    is_inherited = serializers.BooleanField(read_only=True, required=False)
    inherited_from = serializers.CharField(read_only=True, required=False, allow_null=True)
    # An inherited row (see is_inherited above) has no real membership behind
    # it, so the members action sets id=None for those entries (#1294). The
    # auto-generated PK field is otherwise non-nullable, which would
    # understate the real response — declared here for the same
    # schema-accuracy reason as is_inherited/inherited_from above.
    id = serializers.IntegerField(read_only=True, allow_null=True)
    # Not a model field; set by the members action for group admin readers only.
    # Not read_only: drf-spectacular lists every read-only field in the
    # response component's `required` list, but the members action omits the
    # key for readers who are not group admins (#2075), so the schema must
    # not promise it. Same reason as the board member row's
    # has_all_content_access (#1301).
    has_all_content_access = serializers.BooleanField(
        required=False,
        help_text="Whether the member has all-content access, which always "
                  "resolves to full access and overrides this row's role. "
                  "Present only for a group admin reader, on every row.",
    )
    # Not a model field; set by the members action on direct rows, for the same
    # group admin readers as has_all_content_access (#2164). The server refuses
    # to change or remove a site admin's membership unless the caller is a site
    # admin too, so the Members panel uses this to withhold those controls
    # instead of offering an action that ends in a 403. Not read_only, for the
    # same schema reason as has_all_content_access.
    is_site_admin = serializers.BooleanField(
        required=False,
        help_text="Whether the member is a site admin, whose membership only a "
                  "site admin can change or remove. Present only for a group "
                  "admin reader, on direct rows.",
    )

    class Meta:
        model = GroupMembership
        fields = [
            "id", "user", "role", "joined_at", "is_inherited", "inherited_from", "has_all_content_access",
            "is_site_admin",
        ]


class GroupMemberRoleUpdateSerializer(GroupMembershipSerializer):
    """Response of ``PATCH groups/{id}/members/{user_id}/`` (#1783).

    Schema only. ``update_member`` serializes the real membership row with
    :class:`GroupMembershipSerializer`, and on a real row ``is_inherited`` and
    ``inherited_from`` are skipped (they exist only on the rows the ``members``
    list builds), while the shared component documents both as always
    present. Restricting the fields here publishes what PATCH returns without
    touching the list's component.
    """

    class Meta(GroupMembershipSerializer.Meta):
        fields = ["id", "user", "role", "joined_at"]


@extend_schema_serializer(deprecate_fields=["default_board_member_role", "allowed_priorities"])
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
        # GroupViewSet's ``_annotated_groups`` select_related()s the parent chain
        # to the traversal cap, so ancestors() issues no query; a caller that
        # skips it pays one query per level (#1731).
        if not fk_chain_loaded(obj, "parent", _GROUP_TRAVERSAL_MAX_DEPTH):
            note_fallback(self, "get_ancestors", per_row=False)
        return [{"id": g.id, "name": g.name} for g in reversed(obj.ancestors())]


@extend_schema_serializer(deprecate_fields=["default_board_member_role", "allowed_priorities"])
class GroupBoardDefaultsSerializer(serializers.ModelSerializer):
    """Request body of ``PATCH groups/{id}/board-defaults/`` (#1783).

    Schema only: ``GroupViewSet.board_defaults`` keeps just these two keys of
    the body and validates them through :class:`GroupSerializer`, so this
    class never runs at request time. The two fields are declared with the
    same kwargs as on ``GroupSerializer`` so the published request matches
    what that serializer accepts.
    """

    allowed_priorities = AllowedPrioritiesField(
        required=False,
        help_text=field_enforcement.GROUP_ALLOWED_PRIORITIES,
    )

    class Meta:
        model = Group
        fields = ["default_board_member_role", "allowed_priorities"]
        extra_kwargs = {
            "default_board_member_role": {
                "help_text": field_enforcement.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
            },
        }


class GroupInviteLinkSerializer(serializers.ModelSerializer):
    is_expired = serializers.BooleanField(read_only=True)
    status = serializers.CharField(read_only=True)
    # Audit field (#1008) — matches AdminInviteLink.created_by_username so
    # group admins can see who created an invite link, parity with the
    # admin-level invite UI.  Use a CharField with source so we don't have
    # to nest a User serializer for one string.
    # allow_null=True (#1294): created_by is a nullable FK (null when the
    # creator was deactivated and their User row was anonymized — see
    # GroupInviteLink.created_by_username in frontend/src/types/index.ts),
    # and a declared CharField traversing a nullable source does not inherit
    # that nullability the way an auto-generated ModelSerializer field would.
    # A SerializerMethodField, not a dotted-source CharField with default=None:
    # DRF's get_default() raises SkipField under partial=True (#1226, same
    # mechanism as #1166/#1225). Dormant today (only bound read-only).
    created_by_username = serializers.SerializerMethodField(allow_null=True)

    class Meta:
        model = GroupInviteLink
        fields = [
            "id", "prefix", "is_active", "created_at", "created_by_username", "name", "role",
            "expires_at", "is_expired", "single_use", "used_at", "status", "delivery",
        ]
        read_only_fields = ["id", "prefix", "is_active", "created_at", "created_by_username", "is_expired", "single_use", "used_at", "status", "delivery"]

    def get_created_by_username(self, obj) -> str | None:
        # created_by_id reads the loaded FK column (no query); created_by is
        # only dereferenced when set, so a null creator serializes as None.
        # The list endpoint select_related()s it; a list without that pays a
        # query per link (#1731).
        if obj.created_by_id and not GroupInviteLink.created_by.field.is_cached(obj):
            note_fallback(self, "get_created_by_username")
        return obj.created_by.username if obj.created_by_id else None


# Lifetime bounds for a shareable group invite link (#1727), the same limits as
# board invite links and emailed group invites. A shareable link is a bearer
# credential that may be pasted anywhere, so it must age out on its own.
GROUP_INVITE_LINK_DEFAULT_EXPIRY_DAYS = 7
GROUP_INVITE_LINK_MAX_EXPIRY_DAYS = 30

# The roles a shareable group link may grant (#1727): every group role except
# admin. A group admin inherits board admin on every board in the subtree, and
# whoever holds a shareable link holds that grant. An emailed invite is capped
# the same way (#2006): a forwarded or misdirected email would otherwise mint a
# group admin, and binding to one address (#1678) does not stop a mistyped or
# compromised mailbox. Group admin is granted by changing a member's role.
GROUP_INVITE_LINK_ROLE_CHOICES = [
    (value, label) for value, label in GroupInviteLink.Role.choices
    if value != GroupInviteLink.Role.ADMIN
]


class GroupInviteLinkCreateSerializer(serializers.Serializer):
    """Validates input for creating a new shareable GroupInviteLink.

    Validated at creation only (#1727). Links minted before the admin and
    lifetime limits were handled once, by migration 0023 (#1940): unused admin
    links were revoked and unused never-expiring ones got a 7-day expiry; a
    legacy link already expiring later keeps that expiry. There is no update endpoint for a link, so nothing can raise an
    existing link's role or clear its expiry.
    """

    name = serializers.CharField(max_length=100, required=False, default="", allow_blank=True)
    role = serializers.ChoiceField(
        choices=GROUP_INVITE_LINK_ROLE_CHOICES,
        required=False,
        default=GroupInviteLink.Role.MEMBER,
    )
    # Omitted means the 7-day default; an explicit null ("never expires", the
    # pre-#1727 meaning) is refused rather than defaulted, so a client that
    # still asks for a never-expiring link learns it did not get one.
    expiry_days = serializers.IntegerField(
        required=False,
        default=GROUP_INVITE_LINK_DEFAULT_EXPIRY_DAYS,
        min_value=1,
        max_value=GROUP_INVITE_LINK_MAX_EXPIRY_DAYS,
    )
    single_use = serializers.BooleanField(required=False, default=False)


# Upper bound on an emailed group invite's lifetime (#731). Emailed links never
# get a "never expires" option: each one is a live credential sitting in a
# third party's inbox, so it must age out on its own.
GROUP_INVITE_EMAIL_MAX_EXPIRY_DAYS = GROUP_INVITE_LINK_MAX_EXPIRY_DAYS


class GroupInviteLinkEmailSerializer(serializers.Serializer):
    """Validates input for sending a group invite link by email (#731).

    There is deliberately no free-text message field: the instance's trusted
    sender address must not carry attacker-chosen prose to arbitrary inboxes.
    """

    email = InviteEmailField()
    # No admin (#2006), the same choices as a shareable link (#1727).
    role = serializers.ChoiceField(
        choices=GROUP_INVITE_LINK_ROLE_CHOICES,
        required=False,
        default=GroupInviteLink.Role.MEMBER,
    )
    expiry_days = serializers.IntegerField(
        required=False,
        default=GROUP_INVITE_LINK_DEFAULT_EXPIRY_DAYS,
        min_value=1,
        max_value=GROUP_INVITE_EMAIL_MAX_EXPIRY_DAYS,
    )


class HealthStatusWriteSerializer(serializers.Serializer):
    """Body of ``POST /boards/{id}/health-status/`` and ``/groups/{id}/health-status/`` (#2242).

    The explicit set-or-confirm action: the only writer that records a
    reconfirm (same value) or a note. ``status`` null clears the entity's own
    value (inherit). The note is validated here, at the boundary: stripped,
    newlines flattened to spaces, empty becomes null, at most 280 characters.
    """

    status = serializers.ChoiceField(
        choices=HealthStatus.choices, allow_null=True,
        help_text="The status to set or confirm, or null to clear it (inherit).",
    )
    note = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, trim_whitespace=True,
        max_length=HEALTH_NOTE_MAX_LENGTH,
        help_text="Optional reason, shown in the tooltip and history. At most 280 characters.",
    )

    def validate_note(self, value):
        if value is None:
            return None
        value = " ".join(value.split())
        return value or None


class HealthStatusChangeSerializer(serializers.Serializer):
    """One row of ``GET .../health-history/`` (#2242). ``changed_by`` null: removed account or system."""

    from_status = serializers.ChoiceField(choices=HealthStatus.choices, allow_null=True, read_only=True)
    to_status = serializers.ChoiceField(choices=HealthStatus.choices, allow_null=True, read_only=True)
    changed_by = BoardUserSerializer(read_only=True, allow_null=True)
    changed_at = serializers.DateTimeField(read_only=True)
    note = serializers.CharField(read_only=True, allow_null=True)


class HealthHistorySerializer(serializers.Serializer):
    """Response of ``GET .../health-history/`` (#2242): newest first, at most 20 rows."""

    results = HealthStatusChangeSerializer(many=True, read_only=True)
    has_more = serializers.BooleanField(
        read_only=True, help_text="True when older changes exist beyond the 20 returned.",
    )
