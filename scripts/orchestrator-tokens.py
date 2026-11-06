#!/usr/bin/env python3
"""scripts/orchestrator-tokens.py - the orchestrating session's own token usage over a
time window, for the `orchestrator-tokens: <N>` MR ledger line (macrodream/blueprint#340).

Why this exists. The orchestrating session, which re-reads its always-loaded instructions on
every turn, was invisible to the ledger, so it understated per-MR cost. This sums that
session's usage from its transcript between two instants (the implementer's spawn and the MR
go-ahead) and prints one ledger line. It is session spend over the window, not attribution to
the MR. Main sessions were about 29% of list-price spend and subagents about 71% across the
measured window, so this is the smaller component. The subagents' own usage is the
`subagent-tokens:` line (scripts/subagent-tokens.py, macrodream/blueprint#365), summed per
response in the same unit, so the two figures are comparable.

Input: a Claude Code session transcript, JSON Lines. Format as observed on 2026-11-02 (it
is not a documented interface, so the parser is defensive): one JSON object per line;
entries with `"type": "assistant"` carry `timestamp` (ISO 8601, UTC `Z`), `isSidechain`,
and `message.id` plus `message.usage` with `input_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `output_tokens`. One API response is written as several entries
with the same `message.id` and identical usage, so usage is counted once per id. Subagent
turns were in separate files under `<session-id>/subagents/`, not in this file; an entry
marked `isSidechain: true` is still excluded, so the figure never overlaps `subagent-tokens:`.
The parser lives in scripts/lib/transcript_usage.py, shared with subagent-tokens.py.

The sum is input + cache-write + cache-read + output tokens, per response.

The transcript is untrusted data: a malformed line, an entry with a non-integer usage
field, or an unparseable timestamp is skipped and counted on stderr, never fatal.

Usage:
  python3 scripts/orchestrator-tokens.py [<transcript.jsonl | session-id>]
         [--since <ISO 8601>] [--until <ISO 8601>] [--projects-dir <dir>]
  python3 scripts/orchestrator-tokens.py --self-test

  With no positional argument, the session id is read from $CLAUDE_CODE_SESSION_ID (set in
  the session's shell, observed 2026-11-02). A session id is resolved to exactly one
  `<projects-dir>/*/<id>.jsonl` (default projects dir: ~/.claude/projects). --since and
  --until are inclusive and must carry a zone (`Z` or `+hh:mm`): a naive time would be read
  in the wrong zone silently. Take them from `date -u +%Y-%m-%dT%H:%M:%SZ`.

  The cost-ledger setting is asked first (`scripts/cost-ledger enabled`, macrodream/blueprint#348):
  when it is off or unreadable this prints nothing and opens no transcript.

Output: `orchestrator-tokens: <N>` on stdout; the breakdown, skip counts and one
        `orchestrator-tokens: model <id> <N>` line per model on stderr (macrodream/blueprint#383).
Exit:   0 measured - 1 no orchestrator usage in the window (no line printed: an empty
        window is a wrong window, not a measured 0) - 2 usage error or unreadable input
        - 3 the cost ledger is off or its setting is unreadable (nothing read, nothing printed)
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
# The parser is shared with subagent-tokens.py (macrodream/blueprint#365); re-exported under the old names.
from transcript_usage import FIELDS, contained, measure_detail, parse_time, usage_of  # noqa: E402,F401

SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")


def resolve(arg, projects_dir):
    """A transcript path for a file path or a session id; raises ValueError."""
    if os.path.isfile(arg):
        return contained(arg)
    projects_dir = contained(projects_dir)
    if not SESSION_RE.match(arg):
        raise ValueError("not a readable file or a session id: %r" % arg)
    hits = sorted(glob.glob(os.path.join(glob.escape(projects_dir), "*", arg + ".jsonl")))
    if len(hits) != 1:
        raise ValueError("session %s: %d transcripts under %s (need exactly 1)" % (arg, len(hits), projects_dir))
    return hits[0]


def ledger_enabled():
    """scripts/cost-ledger enabled: 0 on, 1 off, 2 unreadable (anything else counts as unreadable)."""
    try:
        return subprocess.run([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"],
                              capture_output=True, timeout=30).returncode
    except (OSError, subprocess.SubprocessError):
        return 2


def run(argv, out=sys.stdout, err=sys.stderr, enabled=ledger_enabled):
    # Defense in depth (macrodream/blueprint#348): /mr and /wave skip this script when the ledger
    # is off, and it still refuses to open a transcript on its own.
    state = enabled()
    if state != 0:
        print("cost ledger %s: nothing read, nothing recorded (scripts/cost-ledger status)"
              % ("off" if state == 1 else "setting unreadable"), file=err)
        return 3
    target, since, until = None, None, None
    projects_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--since", "--until", "--projects-dir"):
            if i + 1 >= len(argv):
                print("usage: %s needs a value" % a, file=err)
                return 2
            v = argv[i + 1]
            if a == "--projects-dir":
                projects_dir = v
            else:
                t = parse_time(v)
                if t is None:
                    print("usage: %s %r is not ISO 8601 with a zone (use `date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ`)"
                          % (a, v), file=err)
                    return 2
                if a == "--since":
                    since = t
                else:
                    until = t
            i += 2
            continue
        if a.startswith("-") or target is not None:
            print("usage: orchestrator-tokens.py [<transcript|session-id>] [--since T] [--until T]", file=err)
            return 2
        target = a
        i += 1
    if since and until and since > until:
        print("usage: --since is after --until", file=err)
        return 2
    if target is None:
        target = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
        if not target:
            print("usage: no transcript or session id given and $CLAUDE_CODE_SESSION_ID is unset", file=err)
            return 2
    try:
        path = resolve(target, projects_dir)
        with open(path, encoding="utf-8", errors="replace") as f:
            totals, stats, per_model = measure_detail(f, since, until)
    except (OSError, ValueError) as e:
        print("ERROR: %s" % e, file=err)
        return 2
    print("orchestrator-tokens: %d messages (input %d, cache-write %d, cache-read %d, output %d); "
          "skipped %d malformed, %d sidechain, %d duplicate message ids, %d outside the window"
          % ((stats["messages"],) + tuple(totals) + (stats["malformed"], stats["sidechain"],
                                                       stats["duplicate"], stats["outside"])), file=err)
    # Per-model split (macrodream/blueprint#383), read by scripts/cost-table.py --split; the stdout
    # ledger line is unchanged. The model name is sanitized by the shared parser.
    for model in sorted(per_model):
        print("orchestrator-tokens: model %s %d" % (model, sum(per_model[model])), file=err)
    if stats["messages"] == 0:
        print("FAIL: no orchestrator usage in the window; check the transcript and --since/--until", file=err)
        return 1
    print("orchestrator-tokens: %d" % sum(totals), file=out)
    return 0


def self_test():

    def entry(mid, ts, usage, side=False, typ="assistant"):
        return json.dumps({"type": typ, "isSidechain": side, "timestamp": ts,
                           "message": {"id": mid, "usage": usage}})

    def u(i, cw, cr, o):
        return {"input_tokens": i, "cache_creation_input_tokens": cw,
                "cache_read_input_tokens": cr, "output_tokens": o, "service_tier": "standard"}

    lines = [
        entry("m1", "2026-11-01T10:00:00.000Z", u(1, 10, 100, 1000)),        # in: 1111
        entry("m1", "2026-11-01T10:00:00.500Z", u(1, 10, 100, 1000)),        # duplicate id
        entry("m2", "2026-11-01T11:00:00Z", u(2, 20, 200, 2000)),            # in: 2222
        entry("m3", "2026-11-01T11:30:00Z", u(5, 5, 5, 5), side=True),       # sidechain
        entry("m4", "2026-11-01T09:59:59Z", u(9, 9, 9, 9)),                  # before window
        entry("m5", "2026-11-01T12:00:01Z", u(9, 9, 9, 9)),                  # after window
        entry("m11", "2026-11-01T12:00:00Z", u(1, 1, 1, 1)),                 # exactly at --until: inclusive, 4
        entry("m6", "2026-11-01T10:30:00Z", u("5", 0, 0, 0)),                # string field
        entry("m7", "not a time", u(1, 1, 1, 1)),                            # bad timestamp
        entry("m8", "2026-11-01T10:30:00Z", u(True, 0, 0, 0)),               # bool field
        entry("m9", "2026-11-01T10:30:00Z", u(1, 1, 1, 1), typ="user"),      # not assistant
        json.dumps({"type": "assistant", "timestamp": "2026-11-01T10:30:00Z", "message": {"id": "m10"}}),
        "{this is not json",
        "",
        json.dumps(["a", "list"]),
        json.dumps({"type": "assistant", "timestamp": "2026-11-01T10:31:00+00:00",
                    "message": {"usage": {"input_tokens": 3, "output_tokens": 4}}}),  # no id, partial: 7
        "x" * 200000,                                                        # long junk line
        "[" * 200000,                                                        # deep nesting
    ]
    fails, ran = [], []

    def check(name, cond, detail=""):
        ran.append(name)
        if not cond:
            fails.append("%s %s" % (name, detail))

    tmp = tempfile.mkdtemp(prefix="orch-tokens-")
    try:
        _self_test_cases(tmp, lines, check)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % len(ran))
    return 0


def _self_test_cases(tmp, lines, check):
    import io
    proj = os.path.join(tmp, "projects", "-some-repo")
    os.makedirs(proj)
    sid = "0f0e0d0c-1111-2222-3333-444455556666"
    path = os.path.join(proj, sid + ".jsonl")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    def call(*args, env_sid=None, enabled=lambda: 0):
        o, e = io.StringIO(), io.StringIO()
        old = os.environ.get("CLAUDE_CODE_SESSION_ID")
        if env_sid is None:
            os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        else:
            os.environ["CLAUDE_CODE_SESSION_ID"] = env_sid
        try:
            rc = run(list(args), o, e, enabled=enabled)
        finally:
            if old is None:
                os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
            else:
                os.environ["CLAUDE_CODE_SESSION_ID"] = old
        return rc, o.getvalue(), e.getvalue()

    win = ("--since", "2026-11-01T10:00:00Z", "--until", "2026-11-01T12:00:00Z")
    rc, out, err = call(path, *win)
    check("windowed sum", rc == 0 and out.strip() == "orchestrator-tokens: 3344", repr((rc, out, err)))
    check("skip counts reported", "skipped 6 malformed, 1 sidechain, 1 duplicate message ids, 2 outside"
          in err, err)
    check("per-model split on stderr, stdout unchanged",
          "orchestrator-tokens: model unknown 3344\n" in err and out.count("\n") == 1, repr((out, err)))
    rc, out, _ = call(path)
    check("no window counts everything but sidechain and malformed",
          rc == 0 and out.strip() == "orchestrator-tokens: %d" % (3344 + 36 + 36), repr(out))
    rc, out, _ = call(sid, "--projects-dir", os.path.join(tmp, "projects"), *win)
    check("session id resolves under --projects-dir", rc == 0 and out.strip().endswith(" 3344"), repr(out))
    rc, out, _ = call("--projects-dir", os.path.join(tmp, "projects"), *win, env_sid=sid)
    check("session id from $CLAUDE_CODE_SESSION_ID", rc == 0 and out.strip().endswith(" 3344"), repr(out))
    rc, out, err = call(path, "--since", "2027-01-01T00:00:00Z")
    check("empty window exits 1 and prints no ledger line", rc == 1 and out == "" and "FAIL" in err,
          repr((rc, out)))
    for name, args in [
        ("unreadable file", (os.path.join(tmp, "missing.jsonl"),)),
        ("unknown session id", ("deadbeef", "--projects-dir", os.path.join(tmp, "projects"))),
        ("path-like session id", ("../-some-repo/" + sid, "--projects-dir", os.path.join(tmp, "projects"))),
        ("naive --since", (path, "--since", "2026-11-01T10:00:00")),
        ("garbage --until", (path, "--until", "yesterday")),
        ("--since after --until", (path, "--since", "2026-11-02T00:00:00Z", "--until", "2026-11-01T00:00:00Z")),
        ("missing value", (path, "--since")),
        ("unknown flag", (path, "--bogus")),
        ("no target, no env", ("--projects-dir", os.path.join(tmp, "projects"))),
        ("a transcript outside the allowed roots", ("/etc/hosts",)),
        ("a projects dir outside the allowed roots", (sid, "--projects-dir", "/etc")),
    ]:
        rc, out, _ = call(*args)
        check("exit 2: " + name, rc == 2 and out == "", repr((rc, out)))
    # A directory named like a transcript is unreadable, not a crash.
    os.makedirs(os.path.join(tmp, "dir.jsonl"))
    rc, out, _ = call(os.path.join(tmp, "dir.jsonl"))
    check("exit 2: directory", rc == 2 and out == "", repr((rc, out)))
    # Negative control (macrodream/blueprint#348): the same unreadable input exits 2 with the
    # ledger on, so a 3 with it off proves the read was never attempted.
    missing = os.path.join(tmp, "missing.jsonl")
    rc, out, _ = call(missing, enabled=lambda: 0)
    check("ledger on: an unreadable path is read and fails (exit 2)", rc == 2 and out == "", repr((rc, out)))
    for state, word in ((1, "off"), (2, "unreadable")):
        rc, out, err = call(missing, enabled=lambda s=state: s)
        check("ledger %s: exit 3, empty stdout, nothing opened" % word,
              rc == 3 and out == "" and "nothing read" in err, repr((rc, out, err)))
        rc, out, _ = call(path, *win, enabled=lambda s=state: s)
        check("ledger %s: a readable transcript is not read either" % word, rc == 3 and out == "", repr((rc, out)))
    check("the default gate asks scripts/cost-ledger", ledger_enabled() in (0, 1, 2))



def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
