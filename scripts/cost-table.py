#!/usr/bin/env python3
"""scripts/cost-table.py - render an MR's cost as numbered `## Cost of this MR` comments.

Ported from Blueprint (macrodream/blueprint#383, macrodream/blueprint#384,
macrodream/blueprint#386) for #2128; docs/development/cost-ledger.md is the contract.

Why this exists. `/mr` and `/wave` write the cost ledger as bare lines at the end of `## Gates`
(`subagent-tokens:`, `orchestrator-tokens:`, `est-cost-usd:`); GitLab renders them run together
as one paragraph, so a person reading a merged MR could not read the tokens or the cost
(macrodream/blueprint#381). This renders the figures as an MR comment with a Sonnet vs Opus split
(macrodream/blueprint#383). The comment is the only human-readable cost table: there is no
`## Cost` section in the description any more (macrodream/blueprint#384). The ledger lines stay
where they are, and `scripts/cost_ledger_lines.py` and `/kaizen` (`scripts/kaizen_gate_ledger.py`)
keep reading them. The comments are also a source (#2154): `/kaizen` sums an MR's windowed records
for its per-MR cost, because the description's lines are a go-ahead snapshot that overlaps across a wave.

Records (macrodream/blueprint#384). Record 1 is the comment `/wave` posts once the MR is open,
from the description's ledger lines; its heading is `## Cost of this MR (#N)`, so a comment posted
before records existed counts as record 1. Work on the MR after that (a fix round, a `/fix-mr`
pass, a re-measure) gets a NEW comment, `## Cost of this MR (#N) — record K`, covering only its
own window, from the measuring scripts' own stdout lines for that window (`--ledger F`), and a
running-total row across records 1..K. An earlier record is never edited: a re-run for the same
window updates that window's own record (the latest one), and a different window posts a new one.

Untrusted input. Earlier records are read back from the MR's notes, which anyone who can comment
can write. On the posting paths (--post, --next-since) only notes authored by the token's own user (`glab api user`) are read at all; readers (scripts/kaizen_gate_ledger.py) may also trust the MR author (`also_trusted`, #2154). Each must
carry the generated heading and footer and parse strictly (fixed regexes, ASCII digits, a size
cap), or the running total reads `n/a (<reason>)`, never 0 and never a guess. No note text is ever
echoed: every reason is fixed text plus integers, so a hostile note cannot put text into the
comment this script posts with the user's token.

The ledger lines are found with scripts/cost_ledger_lines.py's reader (`ledger_lines` and its
regexes), so the format has one parser. Only the `## Gates` section is read, outside code fences,
with HTML comments stripped, exactly as that checker reads it.

Governed by the cost-ledger setting (macrodream/blueprint#348,
docs/development/cost-ledger.md), with no toggle of its own: when `scripts/cost-ledger enabled`
says off (exit 1) or unreadable (exit 2, or anything else), or the description (or the ledger
file) carries the `cost-ledger: off` marker, there is no record.

Usage:
  python3 scripts/cost-table.py --comment --file <description.md> [--issue N] [--until T] [--split F]
        [--post --mr <iid>]
        record 1, from the description's ledger lines. Without --post it prints the body.
  python3 scripts/cost-table.py --comment --ledger <lines.txt> --since T --until T --mr <iid>
        [--issue N] [--split F] [--post]
        a follow-up record for the window T..T, from the measuring scripts' stdout lines in
        <lines.txt>; reads the earlier records from !iid for its number and running total, and
        prints the body (with --post, creates it, or updates the latest record when its window is
        this one).
  python3 scripts/cost-table.py --next-since --mr <iid>
        print the latest record's window end, the next record's `--since` (exit 1 if none).
  python3 scripts/cost-table.py --self-test
  `--split F` is a file holding the stderr of subagent-tokens.py, orchestrator-tokens.py and
  est-cost.py; only their `model` lines are read, and without it the per-model cells read `n/a`.
  `--other-sessions S:A:T` (record 1 and record K; scripts/post-mr-cost.py passes it,
  macrodream/blueprint#389) says the Subagents row includes A subagents from S other sessions,
  whose orchestrators had T tokens no record has claimed yet; it adds one fixed-text line (none
  when A is 0). Three non-negative integers, nothing else.
  Times are ISO 8601 with a zone.

Exit: 0 rendered (printed, or posted) - 1 no `## Gates` section (or, for --next-since, no
      readable record) - 2 usage or unreadable file - 3 ledger off or unreadable, no record -
      4 could not reach, read or update the MR's notes - 5 refused: the window belongs to an
      earlier record, which is never edited
"""
import datetime
import decimal
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import cost_ledger_lines as cl  # noqa: E402
from _paths import PathEscapeError, resolve_within  # noqa: E402

MAX_DIGITS = 18
MAX_NOTE = 32 << 10       # a generated record is about 2 KB; anything bigger is not one
MAX_LEDGER_FILE = 64 << 10
PRICES_RE = re.compile(r"\(prices\s+(\d{4}-\d{2}-\d{2})\)")


strip_comments = cl.strip_comments


def _load_kaizen():
    """scripts/kaizen_gate_ledger.py, for the self-test's cross-reader check only."""
    import kaizen_gate_ledger
    return kaizen_gate_ledger


def ledger_enabled():
    """scripts/cost-ledger enabled: 0 on, 1 off, 2 unreadable (anything else counts as unreadable)."""
    try:
        return subprocess.run([sys.executable, os.path.join(HERE, "cost-ledger"), "enabled"],
                              capture_output=True, timeout=30).returncode
    except (OSError, subprocess.SubprocessError):
        return 2


NONE_RECORDED = "none recorded; measured only under /wave, where `## Notes` says why"
COST_KEYS = ("subagent-tokens", "orchestrator-tokens", "est-cost-usd")


def _one(lines, key, rx, none=False):
    """(match, None) for exactly one well-formed `<key>:` line, else (None, reason). `none` means
    the description holds no cost line at all (a plain /mr, which never holds the figures)."""
    keyed = []
    for line in lines:
        m = cl.COSTISH_RE.match(line)
        if m and m.group(1).lower() == key:
            keyed.append(line)
    if not keyed and none:
        return None, NONE_RECORDED
    if not keyed:
        return None, "no `%s:` line in `## Gates`; see `## Notes`" % key
    if len(keyed) > 1:
        return None, "more than one `%s:` line in `## Gates`" % key
    m = rx.match(keyed[0])
    # ASCII digits of a sane length only: Python's \d also matches other scripts' digits, and
    # int() refuses more than 4300 of them (a traceback, not an n/a cell).
    if not m or not m.group(0).isascii() or len(m.group(1)) > MAX_DIGITS:
        return None, "malformed `%s:` line in `## Gates`" % key
    return m, None


def _unfenced(lines):
    in_fence = False
    for line in lines:
        if cl.FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield line


def figures(body):
    """{'off': bool, 'gates': bool, 'subagent'/'orchestrator'/'total'/'usd': (value, reason)}."""
    body = strip_comments(body or "")
    lines = list(cl.ledger_lines(body))
    has_gates = any(cl.HEADING_RE.match(ln) and cl.heading_title(cl.HEADING_RE.match(ln)) == "gates"
                    for ln in _unfenced(body.splitlines()))
    out = {"off": any(cl.LEDGER_OFF_RE.match(ln) for ln in lines), "gates": has_gates}
    none = not any(cl.COSTISH_RE.match(ln) and cl.COSTISH_RE.match(ln).group(1).lower() in COST_KEYS
                   for ln in lines)
    sub, sr = _one(lines, "subagent-tokens", cl.SUBAGENT_TOKENS_RE, none)
    orch, orr = _one(lines, "orchestrator-tokens", cl.ORCH_TOKENS_RE, none)
    out["subagent"] = (int(sub.group(1)), None) if sub else (None, sr)
    out["orchestrator"] = (int(orch.group(1)), None) if orch else (None, orr)
    if sub and orch:
        out["total"] = (out["subagent"][0] + out["orchestrator"][0], None)
    else:
        out["total"] = (None, NONE_RECORDED if none else "needs both the `subagent-tokens:` and `orchestrator-tokens:` lines")
    est, er = _one(lines, "est-cost-usd", cl.EST_COST_RE, none)
    if est:
        p = PRICES_RE.search(est.group(0))
        out["usd"] = ((est.group(1), p.group(1) if p else None), None)
    else:
        out["usd"] = (None, er)
    return out


def _cell(fig, fmt):
    value, reason = fig
    return "n/a (%s)" % reason if value is None else fmt(value)


def gate(body, enabled):
    """(exit code, stderr message): 0 when a record may be rendered from body."""
    f = figures(body)
    rc = enabled()
    if rc != 0:
        return 3, "cost-table: cost ledger %s; no cost comment" % ("off" if rc == 1 else "setting unreadable")
    if f["off"]:
        return 3, "cost-table: the ledger lines carry `cost-ledger: off`; no cost comment"
    if not f["gates"]:
        return 1, "cost-table: no `## Gates` section; nothing to render"
    return 0, ""


# --- the comment (macrodream/blueprint#383, records macrodream/blueprint#384) -----------------

COMMENT_HEADING = "## Cost of this MR"
DASH = "—"
SPLIT_MODEL = r"([0-9A-Za-z][0-9A-Za-z._:-]{0,63})"  # transcript_usage.MODEL_RE
SPLIT_TOKENS_RE = re.compile(r"^(subagent|orchestrator)-tokens: model " + SPLIT_MODEL + r" (\d{1,%d})$" % MAX_DIGITS)
SPLIT_USD_RE = re.compile(r"^est-cost: (subagent|orchestrator) model " + SPLIT_MODEL + r" (\d{1,%d}\.\d{2}) USD$" % MAX_DIGITS)
SIDES = ("subagent", "orchestrator")
NO_SPLIT = "no per-model split recorded; see `## Notes`"
NO_USD = "no estimate for this model; see `## Notes`"
FOOTER_1 = ("_Generated by `scripts/cost-table.py --comment` from the `## Gates` ledger lines and the per-model split; "
            "never typed by hand._")
FOOTER_K = ("_Generated by `scripts/cost-table.py --comment` from the measuring scripts' lines for this window and the "
            "per-model split; never typed by hand._")
TS = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"
TS_FMT = "%Y-%m-%dT%H:%M:%SZ"
HEAD_RE = re.compile(r"^## Cost of this MR(?: \(#[0-9]{1,9}\))?(?: " + DASH + r" record ([0-9]{1,4}))?$")
HEADER_RE = re.compile(r"^\| \| ((?:(?:Sonnet|Opus|Other) tokens \| (?:Sonnet|Opus|Other) est\. cost \| ){2,3})"
                       r"Total tokens \| Est\. cost \|$")
HEADER_COMPACT_RE = re.compile(r"^\| \| Tokens \| Est\. cost \|$")
HEADER_FAM_RE = re.compile(r"(Sonnet|Opus|Other) tokens \| (Sonnet|Opus|Other) est\. cost \| ")
TOTAL_ROW_RE = re.compile(r"^\| \*\*Total\*\* \| (.{1,4000}) \|$")
CELL_RE = re.compile(r"^\*\*(.{1,400})\*\*$")
TOK_CELL_RE = re.compile(r"^[0-9]{1,3}(?:,[0-9]{3}){0,5}$")
USD_CELL_RE = re.compile(r"^([0-9]{1,18}(?:\.[0-9]{1,18})?) USD$")
NA_CELL_RE = re.compile(r"^n/a \([ -)+-{}~]{1,300}\)$")  # printable ASCII without `*` or `|`
END1_RE = re.compile(r"^- Window end: (?:(" + TS + r")|n/a \([ -{}~]{1,300}\))\. ")
WINK_RE = re.compile(r"^- Window: (" + TS + r") to (" + TS + r")\. ")
CENT = decimal.Decimal("0.01")


def family(model):
    m = model.lower()
    return "Sonnet" if "sonnet" in m else "Opus" if "opus" in m else "Other"


