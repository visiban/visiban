#!/usr/bin/env python3
"""scripts/post-mr-cost.py - post the `## Cost of this MR` comment right after `glab mr create`.

Why this exists. The cost comment used to appear only when an agent followed the /wave prose
(Step 5.4 measures, Step 6 posts). Any MR opened another way (a plain /mr, a hand-run
`glab mr create`) got no comment, and nothing noticed: of !1736-!1744 only !1737 had one. This
runs as a Claude Code PostToolUse hook on Bash (.claude/settings.json), so the comment no longer
depends on anyone remembering. It reuses the existing scripts; it measures nothing itself.

What it does, only when the Bash command was a `glab mr create` that printed an MR URL:
  1. Opt-out first. `scripts/cost-ledger enabled` must exit 0 (off or unreadable: do nothing),
     and the MR description must not carry the `cost-ledger: off` marker.
  2. Skip when this user already has a `## Cost of this MR` comment on the MR (/wave posts a
     richer one with named agents; this never overwrites it).
  3. Measure this session since the last MR it posted for (or the session start): the
     orchestrator, every top-level subagent that started in the window, and the estimate.
  4. Render and post record 1 through scripts/cost-table.py.
Any failure is fail-soft: the hook exits 0 and tells the model what to run by hand, so a broken
transcript layout can never block an MR. Opt out for yourself with
`scripts/cost-ledger off --local`; see docs/development/cost-ledger.md.

Subagents are found by listing <session>/subagents/agent-*.meta.json without a parentAgentId
(descendants are added by subagent-tokens.py) and keeping those whose transcript starts in the
window. /wave names its agents explicitly and stays more exact; this is the fallback.

Usage: reads the hook JSON on stdin.  python3 scripts/post-mr-cost.py --self-test
Exit:  always 0 as a hook; --self-test 0 ok, 1 failed.
"""
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
MR_CREATE_RE = re.compile(r"(?:^|[\s;&|(])glab\s+mr\s+create(?:\s|$)")
MR_URL_RE = re.compile(r"/-/merge_requests/(\d{1,9})(?![\d])")
SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")
AGENT_RE = re.compile(r"^agent-([0-9A-Za-z][0-9A-Za-z_-]{0,127})\.meta\.json\Z")
TS_FMT = "%Y-%m-%dT%H:%M:%SZ"
EPOCH = "1970-01-01T00:00:00Z"
OFF_MARKER_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I | re.M)


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime(TS_FMT)


def mr_iid(command, response):
    """The new MR's iid when `command` ran `glab mr create` and `response` printed its URL."""
    if not MR_CREATE_RE.search(command or ""):
        return None
    text = response if isinstance(response, str) else json.dumps(response or "")
    m = MR_URL_RE.search(text)
    return int(m.group(1)) if m else None


def run(cmd, cwd, env=None, timeout=300):
    try:
        r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 127, "", type(e).__name__
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def first_timestamp(path):
    """The first parseable `timestamp` in a transcript, or None."""
    import transcript_usage as tu
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _, line in zip(range(50), f):
                try:
                    ts = json.loads(line).get("timestamp")
                except (ValueError, AttributeError):
                    continue
                t = tu.parse_time(ts) if isinstance(ts, str) else None
                if t is not None:
                    return t
    except OSError:
        return None
    return None


def top_level_agents(session_dir, since):
    """Ids of top-level subagents (no parentAgentId) whose transcript starts at or after `since`."""
    import transcript_usage as tu
    floor = tu.parse_time(since)
    ids = []
    for meta in sorted(glob.glob(os.path.join(glob.escape(session_dir), "subagents", "agent-*.meta.json"))):
        m = AGENT_RE.match(os.path.basename(meta))
        if not m:
            continue
        try:
            with open(meta, encoding="utf-8") as f:
                if json.load(f).get("parentAgentId"):
                    continue
        except (OSError, ValueError, AttributeError):
            continue
        started = first_timestamp(meta[:-len(".meta.json")] + ".jsonl")
        if started is not None and floor is not None and started >= floor:
            ids.append(m.group(1))
    return ids


