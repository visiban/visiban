"""One shared rule for the ``color`` text columns (#2093).

``Column``, ``Swimlane``, ``Label`` and ``GroupLabel`` store ``color`` as a
plain ``CharField(max_length=7)``. The custom-color UI writes arbitrary hex, so
every write path needs the same definition of "a color". This is deliberately
*not* a model validator or ``RegexValidator``: that would need a migration and
would publish a ``pattern`` on the response schema that legacy rows (which may
hold ``red`` or ``#12345``) would violate.
"""
import re

from django.core.exceptions import ValidationError
from rest_framework import serializers

# fullmatch, not ^...$: "$" also matches before a trailing newline.
_HEX6_RE = re.compile(r"#[0-9A-Fa-f]{6}")
_HEX3_RE = re.compile(r"#[0-9A-Fa-f]{3}")

COLOR_ERROR_MESSAGE = "Enter a color as #RRGGBB or #RGB."


def normalize_hex_color(value):
    """Return *value* as ``#RRGGBB``, or ``None`` if it is not a hex color.

    ``#RGB`` is expanded by doubling each digit; the case of the digits is
    kept, since the server never rewrites case.
    """
    if not isinstance(value, str):
        return None
    if _HEX6_RE.fullmatch(value):
        return value
    if _HEX3_RE.fullmatch(value):
        return "#" + "".join(ch * 2 for ch in value[1:])
    return None


class ColorValidationMixin:
    """``validate_color`` for a ModelSerializer whose model has a ``color``.

    A value equal to the stored one passes untouched. Legacy rows may hold a
    non-hex color, and clients such as the swimlane row editor resend the
    current color on every rename; rejecting that would make an unrelated
    edit fail. Any *changed* value must be valid hex.
    """

    def validate_color(self, value):
        instance = self.instance
        if instance is not None and value == getattr(instance, "color", None):
            return value
        normalized = normalize_hex_color(value)
        if normalized is None:
            raise serializers.ValidationError(COLOR_ERROR_MESSAGE)
        return normalized


class ColorAdminFormMixin:
    """``clean_color`` for a Django admin ModelForm whose model has a ``color`` (#2100).

    The same rule as ``ColorValidationMixin``, for the one write path that does
    not go through a serializer. It is a form-level check on purpose, not a
    model validator, for the reasons in this module's docstring. An unchanged
    value passes so that a superuser can still save a row whose legacy color
    is not hex (for example, to rename it).
    """

    def clean_color(self):
        value = self.cleaned_data["color"]
        if self.instance.pk is not None and value == getattr(self.instance, "color", None):
            return value
        normalized = normalize_hex_color(value)
        if normalized is None:
            raise ValidationError(COLOR_ERROR_MESSAGE)
        return normalized