def parse_split(text):
    """{'tokens': {side: {family: int}}, 'usd': {side: {family: Decimal}}} from the stderr of the
    three measuring scripts. Only the exact `model` lines are read; every other line (a skip count,
    a note, anything a transcript could have influenced) is ignored."""
    out = {"tokens": {}, "usd": {}}
    for line in (text or "").splitlines():
        line = line.strip()
        m = SPLIT_TOKENS_RE.match(line)
        if m and m.group(3).isascii():
            d = out["tokens"].setdefault(m.group(1), {})
            d[family(m.group(2))] = d.get(family(m.group(2)), 0) + int(m.group(3))
            continue
        m = SPLIT_USD_RE.match(line)
        if m and m.group(3).isascii():
            d = out["usd"].setdefault(m.group(1), {})
            d[family(m.group(2))] = d.get(family(m.group(2)), decimal.Decimal(0)) + decimal.Decimal(m.group(3))
    return out


def window_end(until):
    """(text, reason): the time as fixed-format UTC, or n/a with a reason."""
    sys.path.insert(0, os.path.join(HERE, "lib"))
    import transcript_usage as tu
    t = tu.parse_time(until) if until else None
    if t is None:
        return None, "no valid `--until` given" if until else "no window end given"
    return t.astimezone(datetime.timezone.utc).strftime(TS_FMT), None


def _valid_ts(text):
    try:
        datetime.datetime.strptime(text, TS_FMT)
        return True
    except ValueError:
        return False


NOT_WINDOWED = ("- This record has no complete window (no start or no end): its orchestrator row is not windowed, so it overlaps other MRs of the "
                "same session and must not be compared with or added to another MR's cost.")
FIRST_RECORD = ("- This is the session's first record, so the orchestrator row starts at the session's start and "
                "includes work done before this MR's issue.")
OTHERS_RE = re.compile(r"^(\d{1,6}):(\d{1,6}):(\d{1,%d})\Z" % MAX_DIGITS)


def others_line(others):
    """The fixed-text line for subagents claimed from other sessions (macrodream/blueprint#389), or None.
    `others` is (sessions, agents, unclaimed orchestrator tokens of those sessions), integers only: no
    session id, path or transcript text reaches the comment."""
    if not others or not others[1]:
        return None
    s, a, t = others
    return ("- Other sessions: the Subagents row includes %d subagent%s from %d other session%s, counted because %s "
            "in this MR's worktree. Those sessions' orchestrator spend is not in this record: %s tokens of it are in "
            "no record yet." % (a, "" if a == 1 else "s", s, "" if s == 1 else "s",
                                "it worked" if a == 1 else "they worked", "{:,}".format(t)))


# What the window sentence adds when the Subagents row holds other sessions' subagents: each of them is
# counted over ITS OWN session's watermark, so its usage can be from before this record's window.
OTHERS_WINDOW = ", plus other sessions' subagents' work on this branch since their own previous record, which can be from before the window"


def _render(body, issue, until, split_text, record=1, since=None, prior=None, session_start=False, others=None):
    """(lines, own total) of one record. Own total is {column: value or None} for its **Total** row,
    the figures the next record's running total adds up; columns are (kind, family or 'all')."""
    f = figures(body)
    sp = parse_split(split_text)
    n = "{:,}".format
    prior = prior or {}
    # A window with no subagent (macrodream/blueprint#386): `subagent-tokens.py --no-agents` printed a
    # measured `subagent-tokens: 0` and est-cost.py --no-agents printed no subagent model lines. The
    # side is then present and empty, so each family reads `none used` and the side totals 0 / 0.00 USD,
    # not n/a; the split-sum checks below compare 0 with 0. A split that does carry subagent lines is
    # left as it is, so a wrong 0 beside real subagent figures still trips the mismatch note.
    if f["subagent"][0] == 0 and "subagent" not in sp["tokens"] and "subagent" not in sp["usd"]:
        sp["tokens"]["subagent"], sp["usd"]["subagent"] = {}, {}
    # No per-model split at all (neither side has a family): a compact Tokens / Est. cost table,
    # not a per-family table whose every cell reads `n/a` (macrodream/blueprint#387).
    compact = not any(sp["tokens"].get(sd) for sd in SIDES)
    fams = [] if compact else ["Sonnet", "Opus"]
    # `Other` appears only when some model outside Sonnet and Opus actually used tokens: an empty
    # column of `n/a` cells is noise (a zero-usage `<synthetic>` row used to create one).
    if not compact and (any(sp["tokens"].get(sd, {}).get("Other", 0) > 0 for sd in SIDES)
                        or any((p["total"].get(("tok", "Other")) or 0) > 0 for p in prior.get("records", []))):
        fams.append("Other")

    def tok(side, fam):
        if side not in sp["tokens"]:
            return "n/a (%s)" % NO_SPLIT
        v = sp["tokens"][side].get(fam)
        return n(v) if v is not None else "none used"

    def usd(side, fam):
        if side not in sp["tokens"]:
            return "n/a (%s)" % NO_SPLIT
        if fam not in sp["tokens"][side]:
            return "none used"
        v = sp["usd"].get(side, {}).get(fam)
        return "%s USD" % v.quantize(CENT) if v is not None else "n/a (%s)" % NO_USD

    def side_usd(side):
        got = [usd(side, fm) for fm in fams]
        if side not in sp["tokens"] or any(g.startswith("n/a") for g in got):
            return "n/a (%s)" % (NO_SPLIT if side not in sp["tokens"] else NO_USD)
        total = sum((sp["usd"][side].get(fm, decimal.Decimal(0)) for fm in fams), decimal.Decimal(0))
        return "%s USD" % total.quantize(CENT)

    rows = []
    for label, key, side in (("Subagents", "subagent", "subagent"), ("Orchestrator", "orchestrator", "orchestrator")):
        cells = []
        for fm in fams:
            cells += [tok(side, fm), usd(side, fm)]
        if compact:
            # A side's cost needs the split; only a measured 0 (--no-agents) has a known cost.
            cells += [_cell(f[key], n), "0.00 USD" if f[key][0] == 0 else "-"]
        else:
            cells += [_cell(f[key], n), side_usd(side)]
        rows.append("| %s | %s |" % (label, " | ".join(cells)))
    tcells, own = [], {}
    for fm in fams:
        ta = sp["tokens"].get("subagent", {}).get(fm, 0)
        tb = sp["tokens"].get("orchestrator", {}).get(fm, 0)
        both = "subagent" in sp["tokens"] and "orchestrator" in sp["tokens"]
        ua, ub = sp["usd"].get("subagent", {}).get(fm), sp["usd"].get("orchestrator", {}).get(fm)
        priced = both and all((fm not in sp["tokens"][s]) or sp["usd"].get(s, {}).get(fm) is not None for s in SIDES)
        own[("tok", fm)] = ta + tb if both else None
        own[("usd", fm)] = ((ua or decimal.Decimal(0)) + (ub or decimal.Decimal(0))).quantize(CENT) if priced else None
        tcells.append(n(ta + tb) if both else "n/a (%s)" % NO_SPLIT)
        tcells.append("%s USD" % own[("usd", fm)] if priced else "n/a (%s)" % (NO_USD if both else NO_SPLIT))
    own[("tok", "all")] = f["total"][0]
    own[("usd", "all")] = decimal.Decimal(f["usd"][0][0]) if f["usd"][0] else None
    tcells += [_cell(f["total"], n), _cell(f["usd"], lambda v: "%s USD" % v[0])]
    rows.append("| **Total** | %s |" % " | ".join("**%s**" % c for c in tcells))
    running = None
    if record > 1:
        running = _running(own, fams, prior)
        rows.append("| **Running total, records 1-%d** | %s |" % (record, " | ".join("**%s**" % c for c in running[0])))
    sep = "|" + "---|" * (len(fams) * 2 + 3)
    heading = COMMENT_HEADING + (" (#%d)" % issue if issue else "") + (" %s record %d" % (DASH, record) if record > 1 else "")
    end, why = window_end(until)
    prices = f["usd"][0][1] if f["usd"][0] and f["usd"][0][1] else None
    out = [heading, "",
           "| | Tokens | Est. cost |" if compact else
           "| | " + " | ".join("%s tokens | %s est. cost" % (fm, fm) for fm in fams) + " | Total tokens | Est. cost |",
           sep] + rows + [""]
    if compact:
        out.append("- No per-model split was recorded for this record, so the Sonnet and Opus breakdown and each row's cost "
                   "are not shown; the Total row is the record.")
    for side, key in (("subagent", "subagent"), ("orchestrator", "orchestrator")):
        if side in sp["tokens"] and f[key][0] is not None and sum(sp["tokens"][side].values()) != f[key][0]:
            out.append("- The %s model split sums to %s tokens, not the ledger line's %s; the `%s-tokens:` line is the record."
                       % (side, n(sum(sp["tokens"][side].values())), n(f[key][0]), side))
    # Same check for the estimate: per-side USD from the split against the ledger's total.
    if f["usd"][0] and all(sd in sp["usd"] for sd in SIDES):
        got = sum((v for sd in SIDES for v in sp["usd"][sd].values()), decimal.Decimal(0))
        # est-cost.py rounds each per-model figure to cents and the total once, so the parts may drift one cent each.
        parts = sum(len(sp["usd"][sd]) for sd in SIDES)
        if abs(got - decimal.Decimal(f["usd"][0][0])) > CENT * parts:
            out.append("- The model split sums to %s USD, not the ledger line's %s USD; the `est-cost-usd:` line is the record."
                       % (got.quantize(CENT), f["usd"][0][0]))
    out.append("- Costs are estimates at list prices from `.claude/model-prices.json` (%s), not billed amounts; a model with no price row shows `n/a`."
               % ("prices %s" % prices if prices else "no price date on the ledger line"))
    if record == 1 and since is not None and end:
        # The record's actual window (macrodream/blueprint#387): it is posted by the hook or --retry after the
        # MR opened, not at the go-ahead. The parser reads this line back up to the first `. ` (WINK_RE).
        if others_line(others):
            out.append("- Window: %s to %s. This record counts the session's work in this window%s; later work on this MR "
                       "goes in later records." % (since, end, OTHERS_WINDOW))
        else:
            out.append("- Window: %s to %s. This record counts only the session's work in this window; later work on this MR "
                       "goes in later records." % (since, end))
    elif record == 1:
        # The parser reads this line back up to the first `. ` (END1_RE): keep that prefix stable.
        out.append("- Window end: %s. Both figures stop at the go-ahead to push; later work on this MR goes in later records."
                   % (end if end else "n/a (%s)" % why))
        # #2154: with no complete window (no --since, or --since without a valid --until) the orchestrator
        # row is not windowed: with no start it runs from the session's start, so it overlaps the other MRs
        # of the same session. The cost readers (scripts/kaizen_gate_ledger.py) exclude such a record; this
        # line tells a person reading it the same. post-mr-cost.py always passes --since and --until, so
        # only a hand-run `cost-table.py --comment --file` without --since, or with --since but no valid
        # --until, reaches this branch.
        out.append(NOT_WINDOWED)
    else:
        if others_line(others):
            out.append("- Window: %s to %s. This record counts the work in this window%s; the running-total row adds the "
                       "earlier records." % (since, end, OTHERS_WINDOW))
        else:
            out.append("- Window: %s to %s. This record counts only the work in this window; the running-total row adds the earlier records."
                       % (since, end))
        for g0, g1 in prior.get("gaps") or []:
            out.append("- This MR has no record for %s to %s; the session's work in that stretch is in another MR's record from "
                       "the same session, or in none." % (g0, g1))
        out.append("- Running total: %s." % ("the last row, records 1-%d" % record if running[1] is None else "n/a (%s)" % running[1]))
    if session_start:
        out.append(FIRST_RECORD)
    if others_line(others):
        out.append(others_line(others))
    if prior.get("foreign"):
        out.append("- %d note(s) with this heading by another user were not read." % prior["foreign"])
    # Visiban's /wave has no per-agent budget, so it writes no `budget-exceeded:` line; the bullet
    # appears only on a record 1 whose `## Gates` carries a well-formed one (upstream's /wave writes
    # it). A record K never states it: no lines file carries one.
    b = cl.budget_exceeded(body or "") if record == 1 else None
    if b:
        roles = ", ".join("%s %d" % (r, k) for r, k in sorted(b[1].items()))
        out.append("- Agents over their /wave budget (`budget-exceeded:`): %d%s." % (b[0], " (%s)" % roles if roles else ""))
    # Exactly the condition of the `Window:` line above: a record 1 with a start but no end is not windowed either.
    if record > 1 or (since is not None and end):
        out.append("- Records do not overlap: the orchestrator row is this session's spend since its previous cost record, across "
                   "every branch it worked, and each subagent is counted only for usage after its previous record. "
                   "Records add up across sessions; nothing is counted twice.")
    out += ["", FOOTER_1 if record == 1 else FOOTER_K]
    return out, own


