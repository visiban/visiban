"""DRF parsers that turn bodies PostgreSQL cannot store into a JSON 400.

``StrictJSONParser`` (#2085)
----------------------------
``"\\ud800"`` is valid JSON but decodes to a ``str`` UTF-8 cannot encode, so
psycopg raises ``UnicodeEncodeError`` (a ``str`` column) or ``DataError`` (a
``jsonb`` value) and the request is an unhandled 500. DRF 3.18's ``CharField``
already refuses a surrogate, so every plain text field is a field-keyed 400;
what it does not cover is a ``JSONField`` value (saved-filter ``state_json``,
custom-field ``choices``), a ``dict`` key, and any view that reads
``request.data`` directly. Guarding the parsed JSON body once, here, covers all
of them and any field added later. A lone surrogate in an object body answers
``{"<field>": ["Surrogate characters are not allowed: U+D800."]}``, the message
``CharField`` already gives; a surrogate in a key, in a non-object body, or
under a key that is not a short plain identifier answers
``{"detail": "JSON parse error - ..."}`` (a client-chosen key is never echoed
unbounded), as a malformed JSON document does. This is not byte-identical to the
stock behavior: the parser names only the first offending top-level field
(``CharField`` named every bad field), and a surrogate in a field the
serializer would have ignored (an unknown key, a ``labels`` list it discards)
is now a 400 where it used to be a 200. A valid surrogate *pair* (an emoji written ``\\ud83d\\ude00``)
is decoded by ``json`` into one code point and is never touched.

Cost: a bytes-level regex scan for the six-character ``\\ud[89a-f]`` escape,
which a normal body never contains; the walk of the parsed value runs only when
the scan matches.

Upload limits (#2072)
---------------------

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

Out of reach of a parser (#2073), so handled by the project
``EXCEPTION_HANDLER`` (``visiban.exceptions.api_exception_handler``) instead,
which gives the same JSON 400 and keeps the same log line:

- ``RequestDataTooBig`` for a JSON or urlencoded body over
  ``DATA_UPLOAD_MAX_MEMORY_SIZE``. DRF reads ``request.body`` for those two
  parsers in ``Request._parse`` *before* calling ``parse()``, and that read is
  where Django raises it.
- ``TooManyFieldsSent`` for a query string with more than
  ``DATA_UPLOAD_MAX_NUMBER_FIELDS`` parameters, raised while Django parses
  ``request.GET``, which involves no parser at all.

Wired as ``REST_FRAMEWORK["DEFAULT_PARSER_CLASSES"]`` and on every view or
action that pins ``parser_classes``; a new pin must use these classes, not
DRF's.
"""

import io
import logging
import re

from django.core.exceptions import RequestDataTooBig, TooManyFieldsSent, TooManyFilesSent
from rest_framework.exceptions import ParseError, ValidationError
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser

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
    """``FormParser`` whose upload-limit errors are a ``ParseError``.

    Under DRF only ``TooManyFieldsSent`` can reach this ``except``: DRF hands a
    ``FormParser`` ``BytesIO(request.body)``, and ``RequestDataTooBig`` for the
    body size is raised by that ``request.body`` read, before ``parse()`` runs
    (#2073). The full tuple is still caught for defense in depth (one tuple for
    both parsers, and a future DRF that reads the body inside ``parse()``).
    """

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            return super().parse(stream, media_type, parser_context)
        except UPLOAD_LIMIT_ERRORS as exc:
            raise _parse_error(exc, "Form parse error", parser_context) from exc


# A JSON ``\\uD800``..``\\uDFFF`` escape (either case). Present in any body that
# carries a surrogate, lone or paired, so it is a cheap necessary condition.
_SURROGATE_ESCAPE = re.compile(rb"\\[uU][dD][89a-fA-F]")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
# A top-level key short and plain enough to echo as a field name.
_ECHO_KEY = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_ASCII_SAFE_ENCODINGS = frozenset({"utf-8", "utf8", "ascii", "us-ascii"})


def first_lone_surrogate(value):
    """Return the code point of the first surrogate in a parsed JSON ``value``, else ``None``.

    Looks at every string and every dict key. ``json`` joins a valid pair into
    one code point, so a surrogate left in the decoded value is necessarily
    unpaired. Iterative: the body depth is client-controlled.
    """
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            found = _LONE_SURROGATE.search(item)
            if found:
                return ord(found.group())
        elif isinstance(item, dict):
            stack.extend(item.keys())
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return None


def _surrogate_message(code_point):
    # The same text DRF's ProhibitSurrogateCharactersValidator uses for a
    # CharField, so a plain text field's 400 body is unchanged by this parser.
    return f"Surrogate characters are not allowed: U+{code_point:X}."


class StrictJSONParser(JSONParser):
    """``JSONParser`` that answers a lone UTF-16 surrogate with a 400 (#2085).

    For a JSON object body the 400 is field-keyed, ``{"<field>": ["Surrogate
    characters are not allowed: U+D800."]}``: the same message and shape as
    DRF's ``CharField`` for that field, but only the first offending top-level
    field is named, and a surrogate in a field the serializer ignores is now a
    400 (it was a 200). It is a ``ParseError`` (``{"detail": ...}``) when the
    body is not an object, the surrogate is in an object *key*, or the
    offending top-level key is not a short plain identifier (``_ECHO_KEY``):
    the key is client text, and an unbounded echo would reflect up to the body
    cap back (the importers bound every echo, #1507).
    """

    def parse(self, stream, media_type=None, parser_context=None):
        raw = stream.read()
        try:
            data = super().parse(io.BytesIO(raw), media_type, parser_context)
        except RecursionError:
            # DRF's JSONParser catches only ValueError, so a deeply nested
            # "[[[[..." body (about 10,000 levels) was an unhandled 500 on main too.
            raise ParseError("JSON parse error - the document is nested too deeply.") from None
        encoding = ((parser_context or {}).get("encoding") or "utf-8").lower()
        # The bytes-level scan only means something for an ASCII-compatible
        # encoding; for any other, fall through to the (correct) walk.
        if encoding in _ASCII_SAFE_ENCODINGS and not _SURROGATE_ESCAPE.search(raw):
            return data
        if isinstance(data, dict):
            for key, value in data.items():
                if first_lone_surrogate(key) is not None:
                    break
                code_point = first_lone_surrogate(value)
                if code_point is not None:
                    if _ECHO_KEY.fullmatch(key):
                        raise ValidationError({key: [_surrogate_message(code_point)]})
                    break
        code_point = first_lone_surrogate(data)
        if code_point is not None:
            raise ParseError(f"JSON parse error - {_surrogate_message(code_point)}")
        return data
