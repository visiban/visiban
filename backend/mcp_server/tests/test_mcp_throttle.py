"""Tests for the MCP per-token throttle (#1177).

Same MCP_SERVER_ENABLED skip-guard as test_mcp.py, and the harness classes
below (McpTestCase/McpRequest/_parse_sse) are imported from there rather than
duplicated, so the two files cannot drift apart on how a request is driven.
"""
import pytest
from django.conf import settings

if not settings.MCP_SERVER_ENABLED:  # pragma: no cover - exercised only in the flagged CI job
    pytest.skip(
        "MCP server disabled; set MCP_SERVER_ENABLED=true to run these.",
        allow_module_level=True,
    )

import time

from django.core.cache import cache
from django.core.exceptions import ImproperlyConfigured
from django.test import TestCase, override_settings

from accounts.models import SCOPE_MCP_READ, PersonalAccessToken
from boards.tests.conftest import _make_board, _make_column, _make_swimlane, _make_user
from mcp_server import throttling
from mcp_server.context import (
    get_current_token_id, reset_current_token_id, set_current_token_id,
)

from .test_mcp import McpTestCase, _parse_sse


class BucketUnitTests(TestCase):
    """Direct tests of McpTokenBucket, with no ASGI/JSON-RPC machinery.

    These exercise the fail-closed rules from #1075 in isolation, since they
    are otherwise awkward to trigger through the full transport (a bad rate
    setting or a missing context binding should never occur on a request that
    made it through BearerAuthMiddleware).
    """

    def setUp(self):
        super().setUp()
        cache.clear()

    def _bucket(self, setting_name="MCP_THROTTLE_READ_RATE", default_rate="300/min"):
        return throttling.McpTokenBucket(
            bucket_name="test_bucket", setting_name=setting_name, default_rate=default_rate,
        )

    def test_missing_setting_falls_back_to_default(self):
        """An explicitly-None setting must not disable the limit."""
        with override_settings(MCP_THROTTLE_READ_RATE=None):
            bucket = self._bucket(default_rate="1/min")
            token = set_current_token_id(4242)
            try:
                self.assertIsNone(bucket.check())  # first call: allowed
                denial = bucket.check()  # second call within the window: denied
            finally:
                reset_current_token_id(token)
        self.assertIsNotNone(denial)
        self.assertEqual(denial["error"]["code"], "throttled")

    def test_unparseable_setting_raises_improperly_configured(self):
        # Raised from construction, not check(): McpTokenBucket validates
        # eagerly at __init__ too (see its docstring) so that a real
        # deployment — which builds these as module-level singletons at ASGI
        # app construction — fails at startup, not on whichever request
        # happens to be first.
        with override_settings(MCP_THROTTLE_READ_RATE="not-a-rate"):
            with self.assertRaises(ImproperlyConfigured):
                self._bucket()

    def test_non_positive_count_raises_improperly_configured(self):
        with override_settings(MCP_THROTTLE_READ_RATE="0/min"):
            with self.assertRaises(ImproperlyConfigured):
                self._bucket()

    def test_missing_token_identity_denies(self):
        """No test in this class binds a token id, so context is unbound."""
        self.assertIsNone(get_current_token_id())
        bucket = self._bucket()
        denial = bucket.check()
        self.assertIsNotNone(denial)
        self.assertEqual(denial["error"]["code"], "throttled")


class ThrottleIntegrationTestCase(McpTestCase):
    """Shared fixture: a board a compute-bucket tool (list_cards) can read."""

    def setUp(self):
        super().setUp()
        self.board = _make_board(self.user, name="Throttle board")
        _make_column(self.board, name="Backlog", order=0)
        _make_swimlane(self.board, name="General", order=0)

    def _call(self, token):
        return self._tools_call("list_boards", token)

    def _result(self, body):
        payload = _parse_sse(body)
        self.assertNotIn("error", payload, payload)
        return payload["result"]["structuredContent"]["result"]


