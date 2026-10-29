"""MCPServer (formerly FastMCP) server instance and tool registration.

This module is the ONLY place that touches the ``mcp`` SDK's API. Tool logic
lives in :mod:`mcp_server.tools` as plain functions returning plain dicts, so
when the MCP spec or SDK churns (the spec is young — transport rev 2025-03-26)
the blast radius is this file (#511).

Later waves register their tools here too:
    #512 CRUD tools — add a ``@mcp.tool()`` wrapper that delegates to a plain
    function in ``tools.py``. Session-level authentication (identity, and the
    baseline ``mcp:read`` scope every request needs) is already handled by
    the transport middleware and needs no per-tool code.

    #512 additions: a WRITE tool is a narrower case than that comment
    originally covered, and does need one extra per-tool line — see
    ``_require_write_scope`` below and its docstring for why.

    #513 resources — a *resource* (``board://``, ``card://``) is registered
    with ``@mcp.resource("scheme://{param}")`` instead, not ``@mcp.tool()``:
    the SDK treats the two as distinct registries with different failure
    semantics (see tools.py's "Resources (#513)" section for the structured-
    error-vs-raise distinction this forces).

    #1177 throttling — every tool and resource below is registered with
    ``@_throttled()`` (or ``@_throttled(compute=True)``) directly under its
    ``@mcp.tool()``/``@mcp.resource()`` decorator. A future tool that omits it
    is caught by ``test_mcp_throttle.py``'s coverage test, which exhausts the
    shared baseline bucket via one registered tool and then asserts every
    OTHER registered tool/resource is also denied — a tool reachable without
    going through ``_throttled()`` would pass through unthrottled and fail
    that assertion.
"""
import functools
import logging
from collections.abc import Mapping
from typing import Annotated

import pydantic_core
from asgiref.sync import sync_to_async
from django.conf import settings
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ResourceError
from mcp.server.transport_security import TransportSecuritySettings
from mcp_types import CallToolResult, TextContent

from accounts.models import SCOPE_MCP_WRITE, get_maintenance_message, get_maintenance_state
from visiban.demo import DEMO_READ_ONLY_CODE, DEMO_READ_ONLY_DETAIL

from . import throttling, tools
from .context import get_current_scopes, get_current_user

logger = logging.getLogger(__name__)

SERVER_NAME = "visiban"

# Every tool's output schema is built from this annotation, never a narrower
# one like `-> list[dict]`. MCPServer (formerly FastMCP) builds a strict
# output schema from the annotation and validates every plain return against
# it. `list[dict]` alone rejects a dict return (`list_cards` with
# `include_meta`) with a pydantic ValidationError, which the SDK collapses to
# `isError=True` with only the exception text as content. `list[dict] | dict`
# validates either shape and gives a populated `structuredContent`
# (`{"result": ...}`), unlike omitting the annotation entirely (which drops
# `structuredContent` altogether and, for a list return, splits each item into
# its own unstructured content block).
_TOOL_OUTPUT = list[dict] | dict

# What every tool is registered as returning. `Annotated[CallToolResult, X]`
# tells the SDK the function may hand back a ready-made `CallToolResult` and
# that the output schema is still derived from X, so the advertised
# `outputSchema` is byte-identical to a plain `-> _TOOL_OUTPUT` (pinned by
# test_mcp_crud.py's ToolResultEnvelopeTests). A plain list/dict return is
# still converted and validated as before.
_TOOL_RESULT = Annotated[CallToolResult, _TOOL_OUTPUT]


