#!/usr/bin/env python3
"""Path partitions for the sharded `backend-schema-fuzz` MR job (#2521).

`backend-schema-fuzz` used to fuzz all ~227 operations in one `st run` and hit
its 600 s `--max-time` cap every time, so the tail of the operation list got
less search than the head. It is now a `parallel: matrix:` of shards, one per
entry in PARTITIONS below; each shard boots its own Postgres, seed and server
and passes its partition's regex to `st run --include-path-regex`.

Sharding by regex has one failure mode that would never turn a job red: an
operation that no partition matches is fuzzed by nobody, and one that two
partitions match is fuzzed twice while the budget is silently split. `check`
therefore fails (absent-input rule, #1075: an unmatched or empty input denies,
it never passes) when:

  * a schema path matches no partition, or more than one;
  * a partition matches no operation (a renamed prefix would otherwise leave a
    shard green with nothing fuzzed, the #1338 empty-selection class);
  * the schema has no operations at all;
  * the CI file's `backend-schema-fuzz` matrix does not list exactly the
    partition names (a shard dropped from the matrix is a gap the schema check
    alone cannot see). That matrix check runs in two places: in every shard
    (`check --ci-file`, next to the schema check) and, schema-free, in the
    `fuzz-baseline-unobserved-selftest` job (`check-matrix` plus `--self-test`),
    which also fires on a CI-file-only MR that the shard jobs' `changes:` skip.

Partitions are by PATH because that is what `--include-path-regex` filters on
(schemathesis `re.search`es the operation's path template, e.g.
`/api/v1/boards/{board_pk}/cards/`), so every method of one path lands in the
same shard. Regexes are anchored with `^` so the catch-all partition can be a
plain negative lookahead.

To retune: edit PARTITIONS and the matrix's FUZZ_SHARD list together (`check`
fails until they agree); the per-shard budget is the job's FUZZ_MAX_TIME.

Usage:
  fuzz_partitions.py regex SHARD
  fuzz_partitions.py check (--schema FILE | --schema-url URL --token-file F)
                           [--ci-file .gitlab-ci.yml] [--job backend-schema-fuzz]
  fuzz_partitions.py check-matrix --ci-file .gitlab-ci.yml [--job backend-schema-fuzz]
  fuzz_partitions.py baseline SHARD IN_BASELINE OUT_BASELINE
  fuzz_partitions.py --self-test

Exit codes: 0 ok, 1 check failure or bad input, 2 usage error.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request

from _paths import cli_roots, resolve_within

# (name, regex) in matrix order. Sized from a local schema on 2026-11-22
# (WEBHOOKS_ENABLED, git_lens off): 89 / 85 / 55 operations.
PARTITIONS: tuple[tuple[str, str], ...] = (
    # Board-scoped children: cards, columns, swimlanes, comments, attachments...
    ("board-children", r"^/api/v1/boards/\{board_pk\}/"),
    # The board collection and /boards/{id}/... actions, plus groups.
    ("boards-groups", r"^/api/v1/(boards/(?!\{board_pk\}/)|groups/)"),
    # Everything else: auth, admin, notifications, health, share, media...
    # A new top-level prefix lands here without a CI edit.
    ("other", r"^(?!/api/v1/(boards|groups)/)"),
)

HTTP_METHODS = frozenset({"get", "put", "post", "patch", "delete", "head", "options", "trace"})
DEFAULT_JOB = "backend-schema-fuzz"
SHARD_VARIABLE = "FUZZ_SHARD"


class PartitionError(Exception):
    """A partition, schema or CI-matrix problem that must fail the job."""


def shard_regex(name: str, partitions=PARTITIONS) -> str:
    for shard, regex in partitions:
        if shard == name:
            return regex
    raise PartitionError(
        "unknown shard %r; known shards: %s" % (name, ", ".join(s for s, _ in partitions))
    )


def operations(schema: dict) -> dict[str, int]:
    """Map each schema path to its number of HTTP operations."""
    paths = (schema or {}).get("paths")
    if not isinstance(paths, dict):
        return {}
    return {
        path: sum(1 for key in item if key in HTTP_METHODS)
        for path, item in paths.items()
        if isinstance(item, dict)
    }


def check_schema(schema: dict, partitions=PARTITIONS) -> list[str]:
    """Return summary lines; raise PartitionError listing every problem."""
    ops = {p: n for p, n in operations(schema).items() if n > 0}
    if not ops:
        raise PartitionError("schema has no operations; refusing to pass on an empty input (#1075)")
    compiled = [(name, re.compile(regex)) for name, regex in partitions]
    counts = {name: 0 for name, _ in partitions}
    problems = []
    for path in sorted(ops):
        owners = [name for name, rx in compiled if rx.search(path)]
        if not owners:
            problems.append("uncovered: %s matches no partition (it would never be fuzzed)" % path)
        elif len(owners) > 1:
            problems.append("overlap: %s matches %s" % (path, ", ".join(owners)))
        else:
            counts[owners[0]] += ops[path]
    for name, _ in partitions:
        if counts[name] == 0:
            problems.append("empty partition: %s matches no operation" % name)
    if problems:
        raise PartitionError("\n".join(problems))
    total = sum(ops.values())
    lines = ["fuzz-partitions: %d operations on %d paths, each in exactly one shard:" % (total, len(ops))]
    lines += ["  %-16s %4d operations  %s" % (name, counts[name], regex) for name, regex in partitions]
    return lines


def _ci_loader():
    import yaml  # the fuzz job's image has it via schemathesis

    class Loader(yaml.SafeLoader):
        pass

    Loader.add_constructor("!reference", lambda loader, node: loader.construct_sequence(node))
    return yaml, Loader


def matrix_shards(ci_text: str, job: str = DEFAULT_JOB) -> list[str]:
    yaml, loader = _ci_loader()
    data = yaml.load(ci_text, Loader=loader) or {}
    spec = data.get(job)
    if not isinstance(spec, dict):
        raise PartitionError("CI file has no %r job" % job)
    matrix = (spec.get("parallel") or {}).get("matrix") if isinstance(spec.get("parallel"), dict) else None
    if not isinstance(matrix, list) or not matrix:
        raise PartitionError("%r has no parallel: matrix:, so it is not sharded" % job)
    shards = []
    for entry in matrix:
        value = entry.get(SHARD_VARIABLE) if isinstance(entry, dict) else None
        if value is None:
            raise PartitionError("%r matrix entry %r sets no %s" % (job, entry, SHARD_VARIABLE))
        shards += value if isinstance(value, list) else [value]
    return [str(s) for s in shards]


def check_matrix(shards: list[str], partitions=PARTITIONS) -> None:
    names = [name for name, _ in partitions]
    problems = []
    for name in names:
        if shards.count(name) != 1:
            problems.append("matrix lists shard %r %d times (want exactly 1)" % (name, shards.count(name)))
    for shard in sorted(set(shards) - set(names)):
        problems.append("matrix shard %r has no partition in scripts/fuzz_partitions.py" % shard)
    if problems:
        raise PartitionError("\n".join(problems))


def filter_baseline(baseline: dict, regex: str) -> dict:
    """Keep only the baseline entries whose operation path the shard fuzzes.

    Why filter instead of aggregating the shards' reports: aggregation needs a
    job that waits for all three shards' artifacts, and a shard's own log could
    then never say what it left unobserved. A per-shard view keeps each log
    self-contained, and it also makes `st run`'s own "Unobserved entries" count
    true for the shard (it is fed the same filtered file). An entry whose
    operation cannot be parsed is kept in every shard: it may then read as
    unobserved in two shards, but it is never dropped from the one that needs it.
    """
    rx = re.compile(regex)
    kept = []
    for entry in (baseline or {}).get("entries", []):
        op = entry.get("operation") if isinstance(entry, dict) else None
        parts = op.split(" ", 1) if isinstance(op, str) else []
        if len(parts) != 2 or rx.search(parts[1].strip()):
            kept.append(entry)
    out = dict(baseline or {})
    out["entries"] = kept
    return out


LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1"})


def validate_schema_url(raw: str) -> str:
    """Return a URL rebuilt from validated parts, or raise PartitionError.

    The request carries the API token, so the target must really be the job's own
    loopback server. A `startswith("http://localhost:")` prefix check is bypassable
    (`http://localhost:@evil.example/`, `http://localhost:80.evil.example/`);
    parsing and rebuilding from the validated components is not (#2675).
    """
    msg = "--schema-url must be the job's own http://localhost:<port> server"
    try:
        parts = urllib.parse.urlsplit(raw)
        host, port = parts.hostname, parts.port  # .port raises ValueError on garbage
    except ValueError:
        raise PartitionError(msg) from None
    if parts.scheme != "http" or host not in LOOPBACK_HOSTS or port is None or port < 1:
        raise PartitionError(msg)
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise PartitionError(msg)
    return urllib.parse.urlunsplit(("http", f"{host}:{port}", parts.path, parts.query, ""))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would replay the Authorization header to the new host."""

    def redirect_request(self, *args, **kwargs):
        return None


# ProxyHandler({}) ignores http_proxy so the token cannot be routed through an env proxy.
def _build_loopback_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


_LOOPBACK_OPENER = _build_loopback_opener()


def _fetch_json(url: str, token: str) -> dict:
    """GET `url` (already validated and rebuilt) with the token, no redirects, no env proxy."""
    req = urllib.request.Request(url, headers={"Authorization": "Token " + token})
    # noqa rationale: http scheme and loopback host validated, URL rebuilt from parts
    with _LOOPBACK_OPENER.open(req, timeout=60) as resp:  # noqa: S310
        return json.load(resp)


def _load_schema(args) -> dict:
    if args.schema:
        with open(resolve_within(cli_roots(), args.schema), encoding="utf-8") as f:
            return json.load(f)
    if not (args.schema_url and args.token_file):
        raise PartitionError("check needs --schema, or --schema-url with --token-file")
    url = validate_schema_url(args.schema_url)
    with open(resolve_within(cli_roots(), args.token_file), encoding="utf-8") as f:
        token = f.read().strip()
    return _fetch_json(url, token)


def main(argv: list[str]) -> int:
    if argv == ["--self-test"]:
        return _self_test()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_regex = sub.add_parser("regex")
    p_regex.add_argument("shard")
    p_check = sub.add_parser("check")
    p_check.add_argument("--schema")
    p_check.add_argument("--schema-url")
    p_check.add_argument("--token-file")
    p_check.add_argument("--ci-file")
    p_check.add_argument("--job", default=DEFAULT_JOB)
    p_matrix = sub.add_parser("check-matrix")
    p_matrix.add_argument("--ci-file", required=True)
    p_matrix.add_argument("--job", default=DEFAULT_JOB)
    p_base = sub.add_parser("baseline")
    p_base.add_argument("shard")
    p_base.add_argument("src")
    p_base.add_argument("dst")
    args = parser.parse_args(argv)
    try:
        if args.cmd == "regex":
            print(shard_regex(args.shard))
        elif args.cmd == "check":
            print("\n".join(check_schema(_load_schema(args))))
            if args.ci_file:
                with open(resolve_within(cli_roots(), args.ci_file), encoding="utf-8") as f:
                    check_matrix(matrix_shards(f.read(), args.job))
                print("fuzz-partitions: %s matrix lists every partition exactly once" % args.job)
        elif args.cmd == "check-matrix":
            # Schema-free: only the CI matrix vs PARTITIONS, so a CI-only MR is covered.
            with open(resolve_within(cli_roots(), args.ci_file), encoding="utf-8") as f:
                check_matrix(matrix_shards(f.read(), args.job))
            print("fuzz-partitions: %s matrix lists every partition exactly once" % args.job)
        else:
            regex = shard_regex(args.shard)
            with open(resolve_within(cli_roots(), args.src), encoding="utf-8") as f:
                baseline = json.load(f)
            out = filter_baseline(baseline, regex)
            with open(resolve_within(cli_roots(), args.dst), "w", encoding="utf-8") as f:
                json.dump(out, f, indent=2)
            print("fuzz-partitions: shard %s keeps %d of %d baseline entries"
                  % (args.shard, len(out["entries"]), len(baseline.get("entries", []))))
    except (PartitionError, OSError, ValueError) as exc:
        print("fuzz-partitions: FAILED\n%s" % exc, file=sys.stderr)
        return 1
    return 0


def _expect_error(fn, *needles):
    try:
        fn()
    except PartitionError as exc:
        for needle in needles:
            assert needle in str(exc), (needle, str(exc))
        return
    raise AssertionError("expected PartitionError containing %r" % (needles,))


def _self_test_fetch() -> None:
    """Prove the token fetch ignores env proxies and redirects, and uses the rebuilt URL (#2675)."""
    import http.server
    import os
    import tempfile
    import threading
    import urllib.error

    seen: dict[str, list] = {"a": [], "b": []}
    ports: dict[str, int] = {}

    def make_handler(name):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen[name].append(self.headers.get("Authorization"))
                if name == "a":
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.1:%d/target" % ports["b"])
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        return Handler

    servers = {n: http.server.HTTPServer(("127.0.0.1", 0), make_handler(n)) for n in ("a", "b")}
    ports.update({n: s.server_address[1] for n, s in servers.items()})
    for s in servers.values():
        threading.Thread(target=s.serve_forever, daemon=True).start()
    proxy_keys = ("http_proxy", "HTTP_PROXY")
    saved = {k: os.environ.get(k) for k in proxy_keys}
    real_fetch = globals()["_fetch_json"]
    try:
        for k in proxy_keys:
            os.environ[k] = "http://127.0.0.1:1"  # dead: any proxied request fails
        try:
            real_fetch("http://127.0.0.1:%d/redir" % ports["a"], "tok")
        except urllib.error.HTTPError as exc:
            assert exc.code == 302, exc.code
        else:
            raise AssertionError("redirect was followed")
        assert seen["b"] == [], seen["b"]
        # Env proxies are read when an opener is built, not per request, so rebuild one now with
        # the dead proxy set. An empty ProxyHandler({}) registers no <scheme>_open methods and so
        # never lands in .handlers; the default env-driven one (with http_open) does.
        proxied = [h for h in _build_loopback_opener().handlers if isinstance(h, urllib.request.ProxyHandler)]
        assert proxied == [], proxied
        assert seen["a"] == ["Token tok"], seen["a"]  # reached A directly, not via the proxy

        # _load_schema must hand _fetch_json the rebuilt URL, not the raw argument.
        got = []
        globals()["_fetch_json"] = lambda url, token: got.append((url, token)) or {}
        with tempfile.TemporaryDirectory() as d:
            tok = os.path.join(d, "tok")
            with open(tok, "w", encoding="utf-8") as f:
                f.write("secret\n")
            ns = argparse.Namespace(schema=None, schema_url="http://localhost:8000/s/?format=json#frag", token_file=tok)
            _load_schema(ns)
        assert got == [("http://localhost:8000/s/?format=json", "secret")], got
    finally:
        globals()["_fetch_json"] = real_fetch
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        for s in servers.values():
            s.shutdown()
            s.server_close()


def _self_test() -> int:
    def schema(*paths):
        return {"paths": {p: {"get": {}, "post": {}} for p in paths}}

    real = schema(
        "/api/v1/boards/", "/api/v1/boards/{id}/", "/api/v1/boards/{id}/archive/",
        "/api/v1/boards/{board_pk}/cards/", "/api/v1/boards/{board_pk}/cards/{id}/",
        "/api/v1/groups/", "/api/v1/groups/{id}/members/",
        "/api/v1/auth/me/", "/api/v1/admin/users/", "/api/health/liveness/",
        "/api/share/{token}/", "/media/{path}", "/api/v1/boardsx/",
    )
    expected = {
        "/api/v1/boards/": "boards-groups", "/api/v1/boards/{id}/archive/": "boards-groups",
        "/api/v1/boards/{board_pk}/cards/{id}/": "board-children", "/api/v1/groups/": "boards-groups",
        "/api/v1/auth/me/": "other", "/media/{path}": "other", "/api/v1/boardsx/": "other",
    }
    for path, shard in expected.items():
        owners = [n for n, rx in PARTITIONS if re.search(rx, path)]
        assert owners == [shard], (path, owners)
    lines = check_schema(real)
    assert lines[0].startswith("fuzz-partitions: 26 operations on 13 paths"), lines
    assert re.search(r"board-children\s+4 operations", lines[1]), lines

    # Uncovered operation: a partition set with a gap must fail, naming the path.
    gappy = (("a", r"^/api/v1/boards/"), ("b", r"^/api/v1/groups/"))
    _expect_error(lambda: check_schema(schema("/api/v1/boards/", "/api/v1/groups/", "/api/v1/auth/me/"), gappy),
                  "uncovered: /api/v1/auth/me/")
    # Overlap: one path in two partitions must fail.
    overlapping = (("a", r"^/api/v1/"), ("b", r"^/api/v1/groups/"))
    _expect_error(lambda: check_schema(schema("/api/v1/groups/", "/api/v1/x/"), overlapping),
                  "overlap: /api/v1/groups/ matches a, b")
    # Empty partition: a shard that selects nothing must fail, not pass green.
    _expect_error(lambda: check_schema(schema("/api/v1/auth/me/", "/api/v1/groups/")),
                  "empty partition: board-children")
    # Absent input: no paths, a path with no operations only, or no schema at all.
    _expect_error(lambda: check_schema({"paths": {}}), "no operations")
    _expect_error(lambda: check_schema({"paths": {"/api/v1/x/": {"parameters": []}}}), "no operations")
    _expect_error(lambda: check_schema(None), "no operations")

    # --schema-url guard (#2675): the token must only ever reach the job's own loopback server.
    assert validate_schema_url("http://localhost:8000/api/schema/?format=json") == \
        "http://localhost:8000/api/schema/?format=json"
    assert validate_schema_url("http://127.0.0.1:8000/x") == "http://127.0.0.1:8000/x"
    for bad in (
        "http://localhost:@evil.example/", "http://localhost:80.evil.example/",
        "https://localhost:8000/", "http://localhost/", "http://user:pw@localhost:8000/",
        "http://localhost:abc/",
        "http://localhost:99999/",
        "http://127.0.0.1:0/",
        "http://localhost:8000\\@evil.example/",
        "http://evil.example:8000/",
        "http://localhost.evil.example:8000/",
        "ftp://localhost:8000/",
        "",
        "localhost:8000",
    ):
        _expect_error(lambda bad=bad: validate_schema_url(bad), "--schema-url must be")

    _self_test_fetch()

    # CI matrix must list exactly the partitions.
    names = [n for n, _ in PARTITIONS]
    ok_ci = "backend-schema-fuzz:\n  parallel:\n    matrix:\n      - FUZZ_SHARD: [%s]\n" % ", ".join(names)
    check_matrix(matrix_shards(ok_ci))
    check_matrix(matrix_shards("x: !reference [.a, b]\n" + ok_ci))  # !reference tolerated
    _expect_error(lambda: check_matrix(["board-children", "other"]), "'boards-groups' 0 times")
    _expect_error(lambda: check_matrix(names + ["other"]), "'other' 2 times")
    _expect_error(lambda: check_matrix(names + ["extra"]), "'extra' has no partition")
    _expect_error(lambda: matrix_shards("backend-schema-fuzz:\n  script: [x]\n"), "not sharded")
    _expect_error(lambda: matrix_shards("other-job:\n  script: [x]\n"), "no 'backend-schema-fuzz' job")
    _expect_error(lambda: matrix_shards("backend-schema-fuzz:\n  parallel:\n    matrix:\n      - X: [a]\n"),
                  "sets no FUZZ_SHARD")

    # check-matrix (schema-free) CLI: ok, dropped shard, absent/empty matrix, missing file.
    import contextlib
    import io
    import os
    import tempfile

    def run_matrix(ci_text):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "ci.yml")
            with open(path, "w", encoding="utf-8") as f:
                f.write(ci_text)
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as e:
                return main(["check-matrix", "--ci-file", path]), e.getvalue()

    assert run_matrix(ok_ci)[0] == 0
    code, err = run_matrix(ok_ci.replace(names[-1], names[0]))
    assert code == 1 and "0 times" in err, (code, err)
    code, err = run_matrix("backend-schema-fuzz:\n  parallel:\n    matrix: []\n")
    assert code == 1 and "not sharded" in err, (code, err)
    code, err = run_matrix("")
    assert code == 1 and "no 'backend-schema-fuzz' job" in err, (code, err)

    _expect_error(lambda: shard_regex("nope"), "unknown shard 'nope'")

    with contextlib.redirect_stderr(io.StringIO()) as err:
        assert main(["regex", "nope"]) == 1
    assert "unknown shard 'nope'" in err.getvalue(), err.getvalue()
    assert shard_regex("board-children") == PARTITIONS[0][1]

    base = {"format_version": 1, "entries": [
        {"id": "a", "operation": "GET /api/v1/boards/{board_pk}/cards/"},
        {"id": "b", "operation": "POST /api/v1/auth/me/"},
        {"id": "c", "operation": "garbled"},
    ]}
    kept = filter_baseline(base, shard_regex("board-children"))
    assert [e["id"] for e in kept["entries"]] == ["a", "c"], kept
    assert kept["format_version"] == 1 and len(base["entries"]) == 3
    assert [e["id"] for e in filter_baseline(base, shard_regex("other"))["entries"]] == ["b", "c"]
    assert filter_baseline({}, r"^/")["entries"] == []
    print("fuzz_partitions --self-test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