def find_session_dir(sid, projects_dir):
    hits = sorted(h for h in glob.glob(os.path.join(glob.escape(projects_dir), "*", sid)) if os.path.isdir(h))
    return hits[0] if len(hits) == 1 else None


def glab_json(path, cwd):
    rc, out, _ = run(["glab", "api", path], cwd, timeout=60)
    try:
        return json.loads(out) if rc == 0 else None
    except ValueError:
        return None


def already_commented(iid, cwd):
    """True when a `## Cost of this MR` note exists. Unreadable notes count as 'exists' so a
    flaky API never produces a duplicate."""
    notes = glab_json("projects/:id/merge_requests/%d/notes?per_page=100" % iid, cwd)
    if not isinstance(notes, list):
        return True
    return any(isinstance(n, dict) and "## Cost of this MR" in str(n.get("body", "")) for n in notes)


def process(payload, projects_dir=None, runner=run):
    """(message or None). The only function with side effects beyond the scripts it runs."""
    if payload.get("tool_name") not in (None, "Bash"):
        return None
    ti = payload.get("tool_input") or {}
    iid = mr_iid(ti.get("command", ""), payload.get("tool_response"))
    if iid is None:
        return None
    cwd = payload.get("cwd") or os.getcwd()
    manual = "Run it by hand: see docs/development/cost-ledger.md (python3 scripts/cost-table.py --comment --post --mr %d)." % iid
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return None  # the opt-out: ledger off (exit 1) or unreadable (exit 2) means no comment
    sid = payload.get("session_id") or ""
    if not SESSION_RE.match(sid):
        return "MR cost comment skipped for !%d: no usable session id. %s" % (iid, manual)
    d = glab_json("projects/:id/merge_requests/%d" % iid, cwd)
    if isinstance(d, dict) and OFF_MARKER_RE.search(str(d.get("description", ""))):
        return None  # the description opts out
    if already_commented(iid, cwd):
        return None
    projects_dir = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    sdir = find_session_dir(sid, projects_dir)
    has_transcript = bool(glob.glob(os.path.join(glob.escape(projects_dir), "*", sid + ".jsonl")))
    if sdir is None and not has_transcript:
        return "MR cost comment skipped for !%d: session transcript not found. %s" % (iid, manual)
    rc, gitdir, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
    gitdir = os.path.abspath(os.path.join(cwd, gitdir.strip())) if rc == 0 and gitdir.strip() else None
    if not gitdir:
        return "MR cost comment skipped for !%d: not in a git checkout. %s" % (iid, manual)
    state = os.path.join(gitdir, "mr-cost-last-until")
    since = EPOCH
    try:
        with open(state, encoding="utf-8") as f:
            cand = f.read().strip()
        if re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z", cand):
            since = cand
    except OSError:
        pass
    until = now_utc()
    env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
    # A session that never spawned a subagent has no <sid>/ directory; that is --no-agents, not a failure.
    agents = top_level_agents(sdir, since) if sdir else []
    agent_args = [a for i in agents for a in ("--agent", i)] or ["--no-agents"]
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    lines, split = [], []
    for script, extra in (("subagent-tokens.py", agent_args + ["--until", until]),
                          ("orchestrator-tokens.py", ["--since", since, "--until", until]),
                          ("est-cost.py", agent_args + ["--since", since, "--until", until])):
        rc, out, err = runner([sys.executable, os.path.join(HERE, script)] + extra, cwd, env=env)
        split.append(err)
        if rc == 0 and out.strip():
            lines.append(out.strip().splitlines()[0])
    if not any(l.startswith(("subagent-tokens:", "orchestrator-tokens:")) for l in lines):
        return "MR cost comment skipped for !%d: nothing measurable in this session window. %s" % (iid, manual)
    desc, splitf = os.path.join(tmp, "desc.md"), os.path.join(tmp, "split.txt")
    with open(desc, "w", encoding="utf-8") as f:
        f.write("## Gates\n" + "\n".join(lines) + "\n")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [sys.executable, os.path.join(HERE, "cost-table.py"), "--file", desc, "--comment", "--post",
           "--mr", str(iid), "--until", until, "--split", splitf]
    m = re.search(r"(?:^|/)(?:feat|fix|docs|chore)/(\d{1,9})-", str(ti.get("command", "")))
    if m:
        cmd += ["--issue", m.group(1)]
    rc, out, err = runner(cmd, cwd)
    for p in (desc, splitf):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    if rc != 0:
        return "MR cost comment failed for !%d (cost-table exit %d). %s" % (iid, rc, manual)
    try:
        with open(state, "w", encoding="utf-8") as f:
            f.write(until + "\n")
    except OSError:
        pass
    return "Posted the `## Cost of this MR` comment on !%d (opt out: scripts/cost-ledger off --local)." % iid


