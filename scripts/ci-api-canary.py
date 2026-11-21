#!/usr/bin/env python3
"""Loopback GitLab-API canary for hermetic CI-script tests (#2461).

A dead CI_API_V4_URL fails closed exactly like a missing token, so a test that
quietly reaches the API with inherited CI variables (the #2412 class) still
passes. The canary replaces the dead endpoint with a live loopback listener that
answers every request with HTTP 200 `[]` and logs the request path. `verify`
fails the job when anything was logged: a test reached the API without setting
its own URL.

  eval "$(python3 scripts/ci-api-canary.py start --log F)"   # exports CI_API_V4_URL, CANARY_PID
  ... run the tests ...
  python3 scripts/ci-api-canary.py verify --log F --pid "$CANARY_PID"

Tests that run their own fake API (resolve-docs-version.test.sh `runapi`) set their
own CI_API_V4_URL and never touch the canary. POSIX/alpine friendly: stdlib only,
the listener is bound before forking so the exported port is always ready.
Usage: ci-api-canary.py start --log F | verify --log F [--pid N] | --self-test
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


def make_handler(log_path: str):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self):
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(f"{self.command} {self.path}\n")
            body = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _reply

        def log_message(self, *args):  # silence stderr noise
            pass

    return Handler


def start(log_path: str) -> int:
    open(log_path, "w").close()
    srv = HTTPServer(("127.0.0.1", 0), make_handler(log_path))
    port = srv.server_address[1]
    pid = os.fork()
    if pid == 0:  # child: serve until killed
        os.setsid()
        sys.stdin.close()
        devnull = os.open(os.devnull, os.O_RDWR)
        for fd in (0, 1, 2):
            os.dup2(devnull, fd)
        srv.serve_forever()
        os._exit(0)
    srv.socket.close()  # parent: the child owns the listener
    print(f"export CI_API_V4_URL=http://127.0.0.1:{port}/api/v4 CANARY_PID={pid}")
    return 0


def verify(log_path: str, pid: "int | None") -> int:
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    try:
        lines = [x for x in open(log_path, encoding="utf-8").read().splitlines() if x]
    except FileNotFoundError:
        print("ERROR: canary log missing; was `start` run?", file=sys.stderr)
        return 2
    if lines:
        print("FAIL: a test reached the API with inherited CI variables:", file=sys.stderr)
        for x in sorted(set(lines)):
            print(f"  {x}", file=sys.stderr)
        print("Make the test hermetic: set its own CI_API_V4_URL/token or unset the inherited ones. "
              "See docs/maintainers/known-ci-failures.md (Hermetic CI-script tests).", file=sys.stderr)
        return 1
    print("canary: no test reached the API.")
    return 0


def _self_test() -> int:
    import subprocess
    import tempfile
    import urllib.request

    problems = []
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "c.log")
        out = subprocess.run([sys.executable, __file__, "start", "--log", log], capture_output=True, text=True).stdout
        env = dict(kv.split("=", 1) for kv in out.split()[1:])
        pid = int(env["CANARY_PID"])
        if verify(log, None) != 0:
            problems.append("clean log must verify")
        with urllib.request.urlopen(env["CI_API_V4_URL"] + "/projects/1/issues", timeout=5) as r:
            if r.status != 200 or r.read() != b"[]":
                problems.append("canary must answer 200 []")
        if verify(log, pid) != 1:
            problems.append("a logged request must fail verify")
        try:
            os.kill(pid, 0)
            os.waitpid(pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        if verify(os.path.join(tmp, "missing.log"), None) != 2:
            problems.append("missing log must fail")
    if problems:
        print("self-test FAILED: " + "; ".join(problems), file=sys.stderr)
        return 1
    print("self-test OK")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return _self_test()
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["start", "verify"])
    ap.add_argument("--log", required=True)
    ap.add_argument("--pid", type=int)
    a = ap.parse_args()
    return start(a.log) if a.cmd == "start" else verify(a.log, a.pid)


if __name__ == "__main__":
    sys.exit(main())
