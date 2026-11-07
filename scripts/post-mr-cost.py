#!/usr/bin/env python3
"""scripts/post-mr-cost.py - the only code that measures and posts an MR's `## Cost of this MR` record.

Why this exists. The cost comment used to appear only when an agent followed the /wave prose, and
the records it posted overlapped: every MR of one session repeated the session's growing total
(macrodream/blueprint#387). This script owns the whole measure-and-post path so that the records of
one session add up to that session's spend, with no token counted in two of them.

Three entry points, one measuring path:
  hook      PostToolUse(Bash) in .claude/settings.json, reads the hook JSON on stdin. Only when the
            command was a `glab mr create` that printed an MR URL: posts record 1.
  --round   `post-mr-cost.py --round --mr <iid>`: posts record K (K >= 2) for work done after the MR
            opened (/fix-mr calls it after its push).
  --measure `post-mr-cost.py --measure`: prints the `## Gates` ledger lines (`subagent-tokens:`,
            `orchestrator-tokens:`, `est-cost-usd:`) for the same window, posts nothing and advances
            nothing. /wave's go-ahead snapshot uses it.
`--agent <id>` (repeatable; --round and --measure) names exact agents instead of auto-attribution.
`--measure --agent <id> --pin` also records them for the current branch in a per-session pins file,
which the hook and --round read, and which leaves those agents out of every other branch's record.
`--retry --mr <iid>` is what the fail-soft messages print: record 1 if the MR has no cost comment,
else the next record.

The window of a record (non-overlap). Per-session state lives at
`<git-common-dir>/mr-cost-state/<session-id>.json`:
    {"schema": 1, "orchestrator_until": "<UTC Z>", "agents": {"<agent-id>": "<UTC Z>"}}
written atomically (a temp file in the same directory, then os.replace) and advanced after EVERY
successful post to the record's `until`, for the orchestrator and for each agent the record
measured. A record then claims only what no earlier record of the session claimed:
  orchestrator   [orchestrator_until, now]; with no state, from the session transcript's first entry
  each agent     [that agent's watermark, now]; with none, from the agent's own first entry
A watermark is an exclusive lower bound (one microsecond past the stored second), so a response
stamped exactly at the previous record's end is counted once. The state is per session because a
session never shares a window with another one; the legacy shared `mr-cost-last-until` marker is
never read, not even as a fallback, since reading it brings the shared-marker overlap back. A state
file that exists but cannot be read posts nothing and says so: guessing a window would double count.

Which top-level subagents belong to an MR (attribution). A subagent transcript records the session
root as its cwd and `main` as its branch, so neither can attribute it. The agent's BRIEF can: the
text of the first `user` entry in its transcript. An agent is counted for this MR when
  1. it was named with `--agent` (always), or
  2. its brief names this MR's source branch or its worktree directory leaf, or
  3. its brief names no other branch matching (feat|fix|docs|chore)/<digits>-, and
and in every case it has usage after its watermark. An agent whose brief names another branch is
left for that branch's record. A descendant is measured over its own watermark and goes with its
top-level parent. The brief is untrusted text: it is only matched against, never echoed.

Any failure is fail-soft: the hook exits 0 and prints the command to re-run,
`python3 scripts/post-mr-cost.py --retry --mr <iid> --session <sid>`, so a broken transcript layout
can never block an MR. The hook posts only for the repo it runs in: the project in the printed MR URL
must equal this repo's `origin` project (the hook's cwd is the session's directory, which can be a
different repo from the one the MR was opened on), and every API call names its project explicitly. Opt out for yourself with `scripts/cost-ledger off --local`;
see docs/development/cost-ledger.md.

Usage: reads the hook JSON on stdin.            python3 scripts/post-mr-cost.py --self-test
       python3 scripts/post-mr-cost.py --round --mr <iid> [--session <sid>] [--agent <id> ...]
       python3 scripts/post-mr-cost.py --measure [--branch <name>] [--session <sid>] [--agent <id> ... [--pin]]
       python3 scripts/post-mr-cost.py --retry --mr <iid> [--session <sid>]
Exit:  always 0 as a hook; --round and --measure 0 (posted, or said why not); --self-test 0 ok, 1 failed.
"""
import datetime
import glob
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
MR_CREATE_RE = re.compile(r"(?:^|[\s;&|(])glab\s+mr\s+create(?:\s|$)")
MR_URL_RE = re.compile(r"/-/merge_requests/(\d{1,9})(?![\d])")
# `https://<host>/<namespace/project>/-/merge_requests/<n>`: the project is everything between the host and `/-/`.
MR_PROJECT_RE = re.compile(r"https?://[^/\s\"']+/([0-9A-Za-z_.-]+(?:/[0-9A-Za-z_.-]+){1,10})/-/merge_requests/\d")
SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")
TS_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z")
TS_FMT = "%Y-%m-%dT%H:%M:%SZ"
OFF_MARKER_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I | re.M)
ISSUE_RE = re.compile(r"(?:^|/)(?:feat|fix|docs|chore)/(\d{1,9})-")
# A branch name as a brief writes it. The lookbehind lets a path or remote prefix precede it
# (`origin/feat/1-x`, `../wt/1-x`) but not a longer word; the lookahead stops `feat/1-x` matching
# inside `feat/1-x-v2`.
OTHER_BRANCH_RE = re.compile(r"(?<![\w.-])((?:feat|fix|docs|chore)/\d+-[\w.-]*\w)")
LEAF_RE = re.compile(r"^\d+-\S")
BRIEF_CAP = 256 << 10
STATE_SCHEMA = 1


def retry_hint(iid, sid):
    """The fail-soft hint every message prints. `--retry` posts record 1 when the MR has no cost
    comment yet, else the next record, and advances the session state like any other post. It always
    names the session, so it works without $CLAUDE_CODE_SESSION_ID; `<iid>` and `<session-id>` are
    literal placeholders when the value is not known."""
    return ("Re-run in this repo's checkout: python3 scripts/post-mr-cost.py --retry --mr %s --session %s "
            "(docs/development/cost-ledger.md)." % (iid if iid else "<iid>", sid if SESSION_RE.match(sid or "") else "<session-id>"))


def mr_project(text):
    """The `namespace/project` path in the first MR URL of `text` (the hook's tool response), or None."""
    m = MR_PROJECT_RE.search(text if isinstance(text, str) else json.dumps(text or ""))
    return m.group(1) if m else None


def parse_remote(url):
    """`namespace/project` from a git remote URL (https, scp-like ssh or ssh://), or None."""
    u = (url or "").strip()
    m = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/]+/(.+?)/?$", u) or re.match(r"^[^@/\s]+@[^:/\s]+:(.+?)/?$", u)
    if not m:
        return None
    path = re.sub(r"\.git$", "", m.group(1))
    return path if re.match(r"^[0-9A-Za-z_.-]+(?:/[0-9A-Za-z_.-]+){1,10}\Z", path) else None


