"""Scripted local HTTP server shared by the Python suites."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "contract" / "fixtures.json"


def load_fixtures() -> dict:
    return json.loads(FIXTURES_PATH.read_text())


class ScriptedServer:
    """Replays a list of ``{status, headers?, body}`` responses, one per request."""

    def __init__(self, responses: list[dict]):
        self.responses = list(responses)
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                parts = urlsplit(self.path)
                outer.requests.append(
                    {
                        "path": parts.path,
                        "query": dict(parse_qsl(parts.query)),
                        "authorization": self.headers.get("Authorization"),
                    }
                )
                if not outer.responses:
                    self.send_response(599)
                    self.end_headers()
                    return
                resp = outer.responses.pop(0)
                body = b"" if resp.get("body") is None else json.dumps(resp["body"]).encode()
                self.send_response(resp["status"])
                for key, value in resp.get("headers", {}).items():
                    self.send_header(key, value)
                if body:
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # silence
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(timeout=5)
