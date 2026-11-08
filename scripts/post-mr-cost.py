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
`${CLAUDE_CONFIG_DIR:-~/.claude}/mr-cost-state/<session-id>.json` (one file per session, next to the
transcripts, NOT per repo: a session spans repos):
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
Every post is bracketed by a write-ahead `pending` claim in the state file (written before the post, committed
after it); a post that landed without its commit is settled against the MR's notes by the next run on any MR
(resolve_pending), and one that cannot be settled refuses to post. reconcile() remains for a record with no
pending entry (an older version, or a lost state file).
A POST that landed while the hook was killed (or while cost-table failed on the response) leaves the
record on the MR and the state behind it: the next run of the hook, or of `--retry`, finds that record,
takes the token user's own latest end that is not in the future, and advances the state to it
(reconcile()), so the tokens are not claimed twice. A failed post never advances the state.

Which top-level subagents belong to an MR (attribution). A subagent transcript records the session
root as its cwd and `main` as its branch, so neither can attribute it. Two things in the transcript can:
  1. WHERE IT ACTS (strongest): the worktree holding most of the agent's Edit/Write/NotebookEdit
     `file_path`s, else the worktree its Bash `cd <path>` / `git -C <path>` (not show, diff or log) calls
     target most (a read-only auditor `cd`s into what it audits). When that is known the agent counts for
     this MR if it is this MR's worktree, and not otherwise; the brief is ignored.
  2. ITS BRIEF (the text of its first `user` entry), when no home is known: the agent counts if the brief
     names this MR's source branch, branch leaf or worktree leaf; it is left for another record if it names
     another branch (feat|fix|docs|chore)/<digits>-... or another `.../<issue>-<slug>` worktree path;
     otherwise (an unnamed gate) it counts. A brief that names several worktrees (a port agent) is why
     the home outranks it.
`--agent` and pins override both. In every case the agent needs usage after its watermark. A descendant
is measured over its own watermark and goes with its top-level parent. Briefs, paths and commands are
untrusted text: they are classified and matched, never echoed.

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
import contextlib
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

try:
    import fcntl
except ImportError:  # not POSIX: no advisory locks, the state writes stay atomic but unserialized
    fcntl = None

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "lib"))
sys.path.insert(0, HERE)
from _paths import PathEscapeError, resolve_within  # noqa: E402  (#2152: confine state/session paths)
MR_CREATE_RE = re.compile(r"(?:^|[\s;&|(])glab\s+mr\s+create(?:\s|$)")
MR_URL_RE = re.compile(r"/-/merge_requests/(\d{1,9})(?![\d])")
# `https://<host>/<namespace/project>/-/merge_requests/<n>`: the project is everything between the host and `/-/`.
MR_PROJECT_RE = re.compile(r"https?://[^/\s\"']+/([0-9A-Za-z_.-]+(?:/[0-9A-Za-z_.-]+)+)/-/merge_requests/(\d{1,9})(?![\d])")
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
# A worktree path component in a brief (`.../blueprint-wt/387-cost-records/`): `<digits>-<slug>` after a
# slash. Briefs usually name the worktree, not the branch, so this is how another branch's agent is seen.
OTHER_LEAF_RE = re.compile(r"(?<=/)(\d+-[A-Za-z][\w-]*)(?![\w-]|\.\w)")  # not a file name: `3-tier.md`
BRIEF_CAP = 256 << 10
STATE_SCHEMA = 1
NOTE_PAGES = 20   # 2,000 notes, as cost-table reads; more reads as unreadable, never as absent
PROJECT_PATH_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_.-]*(?:/[0-9A-Za-z_.-]+)+\Z")


def retry_hint(iid, sid):
    """The fail-soft hint every message prints. `--retry` posts record 1 when the MR has no cost
    comment yet, else the next record, and advances the session state like any other post. It always
    names the session, so it works without $CLAUDE_CODE_SESSION_ID; `<iid>` and `<session-id>` are
    literal placeholders when the value is not known."""
    return ("Re-run in this repo's checkout: python3 scripts/post-mr-cost.py --retry --mr %s --session %s "
            "(docs/development/cost-ledger.md)." % (iid if iid else "<iid>", sid if SESSION_RE.match(sid or "") else "<session-id>"))


def mr_ref(text):
    """(project path or None, iid or None) from ONE match in `text` (the hook's tool response): the first
    full `https://<host>/<namespace/project>/-/merge_requests/<n>` URL, else a bare `/-/merge_requests/<n>`
    (project None). The iid and the project always come from the same match, so a stray path printed
    before the real URL cannot pair one MR's number with another project."""
    text = text if isinstance(text, str) else json.dumps(text or "")
    m = MR_PROJECT_RE.search(text)
    if m:
        return m.group(1), int(m.group(2))
    m = MR_URL_RE.search(text)
    return (None, int(m.group(1))) if m else (None, None)


def mr_project(text):
    """The `namespace/project` path of the MR URL in `text`, or None (see mr_ref)."""
    return mr_ref(text)[0]


def parse_remote(url):
    """`namespace/project` from a git remote URL (https, scp-like ssh or ssh://), or None."""
    u = (url or "").strip()
    m = re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/]+/(.+?)/?$", u) or re.match(r"^[^@/\s]+@[^:/\s]+:(.+?)/?$", u)
    if not m:
        return None
    path = re.sub(r"\.git$", "", m.group(1))
    return path if re.match(r"^[0-9A-Za-z_.-]+(?:/[0-9A-Za-z_.-]+)+\Z", path) else None


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
    return mr_ref(response)[1]


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
    """[(body, author id)] of the `## Cost of this MR` notes (empty: none), None when unreadable.

    Unreadable is not 'exists': treating it as such made a flaky `glab api` skip the comment with
    no trace. The caller reports it and posts nothing, so a flaky API still never duplicates.
    """
    found = []
    for page in range(1, NOTE_PAGES + 1):
        notes = glab_json("%s/merge_requests/%d/notes?per_page=100&page=%d" % (api_base(project), iid, page), cwd)
        if not isinstance(notes, list):
            return None
        for n in notes:
            if isinstance(n, dict) and "## Cost of this MR" in str(n.get("body", "")):
                a = n.get("author")
                found.append((str(n.get("body", "")), a.get("id") if isinstance(a, dict) else None))
        if len(notes) < 100:
            return found
    return None  # more than NOTE_PAGES pages: "definitely absent" cannot be said


_CT = []


