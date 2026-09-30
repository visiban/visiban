#!/usr/bin/env python3
"""Assert every board/group-scoped write broadcasts, after commit (#1143).

This is the deterministic half of the ``broadcast-check`` agent gate. Of the
conditions in ``.claude/agents/broadcast-check.md``, four are **mechanical** and
are what this script owns:

  1. **Every write broadcasts.** A write handler on a board- or group-scoped view
     must reach ``broadcast_board_event`` / ``broadcast_group_event`` /
     ``record_board_event`` — directly, or through something it calls. A write
     that does not is a silently stale UI for every other connected client.
  2. **Every broadcast is deferred.** A raw ``broadcast_*_event()`` call must sit
     inside a callable registered with ``transaction.on_commit()``. A broadcast
     inside an atomic block that later rolls back pushes state that never
     existed. (``record_board_event`` satisfies this by construction — it
     registers the ``on_commit`` itself — which is why it is the preferred form.)
  3. **No ORM instance in the deferred closure.** A closure that holds a
     ``Board``/``Card``/queryset row carries an object that may be stale or
     evicted by the time the commit hook fires. The payload is built inside the
     atomic block and handed to the closure through default arguments.
  4. **No broadcast storm.** One call per mutation, not one per row in a loop.

What stays with the agent, because it needs to know what the data *means*:
the per-recipient field-leak check (does this payload carry a field the REST
serializer strips for some roles?), payload completeness, and whether the
*right* channel was chosen for a given resource. Event **naming** and the
emitted ↔ documented ↔ handled three-way match are already owned by
``scripts/check-ws-event-reachability.py`` (#1078) and are deliberately not
re-checked here.

Shared primitives (view-class detection, write-handler enumeration, the local
-name analysis) are imported from ``check-rbac-coverage.py`` rather than
restated. #1107's lesson in this repository is explicit about the alternative:
``mcp_server/tools.py`` once carried a second copy of the role-precedence rules
under a "must be kept in step with it" comment, which was an admission that
nothing enforced it.

Usage:
    python scripts/check-broadcast-deferral.py [--root DIR] [--quiet]
    python scripts/check-broadcast-deferral.py --self-test

Exit codes:
    0  every in-scope write broadcasts, after commit, with a plain-data closure
    1  at least one finding
    2  the checker could not run (missing tree, parse error, usage error) —
       fails closed, never silently green
    3  at least one broadcast or write the checker cannot classify: run the
       ``broadcast-check`` agent on it, then either fix it or record the review
       in AGENT_REVIEWED. NOT a pass.
"""

from __future__ import annotations

import argparse
import ast
import importlib.util
import os
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

EXIT_OK = 0
EXIT_FINDINGS = 1
EXIT_CANNOT_RUN = 2
EXIT_DEFER_TO_AGENT = 3


# ─── Shared primitives ───────────────────────────────────────────────────────
#
# check-rbac-coverage.py is the canonical home for the Django/DRF AST
# primitives; this gate is the second consumer. Loaded by path because the
# module name carries hyphens, which no import statement can spell.
def _load_shared():
    path = Path(__file__).resolve().parent / "check-rbac-coverage.py"
    if not path.is_file():
        raise SystemExit(
            f"check-broadcast-deferral: shared primitives not found at {path}"
        )
    name = "_visiban_rbac_gate"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Registered before exec_module: @dataclass resolves annotations through
    # sys.modules[cls.__module__] on 3.12+, and a module that is not there yet
    # makes the decorator raise on the first dataclass in the file.
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


_shared = _load_shared()

_dotted = _shared._dotted
_parse = _shared._parse
_body_nodes = _shared._body_nodes
_calls = _shared._calls
_local_names = _shared._local_names
_is_view_class = _shared._is_view_class
_write_handlers = _shared._write_handlers
_is_scoped = _shared._is_scoped
_load_module = _shared._load_module
CheckerError = _shared.CheckerError


# ─── Scope ───────────────────────────────────────────────────────────────────

# Every backend app that may emit on a board or group channel. The call graph is
# built over all of these so a view handler that delegates to the services layer
# is resolved rather than guessed at.
SOURCE_ROOTS = ("backend/boards", "backend/groups", "backend/git_lens")

# Directories under a source root that are never emit sites.
SKIP_DIR_PARTS = ("tests", "migrations", "__pycache__", "seed_data", "management")

