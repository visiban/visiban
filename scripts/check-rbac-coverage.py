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
     role gate: a comparison against a role constant, a ``_require_*`` helper,
     or an explicit ``role=`` hand-off to the service layer that owns the gate.

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

Scope: ``backend/boards/views/``, ``backend/groups/views.py`` and
``backend/git_lens/views.py`` — the board- and group-scoped API surface the role
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

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_CANNOT_RUN = 2
EXIT_DEFER_TO_AGENT = 3

# ─── Scope ───────────────────────────────────────────────────────────────────

# Directories scanned wholesale, and single files. Both are relative to --root.
SCOPE_DIRS = ("backend/boards/views",)
SCOPE_FILES = ("backend/groups/views.py", "backend/git_lens/views.py")

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

# A call whose name matches one of these is a role gate: it either raises or
# returns a denial on an insufficient role.
GATE_CALL_PREFIXES = ("_require_", "require_")
GATE_CALL_NAMES = frozenset({
    "can_modify_others_content",
    "_can_modify_others_content",
})

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
ROLE_DELEGATION_KWARG = "role"

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

# Builtins that can take a user/board argument without being authorization.
NOT_A_GATE_NAMES = frozenset({"getattr", "hasattr", "setattr", "isinstance", "len", "list", "set", "dict", "str", "int", "bool", "sorted", "any", "all", "print", "super"})

# Names an argument must mention for its call to be a possible authorization
# check. Matched as a substring of the argument's dotted source text.
GATE_SUBJECT_MARKERS = ("role", "user", "request", "board", "group", "actor", "member")

# ─── Recorded exceptions ─────────────────────────────────────────────────────
#
# Both tables are **self-invalidating**, the same contract
# check-serializer-ts-parity.py's SUPPRESSIONS table carries: if the condition
# that made an entry necessary is gone, the entry itself becomes a finding and
# asks to be deleted. An exception cannot outlive its reason.

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
    "backend/boards/views/boards.py::BoardViewSet::@action saved_filter_delete [delete]": (
        "Same per-user state as saved_filters. The queryset is scoped to "
        "request.user, so another user's preset is a 404 rather than a 403."
    ),
}

# Views or handlers whose authorization is real but not statically classifiable.
# Each entry records that the rbac-check AGENT reviewed it and what it found —
# this is the hand-off the exit-3 path exists to force, written down.
AGENT_REVIEWED: dict[str, str] = {
    "backend/groups/views.py::JoinGroupView": (
        "Invite-link join. Authorization is the capability token itself, "
        "resolved from the URL rather than from a group role, so there is no "
        "role gate to find: GET is deliberately AllowAny (token preview, "
        "throttled), POST requires IsAuthenticated via get_permissions() and "
        "then grants the membership the token names. Role-ladder reasoning does "
        "not apply to a capability grant."
    ),
}


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
        tree = _parse(path, rel)
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


def _parse(path: Path, rel: str) -> ast.Module:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
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
    mod = Module(rel=rel, tree=_parse(path, rel))
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
    role_gate: bool = False      # reached a role comparison / _require_ / role= hand-off
    raw_membership: bool = False # reached a raw BoardMembership/GroupMembership lookup
    unresolved: list[str] = field(default_factory=list)  # calls it could not follow


