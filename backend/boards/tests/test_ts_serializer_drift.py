"""Detect drift between DRF serializers and TypeScript interfaces (#821).

The frontend consumes JSON shaped by DRF serializers. Drift accumulates
silently because TypeScript never validates JSON at runtime: a renamed or
removed serializer field only manifests as a runtime ``undefined`` in the
browser, often weeks later. This test walks a registry of
``serializer -> TS interface`` pairs and asserts the read-visible fields
match on both sides.

Only read-visible fields participate in the check:

* ``write_only=True`` serializer fields are excluded (they never appear in a
  response payload).
* Interface fields declared optional in TypeScript (``name?:`` or any type
  that includes ``undefined``) are treated as tolerated — they may be
  absent from the serializer without failing the check. This covers
  intentional client-side widening (e.g. ``BoardMembership.id: number |
  null`` to accommodate synthesized inherited-member rows, or
  ``Swimlane.contact_email?`` which straddles Public/Admin serializers).

Whenever a new serializer + TS interface pair ships, add it to
``_DRIFT_PAIRS`` below so the check runs against it on every CI pipeline.
"""

from __future__ import annotations

import re
from pathlib import Path

from django.test import SimpleTestCase

from boards.serializers import (
    BoardFullSerializer,
    BoardMembershipSerializer,
    BoardSerializer,
    CardActivitySerializer,
    CardAttachmentSerializer,
    CardChecklistSerializer,
    CardCommentSerializer,
    CardMovementSerializer,
    CardSerializer,
    ColumnSerializer,
    LabelSerializer,
    SwimlaneAdminSerializer,
    SwimlaneSerializer,
)
from accounts.serializers import BoardUserSerializer


_FRONTEND_TYPES = (
    Path(__file__).resolve().parents[3] / "frontend" / "src" / "types" / "index.ts"
)


# (serializer_class, ts_interface_name, extra_allowed_fields_on_ts)
# ``extra_allowed_fields_on_ts`` lists TS-only fields that are intentionally
# present despite no matching serializer field — usually because they are
# union widenings that cover a synthesized/polymorphic case. Adding a field
# here is a deliberate choice, not a silent allowance: document why inline.
_DRIFT_PAIRS: list[tuple[type, str, set[str]]] = [
    (BoardSerializer, "Board", set()),
    (BoardFullSerializer, "BoardFull", set()),
    (CardSerializer, "Card", set()),
    (ColumnSerializer, "Column", set()),
    # Swimlane TS interface unions the Public and Admin shapes; contact_email
    # and notes are only on SwimlaneAdminSerializer but legitimately appear
    # on the TS side as optional.
    (SwimlaneSerializer, "Swimlane", {"contact_email", "notes"}),
    (SwimlaneAdminSerializer, "Swimlane", set()),
    (LabelSerializer, "Label", set()),
    (CardMovementSerializer, "CardMovement", set()),
    (CardCommentSerializer, "CardComment", set()),
    (CardActivitySerializer, "CardActivity", set()),
    (CardChecklistSerializer, "CardChecklistItem", set()),
    (CardAttachmentSerializer, "CardAttachment", set()),
    (BoardMembershipSerializer, "BoardMembership", set()),
    (BoardUserSerializer, "BoardUser", set()),
]


def _serializer_read_fields(serializer_class: type) -> set[str]:
    """Return the names of fields this serializer emits in a response.

    Uses DRF's instantiated ``fields`` dict rather than ``Meta.fields`` so
    declared-but-inherited fields, SerializerMethodFields, and ``source=``
    overrides are all included, and ``write_only=True`` fields are excluded.
    """
    instance = serializer_class()
    return {
        name for name, field in instance.fields.items() if not field.write_only
    }


_INTERFACE_HEADER_RE = re.compile(
    r"export\s+interface\s+(\w+)\s*(?:extends[^\{]+)?\{"
)
# Matches a field declaration: optional-leading-whitespace then identifier
# then optional ``?`` then ``:``. Applied per-declaration (we split the
# nested-brace-stripped body on top-level semicolons first) so leading
# anchors are not needed.
_FIELD_RE = re.compile(r"^\s*(\w+)(\??)\s*:\s*(.*)$", re.DOTALL)


