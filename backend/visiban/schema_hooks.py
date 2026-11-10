"""drf-spectacular postprocessing hooks.

Registered via ``SPECTACULAR_SETTINGS["POSTPROCESSING_HOOKS"]`` in
``visiban/settings.py``.
"""

# The body DRF's default exception handler returns for AuthenticationFailed,
# NotAuthenticated, PermissionDenied, NotFound, and Throttled — every one of
# them renders as ``{"detail": "<message>"}``. Visiban's ``EXCEPTION_HANDLER`` (see REST_FRAMEWORK in settings.py)
# only adds a 400 for Django's upload-limit errors (#2073), so this is
# not a convention the views choose — it is what the framework does whenever
# no view-level code intercepts the exception, which is true almost
# everywhere.  ``boards.services.errors.CardServiceError`` subclasses are the
# documented exception: the card mutation endpoints construct their own
# bodies (some without a ``detail`` key at all) and are already declared
# per-endpoint via ``@extend_schema`` (#1108) — this hook never overwrites a
# response that an operation already declares (a declared 400 is only widened,
# #2178).
_ERROR_ENVELOPE_SCHEMA = {
    "type": "object",
    "properties": {"detail": {"type": "string"}},
    "required": ["detail"],
}

# status code -> (description, schema). 400 is handled separately below: its
# body shape varies, so it gets its own (deliberately loose) envelope.
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
# ``@extend_schema``; that schema is kept and widened to also admit the 400s
# raised before the view runs (#2178), never replaced.
_VALIDATION_ERROR_SCHEMA = {
    "oneOf": [
        {"type": "object", "additionalProperties": True},
        {"type": "array", "items": {}},
    ],
}

_VALIDATION_ERROR_DESCRIPTION = (
    "The request was malformed or failed validation. The body is DRF's "
    "validation-error shape: an object keyed by field name (or ``detail``), "
    "or a list of messages. Any operation can also answer it for a request "
    "over a server limit (a body over 2.5 MB, or a query string with more "
    "than 1000 parameters), as ``{\"detail\": \"...\"}``."
)

_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete"})


# The 400 bodies raised *before* a view runs (#2178), which an operation's own
# ``@extend_schema`` 400 does not describe:
#   * ``{"detail": "..."}``, and nothing else: ``ParseError`` for a malformed
#     body or a surrogate in a key (#2085), a form or query string over a
#     Django upload limit (#2072, #2073, #2140), a refused ``charset`` (#2120)
#     or multipart part header (#2151). The limit and charset ones reach every
#     operation, a GET or DELETE included.
#   * ``{"<field>": ["..."]}``: ``StrictJSONParser`` naming a field whose value
#     holds a lone surrogate, under any key, one the serializer would ignore
#     included (the fuzzer's random ``Hgg``). Only a view that reads the body
#     can raise it.
# Deliberately narrower than ``_VALIDATION_ERROR_SCHEMA``: that one accepts any
# object, so a union with it would stop a declared 400 constraining anything
# (#1832's coded query-param 400 requires ``detail`` and ``code``, and its tests
# prove a bare field-keyed body is rejected on those GETs).
_PRE_VIEW_DETAIL_400_SCHEMA = {
    "type": "object",
    "properties": {"detail": {"type": "string"}},
    "required": ["detail"],
    "additionalProperties": False,
}
_PRE_VIEW_FIELD_400_SCHEMA = {
    "type": "object",
    "minProperties": 1,
    "additionalProperties": {"type": "array", "items": {"type": "string"}},
}


def _pre_view_400_branches(method, operation):
    """The pre-view 400 shapes this operation can answer.

    The field-keyed branch applies to every method but GET, and to a GET that
    declares a request body: DRF parses a body only when the view reads
    ``request.data``, and no GET view here does, while a DELETE view may. The
    ``{"detail"}`` branch applies to every operation (see above).
    """
    if method != "get" or "requestBody" in operation:
        return [_PRE_VIEW_DETAIL_400_SCHEMA, _PRE_VIEW_FIELD_400_SCHEMA]
    return [_PRE_VIEW_DETAIL_400_SCHEMA]


