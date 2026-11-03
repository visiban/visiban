"""One guard for every DRF ``JSONField``: refuse a lone UTF-16 surrogate (#2085).

``StrictJSONParser`` guards a JSON *body*. A ``JSONField`` also receives input
that never went through it: on a form-encoded or multipart request DRF's
``JSONField`` runs ``json.loads`` on the field's string inside
``to_internal_value``, after the parser, and ``"\\ud800"`` then reaches
PostgreSQL as ``DataError`` (jsonb) — an unhandled 500 — exactly as in a JSON
body.

The check is installed on ``rest_framework.fields.JSONField`` itself, from
``BoardsConfig.ready()``, rather than on subclasses: every field a serializer
declares (``ColumnPolicyField``, ``ChoicesField``, the two
``AllowedPrioritiesField`` classes), every one ``ModelSerializer`` generates
from a model ``JSONField``, and any declared later (or by an enterprise app)
inherits it, so there is no swap list to miss an entry of.
``boards/tests/test_lone_surrogate.py`` fails if the guard is not installed or
if a project ``JSONField`` is built some other way.
"""
from rest_framework import fields
from rest_framework.exceptions import ValidationError

from visiban.parsers import first_lone_surrogate

_INSTALLED_FLAG = "_visiban_surrogate_guard"


def install():
    """Wrap ``JSONField.to_internal_value`` once; safe to call again."""
    original = fields.JSONField.to_internal_value
    if getattr(original, _INSTALLED_FLAG, False):
        return

    def to_internal_value(self, data):
        value = original(self, data)
        code_point = first_lone_surrogate(value)
        if code_point is not None:
            raise ValidationError(f"Surrogate characters are not allowed: U+{code_point:X}.")
        return value

    setattr(to_internal_value, _INSTALLED_FLAG, True)
    fields.JSONField.to_internal_value = to_internal_value
