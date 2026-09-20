#!/usr/bin/env python3
"""Assert the WebSocket event contract matches itself in all three places (#1078).

A WebSocket event name exists in three places and, until this gate, was verified
in none of them:

  1. **Emitted** — a ``broadcast_board_event`` / ``broadcast_group_event`` call
     in the backend.
  2. **Documented** — a row in ``docs/api/websockets.md``.
  3. **Handled** — an ``event.event === "<name>"`` branch in the frontend.

``CLAUDE.md`` declares the ``{event, data}`` board_* schema a public 1.0+
contract, so a name that exists in only two of the three is a broken promise:
an event nobody documented, a documented event nobody emits, or an emitted
event no client acts on. TruePPM shipped a Prometheus alert querying
``trueppm_deadletter_parked`` while the app emitted
``trueppm_task_dead_letter_parked`` — the alert could never fire, the panel was
permanently blank, and *both docs pages had the correct name*. Same class of
defect, different surface. Nothing compared the three.

The emitted set is read from the **registries** — ``BOARD_CHANNEL_EVENTS`` in
``backend/boards/broadcast.py`` and ``GROUP_CHANNEL_EVENTS`` in
``backend/groups/broadcast.py`` — not from a grep over string literals, because
a grep cannot see a name assembled at runtime (``"member.added" if created else
"member.updated"``) and cannot tell an event name from a log line that happens
to contain one. Every emit call site must therefore draw its name from a
registry constant; a bare string literal at an emit site is itself a failure.

Usage:
    python scripts/check-ws-event-reachability.py [--root DIR]
    python scripts/check-ws-event-reachability.py --self-test

Exit codes:
    0  every channel reconciles
    1  at least one finding
    2  usage error, or the checker could not run (missing file, parse error) —
       fails closed, never silently green
"""

from __future__ import annotations

import argparse
import ast
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# ─── Channel configuration ───────────────────────────────────────────────────
#
# Emit-function names are matched on the *called name* (``f(...)`` or
# ``mod.f(...)``), so module aliases and ``from x import f as _f`` both match
# without the checker having to resolve imports. ``_broadcast_after_commit`` is
# the services-layer wrapper in boards/services/cards.py: its own body passes
# the name straight through from a parameter, which the resolver recognizes as a
# pass-through and skips, while its call sites are checked like any other.


@dataclass(frozen=True)
class ChannelSpec:
    label: str
    registry: str
    channel_set: str
    deprecated_map: str
    unhandled_map: str
    emit_funcs: frozenset
    source_roots: tuple
    consumers: tuple
    doc: str
    doc_side: str  # "before" or "after" the group-channel heading
    handlers: tuple


DOC_SPLIT = re.compile(r"^##\s+Group channel", re.MULTILINE)

BOARD = ChannelSpec(
    label="board",
    registry="backend/boards/broadcast.py",
    channel_set="BOARD_CHANNEL_EVENTS",
    deprecated_map="DEPRECATED_BOARD_EVENTS",
    unhandled_map="INTENTIONALLY_UNHANDLED_BOARD_EVENTS",
    emit_funcs=frozenset({
        "broadcast_board_event",
        "_broadcast_board_event",
        "record_board_event",
        "persist_board_event",
        "_persist_board_event",
        "_broadcast_after_commit",
    }),
    source_roots=("backend/boards", "backend/git_lens", "backend/groups"),
    consumers=("backend/boards/consumers.py",),
    doc="docs/api/websockets.md",
    doc_side="before",
    handlers=(
        "frontend/src/components/Board/BoardView.tsx",
        "frontend/src/hooks/useBoardSocket.ts",
    ),
)

GROUP = ChannelSpec(
    label="group",
    registry="backend/groups/broadcast.py",
    channel_set="GROUP_CHANNEL_EVENTS",
    deprecated_map="DEPRECATED_GROUP_EVENTS",
    unhandled_map="INTENTIONALLY_UNHANDLED_GROUP_EVENTS",
    emit_funcs=frozenset({"broadcast_group_event", "_broadcast_group_event"}),
    source_roots=("backend/boards", "backend/groups"),
    consumers=("backend/groups/consumers.py",),
    doc="docs/api/websockets.md",
    doc_side="after",
    handlers=(
        "frontend/src/pages/GroupDetail.tsx",
        "frontend/src/hooks/useGroupSocket.ts",
    ),
)

