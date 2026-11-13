#!/usr/bin/env python3
"""Assert every board/group-scoped endpoint carries its three RBAC gates (#1143).

This is the deterministic half of the ``rbac-check`` agent gate. The agent's
prompt (``.claude/agents/rbac-check.md``) asks six questions; three of them are
**mechanical** — the same three the issue names — and are what this script owns:

  1. **Authentication gate** — the view's ``permission_classes`` include
     ``IsAuthenticated`` (or it is recorded in :data:`PUBLIC_BY_DESIGN` with a
     reason).
  2. **Board/group membership check** — every write handler on a board- or
     group-scoped view resolves the caller's role through the shared resolver
     (``get_board_for_user`` / ``get_board_role`` / ``_require_group_*`` / …),
     not an ad-hoc ``BoardMembership`` lookup that would skip group inheritance.
  3. **Minimum-role check per write action** — every write handler applies a
     role gate: a comparison against a role constant, a helper named in
     ``GATE_CALL_NAMES``, or an explicit ``role=`` hand-off to the service layer that owns the gate.
     Each must be about the *caller's* role, not a request body's or a target
     row's, and a returned denial must be acted on (#2116; see the notes above
     :data:`CALLER_IDENTITY_ROOTS` and :func:`_consumed`). A helper refuses by
     raising only where the raise is on the branch its comparison decides
     (#2166; see :func:`_raise_guarded`).

The other three (cross-board isolation beyond the mechanical lookup-scoping
case, group-inheritance correctness, and "is this the *right* minimum role for
this resource") stay with the agent: they need to know what a resource *means*,
which no grep can supply. One mechanical slice of cross-board isolation is
checked here too, because it is purely structural — see ``unscoped-lookup``.

Why deterministic at all: the same conversion #1078, #1092 and #1093 made for
the WebSocket contract, suppression markers and gate self-tests. An agent
round-trip per MR costs latency and tokens and produces a verdict nothing
records; a script produces the same verdict in under a second, on every push,
and its misses are visible as code rather than as an absent paragraph.

Why the agent gate does **not** go away: this script has an explicit
**exit code 3 — unhandled pattern, defer to the agent**. A view whose
authorization cannot be classified statically is *not* reported as a pass. It
either lands in :data:`AGENT_REVIEWED` with the reason the agent gave, or it
fails the pipeline asking for that review. Silently passing an unclassifiable
view is the one outcome this script must never produce.

Scope: ``backend/boards/views/``, ``backend/groups/views.py``,
``backend/git_lens/views.py`` and ``backend/webhooks/views.py`` (#863) — the
board- and group-scoped API surface the role
hierarchy governs. ``backend/accounts/views.py`` is deliberately **out of
scope**: it is the authentication/session surface (login throttles, password
reset, email confirmation, PAT management), governed by per-view rules rather
than the admin/member/viewer ladder, and several of its views are public by
design. Auth-surface review stays with ``security-review`` and the agent.

Usage:
    python scripts/check-rbac-coverage.py [--root DIR] [--quiet]
    python scripts/check-rbac-coverage.py --self-test

Exit codes:
    0  every in-scope view class carries its gates
    1  at least one finding
    2  the checker could not run (missing tree, parse error, usage error) —
       fails closed, never silently green
    3  at least one view or handler the checker cannot classify: run the
       ``rbac-check`` agent on it, then either fix it or record the review in
       AGENT_REVIEWED. NOT a pass.
"""

from __future__ import annotations

import argparse
import ast
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# Hyphenated gate scripts are also loaded via importlib by their tests, where
# scripts/ is not on sys.path; make the sibling import work either way.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import resolve_within  # noqa: E402

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_CANNOT_RUN = 2
EXIT_DEFER_TO_AGENT = 3

# ─── Scope ───────────────────────────────────────────────────────────────────

# Directories scanned wholesale, and single files. Both are relative to --root.
SCOPE_DIRS = ("backend/boards/views",)
SCOPE_FILES = ("backend/groups/views.py", "backend/git_lens/views.py", "backend/webhooks/views.py")

# Model modules the board/card-scoping map is derived from (see _scoped_models).
MODEL_MODULES = ("backend/boards/models.py",)

# ─── What counts as a view class ─────────────────────────────────────────────

# Matched on the *last* segment of a base's dotted name, so `viewsets.ModelViewSet`
# and a bare `ModelViewSet` both hit.
VIEW_BASE_SUFFIXES = (
    "APIView",
    "ViewSet",
    "GenericAPIView",
    "ListAPIView",
    "RetrieveAPIView",
    "CreateAPIView",
    "UpdateAPIView",
    "DestroyAPIView",
    "ListCreateAPIView",
    "RetrieveUpdateAPIView",
    "RetrieveUpdateDestroyAPIView",
)

# The permission class that constitutes the authentication gate.
AUTH_PERMISSION = "IsAuthenticated"

# ─── What counts as a write ──────────────────────────────────────────────────

WRITE_HTTP_METHODS = frozenset({"post", "put", "patch", "delete"})

# DRF collapses several method names onto one logical action; a gate in any
# member of a group covers that action, because `destroy` calls
# `perform_destroy` and `update`/`partial_update` call `perform_update`.
DRF_ACTION_GROUPS = (
    ("create", ("create", "perform_create")),
    ("update", ("update", "partial_update", "perform_update")),
    ("destroy", ("destroy", "perform_destroy")),
)

# ─── What counts as a role resolution ────────────────────────────────────────

# The shared resolvers. `get_board_role`/`get_board_roles` carry the precedence
# ladder including group inheritance; a direct `BoardMembership.objects.get()`
# does not, which is why reaching for one is itself a finding.
ROLE_RESOLVERS = frozenset({
    "get_board_for_user",
    "get_board_role",
    "get_board_roles",
    "get_accessible_boards_queryset",
    "get_accessible_group_ids",
    "get_group_ids_for_board_access",
    "_require_group_admin",
    "_require_group_member",
})

# Reaching for a raw membership row instead of a resolver skips group
# inheritance. Matched as a dotted prefix on a call.
RAW_MEMBERSHIP_LOOKUPS = (
    "BoardMembership.objects",
    "GroupMembership.objects",
)

# A call with one of these exact names is a role gate: it decides on a role the
# caller must hold, and this checker cannot read it. A name defined in the module
# being scanned never counts on its name, because the walk reads its body: an
# emptied helper must not keep passing on what it is called.
#
# Exact names, never a ``require_`` prefix (#2069). The prefix also matched
# ``require_json_object`` (body shape), ``require_present_or_404`` (row still
# there), ``_require_live_*`` (referents still there) and ``_require_session`` /
# ``_require_enabled`` (not about the caller's board role at all), so a handler
# that lost its real gate kept passing, exit 0, on any of them.
#
# A helper left off this list fails closed. A same-module one is walked, so its
# real comparison still counts. An imported one that is handed a subject defers
# to the agent. Add a name here only once the helper is confirmed to deny on an
# insufficient role. ``user_has_group_access`` and so ``_require_group_member``
# are deliberately absent: a group viewer passes them, so they prove membership
# and not a minimum role.
GATE_CALL_NAMES = frozenset({
    "user_is_group_admin",
    "require_mutation_role",
})

# Gate calls that *answer* rather than *deny*: they return a bool and refuse
# nothing themselves, so they gate only when the handler acts on the answer
# (see :func:`_consumed`). ``require_mutation_role`` raises, so it is not here.
GATE_PREDICATE_NAMES = frozenset({"user_is_group_admin"})

CALLER_ROLE_CACHE_ATTR = "_cached_board_role"

# ─── Whose role a comparison is about (#2116) ────────────────────────────────
#
# A role comparison is a gate only when one side of it is the *requesting
# user's* role or identity. ``member_role not in BoardMembership.Role.values``
# (a request-body field), ``locked.role == GroupMembership.Role.ADMIN`` (a
# target membership row) and ``existing.role`` all mention a role and decide
# nothing about who is asking; before #2116 each of them kept a handler whose
# real gate had been deleted passing, exit 0.
#
# The approach is a narrow allow-list of operand shapes plus one-step dataflow
# within a function, not general dataflow. An operand is the caller's when it is
#   * rooted at ``request.user`` / ``self.request.user``;
#   * exactly ``self._cached_board_role`` (:data:`CALLER_ROLE_CACHE_ATTR`, the
#     per-request cache of the caller's own resolved role); any other
#     ``self.<name>role<name>`` could just as well hold a request-body value;
#   * a local bound from a shared role resolver, a gate call, or a same-class /
#     same-module helper whose name mentions "role" (``self._board_and_role()``)
#     — for a tuple unpack, only the element whose name mentions "role", because
#     the ``board`` beside it is the resolved object, not the caller;
#   * a parameter of a helper that its call site handed a caller operand
#     (``_require_group_admin(request.user, group)`` trusts ``user``, not
#     ``group``) — so a helper handed a body field cannot launder it.
# Anything else, a request body, a ``get_object()`` row, a loop variable, an ORM
# result, is not the caller's. Failing closed is the point: a comparison shape
# this list does not know is a missing gate, which shows up as a finding on the
# handler and is fixed by adding the shape here with its reason, never by
# trusting it silently.
CALLER_IDENTITY_ROOTS = ("request.user", "self.request.user")

# Names that, appearing in a comparison, make that comparison a role gate.
# ``owner`` and ``can_access_all_content`` are in here because two rungs of the
# precedence ladder are not spelled as roles at all: the board/group owner is
# implicitly admin without a membership row, and ``can_access_all_content`` is
# the site-admin predicate. ``GroupViewSet.destroy`` gates entirely on those two
# — a real gate a "must mention .Role." rule would have called missing.
# Mentioning one of these on either side makes a comparison a role gate outright.
STRONG_ROLE_MARKERS = (
    "SITE_ADMIN",
    ".Role.",
    "Role.values",
    "_ROLES",
    "can_access_all_content",
    "is_site_admin",
)

# Mentioning one of these on the LEFT makes a comparison a role gate provided it
# is compared against something other than None/True/False. The proviso is not
# cosmetic: ``if self._cached_board_role is None:`` — the per-request cache probe
# every board-scoped viewset opens with — mentions "role" and is emphatically
# not a gate. Treating it as one silently marked every handler in the repository
# as gated, which is the failure mode this whole script exists to prevent.
SUBJECT_ROLE_MARKERS = ("role", "owner")

# Handing a resolved role to a callee delegates the gate to it (the services
# layer owns the ladder for cards — see backend/boards/services/cards.py).
# Only those callees count. ``X.objects.create(role=...)`` and
# ``GroupInviteLink.generate(role=...)`` also take the keyword, but they write a
# row's role and decide nothing about the caller (#2069).
ROLE_DELEGATION_KWARG = "role"
ROLE_DELEGATION_ROOTS = frozenset({"card_services"})

# How deep the gate search follows same-class methods and same-module functions.
_RESOLVE_MAX_DEPTH = 4

# A call this checker cannot follow only counts as "the gate might be in there"
# when all three hold:
#   * its callee is a module-level/imported target, never a method on a local
#     variable (``instance.delete()``, ``serializer.save()``);
#   * it is handed the *subject* of an authorization decision — a role, a user,
#     a board or a group. A check that is not given who is asking and what they
#     are asking about cannot be an authorization check, which rules out
#     ``transaction.atomic()``, ``Response(...)`` and the rest of the framework
#     furniture without this script having to enumerate it;
#   * it is not one of these, which are demonstrably not authorization even
#     though they are handed a board. Without them a handler that really has no
#     gate but does broadcast would defer instead of failing.
NOT_A_GATE_SUBSTRINGS = (
    "broadcast",
    "serializer",
    "logger",
    "logging",
    "record_board_event",
    "record_group_event",
    "persist_board_event",
    ".objects.",  # an ORM manager call is data access, never authorization
)

