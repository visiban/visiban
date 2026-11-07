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

Fix rounds. The hook cannot see them (no `glab mr create`), so /fix-mr calls
`python3 scripts/post-mr-cost.py --round --mr <iid>` after its push: it posts
`## Cost of this MR (#N) - record K` (this round's window plus a running total) through
cost-table.py, and prints one line saying what it did. It posts nothing when the ledger is off,
the MR opts out, or record 1 is missing or unreadable.

Usage: reads the hook JSON on stdin.  python3 scripts/post-mr-cost.py --self-test
       python3 scripts/post-mr-cost.py --round --mr <iid> [--session <sid>]
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
    """True when a `## Cost of this MR` note exists, None when the notes could not be read.

    Unreadable is not 'exists': treating it as such made a flaky `glab api` skip the comment with
    no trace. The caller reports it and posts nothing, so a flaky API still never duplicates.
    """
    notes = glab_json("projects/:id/merge_requests/%d/notes?per_page=100" % iid, cwd)
    if not isinstance(notes, list):
        return None
    return any(isinstance(n, dict) and "## Cost of this MR" in str(n.get("body", "")) for n in notes)


def measure(runner, cwd, env, sdir, since, until):
    """Run the three measuring scripts for since..until. Returns (stdout lines, stderr chunks).

    A session that never spawned a subagent has no <sid>/ directory; that is --no-agents, not a failure.
    """
    agents = top_level_agents(sdir, since) if sdir else []
    agent_args = [a for i in agents for a in ("--agent", i)] or ["--no-agents"]
    lines, split = [], []
    for script, extra in (("subagent-tokens.py", agent_args + ["--until", until]),
                          ("orchestrator-tokens.py", ["--since", since, "--until", until]),
                          ("est-cost.py", agent_args + ["--since", since, "--until", until])):
        rc, out, err = runner([sys.executable, os.path.join(HERE, script)] + extra, cwd, env=env)
        split.append(err)
        if rc == 0 and out.strip():
            lines.append(out.strip().splitlines()[0])
    return lines, split


OUTCOME = {"why": ""}


def quiet(why):
    """Record why the hook stayed silent (for the log) and return None."""
    OUTCOME["why"] = why
    return None


def log_firing(cwd, payload, msg):
    """Append one line to <git common dir>/mr-cost-hook.log for a `glab mr create` the hook saw.

    Why: every skip used to be silent, so 'the hook never fired' and 'the hook fired and skipped'
    looked identical. No command text, token or transcript content is logged: only the time, the
    session id, the MR iid (when printed) and a fixed outcome string.
    """
    try:
        rc, out, _ = run(["git", "rev-parse", "--git-common-dir"], cwd, timeout=15)
        base = os.path.abspath(os.path.join(cwd, out.strip())) if rc == 0 and out.strip() else tempfile.gettempdir()
        path = os.path.join(base, "mr-cost-hook.log")
        try:
            if os.path.getsize(path) > (256 << 10):
                os.replace(path, path + ".1")
        except OSError:
            pass
        iid = mr_iid((payload.get("tool_input") or {}).get("command", ""), payload.get("tool_response"))
        outcome = (msg or OUTCOME["why"] or "silent").replace("\n", " ")[:300]
        sid = payload.get("session_id") or "-"
        sid = sid if SESSION_RE.match(str(sid)) else "-"
        with open(path, "a", encoding="utf-8") as f:
            f.write("%s session=%s mr=%s outcome=%s\n" % (now_utc(), sid, iid if iid else "-", outcome))
    except Exception:  # noqa: BLE001 - logging must never break the hook
        pass


def process(payload, projects_dir=None, runner=run):
    """(message or None). The only function with side effects beyond the scripts it runs."""
    OUTCOME["why"] = ""
    if payload.get("tool_name") not in (None, "Bash"):
        return quiet("not a Bash call")
    ti = payload.get("tool_input") or {}
    iid = mr_iid(ti.get("command", ""), payload.get("tool_response"))
    if iid is None:
        return quiet("glab mr create ran but no MR URL was printed" if MR_CREATE_RE.search(ti.get("command", "") or "") else "not an MR create")
    cwd = payload.get("cwd") or os.getcwd()
    manual = "Run it by hand: see docs/development/cost-ledger.md (python3 scripts/cost-table.py --comment --post --mr %d)." % iid
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return quiet("cost-ledger off or unreadable (enabled exit %d)" % rc)  # the opt-out
    sid = payload.get("session_id") or ""
    if not SESSION_RE.match(sid):
        return "MR cost comment skipped for !%d: no usable session id. %s" % (iid, manual)
    d = glab_json("projects/:id/merge_requests/%d" % iid, cwd)
    if isinstance(d, dict) and OFF_MARKER_RE.search(str(d.get("description", ""))):
        return quiet("MR description carries cost-ledger: off")
    seen = already_commented(iid, cwd)
    if seen is None:
        return "MR cost comment not posted for !%d: could not read its notes (glab api failed). %s" % (iid, manual)
    if seen:
        return quiet("a cost comment already exists")
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
    lines, split = measure(runner, cwd, env, sdir, since, until)
    if not any(l.startswith(("subagent-tokens:", "orchestrator-tokens:")) for l in lines):
        return "MR cost comment skipped for !%d: nothing measurable in this session window. %s" % (iid, manual)
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
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


ISSUE_RE = re.compile(r"(?:^|/)(?:feat|fix|docs|chore)/(\d{1,9})-")


def process_round(iid, sid, cwd, projects_dir=None, runner=run):
    """Post `## Cost of this MR (#N) - record K` for a fix round on an MR that already has record 1.

    Why a separate entry point: the PostToolUse hook only sees `glab mr create`. A fix round has no
    such event, and the /fix-mr prose step was the only thing posting its cost, so rounds went
    unrecorded. /fix-mr calls this after its push. The window is the latest record's end (the
    cost-table.py --next-since value) to now; the record itself, its running total and the
    "never edit an earlier record" rule are cost-table.py's. Returns a message (never raises).
    """
    manual = ("Post it by hand: see docs/development/cost-ledger.md "
              "(python3 scripts/cost-table.py --comment --ledger ... --post --mr %d)." % iid)
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return "cost-ledger is off or unreadable: no record posted for !%d." % iid
    if not SESSION_RE.match(sid or ""):
        return "Record skipped for !%d: no usable session id (pass --session). %s" % (iid, manual)
    d = glab_json("projects/:id/merge_requests/%d" % iid, cwd)
    if isinstance(d, dict) and OFF_MARKER_RE.search(str(d.get("description", ""))):
        return "MR !%d carries `cost-ledger: off`: no record posted." % iid
    rc, out, _ = runner([sys.executable, os.path.join(HERE, "cost-table.py"), "--next-since", "--mr", str(iid)], cwd)
    since = out.strip()
    if rc != 0 or not re.match(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)\Z", since):
        return "Record skipped for !%d: it has no readable record 1 to continue from. %s" % (iid, manual)
    projects_dir = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
    sdir = find_session_dir(sid, projects_dir)
    rc, gitdir, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
    gitdir = os.path.abspath(os.path.join(cwd, gitdir.strip())) if rc == 0 and gitdir.strip() else None
    if not gitdir:
        return "Record skipped for !%d: not in a git checkout. %s" % (iid, manual)
    until = now_utc()
    env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
    lines, split = measure(runner, cwd, env, sdir, since, until)
    if not any(l.startswith(("subagent-tokens:", "orchestrator-tokens:")) for l in lines):
        return "Record skipped for !%d: nothing measurable between %s and now. %s" % (iid, since, manual)
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    ledger, splitf = os.path.join(tmp, "lines.txt"), os.path.join(tmp, "split.txt")
    with open(ledger, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [sys.executable, os.path.join(HERE, "cost-table.py"), "--comment", "--ledger", ledger,
           "--split", splitf, "--since", since, "--until", until, "--mr", str(iid), "--post"]
    rc, br, _ = runner(["git", "branch", "--show-current"], cwd)
    m = ISSUE_RE.search(br) if rc == 0 else None
    if m:
        cmd += ["--issue", m.group(1)]
    rc, out, err = runner(cmd, cwd)
    for p in (ledger, splitf):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        os.rmdir(tmp)
    except OSError:
        pass
    if rc != 0:
        return "Record failed for !%d (cost-table exit %d). %s" % (iid, rc, manual)
    # Advance the shared marker so the next `glab mr create` does not re-count this round's tokens.
    try:
        with open(os.path.join(gitdir, "mr-cost-last-until"), "w", encoding="utf-8") as f:
            f.write(until + "\n")
    except OSError:
        pass
    return "Posted the cost record for this fix round on !%d (window %s to %s)." % (iid, since, until)


def round_main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="post-mr-cost.py --round")
    ap.add_argument("--mr", type=int, required=True)
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    a = ap.parse_args(argv)
    print(process_round(a.mr, a.session, os.getcwd()))
    return 0


def main():
    try:
        payload = json.load(sys.stdin)
        msg = process(payload) if isinstance(payload, dict) else None
        if isinstance(payload, dict) and MR_CREATE_RE.search((payload.get("tool_input") or {}).get("command", "") or ""):
            log_firing(payload.get("cwd") or os.getcwd(), payload, msg)
    except Exception as e:  # noqa: BLE001 - a hook must never break the tool call it follows
        msg = "MR cost comment hook errored (%s); post it by hand, see docs/development/cost-ledger.md." % type(e).__name__
        OUTCOME["why"] = "errored: " + type(e).__name__
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
    # The notes read: unreadable is reported (never the old silent 'exists'), readable-and-present is quiet.
    real_glab = globals()["glab_json"]
    try:
        globals()["glab_json"] = lambda path, cwd: {} if path.endswith("%d" % 1745) else None
        msg = process(payload, runner=runner_for(0))
        check("unreadable notes are reported, not silent", msg is not None and "could not read its notes" in msg)
        globals()["glab_json"] = lambda path, cwd: [{"body": "## Cost of this MR (#1)"}] if "notes" in path else {}
        check("existing comment -> quiet", process(payload, runner=runner_for(0)) is None
              and OUTCOME["why"] == "a cost comment already exists")
    finally:
        globals()["glab_json"] = real_glab
    # The log: one line per seen `glab mr create`, outcome text, no command text.
    gd = tempfile.mkdtemp(prefix="post-mr-cost-log-")
    subprocess.run(["git", "init", "-q", gd], check=False)
    secret = "glab mr create --description SECRET-TOKEN-xyz"
    log_firing(gd, dict(payload, tool_input={"command": secret}), None)
    try:
        with open(os.path.join(gd, ".git", "mr-cost-hook.log"), encoding="utf-8") as f:
            logged = f.read()
    except OSError:
        logged = ""
    check("log line written with the outcome", "session=abc-123" in logged and "outcome=" in logged)
    check("log never carries command text", "SECRET-TOKEN" not in logged)
    # --round: every gate must stop before anything is measured or posted.
    def round_runner(enabled_rc, since_rc=0, since="2026-11-07T14:00:00Z"):
        def r(cmd, cwd, env=None, timeout=300):
            calls.append(cmd)
            if cmd[-1:] == ["enabled"]:
                return enabled_rc, "", ""
            if "--next-since" in cmd:
                return since_rc, since + "\n", ""
            return 0, "", ""
        return r

    calls.clear()
    check("round: ledger off -> nothing else runs",
          "off or unreadable" in process_round(7, "abc-123", os.getcwd(), runner=round_runner(1)) and len(calls) == 1)
    check("round: bad session id is reported",
          "no usable session id" in process_round(7, "../x", os.getcwd(), runner=round_runner(0)))
    check("round: ISSUE_RE reads the branch", ISSUE_RE.search("fix/1234-thing").group(1) == "1234"
          and ISSUE_RE.search("chore/mr-cost-comment-enforcement") is None)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % n[0])
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    sys.exit(round_main(sys.argv[2:]) if sys.argv[1:2] == ["--round"] else main())