def _as_tool_result(out):
    """Turn a tool-domain ``{"error": {...}}`` dict into an ``isError=true`` result.

    tools.py stays SDK-free and reports a domain failure (a bad id, a role or
    scope that may not write, a WIP limit, a throttle denial) by RETURNING
    ``{"error": {...}}`` (its module docstring, "Error contract"). This is the
    one place that return becomes the wire envelope, and it is applied to
    every tool by ``_throttled`` below, so no tool can forget it.

    Before #2004 the dict went out as an ordinary success (``isError=false``),
    on the stated premise that the SDK could not carry structured content on
    an error result. Re-verified on mcp 2.3.0 that this is false for a
    RETURNED result: ``FuncMetadata.convert_result`` passes a
    ``CallToolResult`` through unchanged and skips output-schema validation
    when ``is_error`` is set, and ``ClientSession.call_tool`` likewise skips
    its client-side output validation for an error result. So an error keeps
    exactly the payload it had before, in the same two places: the
    ``structuredContent`` ``{"result": {"error": {...}}}`` and one indent=2
    JSON text block identical to what the SDK renders for a returned dict.
    Only ``isError`` changes, so agent frameworks that key on it stop
    reading every WIP, permission and not-found failure as a success.

    What still does NOT work, and why tools must keep returning rather than
    raising: a raised exception becomes ``isError=true`` with only
    ``str(exc)`` as text and no ``structuredContent`` at all, losing every
    field (``wip_limit``, ``current_count``, ``retry_after``, ...) an agent
    needs to act on the failure.

    Anything else (a success list/dict, or a ``CallToolResult`` a tool built
    itself, like ``list_cards``'s truncation notice) passes through untouched.
    """
    if not (isinstance(out, dict) and "error" in out):
        return out
    return CallToolResult(
        # Same rendering the SDK applies to a returned dict (its private
        # `_convert_to_content`); a test asserts byte-identity against it.
        content=[TextContent(type="text", text=pydantic_core.to_json(out, fallback=str, indent=2).decode())],
        # mode="json" equivalent of the SDK's own structured dump, so a
        # non-JSON-native value (a Decimal limit) renders the same as before.
        structured_content={"result": pydantic_core.to_jsonable_python(out, fallback=str)},
        is_error=True,
    )


def _require_write_scope():
    """Return a structured denial dict if the caller's PAT lacks mcp:write, else None.

    Write tools need an EXTRA scope beyond the `mcp:read` the transport
    already required to reach here (#1110 non-hierarchical scopes: read does
    not grant write, and `mcp:write` alone does not even satisfy the
    transport's `mcp:read` gate — see `test_mcp_write_alone_does_not_satisfy_
    mcp_read`, which pins that a write-capable agent PAT must carry BOTH
    scopes). `docs/api/authentication.md` has documented `mcp:write` as
    "Reserved for MCP write tools" since #511; this is the first tool wave
    that exists to reserve it for, so enforcing it now — not deferring to a
    follow-up — is what closes that reservation rather than leaving a written
    promise nothing checks. Without this, any `mcp:read`-only PAT (the scope
    a user grants for "let this agent read my boards") would silently gain
    full write access the moment these tools are registered.

    Deliberately NOT `accounts.authentication.enforce_mcp_scope` — that
    raises `InvalidPersonalAccessToken` for the transport's own 401 envelope,
    which is the right shape for "you cannot open a session at all" but the
    wrong one here: a write-scope denial on an already-open, otherwise-valid
    session is a normal tool-level outcome, so it renders through the same
    `{"error": {...}}` contract every other write-tool failure uses, not a
    401. The scope vocabulary itself (`SCOPE_MCP_WRITE`) is still the single
    source of truth imported from `accounts.models`, so the two enforcement
    points can never name the scope differently.
    """
    if SCOPE_MCP_WRITE not in get_current_scopes():
        return {"error": {
            "code": "missing_scope",
            "detail": f"This action requires the '{SCOPE_MCP_WRITE}' scope on the presented token.",
        }}
    return None


def _require_maintenance_off():
    """Return a structured denial dict while maintenance mode is on, else None.

    WHY THIS EXISTS SEPARATELY FROM THE HTTP MIDDLEWARE: ``/mcp`` is mounted by
    ``McpPathRouter`` *outside* Django's WSGI/ASGI handler (see
    ``mcp_server.asgi_mount``), so ``MaintenanceModeMiddleware`` never sees an
    MCP request. Without this check, enabling maintenance mode would stop every
    human and every REST client but leave MCP agents writing cards into the
    database the operator is in the middle of migrating — the single scenario
    the feature exists to prevent.

    Site admins are exempt, matching ``MaintenanceModeMiddleware`` exactly. The
    acceptance criterion is that admins retain full read/write during
    maintenance, and it would be incoherent for the same admin PAT to be
    honored over REST and refused over MCP — an operator debugging why their
    migration script half-works does not need that puzzle. Non-admin agents are
    frozen, which is the case that matters: it is what stops a fleet of bots
    writing cards into the database an operator is mid-migration on.
    """
    active, message = get_maintenance_state()
    if not active:
        return None
    if getattr(get_current_user(), "is_site_admin", False):
        return None
    return {"error": {
        "code": "maintenance_mode",
        "detail": get_maintenance_message(message),
    }}


