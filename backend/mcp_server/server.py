"""FastMCP server instance and tool registration.

This module is the ONLY place that touches the ``mcp`` SDK's API. Tool logic
lives in :mod:`mcp_server.tools` as plain functions returning plain dicts, so
when the MCP spec or SDK churns (the spec is young — transport rev 2025-03-26)
the blast radius is this file (#511).

Later waves register their tools here too:
    #512 CRUD tools, #513 resources — add a ``@_mcp.tool()`` wrapper that
    delegates to a plain function in ``tools.py``. Authentication is already
    handled by the transport middleware; no per-tool auth code is needed.
"""
from asgiref.sync import sync_to_async
from django.conf import settings
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from . import tools

SERVER_NAME = "visiban"


def _build_transport_security():
    """Bind MCP's DNS-rebinding protection to Django's own host/origin config.

    The SDK validates Host and Origin headers to stop a malicious page from
    driving a local MCP server. Deriving the allowlists from ALLOWED_HOSTS and
    CORS_ALLOWED_ORIGINS keeps one source of truth rather than a second list
    that drifts out of sync with the deployment's real hostnames.
    """
    allowed_hosts = [h for h in getattr(settings, "ALLOWED_HOSTS", []) if h]
    allowed_origins = list(getattr(settings, "CORS_ALLOWED_ORIGINS", []) or [])

    # A wildcard in ALLOWED_HOSTS means the operator has already accepted any
    # Host; mirroring that here keeps the transport from being stricter than
    # the deployment it runs in and silently 421-ing every request.
    if "*" in allowed_hosts:
        return TransportSecuritySettings(enable_dns_rebinding_protection=False)

    # Hosts are matched with their port, which ALLOWED_HOSTS entries omit.
    expanded = []
    for host in allowed_hosts:
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

    return mcp
