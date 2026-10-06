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

# status code -> (description, schema). 400 is handled separately below: it is
# only ever possible on an operation that reads client input, and its body shape
# varies, so it gets its own (deliberately loose) envelope.
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

# What DRF renders for a ``ValidationError`` / ``ParseError`` (#1165, #1124):
#   * ``{"<field>": ["msg", ...], ...}`` from a serializer (values may nest for
#     child serializers / ``many=True``),
#   * ``["msg", ...]`` for a non-field error raised on a list or a bare field,
#   * ``{"detail": "msg"}`` for a malformed body (``ParseError``).
# There is no single stricter shape that is true for every endpoint, so the
# schema says exactly that much: an object or an array. Endpoints whose 400 has
# a specific body (the ``CardServiceError`` family) still declare it with
# ``@extend_schema`` and are never overwritten here.
_VALIDATION_ERROR_SCHEMA = {
    "oneOf": [
        {"type": "object", "additionalProperties": True},
        {"type": "array", "items": {}},
    ],
}

_VALIDATION_ERROR_DESCRIPTION = (
    "The request was malformed or failed validation. The body is DRF's "
    "validation-error shape: an object keyed by field name (or ``detail``), "
    "or a list of messages."
)

_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


_BODY_METHODS = frozenset({"post", "put", "patch"})


def _reads_client_input(method, operation):
    """True if the operation parses a request body or declares query parameters.

    Those are the only operations that can answer 400: a bare path-parameter
    lookup either resolves or is a 404, so documenting a 400 there would claim
    a response the server cannot produce. Header/cookie parameters are not
    counted for the same reason.

    Keyed on the HTTP method, not on a ``requestBody`` entry: a view that
    declares no serializer has no ``requestBody`` in the schema, but DRF still
    parses the body and answers 400 to a malformed one (the fuzz job hit exactly
    that on several auth and swimlane endpoints).
    """
    if method in _BODY_METHODS or "requestBody" in operation:
        return True
    return any(
        param.get("in") == "query"
        for param in operation.get("parameters", [])
        if isinstance(param, dict)
    )


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
            if "400" not in responses and _reads_client_input(method, operation):
                responses["400"] = {
                    "description": _VALIDATION_ERROR_DESCRIPTION,
                    "content": {
                        "application/json": {"schema": _VALIDATION_ERROR_SCHEMA}
                    },
                }
            for status_code, (description, schema) in _STANDARD_ERROR_RESPONSES.items():
                if status_code in responses:
                    continue
                responses[status_code] = {
                    "description": description,
                    "content": {"application/json": {"schema": schema}},
                }
    return result


# (component, property) -> enum component name, for enums whose auto-derived
# name would collide (#1137).
#
# drf-spectacular's ``postprocess_schema_enums`` names an enum after its
# property. ``BoardFull.members[].role`` (EffectiveBoardMember) and
# ``BoardMembership.role`` are both called ``role`` but carry different choice
# sets — the effective roster adds ``site_admin``. On that collision the
# built-in hook renames *both* enums with a hash suffix, which would silently
# rename the long-published ``RoleEnum`` out from under every generated client.
# ``ENUM_NAME_OVERRIDES`` cannot fix it either: overrides are keyed by choice
# set, and ``RoleEnum``'s set is shared with ``DefaultBoardMemberRoleEnum``, so
# pinning one name collapses the other into it.
#
# Lifting these enums into their own named component *before* the built-in
# hook runs removes them from its collision analysis entirely, so every
# existing enum keeps exactly the name it had.
_PINNED_ENUMS = {
    ("EffectiveBoardMember", "role"): "EffectiveBoardRoleEnum",
    ("BoardFull", "current_user_role"): "EffectiveBoardRoleEnum",
    # Board invites (#1444) grant member/collaborator/viewer only — a third
    # ``role`` choice set, which would otherwise hash-rename RoleEnum again.
    ("BoardInviteLink", "role"): "BoardInviteRoleEnum",
    ("BoardInviteLinkEmailRequest", "role"): "BoardInviteRoleEnum",
    ("BoardInviteLinkEmailRequest", "expiry_days"): "BoardInviteExpiryDaysEnum",
}


def pin_named_enums(result, generator, request, public):
    """Lift each ``_PINNED_ENUMS`` property's inline enum into a named component.

    Must be listed before ``drf_spectacular.hooks.postprocess_schema_enums``.
    The replacement mirrors what the built-in hook emits (``allOf`` a ref, or
    ``oneOf`` with ``NullEnum`` when the field is nullable), so the published
    shape is indistinguishable from an auto-named enum.
    """
    from drf_spectacular.plumbing import ResolvedComponent

    def register(name, schema):
        # Through the registry, not straight into ``result``: the built-in enum
        # hook rebuilds ``result["components"]`` from the registry when it runs.
        component = ResolvedComponent(name=name, type=ResolvedComponent.SCHEMA, schema=schema, object=name)
        generator.registry.register_on_missing(component)
        registered = generator.registry[component].schema
        if registered != schema:
            raise ValueError(f"{name} is pinned with {schema}, but already holds {registered}")
        return component.ref

    schemas = result.get("components", {}).get("schemas", {})
    for (component, prop), enum_name in _PINNED_ENUMS.items():
        props = schemas.get(component, {}).get("properties", {})
        prop_schema = props.get(prop)
        if not prop_schema or "enum" not in prop_schema:
            continue
        values = [v for v in prop_schema["enum"] if v not in ("", None)]
        ref = register(enum_name, {"enum": values, "type": prop_schema.get("type", "string")})
        rest = {k: v for k, v in prop_schema.items() if k not in ("type", "enum", "x-spec-enum-id")}
        if None in prop_schema["enum"]:
            null_ref = register("NullEnum", {"enum": [None]})
            props[prop] = {**rest, "oneOf": [ref, null_ref]}
        else:
            props[prop] = {**rest, "allOf": [ref]}
    return result