# View modules whose write handlers must broadcast. Same set as the RBAC gate's
# scope, for the same reason: these are the board/group-scoped API surface.
VIEW_DIRS = ("backend/boards/views",)
VIEW_FILES = ("backend/groups/views.py", "backend/git_lens/views.py")

# ─── The broadcast primitives ────────────────────────────────────────────────

# Functions that put a frame on the wire. A call to one of these is what
# "emitting" means.
# Matched on the *called* name, so an ``import … as _broadcast_group_event``
# alias counts without this checker having to resolve imports — the same
# convention check-ws-event-reachability.py's emit_funcs sets follow, and for the
# same reason: ``GroupViewSet.boards`` reaches the wire entirely through
# underscore-prefixed aliases.
RAW_EMIT_FUNCS = frozenset({
    "broadcast_board_event",
    "broadcast_group_event",
    "_broadcast_board_event",
    "_broadcast_group_event",
})

# Functions that emit but defer the publish themselves: record_* persists the
# feed row inside the caller's transaction and registers the on_commit publish.
# Calling one satisfies both "this write broadcasts" and "the broadcast is
# deferred" — no on_commit of the caller's own is needed or wanted.
DEFERRING_EMIT_FUNCS = frozenset({
    "record_board_event",
    "record_group_event",
    "_broadcast_after_commit",
})

ALL_EMIT_FUNCS = RAW_EMIT_FUNCS | DEFERRING_EMIT_FUNCS

# Where the deferral primitives are *defined*. A raw emit inside one of these is
# the mechanism, not a violation of it.
EMIT_DEFINITION_SITES = frozenset({
    "backend/boards/broadcast.py",
    "backend/groups/broadcast.py",
})

# ─── ORM-instance inference for on_commit closures ───────────────────────────

# An assignment whose right-hand side matches one of these produces a live ORM
# row, so capturing the target as a free variable in a commit hook holds that
# row past the transaction. Matched on the call's dotted name.
ORM_CALL_SUBSTRINGS = (".objects.",)
ORM_CALL_TAILS = frozenset({
    "get", "first", "last", "create", "get_or_create", "update_or_create",
    "select_for_update", "get_object", "get_object_or_404", "save",
})

# Handler parameters and common locals that are ORM instances by convention. A
# commit hook referencing one of these as a free variable is the exact defect
# the agent gate calls out.
ORM_NAMES = frozenset({
    "instance", "obj", "board", "card", "column", "swimlane", "label",
    "group", "membership", "comment", "attachment", "annotated", "conn",
    "serializer", "queryset", "qs", "definition", "link", "saved", "relation",
})


# ─── Recorded exceptions ─────────────────────────────────────────────────────
#
# Self-invalidating, same contract as the RBAC gate's tables and
# check-serializer-ts-parity.py's SUPPRESSIONS: when the condition that made an
# entry necessary is gone, the entry becomes a finding and asks to be deleted.

# Write actions on a board/group-scoped view that deliberately broadcast
# nothing. The reason must say why no other connected client needs to know.
NO_BROADCAST_BY_DESIGN: dict[str, str] = {
    "backend/groups/views.py::GroupViewSet::@action invite_links [post]": (
        "There is no invite_link.created event, deliberately. A group-channel "
        "frame fans out to every subscriber regardless of role, and a created "
        "invite link's payload carries admin-only fields — the raw token among "
        "them, which this response returns to its creator alone. "
        "invite_link.revoked can broadcast because its payload is the link id "
        "and nothing else (see docs/api/websockets.md). The asymmetry is the "
        "leak boundary, not an oversight."
    ),
}

