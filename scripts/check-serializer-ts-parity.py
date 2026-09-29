#!/usr/bin/env python3
"""scripts/check-serializer-ts-parity.py — DRF serializer <-> TypeScript interface parity gate (#1079).

`CLAUDE.md` states the rule plainly:

    `Board`, `Card`, `User`, and related interfaces must match the backend
    serializer fields exactly.

RELATIONSHIP TO #821 — READ THIS FIRST
--------------------------------------
Field *names* are already checked. `backend/boards/tests/test_ts_serializer_drift.py`
(#821, shipped in 1.1) walks 14 serializer -> interface pairs and asserts their
read-visible field names match in both directions. It is not superseded by this
gate, and this gate is not superseded by it: #821 reads the serializer *classes*,
so it reaches two pairs (`CardActivity`, `CardAttachment`) that `drf-spectacular`
emits no component for and that therefore cannot be diffed here at all.
(`BoardFull` was a third until #1137 gave `/full/` its own component.)

The reverse asymmetry — this gate checking types on five pairs while #821
name-checked fourteen — was closed by #1139. `COMPONENT_MAP` below now covers
every pair either check can see, so a green run means "the published document
and the interfaces agree", not "five of them do".

What that test cannot see is **types**, and **what the published schema actually
says**. It introspects the serializer classes directly (`instance.fields`), so a
field is "present" as long as the serializer emits it — regardless of what type
`drf-spectacular` ends up publishing for it. That is precisely how eight fields on
`Board` and `CurrentUser` came to be described as `string` while returning ints,
bools and nested objects (#1135), how `BoardFull.members` came to send rows the
`BoardMembership` component forbids (#1137), and how two nullable fields came to be
declared non-nullable (#1138). Every one of those passes #821's name check.

So this gate checks a different surface: the **generated OpenAPI document** — the
artifact an external API consumer actually generates a client from — against the
TypeScript interfaces, including types, nullability and enum membership. The name
checks here are retained rather than delegated to #821 because the two sources can
disagree: a serializer may emit a field that never reaches the schema (an
`@extend_schema` exclusion, a field spectacular cannot introspect), and that is a
real defect this gate catches and #821's cannot.

The failure mode both address is asymmetric and silent: a field added to a
serializer but not to TypeScript is data the frontend cannot see, with no error
anywhere; a field whose type drifts is worse, because both sides keep type-checking
cleanly against their own private idea of the contract. Same declared-vs-actual
shape as the TruePPM M12/M13 findings that motivated #1079 — two representations of
one contract, each internally consistent, with nothing comparing them.

WHY A DIFF GATE AND NOT CODE GENERATION
---------------------------------------
#1079 was originally written as "generate TypeScript types from openapi.json".
Both viable generators failed this project's `dependency` gate:

  - `openapi-typescript` announced end-of-life on 2026-09-19 (upstream issue
    #2874: no further updates, security patches included, no successor named).
  - `@hey-api/openapi-ts` requires Node >= 22.18 (its own `engines.node`, plus
    four transitive deps), which no image in this pipeline provides, and its
    pinned `js-yaml@4.2.0` carries three unfixed CVSS-7.5 advisories.

Comparing the two representations catches the same drift that generating one from
the other would have, needs no npm dependency at all, and runs in the
`python:3.12-slim` image the pipeline already uses. The cost is that the hand-written
interfaces stay hand-written — this gate tells you they drifted, it does not write
them for you.

WHAT IS CHECKED
---------------
For each mapped (schema component, TypeScript interface) pair:

  missing_in_ts      a schema property with no field of that name in TypeScript
  missing_in_schema  a TypeScript field with no property of that name in the schema
  type_family        both sides declare a type, and the families disagree
                     (string / number / boolean / array / object)
  untyped_schema     the schema declares no resolvable type at all for a property
                     (a JSONField or a bare Field reaches the client as `unknown`)
  nullability        one side admits null and the other does not
  enum_members       both sides resolve to a set of string values, and the sets differ

A check is skipped, never guessed, when either side cannot be classified with
confidence — an unresolvable TypeScript alias produces no finding rather than a
false one. Deliberately not an AST parse: field names, one type expression per
field, and rough optionality are all this needs, and a regex extractor keeps the
gate dependency-free.

TYPESCRIPT-ONLY OPTIONAL FIELDS
-------------------------------
One interface often stands in for several serializers of one resource —
`Swimlane` unions the public and admin shapes, `Group` unions list and retrieve
— and `?` is how this codebase spells "present only on some of them". Such a
field is listed in TS_ONLY_FIELDS below with its reason. That is not a
suppression and cites no issue, because nothing is broken; it is the same fact
#821 records in its `extra_allowed_fields_on_ts` column. It is per pair, per
field, conditional on the field still being optional, and self-invalidating —
see `TsOnlyField`.

SUPPRESSIONS
------------
Real, already-tracked drift is recorded in SUPPRESSIONS below, spelled
`SUPPRESSED-UNTIL(#N)` to match the convention in #1092 (MR !903, unmerged at the
time of writing).

These suppressions are **self-invalidating**, which is the important part. Each one
records the exact observation it is masking — the schema type and the TypeScript
type as they are *today*. When reality stops matching that record, the suppression
has done its job and the gate FAILS asking for its removal, naming the issue that
fixed it. So the suppression for a field #1135 corrects disappears the moment #1135
merges, whether or not anyone remembers to come back for it.

That is deliberately not the closed-issue lookup #1092 performs. #1092's checker
scans `frontend/src` and `backend` only (`SCAN_PATHS` in
`scripts/check-suppression-issues.sh`), so a marker in `scripts/` would never be
enforced by it even once !903 lands. Tying staleness to the observed drift instead
of to an issue's state also needs no network and no GitLab token, so it works
offline and in a fork's pipeline.

USAGE
-----
    python3 scripts/check-serializer-ts-parity.py              # generate schema, check
    python3 scripts/check-serializer-ts-parity.py --schema openapi.json
    python3 scripts/check-serializer-ts-parity.py --self-test  # prove the gate still fires

EXIT CODES
----------
    0  parity holds (suppressed findings printed as notes)
    1  drift found, or a suppression went stale
    2  usage or environment error (schema could not be generated, files missing)

Exit 2 is kept distinct from 1 so a broken gate is never mistaken for a clean tree
— the failure mode this gate exists to prevent is a check that silently stops
checking (#1093).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field as dc_field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TYPES_FILE = REPO_ROOT / "frontend" / "src" / "types" / "index.ts"
BACKEND_DIR = REPO_ROOT / "backend"

EXIT_OK = 0
EXIT_DRIFT = 1
EXIT_USAGE = 2

# Schema component -> TypeScript interface. Confirmed against the generated schema:
# there is no `User` component (the /api/v1/auth/me/ shape is `CurrentUser`).
#
# #1137 published `/full/` as its own `BoardFull` component, with `members`
# items as `EffectiveBoardMember` — the effective roster, whose synthesized rows
# carry `id: null` and `role: "site_admin"`. `BoardMembership` stays the strict
# shape of a real membership row (`/members/`), and the TypeScript side mirrors
# the same split, so both pairs are mapped.
#
# #1139 extended this from the five pairs #1079 shipped to every pair #821
# name-checks that `drf-spectacular` actually emits a component for, plus the
# four same-name pairs #821 does not reach at all (`CardRelation`,
# `CustomFieldDefinition`, `CustomFieldValue`, `GroupBrief`, `GroupLabel`). The
# mapping is not keyed on names matching: `CurrentUser`/`User` and
# `CardChecklist`/`CardChecklistItem` are the same resource under two spellings,
# and leaving either out would be a coverage hole the gate's own name check
# cannot see.
#
# `CardActivity`, `CardAttachment`, `Notification`, and `PublicCard` were added
# by #1209, which wired real response schemas for the endpoints backing them
# (CardViewSet.activities/.attachments, NotificationListView, ShareBoardView) —
# before that they either had no schema component at all or resolved to the
# wrong one, so this map could not diff them. `PublicBoard`, the wrapper
# ShareBoardView actually returns, has no TypeScript interface of its own
# (`frontend/src/api/*` has no caller that needs the raw public-board shape as
# distinct from `PublicCard`), so it stays unmapped for the same reason
# `CardQuery` does below.
#
# `CardQuery` (CardQuerySerializer, backing GET /api/v1/cards/, #1112) is also
# absent, for a different reason: the schema HAS a component, but there is no
# TypeScript interface for it, mapped or otherwise. `frontend/src/api/cards.ts`
# has no caller of that endpoint yet, so nothing hand-maintains its response
# shape on the TypeScript side. Mapping it to the closest existing interface,
# `Card`, would not detect real drift: `CardQuery` carries every `Card` field
# plus `board` (cross-board rows must say which board each one is on, per the
# serializer's own docstring), so the pair would report a permanent
# `missing_in_ts: board` finding that is not a bug — the two components
# describe deliberately different response shapes that happen to share most of
# their fields. `TS_ONLY_FIELDS` below covers the opposite asymmetry (a
# TypeScript field two serializers don't all send); there is no equivalent
# allowance for a schema-only field, and adding one for a single unused pair
# is not worth the gate's own complexity. Revisit once a frontend consumer of
# `GET /api/v1/cards/` exists and needs its own interface (#1172).
#
# `ExternalRef` (`ExternalRefSerializer`, the `Card.external_ref` MR/PR link,
# #352) was missing from this map entirely until #1282, even though it is one
# of the fifteen pairs #821's name check reaches — a coverage hole matching
# the same shape #1139 closed for the other name-checked pairs, just missed at
# the time because `ExternalRefSerializer` is a plain `serializers.Serializer`
# nested on `Card`, not a top-level `ModelSerializer`, so it did not show up
# next to the other viewset-backed components when the map was built. The
# schema component is `ExternalRef` (`drf-spectacular` strips `Serializer`
# from the class name); the TypeScript interface is `CardExternalRef` because
# the frontend names it after the field's role on `Card`, not after the
# serializer. Diffing the two once mapped found no drift.
COMPONENT_MAP = {
    "Board": "Board",
    "BoardFull": "BoardFull",
    "BoardMembership": "BoardMembership",
    "BoardUser": "BoardUser",
    "Card": "Card",
    "CardActivity": "CardActivity",
    "CardAttachment": "CardAttachment",
    "CardChecklist": "CardChecklistItem",
    "CardComment": "CardComment",
    "CardMovement": "CardMovement",
    "CardRelation": "CardRelation",
    "Column": "Column",
    "CurrentUser": "User",
    "CustomFieldDefinition": "CustomFieldDefinition",
    "CustomFieldValue": "CustomFieldValue",
    "EffectiveBoardMember": "EffectiveBoardMember",
    "ExternalRef": "CardExternalRef",
    "Group": "Group",
    "GroupBrief": "GroupBrief",
    "GroupLabel": "GroupLabel",
    "Label": "Label",
    "Notification": "Notification",
    "PublicCard": "PublicCard",
    "Swimlane": "Swimlane",
    "SwimlaneCustomFieldDefinition": "SwimlaneCustomFieldDefinition",
}


# ─── findings ────────────────────────────────────────────────────────────────

MISSING_IN_TS = "missing_in_ts"
MISSING_IN_SCHEMA = "missing_in_schema"
TYPE_FAMILY = "type_family"
UNTYPED_SCHEMA = "untyped_schema"
NULLABILITY = "nullability"
ENUM_MEMBERS = "enum_members"


@dataclass(frozen=True)
class Finding:
    kind: str
    component: str
    interface: str
    field: str
    schema_repr: str
    ts_repr: str
    ts_line: int | None = None

    def key(self) -> tuple[str, str, str]:
        """Identity used to match a finding against a suppression."""
        return (self.kind, self.component, self.field)

    def describe(self) -> str:
        loc = f"{_rel(DEFAULT_TYPES_FILE)}:{self.ts_line}" if self.ts_line else _rel(DEFAULT_TYPES_FILE)
        head = f"{self.component}.{self.field}  ({self.interface} in {loc})"
        body = {
            MISSING_IN_TS: f"    serializer sends `{self.field}` ({self.schema_repr}); no such field in `{self.interface}`",
            MISSING_IN_SCHEMA: f"    `{self.interface}.{self.field}` ({self.ts_repr}) has no matching field on the serializer",
            TYPE_FAMILY: f"    schema says {self.schema_repr}; TypeScript says {self.ts_repr}",
            UNTYPED_SCHEMA: f"    schema declares no type at all; TypeScript says {self.ts_repr}",
            NULLABILITY: f"    schema {self.schema_repr}; TypeScript {self.ts_repr}",
            ENUM_MEMBERS: f"    schema allows {self.schema_repr}; TypeScript allows {self.ts_repr}",
        }[self.kind]
        return f"  {head}\n{body}"


def _rel(p: Path) -> str:
    try:
        return str(p.relative_to(REPO_ROOT))
    except ValueError:
        return str(p)


# ─── suppressions ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Suppression:
    """One known, tracked mismatch this gate deliberately does not fail on.

    ``schema_repr``/``ts_repr`` pin the *observation* being suppressed. If either
    side changes, the suppression is stale and the gate fails — see the module
    docstring.
    """

    kind: str
    component: str
    field: str
    schema_repr: str
    ts_repr: str
    issue: int
    reason: str

    def key(self) -> tuple[str, str, str]:
        return (self.kind, self.component, self.field)

    def matches(self, f: Finding) -> bool:
        return f.schema_repr == self.schema_repr and f.ts_repr == self.ts_repr


# Every entry names a specific, already-filed issue. Do not add one without an
# issue, and do not add one for drift you could simply fix. Past entries were all
# cases where the hand-written TypeScript was CORRECT and the schema was wrong —
# fixed in the serializer, never by editing `frontend/src/types/index.ts`.
SUPPRESSIONS: tuple[Suppression, ...] = (
    # Empty: #1135, #1137 and #1138 each fixed the schema rather than suppress it.
)


# ─── TypeScript-only fields ──────────────────────────────────────────────────


@dataclass(frozen=True)
class TsOnlyField:
    """One **optional** TypeScript field that the mapped component may not carry.

    Deliberately not a `Suppression`, and deliberately not citing an issue:
    nothing here is drift, so there is nothing to track and nothing to fix. One
    TypeScript interface stands in for several serializers of the same resource,
    and `?` is how this codebase says "present only on some of them" — the same
    meaning that already exempts an optional field from the nullability check
    above. `Swimlane` unions the public and admin serializers; `Group` unions
    the list and retrieve ones. #821's test models the identical fact with its
    `extra_allowed_fields_on_ts` column, so this mirrors a reviewed convention
    rather than inventing a second one.

    Three properties keep it from becoming an allowlist:

    * It is **per pair and per field**. Nothing is waived wholesale, and
      `missing_in_schema` stays fully live for every other field on the pair.
    * It applies **only when the TypeScript field is optional**. Drop the `?`
      and the finding comes back, because a required field the API never sends
      is a real defect.
    * It is **self-invalidating**, like a suppression. If the component gains
      the property — someone maps the admin serializer, or moves the field onto
      the list serializer — the entry stops matching anything and the gate FAILS
      asking for its removal, rather than sitting here forever describing a
      state of the world that has moved on.
    """

    component: str
    field: str
    reason: str

    def key(self) -> tuple[str, str, str]:
        return (MISSING_IN_SCHEMA, self.component, self.field)


TS_ONLY_FIELDS: tuple[TsOnlyField, ...] = (
    # `Swimlane` is one interface over two serializers: SwimlaneSerializer omits
    # contact_email and notes so a viewer-role member never receives swimlane
    # PII or internal notes, and SwimlaneAdminSerializer adds them back. Only
    # the former reaches the schema, because it is the one the viewset declares.
    TsOnlyField("Swimlane", "contact_email",
                "SwimlaneAdminSerializer only — withheld from viewers as PII"),
    TsOnlyField("Swimlane", "notes",
                "SwimlaneAdminSerializer only — withheld from viewers"),
    # GroupSerializer (list) omits `ancestors` to avoid an N+1 ancestor walk
    # across every group in a list response; GroupDetailSerializer (retrieve)
    # adds it. The schema has both components — this gate maps `Group`, and
    # `GroupDetail` inherits the rest of the shape from it.
    TsOnlyField("Group", "ancestors",
                "GroupDetailSerializer only — omitted from the list serializer to avoid an N+1"),
)


# ─── TypeScript extraction ───────────────────────────────────────────────────


@dataclass
class TsField:
    name: str
    type_text: str
    optional: bool
    line: int


def strip_ts_comments(src: str) -> str:
    """Blank out `//` and `/* */` comments, preserving line structure and offsets.

    Replacing with spaces rather than deleting keeps every byte offset and line
    number identical to the original file, so reported line numbers stay true.
    String literals are respected — a `//` inside `"http://..."` is not a comment,
    and type unions in this file are full of quoted literals.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        ch = src[i]
        if ch in "\"'`":
            quote = ch
            i += 1
            while i < n:
                if src[i] == "\\":
                    i += 2
                    continue
                if src[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if ch == "/" and i + 1 < n and src[i + 1] == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] != "\n":
                    out[i] = " "
                i += 1
            for j in range(i, min(i + 2, n)):
                out[j] = " "
            i += 2
            continue
        i += 1
    return "".join(out)