def repo_project(runner, cwd):
    """The GitLab project of the repo the hook runs in: its `origin` remote, no network."""
    rc, out, _ = runner(["git", "remote", "get-url", "origin"], cwd)
    return parse_remote(out) if rc == 0 else None


def api_base(project):
    """`projects/<url-encoded path>` so no call ever resolves `:id` against the wrong repo."""
    return "projects/%s" % urllib.parse.quote(project, safe="")


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime(TS_FMT)


def bound(ts):
    """The exclusive lower bound after a stored watermark: one microsecond past it. The measuring
    scripts treat --since as inclusive, so a response stamped exactly at the previous record's end
    would otherwise be counted in both records."""
    t = datetime.datetime.strptime(ts, TS_FMT).replace(tzinfo=datetime.timezone.utc)
    return (t + datetime.timedelta(microseconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


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


def glab_json(path, cwd):
    rc, out, _ = run(["glab", "api", path], cwd, timeout=60)
    try:
        return json.loads(out) if rc == 0 else None
    except ValueError:
        return None


def already_commented(iid, cwd, project):
    """True when a `## Cost of this MR` note exists, None when the notes could not be read.

    Unreadable is not 'exists': treating it as such made a flaky `glab api` skip the comment with
    no trace. The caller reports it and posts nothing, so a flaky API still never duplicates.
    """
    notes = glab_json("%s/merge_requests/%d/notes?per_page=100" % (api_base(project), iid), cwd)
    if not isinstance(notes, list):
        return None
    return any(isinstance(n, dict) and "## Cost of this MR" in str(n.get("body", "")) for n in notes)


# --- transcripts ---------------------------------------------------------------------------

def find_session_dir(sid, projects_dir):
    hits = sorted(h for h in glob.glob(os.path.join(glob.escape(projects_dir), "*", sid)) if os.path.isdir(h))
    return hits[0] if len(hits) == 1 else None


def first_timestamp(path):
    """The first parseable `timestamp` in a transcript as UTC `...Z`, or None."""
    import transcript_usage as tu
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _, line in zip(range(200), f):
                try:
                    ts = json.loads(line).get("timestamp")
                except (ValueError, AttributeError, RecursionError):
                    continue
                t = tu.parse_time(ts) if isinstance(ts, str) else None
                if t is not None:
                    return t.astimezone(datetime.timezone.utc).strftime(TS_FMT)
    except OSError:
        return None
    return None


def first_user_text(path):
    """The text of the first `user` entry of a transcript (the agent's brief), '' when none.

    Untrusted: the caller only matches against it and never prints it."""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for _, line in zip(range(200), f):
                try:
                    e = json.loads(line)
                except (ValueError, RecursionError):
                    continue
                if not isinstance(e, dict) or e.get("type") != "user":
                    continue
                c = (e.get("message") or {}).get("content") if isinstance(e.get("message"), dict) else None
                if isinstance(c, str):
                    return c[:BRIEF_CAP]
                if isinstance(c, list):
                    return "\n".join(b.get("text", "") for b in c
                                     if isinstance(b, dict) and isinstance(b.get("text"), str))[:BRIEF_CAP]
                return ""
    except OSError:
        return ""
    return ""


def top_level_agents(session_dir):
    """Ids of top-level subagents (a meta file without parentAgentId) that have a transcript."""
    import transcript_usage as tu
    ids = []
    for meta in sorted(glob.glob(os.path.join(glob.escape(session_dir), "subagents", "agent-*.meta.json"))):
        aid = os.path.basename(meta)[len("agent-"):-len(".meta.json")]
        if not tu.AGENT_ID_RE.match(aid):
            continue
        try:
            with open(meta, encoding="utf-8") as f:
                if json.load(f).get("parentAgentId"):
                    continue
        except (OSError, ValueError, AttributeError, RecursionError):
            continue
        if os.path.isfile(meta[:-len(".meta.json")] + ".jsonl"):
            ids.append(aid)
    return ids


def names(brief, token):
    """True when `token` (a branch or a worktree leaf) appears in the brief as a whole name."""
    return bool(token) and re.search(r"(?<![\w.-])" + re.escape(token) + r"(?![\w-])", brief) is not None


def attribution(brief, branch, leaf):
    """True: the brief names this MR's branch or worktree leaf. False: it names another branch
    (and not this one). None: it names no branch, so usage alone decides."""
    # A worktree leaf is `<issue>-<slug>` (scripts/wt). Requiring the digits keeps a repo or checkout
    # name such as `blueprint` from matching `org/blueprint` in a brief and claiming every agent.
    if names(brief, branch) or (LEAF_RE.match(leaf or "") and names(brief, leaf)):
        return True
    if any(m != branch for m in OTHER_BRANCH_RE.findall(brief)):
        return False
    return None


# --- per-session state ---------------------------------------------------------------------

class StateError(Exception):
    """The state file exists but is not a valid schema-1 state."""


def state_path(gitdir, sid):
    return os.path.join(gitdir, "mr-cost-state", sid + ".json")


def read_state(gitdir, sid):
    """{'orchestrator_until': str or None, 'agents': {id: str}}; empty when no state file exists.
    Raises StateError for one that exists but does not validate (never guessed around)."""
    import transcript_usage as tu
    try:
        with open(state_path(gitdir, sid), encoding="utf-8") as f:
            raw = f.read(1 << 20)
    except FileNotFoundError:
        return {"orchestrator_until": None, "agents": {}}
    except OSError:
        raise StateError("unreadable")
    try:
        d = json.loads(raw)
    except (ValueError, RecursionError):
        raise StateError("not JSON")
    if not isinstance(d, dict) or d.get("schema") != STATE_SCHEMA:
        raise StateError("unknown schema")
    ou, ag = d.get("orchestrator_until"), d.get("agents")
    if not isinstance(ag, dict) or (ou is not None and not (isinstance(ou, str) and TS_RE.match(ou))):
        raise StateError("malformed")
    for k, v in ag.items():
        if not (isinstance(k, str) and tu.AGENT_ID_RE.match(k) and isinstance(v, str) and TS_RE.match(v)):
            raise StateError("malformed")
    return {"orchestrator_until": ou, "agents": dict(ag)}


def write_state(gitdir, sid, state, until, agent_ids):
    """Advance the session's state to `until` for the orchestrator and every agent in agent_ids,
    atomically. Returns True on success. A watermark never moves backwards."""
    def later(old, new):
        return new if old is None or new > old else old
    agents = dict(state["agents"])
    for a in agent_ids:
        agents[a] = later(agents.get(a), until)
    doc = {"schema": STATE_SCHEMA, "orchestrator_until": later(state["orchestrator_until"], until), "agents": agents}
    d = os.path.dirname(state_path(gitdir, sid))
    try:
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f, sort_keys=True)
                f.write("\n")
            os.replace(tmp, state_path(gitdir, sid))
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
    except OSError:
        return False
    return True


# --- agents pinned to a branch (--measure --pin) -------------------------------------------

def pins_path(gitdir, sid):
    return os.path.join(gitdir, "mr-cost-state", sid + ".pins.json")


def read_pins(gitdir, sid):
    """{branch: [agent id]} the orchestrator named for this session, {} when none. Raises StateError.

    Kept apart from the state file so the state schema stays {orchestrator_until, agents}."""
    import transcript_usage as tu
    try:
        with open(pins_path(gitdir, sid), encoding="utf-8") as f:
            d = json.loads(f.read(1 << 20))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, RecursionError):
        raise StateError("pins unreadable")
    b = d.get("branches") if isinstance(d, dict) and d.get("schema") == STATE_SCHEMA else None
    if not isinstance(b, dict) or not all(isinstance(k, str) and isinstance(v, list)
                                          and all(isinstance(a, str) and tu.AGENT_ID_RE.match(a) for a in v)
                                          for k, v in b.items()):
        raise StateError("pins malformed")
    return {k: list(v) for k, v in b.items()}