# Fan-outs that legitimately call an emit function inside a loop, because the
# loop iterates over *channels* rather than over rows on one channel.
LOOP_FANOUT_BY_DESIGN: dict[str, str] = {
    "backend/groups/views.py::GroupViewSet._evict_stale_ws": (
        "One member.removed per board the user actually lost access to — the "
        "loop iterates boards (distinct channels), not rows on one channel, and "
        "each iteration re-checks get_board_role() post-commit before emitting."
    ),
    "backend/boards/admin.py::CardAdmin.delete_queryset": (
        "Admin bulk delete spans boards, so the loop iterates channels. Each "
        "frame is that board's own card.deleted; there is no single channel to "
        "collapse them onto."
    ),
    "backend/boards/admin.py::ColumnAdmin.delete_queryset": (
        "Same as CardAdmin.delete_queryset — an admin bulk delete of columns "
        "spanning boards iterates channels, not rows."
    ),
    "backend/boards/admin.py::_CardChildBroadcastAdminMixin.delete_queryset": (
        "One card.updated per affected card, already deduped by card_id above "
        "the loop — a bulk delete of comments/checklist items can span cards "
        "(and boards), and each frame carries that card's own refetched "
        "payload, so the frames cannot be collapsed onto a single channel."
    ),
    "backend/boards/services/cards.py::_broadcast_blocked_peers": (
        "One card.updated per peer whose blocker_count changed. Each frame "
        "carries a different card's full payload, so they cannot be collapsed "
        "into one card.updated — the bound is the number of cards this one "
        "blocked, and the payloads are already rendered in a single prefetch "
        "pass (see the function's docstring)."
    ),
    "backend/boards/views/cards.py::CardViewSet._broadcast_relation_change": (
        "Exactly two frames — one card.updated for each end of the relation — "
        "and both feed rows are required for a resumable cursor (#1114). Both "
        "cards are re-fetched in a single _card_queryset pass."
    ),
}

# Broadcasts or writes whose shape the checker cannot classify and the
# broadcast-check AGENT has reviewed. Records what it found.
AGENT_REVIEWED: dict[str, str] = {}


# ─── Call graph ──────────────────────────────────────────────────────────────


@dataclass
class FuncNode:
    key: str                   # "rel::Class.method" or "rel::func"
    name: str                  # bare name, for cross-module edges
    rel: str
    node: ast.AST
    calls: tuple[tuple[str, str], ...]  # (kind, tail) per call, body only
    emits_directly: bool


def _iter_py(root: Path) -> list[str]:
    rels: list[str] = []
    for src in SOURCE_ROOTS:
        base = root / src
        if not base.is_dir():
            raise CheckerError(f"source root not found: {src}")
        for p in sorted(base.rglob("*.py")):
            parts = set(p.relative_to(base).parts[:-1])
            if parts & set(SKIP_DIR_PARTS):
                continue
            rels.append(str(p.relative_to(root)))
    if not rels:
        raise CheckerError("no backend source files found")
    return rels


def _called_tails(fn: ast.AST) -> tuple[tuple[str, str], ...]:
    """Return ``((kind, tail), …)`` for every call in *fn*'s body.

    ``kind`` is ``"self"`` for ``self.x()``, ``"free"`` for a call through a
    module-level or imported name, and ``"local"`` for a method on something this
    function bound itself.

    The distinction is load-bearing. Resolving every call by bare name alone made
    ``instance.delete()`` in ``LabelViewSet.perform_destroy`` edge to
    ``LensConnectionView.delete`` — which does broadcast — so a handler that
    broadcast nothing was reported as clean. A method on a local object is never
    a call into the module-level call graph.
    """
    locals_ = _local_names(fn)
    out: list[tuple[str, str]] = []
    for call in _calls(fn):
        dotted = _dotted(call.func)
        if not dotted:
            continue
        tail = dotted.rsplit(".", 1)[-1]
        root = dotted.split(".", 1)[0]
        if dotted.startswith(("self.", "cls.")):
            out.append(("self", tail))
        elif root in locals_ and "." in dotted:
            out.append(("local", tail))
        else:
            out.append(("free", tail))
    return tuple(out)


def _walk_functions(tree: ast.Module, rel: str):
    """Yield ``(key, name, node)`` for every function, nested ones included."""

    def recurse(node, prefix):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                yield from recurse(child, f"{prefix}{child.name}.")
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                yield f"{rel}::{prefix}{child.name}", child.name, child
                yield from recurse(child, f"{prefix}{child.name}.")

    yield from recurse(tree, "")