def _running(own, fams, prior):
    """(cells, reason): the running-total cells for records 1..K, or all n/a and the reason."""
    if prior.get("reason"):
        return ["n/a (see the running-total line)"] * (len(fams) * 2 + 2), prior["reason"]
    cols = [(k, fm) for fm in fams for k in ("tok", "usd")] + [("tok", "all"), ("usd", "all")]
    cells = []
    for col in cols:
        vals = [own.get(col)]
        for p in prior["records"]:
            if col[1] != "all" and not p["fams"]:
                # A compact record (no per-model split) has no family figures: n/a, not 0.
                vals.append(None)
                continue
            # A family column a record does not show was not used in it (only `Other` comes and goes).
            vals.append(p["total"][col] if col in p["total"] else 0)
        if any(v is None for v in vals):
            cells.append("n/a (a record has no figure in this column)")
        elif col[0] == "tok":
            cells.append("{:,}".format(sum(vals)))
        else:
            cells.append("%s USD" % sum((decimal.Decimal(v) for v in vals), decimal.Decimal(0)).quantize(CENT))
    return cells, None


def comment_lines(body, issue=None, until=None, split_text=None, record=1, since=None, prior=None, session_start=False,
                  others=None):
    """The comment as a list of lines."""
    return _render(body, issue, until, split_text, record, since, prior, session_start, others)[0]


# --- reading earlier records back (untrusted note text) --------------------------------------

def head_number(body):
    """The record number in a note's first line (1 for the bare heading), or None."""
    first = body.split("\n", 1)[0].rstrip("\r")
    m = HEAD_RE.match(first)
    if not m:
        return None
    return int(m.group(1)) if m.group(1) else 1


def parse_record(body):
    """{'k', 'start', 'end', 'fams', 'total'} for a strictly formatted record, else None. Reads only
    the heading, the header row, the **Total** row, the window line and the footer; every other
    line is ignored, and nothing is returned that a regex did not fix the shape of."""
    if not isinstance(body, str) or len(body) > MAX_NOTE:
        return None
    lines = [ln.rstrip("\r") for ln in body.split("\n")]
    k = head_number(body)
    if k is None or k == 0 or (k == 1 and DASH in lines[0]):
        return None
    while lines and lines[-1] == "":
        lines.pop()
    if not lines or lines[-1] != (FOOTER_1 if k == 1 else FOOTER_K):
        return None
    if not "".join(lines[1:]).isascii():
        return None
    headers = [m for m in map(HEADER_RE.match, lines) if m]
    compact = [l for l in lines if HEADER_COMPACT_RE.match(l)]
    totals = [m for m in map(TOTAL_ROW_RE.match, lines) if m]
    wins = [m for m in map(WINK_RE.match, lines) if m]
    if k == 1:
        # Record 1 states either `Window end: X.` (posted at the go-ahead) or `Window: S to U.` (macrodream/blueprint#387).
        wins += [m for m in map(END1_RE.match, lines) if m]
    if len(headers) + len(compact) != 1 or len(totals) != 1 or len(wins) != 1:
        return None
    if compact:
        fams = []  # a record rendered without a per-model split: only the all-column Total
    else:
        fams = [a for a, b in HEADER_FAM_RE.findall(headers[0].group(1) + "") if a == b]
        if (len(fams) * 2 != headers[0].group(1).count(" | ") or fams[:2] != ["Sonnet", "Opus"]
                or fams[2:] not in ([], ["Other"])):
            return None
    cells = totals[0].group(1).split(" | ")
    if len(cells) != len(fams) * 2 + 2:
        return None
    cols = [(kd, fm) for fm in fams for kd in ("tok", "usd")] + [("tok", "all"), ("usd", "all")]
    total = {}
    for col, cell in zip(cols, cells):
        m = CELL_RE.match(cell)
        if not m:
            return None
        v = m.group(1)
        if NA_CELL_RE.match(v):
            total[col] = None
        elif col[0] == "tok" and TOK_CELL_RE.match(v):
            total[col] = int(v.replace(",", ""))
        elif col[0] == "usd" and USD_CELL_RE.match(v):
            total[col] = decimal.Decimal(USD_CELL_RE.match(v).group(1))
        else:
            return None
    if k == 1 and wins[0].re is END1_RE:
        start, end = None, wins[0].group(1)
    else:
        start, end = wins[0].group(1), wins[0].group(2)
        if not (_valid_ts(start) and _valid_ts(end)) or start > end:
            return None
    if end is not None and not _valid_ts(end):
        return None
    return {"k": k, "start": start, "end": end, "fams": fams, "total": total}


PROJECT_RE = re.compile(r"^[0-9A-Za-z_.-]+(?:/[0-9A-Za-z_.-]+)+\Z")
PROJECT = {"path": None}


def scope_path(path, project):
    """`projects/:id/...` with :id replaced by the URL-encoded project path, so a call never resolves
    `:id` against whatever repo the process happens to run in (macrodream/blueprint#387)."""
    if not project:
        return path
    return path.replace("projects/:id/", "projects/%s/" % urllib.parse.quote(project, safe=""), 1)