# Calls that can take a user/board argument without being authorization: builtins,
# framework furniture, request parsing, and the row-lock helpers. A lock is handed a
# board and decides nothing about who is asking; when #1602 added them to these
# handlers, a handler with no role gate started deferring instead of failing (#2069).
# Exact names, so a new helper defers until someone has read it.
NOT_A_GATE_NAMES = frozenset({
    "getattr", "hasattr", "setattr", "isinstance", "len", "list", "set", "dict", "str", "int", "bool", "sorted", "any", "all", "print", "super",
    "Response", "Q", "ErrorDetail", "get_object_or_404", "get_list_or_404", "on_commit",
    "require_json_object", "require_present_or_404", "optional_text", "query_text",
    "generate",  # invite-link token minting; the role it takes is the link's
    "user_has_group_access",  # membership only: a group viewer passes it
    # The ownership exception (#2116): reached only once the target row is
    # someone else's, so a caller acting on their own row never meets it. It is
    # not a minimum role for the action; a handler must check one separately.
    # A handler gated by it alone, unconditionally, is reported missing — record
    # it, do not put it back in GATE_CALL_NAMES.
    "can_modify_others_content",
    "_can_modify_others_content",
    "lock_board_row_or_404",
    "lock_board_and_row_or_404",
    "lock_container_cascade",
    "lock_group_row",
    "lock_group_for_board_placement",
    "lock_group_for_child_write",
    "lock_membership_for_removal_or_demotion",
})

# Names an argument must mention for its call to be a possible authorization
# check. Matched as a substring of the argument's dotted source text.
GATE_SUBJECT_MARKERS = ("role", "user", "request", "board", "group", "actor", "member")

# ─── Recorded exceptions ─────────────────────────────────────────────────────
#
# Every entry becomes a finding, and asks to be deleted, once it matches nothing
# in the tree. PUBLIC_BY_DESIGN and VIEWER_PERMITTED_WRITES go further: an entry
# also becomes a finding once its view gains the gate it was excused from.
# AGENT_REVIEWED goes only part of the way: a recorded handler is skipped, so its
# own body is not re-scanned, but an entry that names its guard in
# AGENT_REVIEWED_GUARDS fails once that guard is no longer reached (#2125). An
# entry with no guard chain is still trusted blind. A chain proves each named
# function still CALLS the next one, not that the call is unconditional or that
# the callee still refuses; the tests each reason cites pin that.

# Views with deliberately no authentication gate. The reason must say what
# stands in for authentication, because "public" alone is not a design.
PUBLIC_BY_DESIGN: dict[str, str] = {
    "backend/boards/views/health.py::LivenessView": (
        "Container liveness probe. Returns a static literal, reads nothing, and "
        "must answer before the app can authenticate anyone."
    ),
    "backend/boards/views/health.py::ReadinessView": (
        "Container readiness probe. Same as LivenessView; the orchestrator "
        "calling it holds no session."
    ),
    "backend/boards/views/share.py::ShareBoardView": (
        "Public share link. The UUID share_token IS the credential (see the "
        "class docstring); the payload is stripped of all PII and the view is "
        "throttled per token and per IP."
    ),
}

# Write actions whose minimum role really is "any board member, viewer
# included", so there is no role gate to find and its absence is the design.
# Every entry must say why the write is safe for a viewer — in practice, because
# the row it writes is the caller's own per-user state, not board content.
VIEWER_PERMITTED_WRITES: dict[str, str] = {
    "backend/boards/views/boards.py::BoardViewSet::@action star [delete,post]": (
        "Starring is per-user state (BoardFavorite, keyed on request.user), not "
        "board content. Any member who can see the board may star it; the row "
        "written is their own."
    ),
    "backend/boards/views/boards.py::BoardViewSet::@action saved_filters [post]": (
        "Saved filters are private to request.user (see the handler docstring) "
        "— there are no shared presets, so a viewer saving their own filter "
        "changes nothing another user can read."
    ),
    "backend/groups/views.py::GroupViewSet::@action star [delete,post]": (
        "Group starring is per-user state (GroupFavorite, keyed on request.user), "
        "not group content. The handler requires group membership and no higher "
        "role, because the row written is the caller's own."
    ),
    "backend/boards/views/boards.py::BoardViewSet::@action saved_filter_delete [delete]": (
        "Same per-user state as saved_filters. The queryset is scoped to "
        "request.user, so another user's preset is a 404 rather than a 403."
    ),
}

# Views or handlers whose authorization is real but not something this script can
# prove: it cannot classify them, or it reports a finding the role ladder does not
# apply to. Each entry records who reviewed it and what they found — this is the
# hand-off the exit-3 path exists to force, written down.
AGENT_REVIEWED: dict[str, str] = {
    "backend/boards/views/import_export.py::BoardImportExportMixin::@action import_board [post]": (
        "JSON and CSV board import. Reviewed by the rbac-check agent for #2069. "
        "Same shape as BoardViewSet::create: it writes only to a board it creates"
        " (owner = request.user, the caller's membership role is the constant "
        "admin), so there is no board role to resolve. The checker cannot follow "
        "the handler's local-variable dispatch to _import_json/_import_csv. Gate:"
        " BoardViewSet permission_classes (IsAuthenticated, both forced-flow "
        "gates, TokenHasScope; PAT write scope is enforced in PATAuthentication) "
        "plus BoardImportThrottle. Both importers call _resolve_import_group, "
        "then _lock_import_group, before Board.objects.create; the only group "
        "source is request.data['group_id'] (never the file), and it reaches "
        "_require_group_admin through resolve_group_for_board_placement (404 "
        "invisible, 403 below admin). Every row lands on the new board; assignees"
        " resolve only through _resolve_import_users/visible_users, and history "
        "and comment authors are the importer with the source name kept as text. "
        "Tests: test_group_placement_roles.py test_import_denied_below_admin, "
        "test_child_group_admin_cannot_use_parent_group."
    ),
    "backend/boards/views/import_export.py::BoardImportExportMixin::@action import_trello [post]": (
        "Trello board import. Reviewed by the rbac-check agent for #2069. It "
        "writes only to a board execute_plan creates (owner = request.user, "
        "caller membership role is the constant admin), so there is no board role"
        " to resolve. Gate: BoardViewSet permission_classes (IsAuthenticated, "
        "both forced-flow gates, TokenHasScope; PAT write scope in "
        "PATAuthentication) plus TrelloImportThrottle (confirm shares the "
        "board_import budget). _resolve_import_group runs in both dry-run and "
        "confirm before any parse, plan or write, and reaches "
        "_require_group_admin through resolve_group_for_board_placement in "
        "another module; the group comes only from request.data['group_id'], and "
        "the mapping options have no group, owner or role key. Every row lands on"
        " the new board; comment authors are the importer with the Trello name "
        "kept as text. One non-obvious write: mapping add_matched_members=true "
        "bulk-creates BoardMembership rows at the constant role member for Trello"
        " members matched by exact username against visible_users (the importer's"
        " board/group co-members and the target group; all active users for a "
        "site admin or all-content importer). The role is never read from the "
        "file, and no add notification is sent. Tests: "
        "test_group_placement_roles.py "
        "test_trello_dry_run_denied_for_each_role_below_admin; "
        "test_trello_import.py test_group_viewer_cannot_import_into_group."
    ),
    "backend/boards/views/boards.py::BoardViewSet::create": (
        "Board creation (POST /boards/, via perform_create). No board exists "
        "yet, so there is no board role to resolve. Gate: IsAuthenticated, both "
        "#1110 forced-flow gates and TokenHasScope (the PAT read/write/admin "
        "baseline runs in PATAuthentication). Any authenticated user may create "
        "a personal board and becomes its admin; the role written is a constant, "
        "never request input, and every other write (membership, template "
        "columns, swimlane, board event) lands on the new board. Placing the "
        "board in a group is the only write into existing shared state, and "
        "BoardSerializer.validate_group gates it on _require_group_admin (admin "
        "of the group or an ancestor, or can_access_all_content): a group "
        "viewer, member, navigation-only ancestor or unseen group gets the same "
        "400 as an unknown id (#1655). Board imports and "
        "POST /groups/{id}/boards/ place boards through "
        "resolve_group_for_board_placement and _require_group_admin, which is "
        "the same predicate. Reviewed by the rbac-check agent for #2069. "
        "test_board_group_field_validation.py: "
        "test_create_with_group_rejected_for_non_member, "
        "test_create_with_group_rejected_for_group_viewer, "
        "test_create_with_group_rejected_for_group_member, "
        "test_create_unknown_group_matches_inaccessible_group_response, "
        "test_create_with_group_rejected_for_nav_only_ancestor_admin."
    ),
    "backend/groups/views.py::JoinGroupView": (
        "Invite-link join. Authorization is the capability token itself, "
        "resolved from the URL rather than from a group role, so there is no "
        "role gate to find: GET is deliberately AllowAny (token preview, "
        "throttled), POST requires IsAuthenticated via get_permissions() and "
        "then grants the membership the token names. Role-ladder reasoning does "
        "not apply to a capability grant."
    ),
    "backend/boards/views/invites.py::JoinBoardView": (
        "Board invite-link join (#1444). Same capability model as JoinGroupView: "
        "authorization is the token itself, resolved from the URL rather than "
        "from a board role, so there is no role gate to find (the DEFER names "
        "get_client_ip, which only reads the caller's address). GET is "
        "deliberately AllowAny (token preview, throttled); POST requires "
        "IsAuthenticated, both #1110 forced-flow gates and TokenHasScope via "
        "get_permissions(), then grants the role the stored link names -- never "
        "caller input, limited to member/collaborator/viewer at mint and again "
        "at redemption, and an existing membership or higher inherited role is "
        "never changed. Revoked, used and expired links are refused (410) under "
        "a row lock, and a sender who lost board admin voids the link. "
        "test_board_invites.py: test_join_unknown_404_and_anonymous_refused, "
        "test_join_410_codes, test_creator_demoted_or_deactivated_is_refused, "
        "test_admin_role_written_directly_is_never_honored, "
        "test_group_admin_redeeming_viewer_invite_is_not_downgraded, "
        "test_existing_explicit_membership_is_never_changed."
    ),
    "backend/git_lens/views.py::LensUsageAdminView": (
        "Site-admin lens usage telemetry (#1061). permission_classes is "
        "_ADMIN_PERMISSIONS imported from accounts.admin_views -- the same list "
        "object every /api/v1/admin/ route uses (IsSiteAdmin, both #1110 "
        "forced-flow gates, TokenHasScope, whose admin scope is derived from "
        "IsSiteAdmin by introspection), which this checker cannot resolve "
        "across modules. GET-only, no path or query params, and the payload is "
        "aggregated hourly counters plus static bounds -- no tokens, repo slugs, "
        "users, or per-board data, so no IDOR surface. test_usage_admin.py pins "
        "the list identity and covers anon/non-admin/forced-flow/405."
    ),
}


