#!/usr/bin/env python3
"""Public-contract compatibility diff against the last GA tag (#1667).

Visiban 1.0+ treats the REST schema and the operator-facing environment
variable names as public contracts (see CLAUDE.md "Backward compatibility").
Nothing diffed them against a release, so "zero removals since v1.1.0" was a
manual claim. This gate does that diff on every MR:

  1. OpenAPI: the schema `manage.py spectacular` emits for HEAD is compared with
     a committed baseline generated from the GA tag. It fails on removed
     operations, removed/renamed parameters, removed or retyped fields, a new
     required request field/parameter, and a response field that became
     optional or nullable. Pure additions pass.
  2. Settings: every env var name read by `backend/visiban/settings.py` at the
     GA tag must still be read at HEAD (a kept deprecated alias counts).

Experimental operations (#1875) are listed in
`scripts/compat-baseline/experimental.json` by path pattern. They are skipped on
both sides of the diff and stripped by `--normalize`, so they never freeze when
the baseline is rolled. This is not the allow-list: that excuses one specific
break, this keeps a whole operation out of the contract. Every entry needs an
issue and a reason, and an entry that matches no operation fails the gate.

Deliberate breaks are allow-listed in `scripts/compat-baseline/allowlist.json`,
one entry per finding, each with a mandatory issue reference. An allow-list
entry that no longer matches a finding is itself a failure, so the list cannot
rot into a silent blanket exemption.

Usage:
    python3 scripts/check-api-compat.py [--schema FILE] [--settings FILE]
    python3 scripts/check-api-compat.py --self-test
    python3 scripts/check-api-compat.py --normalize IN.json OUT.json
    python3 scripts/check-api-compat.py --dump-env settings.py

Regenerating the baseline (only when cutting a new GA tag) is documented in
docs/development/api-compat-gate.md.
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import cli_roots, resolve_within  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
BASELINE_DIR = REPO_ROOT / "scripts" / "compat-baseline"
BASELINE_SCHEMA = BASELINE_DIR / "v1.2.0" / "openapi.json"
BASELINE_ENV = BASELINE_DIR / "v1.2.0" / "settings-env.txt"
ALLOWLIST = BASELINE_DIR / "allowlist.json"
EXPERIMENTAL = BASELINE_DIR / "experimental.json"
SETTINGS_PY = BACKEND_DIR / "visiban" / "settings.py"

HTTP_METHODS = ("get", "put", "post", "patch", "delete", "head", "options", "trace")
# Documentation-only keys: stripped so the committed baseline stays small and
# prose edits never read as contract changes.
_NOISE_KEYS = {"description", "summary", "example", "examples", "externalDocs", "title", "deprecated"}
ISSUE_RE = re.compile(r"^#\d+$")


@dataclass(frozen=True)
class Finding:
    kind: str
    location: str

    @property
    def key(self) -> str:
        return f"{self.kind} {self.location}"


# --- normalization -----------------------------------------------------------


def normalize(node):
    """Drop prose/example noise recursively; keep structure."""
    if isinstance(node, dict):
        return {
            k: normalize(v)
            for k, v in node.items()
            if k not in _NOISE_KEYS and not k.startswith("x-")
        } if "properties" not in node else {
            # `properties` is a name->schema map: a field literally called
            # "description" or "title" is real contract and must survive.
            k: (
                {n: normalize(s) for n, s in v.items()}
                if k == "properties"
                else normalize(v)
            )
            for k, v in node.items()
            if k not in _NOISE_KEYS and not k.startswith("x-")
        }
    if isinstance(node, list):
        return [normalize(v) for v in node]
    return node


# --- schema resolution -------------------------------------------------------


class Doc:
    def __init__(self, spec: dict):
        self.spec = spec

    def deref(self, node: dict) -> dict:
        seen = 0
        while isinstance(node, dict) and "$ref" in node and seen < 20:
            node = self._lookup(node["$ref"])
            seen += 1
        return node

    def _lookup(self, ref: str) -> dict:
        cur = self.spec
        for part in ref.lstrip("#/").split("/"):
            cur = cur.get(part.replace("~1", "/").replace("~0", "~"), {})
        return cur

    def flatten(self, node: dict) -> dict:
        """Resolve $ref and merge allOf into a single properties/required view."""
        node = self.deref(node or {})
        if not isinstance(node, dict):
            return {}
        if "allOf" not in node:
            return node
        merged = {k: v for k, v in node.items() if k != "allOf"}
        props = dict(merged.get("properties", {}))
        required = list(merged.get("required", []))
        for part in node["allOf"]:
            sub = self.flatten(part)
            props.update(sub.get("properties", {}))
            required += sub.get("required", [])
            for k in ("type", "format", "enum", "items", "nullable"):
                if k in sub and k not in merged:
                    merged[k] = sub[k]
        if props:
            merged["properties"] = props
        if required:
            merged["required"] = sorted(set(required))
        return merged


def _nullable(s: dict) -> bool:
    if s.get("nullable"):
        return True
    t = s.get("type")
    return isinstance(t, list) and "null" in t


def _type(s: dict):
    t = s.get("type")
    if isinstance(t, list):
        t = sorted(x for x in t if x != "null")
        t = t[0] if len(t) == 1 else tuple(t)
    return t


# --- schema comparison -------------------------------------------------------


class Comparer:
    def __init__(self, old: Doc, new: Doc):
        self.old, self.new = old, new
        self.findings: list[Finding] = []

    def add(self, kind: str, loc: str) -> None:
        self.findings.append(Finding(kind, loc))

    def run(self) -> list[Finding]:
        old_paths = self.old.spec.get("paths", {})
        new_paths = self.new.spec.get("paths", {})
        for path, item in sorted(old_paths.items()):
            for method in HTTP_METHODS:
                if method not in item:
                    continue
                op_id = f"{method.upper()} {path}"
                new_op = new_paths.get(path, {}).get(method)
                if new_op is None:
                    self.add("REMOVED_OPERATION", op_id)
                    continue
                self.compare_op(op_id, item[method], new_op)
        return self.findings

    def compare_op(self, op_id: str, old_op: dict, new_op: dict) -> None:
        self.compare_params(op_id, old_op, new_op)
        self.compare_request(op_id, old_op, new_op)
        self.compare_responses(op_id, old_op, new_op)

    def _params(self, doc: Doc, op: dict) -> dict:
        out = {}
        for p in op.get("parameters", []):
            p = doc.deref(p)
            out[(p.get("in"), p.get("name"))] = p
        return out

    def compare_params(self, op_id, old_op, new_op) -> None:
        old_p, new_p = self._params(self.old, old_op), self._params(self.new, new_op)
        for (where, name), p in sorted(old_p.items(), key=str):
            loc = f"{op_id} {where}:{name}"
            q = new_p.get((where, name))
            if q is None:
                self.add("REMOVED_PARAMETER", loc)
                continue
            if q.get("required") and not p.get("required"):
                self.add("PARAMETER_BECAME_REQUIRED", loc)
            ot = _type(self.old.flatten(p.get("schema", {})))
            nt = _type(self.new.flatten(q.get("schema", {})))
            if ot and nt and ot != nt:
                self.add("PARAMETER_TYPE_CHANGED", f"{loc} {ot}->{nt}")
        for (where, name), q in sorted(new_p.items(), key=str):
            if (where, name) not in old_p and q.get("required"):
                self.add("NEW_REQUIRED_PARAMETER", f"{op_id} {where}:{name}")

    def compare_request(self, op_id, old_op, new_op) -> None:
        old_b = self.old.deref(old_op.get("requestBody", {}))
        new_b = self.new.deref(new_op.get("requestBody", {}))
        if not old_b:
            if new_b.get("required"):
                self.add("NEW_REQUIRED_REQUEST_BODY", op_id)
            return
        if new_b.get("required") and not old_b.get("required"):
            self.add("REQUEST_BODY_BECAME_REQUIRED", op_id)
        for media, m in sorted(old_b.get("content", {}).items()):
            nm = new_b.get("content", {}).get(media)
            if nm is None:
                self.add("REMOVED_REQUEST_MEDIA_TYPE", f"{op_id} {media}")
                continue
            self.compare_schema(
                m.get("schema", {}), nm.get("schema", {}),
                f"{op_id} request {media}", "request", frozenset(),
            )

    def compare_responses(self, op_id, old_op, new_op) -> None:
        new_r = new_op.get("responses", {})
        for code, r in sorted(old_op.get("responses", {}).items()):
            if not str(code).startswith("2"):
                continue  # error shapes are not the public success contract
            nr = new_r.get(code)
            if nr is None:
                self.add("REMOVED_RESPONSE_STATUS", f"{op_id} {code}")
                continue
            r, nr = self.old.deref(r), self.new.deref(nr)
            for media, m in sorted(r.get("content", {}).items()):
                nm = nr.get("content", {}).get(media)
                if nm is None:
                    self.add("REMOVED_RESPONSE_MEDIA_TYPE", f"{op_id} {code} {media}")
                    continue
                self.compare_schema(
                    m.get("schema", {}), nm.get("schema", {}),
                    f"{op_id} response {code} {media}", "response", frozenset(),
                )

    def compare_schema(self, old_s, new_s, loc: str, side: str, seen) -> None:
        marker = (json.dumps(old_s, sort_keys=True), json.dumps(new_s, sort_keys=True))
        if marker in seen:
            return  # recursive component; already being compared
        seen = seen | {marker}
        o, n = self.old.flatten(old_s), self.new.flatten(new_s)
        if not o:
            return  # baseline made no claim (untyped); nothing to break
        if side == "response" and o.get("readOnly") and _type(o) == "string" and not (
            o.keys() & {"format", "enum", "pattern", "maxLength", "nullable"}
        ):
            # drf-spectacular's fallback for a SerializerMethodField with no
            # type hint is a bare read-only string. That is a documentation
            # gap, not a promise the API makes, so a later `string -> integer`
            # correction must not read as a breaking change.
            return
        ot, nt = _type(o), _type(n)
        if ot and nt and ot != nt:
            self.add("TYPE_CHANGED", f"{loc} {ot}->{nt}")
            return
        if side == "response" and not _nullable(o) and _nullable(n):
            self.add("RESPONSE_BECAME_NULLABLE", loc)
        if side == "request" and _nullable(o) and not _nullable(n):
            self.add("REQUEST_STOPPED_ACCEPTING_NULL", loc)
        if side == "request" and "enum" in o and "enum" in n:
            for v in o["enum"]:
                if v not in n["enum"]:
                    self.add("REQUEST_ENUM_VALUE_REMOVED", f"{loc} {v!r}")
        if "items" in o and "items" in n:
            self.compare_schema(o["items"], n["items"], f"{loc}[]", side, seen)
        # Map values (#2101): a dict field such as ``choice_colors`` is an
        # object whose ``additionalProperties`` is the value schema. Walked like
        # ``items``, under the location ``.{*}``. A map that stops accepting
        # any entry (``false``) reads as a removed field; a value schema that
        # becomes untyped (absent or ``true``) is not a finding, the same rule
        # as an untyped property.
        o_ap, n_ap = o.get("additionalProperties"), n.get("additionalProperties")
        if isinstance(o_ap, dict) and o_ap:
            aloc = f"{loc} .{{*}}"
            if isinstance(n_ap, dict):
                self.compare_schema(o_ap, n_ap, aloc, side, seen)
            elif n_ap is False:
                kind = "REMOVED_RESPONSE_FIELD" if side == "response" else "REMOVED_REQUEST_FIELD"
                self.add(kind, aloc)
        o_props, n_props = o.get("properties", {}), n.get("properties", {})
        o_req, n_req = set(o.get("required", [])), set(n.get("required", []))
        for name, sub in sorted(o_props.items()):
            floc = f"{loc} .{name}"
            if name not in n_props:
                kind = "REMOVED_RESPONSE_FIELD" if side == "response" else "REMOVED_REQUEST_FIELD"
                self.add(kind, floc)
                continue
            if side == "response" and name in o_req and name not in n_req:
                self.add("RESPONSE_FIELD_BECAME_OPTIONAL", floc)
            if side == "request" and name in n_req and name not in o_req:
                self.add("REQUEST_FIELD_BECAME_REQUIRED", floc)
            self.compare_schema(sub, n_props[name], floc, side, seen)
        if side == "request":
            for name in sorted(n_req - set(o_props)):
                self.add("NEW_REQUIRED_REQUEST_FIELD", f"{loc} .{name}")


def diff_schemas(old: dict, new: dict) -> list[Finding]:
    return Comparer(Doc(old), Doc(new)).run()


# --- settings env names ------------------------------------------------------


def env_names(source: str) -> set[str]:
    """Env var names read by a settings module, found via AST (no execution).

    Covers `env("X")`, `env.bool("X")` (django-environ), `_secret_env("X")` (settings'
    secret-or-file helper), `os.environ.get("X")`,
    `os.getenv("X")`, `os.environ["X"]`, the `_warn_deprecated_env_alias`
    helper whose first argument is a legacy name read indirectly, the
    `_env_alias_name("NEW", "OLD")` resolver (#1873), which reads both, and a
    `JobSpec(name, "ENV", default)` scheduler entry (run_scheduler.py), whose
    second argument is read through `environ.get(spec.env_var)`.
    """
    names: set[str] = set()

    def lit(n):
        return n.value if isinstance(n, ast.Constant) and isinstance(n.value, str) else None

    def dotted(n) -> str:
        parts = []
        while isinstance(n, ast.Attribute):
            parts.append(n.attr)
            n = n.value
        if isinstance(n, ast.Name):
            parts.append(n.id)
        return ".".join(reversed(parts))

    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call) and node.args:
            f = dotted(node.func)
            if f in ("env", "_secret_env") or f.startswith("env.") or f in ("os.environ.get", "os.getenv"):
                if (v := lit(node.args[0])) and re.fullmatch(r"[A-Z][A-Z0-9_]*", v):
                    names.add(v)
            elif f in ("_warn_deprecated_env_alias", "_env_alias_name"):
                for a in node.args[:2]:
                    if (v := lit(a)):
                        names.add(v)
            elif f == "JobSpec" and len(node.args) > 1:
                if (v := lit(node.args[1])) and re.fullmatch(r"[A-Z][A-Z0-9_]*", v):
                    names.add(v)
        elif isinstance(node, ast.Subscript) and dotted(node.value) == "os.environ":
            if v := lit(node.slice):
                names.add(v)
    return names


_SKIP_DIRS = {"tests", ".venv", "venv", "node_modules", "__pycache__", "migrations"}


def env_names_in_tree(root: Path) -> set[str]:
    """`env_names` over every non-test `.py` file under `root` (#1873).

    For the env var INVENTORY (docs/development/api-compat-gate.md), which
    must also see reads outside settings.py, such as management commands. Not
    used by the gate itself, which still diffs settings.py only.
    """
    names: set[str] = set()
    for path in sorted(root.rglob("*.py")):
        rel = path.relative_to(root).parts
        if any(part in _SKIP_DIRS for part in rel[:-1]):
            continue
        if path.name.startswith("test_") or path.name == "conftest.py":
            continue
        try:
            names |= env_names(path.read_text())
        except SyntaxError:
            continue
    return names


def diff_env(old_names: set[str], new_names: set[str]) -> list[Finding]:
    return [Finding("REMOVED_ENV_VAR", n) for n in sorted(old_names - new_names)]


# --- allow-list --------------------------------------------------------------


def _entry_name(e: dict) -> str:
    return e.get("key") or f"operation {e.get('operation')}"


def load_allowlist(path: Path) -> tuple[list[dict], list[str]]:
    if not path.exists():
        return [], []
    data = json.loads(path.read_text())
    entries = data.get("allow", []) if isinstance(data, dict) else []
    errors = []
    for i, e in enumerate(entries):
        if bool(e.get("key")) == bool(e.get("operation")):
            errors.append(f"allowlist entry {i}: needs exactly one of 'key' or 'operation'")
        if not ISSUE_RE.match(str(e.get("issue", ""))):
            errors.append(f"allowlist entry {i} ({_entry_name(e)}): 'issue' must look like #1234")
        if not e.get("reason"):
            errors.append(f"allowlist entry {i} ({_entry_name(e)}): missing 'reason'")
    return entries, errors


def _entry_matches(e: dict, f: Finding) -> bool:
    if e.get("key"):
        # fnmatch so one reviewed entry may cover a family; "[" is literal
        # (spectacular emits a regex-ish path with brackets).
        return fnmatch.fnmatchcase(f.key, e["key"].replace("[", "[[]"))
    op = e["operation"]  # "METHOD /path/": every finding under that operation
    return f.location == op or f.location.startswith(op + " ")


def apply_allowlist(findings: list[Finding], entries: list[dict]):
    """Split findings into (live, allow-listed entries that fired, stale entries).

    An entry that matches nothing is stale and fails the gate, so the list can
    only shrink toward the truth, never accumulate dead exemptions.
    """
    live, hit = [], set()
    for f in findings:
        matched = [i for i, e in enumerate(entries) if _entry_matches(e, f)]
        if matched:
            hit.update(matched)
        else:
            live.append(f)
    stale = [_entry_name(e) for i, e in enumerate(entries) if i not in hit]
    return live, [entries[i] for i in sorted(hit)], sorted(stale)


# --- experimental operations (#1875) -----------------------------------------


def load_experimental(path: Path) -> tuple[list[dict], list[str]]:
    if not path.exists():
        return [], []
    data = json.loads(path.read_text())
    entries = data.get("experimental", []) if isinstance(data, dict) else []
    errors = []
    for i, e in enumerate(entries):
        name = e.get("path_pattern") or f"#{i}"
        if not e.get("path_pattern"):
            errors.append(f"experimental entry {i}: missing 'path_pattern'")
        if not ISSUE_RE.match(str(e.get("issue", ""))):
            errors.append(f"experimental entry {i} ({name}): 'issue' must look like #1234")
        if not e.get("reason"):
            errors.append(f"experimental entry {i} ({name}): missing 'reason'")
    return entries, errors


def _is_experimental(entries: list[dict], path: str) -> list[int]:
    # "[" is literal: spectacular can emit regex-ish paths with brackets.
    return [
        i for i, e in enumerate(entries)
        if e.get("path_pattern") and fnmatch.fnmatchcase(path, e["path_pattern"].replace("[", "[[]"))
    ]


def strip_experimental(spec: dict, entries: list[dict]):
    """Drop experimental paths from a schema.

    Returns (stripped spec, sorted "METHOD /path" ops dropped, entry indexes
    that matched a path). Only `paths` is filtered: components are compared
    solely through the operations that reference them, so a component shared
    with a non-experimental operation is still checked through that operation.
    """
    paths = spec.get("paths", {})
    kept, dropped, hit = {}, [], set()
    for path, item in paths.items():
        matched = _is_experimental(entries, path)
        if not matched:
            kept[path] = item
            continue
        hit.update(matched)
        dropped += [f"{m.upper()} {path}" for m in HTTP_METHODS if m in item]
    return dict(spec, paths=kept), sorted(dropped), hit


# --- driver ------------------------------------------------------------------


def generate_schema(destination: Path) -> None:
    env = dict(os.environ)
    env.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
    # git_lens is conditionally installed; force it on so a local
    # GIT_LENS_ENABLED=False cannot make a local run disagree with CI.
    env["GIT_LENS_ENABLED"] = "True"
    subprocess.run(
        [sys.executable, "manage.py", "spectacular", "--format", "openapi-json", "--file", str(destination)],
        cwd=BACKEND_DIR, env=env, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


def report(live, allowed, stale, errors, skipped=(), dead=()) -> int:
    for e in errors:
        print(f"ERROR {e}")
    if skipped:
        print(f"Experimental operations skipped, not frozen ({len(skipped)}):")
        for op in skipped:
            print(f"  {op}")
    if dead:
        print(f"DEAD experimental entries (match no operation in the baseline or HEAD; remove them; with --schema FILE the schema must be generated with GIT_LENS_ENABLED=True or git-lens entries report as dead) - {len(dead)}:")
        for k in dead:
            print(f"  {k}")
    if allowed:
        print(f"Allow-listed breaking changes ({len(allowed)}):")
        for e in allowed:
            print(f"  {_entry_name(e)} -- {e['issue']}: {e['reason']}")
    if stale:
        print(f"STALE allow-list entries (no longer match a finding; remove them) - {len(stale)}:")
        for k in stale:
            print(f"  {k}")
    if live:
        print(f"BREAKING changes vs the GA baseline - {len(live)}:")
        for f in live:
            print(f"  {f.key}")
        print(
            "\nBackward compatibility is a 1.0+ contract. Restore the field/endpoint/env var, "
            "or (if the break is deliberate and planned for a major bump) add an entry with an "
            "issue reference to scripts/compat-baseline/allowlist.json."
        )
    if live or stale or errors or dead:
        return 1
    print("OK - no breaking OpenAPI or settings changes vs the GA baseline.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--schema", type=Path, help="pre-generated HEAD openapi.json (default: run spectacular)")
    ap.add_argument("--settings", type=Path, default=SETTINGS_PY, help="settings.py to scan for env names")
    ap.add_argument("--baseline-schema", type=Path, default=BASELINE_SCHEMA)
    ap.add_argument("--baseline-env", type=Path, default=BASELINE_ENV)
    ap.add_argument("--allowlist", type=Path, default=ALLOWLIST)
    ap.add_argument("--experimental", type=Path, default=EXPERIMENTAL)
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--normalize", nargs=2, metavar=("IN", "OUT"), type=Path)
    ap.add_argument("--dump-env", type=Path, metavar="SETTINGS_PY_OR_DIR",
                    help="print env names read by a settings file, or by every non-test .py under a directory")
    args = ap.parse_args()

    if args.self_test:
        return self_test()
    roots = cli_roots()
    if args.normalize:
        src = json.loads(resolve_within(roots, args.normalize[0]).read_text())
        # Experimental operations must never enter a rolled baseline (#1875).
        exp_entries, exp_errors = load_experimental(resolve_within(roots, args.experimental))
        if exp_errors:
            print("\n".join(f"ERROR {e}" for e in exp_errors))
            return 1
        src, _, _ = strip_experimental(src, exp_entries)
        out = resolve_within(roots, args.normalize[1])
        out.write_text(json.dumps(normalize(src), sort_keys=True, separators=(",", ":")) + "\n")
        return 0
    if args.dump_env:
        target = resolve_within(roots, args.dump_env)
        found = env_names_in_tree(target) if target.is_dir() else env_names(target.read_text())
        print("\n".join(sorted(found)))
        return 0

    old_schema = json.loads(resolve_within(roots, args.baseline_schema).read_text())
    if args.schema:
        new_schema = json.loads(resolve_within(roots, args.schema).read_text())
    else:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "openapi.json"
            generate_schema(out)
            new_schema = json.loads(out.read_text())
    exp_entries, exp_errors = load_experimental(resolve_within(roots, args.experimental))
    old_schema, old_skipped, old_hit = strip_experimental(old_schema, exp_entries)
    new_schema, new_skipped, new_hit = strip_experimental(new_schema, exp_entries)
    skipped = sorted(set(old_skipped) | set(new_skipped))
    dead = [e.get("path_pattern") or f"#{i}" for i, e in enumerate(exp_entries) if i not in old_hit | new_hit]
    findings = diff_schemas(normalize(old_schema), normalize(new_schema))

    old_env = {ln.strip() for ln in resolve_within(roots, args.baseline_env).read_text().splitlines() if ln.strip()}
    findings += diff_env(old_env, env_names(resolve_within(roots, args.settings).read_text()))

    entries, errors = load_allowlist(resolve_within(roots, args.allowlist))
    live, allowed, stale = apply_allowlist(findings, entries)
    return report(live, allowed, stale, errors + exp_errors, skipped, sorted(dead))


# --- self-test ---------------------------------------------------------------


def _spec(props=None, required=None, params=None, body=None, status="200", extra_paths=None):
    resp_schema = {"type": "object", "properties": props or {}, "required": required or []}
    op = {"parameters": params or [], "responses": {status: {"content": {"application/json": {"schema": resp_schema}}}}}
    if body is not None:
        op["requestBody"] = {"required": True, "content": {"application/json": {"schema": body}}}
    paths = {"/api/x/": {"get": op}}
    paths.update(extra_paths or {})
    return {"paths": paths, "components": {"schemas": {}}}


def _kinds(old, new):
    return sorted({f.kind for f in diff_schemas(normalize(old), normalize(new))})


def self_test() -> int:
    failures: list[str] = []

    def check(name, got, want):
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")

    base = _spec(props={"id": {"type": "integer"}, "name": {"type": "string"}}, required=["id", "name"])
    check("identical passes", _kinds(base, base), [])

    added = _spec(props={"id": {"type": "integer"}, "name": {"type": "string"}, "extra": {"type": "string"}},
                  required=["id", "name"])
    added["paths"]["/api/new/"] = {"get": {"responses": {"200": {}}}}
    check("additions pass", _kinds(base, added), [])

    removed_field = _spec(props={"id": {"type": "integer"}}, required=["id"])
    check("removed response field", _kinds(base, removed_field), ["REMOVED_RESPONSE_FIELD"])

    retyped = _spec(props={"id": {"type": "string"}, "name": {"type": "string"}}, required=["id", "name"])
    check("type change", _kinds(base, retyped), ["TYPE_CHANGED"])

    optional = _spec(props={"id": {"type": "integer"}, "name": {"type": "string"}}, required=["id"])
    check("response field became optional", _kinds(base, optional), ["RESPONSE_FIELD_BECAME_OPTIONAL"])

    nullable = _spec(props={"id": {"type": "integer"}, "name": {"type": "string", "nullable": True}},
                     required=["id", "name"])
    check("response became nullable", _kinds(base, nullable), ["RESPONSE_BECAME_NULLABLE"])

    gone = {"paths": {}, "components": {}}
    check("removed operation", _kinds(base, gone), ["REMOVED_OPERATION"])

    old_body = {"type": "object", "properties": {"a": {"type": "string"}}}
    new_body_req = {"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]}
    check("request field became required",
          _kinds(_spec(body=old_body), _spec(body=new_body_req)), ["REQUEST_FIELD_BECAME_REQUIRED"])
    new_body_new = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["b"]}
    check("new required request field",
          _kinds(_spec(body=old_body), _spec(body=new_body_new)), ["NEW_REQUIRED_REQUEST_FIELD"])
    new_body_opt = {"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}}
    check("new optional request field passes", _kinds(_spec(body=old_body), _spec(body=new_body_opt)), [])

    qp = {"in": "query", "name": "q", "schema": {"type": "string"}}
    check("removed query param", _kinds(_spec(params=[qp]), _spec()), ["REMOVED_PARAMETER"])
    check("new required query param", _kinds(_spec(), _spec(params=[dict(qp, required=True)])), ["NEW_REQUIRED_PARAMETER"])
    check("new optional query param passes", _kinds(_spec(), _spec(params=[qp])), [])

    # $ref + allOf resolution, and renamed components must not matter.
    old_ref = {"paths": {"/r/": {"get": {"responses": {"200": {"content": {"application/json": {
        "schema": {"$ref": "#/components/schemas/Old"}}}}}}}},
        "components": {"schemas": {"Old": {"type": "object", "properties": {"k": {"type": "integer"}}}}}}
    new_ref = {"paths": {"/r/": {"get": {"responses": {"200": {"content": {"application/json": {
        "schema": {"allOf": [{"$ref": "#/components/schemas/Renamed"}]}}}}}}}},
        "components": {"schemas": {"Renamed": {"type": "object", "properties": {"k": {"type": "integer"}, "n": {"type": "string"}}}}}}
    check("ref rename + allOf passes", _kinds(old_ref, new_ref), [])
    new_ref["components"]["schemas"]["Renamed"]["properties"].pop("k")
    check("ref removal detected", _kinds(old_ref, new_ref), ["REMOVED_RESPONSE_FIELD"])

    # Self-referential component must terminate.
    rec = {"paths": {"/t/": {"get": {"responses": {"200": {"content": {"application/json": {
        "schema": {"$ref": "#/components/schemas/Tree"}}}}}}}},
        "components": {"schemas": {"Tree": {"type": "object", "properties": {
            "child": {"$ref": "#/components/schemas/Tree"}}}}}}
    check("recursive schema terminates", _kinds(rec, rec), [])

    # Map values (#2101): additionalProperties is walked like items.
    def _map(value):
        return _spec(props={"colors": {"type": "object", "additionalProperties": value}}, required=["colors"])

    str_map = _map({"type": "string"})
    check("map value unchanged passes", _kinds(str_map, str_map), [])
    check("map value type change", _kinds(str_map, _map({"type": "integer"})), ["TYPE_CHANGED"])
    check("map value became nullable", _kinds(str_map, _map({"type": "string", "nullable": True})),
          ["RESPONSE_BECAME_NULLABLE"])
    check("map stopped accepting entries", _kinds(str_map, _map(False)), ["REMOVED_RESPONSE_FIELD"])
    check("map value became untyped passes", _kinds(str_map, _map(True)), [])
    obj_map = _map({"type": "object", "properties": {"hex": {"type": "string"}}, "required": ["hex"]})
    check("map value field removed",
          _kinds(obj_map, _map({"type": "object", "properties": {}})), ["REMOVED_RESPONSE_FIELD"])
    check("map value location",
          [f.location for f in diff_schemas(normalize(str_map), normalize(_map({"type": "integer"})))],
          ["GET /api/x/ response 200 application/json .colors .{*} string->integer"])

    # normalize keeps a field literally named "description".
    n = normalize({"type": "object", "description": "doc", "properties": {"description": {"type": "string", "description": "x"}}})
    check("normalize keeps field named description", n, {"type": "object", "properties": {"description": {"type": "string"}}})

    # env names
    src = (
        'import os\nA = env("ALPHA")\nB = env.bool("BETA", default=False)\n'
        'C = os.environ.get("GAMMA")\nD = os.environ["DELTA"]\n'
        '_warn_deprecated_env_alias("OLD_NAME", "NEW_NAME")\nE = env(some_var)\nF = env("lower")\n'
        'G = env.int(_env_alias_name("CANON", "LEGACY"), default=1)\n'
        'JOBS = [JobSpec("job", "SCHED_X", "off")]\n'
    )
    check("env name extraction", sorted(env_names(src)),
          ["ALPHA", "BETA", "CANON", "DELTA", "GAMMA", "LEGACY", "NEW_NAME", "OLD_NAME", "SCHED_X"])
    with tempfile.TemporaryDirectory() as td:
        tree = Path(td)
        (tree / "app" / "tests").mkdir(parents=True)
        (tree / "app" / "cmd.py").write_text('import os\nX = os.environ.get(\n    "SPLIT_READ", ""\n)\n')
        (tree / "app" / "tests" / "helper.py").write_text('import os\nos.environ.get("IN_TESTS_DIR")\n')
        (tree / "app" / "test_thing.py").write_text('import os\nos.environ.get("IN_TEST_FILE")\n')
        check("tree scan: multi-line read found, test code skipped", sorted(env_names_in_tree(tree)), ["SPLIT_READ"])
    check("env removal flagged", [f.key for f in diff_env({"A", "B"}, {"A"})], ["REMOVED_ENV_VAR B"])
    check("env alias kept passes", diff_env({"A"}, {"A", "A_NEW"}), [])

    # allow-list semantics
    fs = diff_schemas(normalize(base), normalize(removed_field))
    live, allowed, stale = apply_allowlist(fs, [{"key": fs[0].key, "issue": "#1", "reason": "r"}])
    check("allow-listed removal passes", (len(live), len(allowed), stale), (0, 1, []))
    live, allowed, stale = apply_allowlist(fs, [{"operation": "GET /api/x/", "issue": "#1", "reason": "r"}])
    check("operation-scoped entry passes", (len(live), len(allowed), stale), (0, 1, []))
    live, _, _ = apply_allowlist(fs, [{"operation": "GET /api/x", "issue": "#1", "reason": "r"}])
    check("operation entry does not prefix-match", len(live), 1)
    # Frozen-snapshot guard: exact-key entries for an operation's existing
    # findings must NOT swallow a new finding under the same operation.
    snap = [{"key": f.key, "issue": "#1", "reason": "r"} for f in fs]
    worse = _spec(props={"id": {"type": "string"}}, required=["id"])  # drops name AND retypes id
    live, _, stale = apply_allowlist(diff_schemas(normalize(base), normalize(worse)), snap)
    check("new finding under allow-listed operation fails", sorted(f.kind for f in live), ["TYPE_CHANGED"])
    check("snapshot entry for fixed finding goes stale", len(stale), 0)
    live, allowed, stale = apply_allowlist(fs, [{"key": "REMOVED_OPERATION GET /gone/", "issue": "#1", "reason": "r"}])
    check("stale allow-list entry reported", (len(live), stale), (1, ["REMOVED_OPERATION GET /gone/"]))
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "a.json"
        p.write_text(json.dumps({"allow": [{"key": "K x", "issue": "soon", "reason": "r"}, {"key": "K y", "issue": "#2"}, {"issue": "#3", "reason": "r"}]}))
        _, errs = load_allowlist(p)
        check("allow-list requires target, issue ref and reason", len(errs), 3)

    # experimental exclusion (#1875)
    exp = [{"path_pattern": "/api/exp/*", "issue": "#1", "reason": "r"}]
    spec = {"paths": {"/api/exp/a/": {"get": {}, "post": {}}, "/api/x/": {"get": {}}}}
    kept, dropped, hit = strip_experimental(spec, exp)
    check("experimental strip keeps others", sorted(kept["paths"]), ["/api/x/"])
    check("experimental strip reports ops", (dropped, hit), (["GET /api/exp/a/", "POST /api/exp/a/"], {0}))
    check("experimental dead entry unmatched", strip_experimental(spec, [dict(exp[0], path_pattern="/nope/*")])[2], set())
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "e.json"
        p.write_text(json.dumps({"experimental": [{"path_pattern": "/a/*", "issue": "soon"}, {"issue": "#2", "reason": "r"}]}))
        _, errs = load_experimental(p)
        check("experimental requires pattern, issue ref and reason", len(errs), 3)

    if failures:
        print("SELF-TEST FAILED:")
        for f in failures:
            print(f"  {f}")
        return 1
    print("self-test OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
