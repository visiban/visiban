"""Card-detail extension sections (#2212): call, validate and isolate.

The one place that runs ``CARD_DETAIL_EXTENSIONS`` entries. They are reached
only through ``boards.permissions.card_detail_extensions_for_role`` (Security
Invariants Rule 12), so an extension above the caller's role is never called.

Read-only in v1. OSS validates every section against a closed shape before
it leaves the server: an extension's output is untrusted (it renders inside
the card dialog), so a section that fails any check is dropped whole, never
truncated, and the client validates the same shape again.
"""

import datetime
import json
import logging
import math
import re
import unicodedata

from rest_framework.renderers import JSONRenderer

from ..permissions import card_detail_extensions_for_role

logger = logging.getLogger(__name__)

#: Caps shared with ``frontend/src/components/Card/parseCardExtensionSections.ts``.
MAX_SECTIONS = 10
MAX_FIELDS = 30
MAX_TITLE = 120
MAX_LABEL = 80
MAX_TEXT_VALUE = 500
MAX_DISPLAY = 200
MAX_CHOICES = 50
MAX_CHOICE = 80
FIELD_TYPES = ("text", "number", "date", "choice")

_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class _Invalid(Exception):
    """A section failed validation; carries an OSS reason code, never content."""


def _has_control(value, allow_newlines=False):
    """True if *value* holds a control (Cc), format/bidi (Cf) or surrogate (Cs) char."""
    for ch in value:
        if allow_newlines and ch in "\n\t":
            continue
        if unicodedata.category(ch) in ("Cc", "Cf", "Cs"):
            return True
    return False


def _label(value, cap, code):
    if not isinstance(value, str):
        raise _Invalid(code)
    value = value.strip()
    if not value or len(value) > cap or _has_control(value):
        raise _Invalid(code)
    return value


def _clean_value(ftype, value, choices):
    if value is None or value == "":
        return None
    if ftype == "text":
        if not isinstance(value, str) or len(value) > MAX_TEXT_VALUE or _has_control(value, True):
            raise _Invalid("text_value")
        return value
    if ftype == "number":
        # bool is an int subclass: True must not render as 1.
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise _Invalid("number_value")
        return value
    if ftype == "date":
        if not isinstance(value, str) or not _DATE_RE.match(value):
            raise _Invalid("date_value")
        try:
            datetime.date.fromisoformat(value)
        except ValueError as exc:
            raise _Invalid("date_value") from exc
        return value
    # choice
    if not isinstance(value, str) or value not in choices:
        raise _Invalid("choice_value")
    return value


def _clean_field(raw):
    if not isinstance(raw, dict):
        raise _Invalid("field_shape")
    key = raw.get("key")
    if not isinstance(key, str) or not _KEY_RE.match(key):
        raise _Invalid("field_key")
    ftype = raw.get("type")
    if ftype not in FIELD_TYPES:
        raise _Invalid("field_type")
    out = {"key": key, "label": _label(raw.get("label"), MAX_LABEL, "field_label"), "type": ftype}
    choices = []
    if ftype == "choice":
        raw_choices = raw.get("choices")
        if not isinstance(raw_choices, (list, tuple)) or len(raw_choices) > MAX_CHOICES:
            raise _Invalid("choices")
        choices = [_label(c, MAX_CHOICE, "choices") for c in raw_choices]
        out["choices"] = choices
    out["value"] = _clean_value(ftype, raw.get("value"), choices)
    display = raw.get("display")
    if display not in (None, ""):
        out["display"] = _label(display, MAX_DISPLAY, "display")
    return out


def _clean_section(ext_id, raw):
    if not isinstance(raw, dict):
        raise _Invalid("section_shape")
    fields = raw.get("fields")
    if not isinstance(fields, (list, tuple)) or len(fields) > MAX_FIELDS:
        raise _Invalid("fields")
    clean = [_clean_field(f) for f in fields]
    if len({f["key"] for f in clean}) != len(clean):
        raise _Invalid("duplicate_key")
    if not clean:
        raise _Invalid("no_fields")
    section = {"id": ext_id, "title": _label(raw.get("title"), MAX_TITLE, "title"), "fields": clean}
    # Same round-trip as the analytics summary: DRF's own renderer, so a NaN or
    # a lone surrogate fails here rather than in the response renderer.
    return json.loads(JSONRenderer().render(section))


def _ext_name(ext):
    cls = type(ext)
    return f"{cls.__module__}.{cls.__qualname__}"


def sections_for_card(card, user, role):
    """The validated extension sections *user* (holding *role*) may see on *card*.

    **Absent input fails closed** (#1075): a ``None`` card or user, or a role
    outside the ladder, returns ``[]`` and calls no extension.
    """
    if card is None or user is None or not getattr(user, "is_authenticated", False):
        return []
    sections = []
    seen_ids = set()
    called = 0
    for ext in card_detail_extensions_for_role(role):
        if called >= MAX_SECTIONS:
            break
        try:
            ext_id = getattr(ext, "id", None)
            if not isinstance(ext_id, str) or not _ID_RE.match(ext_id):
                raise _Invalid("ext_id")
            if ext_id in seen_ids:
                raise _Invalid("duplicate_id")
            seen_ids.add(ext_id)
            called += 1
            raw = ext.section(card, user, role)
            if raw is None:
                continue
            sections.append(_clean_section(ext_id, raw))
        except Exception as exc:
            reason = exc.args[0] if isinstance(exc, _Invalid) and exc.args else type(exc).__name__
            # Name and reason only: never values, labels, titles or exception text.
            logger.warning("CARD_DETAIL_EXTENSIONS %s dropped (%s)", _ext_name(ext), reason)
    return sections
