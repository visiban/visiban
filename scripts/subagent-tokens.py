#!/usr/bin/env python3
"""scripts/subagent-tokens.py - the subagents' cumulative token usage for the
`subagent-tokens: <N>` MR ledger line (macrodream/blueprint#365).

Why this exists. The ledger's old `tokens:` line summed `subagent_tokens` from each agent's
latest notification, which tracks about one context plus output, not usage across turns: a
median ~30x below cumulative usage (range 5x-83x) on 35 merged MRs, and not comparable with
`orchestrator-tokens:`. This sums every response of the named agents and of their descendants
(the implementer's own gate batch), in the same unit as scripts/orchestrator-tokens.py:
input + cache-write + cache-read + output tokens, per response, once per message id. The
parser is shared (scripts/lib/transcript_usage.py).

Which agents: the orchestrator names each agent it spawned or resumed for the branch, with
`--agent <id>` (repeatable; the id is the `agentId:` line of the Agent tool result). Descendants
are added transitively through `parentAgentId` in the sibling `agent-<id>.meta.json`. Agents are
never found by time window, description, cwd or branch.

Layout dependency (undocumented, observed 2026-11-03):
  <projects-dir>/<slug>/<session-id>/subagents/agent-<id>.jsonl and agent-<id>.meta.json
This FAILS CLOSED: an id with no transcript, or a session directory that does not resolve,
prints no line and exits 1, because a partial sum would read as a measured one. One limit:
descendants are found only through `parentAgentId` in the meta files, so a nested agent whose
transcript exists but whose meta file is missing is not found and the sum is partial (10 of
4,738 transcripts seen locally on 2026-11-03 had no meta file). Transcripts are deleted after
cleanupPeriodDays (30), so run this at MR time.

The transcripts are untrusted data. An id becomes a path only after a strict pattern accepts
it, and the meta `description` text is never read or echoed.

Usage:
  python3 scripts/subagent-tokens.py --agent <id>[@<since>] [--agent <id> ...] [--until <ISO 8601>]
         [--agent-since <id>@<since> ...] [--session <session-id>] [--projects-dir <dir>]
  python3 scripts/subagent-tokens.py --no-agents
  python3 scripts/subagent-tokens.py --self-test

  --no-agents is the orchestrator's explicit statement that it spawned no subagent in the window
  (macrodream/blueprint#386): it prints `subagent-tokens: 0`, a measured zero, and opens no
  transcript. It is never a default: without it and without --agent this exits 2, so a forgotten
  --agent can not become a zero. Giving it with --agent is a usage error.

  Per-agent since (macrodream/blueprint#387): `--agent <id>@<since>` counts that agent only from
  `<since>` on (inclusive), and `--agent-since <id>@<since>` sets the same bound for an agent that
  is not named, such as a descendant found through `parentAgentId`. An agent with no bound counts
  from its first entry. Without it a resumed agent was counted whole again in the next record.
  scripts/post-mr-cost.py passes these from its per-session state.

  The session id defaults to $CLAUDE_CODE_SESSION_ID. --until is inclusive and must carry a zone.
  The cost-ledger setting is asked first (`scripts/cost-ledger enabled`, macrodream/blueprint#348):
  when it is off or unreadable this prints nothing and opens no transcript.

Output: `subagent-tokens: <N>` on stdout and nothing else; the agents counted (named and
        descendants), skip counts and the per-model breakdown on stderr.
Exit:   0 measured - 1 a missing id or session directory, or no usage (no line printed) - 2 usage
        error or unreadable input - 3 the cost ledger is off or its setting is unreadable
"""
import glob
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
import transcript_usage as tu  # noqa: E402

SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")