def glab_api(method, path, payload=None):
    """(returncode, stdout) of one `glab api` call; the JSON payload goes through stdin. `path` is
    built only from constants and integers (the iid, a note id, a page number) and the URL-encoded
    project path, never from text."""
    glab = shutil.which("glab")
    if glab is None:
        return 1, ""
    cmd = [glab, "api", "-X", method, scope_path(path, PROJECT["path"])]
    data = None
    if payload is not None:
        cmd += ["--input", "-", "-H", "Content-Type: application/json"]
        data = json.dumps(payload).encode("utf-8")
    try:
        r = subprocess.run(cmd, input=data, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return 1, ""
    return r.returncode, r.stdout.decode("utf-8", errors="replace")


def _me(api):
    """The token's own user id, or None."""
    rc, text = api("GET", "user")
    try:
        d = json.loads(text) if rc == 0 else None
    except ValueError:
        return None
    uid = d.get("id") if isinstance(d, dict) else None
    return uid if isinstance(uid, int) and not isinstance(uid, bool) else None


def own_records(notes, me, also_trusted=()):
    """(own records, foreign count) from a page of GitLab note objects: the notes with the comment
    heading by user `me` (or by a user id in `also_trusted`), as {'id', 'k', 'rec'}, oldest first; the
    same notes by anyone else are counted, never read. `also_trusted` is for the readers
    (scripts/kaizen_gate_ledger.py passes the MR's author, #2154); the posting paths pass nothing, so
    what they read and refuse to edit is unchanged."""
    trusted = {me, *also_trusted}
    own, foreign = [], 0
    for note in notes:
        if not (isinstance(note, dict) and not note.get("system") and isinstance(note.get("id"), int)
                and isinstance(note.get("body"), str) and note["body"].lstrip().startswith(COMMENT_HEADING)):
            continue
        author = note.get("author")
        aid = author.get("id") if isinstance(author, dict) else None
        if not isinstance(aid, int) or isinstance(aid, bool) or aid not in trusted:
            foreign += 1
            continue
        own.append({"id": note["id"], "k": head_number(note["body"]), "rec": parse_record(note["body"])})
    return own, foreign


def read_records(iid, api, max_pages=20, also_trusted=()):
    """(records, foreign count, error message): records are this user's notes with the comment
    heading, as {'id', 'k' (heading number or None), 'rec' (parse_record or None)}, oldest first.
    Notes by anyone else are counted, never read."""
    me = _me(api)
    if me is None:
        return None, 0, "cost-table: could not read the token's own user (`glab api user`)"
    base = "projects/:id/merge_requests/%d/notes" % iid
    own, foreign = [], 0
    for page in range(1, max_pages + 1):
        rc, text = api("GET", "%s?per_page=100&page=%d&sort=asc&order_by=created_at" % (base, page))
        try:
            notes = json.loads(text) if rc == 0 else None
        except ValueError:
            notes = None
        if not isinstance(notes, list):
            return None, 0, "cost-table: could not list the notes of !%d" % iid
        got, skipped = own_records(notes, me, also_trusted)
        own += got
        foreign += skipped
        if len(notes) < 100:
            return own, foreign, None
    return None, 0, "cost-table: !%d has more than %d notes; not read" % (iid, max_pages * 100)


def plan_followup(own, foreign, since, until):
    """(exit code, message, note id to PUT or None, record number K, prior) for a follow-up record."""
    top = max([o["k"] or 0 for o in own] or [0])
    tops = [o for o in own if (o["k"] or 0) == top]
    # Two notes with the latest number: neither is updated (their window is refused; a new window
    # posts a new record with the total n/a).
    latest = tops[0] if len(tops) == 1 else None
    if latest and latest["rec"] and latest["k"] > 1 and (latest["rec"]["start"], latest["rec"]["end"]) == (since, until):
        target, k = latest["id"], latest["k"]
    elif any(o["rec"] and o["k"] > 1 and (o["rec"]["start"], o["rec"]["end"]) == (since, until) for o in own):
        return 5, "cost-table: this window is an earlier record's; earlier records are never edited", None, 0, None
    else:
        target = None
        k = max(max([o["k"] or 0 for o in own] or [0]), len(own)) + 1
        k = max(k, 2)
    earlier = [o for o in own if o["id"] != target]
    prior = {"foreign": foreign, "records": [], "reason": None, "gaps": []}
    nums = sorted(o["k"] for o in earlier if o["k"] is not None)
    if any(o["k"] is None or o["rec"] is None for o in earlier):
        prior["reason"] = "an earlier record by this user did not parse"
    elif nums != list(range(1, k)):
        prior["reason"] = ("this user's earlier records are not exactly record 1" if k == 2 else
                           "this user's earlier records are not exactly records 1-%d" % (k - 1))
    else:
        recs = sorted((o["rec"] for o in earlier), key=lambda r: r["k"])
        prev = recs[-1]
        # Records are non-overlapping in TOKENS, not in time (macrodream/blueprint#387): each claims what no
        # earlier record of ITS session claimed, so two sessions' records on one MR may cover the same hours
        # and still count different tokens. The running total therefore sums the records whatever their
        # windows; a gap between windows is stated, not a reason to withhold the total.
        gaps = []
        bad = None
        for a, b in zip(recs, recs[1:]):
            if a["end"] is None:
                bad = "record %d states no window end" % a["k"]
                break
            if b["start"] is not None and b["start"] > a["end"]:
                gaps.append((a["end"], b["start"]))
        if bad:
            prior["reason"] = bad
        elif prev["end"] is None:
            prior["reason"] = "record %d states no window end" % prev["k"]
        else:
            prior["records"] = recs
            prior["gaps"] = gaps
            if since > prev["end"]:
                prior["gaps"].append((prev["end"], since))
    return 0, "", target, k, prior


def post(iid, body, target, api):
    if target:
        rc, _ = api("PUT", "projects/:id/merge_requests/%d/notes/%d" % (iid, target), {"body": body})
        return (0, "cost-table: updated note %d on !%d" % (target, iid)) if rc == 0 else (4, "cost-table: could not update note %d" % target)
    rc, _ = api("POST", "projects/:id/merge_requests/%d/notes" % iid, {"body": body})
    return (0, "cost-table: posted a new note on !%d" % iid) if rc == 0 else (4, "cost-table: could not post the note")


def upsert(iid, body, api=glab_api):
    """(exit code, message) for record 1: PUT this user's record 1 when it is the latest record,
    else POST one; refuse (5) once a later record exists, since earlier records are never edited."""
    own, _foreign, err = read_records(iid, api)
    if err:
        return 4, err
    if any(o["k"] is None or o["k"] > 1 for o in own):
        return 5, "cost-table: !%d already has a later cost record; record 1 is never edited after it" % iid
    if len(own) > 1 or (own and own[0]["rec"] is None):
        # Two record 1s, or one that is not a generated record: never overwrite a note it cannot identify.
        return 5, "cost-table: !%d has a record 1 by this user that is doubled or not generated; not updated" % iid
    return post(iid, body, own[0]["id"] if own else None, api)


def _allowed(path):
    """`path` resolved inside the checkout, the cwd, the temp dir or the git common dir
    (cost_ledger_lines.file_roots), else PathEscapeError."""
    return resolve_within(cl.file_roots(), path)


def _read_capped(path, cap):
    with open(_allowed(path), "rb") as fh:
        return fh.read(cap).decode("utf-8", errors="replace")


USAGE = ("usage: cost-table.py --comment (--file <description.md> | --ledger <lines.txt> --since T --until T --mr <iid>) "
         "[--issue N] [--until T] [--since T] [--session-start] [--split F] [--project ns/proj] [--other-sessions S:A:T] "
         "[--post [--mr <iid>]] | "
         "--next-since --mr <iid> | --self-test")


def comment_main(argv, enabled, stdout, stderr, api):
    opts, i = {}, 0
    flags = ("--file", "--ledger", "--issue", "--since", "--until", "--split", "--mr", "--project", "--other-sessions")
    post_it = next_since = session_start = False
    while i < len(argv):
        a = argv[i]
        if a == "--comment":
            i += 1
        elif a == "--post":
            post_it = True
            i += 1
        elif a == "--next-since":
            next_since = True
            i += 1
        elif a == "--session-start":
            session_start = True
            i += 1
        elif a in flags and i + 1 < len(argv) and a not in opts:
            opts[a] = argv[i + 1]
            i += 2
        else:
            print(USAGE, file=stderr)
            return 2
    PROJECT["path"] = None
    if "--project" in opts:
        proj = opts.pop("--project")
        if not PROJECT_RE.match(proj):
            print("cost-table: --project must be a namespace/project path", file=stderr)
            return 2
        PROJECT["path"] = proj
    others = None
    if "--other-sessions" in opts:
        m = OTHERS_RE.match(opts.pop("--other-sessions"))
        if not m:
            print("cost-table: --other-sessions must be <sessions>:<agents>:<tokens>, three non-negative integers", file=stderr)
            return 2
        others = tuple(int(g) for g in m.groups())
    nums = {}
    for k in ("--issue", "--mr"):
        v = opts.get(k)
        if v is not None and not (v.isascii() and v.isdigit() and len(v) <= 9):
            print("cost-table: %s must be a number" % k, file=stderr)
            return 2
        nums[k] = int(v) if v else None
    follow = "--ledger" in opts
    if next_since:
        if not nums["--mr"] or len(opts) != 1 or post_it:
            print("usage: --next-since takes only --mr <iid>", file=stderr)
            return 2
        if enabled() != 0:
            print("cost-table: cost ledger off or unreadable; no record", file=stderr)
            return 3
        own, _f, err = read_records(nums["--mr"], api)
        if err:
            print(err, file=stderr)
            return 4
        latest = max(own, key=lambda o: o["k"] or 0) if own else None
        if not latest or not latest["rec"] or not latest["rec"]["end"]:
            print("cost-table: no readable record with a window end by this user on !%d" % nums["--mr"], file=stderr)
            return 1
        print(latest["rec"]["end"], file=stdout)
        return 0
    if follow == ("--file" in opts) or (post_it and not nums["--mr"]) or (follow and not (
            nums["--mr"] and "--since" in opts and "--until" in opts)):
        print(USAGE, file=stderr)
        return 2
    since = until = None
    if follow:
        since, why_s = window_end(opts["--since"])
        until, why_u = window_end(opts["--until"])
        if since is None or until is None or since > until:
            print("cost-table: --since and --until must be ISO 8601 with a zone, --since first", file=stderr)
            return 2
    elif "--since" in opts:
        # Record 1 may state its actual window (macrodream/blueprint#387) instead of only its end.
        since, why_s = window_end(opts["--since"])
        end1, _w = window_end(opts.get("--until"))
        if since is None or (end1 is not None and since > end1):
            print("cost-table: --since must be ISO 8601 with a zone and not after --until", file=stderr)
            return 2
    try:
        if follow:
            body = "## Gates\n" + _read_capped(opts["--ledger"], MAX_LEDGER_FILE)
        else:
            body = _read_capped(opts["--file"], 16 << 20)
        split = None
        if "--split" in opts:
            # A missing split file is the same as no --split (the cells read n/a); an existing but
            # unreadable one is an error.
            if os.path.exists(_allowed(opts["--split"])):
                split = _read_capped(opts["--split"], 4 << 20)
    except OSError as e:
        print("cost-table: cannot read %s" % e.strerror, file=stderr)
        return 2
    except PathEscapeError:
        print("cost-table: a file argument is outside the checkout, the temp dir and the git dir", file=stderr)
        return 2
    rc, msg = gate(body, enabled)
    if rc != 0:
        print(msg, file=stderr)
        return rc
    if not follow:
        text = "\n".join(comment_lines(body, nums["--issue"], opts.get("--until"), split, since=since, session_start=session_start,
                                        others=others))
        if not post_it:
            print(text, file=stdout)
            return 0
        rc, m = upsert(nums["--mr"], text, api)
        print(m, file=stderr)
        return rc
    own, foreign, err = read_records(nums["--mr"], api)
    if err:
        print(err, file=stderr)
        return 4
    rc, m, target, k, prior = plan_followup(own, foreign, since, until)
    if rc:
        print(m, file=stderr)
        return rc
    text = "\n".join(comment_lines(body, nums["--issue"], until, split, record=k, since=since, prior=prior,
                                    session_start=session_start, others=others))
    if not post_it:
        print(text, file=stdout)
        return 0
    rc, m = post(nums["--mr"], text, target, api)
    print(m, file=stderr)
    return rc


def main(argv, enabled=ledger_enabled, stdout=sys.stdout, stderr=sys.stderr, api=glab_api):
    if argv[:1] == ["--self-test"]:
        return self_test()
    if "--comment" in argv or "--next-since" in argv:
        return comment_main(argv, enabled, stdout, stderr, api)
    # The description's `## Cost` section and `--write` were removed (macrodream/blueprint#384).
    print(USAGE, file=stderr)
    return 2


# --- self-test --------------------------------------------------------------

def self_test():
    import io
    fails, ran = [], [0]

    def check(name, ok, detail=""):
        ran[0] += 1
        if not ok:
            fails.append("%s %s" % (name, detail))

    def desc(*ledger, tail="\n## Notes\n- a note\n\nCloses #5\n"):
        return ("## Summary\n- x\n\n## Gates\n<!-- template comment: subagent-tokens: 999 -->\n"
                "- gate: regression-check — 0 findings (sonnet)\nchange-class: chore\n"
                + "\n".join(ledger) + "\n" + tail)

    full = desc("subagent-tokens: 2594324", "orchestrator-tokens: 1997645",
                "est-cost-usd: 1.57 (prices 2026-11-03)")
    on, off, bad = (lambda: 0), (lambda: 1), (lambda: 2)

    def total_row(body):
        return [ln for ln in comment_lines(body) if ln.startswith("| **Total** |")][0]

    # On: every figure from its line, with thousands separators and the price date.
    check("on: exit 0", gate(full, on) == (0, ""))
    row = total_row(full)
    check("on: totals from the ledger lines", row.endswith("| **4,591,969** | **1.57 USD** |"), row)
    com = "\n".join(comment_lines(full))
    check("on: the commented template line is not read", "999" not in com, com)
    check("on: price date", "(prices 2026-11-03)" in com, com)

    # Off, unreadable, and the description's own marker: no record, exit 3.
    for name, body, en in (("setting off", full, off), ("setting unreadable", full, bad),
                           ("setting answered 127", full, lambda: 127),
                           ("marker in the description", desc("cost-ledger: off"), on)):
        rc, msg = gate(body, en)
        check(name + ": exit 3 and no record", rc == 3 and "no cost comment" in msg, repr((rc, msg)))

    # Partial: a missing line is n/a with its reason, never 0; the total needs both lines.
    com = "\n".join(comment_lines(desc("subagent-tokens: 10")))
    check("partial: present figure", "| 10 |" in com, com)
    check("partial: missing orchestrator is n/a with reason",
          "n/a (no `orchestrator-tokens:` line in `## Gates`; see `## Notes`)" in com, com)
    check("partial: total n/a", "**n/a (needs both" in com, com)
    check("partial: missing estimate is n/a", "n/a (no `est-cost-usd:` line" in com, com)
    check("partial: never renders a 0 figure", "| 0 |" not in com, com)
    # No ledger lines at all (a resumed branch, a script that exited non-zero): every ledger cell n/a.
    com = "\n".join(comment_lines(desc()))
    check("no cost lines: plain /mr reason, not the Notes pointer",
          com.count("n/a (%s)" % NONE_RECORDED) == 4 and "`subagent-tokens:` line in `## Gates`; see" not in com, com)
    # An estimate without a price date says so instead of inventing one.
    com = "\n".join(comment_lines(desc("est-cost-usd: 7")))
    check("estimate without a date", "no price date on the ledger line" in com and "**7 USD**" in com, com)

    # Malformed and doubled lines: n/a with a reason, and the line text is never echoed.
    for name, line, want in (("estimated tokens", "subagent-tokens: ~5kSECRET", "malformed `subagent-tokens:`"),
                             ("comma tokens", "orchestrator-tokens: 1,234", "malformed `orchestrator-tokens:`"),
                             ("dollar estimate", "est-cost-usd: $1.00", "malformed `est-cost-usd:`")):
        com = "\n".join(comment_lines(desc(line)))
        check("malformed %s: n/a with reason" % name, "n/a (%s line" % want in com, com)
        check("malformed %s: not echoed" % name, "SECRET" not in com and "1,234 " not in com and "$1" not in com, com)
    com = "\n".join(comment_lines(desc("subagent-tokens: 1", "subagent-tokens: 2")))
    check("doubled line: n/a, neither figure picked", "more than one `subagent-tokens:`" in com and "| 1 |" not in com, com)
    # Hostile input: non-ASCII digits and an over-long count are malformed, not a crash or a figure.
    for name, line in (("Arabic-Indic digits", "subagent-tokens: ١٢٣"),
                       ("5000 digits", "subagent-tokens: " + "9" * 5000),
                       ("non-ASCII estimate", "est-cost-usd: ١.00 (prices 2026-11-03)")):
        check("hostile %s: rendered with n/a malformed" % name, "n/a (malformed" in "\n".join(comment_lines(desc(line))))
    # Many unclosed comment openers: linear, so this returns at once (a `<!--.*?-->` regex took
    # about 5s on 20k openers and is quadratic; 20k keeps a regression a fast failure, not a hang).
    import time
    t0 = time.time()
    comment_lines("## Gates\nchange-class: chore\n" + "<!--" * 20000)
    check("20k unclosed comment openers render in under 1s", time.time() - t0 < 1, "%.1fs" % (time.time() - t0))
    check("strip_comments: closed, unclosed", strip_comments("a<!--x-->b<!--y") == "ab")

    # Lines outside `## Gates`, or inside a code fence, are not read.
    com = "\n".join(comment_lines("## Notes\nsubagent-tokens: 5\n\n## Gates\n- gate: x — 0 findings\nchange-class: chore\n"
                                  "```\norchestrator-tokens: 6\n```\n"))
    check("outside Gates / fenced: not read", "| 5 |" not in com and "| 6 |" not in com, com)
    check("no Gates section: exit 1", gate("## Summary\n- x\n", on)[0] == 1)

    # The other readers of the ledger read the same figures this renders (one parser:
    # scripts/cost_ledger_lines.py), and a description that renders cleanly passes its checker.
    kz = _load_kaizen()
    check("full: the checker finds the ledger lines clean", cl.check_body(full) == [], repr(cl.check_body(full)))
    check("full: the cost lines module reads the figures",
          [cl.subagent_tokens(full), cl.orchestrator_tokens(full), cl.est_cost_usd(full)] == [2594324, 1997645, 1.57])
    kfig = kz.cost_figures({"iid": 1, "description": full, "source_branch": "chore/x"})
    check("full: /kaizen reads the same figures", (kfig["subagent_tokens"], kfig["orchestrator_tokens"], kfig["gates_est_cost_usd"])
          == (2594324, 1997645, 1.57) and kfig["state"] == "recorded", repr(kfig))
    # #2154: the `## Gates` estimate is a snapshot; /kaizen's per-MR cost comes from the windowed records only.
    check("full: /kaizen does not read the Gates snapshot as the MR's cost", kfig["est_cost_usd"] is None, repr(kfig))
    check("off: /kaizen reads a marker as disabled, never 0",
          kz.cost_figures({"iid": 2, "description": desc("cost-ledger: off")})["state"] == "disabled")

    # The CLI: the description table and --write are gone.
    tmp = tempfile.mkdtemp(prefix="cost-table-2128-")
    path = os.path.join(tmp, "d.md")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(full)
    for args in ([], ["--file", path], ["--file", path, "--write"], ["--bogus", path]):
        e = io.StringIO()
        rc = main(args, enabled=on, stdout=io.StringIO(), stderr=e)
        check("cli %r: exit 2 (usage)" % (args[:1] + args[2:],), rc == 2 and "usage" in e.getvalue(), repr(rc))
    check("cli: --write leaves the file untouched", open(path, encoding="utf-8").read() == full)

    # --- the MR comment, record 1 (macrodream/blueprint#383) ---
    split = "\n".join([
        "subagent-tokens: 3 agents (1 named): skipped SECRET",
        "subagent-tokens: model claude-sonnet-5-5 2000000",
        "subagent-tokens: model claude-opus-5-5 594324",
        "orchestrator-tokens: model claude-opus-5-5 1997645",
        "est-cost: model claude-opus-5-5 9.99 USD",
        "est-cost: subagent model claude-sonnet-5-5 0.50 USD",
        "est-cost: subagent model claude-opus-5-5 0.20 USD",
        "est-cost: orchestrator model claude-opus-5-5 0.87 USD",
        "subagent-tokens: model evil|x 5", "est-cost: subagent model claude-opus-5-5 $9 USD",
    ])
    withb = desc("subagent-tokens: 2594324", "orchestrator-tokens: 1997645",
                 "est-cost-usd: 1.57 (prices 2026-11-03)", "budget-exceeded: 1 (implementer 1)")
    com = "\n".join(comment_lines(withb, 383, "2026-11-04T15:30:00Z", split))
    check("comment: heading with the issue", com.startswith("## Cost of this MR (#383)\n"), com)
    for want in ("| Subagents | 2,000,000 | 0.50 USD | 594,324 | 0.20 USD | 2,594,324 | 0.70 USD |",
                 "| Orchestrator | none used | none used | 1,997,645 | 0.87 USD | 1,997,645 | 0.87 USD |",
                 "| **Total** | **2,000,000** | **0.50 USD** | **2,591,969** | **1.07 USD** | **4,591,969** | **1.57 USD** |",
                 "Window end: 2026-11-04T15:30:00Z.", "prices 2026-11-03", "(`budget-exceeded:`): 1 (implementer 1)",
                 NOT_WINDOWED):
        check("comment: " + want[:40], want in com, com)
    # record K > 1 states a window and the non-overlap sentence (#2154 round 2: dropping `record > 1 or` must fail)
    k2 = "\n".join(comment_lines(withb, 383, None, split, record=2, since="2026-11-04T15:00:00Z",
                                  prior={"records": [], "gaps": []}))
    check("comment: record K>1 renders the non-overlap sentence and no not-windowed line",
          "Records do not overlap" in k2 and NOT_WINDOWED not in k2, k2)
    # --since without --until: no complete window, so the not-windowed line and no add-up claim.
    ns = "\n".join(comment_lines(withb, 383, None, split, since="2026-11-04T15:00:00Z"))
    check("comment: --since without --until is not windowed (not-windowed line, no add-up bullet)",
          NOT_WINDOWED in ns and "Window end: n/a" in ns and "Records do not overlap" not in ns and "Window: " not in ns, ns)
    # #2154: a record with no window start says its orchestrator row is not windowed, and does not claim
    # non-overlap; a record with a start still does.
    check("comment: no window start drops the non-overlap claim", "Records do not overlap" not in com, com)
    check("comment: a windowless record renders the not-windowed line and not the generic add-up bullet",
          NOT_WINDOWED in com and "add up to its total" not in com and "Records from one session" not in com
          and "Records add up across sessions" not in com, com)
    # #2155: the windowed bullet carries upstream's new closing sentence (record 1 with a window, and record K).
    check("comment: the non-overlap bullet ends with the cross-session sentence (#2155)",
          "Records add up across sessions; nothing is counted twice." in k2
          and "Records add up across sessions; nothing is counted twice." in "\n".join(
              comment_lines(withb, 383, "2026-11-04T15:30:00Z", split, since="2026-11-04T15:00:00Z"))
          and "Records from one session add up to its total." not in k2, k2)
    check("comment: a window start keeps the non-overlap claim and has no not-windowed line",
          "Records do not overlap" in "\n".join(comment_lines(withb, 383, "2026-11-04T15:30:00Z", split, since="2026-11-04T15:00:00Z"))
          and NOT_WINDOWED not in "\n".join(comment_lines(withb, 383, "2026-11-04T15:30:00Z", split, since="2026-11-04T15:00:00Z")))
    check("comment: the retired never-add footnote is gone", "must not be added" not in com
          and "shared by every branch of the same wave" not in com, com)
    check("comment: record 1 has no running-total row", "Running total" not in com, com)
    check("comment: hostile split lines are not echoed", "SECRET" not in com and "evil" not in com and "$9" not in com, com)
    check("comment: no ledger line, no `gate:` line", not any(cl.COSTISH_RE.match(ln) or cl.GATE_PREFIX_RE.match(ln)
          for ln in comment_lines(withb, 383, None, split)))
    check("comment: record 1 parses back as record 1", (parse_record(com) or {}).get("k") == 1
          and parse_record(com)["end"] == "2026-11-04T15:30:00Z", repr(parse_record(com)))
    # No split / no estimate / no window: n/a with a reason, never 0.
    bare = "\n".join(comment_lines(full, None, None, None))
    check("comment: no split renders the compact Tokens / Est. cost table, with no n/a split cells (macrodream/blueprint#387)",
          "| | Tokens | Est. cost |\n|---|---|---|\n" in bare and "| Subagents | 2,594,324 | - |" in bare
          and "| **Total** | **4,591,969** | **1.57 USD** |" in bare and "n/a (no per-model split recorded" not in bare
          and "Sonnet tokens" not in bare and "| 0 |" not in bare, bare)
    check("comment: a compact record says why it has no breakdown", "No per-model split was recorded for this record" in bare, bare)
    check("comment: a compact record parses back with its Total (so --next-since and numbering still read it)",
          parse_record(bare) is not None and parse_record(bare)["fams"] == []
          and parse_record(bare)["total"] == {("tok", "all"): 4591969, ("usd", "all"): decimal.Decimal("1.57")}, repr(parse_record(bare)))
    check("comment: no window end is n/a", "Window end: n/a (no window end given)" in bare, bare)
    check("comment: no budget line, no budget bullet", "budget-exceeded" not in bare, bare)
    check("comment: heading without an issue", bare.startswith("## Cost of this MR\n"), bare)
    check("comment: record 1 with no window end parses with end None", parse_record(bare) is not None
          and parse_record(bare)["end"] is None, repr(parse_record(bare)))
    nousd = "\n".join(comment_lines(full, 1, "bogus", "\n".join(ln for ln in split.splitlines() if not ln.startswith("est-cost"))))
    check("comment: a model with no estimate is n/a, not 0",
          "n/a (no estimate for this model" in nousd and "0.00 USD" not in nousd and "no valid `--until` given" in nousd, nousd)
    mis = "\n".join(comment_lines(full, 1, None, "subagent-tokens: model claude-sonnet-5-5 5"))
    check("comment: split that disagrees with the ledger line says so", "model split sums to 5 tokens, not the ledger line's 2,594,324" in mis, mis)
    oth = "\n".join(comment_lines(full, 1, None, "subagent-tokens: model claude-haiku-5-5 7\norchestrator-tokens: model claude-haiku-5-5 3"))
    check("comment: another family gets its own column", "Other tokens | Other est. cost" in oth, oth)
    check("comment: an `Other` record parses back", parse_record(oth) is not None and parse_record(oth)["fams"] == ["Sonnet", "Opus", "Other"],
          repr(parse_record(oth)))
    check("comment: partial ledger renders n/a", "n/a (no `orchestrator-tokens:" in "\n".join(comment_lines(desc("subagent-tokens: 10"))))
    # The record 1 !288 carried, verbatim: an old comment counts as record 1.
    mr288 = ("## Cost of this MR (#383)\n\n| | Sonnet tokens | Sonnet est. cost | Opus tokens | Opus est. cost | Total tokens | Est. cost |\n"
             "|---|---|---|---|---|---|---|\n| Subagents | 7,738,402 | 2.44 USD | none used | none used | 7,738,402 | 2.44 USD |\n"
             "| Orchestrator | 3,820,960 | 0.66 USD | none used | none used | 3,820,960 | 0.66 USD |\n"
             "| **Total** | **11,559,362** | **3.10 USD** | **0** | **0.00 USD** | **11,559,362** | **3.10 USD** |\n\n"
             "- Costs are estimates at list prices from `.claude/model-prices.json` (prices 2026-11-03), not billed amounts; a model with no price row shows `n/a`.\n"
             "- Window end: 2026-11-04T15:38:24Z. Both figures stop at the go-ahead to push; later work is not counted.\n"
             "- Agents over their /wave budget (`budget-exceeded:`): 0.\n"
             "- The orchestrator figure is the session's spend over the window and is shared by every branch of the same wave, "
             "so two MRs' totals must not be added.\n\n" + FOOTER_1)
    p288 = parse_record(mr288)
    check("parse: !288's comment is record 1", p288 is not None and p288["k"] == 1 and p288["end"] == "2026-11-04T15:38:24Z"
          and p288["total"][("tok", "all")] == 11559362 and p288["total"][("usd", "all")] == decimal.Decimal("3.10"), repr(p288))
    # Strict parsing: each of these is not a record.
    for name, mut in (("no footer", lambda b: b.rsplit("\n", 1)[0]),
                      ("a foreign footer", lambda b: b.replace(FOOTER_1, "_typed by hand_")),
                      ("hand-edited total", lambda b: b.replace("**11,559,362** | **3.10 USD** |", "**lots** | **3.10 USD** |")),
                      ("comma-free tokens", lambda b: b.replace("**11,559,362** | **3", "**11559362** | **3")),
                      ("dollar sign", lambda b: b.replace("**3.10 USD** |\n", "**$3.10** |\n")),
                      ("non-ASCII digit", lambda b: b.replace("**11,559,362** | **3", "**11,559,٣٦٢** | **3")),
                      ("two Total rows", lambda b: b.replace("\n\n- Costs", "\n| **Total** | **1** | **1.00 USD** | **0** | **0.00 USD** | **1** | **1.00 USD** |\n\n- Costs")),
                      ("missing window line", lambda b: b.replace("- Window end:", "- Window ends:")),
                      ("bad month", lambda b: b.replace("2026-11-04T15", "2026-13-04T15")),
                      ("a cell too many", lambda b: b.replace("**3.10 USD** |\n", "**3.10 USD** | **1** |\n")),
                      ("record 1 with a record suffix", lambda b: b.replace("(#383)\n", "(#383) %s record 1\n" % DASH, 1)),
                      ("record 0", lambda b: b.replace("(#383)\n", "(#383) %s record 0\n" % DASH, 1)),
                      ("oversized", lambda b: b.replace("- Agents", "- " + "x" * MAX_NOTE + "\n- Agents")),
                      ("indented heading", lambda b: " " + b)):
        check("parse: %s is not a record" % name, parse_record(mut(mr288)) is None, repr(parse_record(mut(mr288))))

    tmp2 = tempfile.mkdtemp(prefix="cost-comment-2128-")
    dpath, spath = os.path.join(tmp2, "d.md"), os.path.join(tmp2, "split.txt")
    open(dpath, "w", encoding="utf-8").write(withb)
    open(spath, "w", encoding="utf-8").write(split)
    o, e = io.StringIO(), io.StringIO()
    rc = main(["--file", dpath, "--comment", "--issue", "383", "--until", "2026-11-04T15:30:00Z", "--split", spath],
              enabled=on, stdout=o, stderr=e)
    check("cli comment: prints the body (the dry-run mode), exit 0", rc == 0 and o.getvalue().startswith("## Cost of this MR (#383)"), repr((rc, e.getvalue())))
    for name, en, want in (("off", off, 3), ("unreadable", bad, 3)):
        o, e = io.StringIO(), io.StringIO()
        calls = []
        rc = main(["--file", dpath, "--comment", "--post", "--mr", "7"], enabled=en, stdout=o, stderr=e,
                  api=lambda *a: calls.append(a) or (0, "[]"))
        check("cli comment %s: exit 3, nothing printed, no API call" % name, rc == want and o.getvalue() == "" and not calls, repr((rc, calls)))
    offd = desc("cost-ledger: off")
    open(dpath, "w", encoding="utf-8").write(offd)
    calls = []
    rc = main(["--file", dpath, "--comment", "--post", "--mr", "7"], enabled=on, stdout=io.StringIO(), stderr=io.StringIO(),
              api=lambda *a: calls.append(a) or (0, "[]"))
    check("cli comment: the description's own `cost-ledger: off` marker means no comment", rc == 3 and not calls, repr((rc, calls)))
    open(dpath, "w", encoding="utf-8").write(withb)
    for args in (["--file", dpath, "--comment", "--post"], ["--file", dpath, "--comment", "--issue", "x"],
                 ["--comment"], ["--file", dpath, "--comment", "--bogus"], ["--file", dpath, "--comment", "--split", tmp2],
                 ["--file", dpath, "--comment", "--since", "yesterday"],
                 ["--file", dpath, "--comment", "--since", "2026-11-04T16:00:00Z", "--until", "2026-11-04T15:30:00Z"],
                 ["--file", dpath, "--ledger", dpath, "--comment", "--mr", "7", "--since", "2026-11-04T15:30:00Z", "--until", "2026-11-04T16:30:00Z"],
                 ["--ledger", dpath, "--comment", "--mr", "7", "--until", "2026-11-04T16:30:00Z"],
                 ["--ledger", dpath, "--comment", "--since", "2026-11-04T15:30:00Z", "--until", "2026-11-04T16:30:00Z"],
                 ["--ledger", dpath, "--comment", "--mr", "7", "--since", "2026-11-04T17:30:00Z", "--until", "2026-11-04T16:30:00Z"],
                 ["--ledger", dpath, "--comment", "--mr", "7", "--since", "yesterday", "--until", "2026-11-04T16:30:00Z"],
                 ["--next-since"], ["--next-since", "--mr", "7", "--post"], ["--file", dpath, "--file", dpath, "--comment"]):
        rc = main(args, enabled=on, stdout=io.StringIO(), stderr=io.StringIO(), api=lambda *a: (0, "[]"))
        check("cli comment usage %r: exit 2" % (args,), rc == 2, repr(rc))

    for args in (["--file", "/etc/hosts", "--comment"], ["--file", dpath, "--comment", "--split", "/etc/hosts"]):
        e = io.StringIO()
        rc = main(args, enabled=on, stdout=io.StringIO(), stderr=e, api=lambda *a: (0, "[]"))
        check("cli comment: a file outside the checkout, temp dir and git dir is refused (exit 2)",
              rc == 2 and "outside" in e.getvalue(), repr((rc, e.getvalue())))
    o = io.StringIO()
    rc = main(["--file", dpath, "--comment", "--split", os.path.join(tmp2, "absent.txt")], enabled=on, stdout=o, stderr=io.StringIO())
    check("cli comment: a missing --split file is the same as none (compact table, exit 0)",
          rc == 0 and "| | Tokens | Est. cost |" in o.getvalue() and "n/a (no per-model split" not in o.getvalue(), repr((rc, o.getvalue())))
    # A doubled split (a re-run appended twice) is flagged for tokens and for USD.
    dbl = "\n".join(comment_lines(full, 1, None, split + "\n" + split))
    check("comment: doubled split flags the USD sum", "model split sums to 3.14 USD, not the ledger line's 1.57 USD" in dbl, dbl)
    cent = "\n".join(comment_lines(full, 1, None, "\n".join(["subagent-tokens: model claude-sonnet-5-5 1", "orchestrator-tokens: model claude-opus-5-5 1",
           "est-cost: subagent model claude-sonnet-5-5 0.50 USD", "est-cost: subagent model claude-opus-5-5 0.20 USD",
           "est-cost: orchestrator model claude-opus-5-5 0.88 USD"])))
    check("comment: parts off by one cent from the ledger total raise no USD warning (1.58 vs 1.57)",
          "USD, not the ledger line" not in cent, cent)
    check("comment: consistent USD split raises no USD warning", "USD, not the ledger line" not in "\n".join(comment_lines(full, 1, None,
          "\n".join(["subagent-tokens: model claude-sonnet-5-5 1", "orchestrator-tokens: model claude-opus-5-5 1",
                      "est-cost: subagent model claude-sonnet-5-5 0.57 USD", "est-cost: orchestrator model claude-opus-5-5 1.00 USD"]))))
    # Two models of one family plus a duplicate line are summed, as designed; non-ASCII digits are rejected.
    fam = parse_split("subagent-tokens: model claude-opus-5-5 5\nsubagent-tokens: model claude-opus-4-1 7\n"
                      "subagent-tokens: model claude-opus-5-5 5\nsubagent-tokens: model claude-opus-5-5 ١٢\n"
                      "est-cost: subagent model claude-opus-5-5 1.23 USD\nest-cost: subagent model claude-opus-5-5 ١.٢٣ USD")
    check("split: two models of one family and a duplicate line sum; non-ASCII digits are rejected",
          fam["tokens"] == {"subagent": {"Opus": 17}}, repr(fam))
    check("split: a non-ASCII USD line is rejected, the ASCII one parses",
          fam["usd"] == {"subagent": {"Opus": decimal.Decimal("1.23")}}, repr(fam))

    # --- a fake `glab api`: `user`, the notes listing (paginated), PUT and POST ---
    ME, OTHER = 42, 99

    def fake(notes, calls, fail=(), me=ME):
        def api(method, path, payload=None):
            calls.append((method, path, payload))
            if method in fail or (path == "user" and "user" in fail):
                return 1, ""
            if path == "user":
                return 0, json.dumps({"id": me, "username": "me"})
            if method == "GET":
                pg = int(re.search(r"&page=(\d+)&", path).group(1))
                return 0, json.dumps(notes[(pg - 1) * 100:pg * 100])
            return 0, "{}"
        return api

    def note(i, body, author=ME, system=False):
        return {"id": i, "body": body, "system": system, "author": {"id": author, "username": "u%d" % author}}

    # Record 1: POST when this user has none, PUT in place on a re-run, skip system and foreign notes.
    calls = []
    rc, _ = upsert(7, "BODY", fake([note(1, "hello"), note(2, "## Cost of this MR", system=True)], calls))
    check("upsert: no existing note posts one", rc == 0 and [c[0] for c in calls] == ["GET", "GET", "POST"]
          and calls[-1][2] == {"body": "BODY"}, repr(calls))
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(1, "x"), note(9, "## Cost of this MR (#383)\nold")], calls))
    check("upsert: a hand-written own note with the heading is never overwritten (exit 5)",
          rc == 5 and not any(c[0] in ("PUT", "POST") for c in calls), repr(calls))
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(8, mr288), note(9, mr288)], calls))
    check("upsert: two own record 1s -> exit 5, neither updated", rc == 5 and not any(c[0] in ("PUT", "POST") for c in calls), repr(calls))
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(1, "x"), note(9, mr288)], calls))
    check("upsert: a re-run updates record 1, no second post",
          rc == 0 and calls[-1][0] == "PUT" and calls[-1][1].endswith("/notes/9") and calls[-1][2] == {"body": "NEW"}, repr(calls))
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(4, "## Cost of this MR\nforged", author=OTHER)], calls))
    check("upsert: another user's record 1 is never updated; a new one is posted", rc == 0 and calls[-1][0] == "POST", repr(calls))
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(4, mr288), note(5, "## Cost of this MR (#383) %s record 2\nx" % DASH)], calls))
    check("upsert: record 1 is refused (exit 5) once record 2 exists", rc == 5 and not any(c[0] in ("PUT", "POST") for c in calls), repr(calls))
    page1 = [note(i, "chat %d" % i) for i in range(100, 200)]
    calls = []
    rc, _ = upsert(7, "NEW", fake(page1 + [note(500, mr288)], calls))
    check("upsert: the match on page 2 is found and updated, not re-posted",
          rc == 0 and [c[0] for c in calls] == ["GET", "GET", "GET", "PUT"] and calls[-1][1].endswith("/notes/500"), repr(calls))
    for method in ("GET", "POST", "user"):
        rc, _ = upsert(7, "B", fake([], [], fail=(method,)))
        check("upsert: %s failure exits 4" % method, rc == 4, repr(rc))
    rc, _ = upsert(7, "B", fake([note(9, mr288)], [], fail=("PUT",)))
    check("upsert: PUT failure exits 4", rc == 4)
    rc, _ = upsert(7, "B", lambda m, p, b=None: (0, "not json"))
    check("upsert: unparseable listing exits 4", rc == 4)
    rc, _ = upsert(7, "B", fake([note(i, "x") for i in range(2000)], []))
    check("upsert: more notes than it reads exits 4, posts nothing", rc == 4)

    # --- follow-up records (macrodream/blueprint#384) ---
    lines2 = "subagent-tokens: 1000\norchestrator-tokens: 500\nest-cost-usd: 0.40 (prices 2026-11-03)\n"
    split2 = ("subagent-tokens: model claude-sonnet-5-5 1000\norchestrator-tokens: model claude-sonnet-5-5 500\n"
              "est-cost: subagent model claude-sonnet-5-5 0.30 USD\nest-cost: orchestrator model claude-sonnet-5-5 0.10 USD\n")
    lpath, s2path = os.path.join(tmp2, "lines.txt"), os.path.join(tmp2, "split2.txt")
    open(lpath, "w", encoding="utf-8").write(lines2)
    open(s2path, "w", encoding="utf-8").write(split2)
    S2, E2 = "2026-11-04T15:38:24Z", "2026-11-04T17:00:00Z"

    def follow(notes, since=S2, until=E2, extra=(), en=on, post_it=True):
        calls, o, e = [], io.StringIO(), io.StringIO()
        args = ["--comment", "--ledger", lpath, "--split", s2path, "--issue", "383", "--mr", "288",
                "--since", since, "--until", until] + (["--post"] if post_it else []) + list(extra)
        rc = main(args, enabled=en, stdout=o, stderr=e, api=fake(notes, calls))
        sent = [c for c in calls if c[0] in ("PUT", "POST")]
        return rc, sent, (sent[-1][2]["body"] if sent else o.getvalue()), e.getvalue()

    rc, sent, b2, _ = follow([note(10, mr288)])
    check("follow-up: posts a new record 2", rc == 0 and len(sent) == 1 and sent[0][0] == "POST", repr(sent))
    check("follow-up: record 2 heading", b2.startswith("## Cost of this MR (#383) %s record 2\n" % DASH), b2)
    check("follow-up: own window stated", "- Window: %s to %s." % (S2, E2) in b2, b2)
    check("follow-up: own Total row from the ledger file",
          "| **Total** | **1,500** | **0.40 USD** | **0** | **0.00 USD** | **1,500** | **0.40 USD** |" in b2, b2)
    check("follow-up: running total across records 1-2",
          "| **Running total, records 1-2** | **11,560,862** | **3.50 USD** | **0** | **0.00 USD** | **11,560,862** | **3.50 USD** |" in b2, b2)
    check("follow-up: same Sonnet/Opus columns", "| | Sonnet tokens | Sonnet est. cost | Opus tokens | Opus est. cost | Total tokens | Est. cost |" in b2, b2)
    check("follow-up: record 1 is never edited", all(c[0] != "PUT" for c in sent))
    p2 = parse_record(b2)
    check("follow-up: record 2 parses back", p2 is not None and (p2["k"], p2["start"], p2["end"]) == (2, S2, E2)
          and p2["total"][("tok", "all")] == 1500, repr(p2))
    # Re-run for the same window: updates record 2 in place; a new window posts record 3.
    rc, sent, b2b, _ = follow([note(10, mr288), note(11, b2)])
    check("follow-up: same window re-run updates that record", rc == 0 and len(sent) == 1 and sent[0][0] == "PUT"
          and sent[0][1].endswith("/notes/11") and b2b == b2, repr(sent))
    E3 = "2026-11-04T18:00:00Z"
    rc, sent, b3, _ = follow([note(10, mr288), note(11, b2)], since=E2, until=E3)
    check("follow-up: a new window posts record 3", rc == 0 and sent[0][0] == "POST" and "%s record 3\n" % DASH in b3, repr(sent))
    check("follow-up: record 3 running total adds 1-3",
          "| **Running total, records 1-3** | **11,562,362** | **3.90 USD** |" in b3, b3)
    rc, sent, _, err = follow([note(10, mr288), note(11, b2), note(12, b3)])
    check("follow-up: record 2's window again is refused (exit 5), nothing sent", rc == 5 and not sent, repr((rc, sent, err)))
    rc, sent, bd, _ = follow([note(10, mr288), note(11, b2), note(14, b2)])
    check("follow-up: two own record 2s for this window -> refused (exit 5), neither updated", rc == 5 and not sent, repr(sent))
    rc, sent, bd, _ = follow([note(10, mr288), note(11, b2), note(14, b2)], since=E2, until=E3)
    check("follow-up: two own record 2s, a new window -> record 4 (past every own note), total n/a",
          rc == 0 and len(sent) == 1 and sent[0][0] == "POST" and "%s record 4\n" % DASH in bd
          and "Running total: n/a (this user's earlier records are not exactly records 1-3)" in bd, repr(sent))
    # --next-since: the latest record's window end.
    for notes, want_rc, want in (([note(10, mr288)], 0, "2026-11-04T15:38:24Z\n"), ([note(10, mr288), note(11, b2)], 0, E2 + "\n"),
                                 ([], 1, ""), ([note(10, mr288, author=OTHER)], 1, "")):
        o = io.StringIO()
        rc = main(["--next-since", "--mr", "288"], enabled=on, stdout=o, stderr=io.StringIO(), api=fake(notes, []))
        check("next-since %d note(s): exit %d" % (len(notes), want_rc), rc == want_rc and o.getvalue() == want, repr((rc, o.getvalue())))
    check("next-since: ledger off exits 3", main(["--next-since", "--mr", "1"], enabled=off, stdout=io.StringIO(),
                                                  stderr=io.StringIO(), api=fake([], [])) == 3)

    # Untrusted notes: a forged record by another user is never read and never edited.
    forged = mr288.replace("**11,559,362** | **3.10 USD** |", "**999,999,999** | **9999.00 USD** |")
    rc, sent, bf, _ = follow([note(10, mr288), note(13, forged, author=OTHER)])
    check("forged: another user's record is not read; the total is this user's", rc == 0 and "**11,560,862**" in bf
          and "999,999" not in bf and "1 note(s) with this heading by another user were not read" in bf, bf)
    rc, sent, bf, _ = follow([note(13, forged, author=OTHER)])
    check("forged: only another user's record 1 -> record 2, total n/a, never 0",
          rc == 0 and "%s record 2\n" % DASH in bf and "Running total: n/a (this user's earlier records are not exactly record 1)" in bf
          and "| **Running total, records 1-2** | **n/a" in bf and "**0**" not in bf.split("Running total, records")[1].split("\n")[0], bf)
    rc, sent, bf, _ = follow([note(10, mr288), note(13, b2.replace("record 2", "record 3"), author=OTHER)])
    check("forged: another user's later record does not change the number", "%s record 2\n" % DASH in bf, bf)
    nauth = dict(note(14, forged))
    nauth["author"] = {"id": True}
    rc, sent, bf, _ = follow([note(10, mr288), nauth])
    check("forged: a boolean author id is not this user", "**11,560,862**" in bf and "were not read" in bf, bf)
    # A malformed record by this user: the total is n/a with a reason; the next number still clears it.
    bad_rec = mr288.replace("**11,559,362**", "**eleven million**")
    rc, sent, bm, _ = follow([note(10, bad_rec)])
    check("malformed own record: total n/a (reason), never a guess",
          rc == 0 and "Running total: n/a (an earlier record by this user did not parse)" in bm and "11,56" not in bm, bm)
    check("parse: a control character in an n/a cell is not a record",
          parse_record(mr288.replace("**0** | **0.00 USD**", "**n/a (a\x1bb)** | **0.00 USD**")) is None
          and parse_record(mr288.replace("**0** | **0.00 USD**", "**n/a (ab)** | **0.00 USD**")) is not None)
    rc, sent, bm, _ = follow([note(10, mr288), note(11, "## Cost of this MR (#383) record two\n" + FOOTER_K)])
    check("malformed own heading: record number still past every own note, total n/a",
          "%s record 3\n" % DASH in bm and "did not parse" in bm, bm)
    check("malformed: no note text echoed", "eleven" not in bm and "record two" not in bm)
    # A gap in the numbering (records 1 and 3, no 2): total n/a.
    rc, sent, bg, _ = follow([note(10, mr288), note(12, b3)], since=E3, until="2026-11-04T19:00:00Z")
    check("gap: records 1 and 3 -> record 4, total n/a",
          "%s record 4\n" % DASH in bg and "Running total: n/a (this user's earlier records are not exactly records 1-3)" in bg, bg)
    # Overlap in time: another session's record may cover the same hours, so the running total sums both.
    rc, sent, bo, _ = follow([note(10, mr288)], since="2026-11-04T15:00:00Z")
    check("a window that starts before the previous record ended (another session's record): the running total sums both",
          "Running total: the last row, records 1-2" in bo and "**11,560,862**" in bo and "starts before" not in bo, bo)
    # An earlier pair that overlaps in time (record 2 starts before record 1 ended) still sums into record 3's total.
    ov2 = b2.replace("- Window: %s to %s." % (S2, E2), "- Window: 2026-11-04T10:00:00Z to 2026-11-04T17:00:00Z.")
    rc, sent, bo2, _ = follow([note(10, mr288), note(11, ov2)], since=E2, until=E3)
    check("an earlier pair that overlaps in time: record 3's total still sums all three",
          "%s record 3\n" % DASH in bo2 and "Running total: the last row, records 1-3" in bo2 and "starts before" not in bo2, bo2)
    # Record 1 is refused when this user's only note is a parsed record K.
    calls = []
    rc, _ = upsert(7, "NEW", fake([note(5, b2)], calls))
    check("upsert: record 1 refused (exit 5) over a lone parsed record 2", rc == 5 and not any(c[0] in ("PUT", "POST") for c in calls), repr(calls))
    # A later start than the previous end: the uncounted stretch is stated, the total still adds up.
    rc, sent, bl, _ = follow([note(10, mr288)], since="2026-11-04T16:00:00Z")
    check("time gap: stated and the total stands", "This MR has no record for 2026-11-04T15:38:24Z to 2026-11-04T16:00:00Z" in bl
          and "**11,560,862**" in bl, bl)
    # An earlier pair with a gap (record 2 starts after record 1 ended): record 3 sums and states it.
    gp2 = b2.replace("- Window: %s to %s." % (S2, E2), "- Window: 2026-11-04T16:00:00Z to %s." % E2)
    rc, sent, bg3, _ = follow([note(10, mr288), note(11, gp2)], since=E2, until=E3)
    check("earlier gap: record 3 sums and states the uncovered stretch",
          "%s record 3\n" % DASH in bg3 and "This MR has no record for 2026-11-04T15:38:24Z to 2026-11-04T16:00:00Z" in bg3
          and "Running total: the last row" in bg3 and "**11,562,362**" in bg3, bg3)
    # Record K has no `## Gates`: it states no budget bullet; record 1 shows one only when its line exists.
    check("record K: no budget-exceeded bullet", "budget-exceeded" not in b2, b2)
    # Record 1 with no window end: the total cannot be checked for overlap, so n/a.
    rc, sent, bn, _ = follow([note(10, bare)])
    check("record 1 with no window end: total n/a", "Running total: n/a (record 1 states no window end)" in bn, bn)
    # Dry run: reads the notes, prints, posts nothing.
    rc, sent, out, _ = follow([note(10, mr288)], post_it=False)
    check("follow-up dry run: printed, nothing sent", rc == 0 and not sent and "%s record 2\n" % DASH in out, repr(sent))
    # Ledger off, or `cost-ledger: off` in the lines file: no record, no API call.
    rc, sent, _, _ = follow([note(10, mr288)], en=off)
    check("follow-up: ledger off exits 3, nothing sent", rc == 3 and not sent)
    open(lpath, "w", encoding="utf-8").write("cost-ledger: off\n")
    rc, sent, _, _ = follow([note(10, mr288)])
    check("follow-up: `cost-ledger: off` in the lines exits 3, nothing sent", rc == 3 and not sent)
    # A missing line in the window's file: that figure is n/a, so the running total column is n/a.
    open(lpath, "w", encoding="utf-8").write("orchestrator-tokens: 500\n")
    rc, sent, bp, _ = follow([note(10, mr288)])
    check("follow-up: a missing line is n/a, and so is its running-total column",
          rc == 0 and "n/a (no `subagent-tokens:` line" in bp
          and "| **Running total, records 1-2** | **11,560,862** | **3.50 USD** | **0** | **0.00 USD** | **n/a (a record has no figure" in bp, bp)
    rc, sent, _, _ = follow([note(10, mr288)], extra=["--ledger", lpath])
    check("follow-up: a doubled flag is a usage error", rc == 2 and not sent)

    # A window with no subagent (macrodream/blueprint#386): measured 0, not n/a.
    open(lpath, "w", encoding="utf-8").write("subagent-tokens: 0\norchestrator-tokens: 500\nest-cost-usd: 0.10 (prices 2026-11-03)\n")
    open(s2path, "w", encoding="utf-8").write("orchestrator-tokens: model claude-sonnet-5-5 500\n"
                                              "est-cost: orchestrator model claude-sonnet-5-5 0.10 USD\n")
    rc, sent, bz, _ = follow([note(10, mr288)])
    check("no-subagent window: Subagents row is a measured 0 / 0.00 USD, families none used",
          rc == 0 and "| Subagents | none used | none used | none used | none used | 0 | 0.00 USD |" in bz, bz)
    check("no-subagent window: orchestrator row and total are real",
          "| Orchestrator | 500 | 0.10 USD | none used | none used | 500 | 0.10 USD |" in bz
          and "| **Total** | **500** | **0.10 USD** | **0** | **0.00 USD** | **500** | **0.10 USD** |" in bz, bz)
    check("no-subagent window: running total is real and no split-sum mismatch note",
          "| **Running total, records 1-2** | **11,559,862** | **3.20 USD** |" in bz and "split sums" not in bz
          and "n/a (no per-model split" not in bz, bz)
    # A 0 beside real subagent split lines is not trusted: the mismatch note fires.
    open(s2path, "w", encoding="utf-8").write(split2)
    rc, sent, bw, _ = follow([note(10, mr288)])
    check("a subagent-tokens 0 with real subagent split lines still trips the mismatch note",
          "The subagent model split sums to 1,000 tokens, not the ledger line's 0" in bw, bw)
    # No subagent-tokens line at all stays n/a (a forgotten --agent is not a zero).
    open(lpath, "w", encoding="utf-8").write("orchestrator-tokens: 500\nest-cost-usd: 0.10 (prices 2026-11-03)\n")
    open(s2path, "w", encoding="utf-8").write("orchestrator-tokens: model claude-sonnet-5-5 500\n"
                                              "est-cost: orchestrator model claude-sonnet-5-5 0.10 USD\n")
    rc, sent, bm, _ = follow([note(10, mr288)])
    check("no subagent-tokens line stays n/a, never 0", "| Subagents | n/a (no per-model split" in bm and "n/a (no `subagent-tokens:` line" in bm, bm)

    # --- macrodream/blueprint#387: empty rows, the compact table and records that mix both shapes ---
    open(lpath, "w", encoding="utf-8").write("subagent-tokens: 1000\norchestrator-tokens: 500\nest-cost-usd: 0.40 (prices 2026-11-03)\n")
    open(s2path, "w", encoding="utf-8").write(
        "subagent-tokens: model claude-sonnet-5-5 1000\nsubagent-tokens: model unknown 0\n"
        "orchestrator-tokens: model claude-sonnet-5-5 500\norchestrator-tokens: model unknown 0\n"
        "est-cost: subagent model claude-sonnet-5-5 0.30 USD\nest-cost: orchestrator model claude-sonnet-5-5 0.10 USD\n")
    rc, sent, bu, _ = follow([note(10, mr288)])
    check("an `unknown 0` split line adds no Other column and no n/a cell",
          rc == 0 and "Other" not in bu and "n/a" not in bu.split("- Costs are")[0], bu)
    check("a column of real Other tokens is still shown", "Other tokens | Other est. cost" in oth)
    # A compact record K, whose running total adds a full record 1 (all-column figures only).
    open(lpath, "w", encoding="utf-8").write("subagent-tokens: 0\norchestrator-tokens: 500\nest-cost-usd: 0.10 (prices 2026-11-03)\n")
    open(s2path, "w", encoding="utf-8").write("")
    rc, sent, bc, _ = follow([note(10, mr288)])
    check("compact record K: Subagents is a measured 0, Orchestrator has no per-row cost, the Total is real",
          rc == 0 and "| | Tokens | Est. cost |" in bc and "| Subagents | 0 | 0.00 USD |" in bc
          and "| Orchestrator | 500 | - |" in bc and "| **Total** | **500** | **0.10 USD** |" in bc
          and "n/a (no per-model split" not in bc, bc)
    check("compact record K: the running total adds the earlier record's all-column figures",
          "| **Running total, records 1-2** | **11,559,862** | **3.20 USD** |" in bc, bc)
    pc = parse_record(bc)
    check("compact record K parses back", pc is not None and pc["k"] == 2 and pc["fams"] == []
          and pc["total"][("tok", "all")] == 500, repr(pc))
    # A full record after a compact one: the family columns are n/a (the compact record has none), the rest add up.
    open(lpath, "w", encoding="utf-8").write("subagent-tokens: 1000\norchestrator-tokens: 500\nest-cost-usd: 0.40 (prices 2026-11-03)\n")
    open(s2path, "w", encoding="utf-8").write(split2)
    comp1 = "\n".join(comment_lines(full, 383, "2026-11-04T15:38:24Z", None))
    rc, sent, bx, _ = follow([note(10, comp1)])
    check("a full record after a compact record 1: family running totals are n/a, the all-column ones add up",
          rc == 0 and "| **Running total, records 1-2** | **n/a (a record has no figure in this column)** |" in bx
          and "**4,593,469** | **1.97 USD** |" in bx, bx)
    o = io.StringIO()
    rc = main(["--next-since", "--mr", "288"], enabled=on, stdout=o, stderr=io.StringIO(), api=fake([note(10, comp1)], []))
    check("--next-since reads a compact record 1", rc == 0 and o.getvalue() == "2026-11-04T15:38:24Z\n", repr((rc, o.getvalue())))
    check("an old record (!288's) is still record 1 beside the new footnote wording", (parse_record(mr288) or {}).get("k") == 1)

    check("--project accepts a deeply nested project path (no depth cap)", PROJECT_RE.match("/".join("g%d" % i for i in range(20)) + "/p") is not None
          and PROJECT_RE.match("not a project") is None)
    # macrodream/blueprint#387: every API path names its project explicitly when --project is given.
    check("scope_path: :id becomes the URL-encoded project path",
          scope_path("projects/:id/merge_requests/7/notes?per_page=100", "ns/sub/p")
          == "projects/ns%2Fsub%2Fp/merge_requests/7/notes?per_page=100")
    check("scope_path: no project leaves the path alone (manual use)", scope_path("projects/:id/x", None) == "projects/:id/x")
    check("scope_path: `user` has no project part", scope_path("user", "ns/p") == "user")
    rc = main(["--next-since", "--mr", "7", "--project", "not a project"], enabled=on, stdout=io.StringIO(), stderr=io.StringIO(),
              api=lambda *a: (0, "[]"))
    check("--project must be a namespace/project path", rc == 2)
    rc = main(["--next-since", "--mr", "7", "--project", "ns/p"], enabled=on, stdout=io.StringIO(), stderr=io.StringIO(),
              api=fake([note(10, comp1)], []))
    check("--project is accepted beside --next-since", rc == 0 and PROJECT["path"] == "ns/p")
    PROJECT["path"] = None

    # macrodream/blueprint#387: record 1 states its real window, and says when the session just started.
    w1 = "\n".join(comment_lines(full, 383, "2026-11-04T16:00:00Z", split, since="2026-11-04T15:00:00Z", session_start=True))
    w2 = "\n".join(comment_lines(full, 383, "2026-11-04T16:00:00Z", split, since="2026-11-04T15:00:00Z"))
    check("record 1 with a start states `Window: S to U.`, not the go-ahead end", "- Window: 2026-11-04T15:00:00Z to 2026-11-04T16:00:00Z. " in w1
          and "Window end:" not in w1 and "stop at the go-ahead" not in w1, w1)
    check("the first-record sentence appears only when the window began at the session's start",
          FIRST_RECORD in w1 and FIRST_RECORD not in w2, w1 + w2)
    p1 = parse_record(w1)
    check("record 1 in the new window format parses (start and end), and old `Window end:` records still parse",
          p1 is not None and (p1["k"], p1["start"], p1["end"]) == (1, "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z")
          and parse_record(mr288)["end"] == "2026-11-04T15:38:24Z", repr(p1))
    o = io.StringIO()
    rc = main(["--next-since", "--mr", "288"], enabled=on, stdout=o, stderr=io.StringIO(), api=fake([note(10, w1)], []))
    check("--next-since reads a new-format record 1", rc == 0 and o.getvalue() == "2026-11-04T16:00:00Z\n", repr((rc, o.getvalue())))
    o = io.StringIO()
    rc = main(["--file", dpath, "--comment", "--until", "2026-11-04T16:00:00Z", "--since", "2026-11-04T15:00:00Z", "--session-start"],
              enabled=on, stdout=o, stderr=io.StringIO())
    check("cli: --since and --session-start on record 1", rc == 0 and "- Window: 2026-11-04T15:00:00Z to" in o.getvalue()
          and FIRST_RECORD in o.getvalue(), o.getvalue()[:200])

    # macrodream/blueprint#389: subagents claimed from other sessions get one fixed-text line, numbers only.
    o = io.StringIO()
    rc = main(["--file", dpath, "--comment", "--until", "2026-11-04T16:00:00Z", "--since", "2026-11-04T15:00:00Z",
               "--other-sessions", "1:2:1234567"], enabled=on, stdout=o, stderr=io.StringIO())
    want_o = ("- Other sessions: the Subagents row includes 2 subagents from 1 other session, counted because they "
              "worked in this MR's worktree. Those sessions' orchestrator spend is not in this record: 1,234,567 tokens "
              "of it are in no record yet.")
    check("cli: --other-sessions adds the fixed-text line, and the record still parses", rc == 0 and want_o in o.getvalue()
          and (parse_record(o.getvalue()) or {}).get("start") == "2026-11-04T15:00:00Z", o.getvalue())
    check("--other-sessions with no agent adds no line", others_line((0, 0, 0)) is None and others_line(None) is None
          and "1 subagent from 1 other session, counted because it worked" in others_line((1, 1, 0)))
    check("record 1's window sentence says the Subagents row also holds other sessions' work from outside the window, "
          "only when it does", "- Window: 2026-11-04T15:00:00Z to 2026-11-04T16:00:00Z. This record counts the session's work in "
          "this window, plus other sessions' subagents' work on this branch since their own previous record, which can be from "
          "before the window; later work on this MR goes in later records." in o.getvalue()
          and "counts only the session's work in this window" not in o.getvalue()
          and "counts only the session's work in this window" in w2, o.getvalue())
    for bad in ("1:2", "a:b:c", "1:2:-3", "1:2:3:4", "1:2:3 x", "1:2:" + "9" * 19):
        rc = main(["--file", dpath, "--comment", "--other-sessions", bad], enabled=on, stdout=io.StringIO(), stderr=io.StringIO())
        check("--other-sessions %r is a usage error" % bad, rc == 2, repr(rc))
    rc, sent, bx, _ = follow([note(10, w1)], extra=("--other-sessions", "2:3:10"))
    check("a record K carries the line too, and its window sentence names the other sessions' work",
          rc == 0 and "includes 3 subagents from 2 other sessions" in bx
          and ". This record counts the work in this window, plus other sessions' subagents' work on this branch since their own "
              "previous record, which can be from before the window; the running-total row adds the earlier records." in bx
          and (parse_record(bx) or {}).get("start") is not None, bx)
    rc, sent, bx0, _ = follow([note(10, w1)])
    check("a record K without other sessions keeps `counts only the work in this window`",
          rc == 0 and "This record counts only the work in this window;" in bx0 and "other sessions' subagents' work" not in bx0, bx0)

    # The real setting reader answers with one of its three codes.
    check("ledger_enabled: answers 0, 1 or 2", ledger_enabled() in (0, 1, 2))

    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(tmp2, ignore_errors=True)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        print("cost-table self-test: %d of %d check(s) failed" % (len(fails), ran[0]), file=sys.stderr)
        return 1
    print("cost-table self-test OK (%d checks)" % ran[0])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
