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

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _has_surrogate(value):
    if isinstance(value, str):
        return any("\ud800" <= ch <= "\udfff" for ch in value)
    if isinstance(value, dict):
        return any(_has_surrogate(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_surrogate(v) for v in value)
    return False


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


class MapBodyHookTests(unittest.TestCase):
    @staticmethod
    def _operation(*media_types):
        return SimpleNamespace(body=[SimpleNamespace(media_type=m) for m in media_types])

    def _hit(self, operation):
        body = _find_injecting_body(lambda i: {"name": f"n{i}"})
        return sur.map_body(SimpleNamespace(operation=operation), body) != body

    def test_applies_to_json_only_operations(self):
        self.assertTrue(self._hit(self._operation("application/json")))
        self.assertTrue(self._hit(self._operation("application/json; charset=utf-8", "application/vnd.api+json")))

    def test_skips_operations_that_can_serialize_a_body_as_a_form(self):
        for media in (("multipart/form-data",), ("application/x-www-form-urlencoded",), ("application/json", "multipart/form-data")):
            with self.subTest(media=media):
                self.assertFalse(self._hit(self._operation(*media)))

    def test_skips_operations_without_a_body_or_context(self):
        self.assertFalse(self._hit(self._operation()))
        self.assertEqual(sur.map_body(SimpleNamespace(operation=None), {"a": "b"}), {"a": "b"})


_SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "surrogate control", "version": "1"},
    "paths": {
        "/echo": {
            "post": {
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {
                                "type": "object",
                                "required": ["name"],
                                "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 30}},
                                "additionalProperties": False,
                            }
                        }
                    },
                },
                "responses": {"200": {"description": "ok"}, "400": {"description": "bad"}},
            }
        }
    },
}


def _make_handler(crash_on_surrogate):
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

    def _run_st(self, crash_on_surrogate):
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), _make_handler(crash_on_surrogate))
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