def _require_demo_off():
    """Return a structured denial dict while ``DEMO_MODE`` is on, else None (#1179).

    ``/mcp`` is mounted outside Django's handler, so ``DemoModeMiddleware``
    never sees it. Unlike the REST fence there is no allowlist here: every MCP
    write is refused, a site admin's included — the demo has no use for agent
    writes, and PAT creation is already refused by the REST fence, so this is
    defense in depth. A settings read only, so no ``sync_to_async`` is needed.
    """
    if getattr(settings, "DEMO_MODE", False) is False:
        return None
    return {"error": {"code": DEMO_READ_ONLY_CODE, "detail": DEMO_READ_ONLY_DETAIL}}


async def _deny_write():
    """Run every gate a write tool must pass; return a denial dict or None.

    Every gate runs through this one helper so a future write tool cannot
    accidentally pick up the scope check and miss the demo fence (#1179) or
    the maintenance check. The
    maintenance check is wrapped in ``sync_to_async`` because it reads the
    Django cache (and, on a cold cache, the database), which is blocking.
    """
    denial = _require_write_scope() or _require_demo_off()
    if denial is not None:
        return denial
    return await sync_to_async(_require_maintenance_off, thread_sensitive=True)()


def _sent_argument_names(ctx):
    """Return the argument names the client actually sent, undeclared ones included.

    The SDK validates ``tools/call`` arguments into a pydantic model that
    ignores keys the tool does not declare (mcp 2.3.0), so a tool function
    never sees them. ``ServerRequestContext.params`` is the raw request
    params mapping, a public field, so a tool can still tell that a removed
    argument such as ``assignee_email`` was sent and refuse the call (#2004)
    instead of dropping it. Deliberately NOT a ServerMiddleware rejecting
    every undeclared argument: the SDK documents that middleware shape as
    subject to change within 2.x, and rejecting all unknown arguments would
    be a much wider contract than the one removed name needs.
    """
    try:
        params = ctx.request_context.params or {}
    except ValueError:
        # No request context: the tool was invoked outside a client request
        # (MCPServer.call_tool called directly), so there is no raw input.
        return ()
    arguments = params.get("arguments") or {}
    return tuple(arguments) if isinstance(arguments, Mapping) else ()