def _cost_table():
    """cost-table.py loaded as a module (its record parser), once."""
    if not _CT:
        import importlib.util
        spec = importlib.util.spec_from_file_location("cost_table_mod", os.path.join(HERE, "cost-table.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _CT.append(mod)
    return _CT[0]


def window_end(notes, me, now, start):
    """The end of THIS session's landed record: the latest window end among the token user's cost
    records whose window STARTS at `start` (this session's current orchestrator watermark, or its first
    entry when it has none), or None.

    Only notes by the token's own user whose body starts with the heading count (as cost-table's
    read_records does); an end later than `now` is ignored (a hand-edited record dated 2099 must not
    push the session past every later window); and a record with no `Window: S to U` line (the older
    go-ahead form) has no start, so it is never adopted. The start is what ties a record to this
    session: a record another session posted on the same MR starts at that session's own watermark."""
    if me is None or not start:
        return None
    ct = _cost_table()
    ends = []
    for body, aid in notes:
        if aid != me or not body.lstrip().startswith("## Cost of this MR"):
            continue
        rec = ct.parse_record(body)
        if (rec and rec.get("start") == start and isinstance(rec.get("end"), str) and TS_RE.match(rec["end"])
                and rec["end"] <= now):
            ends.append(rec["end"])
    return max(ends) if ends else None


def find_session_dir(sid, projects_dir):
    hits = sorted(h for h in glob.glob(os.path.join(glob.escape(projects_dir), "*", sid)) if os.path.isdir(h))
    ok = []
    for h in hits:  # a match that resolves (symlink, `..`) outside the projects dir is no session dir (#2152)
        try:
            ok.append(str(resolve_within(projects_dir, h)))
        except (PathEscapeError, OSError, RuntimeError):
            continue
    hits = ok
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
    """True: the brief names this MR (its branch, its branch's leaf, or its worktree leaf). False: it
    names another MR (another branch, or another worktree-path component `<issue>-<slug>`) and not
    this one. None: it names none, so usage alone decides.

    Naming this MR wins over naming another one: a brief that mentions both is this MR's. A leaf is
    `<issue>-<slug>` (scripts/wt); requiring the digits keeps a repo or checkout name such as
    `blueprint` from matching `org/blueprint` in a brief and claiming every agent."""
    own = {x for x in (leaf, (branch or "").rsplit("/", 1)[-1]) if LEAF_RE.match(x or "")}
    if names(brief, branch) or any(names(brief, x) for x in own):
        return True
    if any(m != branch for m in OTHER_BRANCH_RE.findall(brief)) or any(m not in own for m in OTHER_LEAF_RE.findall(brief)):
        return False
    return None


# --- per-session state ---------------------------------------------------------------------

class StateError(Exception):
    """The state file exists but is not a valid schema-1 state."""


def config_root():
    """`$CLAUDE_CONFIG_DIR` or `~/.claude`: where Claude Code keeps the transcripts, and so where one
    file per SESSION lives. The state is not per repo: a session spans repos, and a record in one repo
    must advance the window every other repo's record starts from."""
    return os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")


@contextlib.contextmanager
def state_lock(sid):
    """Hold an exclusive advisory lock on `mr-cost-state/<sid>.lock` for a read-modify-write of the
    session's state (and pins). Two posts in one session (two MRs opened at once, a --round while the
    hook runs) would otherwise both read the same watermark, claim the same window, and the later write
    would drop the other's agent watermarks. Blocks until the other holder is done."""
    if fcntl is None or not SESSION_RE.match(sid or ""):
        yield
        return
    d = os.path.join(config_root(), "mr-cost-state")
    os.makedirs(d, exist_ok=True)
    try:  # same root as state_path, so a symlinked state dir is refused here too (#2152)
        lock = resolve_within(config_root(), os.path.join(d, sid + ".lock"))
    except PathEscapeError:
        yield  # no lock beats a crashed hook; read_state/_write_doc then refuse the escaping path
        return
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing releases the lock


def pin_key(project, branch):
    """Pins are keyed `<project path>:<branch>` so one branch name in two repos cannot collide."""
    return "%s:%s" % (project or "?", branch)


def _confined(root, name):
    """root/mr-cost-state/<name>, refused (StateError) when it resolves outside root (#2152: a
    symlinked mr-cost-state dir or an odd sid must not redirect the state write)."""
    try:
        return str(resolve_within(root, os.path.join(root, "mr-cost-state", name)))
    except PathEscapeError as e:
        raise StateError("path escapes the config directory") from e


def _shown(root, sid, suffix):
    """The unconfined path, for MESSAGES only (never opened): safe to build while handling a StateError."""
    try:
        return _confined(root, sid + suffix)
    except StateError:
        return os.path.join(root, "mr-cost-state", sid + suffix)


def state_path(root, sid):
    return _confined(root, sid + ".json")


def read_state(root, sid):
    """{'orchestrator_until': str or None, 'agents': {id: str}}; empty when no state file exists.
    Raises StateError for one that exists but does not validate (never guessed around)."""
    import transcript_usage as tu
    try:
        with open(state_path(root, sid), encoding="utf-8") as f:
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
    out = {"orchestrator_until": ou, "agents": dict(ag)}
    pend = d.get("pending")
    if pend is not None:
        ok = (isinstance(pend, dict) and isinstance(pend.get("mr"), int) and not isinstance(pend.get("mr"), bool)
              and isinstance(pend.get("project"), str) and PROJECT_PATH_RE.match(pend["project"])
              and all(isinstance(pend.get(k), str) and TS_RE.match(pend[k]) for k in ("since", "until"))
              and isinstance(pend.get("agents"), dict)
              and all(isinstance(k, str) and tu.AGENT_ID_RE.match(k) and isinstance(v, str) and TS_RE.match(v)
                      for k, v in pend["agents"].items()))
        if not ok:
            raise StateError("malformed pending claim")
        out["pending"] = pend
    return out


def _write_doc(root, sid, doc):
    """Atomically replace the session's state file with `doc`; True on success."""
    try:
        d = os.path.dirname(state_path(root, sid))  # StateError when the state dir escapes the root: fail soft (#2152)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".state-", suffix=".tmp", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f, sort_keys=True)
                f.write("\n")
            os.replace(tmp, state_path(root, sid))
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
    except (OSError, StateError):
        return False
    return True


def write_state(root, sid, state, until, agent_ids):
    """Advance the session's state to `until` for the orchestrator and every agent in agent_ids,
    atomically, and drop any pending claim (this is the commit). Returns True on success. A watermark
    never moves backwards."""
    def later(old, new):
        return new if old is None or new > old else old
    agents = dict(state["agents"])
    for a in agent_ids:
        agents[a] = later(agents.get(a), until)
    return _write_doc(root, sid, {"schema": STATE_SCHEMA, "orchestrator_until": later(state["orchestrator_until"], until),
                                  "agents": agents})


def write_pending(root, sid, state, pending):
    """Write-ahead: record the claim a post is about to make, beside the unchanged watermarks. If the
    post lands but the commit (write_state) never happens, the next run finds this and resolves it
    against the MR's notes instead of claiming the same window again."""
    return _write_doc(root, sid, {"schema": STATE_SCHEMA, "orchestrator_until": state["orchestrator_until"],
                                  "agents": dict(state["agents"]), "pending": pending})


# --- agents pinned to a branch (--measure --pin) -------------------------------------------

def pins_path(root, sid):
    return _confined(root, sid + ".pins.json")


def read_pins(root, sid):
    """{pin key (`<project>:<branch>`): [agent id]} the orchestrator named for this session, {} when none. Raises StateError.

    Kept apart from the state file so the state schema stays {orchestrator_until, agents}."""
    import transcript_usage as tu
    try:
        with open(pins_path(root, sid), encoding="utf-8") as f:
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


def write_pins(root, sid, key, ids):
    """Record that these agents belong to the branch `key` (a pin_key), atomically; True on success. An
    agent pinned to a branch is left out of every other branch's record, so name it once and the hook
    (record 1) and --round (record K) both attribute it the way --measure did."""
    pins = read_pins(root, sid)
    for k in list(pins):
        pins[k] = [a for a in pins[k] if a not in ids]
    pins[key] = sorted(set(pins.get(key, [])) | set(ids))
    try:
        d = os.path.dirname(pins_path(root, sid))  # StateError when the state dir escapes the root: fail soft (#2152)
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".pins-", suffix=".tmp", dir=d)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"schema": STATE_SCHEMA, "branches": pins}, f, sort_keys=True)
                f.write("\n")
            os.replace(tmp, pins_path(root, sid))
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise
    except (OSError, StateError):
        return False
    return True


# --- measuring -----------------------------------------------------------------------------

class Opts:
    """Where the measuring scripts read from; overridden by the golden fixture so it is hermetic."""
    def __init__(self, projects_dir=None, prices=None, today=None):
        self.projects_dir = projects_dir or os.path.join(config_root(), "projects")
        self.prices = prices
        self.today = today


WT_LEAF_RE = re.compile(r"/[^/\s]*-wt/(\d+-[A-Za-z][\w-]*)(?=/|$)")
CD_RE = re.compile(r"(?:^|[;&|(\s])cd\s+[\"']?(/[^\s;&|\"')]+)")
GIT_C_RE = re.compile(r"\bgit\s+-C\s+[\"']?(/[^\s;&|\"')]+)[\"']?\s+([a-z-]+)")
READ_ONLY_GIT = ("show", "diff", "log")
WRITE_TOOLS = {"Edit": "file_path", "Write": "file_path", "NotebookEdit": "notebook_path"}
HOME_CAP = 64 << 20


def worktrees(runner, cwd):
    """[(real path, branch or None)] of every worktree of the hook's repo, from `git worktree list
    --porcelain`: the main checkout and each linked one (a /wave worker's `.claude/worktrees/agent-*`
    included). A detached worktree has no branch."""
    rc, out, _ = runner(["git", "worktree", "list", "--porcelain"], cwd)
    found, cur = [], None
    for line in (out if rc == 0 else "").splitlines():
        if line.startswith("worktree "):
            cur = [os.path.realpath(line[len("worktree "):].strip()), None]
            found.append(cur)
        elif line.startswith("branch ") and cur is not None:
            cur[1] = re.sub(r"^refs/heads/", "", line[len("branch "):].strip())
    return [(p_, b_) for p_, b_ in found]  # git lists the main checkout first


def path_home(path, wts):
    """('branch', name) for a path inside a listed worktree (the deepest one containing it, so a worker's
    `<main>/.claude/worktrees/agent-*` is never read as the main checkout), ('branch', '') for a detached
    one, ('leaf', '<n>-<slug>') for a path under a `*-wt/<n>-<slug>/` directory that is in no listed worktree
    (another repo's, or one already removed), else None. The text is only classified, never kept."""
    if not isinstance(path, str):
        return None
    real = os.path.realpath(path) if path.startswith("/") else path
    best = None
    for entry in wts:
        wpath = entry[0]
        if (real == wpath or real.startswith(wpath.rstrip("/") + "/")) and (best is None or len(wpath) > len(best[0])):
            best = entry
    if best and wts and best is wts[0] and real[len(best[0]):].lstrip("/").startswith(".claude/worktrees/"):
        return None  # a worker's worktree that git no longer lists: never the main checkout
    if best:
        return ("branch", best[1] or "")
    m = WT_LEAF_RE.search(path)
    return ("leaf", m.group(1)) if m else None


def agent_home(path, wts):
    """The worktree an agent ACTS in, read from its own transcript's tool calls, or None.

    A brief can name several worktrees (a port agent reads one and writes another; an auditor reads
    the one it audits), so attribution by brief text mis-attributes them. What an agent does is
    firmer: 1. the worktree holding the majority of its Edit/Write/NotebookEdit `file_path`s; else
    2. the worktree most often the target of a Bash `cd <path>` or `git -C <path> <not show/diff/log>`
    (a read-only auditor `cd`s into what it audits), when one leads strictly. Paths and commands are
    untrusted: they are classified into a (kind, name) pair and never echoed."""
    writes, cds, total_writes, seen = {}, {}, 0, set()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            read = 0
            for line in f:
                read += len(line)
                if read > HOME_CAP:
                    break
                if '"tool_use"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except (ValueError, RecursionError):
                    continue
                msg = e.get("message") if isinstance(e, dict) else None
                content = msg.get("content") if isinstance(msg, dict) else None
                for b in content if isinstance(content, list) else ():
                    if not (isinstance(b, dict) and b.get("type") == "tool_use") or b.get("id") in seen:
                        continue
                    seen.add(b.get("id"))
                    inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                    if b.get("name") in WRITE_TOOLS:
                        total_writes += 1
                        h = path_home(inp.get(WRITE_TOOLS[b["name"]]), wts)
                        if h:
                            writes[h] = writes.get(h, 0) + 1
                    elif b.get("name") == "Bash" and isinstance(inp.get("command"), str):
                        cmd = inp["command"]
                        targets = [m.group(1) for m in CD_RE.finditer(cmd)]
                        targets += [m.group(1) for m in GIT_C_RE.finditer(cmd) if m.group(2) not in READ_ONLY_GIT]
                        for t in targets:
                            h = path_home(t, wts)
                            if h:
                                cds[h] = cds.get(h, 0) + 1
    except OSError:
        return None
    if writes:
        top = max(writes, key=writes.get)
        if writes[top] * 2 > total_writes:
            return top
    if cds:
        ranked = sorted(cds.values(), reverse=True)
        if len(ranked) == 1 or ranked[0] > ranked[1]:
            return max(cds, key=cds.get)
    return None


def select_agents(sdir, branch, leaf, explicit, state_agents, until, pinned_elsewhere=frozenset(), wts=()):
    """(agent ids to measure, notes). A top-level agent counts for this MR by the worktree it acts in
    (agent_home: where it writes, else where it `cd`s) when that is known, and by its brief (attribution)
    otherwise; --agent and pins override both. `notes` are fixed strings: no brief or transcript text."""
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
            home = agent_home(path, wts)
            if home is not None:
                own = {x for x in (leaf, (branch or "").rsplit("/", 1)[-1]) if LEAF_RE.match(x or "")}
                # A home is a branch (a listed worktree) or, for a worktree git does not list, a leaf.
                if not ((home[0] == "branch" and home[1] and home[1] == branch) or (home[0] == "leaf" and home[1] in own)):
                    continue
            elif attribution(first_user_text(path), branch, leaf) is False:
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