def _scan_gates(
    fn: ast.FunctionDef,
    cls: ast.ClassDef,
    mod: Module,
    *,
    depth: int = 0,
    seen: frozenset = frozenset(),
) -> GateEvidence:
    """Walk *fn*, following same-class methods and same-module functions.

    Returns what the walk proved. ``unresolved`` collects calls that *might*
    hold the gate but live outside this module — used only to decide whether a
    handler with no gate found is a finding (the gate is genuinely absent) or a
    defer (the gate may be somewhere the checker cannot read).
    """
    ev = GateEvidence()
    if depth > _RESOLVE_MAX_DEPTH:
        ev.unresolved.append(f"{fn.name} (recursion depth cap)")
        return ev

    methods = _methods(cls)
    locals_ = _local_names(fn)

    # A role comparison anywhere in the body.
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
        if any(marker in blob for marker in STRONG_ROLE_MARKERS):
            ev.role_gate = True
            break
        sentinel_only = all(
            isinstance(c, ast.Constant) and c.value in (None, True, False)
            for c in cmp_node.comparators
        )
        if sentinel_only:
            continue
        if any(m in left_blob.lower() for m in SUBJECT_ROLE_MARKERS):
            ev.role_gate = True
            break

    for call in _calls(fn):
        dotted = _dotted(call.func)
        if not dotted:
            continue
        tail = dotted.rsplit(".", 1)[-1]

        if any(dotted.startswith(p) or f".{p}" in dotted for p in RAW_MEMBERSHIP_LOOKUPS):
            ev.raw_membership = True

        recognized = False
        if tail in ROLE_RESOLVERS:
            ev.resolver = True
            recognized = True
        if tail in GATE_CALL_NAMES or any(tail.startswith(p) for p in GATE_CALL_PREFIXES):
            ev.role_gate = True
            recognized = True
        if any(kw.arg == ROLE_DELEGATION_KWARG for kw in call.keywords):
            ev.role_gate = True
            recognized = True
        # Follow into same-class methods and same-module functions. Done even
        # for a recognized call: `self._require_admin()` is a recognized gate
        # AND the place the membership resolution lives, so stopping here would
        # report the resolver missing.
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
        if target is not None:
            key = f"{cls.name}.{target.name}"
            if key not in seen:
                inner = _scan_gates(
                    target, cls, mod, depth=depth + 1, seen=seen | {key}
                )
                ev.resolver |= inner.resolver
                ev.role_gate |= inner.role_gate
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
            if not _is_view_class(cls):
                continue
            key = f"{rel}::{cls.name}"
            rep.classes_checked += 1

            perms = _permission_classes(cls, mod)
            has_auth = bool(perms.names) and any(
                n.rsplit(".", 1)[-1] == AUTH_PERMISSION for n in perms.names
            )

            # ── 1. Authentication gate ──────────────────────────────────────
            if key in PUBLIC_BY_DESIGN:
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

            if not _is_scoped(cls, mod):
                # Not board/group-scoped: the role ladder has nothing to say
                # about it, and checks 2 and 3 do not apply.
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

from ..models import BoardMembership, Card, CardComment
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
from rest_framework.permissions import IsAuthenticated


def _require_group_admin(user, group):
    raise NotImplementedError


class GroupViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def destroy(self, request, group_id=None, *args, **kwargs):
        group = self.get_object()
        _require_group_admin(request.user, group)
        group.delete()
'''

_FIXTURE_LENS = '''\
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated

from boards.permissions import get_board_for_user

_BOARD_PERMISSIONS = [IsAuthenticated]


def _require_board_admin(role):
    raise NotImplementedError


class LensConnectionView(APIView):
    permission_classes = _BOARD_PERMISSIONS

    def delete(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user)
        _require_board_admin(role)
'''

_FIXTURE = {
    "backend/boards/models.py": _FIXTURE_MODELS,
    "backend/boards/views/__init__.py": "from .cards import CardViewSet  # noqa\n",
    "backend/boards/views/cards.py": _FIXTURE_HELPERS,
    "backend/boards/views/health.py": _FIXTURE_PUBLIC,
    "backend/boards/views/share.py": (
        "from rest_framework.views import APIView\n\n\n"
        "class ShareBoardView(APIView):\n"
        "    permission_classes = []\n\n"
        "    def get(self, request, token):\n        return None\n"
    ),
    "backend/groups/views.py": _FIXTURE_GROUPS,
    "backend/git_lens/views.py": _FIXTURE_LENS,
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

    global PUBLIC_BY_DESIGN, AGENT_REVIEWED, VIEWER_PERMITTED_WRITES
    real_tables = (PUBLIC_BY_DESIGN, AGENT_REVIEWED, VIEWER_PERMITTED_WRITES)

    print("=== check-rbac-coverage.py --self-test ===")
    failures = 0
    for name, overrides, expect_finding, expect_defer, tables in cases:
        PUBLIC_BY_DESIGN = dict(_FIXTURE_PUBLIC_BY_DESIGN)
        AGENT_REVIEWED = dict(_FIXTURE_AGENT_REVIEWED)
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