def _build_graph(root: Path, rels: list[str]) -> tuple[dict[str, FuncNode], set[str]]:
    """Return ``({key: FuncNode}, emitting_keys)``.

    ``emitting_keys`` is closed under reachability: a function that calls a
    function that emits is itself an emitter. Cross-module edges are resolved by
    bare name, which over-approximates when two modules define the same name —
    deliberately the safe direction, since an over-approximated emitter set can
    only *suppress* a finding the agent would still catch, never invent one.
    """
    nodes: dict[str, FuncNode] = {}
    by_name: dict[str, list[str]] = {}

    for rel in rels:
        tree = _parse(root / rel, rel)
        for key, name, node in _walk_functions(tree, rel):
            tails = _called_tails(node)
            nodes[key] = FuncNode(
                key=key,
                name=name,
                rel=rel,
                node=node,
                calls=tails,
                emits_directly=any(
                    kind != "local" and tail in ALL_EMIT_FUNCS for kind, tail in tails
                ),
            )
            by_name.setdefault(name, []).append(key)

    def _targets(key: str, kind: str, tail: str) -> tuple[str, ...]:
        if kind == "local":
            return ()
        if kind == "self":
            # Same class only. The class prefix is the first path segment after
            # "::"; a nested helper inside a method resolves through it too.
            rel_part, _, qual = key.partition("::")
            owner = qual.split(".", 1)[0]
            candidate = f"{rel_part}::{owner}.{tail}"
            return (candidate,) if candidate in nodes else ()
        return tuple(by_name.get(tail, ()))

    emitting = {k for k, v in nodes.items() if v.emits_directly}
    changed = True
    while changed:
        changed = False
        for key, fn in nodes.items():
            if key in emitting:
                continue
            for kind, tail in fn.calls:
                if any(t in emitting for t in _targets(key, kind, tail)):
                    emitting.add(key)
                    changed = True
                    break
    return nodes, emitting


# ─── Deferral analysis ───────────────────────────────────────────────────────


def _parents(tree: ast.Module) -> dict[int, ast.AST]:
    out: dict[int, ast.AST] = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            out[id(child)] = node
    return out


def _deferred_callables(tree: ast.Module) -> tuple[set[int], list[str]]:
    """Return ``(ids of callables registered with on_commit, unresolvable regs)``."""
    deferred: set[int] = set()
    unresolved: list[str] = []
    # name -> nested function node, collected once for the whole module
    defs: dict[str, list[ast.AST]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs.setdefault(node.name, []).append(node)

    for call in (n for n in ast.walk(tree) if isinstance(n, ast.Call)):
        if _dotted(call.func).rsplit(".", 1)[-1] != "on_commit":
            continue
        if not call.args:
            unresolved.append(f"on_commit() with no callable (line {call.lineno})")
            continue
        arg = call.args[0]
        if isinstance(arg, ast.Lambda):
            deferred.add(id(arg))
        elif isinstance(arg, ast.Name) and arg.id in defs:
            for d in defs[arg.id]:
                deferred.add(id(d))
        elif isinstance(arg, (ast.Name, ast.Attribute)):
            # A module-level or imported callable: resolvable by name only, and
            # its body is checked wherever it is defined.
            tail = _dotted(arg).rsplit(".", 1)[-1]
            if tail in defs:
                for d in defs[tail]:
                    deferred.add(id(d))
            else:
                unresolved.append(
                    f"on_commit({_dotted(arg)}) — callable defined elsewhere "
                    f"(line {call.lineno})"
                )
        else:
            unresolved.append(
                f"on_commit(<{type(arg).__name__}>) at line {call.lineno}"
            )

    # Deferral is transitive: `on_commit(lambda: _broadcast_star(starred=True))`
    # defers everything `_broadcast_star` does, so the broadcast inside it is
    # deferred too. Closed to a fixpoint rather than one level, because a hook
    # may be two helpers deep.
    changed = True
    while changed:
        changed = False
        for node in list(ast.walk(tree)):
            if id(node) not in deferred:
                continue
            for call in _calls(node):
                tail = _dotted(call.func).rsplit(".", 1)[-1]
                for d in defs.get(tail, ()):
                    if id(d) not in deferred:
                        deferred.add(id(d))
                        changed = True
    return deferred, unresolved


def _enclosing_chain(node: ast.AST, parents: dict[int, ast.AST]) -> list[ast.AST]:
    chain = []
    cur = parents.get(id(node))
    while cur is not None:
        chain.append(cur)
        cur = parents.get(id(cur))
    return chain


def _orm_flavored(name: str, enclosing: ast.AST) -> bool:
    """True when *name*, bound in *enclosing*, is demonstrably a live ORM row."""
    if name in ORM_NAMES:
        return True
    for node in ast.walk(enclosing):
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            continue
        rhs = node.value
        if isinstance(rhs, ast.Call):
            dotted = _dotted(rhs.func)
            tail = dotted.rsplit(".", 1)[-1]
            if any(s in dotted for s in ORM_CALL_SUBSTRINGS) or tail in ORM_CALL_TAILS:
                return True
    return False


def _free_orm_captures(fn: ast.AST, parents: dict[int, ast.AST]) -> list[str]:
    """Return names *fn* reads from its enclosing function that are ORM rows.

    The accepted capture mechanism is a default argument
    (``def _send(bid=board_id, pl=payload):``), which snapshots the value at
    registration time. A name read straight out of the enclosing scope is only a
    finding when the checker can show it holds an ORM row — a plain int or dict
    read that way is untidy but not the defect this detector is about.
    """
    params = {a.arg for a in fn.args.args + fn.args.kwonlyargs + fn.args.posonlyargs}
    if fn.args.vararg:
        params.add(fn.args.vararg.arg)
    if fn.args.kwarg:
        params.add(fn.args.kwarg.arg)
    own = _local_names(fn)

    enclosing = None
    for anc in _enclosing_chain(fn, parents):
        if isinstance(anc, (ast.FunctionDef, ast.AsyncFunctionDef)):
            enclosing = anc
            break
    if enclosing is None:
        return []
    outer = _local_names(enclosing) - params

    body = fn.body if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) else [fn.body]
    read: set[str] = set()
    for stmt in body:
        for node in ast.walk(stmt):
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                read.add(node.id)

    bad = []
    for name in sorted(read - params - own):
        if name not in outer:
            continue
        if _orm_flavored(name, enclosing):
            bad.append(name)
    return bad