def ledger_enabled():
    """scripts/cost-ledger enabled: 0 on, 1 off, 2 unreadable (anything else counts as unreadable)."""
    try:
        return subprocess.run([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"],
                              capture_output=True, timeout=30).returncode
    except (OSError, subprocess.SubprocessError):
        return 2


def session_dir(sid, projects_dir):
    """The one <projects-dir>/*/<sid>/ directory; raises ValueError."""
    if not SESSION_RE.match(sid):
        raise ValueError("not a session id: %r" % sid)
    hits = sorted(h for h in glob.glob(os.path.join(glob.escape(projects_dir), "*", sid)) if os.path.isdir(h))
    if len(hits) != 1:
        raise ValueError("session %s: %d session directories under %s (need exactly 1)" % (sid, len(hits), projects_dir))
    return hits[0]


def run(argv, out=sys.stdout, err=sys.stderr, enabled=ledger_enabled):
    # Defense in depth (macrodream/blueprint#348): /mr and /wave skip this script when the ledger
    # is off, and it still refuses to open a transcript on its own.
    state = enabled()
    if state != 0:
        print("cost ledger %s: nothing read, nothing recorded (scripts/cost-ledger status)"
              % ("off" if state == 1 else "setting unreadable"), file=err)
        return 3
    ids, until, sid, none_ran = [], None, None, False
    since_by_id = {}
    projects_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--no-agents":
            none_ran = True
            i += 1
            continue
        if a not in ("--agent", "--agent-since", "--until", "--session", "--projects-dir"):
            print("usage: subagent-tokens.py --agent <id>[@since] [--agent <id>...] [--agent-since <id>@since] "
                  "[--until T] [--session <sid>]", file=err)
            return 2
        if i + 1 >= len(argv):
            print("usage: %s needs a value" % a, file=err)
            return 2
        v = argv[i + 1]
        if a in ("--agent", "--agent-since"):
            try:
                aid, asince = tu.parse_agent_spec(v, need_since=(a == "--agent-since"))
            except ValueError as e:
                print("usage: %s %s" % (a, e), file=err)
                return 2
            if a == "--agent":
                ids.append(aid)
            if asince is not None:
                since_by_id[aid] = asince
        elif a == "--until":
            until = tu.parse_time(v)
            if until is None:
                print("usage: --until %r is not ISO 8601 with a zone (use `date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ`)" % v,
                      file=err)
                return 2
        elif a == "--session":
            sid = v
        else:
            projects_dir = v
        i += 2
    if none_ran and ids:
        print("usage: --no-agents and --agent are exclusive", file=err)
        return 2
    if none_ran:
        print("subagent-tokens: 0 agents (--no-agents: the orchestrator stated none ran)", file=err)
        print("subagent-tokens: 0", file=out)
        return 0
    if not ids:
        print("usage: at least one --agent <id> (or --no-agents) is required", file=err)
        return 2
    sid = sid or os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not sid:
        print("usage: no --session given and $CLAUDE_CODE_SESSION_ID is unset", file=err)
        return 2
    try:
        projects_dir = tu.contained(projects_dir)
    except ValueError as e:
        print("usage: %s" % e, file=err)
        return 2
    try:
        sdir = session_dir(sid, projects_dir)
    except ValueError as e:
        print("ERROR: %s" % e, file=err)
        return 2 if not SESSION_RE.match(sid) else 1
    try:
        agents, files = tu.subagent_files(sdir, ids)
    except ValueError as e:
        print("FAIL: %s; no line printed" % e, file=err)
        return 1

    # One deduplicated sum across files (a fork repeats its parent's responses), each agent cut at
    # its own lower bound: `--agent <id>@<since>` / `--agent-since <id>@<since>` (the end of that
    # agent's previous cost record, scripts/post-mr-cost.py), else its first entry.
    try:
        rows, stats = tu.measure_rows_sources(tu.agent_sources(files, agents, since_by_id), until, side="sidechain")
        totals, stats, per_model = tu.sum_rows(rows, stats)
    except OSError as e:
        print("ERROR: %s" % e, file=err)
        return 2
    print("subagent-tokens: %d agents (%d named, %d descendants): %s" % (
        len(agents), sum(1 for _, n in agents if n), sum(1 for _, n in agents if not n),
        ", ".join(a + ("" if n else " (descendant)") for a, n in agents)), file=err)
    print("subagent-tokens: %d messages (input %d, cache-write %d, cache-read %d, output %d); "
          "skipped %d malformed, %d main-session, %d duplicate message ids, %d outside, %d empty"
          % ((stats["messages"],) + tuple(totals) + (stats["malformed"], stats["sidechain"],
                                                       stats["duplicate"], stats["outside"], stats["empty"])), file=err)
    for model in sorted(per_model):
        print("subagent-tokens: model %s %d" % (model, sum(per_model[model])), file=err)
    if stats["messages"] == 0:
        print("FAIL: no subagent usage found; check the agent ids and --until", file=err)
        return 1
    print("subagent-tokens: %d" % sum(totals), file=out)
    return 0


def _load_orchestrator():
    spec = importlib.util.spec_from_file_location("orchestrator_tokens", os.path.join(HERE, "orchestrator-tokens.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def self_test():
    fails, ran = [], []

    def check(name, cond, detail=""):
        ran.append(name)
        if not cond:
            fails.append("%s %s" % (name, detail))

    tmp = tempfile.mkdtemp(prefix="sub-tokens-")
    try:
        _cases(tmp, check)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % len(ran))
    return 0


def _cases(tmp, check):
    orch = _load_orchestrator()
    usage = {"input_tokens": 7, "cache_creation_input_tokens": 70, "cache_read_input_tokens": 700,
             "output_tokens": 7000}  # 7777

    def entry(mid, ts, u, side, model="claude-test"):
        return json.dumps({"type": "assistant", "isSidechain": side, "timestamp": ts,
                           "message": {"id": mid, "model": model, "usage": u}})

    def write(path, lines):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def meta(sub, aid, **kw):
        with open(os.path.join(sub, "agent-%s.meta.json" % aid), "w") as f:
            json.dump(dict(kw, description="SECRET-DESCRIPTION-TEXT"), f)

    projects = os.path.join(tmp, "projects")
    sid = "0f0e0d0c-1111-2222-3333-444455556666"
    base = os.path.join(projects, "-some-repo")
    sub = os.path.join(base, sid, "subagents")
    ts = "2026-11-01T10:00:00Z"
    a1, a2, a3, a4 = "a1111111111111111", "a2222222222222222", "a3333333333333333", "a4444444444444444"
    # AC2 fixture: one identical usage dict, once in a main transcript and once in a subagent one.
    write(os.path.join(base, sid + ".jsonl"), [entry("mm1", ts, usage, False)])
    write(os.path.join(sub, "agent-%s.jsonl" % a1), [entry("s1", ts, usage, True)])
    meta(sub, a1)

    def call(*args, enabled=lambda: 0):
        o, e = io.StringIO(), io.StringIO()
        old = os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        try:
            rc = run(list(args), o, e, enabled=enabled)
        finally:
            if old is not None:
                os.environ["CLAUDE_CODE_SESSION_ID"] = old
        return rc, o.getvalue(), e.getvalue()

    pd = ("--projects-dir", projects)
    rc, out, err = call("--no-agents")
    check("--no-agents prints a measured zero and reads no transcript",
          rc == 0 and out == "subagent-tokens: 0\n", repr((rc, out, err)))
    rc, out, _ = call("--no-agents", "--agent", a1, "--session", sid, *pd)
    check("--no-agents with --agent is a usage error", rc == 2 and out == "", repr((rc, out)))
    rc, out, _ = call("--session", sid, *pd)
    check("neither --agent nor --no-agents still exits 2", rc == 2 and out == "", repr((rc, out)))
    for state in (1, 2):
        rc, out, _ = call("--no-agents", enabled=lambda s=state: s)
        check("--no-agents asks the ledger setting first (exit 3)", rc == 3 and out == "", repr((rc, out)))
    rc, out, _ = call("--agent", a1, "--session", sid, "--projects-dir", "/etc")
    check("a --projects-dir outside the checkout, the temp dir and ~/.claude is refused (exit 2)",
          rc == 2 and out == "", repr((rc, out)))
    rc, out, err = call("--agent", a1, "--session", sid, *pd)
    check("single agent sum", rc == 0 and out == "subagent-tokens: 7777\n", repr((rc, out, err)))
    o2, e2 = io.StringIO(), io.StringIO()
    orc = orch.run([os.path.join(base, sid + ".jsonl")], o2, e2, enabled=lambda: 0)
    check("one unit: the same usage prints the same number from both CLIs",
          orc == 0 and o2.getvalue().split(": ")[1] == out.split(": ")[1], repr((o2.getvalue(), out)))
    check("stdout is only the ledger line", out.count("\n") == 1 and out.startswith("subagent-tokens: "), repr(out))
    check("no description text echoed", "SECRET-DESCRIPTION-TEXT" not in err + out, err)
    check("per-model breakdown on stderr", "model claude-test 7777" in err, err)

    # Nested descendants (two levels) are counted; an unrelated agent is not.
    write(os.path.join(sub, "agent-%s.jsonl" % a2), [entry("s2", ts, usage, True, "other-model")])
    meta(sub, a2, parentAgentId=a1)
    write(os.path.join(sub, "agent-%s.jsonl" % a3), [entry("s3", ts, usage, True)])
    meta(sub, a3, parentAgentId=a2)
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("s4", ts, usage, True)])
    meta(sub, a4)
    rc, out, err = call("--agent", a1, "--session", sid, *pd)
    check("descendants walked transitively, unrelated agent excluded",
          rc == 0 and out == "subagent-tokens: %d\n" % (3 * 7777) and "(descendant)" in err
          and a4 not in err and "model other-model 7777" in err, repr((rc, out, err)))
    rc, out, _ = call("--agent", a1, "--agent", a4, "--session", sid, *pd)
    check("repeated --agent adds each named agent", out == "subagent-tokens: %d\n" % (4 * 7777), repr(out))
    rc, out, _ = call("--agent", a2, "--agent", a1, "--session", sid, *pd)
    check("an agent named and also a descendant counts once", out == "subagent-tokens: %d\n" % (3 * 7777), repr(out))

    # A fork repeats its parent's message id in another file: counted once.
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("s1", ts, usage, True), entry("s4", ts, usage, True)])
    rc, out, err = call("--agent", a1, "--agent", a4, "--session", sid, *pd)
    check("duplicate message ids across files are counted once",
          out == "subagent-tokens: %d\n" % (4 * 7777) and "1 duplicate message ids" in err, repr((out, err)))
    # --until is inclusive; a later entry is outside.
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("s4", "2026-11-01T10:00:01Z", usage, True)])
    rc, out, err = call("--agent", a4, "--until", ts, "--session", sid, *pd)
    check("--until excludes later responses; none left is exit 1 with no line",
          rc == 1 and out == "" and "FAIL" in err, repr((rc, out)))
    # Main-session entries inside an agent file are not subagent usage.
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("s4", ts, usage, False)])
    rc, out, _ = call("--agent", a4, "--session", sid, *pd)
    check("a non-sidechain entry is not counted", rc == 1 and out == "", repr((rc, out)))

    # Fail closed.
    rc, out, err = call("--agent", "a9999999999999999", "--session", sid, *pd)
    check("exit 1: a named id with no transcript, no line", rc == 1 and out == "" and "no transcript" in err, repr((rc, out, err)))
    rc, out, _ = call("--agent", a1, "--agent", "a9999999999999999", "--session", sid, *pd)
    check("exit 1: one missing id fails the whole sum", rc == 1 and out == "", repr((rc, out)))
    meta(sub, "a5555555555555555", parentAgentId=a1)
    rc, out, _ = call("--agent", a1, "--session", sid, *pd)
    check("exit 1: a descendant with no transcript fails closed", rc == 1 and out == "", repr((rc, out)))
    os.remove(os.path.join(sub, "agent-a5555555555555555.meta.json"))
    with open(os.path.join(sub, "agent-a6666666666666666.meta.json"), "w") as f:
        f.write("{not json")
    rc, out, _ = call("--agent", a1, "--session", sid, *pd)
    check("exit 1: an unreadable meta file fails closed", rc == 1 and out == "", repr((rc, out)))
    os.remove(os.path.join(sub, "agent-a6666666666666666.meta.json"))
    rc, out, _ = call("--agent", a1, "--session", "deadbeef", *pd)
    check("exit 1: a session directory that does not resolve", rc == 1 and out == "", repr((rc, out)))
    os.makedirs(os.path.join(base, "nosub-session"))
    rc, out, _ = call("--agent", a1, "--session", "nosub-session", *pd)
    check("exit 1: a session with no subagents directory", rc == 1 and out == "", repr((rc, out)))
    # Usage errors and the traversal guard.
    for name, args in [
        ("path-like agent id", ("--agent", "../../etc/passwd", "--session", sid) + pd),
        ("agent id with a slash", ("--agent", "a1111111/../x", "--session", sid) + pd),
        ("trailing newline in agent id", ("--agent", a1 + "\n", "--session", sid) + pd),
        ("path-like session id", ("--agent", a1, "--session", "../" + sid) + pd),
        ("no agent", ("--session", sid) + pd),
        ("naive --until", ("--agent", a1, "--until", "2026-11-01T10:00:00", "--session", sid) + pd),
        ("missing value", ("--agent", a1, "--session")),
        ("unknown flag", ("--agent", a1, "--bogus", "x")),
        ("no session, no env", ("--agent", a1) + pd),
    ]:
        rc, out, _ = call(*args)
        check("exit 2: " + name, rc == 2 and out == "", repr((rc, out)))
    # Ledger setting (macrodream/blueprint#348): a 3 with it off, against the same input that succeeds on.
    for state, word in ((1, "off"), (2, "unreadable")):
        rc, out, err = call("--agent", a1, "--session", sid, *pd, enabled=lambda s=state: s)
        check("ledger %s: exit 3, empty stdout, nothing read" % word,
              rc == 3 and out == "" and "nothing read" in err, repr((rc, out, err)))
    rc, out, _ = call("--agent", a1, "--session", sid, *pd, enabled=lambda: 0)
    check("injected enabled=0 reads", rc == 0 and out.startswith("subagent-tokens: "), repr(out))
    check("the default gate asks scripts/cost-ledger", ledger_enabled() in (0, 1, 2))
    # Per-agent since (macrodream/blueprint#387): a resumed agent is counted only after its watermark.
    t1, t2 = "2026-11-02T10:00:00Z", "2026-11-03T10:00:00Z"
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("r1", t1, usage, True), entry("r2", t2, usage, True)])
    rc, out, _ = call("--agent", a4, "--session", sid, *pd)
    check("no per-agent since: every response of the agent", out == "subagent-tokens: %d\n" % (2 * 7777), repr(out))
    rc, out, _ = call("--agent", a4 + "@2026-11-03T00:00:00Z", "--session", sid, *pd)
    check("--agent <id>@<since> counts only responses from that time (the resumed agent's new work)",
          out == "subagent-tokens: %d\n" % 7777, repr(out))
    rc, out, _ = call("--agent", a4 + "@" + t2, "--session", sid, *pd)
    check("the per-agent since bound is inclusive", out == "subagent-tokens: %d\n" % 7777, repr(out))
    rc, out, _ = call("--agent", a1, "--agent-since", a2 + "@2026-11-05T00:00:00Z", "--session", sid, *pd)
    check("--agent-since cuts a descendant (not named) at its own bound: a2 drops, a1 and a3 stay",
          out == "subagent-tokens: %d\n" % (2 * 7777), repr(out))
    for name, args in (("--agent-since without a time", ("--agent-since", a2)),
                       ("a naive time", ("--agent", a4 + "@2026-11-03T00:00:00")),
                       ("a path-like id before @", ("--agent", "../x@2026-11-03T00:00:00Z"))):
        rc, out, _ = call(*args, "--session", sid, *pd)
        check("exit 2: " + name, rc == 2 and out == "", repr((rc, out)))
    # An all-zero (`<synthetic>`) response is dropped, never a phantom model line.
    zero = {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0}
    write(os.path.join(sub, "agent-%s.jsonl" % a4), [entry("z1", t1, zero, True, "<synthetic>"), entry("r1", t1, usage, True)])
    rc, out, err = call("--agent", a4, "--session", sid, *pd)
    check("an all-zero response is dropped: no `<synthetic>`/unknown model line, counted as empty",
          out == "subagent-tokens: 7777\n" and "model unknown" not in err and "1 empty" in err, repr((out, err)))
    # The library's own guards.
    for bad in ("", "../x", "a1/b", "ZZZZZZZZ", "a12"):
        try:
            tu.subagent_files(os.path.join(base, sid), [bad])
            ok = False
        except ValueError:
            ok = True
        check("subagent_files rejects id %r" % bad, ok)
    _, st = tu.measure([entry("x", ts, usage, True)], side="main")
    check("main side skips sidechain entries (orchestrator behavior)", st["messages"] == 0 and st["sidechain"] == 1, str(st))


def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
