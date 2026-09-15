"""drf-spectacular postprocessing hooks.

Registered via ``SPECTACULAR_SETTINGS["POSTPROCESSING_HOOKS"]`` in
``visiban/settings.py``.
"""

# The body DRF's default exception handler returns for AuthenticationFailed,
# NotAuthenticated, PermissionDenied, NotFound, and Throttled — every one of
# them renders as ``{"detail": "<message>"}``. Visiban does not configure a
# custom ``EXCEPTION_HANDLER`` (see REST_FRAMEWORK in settings.py), so this is
# not a convention the views choose — it is what the framework does whenever
# no view-level code intercepts the exception, which is true almost
# everywhere.  ``boards.services.errors.CardServiceError`` subclasses are the
# documented exception: the card mutation endpoints construct their own
# bodies (some without a ``detail`` key at all) and are already declared
# per-endpoint via ``@extend_schema`` (#1108) — this hook never overwrites a
# response that an operation already declares.
_ERROR_ENVELOPE_SCHEMA = {
    "type": "object",
    "properties": {"detail": {"type": "string"}},
    "required": ["detail"],
}

# status code -> (description, schema). 400 is deliberately absent: validation
# failures are either a serializer's field-keyed error dict (shape varies per
# serializer) or one of the CardServiceError bodies, and both are meant to be
# declared per-endpoint rather than papered over with a generic shape here.
_STANDARD_ERROR_RESPONSES = {
    "401": (
        "Authentication credentials were not provided, or are invalid/expired.",
        _ERROR_ENVELOPE_SCHEMA,
    ),
    "403": (
        "The authenticated user does not have permission to perform this action.",
        _ERROR_ENVELOPE_SCHEMA,
    ),
    "404": (
        "The requested object does not exist, or the caller cannot see it.",
        _ERROR_ENVELOPE_SCHEMA,
    ),
    "429": (
        "The request was throttled.",
        _ERROR_ENVELOPE_SCHEMA,
    ),
}

_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


def add_standard_error_responses(result, generator, request, public):
    """Document the standard DRF error envelope on every operation.

    Without this, drf-spectacular only ever describes an operation's success
    path (plus any 4xx a view explicitly declares with ``@extend_schema``), so
    the generated schema simply never mentions a 401/403/404/429 for most
    endpoints — not because the server can't return one, but because nothing
    told the schema generator it could. That is exactly the gap #1080 is
    about: a validator that only checks the *document* is well-formed cannot
    catch a response shape the document never describes in the first place.

    Only fills in a status code an operation has not already declared a
    response for, so a view's own ``@extend_schema`` (e.g. the WIP/weight
    limit 409s on CardViewSet.move) is never clobbered.
    """
    for path_item in result.get("paths", {}).values():
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS:
                continue
            responses = operation.setdefault("responses", {})
            for status_code, (description, schema) in _STANDARD_ERROR_RESPONSES.items():
                if status_code in responses:
                    continue
                responses[status_code] = {
                    "description": description,
                    "content": {"application/json": {"schema": schema}},
                }
    return result