def _throttled(*, compute=False, as_resource=False):
    """Wrap an MCP tool/resource function with per-token throttling (#1177).

    Applied at every ``@mcp.tool()``/``@mcp.resource()`` registration in
    :func:`build_mcp_server` below, directly under that decorator — the module
    docstring's "#1177 throttling" note explains what protects a future
    registration that forgets it.

    Runs BEFORE every other gate (``_deny_write``, and the RBAC checks inside
    ``tools.py``) so an over-limit caller is turned away without spending a
    query on those. The baseline bucket (``throttling.check_read``) applies to
    every wrapped call; the compute bucket (``throttling.check_compute``) is
    ADDITIONAL and only checked when ``compute=True``, for the calls #1177
    names as expensive (``list_cards``, ``board_snapshot``). A compute-bucket
    call spends a unit from both buckets, never one or the other.

    For a tool, the wrapper also passes every result (the denial included)
    through :func:`_as_tool_result`, so an ``{"error": {...}}`` return from
    any gate or tool goes out as ``isError=true`` with the payload intact in
    ``structuredContent`` (#2004). Riding on this wrapper is deliberate: it
    is the one decorator every tool already must carry, and the throttle
    coverage test proves every registered tool goes through it.

    ``as_resource`` must be set for the two ``@mcp.resource()``-registered
    functions (``board_resource``, ``card_resource``). Tools signal a denial
    by RETURNING the structured ``{"error": {...}}`` dict — the established
    convention every other gate here (``_require_write_scope``,
    ``_require_maintenance_off``) already uses. Resources cannot
    use that channel at all: per tools.py's "Resources (#513)" section, the
    pinned SDK treats ANY non-exception return from a resource function —
    including this exact dict — as successful content and JSON-serializes it
    verbatim, which would make a throttled call look like a 200 whose payload
    happens to be an error. Raising is the only way a resource can surface a
    real failure, so ``as_resource=True`` raises ``ResourceError`` with the same
    detail text (including the retry hint) instead of returning it, mirroring
    ``board_snapshot``/``card_detail``'s own not-found convention.

    ``functools.wraps`` is not just cosmetic here: FastMCP's
    ``Tool.from_function``/``ResourceTemplate.from_function`` build the JSON
    schema via ``inspect.signature(fn)``, which follows a wrapper's
    ``__wrapped__`` attribute by default — so the generic ``(*args, **kwargs)``
    signature below never reaches the schema builder; the original function's
    real parameters and ``_TOOL_RESULT``/``dict`` return annotation do, and the
    tool's declared input/output schema is unaffected by being wrapped.
    """
    def decorator(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            denial = await throttling.check_read()
            if denial is None and compute:
                denial = await throttling.check_compute()
            if denial is not None:
                if as_resource:
                    raise ResourceError(denial["error"]["detail"])
                return _as_tool_result(denial)
            out = await fn(*args, **kwargs)
            return out if as_resource else _as_tool_result(out)
        return wrapper
    return decorator


def _build_transport_security():
    """Bind MCP's DNS-rebinding protection to Django's own host/origin config.

    The SDK validates Host and Origin headers to stop a malicious web page from
    using DNS rebinding to reach this server from a victim's browser. Deriving
    the allowlist from ALLOWED_HOSTS keeps one source of truth rather than a
    second list that drifts out of sync with the deployment's real hostnames.

    ``MCP_ALLOWED_HOSTS`` overrides that derivation. It exists for the
    ``ALLOWED_HOSTS = ["*"]`` case: a wildcard there is a common self-hosting
    shortcut (often just masking a reverse-proxy Host mismatch), and the two
    settings guard different threats — Django trusting a claimed Host server
    side is not the same question as a browser-resident attacker rebinding DNS.
    Inheriting the wildcard would silently turn this protection off, so instead
    the operator is warned and asked to name the hosts explicitly.
    """
    configured = [h for h in getattr(settings, "MCP_ALLOWED_HOSTS", []) if h]
    allowed_origins = list(getattr(settings, "CORS_ALLOWED_ORIGINS", []) or [])

    if not configured:
        allowed_hosts = [h for h in getattr(settings, "ALLOWED_HOSTS", []) if h]
        if "*" in allowed_hosts:
            logger.warning(
                "ALLOWED_HOSTS contains '*', which cannot be used as an MCP "
                "DNS-rebinding allowlist. Set MCP_ALLOWED_HOSTS to the "
                "hostnames clients reach /mcp on. Until then only Origin "
                "checking from CORS_ALLOWED_ORIGINS applies."
            )
            allowed_hosts = [h for h in allowed_hosts if h != "*"]
        configured = allowed_hosts

    # Hosts are matched with their port, which ALLOWED_HOSTS entries omit.
    expanded = []
    for host in configured:
        expanded.extend([host, f"{host}:*"])

    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=expanded,
        allowed_origins=allowed_origins,
    )


