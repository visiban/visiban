#!/usr/bin/env python3
"""scripts/est-cost.py - the `est-cost-usd:` MR ledger line: the branch's token usage priced
at list prices from a dated table (macrodream/blueprint#364, part C of macrodream/blueprint#348).

What it prices: the same two figures as the measured token lines, per response, each with
its own model and its four usage classes: the orchestrating session over --since/--until
(scripts/orchestrator-tokens.py's window) plus the named subagents, their descendants, up to
--until (scripts/subagent-tokens.py's set). The line is omitted when any piece is missing: a
partial price would read as a whole one.

It is a LIST-PRICE EQUIVALENT: what the same tokens would cost at the public API rates in
.claude/model-prices.json, not what a subscription charged. `cost: usd` stays reserved for a
measured figure. Prices are copied from the table's `source` URL by a person and reviewed.

Pricing rules (per response, exact decimal arithmetic, rounded half up once at the end to
cents):
  input and output tokens at their rates; cache reads at `cache_read`; the cache write split
  by `message.usage.cache_creation.ephemeral_1h_input_tokens` (1-hour rate) and the rest
  (5-minute rate). When the response carries no valid split the whole write is priced at the
  5-minute rate, the cheaper one (so the estimate can understate, never overstate, on that
  field). A model row with `long_prompt` uses it for a response whose prompt tokens
  (input + cache write + cache read) are over its threshold. A model with no row, a stale
  table (`checked` more than 90 days before today, or in the future), or a missing or
  malformed table, or a response with a pricing modifier the table has no rate for (fast mode,
  a non-global `inference_geo`, a non-standard `service_tier`): no line.

Layout dependency (undocumented, observed 2026-11-03), shared with subagent-tokens.py:
  <projects-dir>/<slug>/<session-id>.jsonl and <session-id>/subagents/agent-<id>.jsonl
This FAILS CLOSED: an agent with no transcript or an unresolved session prints no line.

The transcripts and the price table are untrusted data: an id becomes a path only after a
strict pattern accepts it, and no transcript or table string is echoed except a sanitized
model name.

Usage:
  python3 scripts/est-cost.py --agent <id> [--agent <id> ...] --since <ISO 8601> --until <ISO 8601>
         [--session <session-id>] [--projects-dir <dir>] [--prices <file>] [--today YYYY-MM-DD]
  python3 scripts/est-cost.py --no-agents --since <ISO 8601> --until <ISO 8601> [same options]
  python3 scripts/est-cost.py --self-test

  --no-agents prices the orchestrator alone (macrodream/blueprint#386): the explicit statement
  that no subagent ran in the window, such as a /fix-mr pass. The stdout line has the same form;
  stderr labels the run `orchestrator-only` and prints the orchestrator per-model lines and no
  subagent ones. It is never a default: without --agent and without it this exits 2; both
  together is a usage error; an orchestrator with no usage in the window still prints no line.

  The session id defaults to $CLAUDE_CODE_SESSION_ID. Times must carry a zone.
  The cost-ledger setting is asked first (`scripts/cost-ledger enabled`): off or unreadable
  prints nothing and opens no transcript.

Output: `est-cost-usd: <N.NN> (prices <checked date>)` on stdout and nothing else; the pieces
        and per-model figures, or the reason for an omission as a `note:` line (the text for
        the MR's `## Notes`), on stderr.
Exit:   0 priced - 1 omitted (stale or bad table, a model with no row, a response in fast
        mode or with a non-global inference_geo or non-standard service_tier, a missing agent or
        session, no usage) - 2 usage error - 3 the cost ledger is off or unreadable
"""
import datetime
import decimal
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

D = decimal.Decimal
DEFAULT_PRICES = os.path.join(os.path.dirname(HERE), ".claude", "model-prices.json")
MAX_AGE_DAYS = 90
RATES = ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
MILLION = D(1000000)


class Omit(Exception):
    """A reason the line is omitted; the text is safe to print (no transcript or table text)."""