# The guard chain each AGENT_REVIEWED entry relies on (#2125). A link is
# ``(module, function, callee)``: *function* in *module* (``Class.method`` for a
# method, a bare name for a module-level function) must still contain a call
# whose callee name ends in *callee*. Chained end to end, handler -> ... ->
# guard, so removing ``_require_group_admin`` from
# ``resolve_group_for_board_placement``, or no longer routing an importer through
# ``_resolve_import_group``, fails the run even though the handler itself is
# skipped. This proves reachability by name, not behavior; the backend tests the
# reasons cite still prove the guard refuses.
GuardLink = tuple[str, str, str]
_IMPORT = "backend/boards/views/import_export.py"
_MIXIN = "BoardImportExportMixin"
_PLACEMENT_CHAIN: tuple[GuardLink, ...] = (
    (_IMPORT, f"{_MIXIN}._resolve_import_group", "resolve_group_for_board_placement"),
    ("backend/groups/views.py", "resolve_group_for_board_placement", "_require_group_admin"),
)
AGENT_REVIEWED_GUARDS: dict[str, tuple[GuardLink, ...]] = {
    f"{_IMPORT}::{_MIXIN}::@action import_board [post]": (
        (_IMPORT, f"{_MIXIN}._import_json", "_resolve_import_group"),
        (_IMPORT, f"{_MIXIN}._import_json", "_lock_import_group"),
        (_IMPORT, f"{_MIXIN}._import_csv", "_resolve_import_group"),
        (_IMPORT, f"{_MIXIN}._import_csv", "_lock_import_group"),
    ) + _PLACEMENT_CHAIN,
    f"{_IMPORT}::{_MIXIN}::@action import_trello [post]": (
        (_IMPORT, f"{_MIXIN}.import_trello", "_resolve_import_group"),
        (_IMPORT, f"{_MIXIN}.import_trello", "_lock_import_group"),
    ) + _PLACEMENT_CHAIN,
    "backend/boards/views/boards.py::BoardViewSet::create": (
        ("backend/boards/serializers.py", "BoardSerializer.validate_group", "_check_group_change"),
        ("backend/boards/serializers.py", "BoardSerializer._check_group_change", "_require_group_admin"),
    ),
}


def _guard_findings(root: Path) -> list[str]:
    """Findings for every AGENT_REVIEWED_GUARDS link that no longer holds."""
    out: list[str] = []
    cache: dict[str, Module] = {}
    for key, links in AGENT_REVIEWED_GUARDS.items():
        if key not in AGENT_REVIEWED:
            out.append(
                f"AGENT_REVIEWED_GUARDS entry {key} has no AGENT_REVIEWED entry "
                f"- delete it."
            )
            continue
        for rel, func, callee in links:
            if rel not in cache:
                cache[rel] = _load_module(root, rel)
            mod = cache[rel]
            cls_name, _, meth = func.rpartition(".")
            fns: list = []
            if cls_name:
                for cls in mod.classes:
                    if cls.name == cls_name:
                        fns += [
                            n for n in cls.body
                            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
                            and n.name == meth
                        ]
            elif meth in mod.functions:
                fns = [mod.functions[meth]]
            if not fns:
                out.append(
                    f"{key}: its reviewed guard chain names {rel}::{func}, which "
                    f"no longer exists - re-review the handler and update "
                    f"AGENT_REVIEWED_GUARDS."
                )
            elif not any(
                _dotted(c.func).rsplit(".", 1)[-1] == callee
                for fn in fns
                for c in _calls(fn)
            ):
                out.append(
                    f"{key}: {rel}::{func} no longer calls {callee}, which the "
                    f"recorded review relies on as its guard - the handler is "
                    f"skipped by this checker, so re-review it."
                )
    return out


class CheckerError(Exception):
    """The checker could not run. Never reported as a clean result."""


# ─── AST helpers ─────────────────────────────────────────────────────────────


def _dotted(node: ast.AST) -> str:
    """Return the dotted source name of a Name/Attribute node, else ""."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    return ""


def _str_list(node: ast.AST) -> list[str]:
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return [e.value for e in node.elts if isinstance(e, ast.Constant) and isinstance(e.value, str)]
    return []


def _body_nodes(fn: ast.AST):
    """Yield every node in *fn*'s **body**, excluding its decorator list.

    ``ast.walk`` on a FunctionDef also descends into ``@action(...)`` and
    ``@extend_schema(...)``, which are not code the handler runs — counting them
    made every decorated action look as though its gate might be hiding inside
    ``action()``.
    """
    for stmt in fn.body:
        yield from ast.walk(stmt)


def _calls(node: ast.AST):
    """Yield every Call node in *node*'s subtree (decorators excluded)."""
    walker = _body_nodes(node) if isinstance(
        node, (ast.FunctionDef, ast.AsyncFunctionDef)
    ) else ast.walk(node)
    for sub in walker:
        if isinstance(sub, ast.Call):
            yield sub


def _local_names(fn: ast.AST) -> set[str]:
    """Return every name bound locally inside *fn*.

    Used to tell a call that might hold an authorization check
    (``card_services.create_card(...)``, ``external.check(...)``) from one that
    provably cannot (``instance.delete()``, ``serializer.save()``): the second
    goes through a name this function itself bound, so there is nothing
    module-level behind it to hide a gate in.
    """
    names: set[str] = {"self", "cls", "request"}
    for node in ast.walk(fn):
        if isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
    return names


# ─── Model scoping map ───────────────────────────────────────────────────────


def _scoped_models(root: Path) -> dict[str, tuple[str, ...]]:
    """Return ``{ModelName: (fk_field_names, …)}`` for models with a board/card FK.

    Derived from the model modules rather than hardcoded, so a new board-scoped
    model is covered the first time this runs after it lands — the same reason
    check-ws-event-reachability.py reads the event registries instead of
    grepping for literals.

    Only models carrying a **direct** ``board`` or ``card`` foreign key are
    returned. That is deliberately the narrow case: those are exactly the
    lookups where a bare ``pk=`` is a cross-board IDOR, because the pk space is
    global while the resource belongs to one board.
    """
    out: dict[str, tuple[str, ...]] = {}
    for rel in MODEL_MODULES:
        path = root / rel
        if not path.is_file():
            raise CheckerError(f"model module not found: {rel}")
        tree = _parse(root, path, rel)
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            fks: list[str] = []
            for stmt in node.body:
                if not isinstance(stmt, ast.Assign) or not isinstance(stmt.value, ast.Call):
                    continue
                if not _dotted(stmt.value.func).endswith("ForeignKey"):
                    continue
                for target in stmt.targets:
                    if isinstance(target, ast.Name):
                        fks.append(target.id)
            if any(f in ("board", "card", "from_card", "to_card") for f in fks):
                out[node.name] = tuple(fks)
    if not out:
        raise CheckerError("derived no board/card-scoped models — model parsing broke")
    return out


def _parse(root: Path, path: Path, rel: str) -> ast.Module:
    try:
        # Contain the read to --root: a symlinked module must not pull in a
        # file from outside the tree being audited (#1377, S8707).
        safe = resolve_within(root, path)
        return ast.parse(safe.read_text(encoding="utf-8"), filename=str(safe))
    except ValueError as exc:
        raise CheckerError(f"{rel}: unreadable path: {exc}") from exc
    except SyntaxError as exc:
        raise CheckerError(f"{rel}: cannot parse: {exc}") from exc


# ─── Module model ────────────────────────────────────────────────────────────


@dataclass
class Module:
    rel: str
    tree: ast.Module
    # module-level `NAME = [...]` aliases, so `permission_classes = _BOARD_PERMISSIONS`
    # resolves without the checker having to guess.
    list_aliases: dict[str, list[str]] = field(default_factory=dict)
    functions: dict[str, ast.FunctionDef] = field(default_factory=dict)
    classes: list[ast.ClassDef] = field(default_factory=list)


def _load_module(root: Path, rel: str) -> Module:
    path = root / rel
    if not path.is_file():
        raise CheckerError(f"in-scope module not found: {rel}")
    mod = Module(rel=rel, tree=_parse(root, path, rel))
    for node in mod.tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.value, (ast.List, ast.Tuple)):
            names = [_dotted(e) for e in node.value.elts]
            for target in node.targets:
                if isinstance(target, ast.Name):
                    mod.list_aliases[target.id] = [n for n in names if n]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            mod.functions[node.name] = node
        elif isinstance(node, ast.ClassDef):
            mod.classes.append(node)
    return mod


def _in_scope_modules(root: Path) -> list[str]:
    rels: list[str] = []
    for d in SCOPE_DIRS:
        base = root / d
        if not base.is_dir():
            raise CheckerError(f"in-scope directory not found: {d}")
        for p in sorted(base.glob("*.py")):
            if p.name == "__init__.py":
                # Pure re-exports; every class it names is checked at its
                # defining module.
                continue
            rels.append(str(p.relative_to(root)))
    for f in SCOPE_FILES:
        if not (root / f).is_file():
            raise CheckerError(f"in-scope module not found: {f}")
        rels.append(f)
    if not rels:
        raise CheckerError("no in-scope view modules found")
    return rels


# ─── Per-class analysis ──────────────────────────────────────────────────────


def _is_view_class(cls: ast.ClassDef) -> bool:
    for base in cls.bases:
        name = _dotted(base)
        tail = name.rsplit(".", 1)[-1]
        if any(tail.endswith(suffix) for suffix in VIEW_BASE_SUFFIXES):
            return True
    return False


def _is_view_mixin(cls: ast.ClassDef) -> bool:
    """True for a class that is not a view but contributes handlers to one (#2069).

    ``BoardViewSet`` takes its import and invite actions from plain mixins, which
    have no view base for :func:`_is_view_class` to match, so those writes used to
    go unscanned. Detected by name or by carrying an ``@action``, rather than by
    following a viewset's bases into another module.
    """
    if _is_view_class(cls):
        return False
    return cls.name.endswith("Mixin") or any(
        _action_decorator(fn) is not None for fn in _methods(cls).values()
    )