def _widen_declared_400(response, method, operation):
    """Make an operation's own 400 also accept the pre-view 400 bodies (#2178).

    A view's ``@extend_schema`` 400 describes the body *that view* builds (the
    move endpoint's ``CardMoveVersionTypeError``, an invite's
    ``InviteEmailBadRequest``), not the 400s raised before it runs, so the
    fuzzer's surrogate body ``{"Hgg": [...]}`` violated move's contract and a
    ``{"detail"}`` ParseError violated the invite one. Every declared 400 is
    widened, not only those of operations with a JSON request body, because
    the query-string limit and the charset check reach every operation.

    The declared schema stays first, so it remains documented. The union is
    ``anyOf``, not ``oneOf``: a declared ``{detail}`` schema and the pre-view
    ``{detail}`` branch both match ``{"detail": "x"}``, which ``oneOf``
    rejects. Server behavior does not change; the document now describes
    responses the API already sends.

    Per declared shape: a ``$ref``, an inline schema or a ``oneOf`` is wrapped;
    an ``anyOf`` gains the missing branches (no nesting, and a second run adds
    nothing); a 400 with no JSON schema (a description only, such as block's)
    never described its body, so it gains the full ``_VALIDATION_ERROR_SCHEMA``
    rather than a narrower claim about the view's own body.
    """
    content = response.setdefault("content", {})
    media = content.get("application/json")
    if not media or not media.get("schema"):
        content["application/json"] = {**(media or {}), "schema": _VALIDATION_ERROR_SCHEMA}
        return
    schema = media["schema"]
    if schema == _VALIDATION_ERROR_SCHEMA:
        return  # already admits every pre-view body
    branches = _pre_view_400_branches(method, operation)
    if set(schema) == {"anyOf"}:
        schema["anyOf"] += [b for b in branches if b not in schema["anyOf"]]
        return
    media["schema"] = {"anyOf": [schema, *branches]}


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
    limit 409s on CardViewSet.move) is never clobbered. The one exception is
    a declared 400, which keeps its schema but is widened to also admit the
    400 bodies raised before the view runs (#2178, ``_widen_declared_400``).
    """
    for path_item in result.get("paths", {}).values():
        for method, operation in path_item.items():
            if method not in _HTTP_METHODS:
                continue
            responses = operation.setdefault("responses", {})
            # Every operation, not only ones that read client input: content
            # negotiation parses the query string on every request, so a query
            # string over DATA_UPLOAD_MAX_NUMBER_FIELDS is a JSON 400 anywhere
            # (#2073, #2140). A 400 the view declares is kept but widened to
            # admit the pre-view 400s (#2178); see _widen_declared_400.
            if "400" in responses:
                _widen_declared_400(responses["400"], method, operation)
            else:
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
    # Shareable board links and the site-admin board invite list (#439): the
    # same choice sets, pinned to the same components.
    ("BoardInviteLinkCreateRequest", "role"): "BoardInviteRoleEnum",
    ("BoardInviteLinkCreateRequest", "expiry_days"): "BoardInviteExpiryDaysEnum",
    ("BoardInviteLinkCreateResponse", "role"): "BoardInviteRoleEnum",
    ("AdminBoardInviteLink", "role"): "BoardInviteRoleEnum",
    # Shareable group links grant every group role except admin (#1727): a
    # choice set narrower than the response's ``role``, which would otherwise
    # hash-rename RoleEnum too.
    ("GroupInviteLinkCreateRequest", "role"): "GroupInviteLinkRoleEnum",
    # Emailed group invites are capped the same way (#2006): same choice set.
    ("GroupInviteLinkEmailRequest", "role"): "GroupInviteLinkRoleEnum",
    # ``Board.export_min_role`` declares ``choices`` (#1725) with the same four
    # values as ``BoardMembership.role``; left alone it would be named after
    # one of the two and rename the published ``RoleEnum``.
    ("Board", "export_min_role"): "ExportMinRoleEnum",
    ("BoardFull", "export_min_role"): "ExportMinRoleEnum",
    ("BoardImportResponse", "export_min_role"): "ExportMinRoleEnum",
    ("BoardRequest", "export_min_role"): "ExportMinRoleEnum",
    ("PatchedBoardRequest", "export_min_role"): "ExportMinRoleEnum",
    # Column policy mode (#1101): a bare ``mode`` would publish a generic
    # ``ModeEnum`` that the next unrelated ``mode`` field would hash-rename.
    ("ColumnPolicy", "mode"): "ColumnPolicyModeEnum",
    ("ColumnPolicyRequest", "mode"): "ColumnPolicyModeEnum",
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


# (path, method) operations whose view answers 400 without the body.
# drf-spectacular marks a request body required only for serializers, and a
# dict schema never is, so these have to be set here (shared by #1788, #1783
# and #1792).
_REQUIRED_BODIES = (
    ("/api/v1/boards/{board_pk}/swimlanes/{id}/set-collapsed/", "patch"),
    ("/api/v1/boards/{board_pk}/swimlanes/{id}/set_collapsed/", "patch"),
    ("/api/v1/groups/{id}/members/{user_id}/", "patch"),
    # The import views answer 400 "No file provided." without the upload (#1792).
    ("/api/v1/boards/import/", "post"),
    ("/api/v1/boards/import/trello/", "post"),
)


def require_declared_request_bodies(result, generator, request, public):
    """Mark the request body of every ``_REQUIRED_BODIES`` operation as required.

    Without this the schema says the body is optional, and correcting it after
    the v1.2.0 baseline freezes would be a breaking change (#1788, #1783, #1792).
    """
    for path, method in _REQUIRED_BODIES:
        body = result.get("paths", {}).get(path, {}).get(method, {}).get("requestBody")
        if body is not None:
            body["required"] = True
    return result


# (component, property) pairs that stay in the contract but are superseded.
# drf-spectacular cannot express ``deprecated`` on an inline_serializer field.
_DEPRECATED_PROPERTIES = (
    # The change feed's cursor was renamed ``next_cursor`` before GA (#1869).
    ("BoardEventFeedPage", "next"),
)


def mark_deprecated_fields(result, generator, request, public):
    """Flag superseded response properties ``deprecated: true`` in the schema."""
    schemas = result.get("components", {}).get("schemas", {})
    for component, prop in _DEPRECATED_PROPERTIES:
        field = schemas.get(component, {}).get("properties", {}).get(prop)
        if field is not None:
            field["deprecated"] = True
    return result