def plan(runner, cwd, sid, gitdir, branch, explicit, opts, until, project=None):
    """(start, exclusive, sdir, agent ids, state, notes, error) for the next record of this session.

    `start` is where the orchestrator window begins: the session's stored watermark (exclusive, what the
    previous record already claimed), else the session transcript's first entry (inclusive). It is never
    clamped to another record on the same MR: records are non-overlapping in TOKENS, not in time, so a
    record another session posted must not hide this session's own spend between its watermark and that
    record's end. The caller holds state_lock(sid) from here through write_state."""
    import transcript_usage as tu
    try:
        state = read_state(config_root(), sid)
    except StateError as e:
        return (None,) * 6 + ("this session's cost state is %s (%s)" % (e, _shown(config_root(), sid, ".json")),)
    sdir = find_session_dir(sid, opts.projects_dir)
    try:
        main_path, _ = tu.session_paths(sid, opts.projects_dir)
    except ValueError:
        return (None,) * 6 + ("the session transcript was not found",)
    start, exclusive = state["orchestrator_until"], True
    if start is None:
        start, exclusive = first_timestamp(main_path) or "1970-01-01T00:00:00Z", False
    try:
        pins = read_pins(config_root(), sid)
    except StateError as e:
        return (None,) * 6 + ("this session's pinned agents are %s (%s)" % (e, _shown(config_root(), sid, ".pins.json")),)
    key = pin_key(project, branch)
    here = set(pins.get(key, [])) | set(explicit)
    elsewhere = {a for k, v in pins.items() if k != key for a in v} - here
    ids, notes = select_agents(sdir, branch, worktree_leaf(runner, cwd), here, state["agents"], until, elsewhere,
                               worktrees(runner, cwd))
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
    # Write ahead: the post may land and the commit below may not happen (a non-zero exit after the POST, a
    # kill, a timeout); the next run settles this claim against the MR's notes (resolve_pending).
    if not write_pending(config_root(), sid, state, {"mr": iid, "project": project, "since": since, "until": until,
                                                     "agents": {m: until for m in members}}):
        return "the pending claim could not be written, so nothing was posted", False
    tmp = tempfile.mkdtemp(prefix="mr-cost-", dir=gitdir)
    ledger, splitf = os.path.join(tmp, "lines.txt"), os.path.join(tmp, "split.txt")
    with open(splitf, "w", encoding="utf-8") as f:
        f.write("".join(split))
    cmd = [sys.executable, os.path.join(HERE, "cost-table.py"), "--comment"]
    if not exclusive:
        cmd += ["--session-start"]  # no earlier record of this session: the window began at its first entry
    if round_k:
        with open(ledger, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        cmd += ["--ledger", ledger, "--since", since]
    else:
        with open(ledger, "w", encoding="utf-8") as f:
            f.write("## Gates\n" + "\n".join(lines) + "\n")
        cmd += ["--file", ledger, "--since", since]
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
    if not write_state(config_root(), sid, state, until, members):
        return "posted, but the commit of the session cost state failed: the pending claim stays in the state file and the next run settles it against the MR's notes", True
    return "", True


def mr_branch(iid, cwd, runner, project):
    """The MR's source branch from the forge, else the checked-out branch."""
    d = glab_json("%s/merge_requests/%d" % (api_base(project), iid), cwd)
    if isinstance(d, dict) and isinstance(d.get("source_branch"), str):
        return d, d["source_branch"]
    rc, out, _ = runner(["git", "branch", "--show-current"], cwd)
    return d, out.strip() if rc == 0 else ""


def resolve_pending(cwd, sid):
    """(status, pending) after resolving the session's write-ahead claim; the caller holds state_lock(sid).

    A post is preceded by `pending` in the state file and followed by its commit. A post that landed
    while its commit did not (cost-table exited non-zero after its POST, the process was killed, a
    timeout) leaves `pending` behind, and the next run, on ANY MR, must settle it before claiming
    anything: otherwise it would claim the same window again. Read that MR's notes: a record by the token
    user whose `Window: S to U` matches exactly was posted, so the claim is committed (status 'adopted');
    none matches and the notes were read, so it was not posted and the claim is dropped ('discarded', the
    window is claimed again exactly once); the notes cannot be read, or the state is unreadable, and
    nothing can be said ('unreadable'): the caller refuses to post. None: nothing was pending."""
    root = config_root()
    try:
        state = read_state(root, sid)
    except StateError as e:
        return "badstate", "this session's cost state is %s (%s)" % (e, _shown(root, sid, ".json"))
    pend = state.get("pending")
    if not pend:
        return None, None
    user = glab_json("user", cwd)
    me = user.get("id") if isinstance(user, dict) else None
    notes = already_commented(pend["mr"], cwd, pend["project"])
    if me is None or notes is None:
        return "unreadable", pend
    ct = _cost_table()
    landed = False
    for body, aid in notes:
        if aid == me and body.lstrip().startswith("## Cost of this MR"):
            rec = ct.parse_record(body)
            if rec and rec.get("start") == pend["since"] and rec.get("end") == pend["until"]:
                landed = True
                break
    if landed:
        ok = write_state(root, sid, state, pend["until"], list(pend["agents"]))
    else:
        ok = _write_doc(root, sid, {"schema": STATE_SCHEMA, "orchestrator_until": state["orchestrator_until"],
                                    "agents": state["agents"]})
    return (("adopted" if landed else "discarded") if ok else "unreadable"), pend


def pending_refusal(status, info, sid):
    """The message when a pending claim cannot be settled; never a guess. `info` is the pending claim
    ('unreadable') or the specific state error with its file path ('badstate')."""
    if status == "badstate":
        # A retry would refuse for the same reason: name the file and say what to do with it.
        return ("%s, so nothing was posted. Inspect that file; if it is damaged, remove it (the session's next record "
                "then starts from its first entry) and re-run." % info)
    return ("an earlier post for !%d (window %s to %s) cannot be confirmed (its notes could not be read, or the state could not be written), and posting "
            "now could count the same tokens twice, so nothing was posted. Re-run: python3 scripts/post-mr-cost.py "
            "--retry --mr %d --session %s" % (info["mr"], info["since"], info["until"], info["mr"],
                                              sid if SESSION_RE.match(sid or "") else "<session-id>"))


def reconcile(runner, cwd, sid, branch, seen, opts, project=None):
    """Advance the session state to the end of a record THIS session posted whose state write never
    happened.

    A hook killed after its POST landed (or a cost-table that failed on the response) leaves the record
    on the MR and the state behind it, so the session's next record would claim the same tokens again.
    A record is adopted only if it is the token user's, its window START equals this session's current
    orchestrator watermark (or its first entry, when it has none), and its end is not in the future: a
    record another session posted, or a hand-edited one, starts somewhere else and moves nothing. The
    agents advanced are the ones that record's window would have attributed. The hook calls this when
    the MR already has a cost comment; --retry calls it too, since it is what the hook's fail-soft
    message prints. Returns the end the state moved to, else None. A watermark never moves backwards (the
    start rule makes a record's end later than the watermark it starts at; write_state keeps the later).
    Only the expected failures (an unreadable state, a missing transcript) read as "nothing to
    reconcile"; any other exception propagates to the caller, which reports it.

    Records this code posts are settled by the write-ahead `pending` claim (resolve_pending), which also
    covers a landed post on a DIFFERENT MR; reconcile stays for a record with no pending entry: one posted
    by an older version, or after the state file was lost, where only the window-start rule can tie a
    record to this session."""
    opts = opts or Opts()
    with state_lock(sid):
        return _reconcile_safe(runner, cwd, sid, branch, seen, opts, project)


def _reconcile_safe(runner, cwd, sid, branch, seen, opts, project):
    """reconcile() with the session lock held: the expected failures read as nothing to adopt."""
    import transcript_usage as tu
    try:
        return _reconcile_locked(runner, cwd, sid, branch, seen, opts, project, tu)
    except (StateError, OSError, ValueError):
        return None


def _reconcile_locked(runner, cwd, sid, branch, seen, opts, project, tu):
    """reconcile() with the session lock held."""
    user = glab_json("user", cwd)
    me = user.get("id") if isinstance(user, dict) else None
    if me is None or not SESSION_RE.match(sid or ""):
        return None
    state = read_state(config_root(), sid)
    expected = state["orchestrator_until"]
    if expected is None:
        expected = first_timestamp(tu.session_paths(sid, opts.projects_dir)[0])
    end = window_end(seen, me, now_utc(), expected)
    if not end:
        return None
    _, _, sdir, ids, state, _, err = plan(runner, cwd, sid, None, branch, [], opts, end, project=project)
    if err:
        return None
    try:
        members = [a for a, _ in tu.subagent_files(sdir, ids)[0]] if ids else []
    except ValueError:
        members = list(ids)  # the post path falls back the same way; descendants then keep no watermark
    return end if write_state(config_root(), sid, state, end, members) else None


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
    gitdir = git_common_dir(runner, cwd)
    if not gitdir:
        return "MR cost comment skipped for !%d: not in a git checkout. %s" % (iid, manual)
    with state_lock(sid):  # settle, read the watermark, post, write it back: one post per session at a time
        status, pend = resolve_pending(cwd, sid)
        if status in ("unreadable", "badstate"):
            return "MR cost comment skipped for !%d: %s" % (iid, pending_refusal(status, pend, sid))
        seen = already_commented(iid, cwd, project)  # read inside the lock: another post may be landing this record
        if seen is None:
            return "MR cost comment not posted for !%d: could not read its notes (glab api failed). %s" % (iid, manual)
        if seen:
            _reconcile_safe(runner, cwd, sid, branch, seen, opts, project)
            return quiet("a cost comment already exists")
        until = now_utc()
        since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, [], opts, until, project=project)
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
    claimed), whatever other sessions posted on the MR; the MR must already carry a readable record
    (cost-table.py --next-since). The record, its running total and the "never edit an earlier record"
    rule are cost-table.py's. Returns a message (never raises)."""
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
    if rc != 0 or not TS_RE.match(out.strip()):  # the guard: a round needs a readable record on this MR to follow
        return "Record skipped for !%d: it has no readable record 1 to continue from. %s" % (iid, manual)
    gitdir = git_common_dir(runner, cwd)
    if not gitdir:
        return "Record skipped for !%d: not in a git checkout. %s" % (iid, manual)
    with state_lock(sid):
        status, pend = resolve_pending(cwd, sid)
        if status in ("unreadable", "badstate"):
            return "Record skipped for !%d: %s" % (iid, pending_refusal(status, pend, sid))
        until = now_utc()
        since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, explicit, opts, until, project)
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
    if SESSION_RE.match(sid or ""):
        with state_lock(sid):
            status, pend = resolve_pending(cwd, sid)
        if status in ("unreadable", "badstate"):
            return "Retry skipped for !%d: %s" % (iid, pending_refusal(status, pend, sid))
        if status == "adopted" and pend["mr"] == iid:
            return ("Retry posted nothing for !%d: its cost record (window end %s) had already landed; this "
                    "session's state now starts after it. Run --round for later work." % (iid, pend["until"]))
    seen = already_commented(iid, cwd, project)
    if seen is None:
        return "Retry skipped for !%d: could not read its notes (glab api failed)." % iid
    opts = opts or Opts()
    if seen:
        d, branch = mr_branch(iid, cwd, runner, project)
        moved = reconcile(runner, cwd, sid, branch, seen, opts, project)
        if moved:
            # A record landed without this session's state moving: the state now starts after it, so a
            # round here would only count the same tokens again.
            return ("Retry posted nothing for !%d: its cost record (window end %s) had already landed; this "
                    "session's state now starts after it. Run --round for later work." % (iid, moved))
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
    record would cover. Never posts and never moves a watermark, so /wave can ask at the go-ahead and the
    hook still claims the same tokens at `glab mr create`. Its only state writes are the pins (--pin) and
    settling a pending claim from an earlier post (committing it if the record landed, dropping it if
    not). A pin is written even when the pending claim cannot be settled. Exit 2 is a refusal or failure
    of --pin."""
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
    project = repo_project(runner, cwd)
    if pin:
        if not explicit or not branch:
            return [], "--pin needs --agent <id> and a branch (run it in the branch's worktree).\n", 2
        if branch in default_branches(runner, cwd):
            return [], ("refusing to pin to the default branch %s: no MR has that source branch, so the pinned agents "
                        "would be left out of every real branch's record and their tokens never claimed. Run --pin in "
                        "the branch's own worktree (or pass --branch <name>).\n" % branch), 2
        if project is None:
            return [], "--pin needs this checkout's `origin` remote to name its project (pins are keyed project:branch).\n", 2
    elif explicit:
        warn = ("post-mr-cost: --agent without --pin applies to this run only; record 1 (the hook) will not "
                "attribute %s unless they are pinned (add --pin).\n" % ", ".join(sorted(set(explicit))))
    with state_lock(sid):  # the pins file is a read-modify-write, and a pending claim is settled before measuring
        # A pin never moves a watermark, so it is written whether or not the pending claim can be settled
        # (the settle failure is reported below); only a genuine failure to write it is an error (exit 2).
        if pin:
            try:
                ok = write_pins(config_root(), sid, pin_key(project, branch), set(explicit))
            except StateError as e:
                return [], "this session's pinned agents are %s (%s).\n" % (e, _shown(config_root(), sid, ".pins.json")), 2
            if not ok:
                return [], "the pinned agents could not be written.\n", 2
            warn += "post-mr-cost: pinned %s to %s.\n" % (", ".join(sorted(set(explicit))), branch)
        status, pend = resolve_pending(cwd, sid)
        if status in ("unreadable", "badstate"):
            return [], warn + "post-mr-cost: %s\n" % pending_refusal(status, pend, sid), 0
        if status:
            warn += ("post-mr-cost: a pending claim for !%d (window %s to %s) was %s before measuring; --measure "
                     "never posts.\n" % (pend["mr"], pend["since"], pend["until"],
                                          "found posted and committed" if status == "adopted" else "found unposted and dropped"))
        until = now_utc()
        since, excl, sdir, ids, state, notes, err = plan(runner, cwd, sid, gitdir, branch, explicit, opts, until, project=project)
        if err:
            return [], warn + err + ".\n", 0
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
        os.chmod(shim, 0o700)  # owner-only exec is enough for a test shim
        gstate = os.path.join(tmp, "glab-state.json")
        with open(gstate, "w", encoding="utf-8") as f:
            json.dump({"mrs": sc["mrs"], "notes": {}, "next_id": 1}, f)
        repo = os.path.join(tmp, "wt-fixture")
        subprocess.run(["git", "init", "-q", repo], check=True)
        subprocess.run(["git", "-C", repo, "remote", "add", "origin", "https://example.test/g/p.git"], check=True)
        empty = os.path.join(tmp, "gitconfig")
        open(empty, "w").close()
        os.environ.update({"PATH": bindir + os.pathsep + saved_path, "FAKE_GLAB_STATE": gstate, "FAKE_GLAB_PROJECT": urllib.parse.quote("g/p", safe=""),
                           "CLAUDE_CONFIG_DIR": os.path.join(tmp, "claude-config"),
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
        cfg = config_root()
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
                      json.loads(open(state_path(cfg, sid), encoding="utf-8").read()) == want["state"])
                check("golden %s: the pin is recorded for that branch" % step["name"],
                      read_pins(cfg, sid) == {pin_key("g/p", step["branch"]): step["agents"]}, repr(read_pins(cfg, sid)))
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
                      json.loads(open(state_path(cfg, sid), encoding="utf-8").read()) == want["state"])
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
            for text in want.get("absent", []):
                check("golden %s: does not contain %s" % (step["name"], text[:40]), text not in body, body)
            for text in ex["forbidden_anywhere"]:
                check("golden %s: never %s" % (step["name"], text), text not in body, body)
            table = [l for l in body.split("\n") if l.startswith("|")]
            for text in ex["forbidden_in_table"]:
                check("golden %s: no %s in a table row" % (step["name"], text), not any(text in l for l in table), "\n".join(table))
            check("golden %s: state after" % step["name"], json.loads(open(state_path(cfg, sid), encoding="utf-8").read()) == want["state"],
                  open(state_path(cfg, sid), encoding="utf-8").read())
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
        st = read_state(cfg, sid)
        check("golden: the state is global, not in the repo: nothing under the git dir",
              not os.path.exists(os.path.join(gitdir, "mr-cost-state")) and os.path.exists(state_path(cfg, sid)))
        check("golden: a legacy mr-cost-last-until marker is not read", st["orchestrator_until"] == sc["steps"][-1]["at"], repr(st))
        # A POST that landed without the state moving (the hook was killed, cost-table failed on the
        # response): a later run adopts the record, but only a record THIS session posted, i.e. one whose
        # window starts at the session's current watermark.
        seen11 = already_commented(11, repo, "g/p")
        spath = state_path(cfg, sid)
        def plain(doc):
            return {"orchestrator_until": doc["orchestrator_until"], "agents": doc["agents"]}
        before_rec2 = plain(ex["steps"]["b-record-1"]["state"])   # the state just before a-record-2 was posted
        after_rec2 = plain(ex["steps"]["a-record-2"]["state"])    # ... and the one that post leaves
        want_end = after_rec2["orchestrator_until"]
        globals()["now_utc"] = lambda: "2026-11-07T13:30:00Z"

        def roll_back(doc):
            with open(spath, "w", encoding="utf-8") as f:
                json.dump(dict(doc, schema=1), f)

        def notes_n():
            return len(json.load(open(gstate, encoding="utf-8"))["notes"]["11"])

        def note_bodies_11():
            return [n["body"] for n in json.load(open(gstate, encoding="utf-8"))["notes"]["11"]]
        n_before = notes_n()
        roll_back(before_rec2)
        reconcile(run, repo, sid, "feat/101-a", [(b, 8) for b, _ in seen11], opts, "g/p")
        check("golden: reconcile ignores a record by another user", read_state(cfg, sid) == before_rec2)
        check("golden: reconcile ignores a record dated in the future (and one that starts elsewhere)",
              window_end(seen11, 7, "2026-11-07T11:30:00Z", "2026-11-07T11:00:00Z") is None
              and window_end(seen11, 7, "2026-11-07T13:30:00Z", "2026-11-07T11:00:00Z") == want_end
              and window_end(seen11, 7, "2026-11-07T13:30:00Z", "2026-11-07T10:30:00Z") is None)
        old_form = [(re.sub(r"- Window: \S+ to (\S+)\. .*", r"- Window end: \1. Both figures stop at the go-ahead to push.", b), a) for b, a in seen11]
        reconcile(run, repo, sid, "feat/101-a", old_form, opts, "g/p")
        check("golden: a record with no `Window: S to U` line (the older form) is never adopted", read_state(cfg, sid) == before_rec2)
        roll_back(dict(before_rec2, orchestrator_until="2026-11-07T10:30:00Z"))
        elsewhere = read_state(cfg, sid)
        hook_other = process(hook_payload(11), opts, crun)
        check("golden: a record another session posted (its window starts at a different watermark) moves nothing: "
              "the hook posts nothing and leaves the state alone",
              hook_other is None and notes_n() == n_before and read_state(cfg, sid) == elsewhere, repr(read_state(cfg, sid)))
        roll_back(before_rec2)
        moved = reconcile(run, repo, sid, "feat/101-a", seen11, opts, "g/p")
        check("golden: reconcile adopts this session's landed record: the orchestrator and the record's agents move to its end",
              moved == want_end and read_state(cfg, sid) == after_rec2, repr(read_state(cfg, sid)))
        reconcile(run, repo, sid, "feat/101-a", seen11[:1], opts, "g/p")
        check("golden: reconcile never moves the state backwards", read_state(cfg, sid) == after_rec2)
        # The hook: the MR already has the record, the state was rolled back to before it. Nothing is posted and the
        # state moves to what the post would have left.
        roll_back(before_rec2)
        hook_msg = process(hook_payload(11), opts, crun)
        check("golden: the hook on an MR whose record landed posts nothing and moves the state to its end",
              hook_msg is None and notes_n() == n_before and read_state(cfg, sid) == after_rec2, repr((hook_msg, read_state(cfg, sid))))
        # --retry after a landed POST runs the same reconcile: no further record (a round would re-count the agents
        # the landed record measured), and the state moves.
        roll_back(before_rec2)
        retried = process_retry(11, sid, repo, opts, crun)
        check("golden: --retry after a landed POST posts nothing, says the record had landed, and moves the state",
              notes_n() == n_before and "had already landed" in retried and read_state(cfg, sid) == after_rec2, repr((retried, read_state(cfg, sid))))
        # --retry from the CLI passes no opts: it must still reconcile (a missing default read as "nothing to adopt" and fell through to a round).
        seen_opts = []
        real_reconcile = globals()["reconcile"]
        globals()["reconcile"] = lambda runner_, cwd_, sid_, branch_, seen_, opts_, project_=None: seen_opts.append(opts_) or None
        try:
            process_retry(11, sid, repo, None, crun)
        finally:
            globals()["reconcile"] = real_reconcile
        check("golden: process_retry defaults its opts (the CLI passes none)", len(seen_opts) == 1 and isinstance(seen_opts[0], Opts), repr(seen_opts))
        roll_back(before_rec2)
        retried_cli = process_retry(11, sid, repo, None, crun)
        check("golden: --retry without opts still reconciles against the default projects dir or says nothing is measurable, never raises",
              isinstance(retried_cli, str))
        # An unexpected failure inside reconcile is reported, not swallowed as "nothing to reconcile".
        real_gj = globals()["glab_json"]

        def boom(path, cwd):
            raise RuntimeError("unexpected")
        globals()["glab_json"] = boom
        try:
            reconcile(run, repo, sid, "feat/101-a", seen11, opts, "g/p")
            raised = False
        except RuntimeError:
            raised = True
        finally:
            globals()["glab_json"] = real_gj
        check("golden: an unexpected exception in reconcile propagates (only expected failures read as nothing to adopt)", raised)
        # Another session's record must not hide THIS session's spend. Model a real foreign record: this MR's
        # record 2 covers 11:00 to 12:00, but THIS session's watermark is 11:30 (a different session posted it), so
        # the next record still starts at 11:30 (no clamp to the MR's latest record end), and the running total
        # sums the records whatever their windows (non-overlapping in tokens, not in time).
        roll_back(dict(before_rec2, orchestrator_until="2026-11-07T11:30:00Z"))
        globals()["now_utc"] = lambda: "2026-11-07T13:05:00Z"
        low = process_round(11, sid, repo, opts, crun)
        last11 = note_bodies_11()[-1]
        rec3 = ct.parse_record(last11) or {}
        check("golden: a round's window starts at the session's own watermark, not at the MR's latest record end; the total sums",
              low.startswith("Posted") and rec3.get("k") == 3 and rec3.get("start") == "2026-11-07T11:30:00Z"
              and "Running total: the last row, records 1-3" in last11 and "n/a" not in "\n".join(l for l in last11.split("\n") if l.startswith("|")),
              low + last11[:300])
        roll_back(after_rec2)

        # --- the write-ahead pending claim: a post that lands while its state commit does not ---------------
        pend_ex = ex["pending_phase"]
        roll_back(plain(ex["steps"]["c-retry"]["state"]))     # the state the sequential steps left: 13:00
        phase_tokens = []

        def at(hhmmss):
            globals()["now_utc"] = lambda: "2026-11-07T%sZ" % hhmmss

        def notes_of(mr):
            return [n["body"] for n in json.load(open(gstate, encoding="utf-8"))["notes"].get(str(mr), [])]

        def total_of(body):
            return (ct.parse_record(body) or {}).get("total", {}).get(("tok", "all"))

        def uncommitted(t, mr):
            """The post lands, the state commit fails (write_state returns False): `pending` is left behind."""
            at(t)
            real_ws = globals()["write_state"]
            globals()["write_state"] = lambda *a, **k: False
            try:
                return process_round(mr, sid, repo, opts, crun)
            finally:
                globals()["write_state"] = real_ws

        def unposted(t, mr, fn):
            """cost-table fails before anything is posted."""
            at(t)

            def failing_ct(cmd, cwd, env=None, timeout=300):
                if any(os.path.basename(c) == "cost-table.py" for c in cmd[:2]) and "--post" in cmd:
                    return 1, "", "glab api POST timed out\n"
                return crun(cmd, cwd, env, timeout)
            return fn(failing_ct)

        def st_now():
            return json.loads(open(spath, encoding="utf-8").read())

        def claim(mr, before):
            got = notes_of(mr)
            if len(got) == before + 1:
                phase_tokens.append(total_of(got[-1]))
                return total_of(got[-1])
            return None
        n0 = len(notes_of(11))
        m = uncommitted("13:15:00", 11)
        check("golden pending (a): the post lands and the commit fails: the record is on the MR, `pending` is in the state, the watermark has not moved",
              m.startswith("Posted") and claim(11, n0) == pend_ex["records"][0] and st_now().get("pending", {}).get("mr") == 11
              and st_now()["orchestrator_until"] == "2026-11-07T13:00:00Z", repr((m, st_now())))
        n0 = len(notes_of(11))
        at("13:35:00")
        m = process_round(11, sid, repo, opts, crun)
        check("golden pending (a): the next --round on the same MR adopts the landed record and claims only what is after it (no double count)",
              m.startswith("Posted") and claim(11, n0) == pend_ex["records"][1] and "pending" not in st_now()
              and st_now()["orchestrator_until"] == "2026-11-07T13:35:00Z", repr((m, st_now())))
        check("golden pending (a): adopting the landed record moved the AGENT watermarks too (the subagent usage it measured is not claimed again)",
              st_now()["agents"].get("a1000000000000001") == "2026-11-07T13:15:00Z", repr(st_now()["agents"]))
        n0 = len(notes_of(11))
        m = uncommitted("13:45:00", 11)
        check("golden pending (b): the same failure again", m.startswith("Posted") and claim(11, n0) == pend_ex["records"][2] and "pending" in st_now(), repr((m, st_now())))
        at("13:50:00")
        m = process(hook_payload(15), opts, crun) or ""
        check("golden pending (b): the hook on a DIFFERENT MR settles it first, then finds nothing new to claim: no record, no double count",
              m.startswith("MR cost comment skipped for !15") and notes_of(15) == [] and "pending" not in st_now()
              and st_now()["orchestrator_until"] == "2026-11-07T13:45:00Z", repr((m, st_now())))
        n0 = len(notes_of(11))
        m = unposted("13:57:00", 11, lambda r: process_round(11, sid, repo, opts, r))
        check("golden pending (c): cost-table fails before the POST: no record, `pending` stays", m.startswith("Record skipped")
              and len(notes_of(11)) == n0 and "pending" in st_now(), repr((m, st_now())))
        at("14:00:00")
        m = process_round(11, sid, repo, opts, crun)
        check("golden pending (c): the record is definitely absent: the claim is discarded and the window is claimed again exactly once",
              m.startswith("Posted") and claim(11, n0) == pend_ex["records"][3] and "pending" not in st_now()
              and st_now()["orchestrator_until"] == "2026-11-07T14:00:00Z", repr((m, st_now())))
        n0 = len(notes_of(11))
        unposted("14:10:00", 11, lambda r: process_round(11, sid, repo, opts, r))
        real_ac = globals()["already_commented"]
        globals()["already_commented"] = lambda iid, cwd, project: None
        try:
            at("14:12:00")
            m = process_round(11, sid, repo, opts, crun)
        finally:
            globals()["already_commented"] = real_ac
        check("golden pending (d): the notes cannot be read: nothing is posted, nothing is guessed, the retry command is printed",
              "cannot be confirmed" in m and "--retry --mr 11 --session" in m and len(notes_of(11)) == n0 and "pending" in st_now(), repr((m, st_now())))
        at("14:15:00")
        m = process_round(11, sid, repo, opts, crun)
        check("golden pending (d): once the notes read, it is settled and the window is claimed exactly once",
              m.startswith("Posted") and claim(11, n0) == pend_ex["records"][4] and "pending" not in st_now()
              and st_now()["orchestrator_until"] == "2026-11-07T14:15:00Z", repr((m, st_now())))
        FIRST_RECORD_TEXT = ct.FIRST_RECORD
        want_phase, seen_phase = 0, set()
        for path in sorted(glob.glob(os.path.join(projects, "**", "*.jsonl"), recursive=True)):
            for line in open(path, encoding="utf-8"):
                e = json.loads(line)
                u = (e.get("message") or {}).get("usage") if e.get("type") == "assistant" else None
                if u and e["message"]["id"] not in seen_phase and "2026-11-07T13:00:00Z" < e["timestamp"] <= "2026-11-07T14:15:00Z":
                    seen_phase.add(e["message"]["id"])
                    want_phase += sum(u.get(k, 0) for k in tu.FIELDS)
        check("golden pending: the phase's records add up to the usage in that window (none claimed twice, none dropped)",
              phase_tokens == pend_ex["records"] and sum(phase_tokens) == want_phase == pend_ex["tokens"], repr((phase_tokens, want_phase)))

        # --- the guards of resolve_pending, each with a real record the fake glab holds -------------------------------------
        body_last = notes_of(11)[-1]
        rec_last = ct.parse_record(body_last)
        w_since, w_until = rec_last["start"], rec_last["end"]
        base_state = {"orchestrator_until": w_since, "agents": dict(st_now()["agents"])}

        def seed(pend_since=None, pend_until=None, mr=11, agents=None):
            doc = dict(base_state, schema=1, pending={"mr": mr, "project": "g/p", "since": pend_since or w_since,
                                                      "until": pend_until or w_until, "agents": agents or {}})
            with open(spath, "w", encoding="utf-8") as f:
                json.dump(doc, f)

        def settle_with(author, **kw):
            seed(**kw)
            real_ac2 = globals()["already_commented"]
            globals()["already_commented"] = lambda iid, cwd, project: [(body_last, author)]
            try:
                return resolve_pending(repo, sid)[0]
            finally:
                globals()["already_commented"] = real_ac2
        check("golden pending guard: the token user's record with BOTH the same start and end is adopted and moves the watermark",
              settle_with(7) == "adopted" and st_now()["orchestrator_until"] == w_until and "pending" not in st_now(), repr(st_now()))
        check("golden pending guard: another user's record with a matching window is not adopted (the claim is dropped, the watermark stays)",
              settle_with(8) == "discarded" and st_now()["orchestrator_until"] == w_since, repr(st_now()))
        check("golden pending guard: a record that matches only the START is not adopted",
              settle_with(7, pend_until="2026-11-07T14:16:00Z") == "discarded" and st_now()["orchestrator_until"] == w_since, repr(st_now()))
        check("golden pending guard: a record that matches only the END is not adopted",
              settle_with(7, pend_since="2026-11-07T13:59:00Z") == "discarded" and st_now()["orchestrator_until"] == w_since, repr(st_now()))
        # --retry: its own settle step and its early "already landed" return
        seed()
        n0 = len(notes_of(11))
        at("14:20:00")
        r1 = process_retry(11, sid, repo, opts, crun)
        check("golden pending retry: --retry on the pending MR settles it, says the record had already landed, and posts nothing",
              "had already landed" in r1 and len(notes_of(11)) == n0 and "pending" not in st_now()
              and st_now()["orchestrator_until"] == w_until, repr((r1, st_now())))
        seed()
        r2 = process_retry(12, sid, repo, opts, crun)
        check("golden pending retry: --retry for ANOTHER MR still settles the pending claim first, then carries on for its own MR",
              "pending" not in st_now() and st_now()["orchestrator_until"] == w_until and "had already landed" not in r2, repr((r2, st_now())))
        seed()
        globals()["already_commented"] = lambda iid, cwd, project: None
        try:
            r3 = process_retry(11, sid, repo, opts, crun)
        finally:
            globals()["already_commented"] = real_ac
        check("golden pending retry: unreadable notes refuse the retry too and keep the claim",
              "cannot be confirmed" in r3 and "--retry --mr 11 --session" in r3 and "pending" in st_now(), repr(r3))
        # --measure: settles, and --pin is written even when the claim cannot be settled
        seed()
        _l, merr, mrc = process_measure(sid, repo, "feat/101-a", opts, crun)
        check("golden pending measure: --measure settles a pending claim (commits it) and says so, without posting",
              "found posted and committed" in merr and "pending" not in st_now() and len(notes_of(11)) == n0 and mrc == 0, repr((merr, st_now())))
        seed()
        globals()["already_commented"] = lambda iid, cwd, project: None
        try:
            _l, perr, prc = process_measure(sid, repo, "feat/101-a", opts, crun, ["c1000000000000001"], pin=True)
        finally:
            globals()["already_commented"] = real_ac
        check("golden pending pin: a pin is written (exit 0) even when the pending claim cannot be settled, and the failure is reported",
              prc == 0 and "pinned c1000000000000001" in perr and "cannot be confirmed" in perr
              and "c1000000000000001" in read_pins(cfg, sid).get(pin_key("g/p", "feat/101-a"), []), repr((prc, perr)))
        real_wp = globals()["write_pins"]
        globals()["write_pins"] = lambda *a, **k: False
        try:
            _l, _e, frc = process_measure(sid, repo, "feat/101-a", opts, crun, ["c1000000000000001"], pin=True)
        finally:
            globals()["write_pins"] = real_wp
        check("golden pending pin: a genuine failure to write the pin exits 2", frc == 2, repr(frc))
        # a malformed state names its file and the reason on every entry path, and does not suggest a retry that would refuse too
        bad = dict(base_state, schema=1, pending={"mr": 11, "project": "not a project", "since": w_since, "until": w_until, "agents": {}})
        with open(spath, "w", encoding="utf-8") as f:
            json.dump(bad, f)
        hmsg = process(hook_payload(11), opts, crun) or ""
        rmsg = process_round(11, sid, repo, opts, crun)
        tmsg = process_retry(11, sid, repo, opts, crun)
        _l, bmerr, _rc = process_measure(sid, repo, "feat/101-a", opts, crun)
        check("golden state: a malformed pending claim is reported with the state file and the reason on every path (hook, round, retry, measure), "
              "and no retry is suggested",
              all(spath in m and "malformed pending claim" in m and "--retry" not in m for m in (hmsg, rmsg, tmsg, bmerr)),
              repr((hmsg, rmsg, tmsg, bmerr)))
        # a post whose commit never happens, in the session-start form (record 1, no earlier state): adopted, agents included
        os.remove(spath)
        at("14:30:00")
        real_ws = globals()["write_state"]
        globals()["write_state"] = lambda *a, **k: False
        try:
            first = process(hook_payload(15), opts, crun) or ""
        finally:
            globals()["write_state"] = real_ws
        first_body = notes_of(15)[-1] if notes_of(15) else ""
        pend15 = st_now().get("pending", {})
        check("golden pending session-start: record 1 in the session-start form lands, its commit fails, `pending` starts at the session's first entry",
              first.startswith("Posted") and FIRST_RECORD_TEXT in first_body and pend15.get("since") == "2026-11-07T08:55:00Z"
              and "orchestrator_until" in st_now() and st_now()["orchestrator_until"] is None, repr((first, pend15)))
        status15, _p = resolve_pending(repo, sid)
        check("golden pending session-start: it is adopted: the orchestrator AND the agents the record measured move to its end",
              status15 == "adopted" and st_now()["orchestrator_until"] == "2026-11-07T14:30:00Z"
              and st_now()["agents"].get("a9000000000000001") == "2026-11-07T14:30:00Z" and "pending" not in st_now(), repr(st_now()))
        # note pagination: the record is on page 2, and "definitely absent" needs every page
        gs = json.load(open(gstate, encoding="utf-8"))
        gs["notes"]["16"] = [{"id": 900 + i, "body": "filler", "system": False, "author": {"id": 7}} for i in range(130)] + \
            [{"id": 1100, "body": body_last, "system": False, "author": {"id": 7}}]
        gs["notes"]["17"] = [{"id": 1200 + i, "body": "filler", "system": False, "author": {"id": 7}} for i in range(100)]
        json.dump(gs, open(gstate, "w", encoding="utf-8"))
        found16 = already_commented(16, repo, "g/p")
        found17 = already_commented(17, repo, "g/p")
        check("golden notes: a cost record on page 2 of an MR with 131 notes is found; exactly 100 notes (no record) read as none",
              found16 is not None and len(found16) == 1 and found17 == [], repr((found16 and len(found16), found17)))

    finally:
        globals()["now_utc"] = saved_now
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(tmp, ignore_errors=True)


def golden_two_repos(check):
    """One session across TWO repos (different `origin` projects), agent briefs that name only worktree
    paths: scripts/tests/cost-ledger-golden/two-repos/. The state is one file per session, so a record in
    repo Y starts where repo X's ended and leaves X's agents to X; the three records add up to the
    transcripts' usage."""
    import shutil
    import importlib.util
    root = os.path.join(GOLDEN, "two-repos")
    with open(os.path.join(root, "scenario.json"), encoding="utf-8") as f:
        sc = json.load(f)
    with open(os.path.join(root, "expected.json"), encoding="utf-8") as f:
        ex = json.load(f)
    tmp = tempfile.mkdtemp(prefix="cost-golden2-")
    saved_env, saved_now = dict(os.environ), globals()["now_utc"]
    try:
        bindir = os.path.join(tmp, "bin")
        os.makedirs(bindir)
        shim = os.path.join(bindir, "glab")
        with open(shim, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, os.path.join(GOLDEN, "fake-glab.py")))
        os.chmod(shim, 0o700)  # owner-only exec is enough for a test shim
        empty = os.path.join(tmp, "gitconfig")
        open(empty, "w").close()
        os.environ.update({"PATH": bindir + os.pathsep + saved_env.get("PATH", ""), "GIT_CONFIG_GLOBAL": empty,
                           "GIT_CONFIG_NOSYSTEM": "1", "CLAUDE_CONFIG_DIR": os.path.join(tmp, "claude-config")})
        cfg = config_root()
        projects = os.path.join(tmp, "projects")
        shutil.copytree(os.path.join(root, "projects"), projects)
        opts = Opts(projects, os.path.join(GOLDEN, "prices.json"), sc["today"])
        spec = importlib.util.spec_from_file_location("cost_table_golden2", os.path.join(HERE, "cost-table.py"))
        ct = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ct)
        repos, forge = {}, {}
        for name, r in sc["repos"].items():
            path = os.path.join(tmp, "wt-" + name)
            subprocess.run(["git", "init", "-q", path], check=True)
            subprocess.run(["git", "-C", path, "remote", "add", "origin", "https://example.test/%s.git" % r["project"]], check=True)
            gstate = os.path.join(tmp, "glab-%s.json" % name)
            with open(gstate, "w", encoding="utf-8") as f:
                json.dump({"mrs": r["mrs"], "notes": {}, "next_id": 1}, f)
            repos[name], forge[name] = path, (gstate, urllib.parse.quote(r["project"], safe=""), r["project"])
        sid = sc["session"]
        bodies = []
        # A stale per-repo state (the old location) must be ignored: it would push every window to 2999.
        old = os.path.join(git_common_dir(run, repos["y"]), "mr-cost-state")
        os.makedirs(old)
        open(os.path.join(old, sid + ".json"), "w").write('{"schema": 1, "orchestrator_until": "2999-01-01T00:00:00Z", "agents": {}}')
        for step in sc["steps"]:
            globals()["now_utc"] = lambda t=step["at"]: t
            gstate, enc, project = forge[step["repo"]]
            os.environ.update({"FAKE_GLAB_STATE": gstate, "FAKE_GLAB_PROJECT": enc})
            repo, want = repos[step["repo"]], ex["steps"][step["name"]]
            if step["kind"] == "hook":
                msg = process({"tool_name": "Bash", "tool_input": {"command": "glab mr create --yes"},
                               "tool_response": {"stdout": "https://example.test/%s/-/merge_requests/%d\n" % (project, step["mr"])},
                               "session_id": sid, "cwd": repo}, opts) or ""
            else:
                msg = process_round(step["mr"], sid, repo, opts)
            n = step["name"]
            check("golden2 %s: posted" % n, msg.startswith("Posted"), msg)
            body = json.load(open(gstate, encoding="utf-8"))["notes"].get(str(step["mr"]), [{}])[-1].get("body", "")
            bodies.append(body)
            rec = ct.parse_record(body) or {}
            tot = rec.get("total", {})
            check("golden2 %s: record number and totals" % n, rec.get("k") == want["record"]
                  and tot.get(("tok", "all")) == want["total_tokens"] and str(tot.get(("usd", "all"))) == want["total_usd"], repr(rec))
            for line in want["rows"]:
                check("golden2 %s: row %s" % (n, line[:30]), line in body.split("\n"), body)
            for text in want["contains"]:
                check("golden2 %s: contains %s" % (n, text[:40]), text in body, body)
            for text in want["absent"]:
                check("golden2 %s: does not contain %s" % (n, text[:40]), text not in body, body)
            for text in ex["forbidden_anywhere"]:
                check("golden2 %s: never %s" % (n, text), text not in body, body)
            table = [l for l in body.split("\n") if l.startswith("|")]
            for text in ex["forbidden_in_table"]:
                check("golden2 %s: no %s in a table row" % (n, text), not any(text in l for l in table), "\n".join(table))
            now_state = json.loads(open(state_path(cfg, sid), encoding="utf-8").read())
            check("golden2 %s: the session's state after (one file for both repos)" % n, now_state == want["state"], repr(now_state))
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
        check("golden2: the records of both repos add up to the session's usage (nothing claimed twice, nothing dropped)",
              got == every == ex["session_total_tokens"], "records %d, transcripts %d, expected %d" % (got, every, ex["session_total_tokens"]))
        check("golden2: nothing is written under either repo's git dir",
              not any(os.path.exists(os.path.join(git_common_dir(run, r), "mr-cost-state", sid + ".json")) and
                      r != repos["y"] for r in repos.values()))
    finally:
        globals()["now_utc"] = saved_now
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(tmp, ignore_errors=True)