# ─── The check ───────────────────────────────────────────────────────────────


@dataclass
class Report:
    findings: list[str] = field(default_factory=list)
    defers: list[str] = field(default_factory=list)
    modules: int = 0
    emit_sites: int = 0
    write_actions: int = 0
    no_broadcast: int = 0
    loop_fanouts: int = 0
    reviewed: int = 0


def run(root: Path, *, quiet: bool = False) -> Report:
    rep = Report()
    rels = _iter_py(root)
    # The node map is not needed here — reachability is the whole question.
    _, emitting = _build_graph(root, rels)

    used_no_broadcast: set[str] = set()
    used_loop: set[str] = set()
    used_reviewed: set[str] = set()

    # ── 2, 3, 4: every emit site ───────────────────────────────────────────
    for rel in rels:
        tree = _parse(root / rel, rel)
        rep.modules += 1
        parents = _parents(tree)
        deferred, unresolved_regs = _deferred_callables(tree)
        for note in unresolved_regs:
            rep.defers.append(f"{rel}: {note} — cannot prove the broadcast is deferred.")

        for call in (n for n in ast.walk(tree) if isinstance(n, ast.Call)):
            tail = _dotted(call.func).rsplit(".", 1)[-1]
            if tail not in ALL_EMIT_FUNCS:
                continue
            rep.emit_sites += 1
            chain = _enclosing_chain(call, parents)

            # ── 2. deferred? ────────────────────────────────────────────────
            if tail in RAW_EMIT_FUNCS and rel not in EMIT_DEFINITION_SITES:
                in_deferred = any(id(a) in deferred for a in chain)
                if not in_deferred:
                    rep.findings.append(
                        f"{rel}:{call.lineno}: {tail}() is not inside a "
                        f"transaction.on_commit() callable — a rollback after this "
                        f"point publishes state that never committed. Use "
                        f"record_board_event(), or register the publish with "
                        f"transaction.on_commit()."
                    )

            # ── 4. storm? ───────────────────────────────────────────────────
            loop = next(
                (a for a in chain if isinstance(a, (ast.For, ast.While, ast.AsyncFor))),
                None,
            )
            if loop is not None:
                # Qualified with the enclosing class where there is one, so
                # CardAdmin.delete_queryset and ColumnAdmin.delete_queryset are
                # two entries rather than one that silently covers both.
                owner = next(
                    (
                        a.name
                        for a in chain
                        if isinstance(a, (ast.FunctionDef, ast.AsyncFunctionDef))
                    ),
                    "<module>",
                )
                owner_cls = next(
                    (a.name for a in chain if isinstance(a, ast.ClassDef)), None
                )
                if owner_cls:
                    owner = f"{owner_cls}.{owner}"
                loop_key = f"{rel}::{owner}"
                if loop_key in LOOP_FANOUT_BY_DESIGN:
                    used_loop.add(loop_key)
                    rep.loop_fanouts += 1
                else:
                    rep.findings.append(
                        f"{rel}:{call.lineno}: {tail}() inside a loop in {owner}() "
                        f"— one frame per row is a broadcast storm. Broadcast once "
                        f"with the full updated list, or record the fan-out in "
                        f"LOOP_FANOUT_BY_DESIGN with the channels it iterates."
                    )

        # ── 3. ORM instance held in a commit hook ──────────────────────────
        for node in ast.walk(tree):
            if id(node) not in deferred:
                continue
            emits = any(
                _dotted(c.func).rsplit(".", 1)[-1] in ALL_EMIT_FUNCS
                for c in _calls(node)
            )
            if not emits:
                # Not a broadcast hook; payload-staleness is this gate's concern
                # only where a frame goes on the wire.
                continue
            for name in _free_orm_captures(node, parents):
                owner = getattr(node, "name", "<lambda>")
                rep.findings.append(
                    f"{rel}:{node.lineno}: commit hook {owner} reads ORM value "
                    f"'{name}' from the enclosing scope. Build the payload inside "
                    f"the atomic block and capture it through a default argument "
                    f"({owner}({name[:2]}={name}))."
                )

    # ── 1: every board/group-scoped write broadcasts ────────────────────────
    view_rels: list[str] = []
    for d in VIEW_DIRS:
        base = root / d
        if not base.is_dir():
            raise CheckerError(f"view directory not found: {d}")
        view_rels += [
            str(p.relative_to(root))
            for p in sorted(base.glob("*.py"))
            if p.name != "__init__.py"
        ]
    for f in VIEW_FILES:
        if not (root / f).is_file():
            raise CheckerError(f"view module not found: {f}")
        view_rels.append(f)

    for rel in view_rels:
        mod = _load_module(root, rel)
        for cls in mod.classes:
            if not _is_view_class(cls) or not _is_scoped(cls, mod):
                continue
            for label, handlers in _write_handlers(cls):
                rep.write_actions += 1
                key = f"{rel}::{cls.name}::{label}"
                emits = any(
                    f"{rel}::{cls.name}.{fn.name}" in emitting for fn in handlers
                )
                if key in AGENT_REVIEWED:
                    used_reviewed.add(key)
                    rep.reviewed += 1
                    continue
                if key in NO_BROADCAST_BY_DESIGN:
                    used_no_broadcast.add(key)
                    rep.no_broadcast += 1
                    if emits:
                        rep.findings.append(
                            f"{key}: recorded in NO_BROADCAST_BY_DESIGN but now "
                            f"broadcasts — delete the stale entry."
                        )
                    continue
                if not emits:
                    rep.findings.append(
                        f"{key}: writes board/group state but reaches no "
                        f"broadcast_*_event() / record_*_event() on any path — "
                        f"every other connected client's view goes stale with no "
                        f"error anywhere."
                    )

    for table, used, name in (
        (NO_BROADCAST_BY_DESIGN, used_no_broadcast, "NO_BROADCAST_BY_DESIGN"),
        (LOOP_FANOUT_BY_DESIGN, used_loop, "LOOP_FANOUT_BY_DESIGN"),
        (AGENT_REVIEWED, used_reviewed, "AGENT_REVIEWED"),
    ):
        for key, reason in table.items():
            if key not in used:
                rep.findings.append(
                    f"{name} entry {key} matches nothing any more — delete it. "
                    f"(recorded reason: {reason.splitlines()[0]})"
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
        f"check-broadcast-deferral: {rep.modules} module(s), {rep.emit_sites} "
        f"emit site(s), {rep.write_actions} write action(s) — "
        f"{len(rep.findings)} finding(s), {len(rep.defers)} defer(s), "
        f"{rep.no_broadcast} no-broadcast-by-design, "
        f"{rep.loop_fanouts} loop-fanout-by-design, {rep.reviewed} agent-reviewed."
    )
    if rep.defers:
        print()
        print(
            "One or more broadcasts could not be classified. Run the "
            "`broadcast-check` agent on each DEFER above, then either fix the gap "
            "or record the review in AGENT_REVIEWED in this script. A defer is "
            "not a pass."
        )
    elif not rep.findings:
        print("Every in-scope write broadcasts, after commit, with a plain-data closure.")


