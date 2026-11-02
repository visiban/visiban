"""DRF form parsers whose upload-limit errors are a JSON 400 (#2072).

Django enforces three limits while it parses a form body:

- ``DATA_UPLOAD_MAX_NUMBER_FILES`` -> ``TooManyFilesSent`` (multipart only),
- ``DATA_UPLOAD_MAX_NUMBER_FIELDS`` -> ``TooManyFieldsSent`` (multipart, and
  the ``QueryDict`` an urlencoded body is parsed into),
- ``DATA_UPLOAD_MAX_MEMORY_SIZE`` -> ``RequestDataTooBig`` (the non-file parts
  of a multipart body).

All three are ``SuspiciousOperation`` subclasses, not ``MultiPartParserError``,
so DRF's own ``MultiPartParser`` (which converts only the latter) and
``FormParser`` let them escape. ``APIView.handle_exception`` re-raises anything
that is not an ``APIException``, and Django's 400 handler then answers with an
HTML page, while every body-reading operation documents its 400 as
``application/json`` (``visiban.schema_hooks.add_standard_error_responses``).

These subclasses re-raise them as DRF's ``ParseError``, the same exception, and
so the same ``{"detail": "..."}`` body, a malformed multipart body already gets.
The limits themselves are unchanged and still enforced by Django; only the
response changes. Media types are inherited, so the accepted content types are
exactly DRF's. The ``django.security.<ExceptionName>`` error Django logs for a
``SuspiciousOperation`` is kept (same logger, level and message), so an
operator alerting on it still sees an upload-limit probe.

Out of reach of a parser: ``RequestDataTooBig`` for a JSON or urlencoded body
over ``DATA_UPLOAD_MAX_MEMORY_SIZE``. DRF reads ``request.body`` for those two
parsers in ``Request._parse`` *before* calling ``parse()``, and that read is
where Django raises it.

Wired as ``REST_FRAMEWORK["DEFAULT_PARSER_CLASSES"]`` and on every view or
action that pins ``parser_classes``; a new pin must use these classes, not
DRF's.
"""

import logging

from django.core.exceptions import RequestDataTooBig, TooManyFieldsSent, TooManyFilesSent
from rest_framework.exceptions import ParseError
from rest_framework.parsers import FormParser, MultiPartParser

# The Django exceptions raised for a body over an upload limit. Each message
# names the setting that was exceeded and nothing from the request itself, so
# it is safe to echo back as the ``detail``.
UPLOAD_LIMIT_ERRORS = (TooManyFilesSent, TooManyFieldsSent, RequestDataTooBig)


def _parse_error(exc, prefix, parser_context):
    """Log ``exc`` as Django would have, and return the ``ParseError`` to raise.

    Mirrors ``django.core.handlers.exception.response_for_exception`` for a
    ``SuspiciousOperation``: the message names the exceeded setting only, never
    request data, so it is safe both to log and to return as ``detail``.
    """
    request = (parser_context or {}).get("request")
    logging.getLogger(f"django.security.{type(exc).__name__}").error(
        str(exc),
        extra={"status_code": 400, "request": getattr(request, "_request", request)},
    )
    return ParseError(f"{prefix} - {exc}")


class LimitedMultiPartParser(MultiPartParser):
    """``MultiPartParser`` whose upload-limit errors are a ``ParseError``."""

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            return super().parse(stream, media_type, parser_context)
        except UPLOAD_LIMIT_ERRORS as exc:
            raise _parse_error(exc, "Multipart form parse error", parser_context) from exc


class LimitedFormParser(FormParser):
    """``FormParser`` whose upload-limit errors are a ``ParseError``."""

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            return super().parse(stream, media_type, parser_context)
        except UPLOAD_LIMIT_ERRORS as exc:
            raise _parse_error(exc, "Form parse error", parser_context) from exc
