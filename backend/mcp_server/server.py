"""FastMCP server instance and tool registration.

This module is the ONLY place that touches the ``mcp`` SDK's API. Tool logic
lives in :mod:`mcp_server.tools` as plain functions returning plain dicts, so
when the MCP spec or SDK churns (the spec is young — transport rev 2025-03-26)
the blast radius is this file (#511).

Later waves register their tools here too:
    #512 CRUD tools, #513 resources — add a ``@_mcp.tool()`` wrapper that
    delegates to a plain function in ``tools.py``. Session-level authentication
    (identity, and the baseline ``mcp:read`` scope every request needs) is
    already handled by the transport middleware and needs no per-tool code.

    #512 additions: a WRITE tool is a narrower case than that comment
    originally covered, and does need one extra per-tool line — see
    ``_require_write_scope`` below and its docstring for why.
"""
import logging

from asgiref.sync import sync_to_async
from django.conf import settings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from accounts.models import SCOPE_MCP_WRITE

from . import tools
from .context import get_current_scopes

logger = logging.getLogger(__name__)

SERVER_NAME = "visiban"

# Every tool below that can return either its normal payload or a structured
# `{"error": {...}}` dict (see tools.py's module docstring, "Error contract")
# is registered with this exact return annotation, never a narrower one like
# `-> list[dict]`. Verified empirically against the pinned SDK version
# (mcp==1.30.0): FastMCP builds a strict output schema from the annotation and
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
    """Construct the FastMCP server with every OSS tool registered."""
    mcp = FastMCP(
        SERVER_NAME,
        # Stateless: every request is self-contained, with no server-side
        # session to pin a client to one process. Visiban ships a Helm chart
        # and runs multiple Daphne workers, so a stateful session created on
        # one pod would 404 on the next request routed elsewhere unless the
        # operator configured sticky sessions. Stateless avoids that entirely.
        stateless_http=True,
        streamable_http_path="/",
        transport_security=_build_transport_security(),
    )

    @mcp.tool(
        name="list_boards",
        description=(
            "List every Visiban board the authenticated user can access, with "
            "their effective role and column, swimlane, and card counts."
        ),
    )
    async def list_boards() -> list[dict]:
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
    async def list_columns(board_id: int) -> _TOOL_OUTPUT:
        return await sync_to_async(tools.list_columns, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_swimlanes",
        description=(
            "List a board's swimlanes (id, name, position, color, card_count, is_collapsed), "
            "ordered by position. contact_email is included only for admin/site_admin callers."
        ),
    )
    async def list_swimlanes(board_id: int) -> _TOOL_OUTPUT:
        return await sync_to_async(tools.list_swimlanes, thread_sensitive=True)(board_id=board_id)

    @mcp.tool(
        name="list_cards",
        description=(
            "List a board's cards, optionally filtered by column_id, swimlane_id, assignee "
            "(email), priority, or label (name); include_archived defaults to false."
        ),
    )
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
        denial = _require_write_scope()
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
    async def move_card(
        card_id: int,
        to_column_id: int | None = None,
        to_swimlane_id: int | None = None,
        position: int = 0,
    ) -> _TOOL_OUTPUT:
        denial = _require_write_scope()
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
    async def update_card(
        card_id: int,
        title: str | None = None,
        description: str | None = None,
        priority: str | None = None,
        assignee_email: str | None = None,
        labels: list[str] | None = None,
        due_date: str | None = None,
    ) -> _TOOL_OUTPUT:
        denial = _require_write_scope()
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
    async def archive_card(card_id: int) -> _TOOL_OUTPUT:
        denial = _require_write_scope()
        if denial is not None:
            return denial
        return await sync_to_async(tools.archive_card, thread_sensitive=True)(card_id=card_id)

    return mcp
