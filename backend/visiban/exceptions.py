"""Shared DRF exceptions.

``CodedValidationError`` (#1660)
-------------------------------
A 400 whose body is exactly ``{"code": "<slug>", "detail": "<message>"}`` with
both values plain strings — the shape 1.1 shipped for its machine-checkable
errors (``feature_disabled``, ``export_restricted``), which clients compare with
``body.code === "..."``.

Raising ``serializers.ValidationError({"code": ..., "detail": ...})`` from a
serializer's ``validate()`` does **not** produce that shape: DRF's
``Serializer.run_validation`` catches every ``ValidationError`` and re-wraps it
through ``as_serializer_error()``, which coerces each dict value into a
single-item list (``{"code": ["relation_exists"], ...}``). A client checking
``body.code === "relation_exists"`` then silently never matches.

This class deliberately subclasses ``APIException`` and **not**
``ValidationError``, so ``run_validation`` does not catch it: it propagates out
of ``is_valid()`` untouched and DRF's default exception handler renders
``.detail`` as-is. The consequence callers must know about: it escapes
``is_valid()`` even without ``raise_exception=True``, so it is only for
serializers whose callers let DRF render the error (a view), not for code that
inspects ``serializer.errors``.
"""

import logging

from rest_framework import status
from rest_framework.exceptions import APIException, ParseError
from rest_framework.views import exception_handler as drf_exception_handler


# The ``code`` for a refused query parameter (#1825, #1832): the one 400 shape
# for bad query parameters across the API (docs/api/index.md, "Error
# responses"), raised as ``CodedValidationError(INVALID_QUERY_PARAM, ...)``.
INVALID_QUERY_PARAM = "invalid_query_param"

# OpenAPI schema for that 400 body, shared by every operation that raises it.
# Extra keys are allowed because the django-filter errors keep their 1.1
# field-keyed entries next to ``detail``/``code`` (see visiban.filters).
INVALID_QUERY_PARAM_SCHEMA = {
    "type": "object",
    "required": ["detail", "code"],
    "properties": {
        "detail": {"type": "string"},
        "code": {"type": "string", "enum": [INVALID_QUERY_PARAM]},
    },
    "additionalProperties": True,
}


class CodedValidationError(APIException):
    """A 400 with a string ``code`` and string ``detail`` — the 1.1 shape."""

    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "Invalid input."
    default_code = "invalid"

    def __init__(self, code: str, detail: str):
        # Passing a dict makes APIException keep it as the body verbatim
        # (values become ErrorDetail, a str subclass, so they render as JSON
        # strings), rather than wrapping a bare string under a `detail` key.
        super().__init__(detail={"code": code, "detail": detail}, code=code)


def api_exception_handler(exc, context):
    """DRF ``EXCEPTION_HANDLER``: Django's upload-limit errors become a JSON 400 (#2073).

    ``visiban.parsers`` covers the limits Django raises *inside* a parser (#2072).
    Two raise outside one: ``RequestDataTooBig`` from the ``request.body`` read
    DRF does before it calls a JSON or urlencoded parser, and
    ``TooManyFieldsSent`` while Django parses the query string. Both are
    ``SuspiciousOperation``s that DRF's own handler returns ``None`` for, so
    they reached Django's HTML 400. Both surface from code the view runs
    (``request.data`` / ``request.query_params``), i.e. under
    ``APIView.handle_exception``, so one global handler covers every view,
    enterprise ones included, with no per-view opt-in.

    Handling the exception here means Django's own ``response_for_exception``
    never sees it and so never logs it; the ``django.security.<Name>`` record is
    re-emitted (same logger, level and message) so alerting on it keeps working.
    """
    # Local import: visiban.parsers imports nothing from here, but keep the
    # settings-time import graph (this module is loaded via REST_FRAMEWORK) light.
    from visiban.parsers import UPLOAD_LIMIT_ERRORS

    if isinstance(exc, UPLOAD_LIMIT_ERRORS):
        request = context.get("request")
        logging.getLogger(f"django.security.{type(exc).__name__}").error(
            str(exc),
            extra={
                "status_code": 400,
                "request": getattr(request, "_request", request),
            },
        )
        # The message names the exceeded setting only, never request data.
        exc = ParseError(f"Request parse error - {exc}")
    return drf_exception_handler(exc, context)