class LimitReachedTests(ThrottleIntegrationTestCase):
    def test_calls_within_the_limit_succeed(self):
        with override_settings(MCP_THROTTLE_READ_RATE="2/min"):
            for _ in range(2):
                status, body = self._call(self.raw_token)
                self.assertEqual(status, 200)
                self.assertIn("result", _parse_sse(body))
                self.assertNotIn("error", self._result(body))

    def test_call_over_the_limit_is_denied_with_retry_hint(self):
        with override_settings(MCP_THROTTLE_READ_RATE="2/min"):
            self._call(self.raw_token)
            self._call(self.raw_token)
            status, body = self._call(self.raw_token)
            self.assertEqual(status, 200)  # a throttle denial is a normal tool result, not a transport failure
            result = self._result(body)
            self.assertEqual(result["error"]["code"], "throttled")
            self.assertIn("retry_after", result["error"])
            self.assertGreater(result["error"]["retry_after"], 0)


class ResetAfterWindowTests(ThrottleIntegrationTestCase):
    def test_the_bucket_refills_once_the_window_elapses(self):
        with override_settings(MCP_THROTTLE_READ_RATE="1/s"):
            self._call(self.raw_token)  # consumes the one call this window allows
            _, body = self._call(self.raw_token)
            self.assertEqual(self._result(body)["error"]["code"], "throttled")

            time.sleep(1.1)

            _, body = self._call(self.raw_token)
            self.assertNotIn("error", self._result(body))


class PerTokenIsolationTests(ThrottleIntegrationTestCase):
    def test_one_tokens_exhaustion_does_not_affect_another(self):
        other_user = _make_user("mcp-other")
        _, other_raw = PersonalAccessToken.generate(
            other_user, "mcp-other", scopes=[SCOPE_MCP_READ]
        )

        with override_settings(MCP_THROTTLE_READ_RATE="1/min"):
            self._call(self.raw_token)
            _, denied_body = self._call(self.raw_token)
            self.assertEqual(self._result(denied_body)["error"]["code"], "throttled")

            # A different token — and thus a different cache key — is unaffected.
            _, other_body = self._call(other_raw)
            self.assertNotIn("error", self._result(other_body))


class ComputeBucketTests(ThrottleIntegrationTestCase):
    def test_compute_bucket_gates_list_cards_additionally(self):
        with override_settings(
            MCP_THROTTLE_READ_RATE="9999/min", MCP_THROTTLE_COMPUTE_RATE="1/min",
        ):
            status, body = self._tools_call(
                "list_cards", self.raw_token, {"board_id": self.board.id},
            )
            self.assertNotIn("error", self._result(body))

            status, body = self._tools_call(
                "list_cards", self.raw_token, {"board_id": self.board.id},
            )
            self.assertEqual(self._result(body)["error"]["code"], "throttled")

    def test_compute_bucket_exhaustion_does_not_block_a_plain_read_tool(self):
        """The two buckets stack; they are not a shared pool."""
        with override_settings(
            MCP_THROTTLE_READ_RATE="9999/min", MCP_THROTTLE_COMPUTE_RATE="1/min",
        ):
            self._tools_call("list_cards", self.raw_token, {"board_id": self.board.id})
            # Second list_cards call is denied by the compute bucket...
            _, body = self._tools_call(
                "list_cards", self.raw_token, {"board_id": self.board.id},
            )
            self.assertEqual(self._result(body)["error"]["code"], "throttled")
            # ...but list_boards, which never touches the compute bucket, is not.
            _, body = self._call(self.raw_token)
            self.assertNotIn("error", self._result(body))


