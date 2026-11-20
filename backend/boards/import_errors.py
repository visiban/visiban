"""Stable machine-readable ``code`` values for board-import error bodies (#1903).

Every error body from ``POST /boards/import/`` and ``POST /boards/import/trello/``
is ``{"detail": <message>, "code": <code>}``. ``detail`` is prose for a person
and may be reworded in any release; ``code`` is the contract a client branches
on, so a value here is never renamed or removed (add new ones freely).

Errors raised by the framework before or around the importer (authentication,
permission, a missing group, throttling, a parse failure) carry DRF's own
error code for the exception instead: ``not_authenticated``,
``authentication_failed``, ``permission_denied``, ``not_found``, ``throttled``,
``parse_error`` and so on.
"""


class ImportErrorCode:
    """String constants, not an Enum: they go into JSON bodies as-is."""

    #: No ``file`` part in the upload.
    NO_FILE = "no_file"
    #: The upload is over the size limit (400 on the Visiban import, 413 on Trello).
    FILE_TOO_LARGE = "file_too_large"
    #: Neither a .json nor a .csv upload (Visiban import).
    UNSUPPORTED_FORMAT = "unsupported_format"
    #: The file cannot be read as the expected format: not UTF-8, not JSON or CSV,
    #: an empty CSV, or a JSON document that is not an export at all.
    INVALID_FILE = "invalid_file"
    #: The file exceeds a count limit (cards, columns, lists, comments, ...).
    LIMIT_EXCEEDED = "limit_exceeded"
    #: The ``options`` (Visiban) or ``mapping`` (Trello) field is invalid.
    INVALID_OPTIONS = "invalid_options"
    #: The ``name`` field is invalid.
    INVALID_NAME = "invalid_name"
    #: Trello: not exactly one of ``?dry_run=true`` / ``?confirm=true``.
    INVALID_MODE = "invalid_mode"
    #: Trello: the confirmed file is not the one that was previewed (``file_sha256``).
    FILE_MISMATCH = "file_mismatch"
    #: Any other problem with the file's contents (a missing field, a wrong type,
    #: a reference to an undefined column, ...). The fallback for a 400.
    INVALID_IMPORT = "invalid_import"

    ALL = (
        NO_FILE, FILE_TOO_LARGE, UNSUPPORTED_FORMAT, INVALID_FILE, LIMIT_EXCEEDED,
        INVALID_OPTIONS, INVALID_NAME, INVALID_MODE, FILE_MISMATCH, INVALID_IMPORT,
    )


def fallback_code(detail, status_code: int) -> str:
    """The ``code`` for an import error body that did not name one.

    A DRF exception's ``detail`` is an ``ErrorDetail`` carrying the
    exception's own code (``not_found``, ``throttled``, ...), so that wins.
    A plain-string 400 is a contents problem, a 413 is the size cap. Never
    returns an empty value: a body with no input to read still gets a code.

    A 400 keeps a closed vocabulary: an ``ErrorDetail`` code is used there
    only when it is one of ours or ``parse_error`` (a malformed multipart
    body), so a serializer's internal code (``invalid``, ``max_length``)
    can never leak in as a contract value.
    """
    code = getattr(detail, "code", None)
    if isinstance(code, str) and code:
        if status_code != 400 or code in ImportErrorCode.ALL or code == "parse_error":
            return code
    if status_code == 413:
        return ImportErrorCode.FILE_TOO_LARGE
    if status_code == 400:
        return ImportErrorCode.INVALID_IMPORT
    return "error"