def _extract_interface_body(source: str, start: int) -> tuple[str, int] | None:
    """Return the interface body starting at ``source[start]`` (first ``{``).

    Scans forward with a brace-depth counter so nested object types
    (``capabilities: { movement_export: boolean }``) do not terminate the
    interface body prematurely — a bug an ``[^}]*`` regex cannot fix.
    """
    assert source[start] == "{"
    depth = 0
    i = start
    while i < len(source):
        ch = source[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return source[start + 1: i], i + 1
        i += 1
    return None


def _strip_comments(body: str) -> str:
    """Strip ``// line`` and ``/* block */`` comments from a TS snippet.

    Must run before semicolon-splitting because line comments can contain
    ``;`` characters (e.g. prose) that would otherwise fragment a single
    declaration into two chunks and confuse the field matcher.
    """
    # Block comments: ``/* ... */`` including multi-line JSDoc ``/** ... */``.
    body = re.sub(r"/\*.*?\*/", "", body, flags=re.DOTALL)
    # Line comments: ``// ...`` to end-of-line.
    body = re.sub(r"//[^\n]*", "", body)
    return body


def _strip_nested_braces(body: str) -> str:
    """Replace nested ``{...}`` groups with an opaque placeholder.

    Field-level regex then only sees the top-level shape, so object types
    embedded in a field's annotation (``capabilities: { ... }``) do not
    themselves get parsed as field declarations.
    """
    out: list[str] = []
    depth = 0
    for ch in body:
        if ch == "{":
            if depth == 0:
                out.append(" ")
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            continue
        if depth == 0:
            out.append(ch)
    return "".join(out)


def _parse_interfaces(source: str) -> dict[str, tuple[set[str], set[str]]]:
    """Parse ``export interface`` blocks into ``{name: (all, optional)}``.

    A field is "optional" when the TS declaration uses ``name?:`` syntax or
    when the type annotation includes ``undefined``. Optional fields are
    tolerated if the serializer does not emit them — we only warn on missing
    *required* TS fields or on serializer fields absent from TS entirely.
    """
    interfaces: dict[str, tuple[set[str], set[str]]] = {}
    for match in _INTERFACE_HEADER_RE.finditer(source):
        name = match.group(1)
        brace_pos = match.end() - 1
        extracted = _extract_interface_body(source, brace_pos)
        if extracted is None:
            continue
        raw_body, _ = extracted
        # Order matters: strip comments first (they can contain semicolons
        # and braces that would confuse the later passes), then flatten
        # nested object types, then split declarations on semicolons.
        body = _strip_nested_braces(_strip_comments(raw_body))
        all_fields: set[str] = set()
        optional: set[str] = set()
        for chunk in body.split(";"):
            chunk = chunk.strip()
            if not chunk:
                continue
            m = _FIELD_RE.match(chunk)
            if m is None:
                continue
            field_name = m.group(1)
            is_optional_marker = m.group(2) == "?"
            type_slice = m.group(3)
            all_fields.add(field_name)
            if is_optional_marker or "undefined" in type_slice:
                optional.add(field_name)
        interfaces[name] = (all_fields, optional)
    return interfaces


class TypeScriptSerializerDriftTests(SimpleTestCase):
    """Fails when TS interfaces and DRF serializers drift apart."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._interfaces = _parse_interfaces(_FRONTEND_TYPES.read_text())

    def _get_interface(self, ts_name: str) -> tuple[set[str], set[str]]:
        self.assertIn(
            ts_name,
            self._interfaces,
            f"TypeScript interface `{ts_name}` not found in "
            f"{_FRONTEND_TYPES.relative_to(_FRONTEND_TYPES.parents[3])}.",
        )
        return self._interfaces[ts_name]

    def test_pair_coverage_is_registered(self):
        """Every pair in _DRIFT_PAIRS must resolve to a real TS interface.

        Catches typos in the registry before they silently short-circuit the
        drift check on real pairs.
        """
        for serializer_class, ts_name, _extra in _DRIFT_PAIRS:
            with self.subTest(serializer=serializer_class.__name__, interface=ts_name):
                self._get_interface(ts_name)

    def test_no_drift_between_serializers_and_ts_interfaces(self):
        """Serializer response fields must match the TS interface's required fields."""
        failures: list[str] = []
        for serializer_class, ts_name, extra_allowed in _DRIFT_PAIRS:
            backend_fields = _serializer_read_fields(serializer_class)
            ts_all, ts_optional = self._get_interface(ts_name)
            ts_required = ts_all - ts_optional

            # Required TS fields the backend does not emit — either a frontend
            # typo or a serializer field was removed without updating TS.
            missing_from_backend = ts_required - backend_fields - extra_allowed
            # Serializer fields not declared in TS at all — TS did not keep up
            # with a newly added serializer field.
            missing_from_ts = backend_fields - ts_all

            if missing_from_backend:
                failures.append(
                    f"  {serializer_class.__name__} → interface {ts_name}: "
                    f"TS declares required field(s) not emitted by serializer: "
                    f"{sorted(missing_from_backend)}"
                )
            if missing_from_ts:
                failures.append(
                    f"  {serializer_class.__name__} → interface {ts_name}: "
                    f"serializer emits field(s) missing from TS interface: "
                    f"{sorted(missing_from_ts)}"
                )

        if failures:
            msg = (
                "TypeScript ↔ DRF serializer drift detected (#821). "
                "Fix by either updating frontend/src/types/index.ts or the "
                "serializer Meta.fields, then rerun this test.\n\n"
                + "\n".join(failures)
            )
            self.fail(msg)


class DriftParserSelfTests(SimpleTestCase):
    """Confirms the parser and diff logic actually detect drift.

    A drift check that silently degrades is worse than no check at all:
    guard the parser against regressions by feeding it known-drifted input
    and asserting the check flags the expected mismatch.
    """

    def test_parser_handles_nested_braces(self):
        """Nested object types must not truncate the containing interface."""
        src = """
        export interface X {
          a: number;
          nested: { inner: boolean };
          z: string;
        }
        """
        parsed = _parse_interfaces(src)
        self.assertEqual(parsed["X"][0], {"a", "nested", "z"})

    def test_parser_marks_optional_question_mark(self):
        src = "export interface X { a: number; b?: string; }"
        all_fields, optional = _parse_interfaces(src)["X"]
        self.assertEqual(all_fields, {"a", "b"})
        self.assertEqual(optional, {"b"})

    def test_parser_marks_undefined_union_as_optional(self):
        """A field widened to ``T | undefined`` is tolerated like ``name?:``."""
        src = "export interface X { a: number | undefined; b: string; }"
        _all, optional = _parse_interfaces(src)["X"]
        self.assertEqual(optional, {"a"})

    def test_parser_handles_jsdoc_block_comments_before_fields(self):
        """A JSDoc block comment must not swallow the field that follows.

        Regression guard: an earlier implementation left ``/** ... */`` in
        place and the field-regex then tried to match the comment text as
        an identifier, dropping the real field from the interface.
        """
        src = (
            "export interface X {\n"
            "  /** some doc */\n"
            "  uid: string;\n"
            "  b: number;\n"
            "}"
        )
        all_fields, _ = _parse_interfaces(src)["X"]
        self.assertEqual(all_fields, {"uid", "b"})

    def test_parser_handles_semicolon_in_line_comment(self):
        """A ``;`` character inside a ``// ...`` comment must not fragment a field.

        Regression guard: splitting on ``;`` before stripping line comments
        produced two half-declaration chunks and then silently dropped the
        real field (seen with ``BoardUser.avatar_url`` whose doc comment
        contains ``blank=True; null will never``).
        """
        src = (
            "export interface X {\n"
            "  // note: this mentions ;semicolon inside a comment\n"
            "  avatar_url: string;\n"
            "}"
        )
        all_fields, _ = _parse_interfaces(src)["X"]
        self.assertEqual(all_fields, {"avatar_url"})

    def test_detects_field_missing_from_ts(self):
        """When the serializer emits a field absent from TS, the diff must flag it."""
        backend = {"id", "name", "new_field"}
        ts_all = {"id", "name"}
        missing_from_ts = backend - ts_all
        self.assertEqual(missing_from_ts, {"new_field"})

    def test_detects_required_ts_field_missing_from_backend(self):
        """Required TS fields the backend does not emit must be flagged."""
        backend = {"id", "name"}
        ts_required = {"id", "name", "ghost"}
        missing_from_backend = ts_required - backend
        self.assertEqual(missing_from_backend, {"ghost"})