def _methods(cls: ast.ClassDef) -> dict[str, ast.FunctionDef]:
    return {
        n.name: n
        for n in cls.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _action_decorator(fn: ast.FunctionDef):
    """Return the ``@action`` Call node decorating *fn*, or None."""
    for dec in fn.decorator_list:
        if isinstance(dec, ast.Call) and _dotted(dec.func).rsplit(".", 1)[-1] == "action":
            return dec
    return None


def _action_write_methods(dec: ast.Call) -> list[str]:
    for kw in dec.keywords:
        if kw.arg == "methods":
            return sorted(m.lower() for m in _str_list(kw.value) if m.lower() in WRITE_HTTP_METHODS)
    return []


@dataclass
class PermissionClasses:
    names: list[str] | None  # None => not declared as a class attribute
    dynamic: bool = False    # resolved from get_permissions() instead


def _permission_classes(cls: ast.ClassDef, mod: Module) -> PermissionClasses:
    for stmt in cls.body:
        if not isinstance(stmt, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == "permission_classes" for t in stmt.targets):
            continue
        value = stmt.value
        if isinstance(value, (ast.List, ast.Tuple)):
            return PermissionClasses([_dotted(e) for e in value.elts])
        if isinstance(value, ast.Name) and value.id in mod.list_aliases:
            return PermissionClasses(list(mod.list_aliases[value.id]))
        # Anything else (a call, a comprehension, a conditional) is not
        # something this checker may guess at.
        return PermissionClasses(None, dynamic=True)
    methods = _methods(cls)
    if "get_permissions" in methods:
        found = [
            _dotted(c.func).rsplit(".", 1)[-1]
            for c in _calls(methods["get_permissions"])
        ]
        return PermissionClasses(found, dynamic=True)
    return PermissionClasses(None)


@dataclass
class GateEvidence:
    """What a transitive walk of one handler found."""

    resolver: bool = False       # reached a shared role resolver
    role_gate: bool = False      # reached a role comparison / GATE_CALL_NAMES / role= hand-off
    # A role comparison in a helper that never raises: it can only *return* a
    # denial, so it gates only where its caller acts on the result (#2116).
    returned_gate: bool = False
    raw_membership: bool = False # reached a raw BoardMembership/GroupMembership lookup
    unresolved: list[str] = field(default_factory=list)  # calls it could not follow


def _role_named(name: str) -> bool:
    return "role" in name.lower()


def _is_caller_call(call: ast.Call, caller: set[str], methods, mod: Module) -> bool:
    """True when *call* returns the requesting user's role (see the #2116 notes)."""
    dotted = _dotted(call.func)
    tail = dotted.rsplit(".", 1)[-1]
    handed_caller = any(
        _is_caller_expr(a, caller, methods, mod)
        for a in (*call.args, *(kw.value for kw in call.keywords))
    )
    # A resolver answers for whoever it is handed: ``get_board_role(target_user,
    # board)`` is the target's role, and comparing it decides nothing about the
    # caller (``BoardViewSet.members`` does exactly that for its role floor).
    if (tail in ROLE_RESOLVERS or tail in GATE_CALL_NAMES) and handed_caller:
        return True
    if _role_named(tail) and dotted in mod.functions and handed_caller:
        return True
    # ``self._board_and_role()`` resolves from ``self.request``; with arguments,
    # one of them must be the caller.
    if _role_named(tail) and dotted.startswith("self.") and tail in methods:
        return handed_caller or not (call.args or call.keywords)
    # ``getattr(request.user, "role", None)`` and friends.
    return tail == "getattr" and bool(call.args) and _is_caller_expr(call.args[0], caller, methods, mod)


def _is_caller_expr(node: ast.AST, caller: set[str], methods, mod: Module) -> bool:
    """True when *node* is the requesting user's role or identity, not a target's."""
    if isinstance(node, ast.Name):
        return node.id in caller
    if isinstance(node, ast.Attribute):
        dotted = _dotted(node)
        if not dotted:
            return _is_caller_expr(node.value, caller, methods, mod)
        if any(dotted == r or dotted.startswith(r + ".") for r in CALLER_IDENTITY_ROOTS):
            return True
        parts = dotted.split(".")
        if parts[0] == "self":
            return len(parts) > 1 and parts[1] == CALLER_ROLE_CACHE_ATTR
        return parts[0] in caller
    if isinstance(node, ast.Subscript):
        return _is_caller_expr(node.value, caller, methods, mod)
    if isinstance(node, ast.BoolOp):
        return any(_is_caller_expr(v, caller, methods, mod) for v in node.values)
    if isinstance(node, ast.UnaryOp):
        return _is_caller_expr(node.operand, caller, methods, mod)
    if isinstance(node, ast.IfExp):
        return any(_is_caller_expr(v, caller, methods, mod) for v in (node.body, node.orelse))
    if isinstance(node, ast.Call):
        return _is_caller_call(node, caller, methods, mod)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return any(_is_caller_expr(e, caller, methods, mod) for e in node.elts)
    return False


def _caller_names(fn: ast.AST, trusted: frozenset, methods, mod: Module) -> set[str]:
    """Names in *fn* that hold the caller's role or identity: one-step dataflow."""
    caller = set(trusted)
    assigns = []
    for node in _body_nodes(fn):
        if isinstance(node, ast.Assign):
            assigns.append((node.targets, node.value))
        elif isinstance(node, (ast.AnnAssign, ast.NamedExpr)) and node.value is not None:
            assigns.append(([node.target], node.value))
    changed = True
    while changed:
        changed = False
        for targets, value in assigns:
            if not _is_caller_expr(value, caller, methods, mod):
                continue
            for t in targets:
                if isinstance(t, ast.Name):
                    new = {t.id}
                elif isinstance(t, (ast.Tuple, ast.List)):
                    # ``board, role = get_board_for_user(...)``: only ``role``.
                    new = {e.id for e in t.elts if isinstance(e, ast.Name) and _role_named(e.id)}
                else:
                    new = set()
                if not new <= caller:
                    caller |= new
                    changed = True
    # Statement order is not tracked, so a name later rebound to anything that
    # is not the caller (``role = member_role``) cannot be trusted at every
    # comparison. Fail closed: drop it unless it is a trusted parameter.
    rebound = set()
    for targets, value in assigns:
        if _is_caller_expr(value, caller, methods, mod):
            continue
        for t in targets:
            for n in ast.walk(t):
                if isinstance(n, ast.Name):
                    rebound.add(n.id)
    for node in _body_nodes(fn):
        tgts = []
        if isinstance(node, (ast.For, ast.AsyncFor, ast.comprehension)):
            tgts = [node.target]
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            tgts = [node.optional_vars]
        elif isinstance(node, ast.AugAssign):
            tgts = [node.target]
        for tg in tgts:
            rebound |= {n.id for n in ast.walk(tg) if isinstance(n, ast.Name)}
    return caller - (rebound - set(trusted))


def _trusted_params(call: ast.Call, target: ast.FunctionDef, caller: set[str], methods, mod: Module) -> frozenset:
    """Parameters of *target* that this call site hands a caller operand."""
    params = [a.arg for a in (*target.args.posonlyargs, *target.args.args)]
    if _dotted(call.func).startswith("self.") and params and params[0] in ("self", "cls"):
        params = params[1:]
    out = set()
    for name, arg in zip(params, call.args):
        if _is_caller_expr(arg, caller, methods, mod):
            out.add(name)
    for kw in call.keywords:
        if kw.arg and _is_caller_expr(kw.value, caller, methods, mod):
            out.add(kw.arg)
    return frozenset(out)


def _parents(fn: ast.AST) -> dict:
    return {
        child: parent
        for stmt in fn.body
        for parent in ast.walk(stmt)
        for child in ast.iter_child_nodes(parent)
    }


def _consumed(call: ast.Call, fn: ast.AST, parents: dict) -> bool:
    """True when the handler acts on *call*'s result (#2116).

    Acting means returning it, testing it in an ``if``/``while``/``assert``, or
    binding it to a name that is later returned or tested. ``denied =
    _annotation_denied(role)`` with the ``if denied is not None: return denied``
    after it deleted has a result nobody reads, so the comparison inside the
    helper refuses nothing — and used to count as the handler's role gate.
    """
    child, node = call, call
    while not isinstance(node, ast.stmt) and node in parents:
        child, node = node, parents[node]
    if isinstance(node, (ast.Return, ast.Raise)):
        return True
    if isinstance(node, (ast.If, ast.While, ast.Assert)):
        return child is node.test
    if isinstance(node, (ast.Assign, ast.AnnAssign)):
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        names = {n.id for t in targets for n in ast.walk(t) if isinstance(n, ast.Name)}
        for st in _body_nodes(fn):
            if isinstance(st, (ast.If, ast.While, ast.Assert)):
                expr = st.test
            elif isinstance(st, ast.Return) and st.value is not None:
                expr = st.value
            else:
                continue
            if any(isinstance(n, ast.Name) and n.id in names for n in ast.walk(expr)):
                return True
    return False


def _raises_directly(stmts) -> bool:
    """True when *stmts* runs a ``raise`` whenever the block itself runs (#2166).

    Only a ``raise`` that is a statement of the block counts, or one in a
    ``with`` block that is (``with transaction.atomic(): raise ...``). A raise
    under a nested ``if``/``elif``, loop or ``try`` is decided by another test,
    and one inside a nested def does not run with the block at all.
    """
    for st in stmts:
        if isinstance(st, ast.Raise):
            return True
        if isinstance(st, (ast.With, ast.AsyncWith)) and _raises_directly(st.body):
            return True
    return False


def _block_of(stmt: ast.stmt, fn: ast.AST, parents: dict) -> list:
    """The statement list that holds *stmt* (``fn.body`` for a top-level one)."""
    parent = parents.get(stmt, fn)
    for name in ("body", "orelse", "finalbody"):
        block = getattr(parent, name, None)
        if isinstance(block, list) and any(st is stmt for st in block):
            return block
    return []


def _branch_raises(stmt: ast.stmt, fn: ast.AST, parents: dict) -> bool:
    """True when a branch that *stmt*'s test decides raises (#2166).

    Either branch counts when it raises unconditionally (``if role not in X:
    raise`` and ``if role in X: ... else: raise`` both refuse on the
    comparison's outcome), and so does an unconditional ``raise`` straight after
    an ``if`` whose body always leaves (``if role in X: return None`` then
    ``raise PermissionDenied``): that raise is reached only on the comparison's
    other outcome. A ``raise`` anywhere else in the helper is decided by a
    different test and proves nothing about this one: an unrelated ``if role is
    None: raise ValueError``, an ``elif other: raise`` (an ``elif`` is a nested
    ``if`` in ``orelse``), or a raise under an inner ``if`` in either branch.
    """
    if _raises_directly(stmt.body) or _raises_directly(stmt.orelse):
        return True
    if not isinstance(stmt, ast.If) or stmt.orelse or not stmt.body:
        return False
    if not isinstance(stmt.body[-1], (ast.Return, ast.Raise)):
        return False
    block = _block_of(stmt, fn, parents)
    idx = next((i for i, st in enumerate(block) if st is stmt), None)
    return idx is not None and idx + 1 < len(block) and isinstance(block[idx + 1], ast.Raise)


def _comparison_bound_names(targets, value, node: ast.AST) -> set:
    """Names that receive the sub-expression containing *node* (#2166)."""
    names: set = set()

    def holds(expr) -> bool:
        return expr is not None and any(n is node for n in ast.walk(expr))

    def bind(t, v) -> None:
        if isinstance(t, ast.Name):
            if holds(v):
                names.add(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            if isinstance(v, (ast.Tuple, ast.List)) and len(v.elts) == len(t.elts):
                for te, ve in zip(t.elts, v.elts):
                    bind(te, ve)

    for t in targets:
        bind(t, value)
    return names


def _raise_guarded(node: ast.AST, fn: ast.AST, parents: dict) -> bool:
    """True when *node*'s outcome decides whether a ``raise`` runs (#2166).

    That is: *node* is in a ``raise`` statement, or is (part of) the test of an
    ``if``/``while`` with a raising branch (see :func:`_branch_raises`), or is
    bound to a name that such a test reads. Before #2166 a helper counted as
    raising if it held any ``raise`` at all, so an unrelated one let a caller
    drop the helper's returned denial and still pass.
    """
    child, stmt = node, node
    while not isinstance(stmt, ast.stmt) and stmt in parents:
        child, stmt = stmt, parents[stmt]
    if isinstance(stmt, ast.Raise):
        return True
    if isinstance(stmt, (ast.If, ast.While)) and child is stmt.test:
        return _branch_raises(stmt, fn, parents)
    if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        # Bare names only, paired with the value element they receive:
        # ``self._ok = ...`` / ``ctx["ok"] = ...`` bind no name an ``if`` can
        # read back, and ``ok, flag = role in X, role is None`` binds only
        # ``ok`` to the comparison. A tuple target with a non-matching value
        # binds nothing.
        names = _comparison_bound_names(targets, getattr(stmt, "value", None), node)
        for st in _body_nodes(fn):
            if (
                isinstance(st, (ast.If, ast.While))
                and any(isinstance(n, ast.Name) and n.id in names for n in ast.walk(st.test))
                and _branch_raises(st, fn, parents)
            ):
                return True
    return False


def _scan_gates(
    fn: ast.FunctionDef,
    cls: ast.ClassDef,
    mod: Module,
    *,
    depth: int = 0,
    seen: frozenset = frozenset(),
    trusted: frozenset = frozenset(),
) -> GateEvidence:
    """Walk *fn*, following same-class methods and same-module functions.

    Returns what the walk proved. ``unresolved`` collects calls that *might*
    hold the gate but live outside this module — used only to decide whether a
    handler with no gate found is a finding (the gate is genuinely absent) or a
    defer (the gate may be somewhere the checker cannot read).

    *trusted* names the parameters the call site handed the caller's role or
    identity; see the #2116 notes above :data:`CALLER_IDENTITY_ROOTS`.
    """
    ev = GateEvidence()
    if depth > _RESOLVE_MAX_DEPTH:
        ev.unresolved.append(f"{fn.name} (recursion depth cap)")
        return ev

    methods = _methods(cls)
    locals_ = _local_names(fn)
    caller = _caller_names(fn, trusted, methods, mod)
    parents = _parents(fn)
    cmp_gate = False
    # Whether a gate found here refuses by raising on its own outcome (#2166).
    raise_gate = False

    # A role comparison anywhere in the body, on the caller's side (#2116).
    for cmp_node in (n for n in _body_nodes(fn) if isinstance(n, ast.Compare)):
        left_blob = "".join(
            _dotted(sub)
            for sub in ast.walk(cmp_node.left)
            if isinstance(sub, (ast.Attribute, ast.Name))
        )
        right_blob = "".join(
            _dotted(sub)
            for c in cmp_node.comparators
            for sub in ast.walk(c)
            if isinstance(sub, (ast.Attribute, ast.Name))
        )
        blob = left_blob + right_blob
        sentinel_only = all(
            isinstance(c, ast.Constant) and c.value in (None, True, False)
            for c in cmp_node.comparators
        )
        role_shaped = any(marker in blob for marker in STRONG_ROLE_MARKERS) or (
            not sentinel_only
            and any(m in left_blob.lower() for m in SUBJECT_ROLE_MARKERS)
        )
        if role_shaped and _consumed(cmp_node, fn, parents) and any(
            _is_caller_expr(op, caller, methods, mod)
            for op in (cmp_node.left, *cmp_node.comparators)
        ):
            cmp_gate = True
            if _raise_guarded(cmp_node, fn, parents):
                raise_gate = True
                break

    for call in _calls(fn):
        dotted = _dotted(call.func)
        if not dotted:
            continue
        tail = dotted.rsplit(".", 1)[-1]

        if any(dotted.startswith(p) or f".{p}" in dotted for p in RAW_MEMBERSHIP_LOOKUPS):
            ev.raw_membership = True

        # Follow into same-class methods and same-module functions. Done even
        # for a recognized resolver: `_require_group_admin()` is named a resolver
        # AND holds the role check, so stopping here would report the gate missing.
        target = None
        if dotted.startswith("self.") and tail in methods:
            target = methods[tail]
        elif dotted in ("self.get_object", "self.get_queryset") and "get_queryset" in methods:
            # DRF routes `get_object()` through `get_queryset()`, so a viewset
            # whose queryset is access-scoped (BoardViewSet, GroupViewSet) has
            # already resolved membership by the time the handler holds an
            # object. Following the link is what makes that visible.
            target = methods["get_queryset"]
        elif dotted in mod.functions:
            target = mod.functions[dotted]

        recognized = False
        if tail in ROLE_RESOLVERS:
            ev.resolver = True
            recognized = True
        # Only when the body cannot be read: what a readable helper does decides.
        # Handed the caller (#2116): ``user_is_group_admin(target_user, g)``
        # decides about the target. A predicate's answer must also be acted on.
        if tail in GATE_CALL_NAMES and target is None:
            recognized = True
            handed_caller = any(
                _is_caller_expr(a, caller, methods, mod)
                for a in (*call.args, *(kw.value for kw in call.keywords))
            )
            if handed_caller:
                if tail in GATE_PREDICATE_NAMES:
                    if _consumed(call, fn, parents):
                        cmp_gate = True
                        raise_gate |= _raise_guarded(call, fn, parents)
                else:
                    ev.role_gate = True
        if dotted.split(".", 1)[0] in ROLE_DELEGATION_ROOTS and any(
            kw.arg == ROLE_DELEGATION_KWARG
            and _is_caller_expr(kw.value, caller, methods, mod)
            for kw in call.keywords
        ):
            ev.role_gate = True
            recognized = True
        if target is not None:
            key = f"{cls.name}.{target.name}"
            if key not in seen:
                inner = _scan_gates(
                    target, cls, mod, depth=depth + 1, seen=seen | {key},
                    trusted=_trusted_params(call, target, caller, methods, mod),
                )
                ev.resolver |= inner.resolver
                ev.role_gate |= inner.role_gate
                if inner.returned_gate and _consumed(call, fn, parents):
                    cmp_gate = True
                    raise_gate |= _raise_guarded(call, fn, parents)
                ev.raw_membership |= inner.raw_membership
                ev.unresolved.extend(inner.unresolved)
            continue
        if recognized or dotted.startswith(("self.", "cls.")):
            # A call this checker already understands is never also an
            # unresolved place the gate "might" be hiding — classifying it both
            # ways would turn every recognized resolver into a defer.
            continue
        root = dotted.split(".", 1)[0]
        if root in locals_:
            # A method on something this handler bound itself
            # (`instance.delete()`, `serializer.save()`) — nothing module-level
            # behind it that could hold a gate.
            continue
        if tail in NOT_A_GATE_NAMES or any(
            s in dotted.lower() for s in NOT_A_GATE_SUBSTRINGS
        ):
            continue
        arg_text = " ".join(
            _dotted(a) for a in call.args
        ) + " " + " ".join(
            f"{kw.arg or ''} {_dotted(kw.value)}" for kw in call.keywords
        )
        if not any(m in arg_text.lower() for m in GATE_SUBJECT_MARKERS):
            # Handed neither a subject nor an object — cannot be an
            # authorization decision.
            continue
        # A call through a module-level or imported target, handed the subject
        # of an authorization decision: it may hold the gate, and this checker
        # cannot read it.
        ev.unresolved.append(dotted)

    # A comparison refuses by raising, or by returning a denial. A handler's
    # return is the response; a helper's return is only a value its caller may
    # drop, so a helper whose comparison does not decide a raise passes its gate
    # up as returned_gate, and the caller counts it only where it acts on the
    # result (#2116). The raise must be on the branch the comparison decides:
    # an unrelated ``raise`` elsewhere in the helper refuses nothing (#2166).
    if cmp_gate:
        if depth == 0 or raise_gate:
            ev.role_gate = True
        else:
            ev.returned_gate = True

    # Nested functions defined in the handler (on_commit closures and the like)
    # were already covered by ast.walk above.
    return ev


def _is_scoped(cls: ast.ClassDef, mod: Module) -> bool:
    """True when the class is board- or group-scoped.

    Structural, not name-based: the class either takes a ``board_pk``/``board_id``
    /``group`` path argument on a handler, or reaches one of the shared role
    resolvers somewhere in its body.
    """
    for node in ast.walk(cls):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for arg in node.args.args + node.args.kwonlyargs:
                if arg.arg in ("board_pk", "board_id", "group_pk", "group_id"):
                    return True
        if isinstance(node, ast.Call):
            if _dotted(node.func).rsplit(".", 1)[-1] in ROLE_RESOLVERS:
                return True
        if isinstance(node, ast.Constant) and node.value in ("board_pk", "board_id"):
            return True
    return False


def _write_handlers(cls: ast.ClassDef) -> list[tuple[str, tuple[ast.FunctionDef, ...]]]:
    """Return ``[(action_label, (handler, …)), …]`` for every write action."""
    methods = _methods(cls)
    groups: list[tuple[str, tuple[ast.FunctionDef, ...]]] = []

    for label, names in DRF_ACTION_GROUPS:
        present = tuple(methods[n] for n in names if n in methods)
        if present:
            groups.append((label, present))

    for name, fn in methods.items():
        dec = _action_decorator(fn)
        if dec is not None:
            writes = _action_write_methods(dec)
            if writes:
                groups.append((f"@action {name} [{','.join(writes)}]", (fn,)))
        elif name in WRITE_HTTP_METHODS:
            groups.append((f"{name.upper()}", (fn,)))

    return groups


def _unscoped_lookups(fn: ast.FunctionDef, scoped_models: dict[str, tuple[str, ...]]) -> list[str]:
    """Return board/card-scoped model lookups made with no scoping argument.

    ``get_object_or_404(Card, pk=pk)`` on a board-scoped resource is a
    cross-board IDOR: pk space is global, the resource is not. The accepted
    shapes are a scoping keyword (``board=``, ``card=``, …) or a pre-filtered
    queryset / extra positional filter as the first argument.
    """
    bad: list[str] = []
    for call in _calls(fn):
        tail = _dotted(call.func).rsplit(".", 1)[-1]
        if tail not in ("get_object_or_404", "get_list_or_404"):
            continue
        if not call.args:
            continue
        first = call.args[0]
        model = _dotted(first)
        # A pre-filtered queryset (`Card.objects.filter(board=board)`) or an
        # extra positional filter (a Q object) already constrains the lookup.
        if isinstance(first, ast.Call) or len(call.args) > 1:
            continue
        if model not in scoped_models:
            continue
        fks = scoped_models[model]
        if any(kw.arg in fks for kw in call.keywords):
            continue
        bad.append(f"{model} (line {call.lineno})")
    return bad


# ─── The check ───────────────────────────────────────────────────────────────


@dataclass
class Report:
    findings: list[str] = field(default_factory=list)
    defers: list[str] = field(default_factory=list)
    classes_checked: int = 0
    handlers_checked: int = 0
    public: int = 0
    reviewed: int = 0
    viewer_permitted: int = 0


def run(root: Path, *, quiet: bool = False) -> Report:
    rep = Report()
    scoped_models = _scoped_models(root)
    used_public: set[str] = set()
    used_reviewed: set[str] = set()
    used_viewer_ok: set[str] = set()

    for rel in _in_scope_modules(root):
        mod = _load_module(root, rel)
        for cls in mod.classes:
            mixin = _is_view_mixin(cls)
            if not mixin and not _is_view_class(cls):
                continue
            key = f"{rel}::{cls.name}"
            rep.classes_checked += 1

            perms = _permission_classes(cls, mod)
            has_auth = bool(perms.names) and any(
                n.rsplit(".", 1)[-1] == AUTH_PERMISSION for n in perms.names
            )

            # ── 1. Authentication gate ──────────────────────────────────────
            if mixin:
                # permission_classes belongs to the viewset the mixin joins, and
                # that viewset is checked here as a view class in its own right.
                pass
            elif key in PUBLIC_BY_DESIGN:
                used_public.add(key)
                rep.public += 1
                if has_auth:
                    rep.findings.append(
                        f"{key}: recorded in PUBLIC_BY_DESIGN but now requires "
                        f"{AUTH_PERMISSION} — delete the stale entry."
                    )
            elif perms.names is None and not perms.dynamic:
                rep.findings.append(
                    f"{key}: declares no permission_classes, so its auth gate is "
                    f"whatever DEFAULT_PERMISSION_CLASSES happens to be. Enumerate "
                    f"the chain explicitly (#989/#1050)."
                )
            elif perms.names is None and perms.dynamic:
                # A recorded agent review is the hand-off this defer asks for
                # (e.g. a chain imported from another module, which only list
                # aliases defined in the same module can resolve) — honor it here
                # too, or the documented fix for this defer could never clear it.
                # Either way the chain is unreadable, so the empty-chain test
                # below must not run on it.
                if key not in AGENT_REVIEWED:
                    rep.defers.append(
                        f"{key}: permission_classes is computed at run time — this "
                        f"checker cannot read the auth gate."
                    )
            elif not has_auth:
                rep.findings.append(
                    f"{key}: permission_classes {perms.names or '[]'} does not "
                    f"include {AUTH_PERMISSION} — unauthenticated access to "
                    f"board data. Add it, or record the endpoint in "
                    f"PUBLIC_BY_DESIGN with what stands in for authentication."
                )

            # Consumed before the scoping test below, so a class recorded as
            # agent-reviewed BECAUSE the role ladder does not apply to it (a
            # capability-token endpoint, say) still counts its entry as used.
            # Otherwise the blind spot would be invisible in both directions:
            # the class skipped silently, and its recorded review reported stale.
            reviewed_class = key in AGENT_REVIEWED
            if reviewed_class:
                used_reviewed.add(key)
                rep.reviewed += 1

            if not mixin and not _is_scoped(cls, mod):
                # Not board/group-scoped: the role ladder has nothing to say
                # about it, and checks 2 and 3 do not apply. A mixin is always
                # checked: its handlers run on a scoped viewset, and its body may
                # only reach the resolver through that viewset.
                continue

            for label, handlers in _write_handlers(cls):
                rep.handlers_checked += 1
                handler_key = f"{key}::{label}"
                if handler_key in AGENT_REVIEWED:
                    used_reviewed.add(handler_key)
                    rep.reviewed += 1
                    continue
                if reviewed_class:
                    continue

                merged = GateEvidence()
                for fn in handlers:
                    ev = _scan_gates(fn, cls, mod)
                    merged.resolver |= ev.resolver
                    merged.role_gate |= ev.role_gate
                    merged.raw_membership |= ev.raw_membership
                    merged.unresolved.extend(ev.unresolved)

                # ── 2. Membership check ─────────────────────────────────────
                if not merged.resolver:
                    if merged.raw_membership:
                        rep.findings.append(
                            f"{handler_key}: resolves access from a raw "
                            f"membership row instead of get_board_role() — that "
                            f"path skips the group-inheritance rungs of the "
                            f"precedence ladder."
                        )
                    elif merged.unresolved:
                        rep.defers.append(
                            f"{handler_key}: no membership resolution found here; "
                            f"it may be inside {merged.unresolved[0]}, which is "
                            f"outside this module."
                        )
                    else:
                        rep.findings.append(
                            f"{handler_key}: writes without resolving the "
                            f"caller's role — no get_board_for_user() / "
                            f"get_board_role() / _require_group_* on any path."
                        )

                # ── 3. Minimum-role check ───────────────────────────────────
                if handler_key in VIEWER_PERMITTED_WRITES:
                    used_viewer_ok.add(handler_key)
                    rep.viewer_permitted += 1
                    if merged.role_gate:
                        rep.findings.append(
                            f"{handler_key}: recorded in VIEWER_PERMITTED_WRITES "
                            f"but now carries a role gate — delete the stale entry."
                        )
                elif not merged.role_gate:
                    if merged.unresolved:
                        rep.defers.append(
                            f"{handler_key}: no role gate found here; it may be "
                            f"inside {merged.unresolved[0]}, which is outside "
                            f"this module."
                        )
                    else:
                        rep.findings.append(
                            f"{handler_key}: no minimum-role check — any board "
                            f"member, including a viewer, can reach this write."
                        )

                # ── cross-board isolation (mechanical slice) ────────────────
                for fn in handlers:
                    for bad in _unscoped_lookups(fn, scoped_models):
                        rep.findings.append(
                            f"{handler_key}: looks up {bad} by pk with no "
                            f"board/card scoping — a member of another board can "
                            f"reach this object by id."
                        )

    for key, reason in PUBLIC_BY_DESIGN.items():
        if key not in used_public:
            rep.findings.append(
                f"PUBLIC_BY_DESIGN entry {key} matches no view class any more — "
                f"delete it. (recorded reason: {reason.splitlines()[0]})"
            )
    for key, reason in VIEWER_PERMITTED_WRITES.items():
        if key not in used_viewer_ok:
            rep.findings.append(
                f"VIEWER_PERMITTED_WRITES entry {key} matches no write action any "
                f"more — delete it. (recorded reason: {reason.splitlines()[0]})"
            )
    rep.findings.extend(_guard_findings(root))
    for key, reason in AGENT_REVIEWED.items():
        if key not in used_reviewed:
            rep.findings.append(
                f"AGENT_REVIEWED entry {key} matches no view class or handler any "
                f"more — delete it. (recorded reason: {reason.splitlines()[0]})"
            )

    if not quiet:
        _print_report(rep)
    return rep


def _print_report(rep: Report) -> None:
    for f in rep.findings:
        print(f"FINDING: {f}")
    for d in rep.defers:
        print(f"DEFER:   {d}")
    print()
    print(
        f"check-rbac-coverage: {rep.classes_checked} view class(es), "
        f"{rep.handlers_checked} write action(s) — "
        f"{len(rep.findings)} finding(s), {len(rep.defers)} defer(s), "
        f"{rep.public} public-by-design, {rep.viewer_permitted} viewer-permitted, "
        f"{rep.reviewed} agent-reviewed."
    )
    if rep.defers:
        print()
        print(
            "One or more views could not be classified. Run the `rbac-check` "
            "agent on each DEFER above, then either fix the gap or record the "
            "review in AGENT_REVIEWED in this script. A defer is not a pass."
        )
    elif not rep.findings:
        print("All in-scope board/group endpoints carry their RBAC gates.")


# ─── Self-test (#1093) ───────────────────────────────────────────────────────

_FIXTURE_MODELS = '''\
from django.db import models


class Board(models.Model):
    owner = models.ForeignKey("accounts.User", on_delete=models.CASCADE)


class Card(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE)
    created_by = models.ForeignKey("accounts.User", on_delete=models.CASCADE)


class CardComment(models.Model):
    card = models.ForeignKey(Card, on_delete=models.CASCADE)
    author = models.ForeignKey("accounts.User", on_delete=models.CASCADE)
'''

_FIXTURE_HELPERS = '''\
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated

from ..models import BoardMembership, Card, CardAttachment, CardComment
from ..permissions import SITE_ADMIN, get_board_for_user


class CardViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.MEMBER, BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        serializer.save(board=board)

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        instance.delete()

    @action(detail=True, methods=["post"])
    def comments(self, request, board_pk=None, pk=None):
        board, role = self._board_and_role()
        if role == BoardMembership.Role.VIEWER:
            raise PermissionDenied
        card = get_object_or_404(Card, pk=pk, board=board)
        CardComment.objects.create(card=card, author=request.user)
'''

_FIXTURE_PUBLIC = '''\
from rest_framework.views import APIView


class LivenessView(APIView):
    permission_classes = []

    def get(self, request):
        return None
'''

_FIXTURE_GROUPS = '''\
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated


def _require_group_admin(user, group):
    if not user_is_group_admin(user, group):
        raise PermissionDenied


def _require_group_member(user, group):
    if not user_has_group_access(user, group):
        raise PermissionDenied


class GroupViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def destroy(self, request, group_id=None, *args, **kwargs):
        group = self.get_object()
        _require_group_admin(request.user, group)
        group.delete()

    @action(detail=True, methods=["patch", "delete"], url_path=r"members/(?P<user_id>[0-9]+)")
    def update_member(self, request, pk=None, user_id=None):
        group = self.get_object()
        _require_group_admin(request.user, group)
        locked = GroupMembership.objects.filter(group=group, user_id=user_id).first()
        if locked.role == GroupMembership.Role.ADMIN:
            # The helper is handed the target, so it says nothing about the caller.
            _require_group_admin(locked.user, group)
        locked.delete()
'''

_FIXTURE_LENS = '''\
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated

from boards.permissions import get_board_for_user

_BOARD_PERMISSIONS = [IsAuthenticated]


def _require_board_admin(role):
    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        raise PermissionDenied


class LensConnectionView(APIView):
    permission_classes = _BOARD_PERMISSIONS

    def delete(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user)
        _require_board_admin(role)
'''

_FIXTURE_MIXIN = '''\
from rest_framework.decorators import action

from ..permissions import get_board_for_user


def _require_board_admin(pk, user):
    board, role = get_board_for_user(pk, user)
    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
        raise PermissionDenied
    return board


class BoardInviteLinksMixin:
    @action(detail=True, methods=["post"])
    def invite_links(self, request, pk=None):
        board = _require_board_admin(pk, request.user)
        BoardInviteLink.generate(board=board, role="viewer")
'''

_FIXTURE_TARGETS = '''\
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .. import services as card_services
from ..models import BoardMembership, Card, CardComment
from ..permissions import SITE_ADMIN, get_board_for_user, get_board_role
from ..permissions import can_modify_others_content as _can_modify_others_content


def _annotation_denied(role):
    if role in card_services.ANNOTATION_ROLES:
        return None
    return Response(status=status.HTTP_403_FORBIDDEN)


class TargetRowViewSet(viewsets.ModelViewSet):
    """#2116: each write compares a role that is not the caller's."""

    permission_classes = [IsAuthenticated]

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    @action(detail=True, methods=["post"])
    def members(self, request, pk=None):
        board, role = get_board_for_user(pk, request.user)
        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            raise PermissionDenied
        member_role = request.data.get("role", BoardMembership.Role.MEMBER)
        if member_role not in BoardMembership.Role.values:
            return Response(status=status.HTTP_400_BAD_REQUEST)
        existing = BoardMembership.objects.filter(board=board, user_id=request.data["user_id"]).first()
        if existing.role == BoardMembership.Role.ADMIN:
            return Response(status=status.HTTP_400_BAD_REQUEST)
        current = get_board_role(existing.user, board)
        if current in (BoardMembership.Role.ADMIN, SITE_ADMIN):
            member_role = current
        existing.role = member_role
        existing.save()

    @action(detail=True, methods=["post"])
    def comments(self, request, board_pk=None, pk=None):
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)
        denied = _annotation_denied(role)
        if denied is not None:
            return denied
        CardComment.objects.create(card=card, author=request.user)

    @action(detail=True, methods=["delete"], url_path=r"comments/(?P<comment_pk>[0-9]+)")
    def delete_comment(self, request, board_pk=None, pk=None, comment_pk=None):
        board, role = self._board_and_role()
        denied = _annotation_denied(role)
        if denied is not None:
            return denied
        card = get_object_or_404(Card, pk=pk, board=board)
        comment = get_object_or_404(CardComment, pk=comment_pk, card=card)
        if comment.author_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied
        comment.delete()

    @action(detail=True, methods=["patch"], url_path=r"checklist/(?P<item_pk>[0-9]+)")
    def checklist_item(self, request, board_pk=None, pk=None, item_pk=None):
        board, role = self._board_and_role()
        if role not in card_services.ANNOTATION_ROLES:
            raise PermissionDenied
        card = get_object_or_404(Card, pk=pk, board=board)
        if card.created_by_id != request.user.id:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied
        card.save()

    @action(detail=True, methods=["post"])
    def attachments(self, request, board_pk=None, pk=None):
        board, role = self._board_and_role()
        card = get_object_or_404(Card, pk=pk, board=board)
        denied = _annotation_denied(role)
        if denied is not None:
            return denied
        CardAttachment.objects.create(card=card, uploaded_by=request.user)

    @action(detail=True, methods=["delete"], url_path=r"attachments/(?P<attachment_pk>[0-9]+)")
    def delete_attachment(self, request, board_pk=None, pk=None, attachment_pk=None):
        board, role = self._board_and_role()
        denied = _annotation_denied(role)
        if denied is not None:
            return denied
        card = get_object_or_404(Card, pk=pk, board=board)
        attachment = get_object_or_404(CardAttachment, pk=attachment_pk, card=card)
        if attachment.uploaded_by != request.user:
            if not _can_modify_others_content(board, role, request.user):
                raise PermissionDenied
        attachment.delete()
'''

_FIXTURE = {
    "backend/boards/models.py": _FIXTURE_MODELS,
    "backend/boards/views/__init__.py": "from .cards import CardViewSet  # noqa\n",
    "backend/boards/views/cards.py": _FIXTURE_HELPERS,
    "backend/boards/views/targets.py": _FIXTURE_TARGETS,
    "backend/boards/views/health.py": _FIXTURE_PUBLIC,
    "backend/boards/views/share.py": (
        "from rest_framework.views import APIView\n\n\n"
        "class ShareBoardView(APIView):\n"
        "    permission_classes = []\n\n"
        "    def get(self, request, token):\n        return None\n"
    ),
    "backend/groups/views.py": _FIXTURE_GROUPS,
    "backend/git_lens/views.py": _FIXTURE_LENS,
    # A scope file must exist; the fixture's webhooks module declares no views.
    "backend/webhooks/views.py": "",
}

# The fixture tree stands in for the real one, so the recorded-exception tables
# have to match it rather than the repository. Swapped in around each case.
_FIXTURE_PUBLIC_BY_DESIGN = {
    "backend/boards/views/health.py::LivenessView": "fixture: liveness probe.",
    "backend/boards/views/share.py::ShareBoardView": "fixture: token is the credential.",
}
_FIXTURE_AGENT_REVIEWED: dict[str, str] = {}
_FIXTURE_VIEWER_PERMITTED: dict[str, str] = {}


def _materialize(root: Path, overrides=None):
    for rel, body in {**_FIXTURE, **(overrides or {})}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")


def _mutate(rel, old, new):
    return {rel: _FIXTURE[rel].replace(old, new, 1)}


def self_test() -> int:
    """Prove each detector still fires against a deliberately broken fixture."""
    # (name, fixture overrides, expected finding substring, expected defer
    #  substring, recorded-exception table overrides)
    cases = [
        ("clean fixture passes", {}, None, None, {}),
        (
            "write action with no minimum-role check",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        instance.delete()",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            "write action that never resolves a role",
            _mutate(
                "backend/boards/views/cards.py",
                "    def perform_destroy(self, instance):\n"
                "        board, role = self._board_and_role()\n",
                "    def perform_destroy(self, instance):\n",
            ),
            "without resolving the caller's role",
            None,
            {},
        ),
        (
            "auth gate dropped from permission_classes",
            _mutate(
                "backend/boards/views/cards.py",
                "    permission_classes = [IsAuthenticated]",
                "    permission_classes = [AllowAny]",
            ),
            "does not include IsAuthenticated",
            None,
            {},
        ),
        (
            "view class declaring no permission_classes at all",
            _mutate(
                "backend/boards/views/cards.py",
                "    permission_classes = [IsAuthenticated]\n",
                "",
            ),
            "declares no permission_classes",
            None,
            {},
        ),
        (
            "board-scoped lookup with no board/card scoping (IDOR)",
            _mutate(
                "backend/boards/views/cards.py",
                "get_object_or_404(Card, pk=pk, board=board)",
                "get_object_or_404(Card, pk=pk)",
            ),
            "with no board/card scoping",
            None,
            {},
        ),
        (
            "role resolved from a raw membership row, skipping group inheritance",
            _mutate(
                "backend/boards/views/cards.py",
                "    def _board_and_role(self):\n"
                "        return get_board_for_user(self.kwargs[\"board_pk\"], self.request.user)",
                "    def _board_and_role(self):\n"
                "        m = BoardMembership.objects.get(user=self.request.user)\n"
                "        return m.board, m.role",
            ),
            "raw membership row",
            None,
            {},
        ),
        (
            "stale PUBLIC_BY_DESIGN entry (endpoint gained an auth gate)",
            _mutate(
                "backend/boards/views/health.py",
                "    permission_classes = []",
                "    permission_classes = [IsAuthenticated]",
            ),
            "recorded in PUBLIC_BY_DESIGN but now requires",
            None,
            {},
        ),
        (
            "unreadable permission_classes defers instead of passing",
            _mutate(
                "backend/git_lens/views.py",
                "    permission_classes = _BOARD_PERMISSIONS",
                "    permission_classes = build_permissions()",
            ),
            None,
            "cannot read the auth gate",
            {},
        ),
        (
            "unreadable permission_classes clears once AGENT_REVIEWED records it",
            _mutate(
                "backend/git_lens/views.py",
                "    permission_classes = _BOARD_PERMISSIONS",
                "    permission_classes = build_permissions()",
            ),
            None,
            None,
            {"reviewed": {
                "backend/git_lens/views.py::LensConnectionView":
                    "fixture: chain reviewed by the rbac-check agent."
            }},
        ),
        (
            "gate possibly held by another module defers instead of passing",
            _mutate(
                "backend/groups/views.py",
                "        _require_group_admin(request.user, group)\n",
                "        external.check(request.user, group)\n",
            ),
            None,
            "outside this module",
            {},
        ),
        (
            # #2069: lock_board_and_row_or_404 is handed a board and is not
            # authorization. This case failing means a missing gate reads as a
            # DEFER, which invites an AGENT_REVIEWED entry instead of a fix.
            "row-lock helper does not hide a missing role gate behind a defer",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        lock_board_and_row_or_404(board, Card, instance.pk)\n"
                "        instance.delete()",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: the `require_` prefix used to make this pass, exit 0.
            "require_json_object is not a role gate",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        require_json_object(self.request)\n"
                "        instance.delete()",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: same-module and role-free, so nothing can be hiding in it.
            "a same-module _require_ helper with no role check is not a role gate",
            {"backend/boards/views/cards.py": _FIXTURE_HELPERS.replace(
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        self._require_session()\n"
                "        instance.delete()",
                1,
            ).replace(
                "    def perform_create(self, serializer):\n",
                "    def _require_session(self):\n"
                "        raise NotImplementedError\n\n"
                "    def perform_create(self, serializer):\n",
                1,
            )},
            "no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: fail closed. A helper off the GATE_CALL_NAMES list that
            # might hold the gate goes to the agent; it is not trusted on its name.
            "an unlisted imported _require_ helper defers instead of passing",
            _mutate(
                "backend/groups/views.py",
                "        _require_group_admin(request.user, group)\n",
                "        _require_group_owner(request.user, group)\n",
            ),
            None,
            "outside this module",
            {},
        ),
        (
            # #2069: a group viewer passes this helper, so it proves membership.
            "_require_group_member is not a minimum-role check",
            _mutate(
                "backend/groups/views.py",
                "        _require_group_admin(request.user, group)\n",
                "        _require_group_member(request.user, group)\n",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: readable helpers are judged on their body, not their name.
            "an emptied same-module board role helper is not a role gate",
            _mutate(
                "backend/git_lens/views.py",
                "    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "        raise PermissionDenied\n",
                "    return None\n",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            "an emptied same-module group role helper is not a role gate",
            _mutate(
                "backend/groups/views.py",
                "    if not user_is_group_admin(user, group):\n"
                "        raise PermissionDenied\n",
                "    return None\n",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: a role= the link stores is not a role the caller was checked for.
            "role= on an invite-link mint is not a role hand-off",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        GroupInviteLink.generate(group=board, role=role)\n"
                "        instance.delete()",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        (
            # Control for the two role= cases above: the real hand-off still counts.
            "role= handed to the services layer is still a role gate",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        card_services.delete_card(board=board, role=role, card=instance)",
            ),
            None,
            None,
            {},
        ),
        (
            # Control: a services call that is not handed the role proves nothing.
            "a services call with no role= defers",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        card_services.delete_card(board=board, card=instance)",
            ),
            None,
            "outside this module",
            {},
        ),
        (
            # Control: a listed predicate that cannot be read still counts.
            "a listed gate from another module still counts",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        card_services.require_mutation_role(actor=self.request.user, board=board)\n"
                "        instance.delete()",
            ),
            None,
            None,
            {},
        ),
        (
            # #2069: BoardViewSet takes writes from plain mixins, which have no
            # view base. The clean half also proves a mixin is not asked for
            # permission_classes, which its viewset declares.
            "a mixin write with a role gate passes",
            {"backend/boards/views/invites.py": _FIXTURE_MIXIN},
            None,
            None,
            {},
        ),
        (
            "a mixin write with no role gate is a finding",
            {"backend/boards/views/invites.py": _FIXTURE_MIXIN.replace(
                "    if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "        raise PermissionDenied\n",
                "",
            )},
            "BoardInviteLinksMixin::@action invite_links [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # #2069: an ORM role= kwarg writes a row; it hands off no gate.
            "role= on an ORM call is not a role hand-off",
            _mutate(
                "backend/boards/views/cards.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        instance.delete()",
                "        BoardMembership.objects.create(board=board, role=role)\n"
                "        instance.delete()",
            ),
            "no minimum-role check",
            None,
            {},
        ),
        # ── #2116: a role comparison that is not about the caller ──────────
        # Each case deletes only the caller's gate; what is left compares a
        # body field, a target row, or a role resolved for someone else.
        (
            "a request-body role, a target row's role and a target's resolved role are not role gates",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        member_role = ",
                "        member_role = ",
            ),
            "TargetRowViewSet::@action members [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "a predicate gate called and its answer thrown away is not a role gate (update_member)",
            _mutate(
                "backend/groups/views.py",
                "        group = self.get_object()\n"
                "        _require_group_admin(request.user, group)\n"
                "        locked = ",
                "        group = self.get_object()\n"
                "        user_is_group_admin(request.user, group)\n"
                "        locked = ",
            ),
            "GroupViewSet::@action update_member [delete,patch]: no minimum-role check",
            None,
            {},
        ),
        (
            "a for-loop target rebinding the caller's role name to body values is not a role gate (members)",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        member_role = ",
                "        for role in request.data.get('roles', []):\n"
                "            if role not in BoardMembership.Role.values:\n"
                "                raise PermissionDenied\n"
                "        member_role = ",
            ),
            "TargetRowViewSet::@action members [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "a self.<role> attribute set from the request body is not the caller's role (members)",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        member_role = ",
                "        self.requested_role = request.data.get('role')\n"
                "        if self.requested_role not in BoardMembership.Role.values:\n"
                "            raise PermissionDenied\n"
                "        member_role = ",
            ),
            "TargetRowViewSet::@action members [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "a caller role comparison nothing acts on is not a role gate (members)",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        member_role = ",
                "        allowed = role in (BoardMembership.Role.ADMIN, SITE_ADMIN)\n"
                "        member_role = ",
            ),
            "TargetRowViewSet::@action members [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "a target membership row's role is not a role gate, nor a helper handed the target",
            _mutate(
                "backend/groups/views.py",
                "        group = self.get_object()\n"
                "        _require_group_admin(request.user, group)\n"
                "        locked = ",
                "        group = self.get_object()\n"
                "        locked = ",
            ),
            "GroupViewSet::@action update_member [delete,patch]: no minimum-role check",
            None,
            {},
        ),
        (
            "the ownership exception alone is not a minimum role (delete_comment)",
            _mutate(
                "backend/boards/views/targets.py",
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        card = ",
                "        card = ",
            ),
            "TargetRowViewSet::@action delete_comment [delete]: no minimum-role check",
            None,
            {},
        ),
        (
            "the ownership exception alone is not a minimum role (checklist_item)",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in card_services.ANNOTATION_ROLES:\n"
                "            raise PermissionDenied\n",
                "",
            ),
            "TargetRowViewSet::@action checklist_item [patch]: no minimum-role check",
            None,
            {},
        ),
        (
            "a returned denial nobody acts on is not a role gate (comments)",
            _mutate(
                "backend/boards/views/targets.py",
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        denied = _annotation_denied(role)\n"
                "        CardComment.objects.create(",
            ),
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "a returned denial nobody acts on is not a role gate (delete_comment)",
            _mutate(
                "backend/boards/views/targets.py",
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        card = ",
                "        denied = _annotation_denied(role)\n"
                "        card = ",
            ),
            "TargetRowViewSet::@action delete_comment [delete]: no minimum-role check",
            None,
            {},
        ),
        (
            "the ownership exception alone is not a minimum role (delete_attachment)",
            _mutate(
                "backend/boards/views/targets.py",
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        card = get_object_or_404(Card, pk=pk, board=board)\n"
                "        attachment = ",
                "        card = get_object_or_404(Card, pk=pk, board=board)\n"
                "        attachment = ",
            ),
            "TargetRowViewSet::@action delete_attachment [delete]: no minimum-role check",
            None,
            {},
        ),
        (
            "a returned denial nobody acts on is not a role gate (attachments)",
            _mutate(
                "backend/boards/views/targets.py",
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardAttachment.objects.create(",
                "        denied = _annotation_denied(role)\n"
                "        CardAttachment.objects.create(",
            ),
            "TargetRowViewSet::@action attachments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # A same-module wrapper around a predicate that never raises passes
            # its answer up; the handler dropping it must not count as a gate.
            "a predicate gate behind a non-raising helper whose result is dropped",
            {"backend/groups/views.py": _FIXTURE_GROUPS.replace(
                "def _require_group_member(user, group):",
                "def _is_group_admin(user, group):\n"
                "    return user_is_group_admin(user, group)\n\n\n"
                "def _require_group_member(user, group):",
                1,
            ).replace(
                "        group = self.get_object()\n"
                "        _require_group_admin(request.user, group)\n"
                "        locked = ",
                "        group = self.get_object()\n"
                "        _is_group_admin(request.user, group)\n"
                "        locked = ",
                1,
            )},
            "GroupViewSet::@action update_member [delete,patch]: no minimum-role check",
            None,
            {},
        ),
        (
            "the same predicate wrapper still gates when its result is acted on",
            {"backend/groups/views.py": _FIXTURE_GROUPS.replace(
                "def _require_group_member(user, group):",
                "def _is_group_admin(user, group):\n"
                "    return user_is_group_admin(user, group)\n\n\n"
                "def _require_group_member(user, group):",
                1,
            ).replace(
                "        group = self.get_object()\n"
                "        _require_group_admin(request.user, group)\n"
                "        locked = ",
                "        group = self.get_object()\n"
                "        if not _is_group_admin(request.user, group):\n"
                "            raise PermissionDenied\n"
                "        locked = ",
                1,
            )},
            None,
            None,
            {},
        ),
        # ── #2166: the raise must be on the branch the comparison decides ──
        (
            # The issue's reproduction: an unrelated raise in the helper used to
            # make the helper "raise", so dropping its returned denial passed.
            "an unrelated raise in a gate helper does not make a dropped result a gate",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "def _annotation_denied(role):\n",
                "def _annotation_denied(role):\n"
                "    if role is None:\n"
                "        raise ValueError\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        denied = _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # Same, with the unrelated raise after the allow-branch's return:
            # it is reached only when the comparison fails, but a second test
            # decides it, so it is not the comparison's refusal.
            "a conditional raise after the allow-return is not the comparison's refusal",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "        return None\n"
                "    if role is None:\n"
                "        raise ValueError\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        denied = _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # An ``elif`` is a nested ``if`` in ``orelse``: its raise is decided
            # by the elif's own test, not by the role comparison.
            "a raise in an unrelated elif is not the comparison's refusal",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "        return None\n"
                "    elif role is None:\n"
                "        raise ValueError\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        denied = _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # Positive control: a raise on the comparison's own branch still
            # refuses, so the caller need not act on the result.
            "a helper that raises on the comparison's branch still gates a dropped result",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "    if role in card_services.ANNOTATION_ROLES:\n"
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "    if role not in card_services.ANNOTATION_ROLES:\n"
                "        raise PermissionDenied\n"
                "    return None\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            None,
            None,
            {},
        ),
        (
            # Positive control: ``if allowed: return`` then an unconditional
            # raise is the comparison's other outcome.
            "an unconditional raise after the allow-return still gates a dropped result",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "        return None\n"
                "    raise PermissionDenied\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            None,
            None,
            {},
        ),
        (
            # Positive control for the Assign branch: ``ok = role in X`` then ``if not ok: raise``.
            "a raise decided by a name bound from the comparison still gates a dropped result",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "    if role in card_services.ANNOTATION_ROLES:\n"
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "    ok = role in card_services.ANNOTATION_ROLES\n"
                "    if not ok:\n"
                "        raise PermissionDenied\n"
                "    return None\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            None,
            None,
            {},
        ),
        (
            # An attribute target binds no name: an unrelated ``if holder.flag: raise`` is not the comparison's refusal.
            "a comparison stored on an attribute is not read back by an unrelated raise",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "    if role in card_services.ANNOTATION_ROLES:\n"
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "    holder.ok = role in card_services.ANNOTATION_ROLES\n"
                "    if holder.flag:\n"
                "        raise PermissionDenied\n"
                "    return None\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # Tuple binding: only ``ok`` receives the comparison, so a raise
            # decided by ``flag`` is not the comparison's refusal.
            "a tuple-bound sibling name does not carry the comparison to a raise",
            {"backend/boards/views/targets.py": _FIXTURE_TARGETS.replace(
                "    if role in card_services.ANNOTATION_ROLES:\n"
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                "    ok, flag = role in card_services.ANNOTATION_ROLES, role is None\n"
                "    if flag:\n"
                "        raise ValueError\n"
                "    if ok:\n"
                "        return None\n"
                "    return Response(status=status.HTTP_403_FORBIDDEN)\n",
                1,
            ).replace(
                "        denied = _annotation_denied(role)\n"
                "        if denied is not None:\n"
                "            return denied\n"
                "        CardComment.objects.create(",
                "        _annotation_denied(role)\n"
                "        CardComment.objects.create(",
                1,
            )},
            "TargetRowViewSet::@action comments [post]: no minimum-role check",
            None,
            {},
        ),
        (
            # Statement order is not tracked, so a name rebound to a body value
            # is no longer the caller's role anywhere.
            "a caller role name rebound to a request-body role is not a role gate",
            _mutate(
                "backend/boards/views/targets.py",
                "        if role not in (BoardMembership.Role.ADMIN, SITE_ADMIN):\n"
                "            raise PermissionDenied\n"
                "        member_role = request.data.get(\"role\", BoardMembership.Role.MEMBER)\n"
                "        if member_role not in BoardMembership.Role.values:\n",
                "        member_role = request.data.get(\"role\", BoardMembership.Role.MEMBER)\n"
                "        role = member_role\n"
                "        if role not in BoardMembership.Role.values:\n",
            ),
            "TargetRowViewSet::@action members [post]: no minimum-role check",
            None,
            {},
        ),
        (
            "stale VIEWER_PERMITTED_WRITES entry (action gained a role gate)",
            {},
            "recorded in VIEWER_PERMITTED_WRITES",
            None,
            {"viewer": {
                "backend/boards/views/cards.py::CardViewSet::create":
                    "fixture: deliberately stale."
            }},
        ),
        (
            "AGENT_REVIEWED entry for a class that no longer exists",
            {},
            "matches no view class or handler any more",
            None,
            {"reviewed": {
                "backend/groups/views.py::GoneView": "fixture: deleted class."
            }},
        ),
    ]

    import contextlib

    global PUBLIC_BY_DESIGN, AGENT_REVIEWED, VIEWER_PERMITTED_WRITES, AGENT_REVIEWED_GUARDS
    real_tables = (PUBLIC_BY_DESIGN, AGENT_REVIEWED, VIEWER_PERMITTED_WRITES)
    real_guards = AGENT_REVIEWED_GUARDS

    print("=== check-rbac-coverage.py --self-test ===")
    failures = 0
    for name, overrides, expect_finding, expect_defer, tables in cases:
        PUBLIC_BY_DESIGN = dict(_FIXTURE_PUBLIC_BY_DESIGN)
        AGENT_REVIEWED = dict(_FIXTURE_AGENT_REVIEWED)
        AGENT_REVIEWED_GUARDS = dict(tables.get("guards", {}))
        VIEWER_PERMITTED_WRITES = dict(_FIXTURE_VIEWER_PERMITTED)
        PUBLIC_BY_DESIGN.update(tables.get("public", {}))
        AGENT_REVIEWED.update(tables.get("reviewed", {}))
        VIEWER_PERMITTED_WRITES.update(tables.get("viewer", {}))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _materialize(root, overrides)
                with contextlib.redirect_stdout(None):
                    rep = run(root, quiet=True)
        except CheckerError as exc:
            print(f"  x {name}: checker aborted: {exc}")
            failures += 1
            continue
        finally:
            PUBLIC_BY_DESIGN, AGENT_REVIEWED, VIEWER_PERMITTED_WRITES = real_tables
            AGENT_REVIEWED_GUARDS = real_guards

        if expect_finding is None and expect_defer is None:
            ok = not rep.findings and not rep.defers
        else:
            ok = True
            if expect_finding is not None:
                ok &= any(expect_finding in f for f in rep.findings)
            if expect_defer is not None:
                ok &= any(expect_defer in d for d in rep.defers)
        if ok:
            print(f"  ok {name}")
        else:
            print(f"  x  {name}: expected finding={expect_finding!r} defer={expect_defer!r}")
            for f in rep.findings:
                print(f"       FINDING: {f}")
            for d in rep.defers:
                print(f"       DEFER:   {d}")
            failures += 1

    print()
    if failures:
        print(f"check-rbac-coverage --self-test: {failures} of {len(cases)} cases FAILED")
        return EXIT_FINDINGS
    print(f"check-rbac-coverage --self-test: all {len(cases)} cases passed")
    return EXIT_OK


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Assert every board/group-scoped endpoint carries its RBAC gates (#1143).",
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("CI_PROJECT_DIR") or str(Path(__file__).resolve().parent.parent),
        help="repository root (default: the checkout this script lives in)",
    )
    parser.add_argument("--quiet", action="store_true", help="suppress the report body")
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="prove the detection logic against known-bad fixtures and exit",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    try:
        rep = run(Path(args.root), quiet=args.quiet)
    except CheckerError as exc:
        print(f"check-rbac-coverage: cannot run: {exc}", file=sys.stderr)
        return EXIT_CANNOT_RUN
    if rep.findings:
        return EXIT_FINDINGS
    if rep.defers:
        return EXIT_DEFER_TO_AGENT
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