def golden_worktrees(check):
    """/wave workers: two linked worktrees under `<repo>/.claude/worktrees/agent-*`, both MRs opened from
    the MAIN checkout (scripts/tests/cost-ledger-golden/worktrees/). A worker's path is inside the main
    checkout's directory, so attribution must resolve it to the worktree git lists for it (its branch), not
    call it the main checkout's. Also two posts at once in one session: the session lock must serialize them."""
    import shutil
    import threading
    import time
    import importlib.util
    root = os.path.join(GOLDEN, "worktrees")
    with open(os.path.join(root, "scenario.json"), encoding="utf-8") as f:
        sc = json.load(f)
    with open(os.path.join(root, "expected.json"), encoding="utf-8") as f:
        ex = json.load(f)
    tmp = tempfile.mkdtemp(prefix="cost-golden3-")
    saved_env, saved_now = dict(os.environ), globals()["now_utc"]
    try:
        bindir = os.path.join(tmp, "bin")
        os.makedirs(bindir)
        shim = os.path.join(bindir, "glab")
        with open(shim, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, os.path.join(GOLDEN, "fake-glab.py")))
        os.chmod(shim, 0o700)  # owner-only exec is enough for a test shim
        empty = os.path.join(tmp, "gitconfig")
        open(empty, "w").close()
        gstate = os.path.join(tmp, "glab-state.json")
        with open(gstate, "w", encoding="utf-8") as f:
            json.dump({"mrs": sc["mrs"], "notes": {}, "next_id": 1}, f)
        os.environ.update({"PATH": bindir + os.pathsep + saved_env.get("PATH", ""), "GIT_CONFIG_GLOBAL": empty,
                           "GIT_CONFIG_NOSYSTEM": "1", "CLAUDE_CONFIG_DIR": os.path.join(tmp, "claude-config"),
                           "FAKE_GLAB_STATE": gstate, "FAKE_GLAB_PROJECT": urllib.parse.quote(sc["project"], safe="")})
        cfg = config_root()
        repo = os.path.join(tmp, "main-checkout")
        g = ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-C", repo]
        subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True)
        subprocess.run(g + ["commit", "-q", "--no-verify", "--allow-empty", "-m", "x"], check=True)
        subprocess.run(g + ["remote", "add", "origin", "https://example.test/%s.git" % sc["project"]], check=True)
        for wname, wbranch in sc["workers"].items():
            subprocess.run(g + ["worktree", "add", "-q", "-b", wbranch, os.path.join(repo, ".claude", "worktrees", wname)], check=True)
        projects = os.path.join(tmp, "projects")
        shutil.copytree(os.path.join(root, "projects"), projects)
        for dirpath, _d, files in os.walk(projects):  # the fixture names paths as {REPO}: point them at this checkout
            for fn in files:
                if fn.endswith(".jsonl"):
                    fp = os.path.join(dirpath, fn)
                    text = open(fp, encoding="utf-8").read().replace("{REPO}", repo)
                    open(fp, "w", encoding="utf-8").write(text)
        opts = Opts(projects, os.path.join(GOLDEN, "prices.json"), sc["today"])
        spec = importlib.util.spec_from_file_location("cost_table_golden3", os.path.join(HERE, "cost-table.py"))
        ct = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ct)
        sid = sc["session"]
        wts = worktrees(run, repo)
        check("golden3: git lists the main checkout and both workers' worktrees", len(wts) == 3 and wts[0][1] == "main", repr(wts))

        def hook(mr, runner):
            return process({"tool_name": "Bash", "tool_input": {"command": "glab mr create --yes"},
                            "tool_response": {"stdout": "https://example.test/%s/-/merge_requests/%d\n" % (sc["project"], mr)},
                            "session_id": sid, "cwd": repo}, opts, runner) or ""

        def note_bodies(mr):
            return [n["body"] for n in json.load(open(gstate, encoding="utf-8"))["notes"].get(str(mr), [])]
        bodies = []
        for step in sc["steps"]:
            globals()["now_utc"] = lambda t=step["at"]: t
            n, want = step["name"], ex["steps"][step["name"]]
            if step["kind"] == "concurrent":
                def slow(cmd, cwd, env=None, timeout=300):
                    if any(os.path.basename(c) == "cost-table.py" for c in cmd[:2]) and "--post" in cmd:
                        time.sleep(0.5)  # hold each post open so an unlocked pair would both read the old watermark
                    return run(cmd, cwd, env, timeout)
                threads = [threading.Thread(target=hook, args=(mr, slow)) for mr in step["mrs"]]
                for t in threads:
                    t.start()
                for t in threads:
                    t.join()
                posted = [b for mr in step["mrs"] for b in note_bodies(mr)]
                bodies += posted
                got = [(ct.parse_record(b) or {}).get("total", {}) for b in posted]
                check("golden3 %s: two posts at once in one session: exactly one claims the window" % n, len(posted) == want["posted_notes"], repr(len(posted)))
                check("golden3 %s: it claims the window's tokens, once" % n, got and got[0].get(("tok", "all")) == want["total_tokens"]
                      and str(got[0].get(("usd", "all"))) == want["total_usd"], repr(got))
                now_state = json.loads(open(state_path(cfg, sid), encoding="utf-8").read())
                check("golden3 %s: no watermark is dropped" % n, now_state == want["state"], repr(now_state))
                continue
            msg = hook(step["mr"], run) if step["kind"] == "hook" else process_round(step["mr"], sid, repo, opts)
            check("golden3 %s: posted" % n, msg.startswith("Posted"), msg)
            body = note_bodies(step["mr"])[-1]
            bodies.append(body)
            rec = ct.parse_record(body) or {}
            tot = rec.get("total", {})
            check("golden3 %s: record number and totals" % n, rec.get("k") == want["record"]
                  and tot.get(("tok", "all")) == want["total_tokens"] and str(tot.get(("usd", "all"))) == want["total_usd"], repr(rec))
            for line in want["rows"]:
                check("golden3 %s: row %s" % (n, line[:30]), line in body.split("\n"), body)
            for text in want["contains"]:
                check("golden3 %s: contains %s" % (n, text[:40]), text in body, body)
            for text in want["absent"]:
                check("golden3 %s: does not contain %s" % (n, text[:40]), text not in body, body)
            for text in ex["forbidden_anywhere"]:
                check("golden3 %s: never %s" % (n, text), text not in body, body)
            table = [l for l in body.split("\n") if l.startswith("|")]
            for text in ex["forbidden_in_table"]:
                check("golden3 %s: no %s in a table row" % (n, text), not any(text in l for l in table), "\n".join(table))
            now_state = json.loads(open(state_path(cfg, sid), encoding="utf-8").read())
            check("golden3 %s: the session's state after" % n, now_state == want["state"], repr(now_state))
        import transcript_usage as tu
        last = tu.parse_time(sc["steps"][-1]["at"])
        every, seen_ids = 0, set()
        for path in sorted(glob.glob(os.path.join(projects, "**", "*.jsonl"), recursive=True)):
            for line in open(path, encoding="utf-8"):
                e = json.loads(line)
                u = (e.get("message") or {}).get("usage") if e.get("type") == "assistant" else None
                if not u or e["message"]["id"] in seen_ids or tu.parse_time(e["timestamp"]) > last:
                    continue
                seen_ids.add(e["message"]["id"])
                every += sum(u.get(k, 0) for k in tu.FIELDS)
        got = sum(((ct.parse_record(b) or {}).get("total", {}).get(("tok", "all")) or 0) for b in bodies)
        check("golden3: the records add up to the session's usage (each worker on its own MR, nothing claimed twice)",
              got == every == ex["session_total_tokens"], "records %d, transcripts %d, expected %d" % (got, every, ex["session_total_tokens"]))
    finally:
        globals()["now_utc"] = saved_now
        os.environ.clear()
        os.environ.update(saved_env)
        shutil.rmtree(tmp, ignore_errors=True)


