"""django-filter backend whose 400 carries the bad-query-param ``code`` (#1832).

A filter value that fails its type check (``?assignee=x``, ``?due_before=x``,
``?updated_since=x``) makes ``DjangoFilterBackend`` raise DRF's field-keyed
``{"assignee": ["Enter a number."]}``. #1825 settled ``{detail, code}`` with
``code: "invalid_query_param"`` as the API's shape for a bad query parameter.

The field-keyed entry is kept and ``detail``/``code`` are added beside it,
rather than replacing it. ``GET /boards/{id}/cards/`` shipped that field-keyed
body in 1.1, and removing a response field is a breaking change in a minor
release (CLAUDE.md, "Backward compatibility"). ``GET /cards/`` is new in 1.2
and could have taken the bare shape, but it mirrors the board card list's
filters on purpose; one backend gives both the same body for the same
parameter rather than forking the error shape per endpoint.

Wired as the first ``DEFAULT_FILTER_BACKENDS`` entry and on views that set
``filter_backends`` explicitly. A FilterSet must therefore never declare a
filter named ``detail`` or ``code``: its field-keyed entry would collide with
the added keys.
"""

from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.contrib.django_filters import DjangoFilterExtension
from rest_framework.exceptions import ValidationError

from visiban.exceptions import INVALID_QUERY_PARAM


def _summarize(errors):
    """``{"assignee": ["Enter a number."]}`` -> ``"assignee: Enter a number."``."""
    parts = []
    for field, messages in errors.items():
        if not isinstance(messages, (list, tuple)):
            messages = [messages]
        parts.append(f"{field}: {' '.join(str(m) for m in messages)}")
    return "; ".join(parts)


class CodedDjangoFilterBackend(DjangoFilterBackend):
    """``DjangoFilterBackend`` whose filter errors also carry ``detail``/``code``."""

    def filter_queryset(self, request, queryset, view):
        try:
            return super().filter_queryset(request, queryset, view)
        except ValidationError as exc:
            # translate_validation() always raises a dict; anything else is not
            # a filterset error and passes through untouched.
            if not isinstance(exc.detail, dict):
                raise
            body = dict(exc.detail)
            body["detail"] = _summarize(exc.detail)
            body["code"] = INVALID_QUERY_PARAM
            raise ValidationError(body) from None


class CodedDjangoFilterExtension(DjangoFilterExtension):
    """Schema for ``CodedDjangoFilterBackend``: the stock extension, ids as integers.

    drf-spectacular's ``DjangoFilterExtension`` already matches this subclass
    (``match_subclasses``). It types a ``NumberFilter`` from the model field
    its ``field_name`` reaches, and a ``field_name`` written as an attname
    (``board_id``, ``column_id``) reaches none, so those id filters came out as
    ``number``. Every ``BoundedIdFilter`` filters an integer id column and
    refuses a value outside the signed 64-bit range with a 400, so it is
    published as a 64-bit integer (#1887).

    Not ``extend_schema_field`` on ``BoundedIdFilter``: an annotated filter
    loses the ``help_text`` description the extension otherwise publishes.

    The stock extension also publishes the FilterSet on every operation
    drf-spectacular treats as a list, which includes a viewset's custom
    ``@action``s that return many rows. Only the ``list`` action runs
    ``filter_queryset()`` (``ListModelMixin``; ``CardViewSet.list``), so on any
    other action those parameters would be ignored and are not published.
    A plain ``APIView`` has no ``action`` and is left to the stock rule.
    Schema only: nothing here runs at request time.
    """

    target_class = "visiban.filters.CodedDjangoFilterBackend"
    priority = 1  # above drf_spectacular.contrib.django_filters' extension (0)

    def get_schema_operation_parameters(self, auto_schema, *args, **kwargs):
        if getattr(auto_schema.view, "action", "list") not in (None, "list"):
            return []
        return super().get_schema_operation_parameters(auto_schema, *args, **kwargs)

    def resolve_filter_field(self, auto_schema, model, filterset_class, field_name, filter_field):
        # Deferred: boards imports this module, and this runs only at schema time.
        from boards.views._helpers import BoundedIdFilter

        params = super().resolve_filter_field(
            auto_schema, model, filterset_class, field_name, filter_field,
        )
        if isinstance(filter_field, BoundedIdFilter):
            for param in params:
                param["schema"] = {"type": "integer", "format": "int64"}
        return params