# ─── Self-test (#1093) ───────────────────────────────────────────────────────

_FIX_MODELS = '''\
from django.db import models


class Board(models.Model):
    pass


class Card(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE)
'''

_FIX_BROADCAST = '''\
from django.db import transaction

EVT_CARD_UPDATED = "card.updated"


def broadcast_board_event(board_id, event_type, payload):
    pass


def record_board_event(board_id, event_type, payload, *, actor_id=None):
    transaction.on_commit(
        lambda: broadcast_board_event(board_id, event_type, payload)
    )
'''

_FIX_GROUP_BROADCAST = '''\
EVT_GROUP_UPDATED = "group.updated"


def broadcast_group_event(group_id, event_type, payload):
    pass
'''

_FIX_CARD_VIEWS = '''\
from django.db import transaction
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated

from .. import broadcast as _broadcast
from ..permissions import get_board_for_user
from ..serializers import CardSerializer


class CardViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def _board_and_role(self):
        return get_board_for_user(self.kwargs["board_pk"], self.request.user)

    def perform_create(self, serializer):
        board, role = self._board_and_role()
        with transaction.atomic():
            card = serializer.save(board=board)
            card_data = CardSerializer(card).data
            board_id = board.id
            _broadcast.record_board_event(board_id, _broadcast.EVT_CARD_UPDATED, card_data)

    def perform_destroy(self, instance):
        board, role = self._board_and_role()
        board_id = board.id
        card_uid = instance.uid
        with transaction.atomic():
            instance.delete()
            payload = {"card_uid": card_uid}

            def _send(bid=board_id, pl=payload):
                _broadcast.broadcast_board_event(bid, _broadcast.EVT_CARD_UPDATED, pl)

            transaction.on_commit(_send)

    @action(detail=True, methods=["post"])
    def touch(self, request, board_pk=None, pk=None):
        board, role = self._board_and_role()
        with transaction.atomic():
            board.save()
            _broadcast.record_board_event(board.id, _broadcast.EVT_CARD_UPDATED, {})
'''

