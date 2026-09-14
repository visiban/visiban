from django.apps import AppConfig


class McpServerConfig(AppConfig):
    """Model Context Protocol (MCP) server app.

    The package is named ``mcp_server``, not ``mcp``, on purpose: every Django
    app under ``backend/`` is a top-level import root, so a local package named
    ``mcp`` would shadow the installed ``mcp`` SDK on ``sys.path`` and break
    every ``import mcp`` in the process (#511).

    This app holds no models — MCP callers authenticate with the existing
    ``accounts.PersonalAccessToken``, so there is no table and no migration.
    """

    default_auto_field = "django.db.models.BigAutoField"
    name = "mcp_server"
    verbose_name = "MCP Server"