def build_mcp_server():
    """Construct the MCPServer (formerly FastMCP) server with every OSS tool registered."""
    # version: mcp 2.x defaults serverInfo.version to "" (1.x reported the SDK
    # version), so surface the app's own version as clients' handshake value.
    mcp = MCPServer(SERVER_NAME, version=settings.APP_VERSION)

    @mcp.tool(
        name="list_boards",
        description=(
            "List every Visiban board the authenticated user can access, with "
            "their effective role and column, swimlane, and card counts."
        ),
    )
    @_throttled()
    async def list_boards() -> _TOOL_RESULT:
        # The tool surface is async (the MCP server runs on the event loop),
        # but the implementation is sync ORM code. thread_sensitive=True keeps
        # it on the sync worker thread that owns Django's DB connection, and
        # sync_to_async propagates the contextvars the auth middleware set, so
        # get_current_user() still resolves inside the thread.
        return await sync_to_async(tools.list_boards, thread_sensitive=True)()

    # ── Read tools (#512) — all board roles, no extra scope beyond mcp:read ──

    @mcp.tool(
        name="list_columns",
        description=(
            "List a board's columns (id, name, position, color, wip_limit, card_count), ordered by "
            "position. wip_limit is checked on move_card only, so card_count can exceed it."
        ),
    )
    @_throttled()
    async def list_columns(board_id: int) -> _TOOL_RESULT:
        return await sync_to_async(tools.list_columns, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_swimlanes",
        description=(
            "List a board's swimlanes (id, name, position, color, card_count, is_collapsed), "
            "ordered by position. contact_email is included only for admin/site_admin callers."
        ),
    )
    @_throttled()
    async def list_swimlanes(board_id: int) -> _TOOL_RESULT:
        return await sync_to_async(tools.list_swimlanes, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_cards",
        description=(
            "List a board's cards, optionally filtered by column_id, swimlane_id, assignee "
            "(username), priority, or label (name); include_archived defaults to false. "
            "Users are identified by username and display_name, matching the REST API. "
            "Returns at most 200 cards as an array. When more match, the result "
            "carries an extra text block (\"Showing N of M cards; call again with "
            "offset=K\") and _meta {\"visiban/total\", \"visiban/truncated\"}; page "
            "with limit (max 200) / offset. include_meta=true returns "
            "{cards, total, truncated, limit, offset} instead of an array."
        ),
    )
    @_throttled(compute=True)
    async def list_cards(
        board_id: int,
        column_id: int | None = None,
        swimlane_id: int | None = None,
        assignee: str | None = None,
        priority: str | None = None,
        label: str | None = None,
        include_archived: bool = False,
        limit: int | None = None,
        offset: int | None = None,
        include_meta: bool = False,
    ) -> _TOOL_RESULT:
        # Ask tools for the meta envelope always, then shape it here: a bare
        # array has nowhere to carry a truncation signal, so a truncated plain
        # call is signaled in-band (extra text block + _meta) while its
        # structuredContent stays the unchanged {"result": [...]} (#1762).
        # An untruncated call returns the plain list, which the SDK renders
        # byte-identically to before.
        out = await sync_to_async(tools.list_cards, thread_sensitive=True)(
            board_id=board_id, column_id=column_id, swimlane_id=swimlane_id,
            assignee=assignee, priority=priority, label=label,
            include_archived=include_archived, limit=limit, offset=offset,
            include_meta=True,
        )
        if "error" in out or include_meta:
            # An error payload (made isError=true by _throttled's
            # _as_tool_result), or the explicit envelope: pass through.
            return out
        rows = out["cards"]
        # limit=0 is an explicit total-only request (use include_meta); a
        # "call again with offset=0" hint there would loop with no progress.
        if not out["truncated"] or not rows:
            return rows
        shown, total = len(rows), out["total"]
        # Same per-card rendering the SDK applies to a returned list (indent=2
        # JSON, one block per card); a test asserts byte-identity against the
        # SDK's own helper so an SDK bump that changes it is caught.
        content = [
            TextContent(type="text", text=pydantic_core.to_json(row, fallback=str, indent=2).decode())
            for row in rows
        ] + [TextContent(
            type="text",
            text=f"Showing {shown} of {total} cards; call again with offset={out['offset'] + shown}",
        )]
        return CallToolResult(
            content=content,
            structured_content={"result": rows},
            meta={"visiban/total": total, "visiban/truncated": True},
        )

    # ── Resources (#513) — board:// and card://, all board roles ──
    #
    # Registered as templates (a `{param}` placeholder in the URI) rather
    # than tools: an agent reads one of these to load a whole board or card's
    # context in a single round trip instead of chaining several list_*
    # calls. The parameter name must match the URI placeholder exactly
    # (`board_id`/`card_id`) — MCPServer.resource() raises at registration time
    # otherwise. See tools.py's "Resources (#513)" section for why these
    # raise ResourceError on failure instead of returning `{"error": ...}` like
    # the tools above: resource reads have no structured-error channel here.

    @mcp.resource(
        "board://{board_id}",
        name="board",
        mime_type="application/json",
        description=(
            "Read-only board snapshot: metadata, columns, swimlanes, up to 200 "
            "active cards, and labels — like list_columns + list_swimlanes + "
            "list_cards in one read. If the board has more than 200 active "
            "cards, cards_truncated is true and cards_total gives the real "
            "count; fetch the rest with list_cards (limit/offset). All board "
            "roles may read it."
        ),
    )
    @_throttled(compute=True, as_resource=True)
    async def board_resource(board_id: int) -> dict:
        try:
            return await sync_to_async(tools.board_snapshot, thread_sensitive=True)(board_id=board_id)
        except ValueError as exc:
            # tools.py stays SDK-free and raises ValueError; MCP 2.x only
            # preserves the message for ResourceError.
            raise ResourceError(str(exc)) from None

    @mcp.resource(
        "card://{card_id}",
        name="card",
        mime_type="application/json",
        description=(
            "Card detail plus full audit history: movements, activities, "
            "comments, and checklist items. Requires membership on the "
            "card's board."
        ),
    )
    @_throttled(as_resource=True)
    async def card_resource(card_id: int) -> dict:
        try:
            return await sync_to_async(tools.card_detail, thread_sensitive=True)(card_id=card_id)
        except ValueError as exc:
            raise ResourceError(str(exc)) from None

    # ── Write tools (#512) — admin/member only (enforced in the service
    # layer); additionally require the mcp:write scope (enforced here, see
    # _require_write_scope's docstring for why it lives at this layer). ──

    @mcp.tool(
        name="create_card",
        description=(
            "Create a card in a column/swimlane cell, appended to the end unless position "
            "is given. Requires admin or member board role and the mcp:write scope. "
            "Enforces the column's WIP and weight limits exactly as move_card does, with no "
            "override: a create into a full column returns a structured "
            "wip_limit_exceeded/wip_hard_blocked/weight_limit_exceeded error. "
            "assignee is the username of an assignable board member."
        ),
    )
    @_throttled()
    async def create_card(
        ctx: Context,
        board_id: int,
        column_id: int,
        swimlane_id: int,
        title: str,
        description: str | None = None,
        priority: str | None = None,
        assignee: str | None = None,
        labels: list[str] | None = None,
        due_date: str | None = None,
        position: int | None = None,
    ) -> _TOOL_RESULT:
        # ctx is injected by the SDK and is not part of the input schema;
        # it is only here to see undeclared arguments (_sent_argument_names).
        denial = await _deny_write() or tools.reject_removed_arguments(_sent_argument_names(ctx))
        if denial is not None:
            return denial
        return await sync_to_async(tools.create_card, thread_sensitive=True)(
            board_id=board_id, column_id=column_id, swimlane_id=swimlane_id, title=title,
            description=description, priority=priority, assignee=assignee,
            labels=labels, due_date=due_date, position=position,
        )

    @mcp.tool(
        name="move_card",
        description=(
            "Move a card to a new column and/or swimlane and/or position. At least one of "
            "to_column_id/to_swimlane_id is required. Enforces WIP/weight limits with no "
            "override. Requires admin or member board role and the mcp:write scope."
        ),
    )
    @_throttled()
    async def move_card(
        card_id: int,
        to_column_id: int | None = None,
        to_swimlane_id: int | None = None,
        position: int = 0,
    ) -> _TOOL_RESULT:
        denial = await _deny_write()
        if denial is not None:
            return denial
        return await sync_to_async(tools.move_card, thread_sensitive=True)(
            card_id=card_id, to_column_id=to_column_id, to_swimlane_id=to_swimlane_id,
            position=position,
        )

    @mcp.tool(
        name="update_card",
        description=(
            "Update a card's title/description/priority/assignee/labels/due_date. "
            "assignee is a username; an empty string unassigns. "
            "Cannot change column/swimlane — use move_card. Requires admin or member board "
            "role and the mcp:write scope."
        ),
    )
    @_throttled()
    async def update_card(
        ctx: Context,
        card_id: int,
        title: str | None = None,
        description: str | None = None,
        priority: str | None = None,
        assignee: str | None = None,
        labels: list[str] | None = None,
        due_date: str | None = None,
    ) -> _TOOL_RESULT:
        # See create_card for ctx.
        denial = await _deny_write() or tools.reject_removed_arguments(_sent_argument_names(ctx))
        if denial is not None:
            return denial
        return await sync_to_async(tools.update_card, thread_sensitive=True)(
            card_id=card_id, title=title, description=description, priority=priority,
            assignee=assignee, labels=labels, due_date=due_date,
        )

    @mcp.tool(
        name="archive_card",
        description=(
            "Soft-delete a card (idempotent). Requires admin or member board role and the "
            "mcp:write scope."
        ),
    )
    @_throttled()
    async def archive_card(card_id: int) -> _TOOL_RESULT:
        denial = await _deny_write()
        if denial is not None:
            return denial
        return await sync_to_async(tools.archive_card, thread_sensitive=True)(card_id=card_id)

    return mcp