# Variables git itself sets (a hook runs with GIT_DIR and friends) that make EVERY git command, even
# `git -C <scratch repo>`, act on the outer repository. The self-test builds scratch repos and runs
# `checkout -B main`, `symbolic-ref` and commits in them, so they must not be inherited.
REPO_LOCATING_GIT_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX",
                         "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE")


def self_test():
    cfg_tmp = tempfile.mkdtemp(prefix="post-mr-cost-config-")
    saved = os.environ.get("CLAUDE_CONFIG_DIR")
    saved_git = {k: os.environ.pop(k) for k in REPO_LOCATING_GIT_ENV if k in os.environ}
    os.environ["CLAUDE_CONFIG_DIR"] = cfg_tmp  # never touch the real ~/.claude/mr-cost-state
    try:
        return _self_test()
    finally:
        os.environ.update(saved_git)
        if saved is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = saved


def _self_test():
    fails, n = [], [0]

    def check(name, cond, detail=""):
        n[0] += 1
        if not cond:
            fails.append("%s %s" % (name, detail))

    check("no repo-locating GIT_* variable leaks into the self-test (a pre-push hook sets GIT_DIR, and "
          "every scratch repo would be the outer one)",
          not [k for k in REPO_LOCATING_GIT_ENV if k in os.environ],
          repr([k for k in REPO_LOCATING_GIT_ENV if k in os.environ]))

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
            if cmd[:3] == ["git", "rev-parse", "--git-common-dir"]:
                return 0, os.path.join(tempfile.gettempdir(), "stub-git-dir") + "\n", ""
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
    mixed = "ls /-/merge_requests/3 && https://x.test/g/p/-/merge_requests/9\n"
    check("the iid and the project come from ONE match: a bare /-/merge_requests/3 before the full URL is not the MR",
          mr_ref(mixed) == ("g/p", 9) and mr_iid("glab mr create", mixed) == 9 and mr_project(mixed) == "g/p"
          and mr_ref("see /-/merge_requests/3") == (None, 3) and mr_ref("nothing") == (None, None))
    deep = "/".join("sub%d" % i for i in range(1, 16)) + "/proj"     # 16 segments, past any fixed cap
    check("a deeply nested GitLab project is read from the MR URL, the origin remote and a pending claim",
          mr_ref("https://h.test/%s/-/merge_requests/4" % deep) == (deep, 4)
          and parse_remote("git@h.test:%s.git" % deep) == deep and PROJECT_PATH_RE.match(deep) is not None)
    check("the default transcript directory is $CLAUDE_CONFIG_DIR/projects", Opts().projects_dir == os.path.join(config_root(), "projects"))
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
    # #2152: a state dir symlinked outside the config root is refused (StateError / False), never followed or crashed on.
    gd_esc = tempfile.mkdtemp(prefix="post-mr-cost-esc-")
    gd_out = tempfile.mkdtemp(prefix="post-mr-cost-out-")
    os.symlink(gd_out, os.path.join(gd_esc, "mr-cost-state"))
    try:
        read_state(gd_esc, "sess-1")
        esc_read = False
    except StateError:
        esc_read = True
    check("a symlinked state dir is refused on read", esc_read)
    check("a symlinked state dir is refused on write (False, no raise)",
          write_state(gd_esc, "sess-1", {"orchestrator_until": None, "agents": {}}, "2026-11-07T10:00:00Z", []) is False
          and os.listdir(gd_out) == [])
    # #2152: state_lock degrades to NO lock (runs the body, creates no lock file) when the state dir escapes the config root.
    prev_cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    os.environ["CLAUDE_CONFIG_DIR"] = gd_esc
    ran = []
    try:
        if fcntl is not None:
            with state_lock("sess-1"):
                ran.append(1)
    finally:
        if prev_cfg is None:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)
        else:
            os.environ["CLAUDE_CONFIG_DIR"] = prev_cfg
    check("an escaping state dir: state_lock runs the body without a lock file outside the root",
          (ran == [1] or fcntl is None) and os.listdir(gd_out) == [], repr(os.listdir(gd_out)))
    # #2152: find_session_dir skips a session dir that symlinks outside the projects dir, and keeps the others.
    pd = tempfile.mkdtemp(prefix="post-mr-cost-proj-")
    os.makedirs(os.path.join(pd, "slug-a", "sess-ok"))
    os.makedirs(os.path.join(pd, "slug-b-link-real"), exist_ok=True)
    os.symlink(gd_out, os.path.join(pd, "slug-b-link-real", "sess-esc"))
    check("find_session_dir: a symlinked session dir that escapes the projects dir is skipped", find_session_dir("sess-esc", pd) is None)
    check("find_session_dir: an in-tree session dir is found (as its resolved path)",
          find_session_dir("sess-ok", pd) == os.path.realpath(os.path.join(pd, "slug-a", "sess-ok")))
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
    subprocess.run(git + ["commit", "-q", "--no-verify", "--allow-empty", "-m", "x"], check=True)
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
          and not os.path.exists(pins_path(config_root(), "abc-123")), repr((rc, err)))
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

    check("a brief naming this MR AND another keeps this MR (the precedence is pinned)",
          attribution("branch feat/101-a; the other one is work-wt/202-b and fix/303-c", br, "") is True
          and attribution("the other one is /ws/work-wt/202-b/ and /ws/work-wt/101-a/ is mine", br, "") is True)
    check("a brief naming only another worktree path is another MR's (no branch token needed)",
          attribution("Implement in /ws/work-wt/202-other/ and report", br, "") is False
          and attribution("Implement in /ws/work-wt/202-other/ and report", br, "101-a") is False)
    check("this MR's own worktree path is this MR's, even in the main checkout (leaf '' falls back to the branch's leaf)",
          attribution("Implement in /ws/work-wt/101-a/", br, "") is True)
    check("a docs path or a file name is not a worktree leaf", attribution("see guides/3-tier-model.md and /x/2-columns.png", br, "") is None
          and attribution("dated /notes/2026-11-07/log", br, "") is None)
    check("pins are keyed project:branch", pin_key("g/p", "feat/1-a") == "g/p:feat/1-a" and pin_key("g/q", "feat/1-a") != pin_key("g/p", "feat/1-a"))
    check("the state root is $CLAUDE_CONFIG_DIR, else ~/.claude", config_root() == os.environ["CLAUDE_CONFIG_DIR"])

    # agent_home: a transcript shaped like the real ones (Bash input.command starting `cd /abs/...-wt/<n>-slug && `,
    # Edit with an absolute file_path), classified and never echoed.
    ht = tempfile.mkdtemp(prefix="post-mr-cost-home-")

    def transcript(*calls):
        path = os.path.join(ht, "t%d.jsonl" % len(os.listdir(ht)))
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps({"type": "user", "message": {"role": "user", "content": "SECRET-BRIEF"}}) + "\n")
            for k, (name, inp) in enumerate(calls):
                f.write(json.dumps({"type": "assistant", "message": {"id": "m%d" % k, "content": [
                    {"type": "tool_use", "id": "tu%d" % k, "name": name, "input": inp}]}}) + "\n")
        return path
    wa, wb = "/Users/x/repos/proj-wt/101-first", "/Users/x/repos/proj-wt/202-second"
    top = "/Users/x/repos/proj"
    wts0 = []   # no listed worktree: the `*-wt/<n>-<slug>` leaf rule
    check("home: the majority of Edit/Write paths wins over a cd",
          agent_home(transcript(("Edit", {"file_path": wb + "/a.py"}), ("Write", {"file_path": wb + "/b.py"}),
                                ("Bash", {"command": "cd %s && ls" % wa}), ("Bash", {"command": "cd %s && ls" % wa})), wts0) == ("leaf", "202-second"))
    check("home: no writes, the cd target leads (a read-only auditor)",
          agent_home(transcript(("Bash", {"command": "cd %s && git diff origin/main" % wa}), ("Bash", {"command": "cd %s && git log -1" % wa}),
                                ("Bash", {"command": "cd %s && ls" % wb})), wts0) == ("leaf", "101-first"))
    check("home: git -C counts unless the command is show, diff or log",
          agent_home(transcript(("Bash", {"command": "git -C %s status" % wa})), wts0) == ("leaf", "101-first")
          and agent_home(transcript(("Bash", {"command": "git -C %s show HEAD" % wa}), ("Bash", {"command": "git -C %s diff" % wa}),
                                    ("Bash", {"command": "git -C %s log" % wa})), wts0) is None)
    check("home: two worktrees written EQUALLY is no home (a strict majority is required), so the cd rule decides, then the brief",
          agent_home(transcript(("Edit", {"file_path": wa + "/a"}), ("Edit", {"file_path": wb + "/b"})), wts0) is None
          and agent_home(transcript(("Edit", {"file_path": wa + "/a"}), ("Edit", {"file_path": wb + "/b"}),
                                    ("Bash", {"command": "cd %s && ls" % wb})), wts0) == ("leaf", "202-second"))
    check("home: a tie between two worktrees is no home (the brief decides)",
          agent_home(transcript(("Bash", {"command": "cd %s" % wa}), ("Bash", {"command": "cd %s" % wb})), wts0) is None)
    check("home: writes that are not a majority fall through to the cd rule",
          agent_home(transcript(("Edit", {"file_path": wb + "/a.py"}), ("Write", {"file_path": "/scratch-2152/n.md"}),
                                ("Write", {"file_path": "/scratch-2152/m.md"}), ("Bash", {"command": "cd %s" % wa})), wts0) == ("leaf", "101-first"))
    wl = [(top, "main"), (top + "/.claude/worktrees/agent-p", "feat/1-p"), (top + "/.claude/worktrees/agent-q", "feat/2-q")]
    check("home: a path in a listed worktree is that worktree's BRANCH; the deepest wins, so a worker under .claude/worktrees is never the main checkout",
          agent_home(transcript(("Edit", {"file_path": top + "/.claude/worktrees/agent-p/x.py"})), wl) == ("branch", "feat/1-p")
          and agent_home(transcript(("Edit", {"file_path": top + "/src/x.py"})), wl) == ("branch", "main"))
    check("home: a path under <toplevel>/.claude/worktrees/ in no LISTED worktree is never the main checkout",
          path_home(top + "/.claude/worktrees/agent-gone/x.py", wl) is None
          and path_home(top + "/src/x.py", wl) == ("branch", "main"))
    dup = os.path.join(ht, "dup.jsonl")
    with open(dup, "w", encoding="utf-8") as f:
        for tid, w in (("t1", wb), ("t1", wb), ("t2", wa), ("t3", wa)):
            f.write(json.dumps({"type": "assistant", "message": {"id": "m", "content": [
                {"type": "tool_use", "id": tid, "name": "Edit", "input": {"file_path": w + "/a"}}]}}) + "\n")
    check("home: a tool_use repeated in the transcript (same id) is counted once", agent_home(dup, wts0) == ("leaf", "101-first"))
    check("home: no tool calls, or an unreadable file, is no home",
          agent_home(transcript(("Read", {"file_path": wa + "/a"})), wts0) is None and agent_home(os.path.join(ht, "absent"), wts0) is None)
    check("home: the result carries no path or command text",
          "/Users" not in repr(agent_home(transcript(("Edit", {"file_path": wa + "/a.py"})), wts0)))

    golden_cases(check)
    golden_two_repos(check)
    golden_worktrees(check)
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