_FIX_GROUP_VIEWS = '''\
from django.db import transaction
from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated

from boards.permissions import get_board_role
from .broadcast import broadcast_group_event, EVT_GROUP_UPDATED


def _require_group_admin(user, group):
    raise NotImplementedError


class GroupViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]

    def perform_update(self, serializer):
        group = serializer.instance
        _require_group_admin(self.request.user, group)
        role = get_board_role(self.request.user, group)
        with transaction.atomic():
            serializer.save()
            gid = group.pk
            payload = {"id": gid}

            def _send(g=gid, pl=payload):
                broadcast_group_event(g, EVT_GROUP_UPDATED, pl)

            transaction.on_commit(_send)
'''

_FIX_LENS_VIEWS = '''\
from django.db import transaction
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated

from boards.broadcast import record_board_event, EVT_CARD_UPDATED
from boards.permissions import get_board_for_user


def _require_board_admin(role):
    raise NotImplementedError


class LensConnectionView(APIView):
    permission_classes = [IsAuthenticated]

    def delete(self, request, board_id):
        board, role = get_board_for_user(board_id, request.user)
        _require_board_admin(role)
        with transaction.atomic():
            record_board_event(board.id, EVT_CARD_UPDATED, {"board_id": board.id})
'''

_FIXTURE = {
    "backend/boards/models.py": _FIX_MODELS,
    "backend/boards/broadcast.py": _FIX_BROADCAST,
    "backend/boards/permissions.py": "def get_board_for_user(b, u):\n    return None, None\n\n\ndef get_board_role(u, b):\n    return None\n",
    "backend/boards/serializers.py": "class CardSerializer:\n    pass\n",
    "backend/boards/views/__init__.py": "",
    "backend/boards/views/cards.py": _FIX_CARD_VIEWS,
    "backend/groups/broadcast.py": _FIX_GROUP_BROADCAST,
    "backend/groups/views.py": _FIX_GROUP_VIEWS,
    "backend/git_lens/views.py": _FIX_LENS_VIEWS,
}

_FIXTURE_TABLES = {"no_broadcast": {}, "loop": {}, "reviewed": {}}


def _materialize(root: Path, overrides=None):
    for rel, body in {**_FIXTURE, **(overrides or {})}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")


def _mutate(rel, old, new):
    assert old in _FIXTURE[rel], f"self-test fixture drift: {old!r} not in {rel}"
    return {rel: _FIXTURE[rel].replace(old, new, 1)}