def write_pins(gitdir, sid, branch, ids):
    """Record that these agents belong to `branch` (atomically); True on success. An agent pinned to
    a branch is left out of every other branch's record, so name it once and the hook (record 1) and
    --round (record K) both attribute it the way --measure did."""
    pins = read_pins(gitdir, sid)
    for k in list(pins):
        pins[k] = [a for a in pins[k] if a not in ids]
    pins[branch] = sorted(set(pins.get(branch, [])) | set(ids))
    d = os.path.dirname(pins_path(gitdir, sid))
    try:
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".pins-", suffix=".tmp", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"schema": STATE_SCHEMA, "branches": pins}, f, sort_keys=True)
                f.write("\n")
            os.replace(tmp, pins_path(gitdir, sid))
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
    except OSError:
        return False
    return True


# --- measuring -----------------------------------------------------------------------------

class Opts:
    """Where the measuring scripts read from; overridden by the golden fixture so it is hermetic."""
    def __init__(self, projects_dir=None, prices=None, today=None):
        self.projects_dir = projects_dir or os.path.join(os.path.expanduser("~"), ".claude", "projects")
        self.prices = prices
        self.today = today


def select_agents(sdir, branch, leaf, explicit, state_agents, until, pinned_elsewhere=frozenset()):
    """(agent ids to measure, descendant ids with a watermark, notes). See the module docstring for
    the attribution rule. `notes` are fixed strings: no brief or transcript text."""
    import transcript_usage as tu
    chosen, notes = [], []
    if not sdir:
        return chosen, notes
    until_dt = tu.parse_time(until)
    for aid in top_level_agents(sdir):
        path = os.path.join(sdir, "subagents", "agent-%s.jsonl" % aid)
        forced = aid in explicit
        if aid in pinned_elsewhere and not forced:
            continue
        if not forced:
            verdict = attribution(first_user_text(path), branch, leaf)
            if verdict is False:
                continue
        try:
            agents, files = tu.subagent_files(sdir, [aid])
        except ValueError:
            notes.append("an agent group could not be read and was left out")
            continue
        since = {m: tu.parse_time(bound(state_agents[m])) for m, _ in agents if m in state_agents}
        try:
            with_usage = tu.measure_rows_sources(tu.agent_sources(files, agents, since), until_dt, side="sidechain")[1]["messages"]
        except OSError:
            with_usage = 0
        if with_usage:
            chosen.append(aid)
        elif forced:
            notes.append("a named agent had no usage in the window and was left out")
    for missing in explicit - set(top_level_agents(sdir)):
        notes.append("a named agent id is not a top-level agent of this session and was ignored")
    return chosen, notes


def measure(runner, cwd, sid, sdir, opts, since, until, agent_ids, state_agents):
    """Run the three measuring scripts. Returns (stdout lines, stderr chunks, every agent id the
    window measured: the chosen ones and their descendants).

    A window with no agent runs --no-agents, which is a measured 0 and not a forgotten --agent."""
    import transcript_usage as tu
    members = []
    sub_args = ["--no-agents"]
    if agent_ids:
        try:
            agents, _ = tu.subagent_files(sdir, agent_ids)
        except ValueError:
            agents = [(a, True) for a in agent_ids]
        members = [a for a, _ in agents]
        sub_args = []
        for a, named in agents:
            if named:
                sub_args += ["--agent", a + ("@" + bound(state_agents[a]) if a in state_agents else "")]
            elif a in state_agents:
                sub_args += ["--agent-since", a + "@" + bound(state_agents[a])]
    est_extra = (["--prices", opts.prices] if opts.prices else []) + (["--today", opts.today] if opts.today else [])
    env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
    pd = ["--projects-dir", opts.projects_dir]
    lines, split = [], []
    for script, extra in (("subagent-tokens.py", sub_args + ["--until", until, "--session", sid] + pd),
                          ("orchestrator-tokens.py", [sid, "--since", since, "--until", until] + pd),
                          ("est-cost.py", sub_args + ["--since", since, "--until", until, "--session", sid] + pd + est_extra)):
        rc, out, err = runner([sys.executable, os.path.join(HERE, script)] + extra, cwd, env=env)
        split.append(err)
        if rc == 0 and out.strip():
            lines.append(out.strip().splitlines()[0])
    return lines, split, members


OUTCOME = {"why": ""}


def quiet(why):
    """Record why the hook stayed silent (for the log) and return None."""
    OUTCOME["why"] = why
    return None


def git_common_dir(runner, cwd):
    rc, out, _ = runner(["git", "rev-parse", "--git-common-dir"], cwd)
    return os.path.abspath(os.path.join(cwd, out.strip())) if rc == 0 and out.strip() else None


def worktree_leaf(runner, cwd):
    """The directory leaf of a LINKED worktree, else ''. In the main checkout the toplevel's name is
    the repo's, which says nothing about a branch (and appears in every brief that names the repo)."""
    rc, top, _ = runner(["git", "rev-parse", "--show-toplevel"], cwd)
    rc2, gd, _ = runner(["git", "rev-parse", "--absolute-git-dir"], cwd)
    cd = git_common_dir(runner, cwd)
    if rc or rc2 or not top.strip() or not gd.strip() or not cd:
        return ""
    if os.path.realpath(gd.strip()) == os.path.realpath(cd):
        return ""
    return os.path.basename(top.strip())


def plan(runner, cwd, sid, gitdir, branch, explicit, opts, until, floor=None):
    """(start, exclusive, sdir, agent ids, state, notes, error) for the next record of this session.

    `start` is where the orchestrator window begins: the session's stored watermark (exclusive, the
    previous record already claimed up to it), else `floor`, the MR's previous record end for
    --round (also exclusive), else the session transcript's first entry (inclusive). It is never
    earlier than `floor`, so a record cannot claim to overlap the record before it on the same MR."""
    import transcript_usage as tu
    try:
        state = read_state(gitdir, sid)
    except StateError as e:
        return (None,) * 6 + ("this session's cost state is %s (%s)" % (e, state_path(gitdir, sid)),)
    sdir = find_session_dir(sid, opts.projects_dir)
    try:
        main_path, _ = tu.session_paths(sid, opts.projects_dir)
    except ValueError:
        return (None,) * 6 + ("the session transcript was not found",)
    start, exclusive = state["orchestrator_until"], True
    if start is None:
        if floor:
            start = floor
        else:
            start, exclusive = first_timestamp(main_path) or "1970-01-01T00:00:00Z", False
    elif floor and floor > start:
        start = floor
    try:
        pins = read_pins(gitdir, sid)
    except StateError as e:
        return (None,) * 6 + ("this session's pinned agents are %s (%s)" % (e, pins_path(gitdir, sid)),)
    here = set(pins.get(branch, [])) | set(explicit)
    elsewhere = {a for k, v in pins.items() if k != branch for a in v} - here
    ids, notes = select_agents(sdir, branch, worktree_leaf(runner, cwd), here, state["agents"], until, elsewhere)
    return start, exclusive, sdir, ids, state, notes, None