_INTERFACE_RE = re.compile(r"\bexport\s+interface\s+(\w+)\s*(?:extends\s+[^{]+?)?\{")
_FIELD_RE = re.compile(r"^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*(.+?)\s*$", re.S)


def parse_ts_interfaces(src: str) -> dict[str, dict[str, TsField]]:
    """Extract top-level field name / type / optionality for every exported interface.

    Brace-depth aware, so a nested object literal (`ancestors?: { id: number }[]`)
    contributes one field named `ancestors` rather than leaking `id` into the
    parent interface.
    """
    clean = strip_ts_comments(src)
    result: dict[str, dict[str, TsField]] = {}
    for m in _INTERFACE_RE.finditer(clean):
        name = m.group(1)
        body_start = m.end()
        depth, i, n = 1, body_start, len(clean)
        while i < n and depth:
            if clean[i] == "{":
                depth += 1
            elif clean[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        body = clean[body_start:i]
        result[name] = _parse_interface_body(body, clean.count("\n", 0, body_start) + 1)
    return result


_FIELD_START_RE = re.compile(r"^\s*(?:readonly\s+)?[A-Za-z_$][\w$]*\s*\??\s*:")


def _starts_new_field(body: str, pos: int) -> bool:
    """Does the next non-blank line begin a new field declaration?

    Used as the newline-termination test. Comments are already blanked to
    spaces by `strip_ts_comments`, so a comment-only line reads as blank here.
    """
    n = len(body)
    while pos < n:
        end = body.find("\n", pos)
        if end == -1:
            end = n
        segment = body[pos:end]
        if segment.strip():
            return bool(_FIELD_START_RE.match(segment))
        pos = end + 1
    return False


def _parse_interface_body(body: str, first_line: int) -> dict[str, TsField]:
    """Split an interface body into one chunk per field.

    A field ends at a depth-0 `;`, or at a newline **only when the next non-blank
    line starts another field**. That lookahead is what makes a multi-line union
    survive:

        role:
          | "admin"
          | "viewer";

    Terminating on any bare newline instead would close `role:` as a chunk with
    an empty type, `_parse_field` would reject it, and the field would vanish
    from the gate's view with no warning — the gate would then silently check
    less than it claims to, which is worse than not having it. The codebase's own
    convention for long unions is exactly this leading-pipe style, so this is a
    live hazard rather than a theoretical one.
    """
    fields: dict[str, TsField] = {}
    depth = 0
    chunk: list[str] = []
    line = first_line
    chunk_line = first_line
    prev = ""
    i, n = 0, len(body)

    def flush(at_line: int) -> None:
        text = "".join(chunk)
        if text.strip():
            f = _parse_field(text, at_line)
            if f:
                fields[f.name] = f
        chunk.clear()

    while i < n:
        ch = body[i]
        if ch == "\n":
            line += 1
        depth = _adjust_depth(depth, ch, prev)
        prev = ch
        if depth == 0 and (ch == ";" or (ch == "\n" and _starts_new_field(body, i + 1))):
            flush(chunk_line)
            chunk_line = line
            i += 1
            continue
        chunk.append(ch)
        i += 1
    flush(chunk_line)
    return fields


def _parse_field(text: str, line: int) -> TsField | None:
    m = _FIELD_RE.match(text)
    if not m:
        return None
    name, optional, type_text = m.group(1), bool(m.group(2)), m.group(3)
    # Strip a trailing `,` as well as `;`. A comma-delimited interface is legal
    # TypeScript, and leaving the comma attached makes the type text match no
    # classifier branch, so it falls back to UNKNOWN — which silently switches
    # off the type and enum checks for that field while the name check keeps
    # passing. A weakened check that still reports OK is the failure mode this
    # gate exists to avoid, so normalise rather than rely on house style.
    type_text = " ".join(type_text.split()).rstrip(";,").strip()
    if not type_text:
        return None
    return TsField(name=name, type_text=type_text, optional=optional, line=line)


_TYPE_ALIAS_RE = re.compile(r"\bexport\s+type\s+(\w+)\s*=\s*([^;]+);")


def parse_ts_string_unions(src: str) -> dict[str, frozenset[str]]:
    """Resolve `export type X = "a" | "b"` aliases, including one level of alias reuse.

    One level is enough for this codebase's role unions
    (`BoardOrSiteRole = BoardRole | "site_admin"`) and stops well short of a real
    type resolver — an alias this cannot resolve simply yields no enum check.

    A **leading or trailing pipe** is tolerated, because the house style for a
    long alias is exactly that:

        export type CustomFieldType =
          | "text"
          | "number";

    Splitting that on `|` yields an empty first part, and treating the empty
    string as an alias name to resolve made the whole alias unresolvable.
    Unresolvable then reaches `classify_ts`, which files any capitalised bare
    name under `object` — so a field typed with such an alias was reported as
    `type_family: schema says string; TypeScript says object`, a pure false
    positive, and every *real* enum comparison on that alias was silently
    skipped. `_parse_interface_body` already guards this style for field types
    (see its docstring); the alias parser did not, and five aliases
    (`CustomFieldType`, `CardActivityEventType`, `CardRelationErrorCode`,
    `EmailTestErrorCode`, `PersonalAccessTokenScope`) were affected (#1139).
    """
    clean = strip_ts_comments(src)
    raw = {m.group(1): " ".join(m.group(2).split()) for m in _TYPE_ALIAS_RE.finditer(clean)}
    resolved: dict[str, frozenset[str]] = {}

    def resolve(name: str, seen: frozenset[str]) -> frozenset[str] | None:
        if name in resolved:
            return resolved[name]
        if name not in raw or name in seen:
            return None
        members: set[str] = set()
        for part in raw[name].split("|"):
            part = part.strip()
            if not part:
                # Leading/trailing pipe in the multi-line house style.
                continue
            if len(part) >= 2 and part[0] in "\"'" and part[-1] == part[0]:
                members.add(part[1:-1])
            else:
                sub = resolve(part, seen | {name})
                if sub is None:
                    return None
                members |= sub
        if not members:
            # Not a string union at all (e.g. `export type X = Record<string, y>`).
            # Returning an empty set would compare as an enum of nothing.
            return None
        out = frozenset(members)
        resolved[name] = out
        return out

    for alias in raw:
        resolve(alias, frozenset())
    return resolved


# ─── type classification ─────────────────────────────────────────────────────

UNKNOWN = "unknown"


@dataclass
class TypeInfo:
    family: str = UNKNOWN
    nullable: bool = False
    enum: frozenset[str] | None = None
    repr: str = UNKNOWN


_SCHEMA_FAMILIES = {
    "integer": "number",
    "number": "number",
    "string": "string",
    "boolean": "boolean",
    "array": "array",
    "object": "object",
}


def classify_schema(prop: dict, components: dict) -> TypeInfo:
    # `oneOf` is how drf-spectacular models a choice field that also allows blank:
    # `{"oneOf": [{"$ref": ThemeEnum}, {"$ref": BlankEnum}]}`. Classifying the
    # branches and merging them keeps such a field from looking untyped.
    if isinstance(prop, dict) and isinstance(prop.get("oneOf"), list) and prop["oneOf"]:
        branches = [classify_schema(b, components) for b in prop["oneOf"]]
        families = {b.family for b in branches if b.family != UNKNOWN}
        family = families.pop() if len(families) == 1 else UNKNOWN
        enums = [b.enum for b in branches if b.enum is not None]
        merged = frozenset().union(*enums) if enums else None
        nullable = bool(prop.get("nullable")) or any(b.nullable for b in branches)
        return TypeInfo(family, nullable, _clean_enum(merged), family if family != UNKNOWN else "no type")

    node, nullable = _unwrap_schema(prop, components)
    if node is None:
        return TypeInfo(UNKNOWN, nullable, None, "no type")
    if "$ref" in node:
        return TypeInfo("object", nullable, None, "object")
    enum = _clean_enum(frozenset(node["enum"]) if isinstance(node.get("enum"), list) else None)
    raw = node.get("type")
    if raw is None:
        if "properties" in node:
            return TypeInfo("object", nullable, enum, "object")
        return TypeInfo(UNKNOWN, nullable, enum, "no type")
    family = _SCHEMA_FAMILIES.get(raw, UNKNOWN)
    return TypeInfo(family, nullable, enum, family if family != UNKNOWN else "no type")


def _clean_enum(enum: frozenset[str] | None) -> frozenset[str] | None:
    """Drop the empty-string member drf-spectacular adds for `blank=True`.

    A `CharField(choices=..., blank=True)` gets a `BlankEnum` (`[""]`) branch in
    its schema. That `""` describes what a *write* may contain, not a distinct
    value a read returns, so comparing it against a frontend union would flag
    every blankable choice field in the codebase for no benefit. The enum check
    compares the real choice members only.

    `None` is dropped for the same reason: a nullable choice field gets a
    `NullEnum` (`[null]`) branch, and null-ness is already compared by the
    nullability check (#1137 — `BoardFull.current_user_role` was the first
    mapped field to carry one).
    """
    if enum is None:
        return None
    cleaned = enum - {"", None}
    return cleaned or None


def _unwrap_schema(prop: dict, components: dict, depth: int = 0) -> tuple[dict | None, bool]:
    """Follow `$ref` / `allOf` wrappers to the node that carries the real type.

    drf-spectacular wraps a nullable nested serializer as
    `{"allOf": [{"$ref": ...}], "nullable": true}`, so nullability lives on the
    wrapper while the type lives one level down.
    """
    if depth > 10 or not isinstance(prop, dict):
        return None, False
    nullable = bool(prop.get("nullable"))
    if "allOf" in prop and isinstance(prop["allOf"], list) and len(prop["allOf"]) == 1:
        inner, inner_null = _unwrap_schema(prop["allOf"][0], components, depth + 1)
        return inner, nullable or inner_null
    if "$ref" in prop:
        target = _resolve_ref(prop["$ref"], components)
        if target is None:
            return prop, nullable
        inner, inner_null = _unwrap_schema(target, components, depth + 1)
        return inner, nullable or inner_null
    return prop, nullable


def _resolve_ref(ref: str, components: dict) -> dict | None:
    prefix = "#/components/schemas/"
    if not ref.startswith(prefix):
        return None
    return components.get(ref[len(prefix):])


_TS_PRIMITIVES = {
    "number": "number",
    "string": "string",
    "boolean": "boolean",
}


def classify_ts(type_text: str, unions: dict[str, frozenset[str]]) -> TypeInfo:
    parts = [p.strip() for p in _split_union(type_text)]
    nullable = any(p in ("null", "undefined") for p in parts)
    rest = [p for p in parts if p not in ("null", "undefined")]
    if not rest:
        return TypeInfo(UNKNOWN, nullable, None, UNKNOWN)

    literals = {p[1:-1] for p in rest if len(p) >= 2 and p[0] in "\"'" and p[-1] == p[0]}
    if literals and len(literals) == len(rest):
        return TypeInfo("string", nullable, frozenset(literals), "string")

    if len(rest) == 1:
        one = rest[0]
        if one in unions:
            return TypeInfo("string", nullable, unions[one], "string")
        if one.endswith("[]") or one.startswith("Array<"):
            return TypeInfo("array", nullable, None, "array")
        if one in _TS_PRIMITIVES:
            return TypeInfo(_TS_PRIMITIVES[one], nullable, None, _TS_PRIMITIVES[one])
        if one.startswith("{") or one.startswith("Record<") or one.startswith("Partial<"):
            return TypeInfo("object", nullable, None, "object")
        if re.fullmatch(r"[A-Z]\w*", one):
            # A named interface. Only classify it as an object when we actually
            # saw that interface — an unresolved alias stays UNKNOWN so it
            # produces no finding rather than a wrong one.
            return TypeInfo("object", nullable, None, "object")
        return TypeInfo(UNKNOWN, nullable, None, UNKNOWN)
    return TypeInfo(UNKNOWN, nullable, None, UNKNOWN)


def _adjust_depth(depth: int, ch: str, prev: str) -> int:
    """Bracket-depth step that understands `=>`.

    The `>` of an arrow (`(e: Event) => void`) is not a closing bracket. Counting
    it as one drives the depth negative and makes the splitter stop finding field
    boundaries, silently dropping every field after the first function-typed one
    — a gate that quietly checks less than it claims to. Depth is also clamped at
    zero so any unbalanced token degrades into "split here" rather than
    swallowing the rest of the body.
    """
    if ch in "{([<":
        return depth + 1
    if ch in "})]>":
        if ch == ">" and prev == "=":
            return depth
        return max(0, depth - 1)
    return depth


def _split_union(text: str) -> list[str]:
    parts, depth, cur, prev = [], 0, [], ""
    for ch in text:
        depth = _adjust_depth(depth, ch, prev)
        prev = ch
        if ch == "|" and depth == 0:
            parts.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    parts.append("".join(cur))
    return [p.strip() for p in parts if p.strip()]


# ─── comparison ──────────────────────────────────────────────────────────────


def compare(schema: dict, interfaces: dict[str, dict[str, TsField]], unions: dict[str, frozenset[str]]) -> tuple[list[Finding], list[str]]:
    components = schema.get("components", {}).get("schemas", {})
    findings: list[Finding] = []
    errors: list[str] = []

    for comp_name, iface_name in sorted(COMPONENT_MAP.items()):
        comp = components.get(comp_name)
        if comp is None:
            errors.append(f"schema component `{comp_name}` not found — mapping is stale or the schema is incomplete")
            continue
        iface = interfaces.get(iface_name)
        if iface is None:
            errors.append(f"TypeScript interface `{iface_name}` not found in {_rel(DEFAULT_TYPES_FILE)}")
            continue
        props = comp.get("properties", {})

        for prop_name, prop in sorted(props.items()):
            s = classify_schema(prop, components)
            ts_field = iface.get(prop_name)
            if ts_field is None:
                findings.append(Finding(MISSING_IN_TS, comp_name, iface_name, prop_name, s.repr, "absent"))
                continue
            t = classify_ts(ts_field.type_text, unions)

            if s.family == UNKNOWN and s.enum is None:
                findings.append(Finding(UNTYPED_SCHEMA, comp_name, iface_name, prop_name, "no type", t.repr, ts_field.line))
                continue
            if s.family != UNKNOWN and t.family != UNKNOWN and s.family != t.family:
                findings.append(Finding(TYPE_FAMILY, comp_name, iface_name, prop_name, s.family, t.family, ts_field.line))
                continue
            # Optional TypeScript fields are excluded from the nullability check:
            # `x?: T` already means the value may be absent, which is how this
            # codebase models "only present under some conditions" (e.g. an
            # ?expand= payload). Only a declared `| null` is compared.
            if not ts_field.optional and s.nullable != t.nullable:
                findings.append(Finding(
                    NULLABILITY, comp_name, iface_name, prop_name,
                    "nullable" if s.nullable else "not nullable",
                    "nullable" if t.nullable else "not nullable",
                    ts_field.line,
                ))
                continue
            if s.enum is not None and t.enum is not None and s.enum != t.enum:
                findings.append(Finding(
                    ENUM_MEMBERS, comp_name, iface_name, prop_name,
                    "|".join(sorted(s.enum)), "|".join(sorted(t.enum)), ts_field.line,
                ))

        for ts_name, ts_field in sorted(iface.items()):
            if ts_name not in props:
                t = classify_ts(ts_field.type_text, unions)
                findings.append(Finding(MISSING_IN_SCHEMA, comp_name, iface_name, ts_name, "absent", t.repr, ts_field.line))

    return findings, errors


def apply_ts_only(
    findings: list[Finding],
    interfaces: dict[str, dict[str, TsField]],
    allowances: tuple[TsOnlyField, ...],
) -> tuple[list[Finding], list[TsOnlyField], list[str]]:
    """Drop `missing_in_schema` findings covered by a `TS_ONLY_FIELDS` entry.

    Runs before `apply_suppressions` and on the same shape of contract: an
    allowance that matches nothing is stale and fails the gate. `interfaces` is
    needed because optionality lives on the TypeScript field, not on the
    finding — an allowance for a field someone has since made required does not
    apply, and says so rather than quietly covering it.
    """
    by_key = {f.key(): f for f in findings}
    allowed: list[TsOnlyField] = []
    stale: list[str] = []
    used: set[tuple[str, str, str]] = set()

    for a in allowances:
        f = by_key.get(a.key())
        if f is None:
            stale.append(
                f"  TS-only allowance {a.component}.{a.field}\n"
                f"    recorded: {a.reason}\n"
                f"    but the schema component now carries this property. Delete this entry."
            )
            continue
        ts_field = interfaces.get(f.interface, {}).get(a.field)
        if ts_field is None or not ts_field.optional:
            stale.append(
                f"  TS-only allowance {a.component}.{a.field}\n"
                f"    recorded: {a.reason}\n"
                f"    but `{f.interface}.{a.field}` is no longer optional in TypeScript. A required\n"
                f"    field the API never sends is a real defect — fix it, or restore the `?`."
            )
            continue
        used.add(a.key())
        allowed.append(a)

    live = [f for f in findings if f.key() not in used]
    return live, allowed, stale


def apply_suppressions(findings: list[Finding], suppressions: tuple[Suppression, ...]) -> tuple[list[Finding], list[Suppression], list[str]]:
    """Split findings into live and suppressed, and detect stale suppressions.

    A suppression is stale when the drift it records is gone, or has changed into
    different drift. Either way the recorded observation no longer describes
    reality and a human must look at it — that is what keeps a suppression from
    outliving its reason.
    """
    by_key = {f.key(): f for f in findings}
    live: list[Finding] = []
    suppressed: list[Suppression] = []
    stale: list[str] = []
    used: set[tuple[str, str, str]] = set()

    for s in suppressions:
        f = by_key.get(s.key())
        if f is None:
            stale.append(
                f"  SUPPRESSED-UNTIL(#{s.issue}) {s.component}.{s.field} [{s.kind}]\n"
                f"    recorded: schema={s.schema_repr!r} ts={s.ts_repr!r}\n"
                f"    but this mismatch no longer occurs — the drift was fixed. Delete this suppression."
            )
            continue
        if not s.matches(f):
            stale.append(
                f"  SUPPRESSED-UNTIL(#{s.issue}) {s.component}.{s.field} [{s.kind}]\n"
                f"    recorded: schema={s.schema_repr!r} ts={s.ts_repr!r}\n"
                f"    actual:   schema={f.schema_repr!r} ts={f.ts_repr!r}\n"
                f"    the drift changed shape. Re-check it and update or delete this suppression."
            )
            used.add(s.key())
            continue
        used.add(s.key())
        suppressed.append(s)

    for f in findings:
        if f.key() not in used:
            live.append(f)
    return live, suppressed, stale


# ─── schema loading ──────────────────────────────────────────────────────────


def generate_schema(destination: Path) -> None:
    """Run `manage.py spectacular`, the same way the backend-schema-validate job does."""
    env = dict(os.environ)
    env.setdefault("DJANGO_SETTINGS_MODULE", "visiban.settings")
    subprocess.run(
        [sys.executable, "manage.py", "spectacular", "--format", "openapi-json", "--file", str(destination)],
        cwd=BACKEND_DIR, env=env, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


def load_schema(path: Path | None) -> dict:
    if path is not None:
        return json.loads(path.read_text())
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "openapi.json"
        generate_schema(out)
        return json.loads(out.read_text())


# ─── reporting ───────────────────────────────────────────────────────────────


def report(
    live: list[Finding],
    suppressed: list[Suppression],
    stale: list[str],
    ts_only: list[TsOnlyField] | None = None,
) -> int:
    if ts_only:
        print(f"TypeScript-only optional fields (by design, not failing) — {len(ts_only)}:")
        for a in sorted(ts_only, key=lambda x: (x.component, x.field)):
            print(f"  {a.component}.{a.field} — {a.reason}")
        print()

    if suppressed:
        print(f"Suppressed (tracked, not failing) — {len(suppressed)}:")
        for s in sorted(suppressed, key=lambda x: (x.component, x.field)):
            print(f"  {s.component}.{s.field} [{s.kind}] SUPPRESSED-UNTIL(#{s.issue}) — {s.reason}")
        print()

    if stale:
        print(f"STALE ENTRIES — {len(stale)}:")
        print("The drift these mask is gone or changed. An entry that outlives its")
        print("reason is how a gate goes quietly green, so this is a failure.\n")
        for s in stale:
            print(s)
        print()

    if live:
        print(f"PARITY DRIFT — {len(live)} finding(s):\n")
        for f in sorted(live, key=lambda x: (x.component, x.field, x.kind)):
            print(f.describe())
        print()
        print("Fix the serializer, the TypeScript interface, or the schema annotation so the")
        print("two agree. If the mismatch is real and tracked, add a SUPPRESSED-UNTIL entry")
        print("to SUPPRESSIONS in this script citing the issue.")

    if stale or live:
        return EXIT_DRIFT
    notes = []
    if suppressed:
        notes.append(f"{len(suppressed)} suppressed")
    if ts_only:
        notes.append(f"{len(ts_only)} TypeScript-only")
    print(f"serializer <-> TypeScript parity: OK across {len(COMPONENT_MAP)} pairs"
          + (f" ({', '.join(notes)})" if notes else ""))
    return EXIT_OK


# ─── self-test ───────────────────────────────────────────────────────────────

_SELF_TEST_TS = '''
export type Role = "admin" | "viewer";

/* The multi-line, leading-pipe house style for a long alias. Treating the empty
   first part as an alias name made the whole thing unresolvable, which turned
   every field typed with it into a false `type_family` object finding and
   silently switched off its enum check (#1139). */
export type LeadingPipeRole =
  | "admin"
  | "viewer";

/* Not a string union at all — must resolve to nothing rather than to an empty
   enum, which would compare unequal against every real enum. */
export type NotAUnion = Record<string, number>;

/** A comment containing { braces } and a // slash and a "quote". */
export interface Widget {
  id: number;
  name: string;
  count: number;
  flag: boolean;
  tags: string[];
  nested: { a: number; b: string }[];
  owner: Thing | null;
  role: Role;
  extra_only_in_ts: string;
  optional_only_in_ts?: string;
  untyped: string;
}

/* A function-typed field must not eat the fields after it: the `>` of `=>` is
   not a closing bracket. Regression guard for the silent-field-loss bug. */
export interface Handlers {
  onEvent: (event: Widget) => void;
  after: string;
  cb: (a: number, b: string) => Promise<void>;
  last: number;
}

/* A field whose type is a multi-line union must survive. This is the house
   style for long unions in frontend/src/types/index.ts, and terminating a
   field on any bare newline silently dropped it. */
export interface MultiLine {
  before: string;
  role:
    | "admin"
    | "viewer";
  nested?: {
    id: number;
    name: string;
  }[];
  after: number;
}
'''

_SELF_TEST_SCHEMA = {
    "components": {
        "schemas": {
            "Thing": {"type": "object", "properties": {"id": {"type": "integer"}}},
            "RoleEnum": {"type": "string", "enum": ["admin", "viewer", "owner"]},
            "Widget": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                    "count": {"type": "string"},
                    "flag": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "nested": {"type": "array", "items": {"type": "object"}},
                    "owner": {"allOf": [{"$ref": "#/components/schemas/Thing"}]},
                    "role": {"$ref": "#/components/schemas/RoleEnum"},
                    "untyped": {"description": "a JSONField reaches the client as unknown"},
                    "only_in_schema": {"type": "string"},
                },
            },
        }
    }
}