def self_test() -> int:
    """Prove each detector still fires against a deliberately broken fixture."""
    cases = [
        ("clean fixture passes", {}, None, None, {}),
        (
            "write action that broadcasts nothing",
            _mutate(
                "backend/boards/views/cards.py",
                "            _broadcast.record_board_event(board_id, _broadcast.EVT_CARD_UPDATED, card_data)",
                "            pass",
            ),
            "reaches no broadcast_*_event()",
            None,
            {},
        ),
        (
            "raw broadcast not deferred with on_commit",
            _mutate(
                "backend/boards/views/cards.py",
                "            def _send(bid=board_id, pl=payload):\n"
                "                _broadcast.broadcast_board_event(bid, _broadcast.EVT_CARD_UPDATED, pl)\n"
                "\n"
                "            transaction.on_commit(_send)",
                "            _broadcast.broadcast_board_event(board_id, _broadcast.EVT_CARD_UPDATED, payload)",
            ),
            "is not inside a transaction.on_commit()",
            None,
            {},
        ),
        (
            "commit hook holding an ORM instance",
            _mutate(
                "backend/boards/views/cards.py",
                "            def _send(bid=board_id, pl=payload):\n"
                "                _broadcast.broadcast_board_event(bid, _broadcast.EVT_CARD_UPDATED, pl)",
                "            def _send():\n"
                "                _broadcast.broadcast_board_event(board.id, _broadcast.EVT_CARD_UPDATED, payload)",
            ),
            "from the enclosing scope",
            None,
            {},
        ),
        (
            "broadcast storm — one frame per row in a loop",
            _mutate(
                "backend/boards/views/cards.py",
                "            _broadcast.record_board_event(board.id, _broadcast.EVT_CARD_UPDATED, {})",
                "            for c in board.cards.all():\n"
                "                _broadcast.record_board_event(board.id, _broadcast.EVT_CARD_UPDATED, {})",
            ),
            "inside a loop",
            None,
            {},
        ),
        (
            "group-channel write that broadcasts nothing",
            _mutate(
                "backend/groups/views.py",
                "            def _send(g=gid, pl=payload):\n"
                "                broadcast_group_event(g, EVT_GROUP_UPDATED, pl)\n"
                "\n"
                "            transaction.on_commit(_send)",
                "            pass",
            ),
            "reaches no broadcast_*_event()",
            None,
            {},
        ),
        (
            "on_commit handed something unreadable defers instead of passing",
            _mutate(
                "backend/boards/views/cards.py",
                "            transaction.on_commit(_send)",
                "            transaction.on_commit(HOOKS[0])",
            ),
            None,
            "cannot prove the broadcast is deferred",
            {},
        ),
        (
            "stale LOOP_FANOUT_BY_DESIGN entry",
            {},
            "matches nothing any more",
            None,
            {"loop": {"backend/boards/views/cards.py::gone": "fixture: stale."}},
        ),
        (
            "stale NO_BROADCAST_BY_DESIGN entry (action now broadcasts)",
            {},
            "recorded in NO_BROADCAST_BY_DESIGN but now broadcasts",
            None,
            {"no_broadcast": {
                "backend/boards/views/cards.py::CardViewSet::create": "fixture: stale."
            }},
        ),
    ]

    global NO_BROADCAST_BY_DESIGN, LOOP_FANOUT_BY_DESIGN, AGENT_REVIEWED
    real = (NO_BROADCAST_BY_DESIGN, LOOP_FANOUT_BY_DESIGN, AGENT_REVIEWED)

    print("=== check-broadcast-deferral.py --self-test ===")
    failures = 0
    for name, overrides, expect_finding, expect_defer, tables in cases:
        NO_BROADCAST_BY_DESIGN = dict(tables.get("no_broadcast", {}))
        LOOP_FANOUT_BY_DESIGN = dict(tables.get("loop", {}))
        AGENT_REVIEWED = dict(tables.get("reviewed", {}))
        try:
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                _materialize(root, overrides)
                rep = run(root, quiet=True)
        except CheckerError as exc:
            print(f"  x  {name}: checker aborted: {exc}")
            failures += 1
            continue
        finally:
            NO_BROADCAST_BY_DESIGN, LOOP_FANOUT_BY_DESIGN, AGENT_REVIEWED = real

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
        print(f"check-broadcast-deferral --self-test: {failures} of {len(cases)} cases FAILED")
        return EXIT_FINDINGS
    print(f"check-broadcast-deferral --self-test: all {len(cases)} cases passed")
    return EXIT_OK


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Assert every board/group-scoped write broadcasts, after commit (#1143).",
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
        print(f"check-broadcast-deferral: cannot run: {exc}", file=sys.stderr)
        return EXIT_CANNOT_RUN
    if rep.findings:
        return EXIT_FINDINGS
    if rep.defers:
        return EXIT_DEFER_TO_AGENT
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