class ResourceThrottleTests(ThrottleIntegrationTestCase):
    """`board://`/`card://` denials raise, unlike a tool's returned dict.

    See `server._throttled`'s `as_resource` branch and tools.py's "Resources
    (#513)" section: the pinned SDK gives a resource read no
    isError/structuredContent channel, so a throttle denial there must be a
    raised exception (surfaced as a top-level JSON-RPC error) rather than the
    `{"error": {...}}` dict every tool above returns.
    """

    def test_board_resource_denial_is_a_jsonrpc_error_with_retry_hint(self):
        with override_settings(MCP_THROTTLE_READ_RATE="1/min"):
            self._read_resource(f"board://{self.board.id}", self.raw_token)  # spends the one call
            status, body = self._read_resource(f"board://{self.board.id}", self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertIn("error", payload, payload)
        self.assertIn("Rate limit exceeded", payload["error"]["message"])
        self.assertIn("Retry after", payload["error"]["message"])

    def test_card_resource_baseline_bucket_also_applies(self):
        with override_settings(MCP_THROTTLE_READ_RATE="1/min"):
            self._read_resource("card://1", self.raw_token)  # spends the one call
            status, body = self._read_resource("card://1", self.raw_token)
        self.assertEqual(status, 200)
        payload = _parse_sse(body)
        self.assertIn("error", payload, payload)
        self.assertIn("Rate limit exceeded", payload["error"]["message"])


class ThrottleCoverageTests(ThrottleIntegrationTestCase):
    """Every registered tool and resource must go through the same baseline gate.

    Rather than inspect FastMCP's internal registries for a marker attribute
    (which would have to see through both `functools.wraps` and the SDK's own
    wrapping), this drives the real transport: it discovers every tool and
    resource template the running server actually advertises, exhausts the
    shared baseline bucket with the FIRST one, and asserts every OTHER
    registered tool/resource is also denied. A future tool registered without
    `@_throttled()` would reach its real implementation instead and fail this
    assertion (most likely with something other than a clean "throttled"
    denial, since the arguments below are placeholders, not real IDs).
    """

    # Placeholder, syntactically-valid arguments. A throttled call never
    # reaches the tool's own argument validation/lookup, so these do not need
    # to reference real objects — only to satisfy the declared parameter
    # types so the SDK's own schema validation doesn't reject the call before
    # our wrapper ever runs.
    _TOOL_ARGS = {
        "list_boards": {},
        "list_columns": {"board_id": 1},
        "list_swimlanes": {"board_id": 1},
        "list_cards": {"board_id": 1},
        "create_card": {
            "board_id": 1, "column_id": 1, "swimlane_id": 1, "title": "x",
        },
        "move_card": {"card_id": 1, "to_column_id": 1},
        "update_card": {"card_id": 1, "title": "x"},
        "archive_card": {"card_id": 1},
    }

    def _tool_names(self, token):
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, token=token,
        )
        self.assertEqual(status, 200)
        return [t["name"] for t in _parse_sse(body)["result"]["tools"]]

    def _resource_uris(self, token):
        status, body = self.client_.post(
            {"jsonrpc": "2.0", "id": 1, "method": "resources/templates/list"}, token=token,
        )
        self.assertEqual(status, 200)
        templates = _parse_sse(body)["result"]["resourceTemplates"]
        return [t["uriTemplate"] for t in templates]

    def test_every_tool_and_resource_is_denied_once_the_baseline_bucket_is_spent(self):
        tool_names = self._tool_names(self.raw_token)
        resource_uris = self._resource_uris(self.raw_token)
        self.assertTrue(tool_names)
        self.assertTrue(resource_uris)

        with override_settings(MCP_THROTTLE_READ_RATE="1/min", MCP_THROTTLE_COMPUTE_RATE="9999/min"):
            # Spend the one allowed call on the first discovered tool.
            first, remaining_tools = tool_names[0], tool_names[1:]
            status, body = self._tools_call(first, self.raw_token, self._TOOL_ARGS.get(first, {}))
            self.assertEqual(status, 200)

            for name in remaining_tools:
                status, body = self._tools_call(name, self.raw_token, self._TOOL_ARGS.get(name, {}))
                self.assertEqual(status, 200, name)
                result = self._result(body)
                self.assertEqual(
                    result.get("error", {}).get("code"), "throttled",
                    f"tool {name!r} was not denied by the exhausted baseline bucket: {result!r}",
                )

            for uri_template in resource_uris:
                uri = uri_template.replace("{board_id}", "1").replace("{card_id}", "1")
                status, body = self._read_resource(uri, self.raw_token)
                self.assertEqual(status, 200, uri)
                # Resources have no structured-error return path in the SDK
                # (tools.py's "Resources (#513)" section) — a throttle denial
                # is raised, not returned, so it surfaces as a top-level
                # JSON-RPC error rather than `result.contents` (see
                # server.py's `_throttled(as_resource=True)`).
                payload = _parse_sse(body)
                self.assertIn("error", payload, f"resource {uri!r} was not denied: {payload!r}")
                self.assertIn("Rate limit exceeded", payload["error"]["message"])