def main():
    try:
        payload = json.load(sys.stdin)
        msg = process(payload) if isinstance(payload, dict) else None
    except Exception as e:  # noqa: BLE001 - a hook must never break the tool call it follows
        msg = "MR cost comment hook errored (%s); post it by hand, see docs/development/cost-ledger.md." % type(e).__name__
    if msg:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))
    return 0


def self_test():
    fails, n = [], [0]

    def check(name, cond):
        n[0] += 1
        if not cond:
            fails.append(name)

    url = "https://gitlab.com/visiban/visiban/-/merge_requests/1745\n"
    check("create + url -> iid", mr_iid("glab mr create --title x --yes", {"stdout": url}) == 1745)
    check("create in a chain", mr_iid("git push && glab mr create --yes", url) == 1745)
    check("no create -> none", mr_iid("glab mr view 5", url) is None)
    check("no url -> none", mr_iid("glab mr create --yes", "boom") is None)
    check("huge digit run is not an iid", mr_iid("glab mr create", "/-/merge_requests/" + "9" * 12) is None)

    calls = []

    def runner_for(enabled_rc):
        def r(cmd, cwd, env=None, timeout=300):
            calls.append(cmd)
            if cmd[-1:] == ["enabled"]:
                return enabled_rc, "", ""
            return 0, "", ""
        return r

    payload = {"tool_name": "Bash", "tool_input": {"command": "glab mr create --yes"},
               "tool_response": {"stdout": url}, "session_id": "abc-123", "cwd": os.getcwd()}
    for rc, label in ((1, "off"), (2, "unreadable")):
        calls.clear()
        check("ledger %s -> silent no-op" % label, process(payload, runner=runner_for(rc)) is None
              and len(calls) == 1)
    calls.clear()
    check("non-MR command never touches anything",
          process(dict(payload, tool_input={"command": "ls"}), runner=runner_for(0)) is None and not calls)
    check("bad session id is reported, not fatal",
          "no usable session id" in (process(dict(payload, session_id="../x"), runner=runner_for(0)) or ""))

    tmp = tempfile.mkdtemp(prefix="post-mr-cost-test-")
    sdir = os.path.join(tmp, "slug", "abc-123", "subagents")
    os.makedirs(sdir)
    for aid, parent, ts in (("top1", None, "2026-11-07T10:00:00Z"), ("kid1", "top1", "2026-11-07T10:01:00Z"),
                            ("old1", None, "2026-11-01T10:00:00Z")):
        with open(os.path.join(sdir, "agent-%s.meta.json" % aid), "w") as f:
            json.dump({"parentAgentId": parent} if parent else {}, f)
        with open(os.path.join(sdir, "agent-%s.jsonl" % aid), "w") as f:
            f.write(json.dumps({"type": "assistant", "timestamp": ts}) + "\n")
    got = top_level_agents(os.path.join(tmp, "slug", "abc-123"), "2026-11-05T00:00:00Z")
    check("top-level agents in the window only (no descendants, none before since)", got == ["top1"])
    check("session dir resolves", find_session_dir("abc-123", tmp) == os.path.join(tmp, "slug", "abc-123"))
    check("missing session dir -> None", find_session_dir("zzz", tmp) is None)
    check("off marker regex", OFF_MARKER_RE.search("## Gates\ncost-ledger: off\n") is not None
          and OFF_MARKER_RE.search("cost-ledger: on") is None)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % n[0])
    return 0


if __name__ == "__main__":
    sys.exit(self_test() if sys.argv[1:] == ["--self-test"] else main())
