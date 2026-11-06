"""scripts/lib/transcript_usage.py - per-response token usage from Claude Code session
transcripts, shared by scripts/orchestrator-tokens.py and scripts/subagent-tokens.py
(macrodream/blueprint#365), and by scripts/est-cost.py (macrodream/blueprint#364), which prices each
response by `measure_rows`.

Pure functions: no subprocess, no policy (the cost-ledger setting is each CLI's job).
Ported from Blueprint for #2128; `contained()` is the one Visiban addition (below).

The transcript layout is an undocumented interface, observed 2026-11-03:
  ~/.claude/projects/<slug>/<session-id>.jsonl                      the orchestrating session
  ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.jsonl one per subagent
  ~/.claude/projects/<slug>/<session-id>/subagents/agent-<id>.meta.json   `parentAgentId` for a
                                                                     nested agent; all agents
                                                                     (nested too) share the one flat dir
Every entry of a subagent transcript carries `isSidechain: true`; the orchestrator's own do
not. So `measure` takes a side selector. One API response is written as several entries with
the same `message.id` and identical usage (a fork repeats its parent's), so usage is counted
once per id, across every line handed to one `measure` call.

The transcript is untrusted data: nothing here echoes a transcript or meta string except the
model name (sanitized), and an id becomes a path only after AGENT_ID_RE accepts it.
"""
import collections
import datetime
import glob
import json
import os
import re
import sys

FIELDS = ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")
# An agent id as the Agent tool result prints it (`a` + hex, observed 17 chars). Anchored with \Z and
# no separators, so an id can never carry `/` or `..` into a path.
AGENT_ID_RE = re.compile(r"^a?[0-9a-f]{8,64}\Z")
SESSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{0,127}\Z")
MODEL_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}\Z")


def allowed_roots():
    """Where a CLI-named transcript, projects dir or price table may live: the checkout, the cwd
    and the temp dir (scripts/_paths.py cli_roots), plus ~/.claude and $CLAUDE_CONFIG_DIR."""
    scripts = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from _paths import cli_roots
    extra = [os.path.join(os.path.expanduser("~"), ".claude")]
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        extra.append(os.environ["CLAUDE_CONFIG_DIR"])
    return cli_roots(*extra)


def contained(path):
    """`path` canonicalized inside allowed_roots(), as a str; raises ValueError otherwise.
    The visiban gate-script convention (#1377): a path from the command line is resolved
    (symlinks and `..` collapsed) and checked before anything is opened under it."""
    from _paths import PathEscapeError, resolve_within
    try:
        return str(resolve_within(allowed_roots(), path))
    except PathEscapeError:
        raise ValueError("a path argument is outside the checkout, the temp dir and ~/.claude") from None


def parse_time(text):
    """An aware datetime, or None when the text is not ISO 8601 with a zone."""
    if not isinstance(text, str):
        return None
    t = text.strip()
    if t.endswith(("Z", "z")):
        t = t[:-1] + "+00:00"
    try:
        dt = datetime.datetime.fromisoformat(t)
    except ValueError:
        return None
    return dt if dt.tzinfo is not None else None


def usage_of(entry):
    """(message id or None, (4 ints)) for an assistant entry with usage;
    None for an entry that carries no usage; False for a malformed one."""
    msg = entry.get("message")
    if not isinstance(msg, dict) or "usage" not in msg:
        return None
    u = msg.get("usage")
    if not isinstance(u, dict):
        return False
    vals = []
    for f in FIELDS:
        v = u.get(f, 0)
        if v is None:
            v = 0
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            return False
        vals.append(v)
    mid = msg.get("id")
    return (mid if isinstance(mid, str) and mid else None), tuple(vals)


def _model_of(entry):
    m = (entry.get("message") or {}).get("model")
    return m if isinstance(m, str) and MODEL_RE.match(m) else "unknown"


def cache_1h_of(entry, cache_write):
    """Tokens of the response's cache write that were billed at the 1-hour rate:
    `message.usage.cache_creation.ephemeral_1h_input_tokens` when it is an int within
    [0, cache_write], else 0 (the whole write then prices at the 5-minute rate, the cheaper
    one; the field is observed 2026-11-03, not documented)."""
    cc = ((entry.get("message") or {}).get("usage") or {}).get("cache_creation")
    v = cc.get("ephemeral_1h_input_tokens") if isinstance(cc, dict) else None
    if isinstance(v, bool) or not isinstance(v, int) or v < 0 or v > cache_write:
        return 0
    return v


def modifier_of(entry):
    """A pricing modifier the response carries, as FIXED text (never the transcript value, which
    is untrusted), else None: `message.usage.speed` present and not "standard" (fast mode),
    `message.usage.inference_geo` present and not "global" (a regional multiplier), or
    `message.usage.service_tier` present and not "standard" (batch, priority). A price table
    that has no rate for any of them cannot price the response, so est-cost.py omits its line
    (observed 2026-11-03, not documented)."""
    u = (entry.get("message") or {}).get("usage") or {}
    sp, geo, tier = u.get("speed"), u.get("inference_geo"), u.get("service_tier")
    if sp is not None and sp != "standard":
        return "fast mode"
    if geo is not None and geo != "global":
        return "a non-global inference_geo"
    if tier is not None and tier != "standard":
        return "a non-standard service_tier"
    return None