def post_record(runner, cwd, iid, gitdir, sid, sdir, opts, since, exclusive, until, ids, state, branch, round_k, project):
    """Measure, post through cost-table.py and advance the state. Returns (message, ok)."""
    lines, split, members = measure(runner, cwd, sid, sdir, opts, bound(since) if exclusive else since, until,
                                    ids, state["agents"])
    # `subagent-tokens: 0` is what --no-agents prints (a measured zero, not usage), so on its own it
    # must not turn an empty window into a record of zeros.
    if not any(l.startswith("orchestrator-tokens:") or (l.startswith("subagent-tokens:") and l.split(":")[1].strip() != "0")
               for l in lines):
        return "nothing measurable in this session window", False
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    ledger, splitf = os.path.join(tmp, "lines.txt"), os.path.join(tmp, "split.txt")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [sys.executable, os.path.join(HERE, "cost-table.py"), "--comment"]
    if round_k:
        with open(ledger, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        cmd += ["--ledger", ledger, "--since", since]
    else:
        with open(ledger, "w", encoding="utf-8") as f:
            f.write("## Gates\n" + "\n".join(lines) + "\n")
        cmd += ["--file", ledger]
    cmd += ["--post", "--mr", str(iid), "--until", until, "--split", splitf, "--project", project]
    m = ISSUE_RE.search(branch or "")
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
        return "cost-table exit %d" % rc, False
    if not write_state(gitdir, sid, state, until, members):
        return "posted, but the session cost state could not be written (the next record may overlap this one)", True
    return "", True


def mr_branch(iid, cwd, runner, project):
    """The MR's source branch from the forge, else the checked-out branch."""
    d = glab_json("%s/merge_requests/%d" % (api_base(project), iid), cwd)
    if isinstance(d, dict) and isinstance(d.get("source_branch"), str):
        return d, d["source_branch"]
    rc, out, _ = runner(["git", "branch", "--show-current"], cwd)
    return d, out.strip() if rc == 0 else ""


def process(payload, opts=None, runner=run, project=None):
    """(message or None). Record 1 for the MR a `glab mr create` just opened.

    The hook's cwd is the SESSION's directory, so a session that started in repo X and ran
    `glab mr create` for repo Y would read X's MR with Y's iid. The project in the printed MR URL
    must therefore equal the project of the repo the hook runs in, or nothing is posted (`project`
    is given only by --retry, which runs inside the right checkout)."""
    OUTCOME["why"] = ""
    opts = opts or Opts()
    if payload.get("tool_name") not in (None, "Bash"):
        return quiet("not a Bash call")
    ti = payload.get("tool_input") or {}
    iid = mr_iid(ti.get("command", ""), payload.get("tool_response"))
    if iid is None:
        return quiet("glab mr create ran but no MR URL was printed" if MR_CREATE_RE.search(ti.get("command", "") or "") else "not an MR create")
    cwd = payload.get("cwd") or os.getcwd()
    sid = payload.get("session_id") or ""
    manual = retry_hint(iid, sid)
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return quiet("cost-ledger off or unreadable (enabled exit %d)" % rc)  # the opt-out
    if project is None:
        url_project, here = mr_project(payload.get("tool_response")), repo_project(runner, cwd)
        if here is None or url_project != here:
            return ("MR cost comment skipped for !%d: it was opened on %s, not on this session's repo (%s), so this "
                    "hook cannot read it. Run it in that project's checkout: python3 scripts/post-mr-cost.py "
                    "--retry --mr %d --session %s" % (iid, url_project or "an unknown project", here or "unknown",
                                                      iid, sid if SESSION_RE.match(sid) else "<session-id>"))
        project = here
    if not SESSION_RE.match(sid):
        return "MR cost comment skipped for !%d: no usable session id. %s" % (iid, manual)
    d, branch = mr_branch(iid, cwd, runner, project)
    if isinstance(d, dict) and OFF_MARKER_RE.search(str(d.get("description", ""))):
        return quiet("MR description carries cost-ledger: off")
    seen = already_commented(iid, cwd, project)
    if seen is None:
        return "MR cost comment not posted for !%d: could not read its notes (glab api failed). %s" % (iid, manual)
    if seen:
        return quiet("a cost comment already exists")
    gitdir = git_common_dir(runner, cwd)
    if not gitdir:
        return "MR cost comment skipped for !%d: not in a git checkout. %s" % (iid, manual)
    until = now_utc()
    since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, [], opts, until)
    if err:
        return "MR cost comment skipped for !%d: %s. %s" % (iid, err, manual)
    why, ok = post_record(runner, cwd, iid, gitdir, sid, sdir, opts, since, excl, until, ids, state, branch, False, project)
    if not ok:
        return "MR cost comment skipped for !%d: %s. %s" % (iid, why, manual)
    return "Posted the `## Cost of this MR` comment on !%d (opt out: scripts/cost-ledger off --local).%s" % (iid, " " + why if why else "")


def process_round(iid, sid, cwd, opts=None, runner=run, explicit=(), project=None):
    """Post `## Cost of this MR (#N) - record K` for work on an MR that already has record 1.

    Why a separate entry point: the PostToolUse hook only sees `glab mr create`. A fix round has no
    such event. The window is the session's own state (what no earlier record of this session
    claimed), never earlier than this MR's latest record end (the cost-table.py --next-since
    value). The record, its running total and the "never edit an earlier record" rule are
    cost-table.py's. Returns a message (never raises)."""
    opts = opts or Opts()
    manual = retry_hint(iid, sid)
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return "cost-ledger is off or unreadable: no record posted for !%d." % iid
    if not SESSION_RE.match(sid or ""):
        return "Record skipped for !%d: no usable session id. %s" % (iid, manual)
    project = project or repo_project(runner, cwd)
    if project is None:
        return "Record skipped for !%d: this checkout has no readable `origin` remote to name its project. %s" % (iid, manual)
    d, branch = mr_branch(iid, cwd, runner, project)
    if isinstance(d, dict) and OFF_MARKER_RE.search(str(d.get("description", ""))):
        return "MR !%d carries `cost-ledger: off`: no record posted." % iid
    rc, out, _ = runner([sys.executable, os.path.join(HERE, "cost-table.py"), "--next-since", "--mr", str(iid), "--project", project], cwd)
    floor = out.strip()
    if rc != 0 or not TS_RE.match(floor):
        return "Record skipped for !%d: it has no readable record 1 to continue from. %s" % (iid, manual)
    gitdir = git_common_dir(runner, cwd)
    if not gitdir:
        return "Record skipped for !%d: not in a git checkout. %s" % (iid, manual)
    until = now_utc()
    since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, explicit, opts, until, floor)
    if err:
        return "Record skipped for !%d: %s. %s" % (iid, err, manual)
    if since > until:
        return "Record skipped for !%d: nothing measurable between %s and now. %s" % (iid, since, manual)
    why, ok = post_record(runner, cwd, iid, gitdir, sid, sdir, opts, since, excl, until, ids, state, branch, True, project)
    if not ok:
        return "Record skipped for !%d: %s. %s" % (iid, why, manual)
    return "Posted the cost record for this fix round on !%d (window %s to %s).%s" % (iid, since, until, " " + why if why else "")


