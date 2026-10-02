"""Type-level facts about custom field values shared by every layer (#1391).

The serializer validates multi-select values, the CSV export formats them, and
the service diffs them. All three must agree on one encoding, so the encoding
lives here once rather than being re-derived in each place.

Kept free of DRF and of any model import beyond the enum so that the export
view, the serializers and the services can all import it without a cycle.

**The multi-select storage format.** A ``multi_select`` value is stored in the
same text column as every other type, as a *canonical* JSON array string:

* compact separators (``["a","b"]``, no spaces), ``ensure_ascii=False``;
* deduplicated;
* entries that are still choices first, in ``choices_json`` order, then any
  orphaned entries (a choice since renamed or removed) in their stored order;
* the empty set is never stored — it is ``""``, which the service turns into
  "delete the row", the same "unset" representation as every other type.

Canonical, not merely valid, because ``services.custom_fields._apply_values``
diffs by string equality: two encodings of the same set would read as a change
and fire ``custom_field_value_changed`` for an edit nobody made.
"""

import json

from .models import CustomFieldDefinition

T = CustomFieldDefinition.FieldType

#: Types whose definition carries ``choices_json``. Both definition serializers
#: read this rather than naming the types inline, so a later choice-bearing type
#: is one edit, not two copies to keep in step.
CHOICE_TYPES = frozenset({T.DROPDOWN, T.MULTI_SELECT})

#: The closed palette a choice may be colored from (#1391), as *keys* — never
#: hex. The frontend owns how each key renders (a ``{light, dark}`` fg/bg pair
#: with a recorded contrast ratio), so the server stores only which key was
#: picked and a theme or contrast change never needs a data migration.
#:
#: Mirrored exactly, in this order, by ``CHOICE_COLOR_KEYS`` in
#: ``frontend/src/constants/choiceColors.ts``.
#: ``boards/tests/test_custom_fields.py::ChoiceColorKeyParityTests`` reads that
#: file and fails on any drift, so adding a key means editing both files (and
#: recording the new key's contrast ratio — see frontend/CLAUDE.md).
CHOICE_COLOR_KEYS = (
    "slate", "blue", "green", "amber", "red", "violet", "pink", "teal",
)


def parse_multi_select(value):
    """Return the entries of a stored multi-select value as a list of strings.

    Tolerant by design: anything that is not a JSON array of strings — ``""``,
    malformed JSON, a scalar, mixed members — yields ``[]`` (or drops the
    non-string members) rather than raising. This runs on the read side
    (export, the orphan check on write), where a bad stored row must not turn a
    read into a 500. Type changes are blocked once values exist, so a non-JSON
    row is not expected; this is defense, not a migration path.
    """
    if not value:
        return []
    # A stored value is capped at 500 characters, so anything far longer was
    # not written by this code; refuse to parse it rather than spend time on it.
    if not isinstance(value, str) or len(value) > CustomFieldDefinition.MAX_VALUE_LENGTH * 4:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, RecursionError):
        return []
    if not isinstance(parsed, list):
        return []
    return [entry for entry in parsed if isinstance(entry, str)]


def canonical_multi_select(entries, choices):
    """Return *entries* deduplicated and in canonical order (see module docs)."""
    wanted = list(dict.fromkeys(entries))
    wanted_set = set(wanted)
    ordered = [choice for choice in (choices or []) if choice in wanted_set]
    in_choices = set(ordered)
    ordered.extend(entry for entry in wanted if entry not in in_choices)
    return ordered


def encode_multi_select(entries):
    """Encode already-canonical *entries*; ``""`` for the empty set."""
    if not entries:
        return ""
    return json.dumps(entries, separators=(",", ":"), ensure_ascii=False)