CHANNELS = (BOARD, GROUP)

# Directories under a source root that are never emit sites.
SKIP_DIRS = ("/tests/", "/migrations/", "/__pycache__/", "/seed_data/")

# An event name: dotted lowercase, or the bare keepalive.
EVENT_SHAPE = re.compile(r"^(?:[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+|ping)$")
# First cell of a Markdown table row, backticked.
DOC_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|", re.MULTILINE)
# `event.event === "card.created"` / `evt.event === 'card.created'`
HANDLER_BRANCH = re.compile(r"\.event\s*===\s*[\"']([^\"']+)[\"']")

PASSTHROUGH = object()   # the name is a function parameter — checked at its call sites
UNRESOLVED = object()    # the checker could not prove what goes on the wire


class CheckerError(Exception):
    """The checker could not run. Never reported as a clean result."""


# ─── Registry loading ────────────────────────────────────────────────────────


def _str_const(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def load_registry(path: Path, base: dict) -> tuple:
    """Return (constants, collections) for one registry module.

    ``constants`` maps constant name -> wire string, including names re-exported
    from another registry via ``from ... import`` (resolved against *base*), so
    the two channels can share a name without restating the string.
    ``collections`` maps a frozenset/dict name -> the set (or dict) it declares.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except (OSError, SyntaxError) as exc:
        raise CheckerError(f"cannot read registry {path}: {exc}") from exc

    consts = dict(base)
    collections: dict = {}

    for node in tree.body:
        if isinstance(node, ast.ImportFrom):
            for alias in node.names:
                src = alias.name
                if src in base:
                    consts[alias.asname or src] = base[src]
            continue
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            names = [t.id for t in targets if isinstance(t, ast.Name)]
            if not names or node.value is None:
                continue
            literal = _str_const(node.value)
            if literal is not None:
                for n in names:
                    consts[n] = literal
                continue
            members = _collection_members(node.value, consts)
            if members is not None:
                for n in names:
                    collections[n] = members

    return consts, collections


def _collection_members(value, consts):
    """Resolve ``frozenset({A, B})`` / ``{A: "why"}`` to a dict of name -> note."""
    if isinstance(value, ast.Call):
        fn = value.func
        fname = fn.id if isinstance(fn, ast.Name) else getattr(fn, "attr", None)
        if fname == "frozenset" and value.args:
            inner = value.args[0]
            if isinstance(inner, (ast.Set, ast.List, ast.Tuple)):
                return {v: "" for v in _resolve_all(inner.elts, consts)}
        return None
    if isinstance(value, ast.Dict):
        out = {}
        for k, v in zip(value.keys, value.values):
            resolved = _resolve_all([k], consts)
            if len(resolved) != 1:
                continue
            note = _str_const(v)
            if note is None and isinstance(v, ast.JoinedStr):
                note = "".join(_str_const(p) or "" for p in v.values)
            out[resolved[0]] = (note or "").strip()
        return out
    if isinstance(value, (ast.Set, ast.List, ast.Tuple)):
        return {v: "" for v in _resolve_all(value.elts, consts)}
    return None


def _resolve_all(nodes, consts):
    out = []
    for n in nodes:
        if isinstance(n, ast.Name) and n.id in consts:
            out.append(consts[n.id])
        elif isinstance(n, ast.Attribute) and n.attr in consts:
            out.append(consts[n.attr])
        else:
            lit = _str_const(n)
            if lit is not None:
                out.append(lit)
    return out


# ─── Emit-site scanning ──────────────────────────────────────────────────────


def _called_name(call: ast.Call):
    f = call.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _enclosing_functions(tree):
    """Map every node id to the chain of FunctionDefs enclosing it, innermost first."""
    chain: dict = {}

    def walk(node, stack):
        for child in ast.iter_child_nodes(node):
            new = stack
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                new = (child,) + stack
            chain[id(child)] = new
            walk(child, new)

    chain[id(tree)] = ()
    walk(tree, ())
    return chain


def _params(fn):
    if isinstance(fn, ast.Lambda):
        a = fn.args
    else:
        a = fn.args
    names = [p.arg for p in (*a.posonlyargs, *a.args, *a.kwonlyargs)]
    if a.vararg:
        names.append(a.vararg.arg)
    if a.kwarg:
        names.append(a.kwarg.arg)
    return names


def _assignments_in(scope, name):
    """RHS expressions assigned to *name* directly inside *scope* (not nested defs)."""
    out = []
    for node in ast.walk(scope):
        if isinstance(node, ast.Assign) and node.value is not None:
            if any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
                out.append(node.value)
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            if isinstance(node.target, ast.Name) and node.target.id == name:
                out.append(node.value)
        elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            if node.target.id == name:
                out.append(node.value)
    return out


def resolve_event_arg(node, consts, tree, chain, seen=None):
    """Resolve the event-name argument of an emit call to the strings it can be.

    Returns a list whose members are wire strings, ``PASSTHROUGH``, or
    ``UNRESOLVED``. A bare string constant comes back as a ``("literal", value)``
    tuple so the caller can report it as the distinct (and worse) failure it is:
    a call site that bypassed the registry.
    """
    seen = seen or set()
    if isinstance(node, ast.Constant):
        return [("literal", node.value)] if isinstance(node.value, str) else [UNRESOLVED]
    if isinstance(node, ast.Attribute):
        return [consts[node.attr]] if node.attr in consts else [UNRESOLVED]
    if isinstance(node, ast.IfExp):
        return (
            resolve_event_arg(node.body, consts, tree, chain, seen)
            + resolve_event_arg(node.orelse, consts, tree, chain, seen)
        )
    if isinstance(node, ast.Name):
        if node.id in consts:
            return [consts[node.id]]
        if node.id in seen:
            return [UNRESOLVED]
        seen = seen | {node.id}
        for fn in chain.get(id(node), ()):
            if node.id in _params(fn):
                return [PASSTHROUGH]
            rhs = _assignments_in(fn, node.id)
            if rhs:
                out = []
                for r in rhs:
                    out += resolve_event_arg(r, consts, tree, chain, seen)
                return out
        rhs = [
            n.value
            for n in tree.body
            if isinstance(n, ast.Assign)
            and n.value is not None
            and any(isinstance(t, ast.Name) and t.id == node.id for t in n.targets)
        ]
        if rhs:
            out = []
            for r in rhs:
                out += resolve_event_arg(r, consts, tree, chain, seen)
            return out
    return [UNRESOLVED]


def _python_files(root: Path, source_roots):
    for rel in source_roots:
        base = root / rel
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*.py")):
            posix = "/" + p.relative_to(root).as_posix()
            if any(skip in posix for skip in SKIP_DIRS):
                continue
            yield p


def scan_emitted(root: Path, spec: ChannelSpec, consts: dict, registries):
    """Return (emitted set, findings) for one channel."""
    emitted, findings = set(), []
    registry_paths = {root / r for r in registries}

    for path in _python_files(root, spec.source_roots):
        if path in registry_paths:
            continue
        rel = path.relative_to(root).as_posix()
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except (OSError, SyntaxError) as exc:
            raise CheckerError(f"cannot parse {rel}: {exc}") from exc
        chain = _enclosing_functions(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            if _called_name(node) not in spec.emit_funcs or len(node.args) < 2:
                continue
            for value in resolve_event_arg(node.args[1], consts, tree, chain):
                if value is PASSTHROUGH:
                    continue
                if value is UNRESOLVED:
                    findings.append(
                        f"{rel}:{node.lineno}: cannot prove which event name this "
                        f"{_called_name(node)}() call puts on the wire. Pass a "
                        f"registry constant so the gate can read it."
                    )
                elif isinstance(value, tuple):
                    findings.append(
                        f"{rel}:{node.lineno}: event name {value[1]!r} is a bare string "
                        f"literal. Use the matching constant from {spec.registry} — the "
                        f"registry is the authoritative emitted set, and a literal is "
                        f"invisible to it."
                    )
                else:
                    emitted.add(value)

    # The consumers emit their keepalive with self.send(), not through a
    # broadcast helper, so no call site exists to scan. Count any registry
    # constant they reference as emitted by them.
    for rel in spec.consumers:
        path = root / rel
        if not path.exists():
            raise CheckerError(f"consumer file not found: {rel}")
        src = path.read_text(encoding="utf-8")
        for name, wire in consts.items():
            if re.search(rf"\b{re.escape(name)}\b", src):
                emitted.add(wire)

    return emitted, findings


# ─── Docs and frontend ───────────────────────────────────────────────────────


def parse_documented(root: Path, spec: ChannelSpec):
    path = root / spec.doc
    if not path.exists():
        raise CheckerError(f"docs page not found: {spec.doc}")
    text = path.read_text(encoding="utf-8")
    match = DOC_SPLIT.search(text)
    if match is None:
        raise CheckerError(
            f"{spec.doc}: no '## Group channel' heading — the checker splits the page "
            f"there to tell the two channels' event tables apart."
        )
    section = text[: match.start()] if spec.doc_side == "before" else text[match.start():]
    return {c for c in DOC_ROW.findall(section) if EVENT_SHAPE.match(c)}


def parse_handled(root: Path, spec: ChannelSpec):
    handled = set()
    for rel in spec.handlers:
        path = root / rel
        if not path.exists():
            raise CheckerError(f"frontend handler file not found: {rel}")
        handled |= set(HANDLER_BRANCH.findall(path.read_text(encoding="utf-8")))
    return handled


# ─── Reconciliation ──────────────────────────────────────────────────────────


@dataclass
class ChannelResult:
    label: str
    declared: set = field(default_factory=set)
    emitted: set = field(default_factory=set)
    documented: set = field(default_factory=set)
    handled: set = field(default_factory=set)
    findings: list = field(default_factory=list)


def reconcile(root: Path, spec: ChannelSpec, consts: dict, collections: dict, registries):
    res = ChannelResult(label=spec.label)

    for key in (spec.channel_set, spec.deprecated_map, spec.unhandled_map):
        if key not in collections:
            raise CheckerError(f"{spec.registry}: {key} not found or not parseable")

    res.declared = set(collections[spec.channel_set])
    deprecated = collections[spec.deprecated_map]
    unhandled = collections[spec.unhandled_map]

    res.emitted, emit_findings = scan_emitted(root, spec, consts, registries)
    res.findings += emit_findings
    res.documented = parse_documented(root, spec)
    res.handled = parse_handled(root, spec)

    f = res.findings
    ch = spec.label

    for name in sorted(res.emitted - res.declared):
        f.append(
            f"[{ch}] {name!r} is emitted but is not in {spec.channel_set}. Add it to the "
            f"registry in {spec.registry}."
        )
    for name in sorted(res.declared - res.emitted - set(deprecated)):
        f.append(
            f"[{ch}] {name!r} is declared in {spec.channel_set} but nothing emits it. If it "
            f"was retired, move it to {spec.deprecated_map} with the release it was "
            f"deprecated in — removing a documented event outright breaks the contract."
        )
    for name in sorted(res.declared - res.documented):
        f.append(
            f"[{ch}] {name!r} is emitted but has no row in {spec.doc} ({ch} channel section). "
            f"An undocumented event is one no integrator can consume."
        )
    for name in sorted(res.documented - res.declared - set(deprecated)):
        f.append(
            f"[{ch}] {name!r} is documented in {spec.doc} but is not in {spec.channel_set}. "
            f"Either the docs row is stale or an emit site was deleted."
        )
    for name in sorted(set(deprecated) - res.documented):
        f.append(
            f"[{ch}] {name!r} is marked deprecated in {spec.deprecated_map} but has no docs "
            f"row. The deprecation notice must stand for at least one minor release."
        )
    for name in sorted(set(deprecated) & res.emitted):
        f.append(
            f"[{ch}] {name!r} is marked deprecated in {spec.deprecated_map} but is still "
            f"emitted. Remove the emit site or the deprecation entry."
        )
    for name in sorted(res.emitted - res.handled - set(unhandled)):
        f.append(
            f"[{ch}] {name!r} is emitted but no frontend handler matches it in "
            f"{', '.join(spec.handlers)}. Add a handler, or add it to {spec.unhandled_map} "
            f"with the reason there is none."
        )
    for name in sorted(set(unhandled) - res.declared):
        f.append(
            f"[{ch}] {name!r} is exempted in {spec.unhandled_map} but is not a declared "
            f"{ch}-channel event. Stale exemption — remove it."
        )
    for name in sorted(set(unhandled) & res.handled):
        f.append(
            f"[{ch}] {name!r} is exempted in {spec.unhandled_map} but a frontend handler "
            f"now exists. Remove the exemption so the gate protects the handler."
        )
    for name, reason in sorted(unhandled.items()):
        if not reason:
            f.append(
                f"[{ch}] {name!r} is exempted in {spec.unhandled_map} with no reason. The "
                f"reason is what distinguishes a considered omission from a forgotten one."
            )

    return res


def run(root: Path, quiet=False):
    registries = [c.registry for c in CHANNELS]
    consts: dict = {}
    collections: dict = {}
    for spec in CHANNELS:
        path = root / spec.registry
        if not path.exists():
            raise CheckerError(f"registry not found: {spec.registry}")
        c, coll = load_registry(path, consts)
        # Constant names are resolved from one shared map, so two registries
        # defining the same name with different strings would make the resolver
        # pick one at random and quietly mis-report the other channel. The
        # overlapping names are meant to be *imported* from the board registry,
        # never restated — so a conflict here is a bug, not a configuration.
        for name, wire in c.items():
            if consts.get(name, wire) != wire:
                raise CheckerError(
                    f"{spec.registry}: {name} is {wire!r} here but {consts[name]!r} in another "
                    f"registry. Import the shared constant instead of restating it."
                )
        consts.update(c)
        collections.update(coll)

    results = [reconcile(root, spec, consts, collections, registries) for spec in CHANNELS]
    findings = [x for r in results for x in r.findings]

    if not quiet:
        for r in results:
            print(
                f"{r.label:>5} channel: {len(r.declared)} declared, {len(r.emitted)} emitted, "
                f"{len(r.documented)} documented, {len(r.handled)} handled"
            )
        print()
        if findings:
            print(f"ws-event-reachability: {len(findings)} finding(s)\n")
            for item in findings:
                print(f"  ✗ {item}")
            print(
                "\nEvery WebSocket event name must be emitted from the registry, "
                "documented in docs/api/websockets.md, and handled in the frontend "
                "(or explicitly exempted with a reason). See #1078."
            )
        else:
            print("ws-event-reachability: emitted ↔ documented ↔ handled all reconcile.")

    return findings


# ─── Self-test (#1093) ───────────────────────────────────────────────────────
#
# A bespoke gate that has silently stopped detecting anything is worse than no
# gate, because the green tick is read as a verdict. So the detection logic is
# proved against known-bad input on the same image, immediately before the real
# invocation. The fixture is a complete miniature of the real tree — registry,
# emit site, docs page, handler file — built in a temp dir; nothing in this
# repository is read or written.

_FIXTURE_REGISTRY_BOARD = '''\
EVT_CARD_CREATED = "card.created"
EVT_MEMBER_ADDED = "member.added"
EVT_MEMBER_UPDATED = "member.updated"
EVT_PING = "ping"

BOARD_CHANNEL_EVENTS: frozenset[str] = frozenset({
    EVT_CARD_CREATED,
    EVT_MEMBER_ADDED,
    EVT_MEMBER_UPDATED,
    EVT_PING,
})
DEPRECATED_BOARD_EVENTS: dict[str, str] = {}
INTENTIONALLY_UNHANDLED_BOARD_EVENTS: dict[str, str] = {
    EVT_MEMBER_UPDATED: "fixture: deliberately unhandled",
}


def broadcast_board_event(board_id, event_type, payload, *, event_id=None):
    pass


def record_board_event(board_id, event_type, payload, *, actor_id=None):
    pass


def persist_board_event(board_id, event_type, payload, *, actor_id=None):
    pass
'''

_FIXTURE_REGISTRY_GROUP = '''\
from boards.broadcast import EVT_PING

EVT_GROUP_CREATED = "group.created"

GROUP_CHANNEL_EVENTS: frozenset[str] = frozenset({
    EVT_GROUP_CREATED,
    EVT_PING,
})
DEPRECATED_GROUP_EVENTS: dict[str, str] = {}
INTENTIONALLY_UNHANDLED_GROUP_EVENTS: dict[str, str] = {}


def broadcast_group_event(group_id, event_type, payload):
    pass
'''

_FIXTURE_VIEWS = '''\
from .. import broadcast as _broadcast


class CardViewSet:
    def perform_create(self, serializer):
        _broadcast.record_board_event(1, _broadcast.EVT_CARD_CREATED, {})

    def add_member(self, request, created):
        # Exercises IfExp + local-variable resolution, the shape a grep misses.
        ws_event = _broadcast.EVT_MEMBER_ADDED if created else _broadcast.EVT_MEMBER_UPDATED
        _broadcast.record_board_event(1, ws_event, {})
'''

_FIXTURE_GROUP_VIEWS = '''\
from . import broadcast as _group_broadcast
from .broadcast import broadcast_group_event


def create_group():
    broadcast_group_event(1, _group_broadcast.EVT_GROUP_CREATED, {})
'''

_FIXTURE_BOARD_CONSUMER = '''\
import json
from .broadcast import EVT_PING


class BoardConsumer:
    async def ping(self):
        await self.send(json.dumps({"event": EVT_PING, "data": {}}))
'''

_FIXTURE_GROUP_CONSUMER = '''\
import json
from .broadcast import EVT_PING


class GroupConsumer:
    async def ping(self):
        await self.send(json.dumps({"event": EVT_PING, "data": {}}))
'''

_FIXTURE_DOCS = """\
# WebSocket API

## Board channel

| Close code | Meaning |
|---|---|
| `4001` | Unauthenticated |

## Event reference

| Event | Trigger | `data` shape |
|---|---|---|
| `card.created` | New card | Full object |
| `member.added` | Member added | Full object |
| `member.updated` | Member role changed | Full object |
| `ping` | Keepalive | `{}` |

## Group channel (since 1.1)

| Event | Trigger | `data` shape |
|---|---|---|
| `group.created` | Group created | Full object |
| `ping` | Keepalive | `{}` |
"""

_FIXTURE_BOARDVIEW = '''\
export function BoardView() {
  const onEvent = (event) => {
    if (event.event === "card.created") {
      addCard(event.data);
    } else if (event.event === "member.added") {
      refetchMembers();
    }
  };
}
'''

_FIXTURE_BOARD_SOCKET = '''\
export function useBoardSocket() {
  const handle = (data) => {
    if (data.event === "ping") return;
  };
}
'''

_FIXTURE_GROUPDETAIL = '''\
export function GroupDetail() {
  const onEvent = (evt) => {
    if (evt.event === "group.created") {
      refetchSubgroups();
    }
  };
}
'''

_FIXTURE_GROUP_SOCKET = '''\
export function useGroupSocket() {
  const handle = (data) => {
    if (data.event === "ping") return;
  };
}
'''

_FIXTURE = {
    "backend/boards/broadcast.py": _FIXTURE_REGISTRY_BOARD,
    "backend/boards/consumers.py": _FIXTURE_BOARD_CONSUMER,
    "backend/boards/views/cards.py": _FIXTURE_VIEWS,
    "backend/groups/broadcast.py": _FIXTURE_REGISTRY_GROUP,
    "backend/groups/consumers.py": _FIXTURE_GROUP_CONSUMER,
    "backend/groups/views.py": _FIXTURE_GROUP_VIEWS,
    "backend/git_lens/__init__.py": "",
    "docs/api/websockets.md": _FIXTURE_DOCS,
    "frontend/src/components/Board/BoardView.tsx": _FIXTURE_BOARDVIEW,
    "frontend/src/hooks/useBoardSocket.ts": _FIXTURE_BOARD_SOCKET,
    "frontend/src/pages/GroupDetail.tsx": _FIXTURE_GROUPDETAIL,
    "frontend/src/hooks/useGroupSocket.ts": _FIXTURE_GROUP_SOCKET,
}


def _materialize(root: Path, overrides=None):
    for rel, body in {**_FIXTURE, **(overrides or {})}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")


def _mutate(rel, old, new):
    return {rel: _FIXTURE[rel].replace(old, new, 1)}


def self_test():
    """Prove each detector fires against a deliberately broken fixture."""
    cases = [
        (
            "clean fixture reconciles",
            {},
            None,
        ),
        (
            "emitted name missing from the docs page",
            _mutate("docs/api/websockets.md", "| `card.created` | New card | Full object |\n", ""),
            "has no row in",
        ),
        (
            "documented name nothing emits",
            _mutate(
                "docs/api/websockets.md",
                "| `ping` | Keepalive | `{}` |\n\n## Group channel",
                "| `ping` | Keepalive | `{}` |\n| `card.teleported` | Ghost | `{}` |\n\n## Group channel",
            ),
            "is documented in",
        ),
        (
            "emitted name with no frontend handler",
            _mutate(
                "frontend/src/components/Board/BoardView.tsx",
                'if (event.event === "card.created") {\n      addCard(event.data);\n    } else ',
                "if (false) {\n    } else ",
            ),
            "no frontend handler matches it",
        ),
        (
            "bare string literal at an emit site",
            _mutate(
                "backend/boards/views/cards.py",
                "_broadcast.record_board_event(1, _broadcast.EVT_CARD_CREATED, {})",
                '_broadcast.record_board_event(1, "card.created", {})',
            ),
            "is a bare string literal",
        ),
        (
            "emitted name absent from the registry",
            _mutate(
                "backend/boards/broadcast.py",
                "    EVT_CARD_CREATED,\n    EVT_MEMBER_ADDED,",
                "    EVT_MEMBER_ADDED,",
            ),
            "is not in BOARD_CHANNEL_EVENTS",
        ),
        (
            "declared name whose emit site was deleted",
            _mutate(
                "backend/boards/views/cards.py",
                "_broadcast.record_board_event(1, _broadcast.EVT_CARD_CREATED, {})",
                "pass",
            ),
            "but nothing emits it",
        ),
        (
            "exemption with no reason",
            _mutate(
                "backend/boards/broadcast.py",
                'EVT_MEMBER_UPDATED: "fixture: deliberately unhandled",',
                'EVT_MEMBER_UPDATED: "",',
            ),
            "with no reason",
        ),
        (
            "stale exemption for a handled event",
            _mutate(
                "frontend/src/components/Board/BoardView.tsx",
                'else if (event.event === "member.added") {',
                'else if (event.event === "member.updated") {',
            ),
            "a frontend handler now exists",
        ),
        (
            "group-channel drift is caught separately from board-channel drift",
            _mutate(
                "frontend/src/pages/GroupDetail.tsx",
                'evt.event === "group.created"',
                'evt.event === "group.invented"',
            ),
            "[group] 'group.created' is emitted but no frontend handler",
        ),
        (
            "unresolvable event expression fails closed",
            _mutate(
                "backend/boards/views/cards.py",
                "_broadcast.record_board_event(1, _broadcast.EVT_CARD_CREATED, {})",
                "_broadcast.record_board_event(1, compute_name(), {})",
            ),
            "cannot prove which event name",
        ),
    ]

    failures = 0
    for name, overrides, expect in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _materialize(root, overrides)
            try:
                findings = run(root, quiet=True)
            except CheckerError as exc:
                print(f"  ✗ {name}: checker aborted: {exc}")
                failures += 1
                continue
        if expect is None:
            ok = not findings
            detail = "; ".join(findings[:3])
        else:
            ok = any(expect in x for x in findings)
            detail = "no finding matched" if not ok else ""
        if ok:
            print(f"  ✓ {name}")
        else:
            print(f"  ✗ {name}: {detail or 'expected ' + repr(expect)}")
            for x in findings:
                print(f"      · {x}")
            failures += 1

    print()
    if failures:
        print(f"check-ws-event-reachability --self-test: {failures} of {len(cases)} cases FAILED")
        return 1
    print(f"check-ws-event-reachability --self-test: all {len(cases)} cases passed")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Assert emitted ↔ documented ↔ handled for every WebSocket event (#1078).",
    )
    parser.add_argument(
        "--root",
        default=os.environ.get("CI_PROJECT_DIR") or str(Path(__file__).resolve().parent.parent),
        help="repository root (default: the checkout this script lives in)",
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="prove the detection logic against known-bad fixtures and exit",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    try:
        findings = run(Path(args.root))
    except CheckerError as exc:
        print(f"check-ws-event-reachability: cannot run: {exc}", file=sys.stderr)
        return 2
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
