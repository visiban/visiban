"""Tests for schemathesis_surrogates (#2121).

Two halves: the pure injection logic, and a negative control that drives the real
`st run` CLI at a stub server. The control is the acceptance proof: a handler that 500s on a
lone surrogate must make the run exit non-zero, and the same handler fixed must exit zero.
Without it the hook could silently stop reaching the wire and the job would stay green.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import schemathesis_surrogates as sur
from django.test import TestCase

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _has_surrogate(value):
    if isinstance(value, str):
        return any("\ud800" <= ch <= "\udfff" for ch in value)
    if isinstance(value, dict):
        return any(_has_surrogate(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_surrogate(v) for v in value)
    return False


def _hooks():
    # Lazy: schemathesis_hooks queries the DB at import time, which needs a TestCase.
    import importlib

    return importlib.import_module("schemathesis_hooks")


def _find_injecting_body(make):
    for i in range(500):
        body = make(i)
        if sur.inject_lone_surrogate(body) != body:
            return body
    raise AssertionError("no body was selected for injection in 500 tries")


class InjectLoneSurrogateTests(unittest.TestCase):
    def test_injects_into_roughly_one_in_n_bodies(self):
        hits = sum(sur.inject_lone_surrogate({"name": f"card {i}"}) != {"name": f"card {i}"} for i in range(1000))
        self.assertTrue(50 <= hits <= 200, hits)

    def test_result_holds_a_lone_surrogate_and_keeps_length(self):
        body = _find_injecting_body(lambda i: {"title": f"title-{i}", "n": i})
        out = sur.inject_lone_surrogate(body)
        self.assertTrue(_has_surrogate(out))
        self.assertEqual(len(out["title"]), len(body["title"]))
        self.assertEqual(out["n"], body["n"])

    def test_is_deterministic_for_replay_and_shrinking(self):
        body = _find_injecting_body(lambda i: {"title": f"t{i}"})
        self.assertEqual(sur.inject_lone_surrogate(body), sur.inject_lone_surrogate(body))

    def test_does_not_mutate_the_input(self):
        body = _find_injecting_body(lambda i: {"title": f"t{i}", "tags": ["a", "b"]})
        snapshot = json.loads(json.dumps(body))
        sur.inject_lone_surrogate(body)
        self.assertEqual(body, snapshot)

    def test_reaches_nested_strings_and_top_level_string_bodies(self):
        nested = _find_injecting_body(lambda i: {"outer": {"inner": [f"x{i}"]}})
        self.assertTrue(_has_surrogate(sur.inject_lone_surrogate(nested)))
        top = _find_injecting_body(lambda i: f"value-{i}")
        self.assertTrue(_has_surrogate(sur.inject_lone_surrogate(top)))

    def test_empty_string_becomes_a_lone_surrogate(self):
        body = _find_injecting_body(lambda i: {"k": "", "i": i})
        self.assertEqual(len(sur.inject_lone_surrogate(body)["k"]), 1)

    def test_passes_through_bodies_with_no_string(self):
        for body in (None, 5, True, {"a": 1, "b": [2, 3]}, [], {}, b"raw"):
            with self.subTest(body=body):
                self.assertEqual(sur.inject_lone_surrogate(body), body)

    def test_wire_form_is_the_ascii_json_escape(self):
        """requests uses json.dumps; the surrogate must travel as the \\udXXX escape."""
        body = _find_injecting_body(lambda i: {"name": f"n{i}"})
        wire = json.dumps(sur.inject_lone_surrogate(body)).encode()
        self.assertIn(b"\\ud", wire.lower())
        wire.decode("ascii")
        self.assertTrue(_has_surrogate(json.loads(wire)))


def _json_serializer():
    from schemathesis.transport.requests import REQUESTS_TRANSPORT

    return REQUESTS_TRANSPORT._serializers["application/json"]


class JsonSerializerWrapperTests(unittest.TestCase):
    """The wrapped serializer is what puts the surrogate on the wire, and only for JSON."""

    def test_serialized_body_carries_the_ascii_escape_for_selected_bodies(self):
        body = _find_injecting_body(lambda i: {"name": f"n{i}"})
        result = _json_serializer()(SimpleNamespace(case=None), body)
        wire = result["data"] if "data" in result else json.dumps(result["json"]).encode()
        self.assertRegex(wire.decode("ascii"), r"\\u[dD][89a-fA-F][0-9a-fA-F]{2}")

    def test_input_body_is_not_mutated(self):
        body = _find_injecting_body(lambda i: {"name": f"n{i}"})
        snapshot = json.loads(json.dumps(body))
        _json_serializer()(SimpleNamespace(case=None), body)
        self.assertEqual(body, snapshot)

    def test_unselected_bodies_serialize_unchanged(self):
        body = {"a": 1}
        result = _json_serializer()(SimpleNamespace(case=None), body)
        self.assertNotIn(b"\\u", result.get("data", b""))

    def test_real_case_reaches_the_wire_with_a_surrogate_and_stays_pristine(self):
        """End to end through a real Case: wire has the escape, `case.body` never holds a surrogate.

        The CLI re-validates a recorded case's body after the scenario and the validator
        UTF-8-encodes strings, so a surrogate left on `case.body` crashed `st run` in CI (#2121).
        """
        import schemathesis
        from schemathesis.transport.requests import REQUESTS_TRANSPORT

        operation = schemathesis.openapi.from_dict(_SPEC)["/echo"]["POST"]
        body = _find_injecting_body(lambda i: {"name": f"n{i}"})
        case = operation.Case(body=body, media_type="application/json")
        kwargs = REQUESTS_TRANSPORT.serialize_case(case, base_url="http://127.0.0.1:1")
        wire = kwargs["data"] if "data" in kwargs else json.dumps(kwargs["json"])
        wire = wire.decode("ascii") if isinstance(wire, bytes) else wire
        self.assertRegex(wire, r"\\u[dD][89a-fA-F][0-9a-fA-F]{2}")
        self.assertFalse(_has_surrogate(case.body))
        self.assertEqual(case.body, body)

    def test_form_and_multipart_serializers_are_not_wrapped(self):
        from schemathesis.transport.requests import REQUESTS_TRANSPORT

        for media in ("application/x-www-form-urlencoded", "multipart/form-data"):
            fn = REQUESTS_TRANSPORT._serializers.get(media)
            self.assertFalse(getattr(fn, "_injects_surrogates", False), media)

    def test_install_is_idempotent(self):
        before = _json_serializer()
        sur._install_json_serializer()
        self.assertIs(_json_serializer(), before)


class HookWiringTests(TestCase):
    """`st run` loads only schemathesis_hooks.py; it must pull the surrogate serializer in."""

    def test_schemathesis_hooks_imports_the_surrogate_module(self):
        # AttributeError here means the `import schemathesis_surrogates` line was removed.
        self.assertIs(_hooks().schemathesis_surrogates, sur)
        self.assertTrue(getattr(_json_serializer(), "_injects_surrogates", False))

    def test_hooks_file_names_the_import_statically(self):
        source = (BACKEND_DIR / "schemathesis_hooks.py").read_text()
        self.assertRegex(source, r"(?m)^import schemathesis_surrogates\b")


_BODY_SCHEMA = {
    "type": "object",
    "required": ["name"],
    "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 30}},
    "additionalProperties": False,
}

_SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "surrogate control", "version": "1"},
    "paths": {
        "/echo": {
            "post": {
                "requestBody": {
                    "required": True,
                    # The shape drf-spectacular emits for every serializer-bodied operation.
                    "content": {mt: {"schema": _BODY_SCHEMA} for mt in (
                        "application/json", "application/x-www-form-urlencoded", "multipart/form-data"
                    )},
                },
                "responses": {"200": {"description": "ok"}, "400": {"description": "bad"}},
            }
        }
    },
}


def _make_handler(crash_on_surrogate, reject_all_json=False):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._send(200, _SPEC)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if "json" not in self.headers.get("Content-Type", ""):
                return self._send(200, {"form": True})  # form/multipart: the hook must never touch these
            if reject_all_json:
                return self._send(400, {"detail": "always rejected"})
            try:
                body = json.loads(raw)
                name = body["name"]
                if not isinstance(name, str):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                return self._send(400, {"detail": "bad"})
            try:
                name.encode("utf-8")  # what a DB write or a log line does to the value
            except UnicodeEncodeError:
                if crash_on_surrogate:
                    return self._send(500, {"detail": "boom"})
                return self._send(400, {"name": ["invalid characters"]})
            self._send(200, {"name": name})

    return Handler


class SurrogateNegativeControlTests(unittest.TestCase):
    """Run the real CLI at a stub: a surrogate-triggered 500 fails the run, a fixed handler passes."""

    def _run_st(self, crash_on_surrogate, reject_all_json=False):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(crash_on_surrogate, reject_all_json))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            env = dict(os.environ, SCHEMATHESIS_HOOKS=str(BACKEND_DIR / "schemathesis_surrogates.py"))
            result = subprocess.run(
                [
                    sys.executable, "-m", "schemathesis.cli", "run",
                    f"http://127.0.0.1:{server.server_port}/",
                    "--seed", "1",
                    "--checks", "status_code_conformance",
                    "--phases", "fuzzing",
                    "--max-examples", "150",
                    # The CI job writes both reports; a surrogate must not crash their writers.
                    "--report", "junit,json",
                    "--report-junit-path", os.path.join(tmp, "junit.xml"),
                    "--report-json-path", os.path.join(tmp, "report.json"),
                    "--no-color",
                ],
                env=env, capture_output=True, text=True, timeout=120, check=False,
            )
        finally:
            server.shutdown()
            server.server_close()
        return result

    def test_surrogate_triggered_500_fails_the_run(self):
        result = self._run_st(crash_on_surrogate=True)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 1, output)
        self.assertNotIn("Traceback", output)
        self.assertIn("Received: 500", output)
        # The failing request carried the lone surrogate as the ASCII JSON escape.
        self.assertRegex(output, r"\\u[dD][89a-fA-F][0-9a-fA-F]{2}")

    def test_handler_that_rejects_a_surrogate_passes(self):
        result = self._run_st(crash_on_surrogate=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_post_scenario_warnings_path_does_not_crash_the_cli(self):
        """No positive case is accepted, so the CLI inspects every recorded case after the scenario.

        That path re-validates each case's body (`warnings.py` -> `_revalidate_metadata`) and
        crashed `st run` with `UnicodeEncodeError` when the surrogate lived on `case.body` (#2121,
        seen in CI). The recorded cases must stay pristine.
        """
        result = self._run_st(crash_on_surrogate=False, reject_all_json=True)
        output = result.stdout + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn("UnicodeEncodeError", output)
