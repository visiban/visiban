# #2218: rewrite date and number custom-field values stored before the write
# path canonicalized them. Data only (RunPython, reverse a no-op), no schema
# operation, so it is safe under a rolling deploy: every value it writes is
# one the previous release already accepted and reads, and the previous
# release keeps working against the rewritten rows.

import decimal

from django.db import migrations
from django.utils.dateparse import parse_date

BATCH_SIZE = 500

# Rows already in canonical form are not read at all.
_CANONICAL_DATE = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
# A number is left as typed when it is plain ASCII without "_".
_NON_PLAIN_NUMBER = r"[^0-9eE+.-]"


def canonical_date(text):
    """Inlined copy of the date rule in ``_normalize_custom_field_value`` (#2218).

    ``None`` for a value the write path would reject now; such a row is left
    as stored rather than guessed at.
    """
    try:
        parsed = parse_date(text.strip())
    except ValueError:
        return None
    return parsed.isoformat() if parsed is not None else None


def canonical_number(text):
    """Inlined copy of ``boards.serializers.canonical_number_text`` (#2218).

    A migration must not import app code that may change later;
    ``boards/tests/test_custom_field_canonical_2218.py`` keeps the two in step.
    """
    text = text.strip()
    try:
        parsed = decimal.Decimal(text)
    except (decimal.InvalidOperation, ValueError):
        return None
    if not parsed.is_finite():
        return None
    if text.isascii() and "_" not in text:
        return text
    return str(parsed)


def _rewrite(model, field_type, candidates, canonical):
    pending = (
        model.objects.filter(field_definition__field_type=field_type)
        .filter(candidates)
        .values_list("pk", "value")
        .order_by("pk")
    )
    for pk, value in pending.iterator(chunk_size=BATCH_SIZE):
        new = canonical(value)
        if new is None or new == value:
            continue
        # Conditional on the value read: a write that landed meanwhile keeps
        # what its writer set, and a re-run changes nothing.
        model.objects.filter(pk=pk, value=value).update(value=new)


def canonicalize_values(apps, schema_editor):
    from django.db.models import Q

    for name in ("CustomFieldValue", "SwimlaneCustomFieldValue"):
        model = apps.get_model("boards", name)
        _rewrite(model, "date", ~Q(value__regex=_CANONICAL_DATE), canonical_date)
        _rewrite(model, "number", Q(value__regex=_NON_PLAIN_NUMBER), canonical_number)


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0101_custom_field_thresholds"),
    ]

    operations = [
        # Reverse is a no-op: the canonical forms are valid under every
        # earlier release, and the original spelling is not kept.
        migrations.RunPython(canonicalize_values, migrations.RunPython.noop),
    ]