def self_test() -> int:
    """Prove the detection logic still fires, on a fixture with known drift.

    A gate that has stopped detecting anything looks exactly like a clean tree
    (#1093). This builds a synthetic schema + interface carrying one instance of
    every finding kind, asserts each is found, then asserts a clean pair is
    silent and that the suppression machinery both suppresses and goes stale.
    No network, no database, no dependency on the real repo's contents.
    """
    failures: list[str] = []

    def check(desc: str, ok: bool) -> None:
        if not ok:
            failures.append(desc)

    global COMPONENT_MAP
    original_map = COMPONENT_MAP
    COMPONENT_MAP = {"Widget": "Widget"}
    try:
        interfaces = parse_ts_interfaces(_SELF_TEST_TS)
        unions = parse_ts_string_unions(_SELF_TEST_TS)

        check("parsed the Widget interface", "Widget" in interfaces)
        w = interfaces.get("Widget", {})
        check("nested object literal did not leak its inner fields",
              "a" not in w and "b" not in w and "nested" in w)
        check("comment braces did not corrupt parsing", len(w) == 11)
        check("resolved the Role string union", unions.get("Role") == frozenset({"admin", "viewer"}))

        # A leading-pipe alias must resolve. When it did not, `classify_ts` fell
        # through to its bare-capitalised-name branch and called it an `object`,
        # inventing a type_family finding and dropping the enum check (#1139).
        check("resolved a multi-line leading-pipe alias",
              unions.get("LeadingPipeRole") == frozenset({"admin", "viewer"}))
        check("a leading-pipe alias classifies as a string enum, not an object",
              classify_ts("LeadingPipeRole", unions).family == "string"
              and classify_ts("LeadingPipeRole", unions).enum == frozenset({"admin", "viewer"}))
        check("a non-union alias resolves to nothing rather than an empty enum",
              "NotAUnion" not in unions)

        # A `=>` must not be read as a closing bracket. When it was, every field
        # after the first function-typed one vanished and the gate silently
        # stopped checking them.
        h = interfaces.get("Handlers", {})
        check("a function-typed field does not swallow the fields after it",
              list(h) == ["onEvent", "after", "cb", "last"])
        check("a parenthesised function type in a union splits correctly",
              _split_union("((x: number) => void) | null") == ["((x: number) => void)", "null"])

        # A multi-line union on a field must not be dropped. When it was, the
        # gate silently stopped checking that field entirely — and if the field
        # was TypeScript-only, produced no finding at all.
        ml = interfaces.get("MultiLine", {})
        check("a multi-line union field survives parsing",
              list(ml) == ["before", "role", "nested", "after"])
        check("a multi-line union field keeps its whole type",
              classify_ts(ml["role"].type_text, {}).enum == frozenset({"admin", "viewer"}))
        check("a multi-line nested object literal stays one field",
              "id" not in ml and "name" not in ml
              and classify_ts(ml["nested"].type_text, {}).family == "array")

        # Comma-delimited fields are legal TypeScript. Leaving the comma on the
        # type text made every classifier branch miss, silently disabling the
        # type and enum checks while the name check still passed.
        comma = parse_ts_interfaces("export interface C {\n  count: number,\n  name: string,\n}\n").get("C", {})
        check("comma-delimited fields still classify",
              classify_ts(comma["count"].type_text, {}).family == "number"
              and classify_ts(comma["name"].type_text, {}).family == "string")

        findings, errors = compare(_SELF_TEST_SCHEMA, interfaces, unions)
        check("no structural errors on the fixture", not errors)
        kinds = {(f.kind, f.field) for f in findings}

        check("detects a numeric field typed string in the schema", (TYPE_FAMILY, "count") in kinds)
        check("detects a boolean field typed string in the schema", (TYPE_FAMILY, "flag") in kinds)
        check("detects a schema property absent from TypeScript", (MISSING_IN_TS, "only_in_schema") in kinds)
        check("detects a TypeScript field absent from the schema", (MISSING_IN_SCHEMA, "extra_only_in_ts") in kinds)
        check("detects an untyped schema property", (UNTYPED_SCHEMA, "untyped") in kinds)
        check("detects a nullability mismatch", (NULLABILITY, "owner") in kinds)
        check("detects an enum membership mismatch", (ENUM_MEMBERS, "role") in kinds)
        check("does not flag matching fields", not any(f.field in ("id", "name", "tags") for f in findings))

        # A suppression matching a real finding silences exactly that finding.
        count_finding = next((f for f in findings if f.key() == (TYPE_FAMILY, "Widget", "count")), None)
        check("found the count finding to suppress", count_finding is not None)
        if count_finding:
            sup = Suppression(TYPE_FAMILY, "Widget", "count", count_finding.schema_repr,
                              count_finding.ts_repr, 1, "fixture")
            live, suppressed, stale = apply_suppressions(findings, (sup,))
            check("suppression removes its finding from the live set",
                  all(f.key() != sup.key() for f in live))
            check("suppression is reported as suppressed", len(suppressed) == 1)
            check("a matching suppression is not stale", not stale)

            # The self-invalidating property: same field, but the recorded
            # observation no longer matches reality.
            moved = Suppression(TYPE_FAMILY, "Widget", "count", "boolean", count_finding.ts_repr, 1, "fixture")
            _, _, stale2 = apply_suppressions(findings, (moved,))
            check("a suppression whose recorded drift changed is stale", len(stale2) == 1)

        # A suppression for drift that no longer exists at all is stale.
        gone = Suppression(TYPE_FAMILY, "Widget", "id", "string", "number", 1, "fixture")
        _, _, stale3 = apply_suppressions(findings, (gone,))
        check("a suppression for vanished drift is stale", len(stale3) == 1)

        # ── TS-only allowances ────────────────────────────────────────────
        # An optional TypeScript field absent from the component is covered.
        check("an optional TS-only field is reported before any allowance applies",
              (MISSING_IN_SCHEMA, "optional_only_in_ts") in kinds)
        opt_allow = TsOnlyField("Widget", "optional_only_in_ts", "fixture")
        live_a, allowed_a, stale_a = apply_ts_only(findings, interfaces, (opt_allow,))
        check("an allowance removes its finding from the live set",
              all(f.key() != opt_allow.key() for f in live_a))
        check("an allowance is reported as allowed", len(allowed_a) == 1)
        check("a matching allowance is not stale", not stale_a)
        check("an allowance does not touch the other pair's findings",
              any(f.key() == (MISSING_IN_SCHEMA, "Widget", "extra_only_in_ts") for f in live_a))

        # An allowance for a REQUIRED field does not apply — that is real drift.
        req_allow = TsOnlyField("Widget", "extra_only_in_ts", "fixture")
        live_b, allowed_b, stale_b = apply_ts_only(findings, interfaces, (req_allow,))
        check("an allowance for a required TS field is stale, not honored",
              not allowed_b and len(stale_b) == 1)
        check("the required field's finding survives the rejected allowance",
              any(f.key() == req_allow.key() for f in live_b))

        # An allowance for a field the component now carries is stale.
        served = TsOnlyField("Widget", "name", "fixture")
        _, allowed_c, stale_c = apply_ts_only(findings, interfaces, (served,))
        check("an allowance for a property the schema now has is stale",
              not allowed_c and len(stale_c) == 1)

        # A clean pair produces nothing.
        clean_schema = {"components": {"schemas": {"Widget": {"properties": {"id": {"type": "integer"}}}}}}
        clean_ts = parse_ts_interfaces("export interface Widget {\n  id: number;\n}\n")
        clean_findings, clean_errors = compare(clean_schema, clean_ts, {})
        check("a matching schema/interface pair yields no findings", not clean_findings and not clean_errors)

        # A missing component is an error, not a silent pass.
        _, missing_errors = compare({"components": {"schemas": {}}}, clean_ts, {})
        check("a missing schema component is reported as an error", len(missing_errors) == 1)
    finally:
        COMPONENT_MAP = original_map

    if failures:
        print(f"=== self-test: FAILED ({len(failures)} assertion(s)) ===")
        for f in failures:
            print(f"  - {f}")
        # EXIT_USAGE, not EXIT_DRIFT: a failed self-test means the gate itself is
        # broken, which is the "could not run" case, not "found drift".
        return EXIT_USAGE
    print("=== self-test: PASSED ===")
    return EXIT_OK


