from drf_spectacular.utils import extend_schema_field, extend_schema_serializer
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied
from accounts.serializers import BoardUserSerializer
from visiban import field_enforcement
from visiban.utils import MAX_ALLOWED_PRIORITIES_LENGTH, check_allowed_priorities_length
from visiban.invite_email import InviteEmailField
from .models import (
    Group, GroupLabel, GroupMembership, GroupInviteLink, GroupFavorite,
    _GROUP_TRAVERSAL_MAX_DEPTH, user_has_group_access,
    user_is_group_admin,
)

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


def full_group_access(group):
    """``group_access`` context value for a caller already cleared for full detail.

    ``GroupSerializer`` withholds non-navigation fields unless it can tell the
    viewer may see them (see ``GroupSerializer._is_navigation_only``). Pass
    this only where the code has already established that every recipient of
    the payload is a member or admin of the group, and say why at the call.
    """
    return True


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


# default_board_member_role is deprecated (#1430): kept for API compatibility
# (1.0 contract forbids removing a serializer field), flagged in the schema.
@extend_schema_serializer(deprecate_fields=["default_board_member_role"])
class GroupSerializer(serializers.ModelSerializer):
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
        ]
        read_only_fields = [
            "owner", "created_at", "shared_labels", "is_starred", "navigation_only",
            "can_place_boards",
        ]
        # Schema-only (#1077): see visiban/field_enforcement.py.
        extra_kwargs = {
            "default_board_member_role": {
                "help_text": field_enforcement.GROUP_DEFAULT_BOARD_MEMBER_ROLE,
            },
        }

    def get_parent_name(self, obj) -> str | None:
        return _parent_name_for_group(obj)

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
                    data[key] = type(empty)(empty)
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

    class Meta:
        model = GroupMembership
        fields = ["id", "user", "role", "joined_at", "is_inherited", "inherited_from"]


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


@extend_schema_serializer(deprecate_fields=["default_board_member_role"])
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


@extend_schema_serializer(deprecate_fields=["default_board_member_role"])
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