def ledger_enabled():
    """scripts/cost-ledger enabled: 0 on, 1 off, 2 unreadable (anything else counts as unreadable)."""
    try:
        return subprocess.run([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"],
                              capture_output=True, timeout=30).returncode
    except (OSError, subprocess.SubprocessError):
        return 2


def _rate(v):
    return isinstance(v, D) and v.is_finite() and v >= 0


def _rates_ok(row):
    return isinstance(row, dict) and all(_rate(row.get(k)) for k in RATES)


def load_prices(path, today):
    """(table, checked date string); raises Omit for a missing, malformed or stale table."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f, parse_float=D, parse_int=D)
    except OSError:
        raise Omit("price table %s is missing or unreadable" % os.path.basename(path))
    except (ValueError, RecursionError):
        raise Omit("price table is not valid JSON")
    if not isinstance(data, dict) or data.get("schema") != 1 or not isinstance(data.get("models"), dict):
        raise Omit("price table is malformed (schema 1 with a `models` object expected)")
    checked = data.get("checked")
    if not isinstance(checked, str) or not DATE_RE.match(checked):
        raise Omit("price table is malformed (`checked` must be YYYY-MM-DD)")
    src = data.get("source")
    if not isinstance(src, str) or not src.startswith("https://"):
        raise Omit("price table is malformed (`source` must be an https URL)")
    try:
        when = datetime.date.fromisoformat(checked)
    except ValueError:
        raise Omit("price table is malformed (`checked` is not a date)")
    age = (today - when).days
    if age < 0:
        raise Omit("price table `checked` date %s is in the future" % checked)
    if age > MAX_AGE_DAYS:
        raise Omit("price table is stale: checked %s, %d days old (limit %d); re-copy the prices "
                   "from its source and update `checked`" % (checked, age, MAX_AGE_DAYS))
    for name, row in data["models"].items():
        lp = row.get("long_prompt") if isinstance(row, dict) else None
        if not _rates_ok(row) or (lp is not None and not (_rates_ok(lp) and _rate(lp.get("over_tokens")))):
            raise Omit("price table is malformed (a model row lacks a rate)")
    return data["models"], checked


def price_row(table, vals, model, w1h, modifier=None):
    """Exact USD (Decimal) for one response; raises Omit for a model with no row, and for a
    response with a pricing modifier (fast mode, a regional multiplier, a non-standard service_tier) the table has no rate for:
    pricing it at the standard rate would print a complete-looking line about half the real figure."""
    if modifier is not None:
        raise Omit("a response used %s, which the price table does not cover" % modifier)
    row = table.get(model)
    if row is None:
        raise Omit("model %s has no row in the price table" % model)
    i, cw, cr, out = vals
    lp = row.get("long_prompt")
    if lp is not None and i + cw + cr > lp["over_tokens"]:
        row = lp
    return (i * row["input"] + (cw - w1h) * row["cache_write_5m"] + w1h * row["cache_write_1h"]
            + cr * row["cache_read"] + out * row["output"]) / MILLION


def price_rows(table, rows):
    """(total Decimal, {model: Decimal}) over measure_rows output. All-zero rows (a synthetic
    message) cost nothing and need no price row."""
    total, per = D(0), {}
    for vals, model, w1h, modifier in rows:
        if not any(vals):
            continue
        c = price_row(table, vals, model, w1h, modifier)
        total += c
        per[model] = per.get(model, D(0)) + c
    return total, per


def cents(x):
    return x.quantize(D("0.01"), rounding=decimal.ROUND_HALF_UP)


def estimate(sid, ids, since, until, projects_dir, table, err, orchestrator_only=False):
    """(total Decimal) for the orchestrator window plus the agents; raises Omit."""
    try:
        main_path, sdir = tu.session_paths(sid, projects_dir)
        agents, files = ([], []) if orchestrator_only else tu.subagent_files(sdir, ids)
    except ValueError as e:
        raise Omit("%s" % e)

    def sub_lines():
        for path in files:
            with open(path, encoding="utf-8", errors="replace") as f:
                yield from f

    try:
        with open(main_path, encoding="utf-8", errors="replace") as f:
            orows, ostats = tu.measure_rows(f, since, until, side="main")
        srows, sstats = ([], {"messages": 0}) if orchestrator_only else \
            tu.measure_rows(sub_lines(), None, until, side="sidechain")
    except OSError:
        raise Omit("a transcript could not be read")
    if not ostats["messages"]:
        raise Omit("no orchestrator usage in the window")
    if not sstats["messages"] and not orchestrator_only:
        raise Omit("no subagent usage found for the named agents")
    otot, oper = price_rows(table, orows)
    stot, sper = price_rows(table, srows)
    if orchestrator_only:
        print("est-cost: orchestrator-only (--no-agents): orchestrator %d messages %s USD; no subagent"
              % (ostats["messages"], cents(otot)), file=err)
    else:
        print("est-cost: orchestrator %d messages %s USD; %d agents (%d named, %d descendants) %d messages %s USD"
              % (ostats["messages"], cents(otot), len(agents), sum(1 for _, n in agents if n),
                 sum(1 for _, n in agents if not n), sstats["messages"], cents(stot)), file=err)
    for model in sorted(set(oper) | set(sper)):
        print("est-cost: model %s %s USD" % (model, cents(oper.get(model, D(0)) + sper.get(model, D(0)))), file=err)
    # Per side, so scripts/cost-table.py can split the comment's rows (macrodream/blueprint#383).
    for side, per in (("orchestrator", oper), ("subagent", sper)):
        for model in sorted(per):
            print("est-cost: %s model %s %s USD" % (side, model, cents(per[model])), file=err)
    return otot + stot


def run(argv, out=sys.stdout, err=sys.stderr, enabled=ledger_enabled, today=None):
    state = enabled()
    if state != 0:
        print("cost ledger %s: nothing read, nothing recorded (scripts/cost-ledger status)"
              % ("off" if state == 1 else "setting unreadable"), file=err)
        return 3
    ids, since, until, sid, prices_path, none_ran = [], None, None, None, DEFAULT_PRICES, False
    projects_dir = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    day = today
    i = 0
    flags = ("--agent", "--since", "--until", "--session", "--projects-dir", "--prices", "--today")
    while i < len(argv):
        a = argv[i]
        if a == "--no-agents":
            none_ran = True
            i += 1
            continue
        if a not in flags:
            print("usage: est-cost.py --agent <id> [--agent <id>...] --since T --until T [--session <sid>]", file=err)
            return 2
        if i + 1 >= len(argv):
            print("usage: %s needs a value" % a, file=err)
            return 2
        v = argv[i + 1]
        i += 2
        if a == "--agent":
            if not tu.AGENT_ID_RE.match(v):
                print("usage: --agent %r is not an agent id (the `agentId:` of the Agent tool result)" % v, file=err)
                return 2
            ids.append(v)
        elif a in ("--since", "--until"):
            t = tu.parse_time(v)
            if t is None:
                print("usage: %s %r is not ISO 8601 with a zone (use `date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ`)" % (a, v),
                      file=err)
                return 2
            if a == "--since":
                since = t
            else:
                until = t
        elif a == "--session":
            sid = v
        elif a == "--projects-dir":
            projects_dir = v
        elif a == "--prices":
            prices_path = v
        else:
            if not DATE_RE.match(v):
                print("usage: --today wants YYYY-MM-DD", file=err)
                return 2
            try:
                day = datetime.date.fromisoformat(v)
            except ValueError:
                print("usage: --today wants YYYY-MM-DD", file=err)
                return 2
    if none_ran and ids:
        print("usage: --no-agents and --agent are exclusive", file=err)
        return 2
    if (not ids and not none_ran) or since is None or until is None:
        print("usage: at least one --agent (or --no-agents), and both --since and --until, are required", file=err)
        return 2
    if since > until:
        print("usage: --since is after --until", file=err)
        return 2
    sid = sid or os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not sid:
        print("usage: no --session given and $CLAUDE_CODE_SESSION_ID is unset", file=err)
        return 2
    day = day or datetime.datetime.now(datetime.timezone.utc).date()
    try:
        prices_path, projects_dir = tu.contained(prices_path), tu.contained(projects_dir)
    except ValueError as e:
        print("usage: %s" % e, file=err)
        return 2
    try:
        table, checked = load_prices(prices_path, day)
        total = estimate(sid, ids, since, until, projects_dir, table, err, none_ran)
    except Omit as e:
        print("FAIL: %s; no line printed" % e, file=err)
        print("note: est-cost-usd omitted: %s" % e, file=err)
        return 1
    print("est-cost-usd: %s (prices %s)" % (cents(total), checked), file=out)
    return 0


def self_test():
    fails, ran = [], []

    def check(name, cond, detail=""):
        ran.append(name)
        if not cond:
            fails.append("%s %s" % (name, detail))

    tmp = tempfile.mkdtemp(prefix="est-cost-")
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
    TODAY = datetime.date(2026, 11, 3)

    def u(i, cw, cr, o, w1h=None):
        d = {"input_tokens": i, "cache_creation_input_tokens": cw, "cache_read_input_tokens": cr, "output_tokens": o}
        if w1h is not None:
            d["cache_creation"] = {"ephemeral_5m_input_tokens": cw - w1h, "ephemeral_1h_input_tokens": w1h}
        return d

    def entry(mid, ts, usage, side, model):
        return json.dumps({"type": "assistant", "isSidechain": side, "timestamp": ts,
                           "message": {"id": mid, "model": model, "usage": usage}})

    def write(path, lines):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    # Hand-computed table: every class a different power-of-ten-friendly rate, per MTok.
    table = {"m-a": {"input": 1, "cache_write_5m": 2, "cache_write_1h": 4, "cache_read": 0.5, "output": 10},
             "m-b": {"input": 3, "cache_write_5m": 4, "cache_write_1h": 6, "cache_read": 0.3, "output": 30,
                     "long_prompt": {"over_tokens": 1000, "input": 6, "cache_write_5m": 8, "cache_write_1h": 12,
                                     "cache_read": 0.6, "output": 60}}}

    dtable = json.loads(json.dumps(table), parse_float=D, parse_int=D)  # as load_prices reads it

    def prices_file(name, checked="2026-11-03", models=table, source="https://example.com/p", schema=1):
        path = os.path.join(tmp, name)
        with open(path, "w") as f:
            json.dump({"schema": schema, "checked": checked, "source": source, "models": models}, f)
        return path

    good = prices_file("good.json")
    projects = os.path.join(tmp, "projects")
    sid = "0f0e0d0c-1111-2222-3333-444455556666"
    base = os.path.join(projects, "-some-repo")
    sub = os.path.join(base, sid, "subagents")
    ts = "2026-11-01T10:00:00Z"
    a1, a2 = "a1111111111111111", "a2222222222222222"
    # Orchestrator, model m-a: 1M input, 1M cache-write (400k at the 1h rate), 2M cache-read, 100k output.
    # = 1*1 + 0.6*2 + 0.4*4 + 2*0.5 + 0.1*10 = 1 + 1.2 + 1.6 + 1 + 1 = 5.80
    write(os.path.join(base, sid + ".jsonl"), [
        entry("o1", ts, u(1000000, 1000000, 2000000, 100000, 400000), False, "m-a"),
        entry("o1", ts, u(1000000, 1000000, 2000000, 100000, 400000), False, "m-a"),  # duplicate id: once
    ])
    # Subagent a1, model m-b, prompt 1,000 tokens (not over 1000): no cache split field, so all 5-minute.
    # 400 in, 300 cw, 300 cr, 1M out: 400*3 + 300*4 + 300*0.3 + 1e6*30 = 1200+1200+90+30,000,000 -> /1e6 = 30.0024
    # Descendant a2, model m-b, long prompt (1,001 tokens): 1 in, 1000 cw (all 1h via split), 0 cr, 0 out
    # long rates: 1*6 + 1000*12 = 12006 -> 0.012006
    write(os.path.join(sub, "agent-%s.jsonl" % a1), [entry("s1", ts, u(400, 300, 300, 1000000), True, "m-b")])
    write(os.path.join(sub, "agent-%s.jsonl" % a2), [entry("s2", ts, u(1, 1000, 0, 0, 1000), True, "m-b")])
    for aid, parent in ((a1, None), (a2, a1)):
        with open(os.path.join(sub, "agent-%s.meta.json" % aid), "w") as f:
            json.dump({"parentAgentId": parent} if parent else {}, f)
    # total = 5.80 + 30.0024 + 0.012006 = 35.814406 -> 35.81

    def call(*args, enabled=lambda: 0, prices=good):
        o, e = io.StringIO(), io.StringIO()
        old = os.environ.pop("CLAUDE_CODE_SESSION_ID", None)
        try:
            rc = run(list(args) + ["--prices", prices, "--projects-dir", projects, "--session", sid,
                                   "--since", "2026-11-01T09:00:00Z", "--until", "2026-11-01T11:00:00Z"],
                     o, e, enabled=enabled, today=TODAY)
        finally:
            if old is not None:
                os.environ["CLAUDE_CODE_SESSION_ID"] = old
        return rc, o.getvalue(), e.getvalue()

    rc, out, err = call("--agent", a1)
    check("per-class, per-model pricing against hand-computed values (descendant, long-prompt tier, 1h split, "
          "duplicate id once)", rc == 0 and out == "est-cost-usd: 35.81 (prices 2026-11-03)\n", repr((rc, out, err)))
    check("stdout is one line; per-model figures on stderr",
          out.count("\n") == 1 and "model m-a 5.80 USD" in err and "model m-b 30.01 USD" in err, err)
    check("per-side model lines for the cost comment (macrodream/blueprint#383)",
          "est-cost: orchestrator model m-a 5.80 USD\n" in err and "est-cost: subagent model m-b 30.01 USD\n" in err, err)
    # Exact decimal arithmetic, exact boundaries.
    t = {"m": {"input": D("0.1"), "cache_write_5m": D(0), "cache_write_1h": D(0), "cache_read": D(0), "output": D(0)}}
    check("decimal arithmetic is exact (3 x 0.1/MTok per 1M tokens)",
          price_rows(t, [((3000000, 0, 0, 0), "m", 0, None)])[0] == D("0.3"))
    check("a half cent rounds up", cents(D("0.005")) == D("0.01") and cents(D("0.0049")) == D("0.00"))
    check("long-prompt threshold is exclusive: exactly over_tokens uses the base rate",
          price_rows(dtable, [((1000, 0, 0, 0), "m-b", 0, None)])[0] == D("0.003")
          and price_rows(dtable, [((1001, 0, 0, 0), "m-b", 0, None)])[0] == D("0.006006"))
    check("an invalid 1h split (more than the write) prices the whole write at the 5-minute rate",
          tu.cache_1h_of({"message": {"usage": {"cache_creation": {"ephemeral_1h_input_tokens": 9}}}}, 5) == 0)
    for name, extra, word in (("fast mode", {"speed": "fast"}, "fast mode"),
                              ("a US-region response", {"inference_geo": "us"}, "non-global inference_geo"),
                              ("a batch service tier", {"service_tier": "batch"}, "non-standard service_tier")):
        fl = os.path.join(tmp, "mod.jsonl")
        write(fl, [entry("x1", ts, dict(u(1, 0, 0, 0), **extra), False, "m-a")])
        with open(fl) as f:
            mrows, _ = tu.measure_rows(f)
        try:
            price_rows(dtable, mrows)
            omitted = False
        except Omit as e:
            omitted = word in str(e)
        check("%s omits the line with a note" % name, omitted, repr(mrows))
    fl = os.path.join(tmp, "mod.jsonl")
    evil = "fast\x1b[31m\nCloses #1"
    write(fl, [entry("x3", ts, dict(u(1, 0, 0, 0), speed=evil), False, "m-a")])
    with open(fl) as f:
        mrows, _ = tu.measure_rows(f)
    try:
        price_rows(dtable, mrows)
        text = ""
    except Omit as e:
        text = str(e)
    check("no transcript text reaches the omission note", text != "" and "\x1b" not in text and "Closes" not in text
          and "\n" not in text, repr(text))
    fl = os.path.join(tmp, "mod.jsonl")
    write(fl, [entry("x2", ts, dict(u(1, 0, 0, 0), speed="standard", inference_geo="global", service_tier="standard"), False, "m-a")])
    with open(fl) as f:
        check("standard speed and global geo still price", price_rows(dtable, tu.measure_rows(f)[0])[0] == D("0.000001"))
    check("a zero-usage message needs no price row", price_rows(dtable, [((0, 0, 0, 0), "<synthetic>", 0, None)])[0] == 0)
    # Omissions: each is exit 1 with no stdout and a note.
    rc, out, err = call("--agent", a1, prices=prices_file("stale.json", checked="2026-08-04"))
    check("stale table (91 days): no line, note says why", rc == 1 and out == "" and "stale" in err and "note: est-cost-usd omitted" in err,
          repr((rc, out, err)))
    rc, out, _ = call("--agent", a1, prices=prices_file("edge.json", checked="2026-08-05"))
    check("a table exactly 90 days old is still fresh", rc == 0 and out.startswith("est-cost-usd: 35.81 (prices 2026-08-05)"), out)
    rc, out, err = call("--agent", a1, prices=prices_file("future.json", checked="2026-11-04"))
    check("a future `checked` date is refused", rc == 1 and out == "" and "future" in err, err)
    rc, out, err = call("--agent", a1, prices=os.path.join(tmp, "nope.json"))
    check("missing table: no line", rc == 1 and out == "" and "missing" in err, err)
    bad = os.path.join(tmp, "bad.json")
    with open(bad, "w") as f:
        f.write("{not json")
    rc, out, _ = call("--agent", a1, prices=bad)
    check("malformed table (not JSON): no line", rc == 1 and out == "", out)
    for name, kw in [("a model row missing a rate", {"models": {"m-a": {"input": 1}, "m-b": table["m-b"]}}),
                     ("a negative rate", {"models": {"m-a": dict(table["m-a"], output=-1), "m-b": table["m-b"]}}),
                     ("a string rate", {"models": {"m-a": dict(table["m-a"], output="10"), "m-b": table["m-b"]}}),
                     ("no source URL", {"source": "example.com"}), ("schema 2", {"schema": 2}),
                     ("bad date", {"checked": "yesterday"})]:
        rc, out, _ = call("--agent", a1, prices=prices_file("m.json", **kw))
        check("malformed table: " + name, rc == 1 and out == "", repr((rc, out)))
    rc, out, err = call("--agent", a1, prices=prices_file("norow.json", models={"m-a": table["m-a"]}))
    check("a model with no price row: no line, names the model", rc == 1 and out == "" and "model m-b has no row" in err, err)
    rc, out, err = call("--agent", "a9999999999999999")
    check("a missing agent file fails closed", rc == 1 and out == "" and "no transcript" in err, repr((rc, out, err)))
    rc, out, _ = call("--agent", a1, "--agent", "a9999999999999999")
    check("one missing agent fails the whole estimate", rc == 1 and out == "", out)
    # Ledger off: exit 3, nothing read (an unreadable price path and a missing agent would otherwise exit 1).
    for state, word in ((1, "off"), (2, "unreadable")):
        rc, out, err = call("--agent", a1, enabled=lambda s=state: s)
        check("ledger %s: exit 3, empty stdout, nothing read" % word, rc == 3 and out == "" and "nothing read" in err, repr((rc, out, err)))
    # Windows: nothing in the orchestrator window, or nothing from the agents, omits the line.
    o, e = io.StringIO(), io.StringIO()
    rc = run(["--agent", a1, "--prices", good, "--projects-dir", projects, "--session", sid, "--since",
              "2027-01-01T00:00:00Z", "--until", "2027-01-02T00:00:00Z"], o, e, enabled=lambda: 0, today=TODAY)
    check("an empty orchestrator window omits the line", rc == 1 and o.getvalue() == "" and "no orchestrator usage" in e.getvalue(), e.getvalue())
    o, e = io.StringIO(), io.StringIO()
    rc = run(["--agent", a1, "--prices", good, "--projects-dir", projects, "--session", sid, "--since",
              "2026-11-01T09:00:00Z", "--until", "2026-11-01T09:30:00Z"], o, e, enabled=lambda: 0, today=TODAY)
    check("no usage before --until omits the line", rc == 1 and o.getvalue() == "", e.getvalue())
    # Orchestrator-only (macrodream/blueprint#386): 5.80 USD, no subagent lines.
    rc, out, err = call("--no-agents")
    check("--no-agents prices the orchestrator alone", rc == 0 and out == "est-cost-usd: 5.80 (prices 2026-11-03)\n", repr((rc, out, err)))
    check("--no-agents is labeled orchestrator-only; per-side lines carry no subagent side",
          "orchestrator-only" in err and "est-cost: orchestrator model m-a 5.80 USD\n" in err
          and "est-cost: subagent" not in err and "est-cost: model m-a 5.80 USD\n" in err, err)
    rc, out, _ = call("--no-agents", "--agent", a1)
    check("--no-agents with --agent is a usage error", rc == 2 and out == "", repr((rc, out)))
    rc, out, _ = call("--no-agents", enabled=lambda: 1)
    check("--no-agents asks the ledger setting first (exit 3)", rc == 3 and out == "", repr((rc, out)))
    o, e = io.StringIO(), io.StringIO()
    rc = run(["--no-agents", "--prices", good, "--projects-dir", projects, "--session", sid, "--since",
              "2027-01-01T00:00:00Z", "--until", "2027-01-02T00:00:00Z"], o, e, enabled=lambda: 0, today=TODAY)
    check("--no-agents with no orchestrator usage prints no line and exits 1, never 0",
          rc == 1 and o.getvalue() == "" and "no orchestrator usage" in e.getvalue(), repr((rc, e.getvalue())))
    rc, out, err = call("--no-agents", prices=prices_file("norow2.json", models={"m-b": table["m-b"]}))
    check("--no-agents still omits on a model with no row", rc == 1 and out == "" and "model m-a has no row" in err, err)
    # Neither --agent nor --no-agents, with valid times: exit 2 (a forgotten --agent is never a zero).
    o, e = io.StringIO(), io.StringIO()
    rc = run(["--prices", good, "--projects-dir", projects, "--session", sid, "--since",
              "2026-11-01T09:00:00Z", "--until", "2026-11-01T11:00:00Z"], o, e, enabled=lambda: 0, today=TODAY)
    check("neither --agent nor --no-agents (valid times) exits 2", rc == 2 and o.getvalue() == "", repr((rc, o.getvalue(), e.getvalue())))
    # A session that never spawned a subagent has no subagents/ directory: --no-agents still prices.
    sid2 = "1a1b1c1d-1111-2222-3333-444455556666"
    write(os.path.join(base, sid2 + ".jsonl"), [entry("n1", ts, u(1000000, 0, 0, 0), False, "m-a")])
    o, e = io.StringIO(), io.StringIO()
    rc = run(["--no-agents", "--prices", good, "--projects-dir", projects, "--session", sid2, "--since",
              "2026-11-01T09:00:00Z", "--until", "2026-11-01T11:00:00Z"], o, e, enabled=lambda: 0, today=TODAY)
    check("--no-agents prices a session with no subagents/ directory",
          rc == 0 and o.getvalue() == "est-cost-usd: 1.00 (prices 2026-11-03)\n", repr((rc, o.getvalue(), e.getvalue())))
    # Usage errors and the traversal guard.
    for name, args in [("path-like agent id", ["--agent", "../../etc/passwd"]), ("no agent", []),
                       ("unknown flag", ["--agent", a1, "--bogus", "x"]), ("naive --since", ["--agent", a1, "--since", "2026-11-01T10:00:00"]),
                       ("missing value", ["--agent", a1, "--prices"]), ("bad --today", ["--agent", a1, "--today", "2026-13-40"]),
                       ("prices outside the allowed roots", ["--agent", a1, "--prices", "/etc/hosts", "--session", sid,
                                                             "--since", "2026-11-01T00:00:00Z", "--until", "2026-11-02T00:00:00Z"]),
                       ("projects dir outside the allowed roots", ["--agent", a1, "--projects-dir", "/etc", "--session", sid,
                                                                   "--since", "2026-11-01T00:00:00Z", "--until", "2026-11-02T00:00:00Z"])]:
        o, e = io.StringIO(), io.StringIO()
        rc = run(args, o, e, enabled=lambda: 0, today=TODAY)
        check("exit 2: " + name, rc == 2 and o.getvalue() == "", repr((rc, o.getvalue())))
    check("the default gate asks scripts/cost-ledger", ledger_enabled() in (0, 1, 2))
    # The shipped table must itself load, with every model this repo's transcripts name.
    try:
        shipped, _ = load_prices(DEFAULT_PRICES, datetime.date.fromisoformat(json.load(open(DEFAULT_PRICES))["checked"]))
        have = all(m in shipped for m in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"))
    except (Omit, OSError, ValueError):
        have = False
    check("the shipped .claude/model-prices.json is well formed and covers the repo's models", have)


def main(argv):
    if argv[:1] == ["--self-test"]:
        return self_test()
    return run(argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