# ─── entry point ─────────────────────────────────────────────────────────────


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Check DRF serializer <-> TypeScript interface parity (#1079).",
    )
    parser.add_argument("--schema", type=Path, default=None,
                        help="Pre-generated OpenAPI JSON. Default: generate it with manage.py spectacular.")
    parser.add_argument("--types", type=Path, default=DEFAULT_TYPES_FILE,
                        help=f"TypeScript types file. Default: {_rel(DEFAULT_TYPES_FILE)}")
    parser.add_argument("--self-test", action="store_true",
                        help="Run the offline self-test proving the gate still fires, then exit.")
    parser.add_argument("--no-suppressions", action="store_true",
                        help="Report every mismatch, including tracked ones. Strictly stricter "
                             "than a normal run — it can only add findings, never hide them. "
                             "Use it to audit what is currently suppressed.")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()

    if not args.types.is_file():
        print(f"error: TypeScript types file not found: {args.types}", file=sys.stderr)
        return EXIT_USAGE
    if args.schema is not None and not args.schema.is_file():
        print(f"error: schema file not found: {args.schema}", file=sys.stderr)
        return EXIT_USAGE

    try:
        schema = load_schema(args.schema)
    except subprocess.CalledProcessError as exc:
        print("error: could not generate the OpenAPI schema.", file=sys.stderr)
        if exc.stderr:
            print(exc.stderr.decode(errors="replace").strip(), file=sys.stderr)
        return EXIT_USAGE
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: could not read the OpenAPI schema: {exc}", file=sys.stderr)
        return EXIT_USAGE

    src = args.types.read_text()
    interfaces = parse_ts_interfaces(src)
    unions = parse_ts_string_unions(src)

    findings, errors = compare(schema, interfaces, unions)
    if errors:
        print("error: the gate could not run its full comparison:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return EXIT_USAGE

    # `--no-suppressions` waives the TS-only allowances too: it is documented as
    # "report every mismatch, including tracked ones", and an audit that still
    # hid three of them would not be the stricter run it claims to be.
    if args.no_suppressions:
        live, allowed, stale = findings, [], []
    else:
        live, allowed, stale = apply_ts_only(findings, interfaces, TS_ONLY_FIELDS)
    active = () if args.no_suppressions else SUPPRESSIONS
    live, suppressed, sup_stale = apply_suppressions(live, active)
    return report(live, suppressed, stale + sup_stale, allowed)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