def measure_rows(lines, since=None, until=None, side="main"):
    """The per-response rows behind measure_detail: (rows, stats), each row
    (vals, model, cache_write_1h, modifier) with vals the 4 ints in FIELDS order and modifier
    the modifier_of text or None. side="main" keeps
    entries NOT marked isSidechain (the orchestrating session); side="sidechain" keeps only
    isSidechain entries (subagent transcripts). The other side is counted in stats["sidechain"]
    (the count of entries skipped for being on the other side; the key name is historical).
    One row per message id across every line handed in."""
    if side not in ("main", "sidechain"):
        raise ValueError("side must be 'main' or 'sidechain'")
    stats = {"messages": 0, "malformed": 0, "sidechain": 0, "duplicate": 0, "outside": 0}
    by_id, anon = {}, []
    for raw in lines:
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw)
        except (ValueError, RecursionError):  # deep nesting raises RecursionError, not ValueError
            stats["malformed"] += 1
            continue
        if not isinstance(entry, dict) or entry.get("type") != "assistant":
            continue
        got = usage_of(entry)
        if got is None:
            continue
        if got is False:
            stats["malformed"] += 1
            continue
        if (entry.get("isSidechain") is True) != (side == "sidechain"):
            stats["sidechain"] += 1
            continue
        ts = parse_time(entry.get("timestamp"))
        if ts is None:
            stats["malformed"] += 1
            continue
        if (since and ts < since) or (until and ts > until):
            stats["outside"] += 1
            continue
        mid, vals = got
        row = (vals, _model_of(entry), cache_1h_of(entry, vals[1]), modifier_of(entry))
        if mid is None:
            anon.append(row)
        elif mid in by_id:
            stats["duplicate"] += 1
            by_id[mid] = row  # last write wins; observed duplicates are identical
        else:
            by_id[mid] = row
    rows = list(by_id.values()) + anon
    stats["messages"] = len(rows)
    return rows, stats


def measure_detail(lines, since=None, until=None, side="main"):
    """Sum usage over the window for one side (see measure_rows).
    Returns (totals, stats, per_model) where per_model is {model: [4 ints]}."""
    rows, stats = measure_rows(lines, since, until, side)
    totals = [sum(r[0][i] for r in rows) for i in range(len(FIELDS))]
    per_model = collections.defaultdict(lambda: [0] * len(FIELDS))
    for vals, model, _, _ in rows:
        for i, v in enumerate(vals):
            per_model[model][i] += v
    return totals, stats, dict(per_model)


def measure(lines, since=None, until=None, side="main"):
    """Sum usage over the window. Returns (totals, stats)."""
    totals, stats, _ = measure_detail(lines, since, until, side)
    return totals, stats


def _read_json(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            data = json.load(f)
    except (OSError, ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def subagent_files(session_dir, ids):
    """Resolve named agent ids plus every transitive descendant (via `parentAgentId` in
    agent-<id>.meta.json) to transcript files under <session_dir>/subagents/.
    Returns (agents, files): agents is a list of (id, named) in discovery order, files the
    matching transcript paths. Raises ValueError for a malformed id, an unresolvable session
    dir, or any named or descendant id with no transcript (fail closed: a partial sum would
    read as a measured one)."""
    for i in ids:
        if not isinstance(i, str) or not AGENT_ID_RE.match(i):
            raise ValueError("not an agent id: %r" % (i if isinstance(i, str) else type(i).__name__))
    sub = os.path.join(session_dir, "subagents")
    if not os.path.isdir(sub):
        raise ValueError("no subagents directory at the session path (transcript layout changed, "
                         "or the session id is wrong)")
    children = collections.defaultdict(list)
    for meta in sorted(glob.glob(os.path.join(glob.escape(sub), "agent-*.meta.json"))):
        name = os.path.basename(meta)[len("agent-"):-len(".meta.json")]
        data = _read_json(meta)
        if data is None:
            # Fail closed: an unreadable meta could hide a descendant and undercount silently.
            raise ValueError("an agent meta file is unreadable (transcript layout changed?)")
        parent = data.get("parentAgentId")
        if AGENT_ID_RE.match(name) and isinstance(parent, str) and AGENT_ID_RE.match(parent):
            children[parent].append(name)
    agents, seen, queue = [], set(), collections.deque()
    for i in ids:
        if i not in seen:
            seen.add(i)
            agents.append((i, True))
            queue.append(i)
    while queue:
        cur = queue.popleft()
        for child in children.get(cur, ()):
            if child not in seen:
                seen.add(child)
                agents.append((child, False))
                queue.append(child)
    files = []
    for aid, _named in agents:
        path = os.path.join(sub, "agent-%s.jsonl" % aid)
        if not os.path.isfile(path):
            raise ValueError("agent %s has no transcript under the session's subagents directory" % aid)
        files.append(path)
    return agents, files


def session_paths(sid, projects_dir):
    """(main transcript path, session directory) for a session id: the one
    <projects_dir>/*/<sid>.jsonl and its sibling <sid>/ directory. Raises ValueError for a
    malformed id or anything but exactly one transcript."""
    if not isinstance(sid, str) or not SESSION_RE.match(sid):
        raise ValueError("not a session id: %r" % (sid if isinstance(sid, str) else type(sid).__name__))
    hits = sorted(glob.glob(os.path.join(glob.escape(projects_dir), "*", sid + ".jsonl")))
    if len(hits) != 1:
        raise ValueError("session %s: %d transcripts under %s (need exactly 1)" % (sid, len(hits), projects_dir))
    return hits[0], hits[0][:-len(".jsonl")]