def process_retry(iid, sid, cwd, opts=None, runner=run):
    """The command the fail-soft messages print: record 1 when the MR has no cost comment yet (the
    hook's work), else the next record (--round's). Both advance the session state."""
    project = repo_project(runner, cwd)
    if project is None:
        return "Retry skipped for !%d: this checkout has no readable `origin` remote to name its project." % iid
    seen = already_commented(iid, cwd, project)
    if seen is None:
        return "Retry skipped for !%d: could not read its notes (glab api failed)." % iid
    if seen:
        return process_round(iid, sid, cwd, opts, runner, project=project)
    payload = {"tool_name": "Bash", "tool_input": {"command": "glab mr create"},
               "tool_response": "/-/merge_requests/%d" % iid, "session_id": sid, "cwd": cwd}
    return process(payload, opts, runner, project) or "Retry posted nothing for !%d: %s." % (iid, OUTCOME["why"] or "see mr-cost-hook.log")


def default_branches(runner, cwd):
    """Branch names a pin must never use: `main` and whatever origin/HEAD names."""
    rc, out, _ = runner(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)
    names_ = {"main"}
    if rc == 0 and out.strip():
        names_.add(re.sub(r"^origin/", "", out.strip()))
    return names_


def process_measure(sid, cwd, branch, opts=None, runner=run, explicit=(), pin=False):
    """(stdout lines, stderr text, exit code) for --measure: the ledger lines for the window the next
    record would cover. Posts nothing and leaves the state alone, so /wave can ask at the go-ahead and
    the hook still claims the same tokens at `glab mr create`. Exit 2 is a refusal (a bad --pin)."""
    opts = opts or Opts()
    rc, _, _ = runner([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], cwd)
    if rc != 0:
        return [], "cost-ledger is off or unreadable: nothing measured.\n", 0
    if not SESSION_RE.match(sid or ""):
        return [], "no usable session id (pass --session or set $CLAUDE_CODE_SESSION_ID).\n", 0
    gitdir = git_common_dir(runner, cwd)
    if not gitdir:
        return [], "not in a git checkout.\n", 0
    if not branch:
        rc, out, _ = runner(["git", "branch", "--show-current"], cwd)
        branch = out.strip() if rc == 0 else ""
    warn = ""
    if pin:
        if not explicit or not branch:
            return [], "--pin needs --agent <id> and a branch (run it in the branch's worktree).\n", 2
        if branch in default_branches(runner, cwd):
            return [], ("refusing to pin to the default branch %s: no MR has that source branch, so the pinned agents "
                        "would be left out of every real branch's record and their tokens never claimed. Run --pin in "
                        "the branch's own worktree (or pass --branch <name>).\n" % branch), 2
        try:
            ok = write_pins(gitdir, sid, branch, set(explicit))
        except StateError as e:
            return [], "this session's pinned agents are %s.\n" % e, 2
        if not ok:
            return [], "the pinned agents could not be written.\n", 2
    elif explicit:
        warn = ("post-mr-cost: --agent without --pin applies to this run only; record 1 (the hook) will not "
                "attribute %s unless they are pinned (add --pin).\n" % ", ".join(sorted(set(explicit))))
    until = now_utc()
    since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, explicit, opts, until)
    if err:
        return [], err + ".\n", 0
    lines, split, _members = measure(runner, cwd, sid, sdir, opts, bound(since) if excl else since, until, ids, state["agents"])
    return lines, warn + "".join(split) + "".join("post-mr-cost: %s\n" % n for n in notes), 0


def cli_main(argv):
    import argparse
    ap = argparse.ArgumentParser(prog="post-mr-cost.py")
    ap.add_argument("--round", action="store_true")
    ap.add_argument("--retry", action="store_true")
    ap.add_argument("--pin", action="store_true")
    ap.add_argument("--measure", action="store_true")
    ap.add_argument("--mr", type=int)
    ap.add_argument("--branch", default="")
    ap.add_argument("--agent", action="append", default=[])
    ap.add_argument("--session", default=os.environ.get("CLAUDE_CODE_SESSION_ID", ""))
    a = ap.parse_args(argv)
    import transcript_usage as tu
    bad = [x for x in a.agent if not tu.AGENT_ID_RE.match(x)]
    if bad or [a.round, a.measure, a.retry].count(True) != 1 or ((a.round or a.retry) and not a.mr) \
            or (a.pin and not a.measure):
        ap.error("exactly one of --round or --retry (each needs --mr) or --measure [--pin]; --agent takes an agentId")
    if a.retry:
        print(process_retry(a.mr, a.session, os.getcwd()))
        return 0
    if a.round:
        print(process_round(a.mr, a.session, os.getcwd(), explicit=a.agent))
        return 0
    lines, err, rc = process_measure(a.session, os.getcwd(), a.branch, explicit=a.agent, pin=a.pin)
    sys.stderr.write(err)
    for l in lines:
        print(l)
    return rc


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


def main():
    try:
        payload = json.load(sys.stdin)
        msg = process(payload) if isinstance(payload, dict) else None
        if isinstance(payload, dict) and MR_CREATE_RE.search((payload.get("tool_input") or {}).get("command", "") or ""):
            log_firing(payload.get("cwd") or os.getcwd(), payload, msg)
    except Exception as e:  # noqa: BLE001 - a hook must never break the tool call it follows
        try:
            iid = mr_iid((payload.get("tool_input") or {}).get("command", ""), payload.get("tool_response"))
            sid = payload.get("session_id") or ""
        except Exception:  # noqa: BLE001 - payload may be the thing that was malformed
            iid, sid = None, ""
        msg = "MR cost comment hook errored (%s). %s" % (type(e).__name__, retry_hint(iid, sid))
        OUTCOME["why"] = "errored: " + type(e).__name__
    if msg:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg}}))
    return 0


# --- self-test -----------------------------------------------------------------------------

GOLDEN = os.path.join(HERE, "tests", "cost-ledger-golden")


