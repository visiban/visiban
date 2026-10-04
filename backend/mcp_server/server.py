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

from asgiref.sync import sync_to_async
from django.conf import settings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ResourceError
from mcp.server.transport_security import TransportSecuritySettings

from accounts.models import SCOPE_MCP_WRITE, get_maintenance_message, get_maintenance_state
from visiban.demo import DEMO_READ_ONLY_CODE, DEMO_READ_ONLY_DETAIL

from . import throttling, tools
from .context import get_current_scopes, get_current_user

logger = logging.getLogger(__name__)

SERVER_NAME = "visiban"

# Every tool below that can return either its normal payload or a structured
# `{"error": {...}}` dict (see tools.py's module docstring, "Error contract")
# is registered with this exact return annotation, never a narrower one like
# `-> list[dict]`. Verified empirically against the pinned SDK version
# (mcp 1.30.0, re-verified on 2.3.0): MCPServer (formerly
# FastMCP) builds a strict output schema from the annotation and
# validates every return against it. `list[dict]` alone rejects a dict-shaped
# error with a pydantic ValidationError, which the SDK then collapses to
# `isError=True` with only the exception text as content — silently discarding
# every structured field (`wip_limit`, `current_count`, `current_version`,
# ...) a calling agent needs, which is exactly the "structured error, not a
# 500" failure #512's acceptance criteria call out. `list[dict] | dict`
# validates either shape and still gives a populated `structuredContent`
# (`{"result": ...}`) on both success and failure, unlike omitting the
# annotation entirely (which drops `structuredContent` altogether and, for a
# list return, splits each item into its own unstructured content block).
_TOOL_OUTPUT = list[dict] | dict


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

    ``as_resource`` must be set for the two ``@mcp.resource()``-registered
    functions (``board_resource``, ``card_resource``). Tools signal a denial
    by RETURNING the structured ``{"error": {...}}`` dict — the established
    convention every other gate here (``_require_write_scope``,
    ``_require_maintenance_off``) already uses, and what keeps ``isError``
    false with the denial visible in ``structuredContent``. Resources cannot
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
    real parameters and ``_TOOL_OUTPUT``/``dict`` return annotation do, and the
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
                return denial
            return await fn(*args, **kwargs)
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
    mcp = MCPServer(SERVER_NAME)

    @mcp.tool(
        name="list_boards",
        description=(
            "List every Visiban board the authenticated user can access, with "
            "their effective role and column, swimlane, and card counts."
        ),
    )
    @_throttled()
    async def list_boards() -> _TOOL_OUTPUT:
        # The tool surface is async (the MCP server runs on the event loop),
        # but the implementation is sync ORM code. thread_sensitive=True keeps
        # it on the sync worker thread that owns Django's DB connection, and
        # sync_to_async propagates the contextvars the auth middleware set, so
        # get_current_user() still resolves inside the thread.
        return await sync_to_async(tools.list_boards, thread_sensitive=True)()

    # ── Read tools (#512) — all board roles, no extra scope beyond mcp:read ──

    @mcp.tool(
        name="list_columns",
        description="List a board's columns (id, name, position, color, wip_limit, card_count), ordered by position.",
    )
    @_throttled()
    async def list_columns(board_id: int) -> _TOOL_OUTPUT:
        return await sync_to_async(tools.list_columns, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_swimlanes",
        description=(
            "List a board's swimlanes (id, name, position, color, card_count, is_collapsed), "
            "ordered by position. contact_email is included only for admin/site_admin callers."
        ),
    )
    @_throttled()
    async def list_swimlanes(board_id: int) -> _TOOL_OUTPUT:
        return await sync_to_async(tools.list_swimlanes, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_cards",
        description=(
            "List a board's cards, optionally filtered by column_id, swimlane_id, assignee "
            "(email), priority, or label (name); include_archived defaults to false."
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
    ) -> _TOOL_OUTPUT:
        return await sync_to_async(tools.list_cards, thread_sensitive=True)(
            board_id=board_id, column_id=column_id, swimlane_id=swimlane_id,
            assignee=assignee, priority=priority, label=label,
            include_archived=include_archived,
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
            "Full read-only board snapshot: metadata, columns, swimlanes, "
            "active cards, and labels — equivalent to list_columns + "
            "list_swimlanes + list_cards in one read. All board roles may "
            "read it."
        ),
    )
    @_throttled(compute=True, as_resource=True)
    async def board_resource(board_id: int) -> dict:
        return await sync_to_async(tools.board_snapshot, thread_sensitive=True)(board_id=board_id)

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
        return await sync_to_async(tools.card_detail, thread_sensitive=True)(card_id=card_id)

    # ── Write tools (#512) — admin/member only (enforced in the service
    # layer); additionally require the mcp:write scope (enforced here, see
    # _require_write_scope's docstring for why it lives at this layer). ──

    @mcp.tool(
        name="create_card",
        description=(
            "Create a card in a column/swimlane cell, appended to the end unless position "
            "is given. Requires admin or member board role and the mcp:write scope."
        ),
    )
    @_throttled()
    async def create_card(
        board_id: int,
        column_id: int,
        swimlane_id: int,
        title: str,
        description: str | None = None,
        priority: str | None = None,
        assignee_email: str | None = None,
        labels: list[str] | None = None,
        due_date: str | None = None,
        position: int | None = None,
    ) -> _TOOL_OUTPUT:
        denial = await _deny_write()
        if denial is not None:
            return denial
        return await sync_to_async(tools.create_card, thread_sensitive=True)(
            board_id=board_id, column_id=column_id, swimlane_id=swimlane_id, title=title,
            description=description, priority=priority, assignee_email=assignee_email,
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
    ) -> _TOOL_OUTPUT:
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
            "Update a card's title/description/priority/assignee_email/labels/due_date. "
            "Cannot change column/swimlane — use move_card. Requires admin or member board "
            "role and the mcp:write scope."
        ),
    )
    @_throttled()
    async def update_card(
        card_id: int,
        title: str | None = None,
        description: str | None = None,
        priority: str | None = None,
        assignee_email: str | None = None,
        labels: list[str] | None = None,
        due_date: str | None = None,
    ) -> _TOOL_OUTPUT:
        denial = await _deny_write()
        if denial is not None:
            return denial
        return await sync_to_async(tools.update_card, thread_sensitive=True)(
            card_id=card_id, title=title, description=description, priority=priority,
            assignee_email=assignee_email, labels=labels, due_date=due_date,
        )

    @mcp.tool(
        name="archive_card",
        description=(
            "Soft-delete a card (idempotent). Requires admin or member board role and the "
            "mcp:write scope."
        ),
    )
    @_throttled()
    async def archive_card(card_id: int) -> _TOOL_OUTPUT:
        denial = await _deny_write()
        if denial is not None:
            return denial
        return await sync_to_async(tools.archive_card, thread_sensitive=True)(card_id=card_id)

    return mcp