def golden_cases(check):
    """Replay scripts/tests/cost-ledger-golden/ through the real hook, --round, state and cost-table
    with a fake `glab` (no network) and a temp git dir, and compare with expected.json.

    The fixture is one synthetic session whose records must not overlap: see its scenario.json."""
    import shutil
    import importlib.util
    with open(os.path.join(GOLDEN, "scenario.json"), encoding="utf-8") as f:
        sc = json.load(f)
    with open(os.path.join(GOLDEN, "expected.json"), encoding="utf-8") as f:
        ex = json.load(f)
    tmp = tempfile.mkdtemp(prefix="cost-golden-")
    saved_path, saved_env, saved_now = os.environ.get("PATH", ""), dict(os.environ), globals()["now_utc"]
    try:
        bindir = os.path.join(tmp, "bin")
        os.makedirs(bindir)
        shim = os.path.join(bindir, "glab")
        with open(shim, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, os.path.join(GOLDEN, "fake-glab.py")))
        os.chmod(shim, 0o755)
        gstate = os.path.join(tmp, "glab-state.json")
        with open(gstate, "w", encoding="utf-8") as f:
            json.dump({"mrs": sc["mrs"], "notes": {}, "next_id": 1}, f)
        repo = os.path.join(tmp, "wt-fixture")
        subprocess.run(["git", "init", "-q", repo], check=True)
        subprocess.run(["git", "-C", repo, "remote", "add", "origin", "https://example.test/g/p.git"], check=True)
        empty = os.path.join(tmp, "gitconfig")
        open(empty, "w").close()
        os.environ.update({"PATH": bindir + os.pathsep + saved_path, "FAKE_GLAB_STATE": gstate, "FAKE_GLAB_PROJECT": urllib.parse.quote("g/p", safe=""),
                           "GIT_CONFIG_GLOBAL": empty, "GIT_CONFIG_NOSYSTEM": "1"})
        rc, _, _ = run([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"], repo)
        check("golden: needs the cost ledger on in this checkout (scripts/cost-ledger status)", rc == 0, "enabled exit %d" % rc)
        if rc != 0:
            return
        projects = os.path.join(tmp, "projects")
        shutil.copytree(os.path.join(GOLDEN, "projects"), projects)
        opts = Opts(projects, os.path.join(GOLDEN, "prices.json"), sc["today"])
        spec = importlib.util.spec_from_file_location("cost_table_golden", os.path.join(HERE, "cost-table.py"))
        ct = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ct)
        gitdir = git_common_dir(run, repo)
        sid = sc["session"]
        bodies, errs = [], []

        def crun(cmd, cwd, env=None, timeout=300):
            """run(), keeping the stderr of the three measuring scripts: the per-model split."""
            rc_, out_, err_ = run(cmd, cwd, env, timeout)
            if any(os.path.basename(c) in ("subagent-tokens.py", "orchestrator-tokens.py", "est-cost.py") for c in cmd[:2]):
                errs.append(err_)
            return rc_, out_, err_

        def hook_payload(mr):
            return {"tool_name": "Bash", "tool_input": {"command": "glab mr create --yes"},
                    "tool_response": {"stdout": "https://example.test/g/p/-/merge_requests/%d\n" % mr},
                    "session_id": sid, "cwd": repo}

        for step in sc["steps"]:
            globals()["now_utc"] = lambda t=step["at"]: t
            want = ex["steps"][step["name"]]
            if step["kind"] == "pin":
                lines, _err, _rc = process_measure(sid, repo, step["branch"], opts, crun, step["agents"], pin=True)
                check("golden %s: --measure --pin prints the window's ledger lines" % step["name"], lines == want["lines"], repr(lines))
                check("golden %s: --measure advances nothing" % step["name"],
                      json.loads(open(state_path(gitdir, sid), encoding="utf-8").read()) == want["state"])
                check("golden %s: the pin is recorded for that branch" % step["name"],
                      read_pins(gitdir, sid) == {step["branch"]: step["agents"]}, repr(read_pins(gitdir, sid)))
                continue
            if step["kind"] == "foreign":
                # A session in this repo ran `glab mr create` for ANOTHER project: nothing may be read or posted.
                before = open(gstate + ".log", encoding="utf-8").read() if os.path.exists(gstate + ".log") else ""
                payload = hook_payload(step["mr"])
                payload["tool_response"] = {"stdout": "https://example.test/%s/-/merge_requests/%d\n" % (step["project"], step["mr"])}
                msg = process(payload, opts, crun) or ""
                after = open(gstate + ".log", encoding="utf-8").read() if os.path.exists(gstate + ".log") else ""
                check("golden %s: skipped, naming the project and the --retry command to run there" % step["name"],
                      step["project"] in msg and "--retry --mr %d" % step["mr"] in msg and "--session %s" % sid in msg
                      and not msg.startswith("Posted"), msg)
                check("golden %s: no glab call at all" % step["name"], after == before)
                check("golden %s: the state is untouched" % step["name"],
                      json.loads(open(state_path(gitdir, sid), encoding="utf-8").read()) == want["state"])
                continue
            if step["kind"] == "hook":
                msg = process(hook_payload(step["mr"]), opts, crun) or ""
            elif step["kind"] == "retry":
                # The first attempt cannot read the notes: it must print a command that works.
                real = globals()["already_commented"]
                globals()["already_commented"] = lambda iid, cwd, project: None
                try:
                    hint = process(hook_payload(step["mr"]), opts, crun) or ""
                finally:
                    globals()["already_commented"] = real
                m = re.search(r"python3 scripts/post-mr-cost\.py --retry --mr (\d+)", hint)
                check("golden %s: the fail-soft message prints a post-mr-cost.py --retry command, with the session" % step["name"],
                      m is not None and int(m.group(1)) == step["mr"] and "cost-table.py" not in hint
                      and "--session %s" % sid in hint, hint)
                msg = process_retry(int(m.group(1)), sid, repo, opts, crun) if m else ""
            else:
                msg = process_round(step["mr"], sid, repo, opts, crun)
            with open(gstate, encoding="utf-8") as f:
                notes = json.load(f)["notes"].get(str(step["mr"]), [])
            check("golden %s: posted" % step["name"], msg.startswith("Posted"), msg)
            body = notes[-1]["body"] if notes else ""
            bodies.append(body)
            rec = ct.parse_record(body) or {}
            tot = rec.get("total", {})
            check("golden %s: record number" % step["name"], rec.get("k") == want["record"], repr(rec.get("k")))
            check("golden %s: total tokens and cost" % step["name"],
                  tot.get(("tok", "all")) == want["total_tokens"] and str(tot.get(("usd", "all"))) == want["total_usd"], repr(tot))
            for line in want["rows"]:
                check("golden %s: row %s" % (step["name"], line[:30]), line in body.split("\n"), body)
            for text in want["contains"]:
                check("golden %s: contains %s" % (step["name"], text[:40]), text in body, body)
            for text in ex["forbidden_anywhere"]:
                check("golden %s: never %s" % (step["name"], text), text not in body, body)
            table = [l for l in body.split("\n") if l.startswith("|")]
            for text in ex["forbidden_in_table"]:
                check("golden %s: no %s in a table row" % (step["name"], text), not any(text in l for l in table), "\n".join(table))
            check("golden %s: state after" % step["name"], json.loads(open(state_path(gitdir, sid), encoding="utf-8").read()) == want["state"],
                  open(state_path(gitdir, sid), encoding="utf-8").read())
        split = "".join(errs)
        check("golden: the per-model split carries real model lines", "model claude-sonnet-5-5" in split and "model claude-opus-5-5" in split, split)
        check("golden: the per-model split has no `model unknown` line (an all-zero <synthetic> row is dropped at the parser)",
              "model unknown" not in split and "<synthetic>" not in split, split)
        # --retry on an MR that already has a cost comment is the next record's job (--round).
        globals()["now_utc"] = lambda: "2026-11-07T13:01:00Z"
        again = process_retry(11, sid, repo, opts, crun)
        check("golden: --retry on an MR with a cost comment goes the --round way, and says why nothing was posted",
              again.startswith("Record skipped for !11: nothing measurable in this session window."), again)
        _l, warn_err, _rc = process_measure(sid, repo, "feat/101-a", opts, crun, ["c1000000000000001"])
        check("golden: --measure --agent without --pin warns that the hook will not attribute it",
              "will not attribute c1000000000000001 unless they are pinned" in warn_err and warn_err.count("record 1 (the hook)") == 1, warn_err)
        calls_log = open(gstate + ".log", encoding="utf-8").read()
        check("golden: every glab call names its project (no `:id` anywhere) and the fake accepted them all",
              calls_log.strip() != "" and ":id" not in calls_log and "projects/g%2Fp/" in calls_log, calls_log[:300])
        # No token is claimed twice: the records add up to the session's usage in [start, last until].
        import transcript_usage as tu
        last = tu.parse_time(sc["steps"][-1]["at"])
        every, seen = 0, set()
        for path in sorted(glob.glob(os.path.join(projects, "**", "*.jsonl"), recursive=True)):
            for line in open(path, encoding="utf-8"):
                e = json.loads(line)
                u = (e.get("message") or {}).get("usage") if e.get("type") == "assistant" else None
                if not u or e["message"]["id"] in seen or tu.parse_time(e["timestamp"]) > last:
                    continue
                seen.add(e["message"]["id"])
                every += sum(u.get(k, 0) for k in tu.FIELDS)
        got = sum(((ct.parse_record(b) or {}).get("total", {}).get(("tok", "all")) or 0) for b in bodies)
        check("golden: the records add up to the session's usage (nothing claimed twice, nothing dropped)",
              got == every == ex["session_total_tokens"], "records %d, transcripts %d, expected %d" % (got, every, ex["session_total_tokens"]))
        # The legacy shared marker is never read: a stale one must not move any window.
        marker = os.path.join(gitdir, "mr-cost-last-until")
        open(marker, "w").write("2999-01-01T00:00:00Z\n")
        st = read_state(gitdir, sid)
        check("golden: a legacy mr-cost-last-until marker is not read", st["orchestrator_until"] == sc["steps"][-1]["at"], repr(st))
    finally:
        globals()["now_utc"] = saved_now
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(tmp, ignore_errors=True)


def self_test():
    fails, n = [], [0]

    def check(name, cond, detail=""):
        n[0] += 1
        if not cond:
            fails.append("%s %s" % (name, detail))

    url = "https://gitlab.com/g/p/-/merge_requests/1745\n"
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
            if cmd[:3] == ["git", "remote", "get-url"]:
                return 0, "https://gitlab.com/g/p.git\n", ""
            return 0, "", ""
        return r

    payload = {"tool_name": "Bash", "tool_input": {"command": "glab mr create --yes"},
               "tool_response": {"stdout": url}, "session_id": "abc-123", "cwd": os.getcwd()}
    for rc, label in ((1, "off"), (2, "unreadable")):
        calls.clear()
        check("ledger %s -> silent no-op" % label, process(payload, runner=runner_for(rc)) is None and len(calls) == 1)
    calls.clear()
    check("non-MR command never touches anything",
          process(dict(payload, tool_input={"command": "ls"}), runner=runner_for(0)) is None and not calls)
    check("bad session id is reported, not fatal",
          "no usable session id" in (process(dict(payload, session_id="../x"), runner=runner_for(0)) or ""))
    check("off marker regex", OFF_MARKER_RE.search("## Gates\ncost-ledger: off\n") is not None
          and OFF_MARKER_RE.search("cost-ledger: on") is None)
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

    def round_runner(enabled_rc):
        def r(cmd, cwd, env=None, timeout=300):
            calls.append(cmd)
            return (enabled_rc, "", "") if cmd[-1:] == ["enabled"] else (0, "", "")
        return r

    calls.clear()
    check("round: ledger off -> nothing else runs",
          "off or unreadable" in process_round(7, "abc-123", os.getcwd(), runner=round_runner(1)) and len(calls) == 1)
    check("round: bad session id is reported",
          "no usable session id" in process_round(7, "../x", os.getcwd(), runner=round_runner(0)))
    check("measure: ledger off -> no lines, nothing run",
          process_measure("abc-123", os.getcwd(), "", runner=round_runner(1))[0] == [])
    # Retry hints, the exception path and the project check (macrodream/blueprint#387).
    check("retry hint names the session and the iid", "--retry --mr 7 --session abc-123" in retry_hint(7, "abc-123"))
    check("retry hint with no usable session says <session-id>, never a bare command",
          "--retry --mr 7 --session <session-id>" in retry_hint(7, "../x"))
    check("retry hint with an unknown iid prints the literal <iid>", "--retry --mr <iid> --session" in retry_hint(None, "abc-123"))
    check("no usable session id: the message carries a --session to pass",
          "--session <session-id>" in (process(dict(payload, session_id="../x"), runner=lambda *a, **k: (0, "https://gitlab.test/g/p.git", "")) or ""))
    check("mr_project reads the namespace/project of the URL", mr_project("https://h.test/ns/sub/p/-/merge_requests/5") == "ns/sub/p"
          and mr_project({"stdout": "see https://h.test/g/p/-/merge_requests/9\n"}) == "g/p" and mr_project("nope") is None)
    for url, want in (("https://h.test/g/p.git", "g/p"), ("git@h.test:g/sub/p.git", "g/sub/p"), ("ssh://git@h.test:2222/g/p", "g/p"),
                      ("https://h.test/g/p/", "g/p"), ("/local/path", None), ("", None)):
        check("parse_remote %r" % url, parse_remote(url) == want, repr(parse_remote(url)))
    check("a project from another repo is never posted on (the hook's cwd is the session's repo)",
          "opened on h/other, not on this session's repo (g/p)" in (process(
              dict(payload, tool_response={"stdout": "https://x.test/h/other/-/merge_requests/9\n"}),
              runner=lambda cmd, cwd, env=None, timeout=300: (0, "https://x.test/g/p.git\n" if cmd[:3] == ["git", "remote", "get-url"] else "", "")) or ""))
    errored = io.StringIO()
    saved_stdin, saved_stdout = sys.stdin, sys.stdout
    sys.stdin, sys.stdout = io.StringIO(json.dumps(dict(payload, tool_response={"stdout": "x/-/merge_requests/9"}, cwd=7)) ), errored
    try:
        main()
    finally:
        sys.stdin, sys.stdout = saved_stdin, saved_stdout
    check("the hook's exception path names post-mr-cost.py --retry with the iid",
          "post-mr-cost.py --retry --mr 9 --session abc-123" in errored.getvalue() and "by hand" not in errored.getvalue(), errored.getvalue())
    errored = io.StringIO()
    sys.stdin, sys.stdout = io.StringIO("not json"), errored
    try:
        main()
    finally:
        sys.stdin, sys.stdout = saved_stdin, saved_stdout
    check("an unreadable hook payload still prints the literal <iid> command", "--retry --mr <iid>" in errored.getvalue(), errored.getvalue())
    check("ISSUE_RE reads the branch", ISSUE_RE.search("fix/1234-thing").group(1) == "1234"
          and ISSUE_RE.search("chore/mr-cost-comment-enforcement") is None)

    # Attribution by brief.
    br, lf = "feat/101-a", "101-a"
    check("brief naming the branch -> this MR", attribution("Implement feat/101-a now", br, lf) is True)
    check("brief naming the worktree leaf (a path) -> this MR", attribution("work in ../wt/101-a/ please", br, lf) is True)
    check("brief naming another branch only -> not this MR", attribution("Fix fix/202-b", br, lf) is False)
    check("brief naming both: this MR wins", attribution("feat/101-a, not fix/202-b", br, lf) is True)
    check("brief naming no branch -> usage decides (None)", attribution("Run the regression check", br, lf) is None)
    check("a longer branch is another branch (feat/101-a-v2 is not feat/101-a)", attribution("on feat/101-a-v2", br, lf) is False)
    check("sentence-final period still matches", attribution("Branch is feat/101-a.", br, lf) is True)
    check("a remote prefix still matches", attribution("origin/feat/101-a", br, lf) is True)
    check("an empty leaf matches nothing", attribution("anything", br, "") is None)

    # The exclusive lower bound.
    check("bound is one microsecond past the second", bound("2026-11-07T10:00:00Z") == "2026-11-07T10:00:00.000001Z")

    # State: atomic write, validation, never backwards, legacy marker not read.
    gd2 = tempfile.mkdtemp(prefix="post-mr-cost-state-")
    sid = "sess-1"
    check("no state file -> empty state", read_state(gd2, sid) == {"orchestrator_until": None, "agents": {}})
    st = read_state(gd2, sid)
    aid = "a1111111111111111"
    check("write_state succeeds", write_state(gd2, sid, st, "2026-11-07T10:00:00Z", [aid]))
    check("state round-trips", read_state(gd2, sid) == {"orchestrator_until": "2026-11-07T10:00:00Z", "agents": {aid: "2026-11-07T10:00:00Z"}})
    check("no temp file left behind", [f for f in os.listdir(os.path.join(gd2, "mr-cost-state")) if f.endswith(".tmp")] == [])
    write_state(gd2, sid, read_state(gd2, sid), "2026-11-07T09:00:00Z", [aid])
    check("a watermark never moves backwards", read_state(gd2, sid)["orchestrator_until"] == "2026-11-07T10:00:00Z")
    open(os.path.join(gd2, "mr-cost-last-until"), "w").write("2999-01-01T00:00:00Z\n")
    check("the legacy shared marker is never read", read_state(gd2, sid)["orchestrator_until"] == "2026-11-07T10:00:00Z"
          and read_state(gd2, "other-session")["orchestrator_until"] is None)
    for label, text in (("not JSON", "{nope"), ("wrong schema", '{"schema": 2, "agents": {}}'),
                        ("bad time", '{"schema": 1, "orchestrator_until": "yesterday", "agents": {}}'),
                        ("bad agent id", '{"schema": 1, "orchestrator_until": null, "agents": {"../x": "2026-11-07T10:00:00Z"}}')):
        open(state_path(gd2, "bad"), "w").write(text)
        try:
            read_state(gd2, "bad")
            ok = False
        except StateError:
            ok = True
        check("an invalid state file is an error, never a guess: " + label, ok)

    check("a repo-name leaf (main checkout) does not match `org/repo` in a brief and swallow the exclusion",
          attribution("macrodream/blueprint fix/202-b", br, "blueprint") is False)
    wd = tempfile.mkdtemp(prefix="post-mr-cost-wt-")
    main_co = os.path.join(wd, "main-co")
    git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-C", main_co]
    subprocess.run(["git", "init", "-q", main_co], check=True)
    subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "x"], check=True)
    linked = os.path.join(wd, "101-a")
    subprocess.run(git + ["worktree", "add", "-q", "-b", "feat/101-a", linked], check=True)
    check("worktree_leaf: the main checkout has no leaf", worktree_leaf(run, main_co) == "")
    check("worktree_leaf: a linked worktree's directory is the leaf", worktree_leaf(run, linked) == "101-a")

    # --pin: refuses the default branch, exits non-zero, writes nothing; re-pinning moves an agent.
    subprocess.run(git + ["checkout", "-q", "-B", "main"], check=True)
    a_id = "a1111111111111111"
    lines, err, rc = process_measure("abc-123", main_co, "", runner=run, explicit=[a_id], pin=True)
    check("--pin on main is refused (exit 2) with a clear message and pins nothing",
          rc == 2 and lines == [] and "refusing to pin to the default branch main" in err
          and not os.path.exists(pins_path(os.path.join(main_co, ".git"), "abc-123")), repr((rc, err)))
    subprocess.run(git + ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], check=True)
    check("the default branch is whatever origin/HEAD names", "trunk" in default_branches(run, main_co))
    lines, err, rc = process_measure("abc-123", main_co, "trunk", runner=run, explicit=[a_id], pin=True)
    check("--pin on origin/HEAD's branch is refused too", rc == 2 and "default branch trunk" in err, err)
    lines, err, rc = process_measure("abc-123", main_co, "feat/101-a", runner=run, explicit=[], pin=True)
    check("--pin without --agent is refused", rc == 2 and "--pin needs --agent" in err, err)
    gd3 = tempfile.mkdtemp(prefix="post-mr-cost-pins-")
    write_pins(gd3, "s1", "feat/1-a", {a_id})
    write_pins(gd3, "s1", "feat/2-b", {a_id})
    pins = read_pins(gd3, "s1")
    check("re-pinning an agent to another branch removes it from the first (it belongs to one branch)",
          pins.get("feat/2-b") == [a_id] and a_id not in pins.get("feat/1-a", []), repr(pins))

    golden_cases(check)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("self-test OK (%d checks)" % n[0])
    return 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    sys.exit(cli_main(sys.argv[1:]) if sys.argv[1:] else main())
