#!/usr/bin/env python3
"""scripts/cost_ledger_lines.py - read and check the cost lines in an MR's `## Gates` section.

The cost ledger (#2128, docs/development/cost-ledger.md) is the set of lines `/mr` and `/wave`
write under the `gate:` lines of `## Gates`:

  subagent-tokens: <N>                        measured (scripts/subagent-tokens.py)
  orchestrator-tokens: <N>                    measured (scripts/orchestrator-tokens.py)
  est-cost-usd: <N.NN> (prices YYYY-MM-DD)    the one estimate (scripts/est-cost.py)
  turns: <N>, cost: usd <N>                   measured only; never computed from a price table
  budget-exceeded: <N> [(<role> <k>, ...)]    a count of agents, not cost (upstream's /wave only)
  cost-ledger: off                            the marker when the setting is off; no cost line then

This module is the one reader of that format in this repo: scripts/cost-table.py renders the
cost comment from it and scripts/kaizen_gate_ledger.py reads the `## Gates` lines through it (the
per-MR cost /kaizen reports comes from the MR's windowed cost comments instead, #2154). It is ported from
the cost parts of Blueprint's gate-yield.py and check-gate-ledger.py (macrodream/blueprint#235,
macrodream/blueprint#340, macrodream/blueprint#348, macrodream/blueprint#364,
macrodream/blueprint#365); the gate-line rules of those scripts are not ported, because
kaizen_gate_ledger.py already owns how this repo reads `gate:` lines.

Only the `## Gates` section is read, outside code fences, with HTML comments stripped, so an MR
that quotes the template (in a fence, a comment, or `## Notes`) does not count as recording.

As a checker it reports a malformed, doubled or contradictory cost line. It never requires a cost
line (a plain /mr holds no figures) and never echoes the line's text: an MR description is
written by whoever can edit it, so every problem is fixed text plus integers.

Usage:
  python3 scripts/cost_ledger_lines.py --file <description.md>   exit 0 clean, 1 problems, 2 usage
  python3 scripts/cost_ledger_lines.py --self-test
"""
from __future__ import annotations

import collections
import math
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
from _paths import PathEscapeError, cli_roots, resolve_within  # noqa: E402

def _git_common_dir():
    """The clone's git common dir, or None. /wave keeps its description, split and window files in
    the git dir, which for a scripts/wt worktree is outside the checkout (`<clone>/.git/worktrees/`)."""
    git = shutil.which("git")
    if git is None:
        return None
    try:
        r = subprocess.run([git, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return (r.stdout.strip() or None) if r.returncode == 0 else None


def file_roots():
    """Where a CLI-named description, lines or split file may live: scripts/_paths.py's cli_roots
    (the checkout, the cwd, the temp dir) plus the clone's git common dir."""
    extra = _git_common_dir()
    return cli_roots(*([extra] if extra else []))


# Linear on purpose: upstream's `^(#{1,6})\s+(.*?)\s*#*\s*$` backtracks cubically on a heading
# line padded with spaces (2,000 spaces stalled it past 120s; an MR description is user-written).
# The optional closing `#`s are stripped in heading_title() instead.
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")


def heading_title(m):
    """The lowercased title of a HEADING_RE match, closing `#`s and spaces stripped."""
    return m.group(2).rstrip(" \t#").strip().lower()
GATE_PREFIX_RE = re.compile(r"^\s*(?:[-*]\s*)?gate:", re.I)

COST_RE = re.compile(r"^\s*(?:[-*]\s*)?cost:\s*usd\s+(\d+(?:\.\d+)?)\s*$", re.I)
TURNS_RE = re.compile(r"^\s*(?:[-*]\s*)?turns:\s*(\d+)\s*$", re.I)
SUBAGENT_TOKENS_RE = re.compile(r"^\s*(?:[-*]\s*)?subagent-tokens:\s*(\d+)\s*$", re.I)
# est-cost-usd (macrodream/blueprint#364): a list-price ESTIMATE, its own line, never mixed with `cost: usd`.
EST_COST_RE = re.compile(r"^\s*(?:[-*]\s*)?est-cost-usd:\s*(\d+(?:\.\d+)?)(?:\s*\(prices\s+\d{4}-\d{2}-\d{2}\))?\s*$", re.I)
ORCH_TOKENS_RE = re.compile(r"^\s*(?:[-*]\s*)?orchestrator-tokens:\s*(\d+)\s*$", re.I)
_ROLE = r"(?:implementer|gate|completeness-check)"
# ASCII digits, at most 18: `\d` also matches other scripts' digits, and int() raises past 4,300.
BUDGET_RE = re.compile(r"^\s*(?:[-*]\s*)?budget-exceeded:\s*([0-9]{1,18})"
                       r"(?:\s*\(\s*(" + _ROLE + r"\s+[0-9]{1,18}(?:\s*,\s*" + _ROLE + r"\s+[0-9]{1,18})*)\s*\))?\s*$", re.I)
BUDGET_ROLE_RE = re.compile(r"(" + _ROLE + r")\s+([0-9]{1,18})", re.I)
COSTISH_RE = re.compile(r"^\s*(?:[-*]\s*)?(cost|turns|tokens|subagent-tokens|orchestrator-tokens|est-cost-usd|"
                        r"budget-exceeded|cost-ledger):", re.I)
# The cost-ledger off marker (macrodream/blueprint#348): the only value the line takes; an MR with the
# ledger on writes no such line. It never names the layer that turned it off.
LEDGER_OFF_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:\s*off\s*$", re.I)
LEDGER_LINE_RE = re.compile(r"^\s*(?:[-*]\s*)?cost-ledger:", re.I)
# Keys that carry a cost figure, as opposed to `budget-exceeded:` (a count of agents).
COST_KEYS = ("cost", "turns", "tokens", "subagent-tokens", "orchestrator-tokens", "est-cost-usd")
MAX_DIGITS = 18


def strip_comments(body):
    """Drop HTML comments in one linear pass; an unclosed `<!--` runs to the end, as in HTML.
    A `<!--.*?-->` regex is quadratic on many unclosed openers, and the body is user-authored."""
    out, i = [], 0
    while True:
        j = body.find("<!--", i)
        if j < 0:
            out.append(body[i:])
            return "".join(out)
        out.append(body[i:j])
        k = body.find("-->", j + 4)
        if k < 0:
            return "".join(out)
        i = k + 3


def section_lines(body, title="gates"):
    """Yield only the lines of the `## <title>` section, outside code fences. Comments are NOT
    stripped here; callers pass a body through strip_comments() first (ledger_lines does)."""
    level, in_fence = None, False
    for line in (body or "").splitlines():
        if FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        h = HEADING_RE.match(line)
        if h:
            lvl = len(h.group(1))
            if level is None:
                if heading_title(h) == title:
                    level = lvl
                continue
            if lvl <= level:
                if heading_title(h) == title:
                    level = lvl
                    continue
                level = None
                continue
        if level is not None:
            yield line


def ledger_lines(body):
    """The `## Gates` section's lines, comments stripped, outside code fences."""
    return list(section_lines(strip_comments(body or ""), "gates"))


def _first(body, rx, conv):
    for line in ledger_lines(body):
        m = rx.match(line)
        if m and m.group(0).isascii() and len(m.group(1)) <= MAX_DIGITS:
            return conv(m.group(1))
    return None


def subagent_tokens(body):
    """The MR's `subagent-tokens:` value (first well-formed line), or None."""
    return _first(body, SUBAGENT_TOKENS_RE, int)


def orchestrator_tokens(body):
    """The MR's `orchestrator-tokens:` value (first well-formed line), or None."""
    return _first(body, ORCH_TOKENS_RE, int)


def est_cost_usd(body):
    """The MR's `est-cost-usd:` value in USD (first well-formed line; a list-price estimate), or
    None. Never read as, or averaged with, `cost: usd`."""
    return _first(body, EST_COST_RE, float)


def ledger_disabled(body):
    """True when the MR's ledger carries the `cost-ledger: off` marker."""
    return any(LEDGER_OFF_RE.match(line) for line in ledger_lines(body))


def has_cost_signal(body):
    """True when the MR's `## Gates` section carries any cost line or the off marker."""
    return any((m := COSTISH_RE.match(line)) and m.group(1).lower() in COST_KEYS + ("cost-ledger",)
               for line in ledger_lines(body))


def budget_line(line):
    """(total, {role: k}) for a well-formed `budget-exceeded:` line, False when the per-role
    counts do not sum to the total, None when it is not such a line."""
    b = BUDGET_RE.match(line)
    if not b:
        return None
    total, roles = int(b.group(1)), collections.Counter()
    for role, k in BUDGET_ROLE_RE.findall(b.group(2) or ""):
        roles[role.lower()] += int(k)
    if b.group(2) and sum(roles.values()) != total:
        return False
    return total, roles


def budget_exceeded(body):
    """The MR's (`budget-exceeded:` total, role split), or None when there is no well-formed line."""
    for line in ledger_lines(body):
        b = budget_line(line)
        if b is not None:
            return b or None
    return None


def check_body(body):
    """Problems with the cost lines of one MR description, as fixed strings (never the line text)."""
    problems = []
    lines = ledger_lines(body)

    def count(rx):
        return sum(1 for line in lines if rx.match(line))

    for key, rx in (("subagent-tokens", SUBAGENT_TOKENS_RE), ("orchestrator-tokens", ORCH_TOKENS_RE),
                    ("est-cost-usd", EST_COST_RE), ("budget-exceeded", BUDGET_RE)):
        if count(rx) > 1:
            problems.append("more than one `%s:` line in the `## Gates` section (one total per MR)" % key)
    for n, line in enumerate(lines, 1):
        if LEDGER_LINE_RE.match(line):
            if not LEDGER_OFF_RE.match(line):
                problems.append("`## Gates` line %d: a `cost-ledger:` line other than `cost-ledger: off` "
                                "(the only value; with the ledger on, write no such line)" % n)
            continue
        cm = COSTISH_RE.match(line)
        if not cm:
            continue
        if cm.group(1).lower() == "tokens":
            # macrodream/blueprint#365: the legacy line summed the latest notification, not cumulative usage.
            problems.append("`## Gates` line %d: a bare `tokens:` line is retired; write `subagent-tokens: <N>` "
                            "(scripts/subagent-tokens.py)" % n)
            continue
        if BUDGET_RE.match(line) and budget_line(line) is False:
            problems.append("`## Gates` line %d: the per-role counts must sum to the `budget-exceeded:` total" % n)
            continue
        ok = any(r.match(line) for r in (COST_RE, TURNS_RE, SUBAGENT_TOKENS_RE, ORCH_TOKENS_RE, EST_COST_RE, BUDGET_RE))
        if not ok or not line.isascii():
            problems.append("`## Gates` line %d: malformed `%s:` line; cost lines are `subagent-tokens: <N>`, "
                            "`orchestrator-tokens: <N>`, `turns: <N>`, `cost: usd <N>`, `budget-exceeded: <N>` "
                            "(measured counts, digits only) or `est-cost-usd: <N.NN> [(prices YYYY-MM-DD)]`; "
                            "omit a line when its script exited non-zero" % (n, cm.group(1).lower()))
    markers = count(LEDGER_OFF_RE)
    if markers > 1:
        problems.append("more than one `cost-ledger: off` line in the `## Gates` section (one per MR)")
    if markers:
        recorded = sorted({m.group(1).lower() for m in (COSTISH_RE.match(line) for line in lines)
                           if m and m.group(1).lower() in COST_KEYS})
        if recorded:
            problems.append("`cost-ledger: off` together with %s line(s): with the ledger off, record none of them"
                            % ", ".join("`%s:`" % r for r in recorded))
    return problems


def report(body, out=sys.stdout, err=sys.stderr):
    problems = check_body(body)
    if problems:
        for p in problems:
            print("BAD COST LINE: " + p, file=err)
        print("FAIL: %d cost-ledger problem(s) in `## Gates` (docs/development/cost-ledger.md)." % len(problems), file=err)
        return 1
    print("OK: the cost lines in `## Gates` are well formed (or absent).", file=out)
    return 0


def self_test():
    def wrap(*lines):
        return "## Summary\n- x\n\n## Gates\n- gate: regression-check — 0 findings\n" + "\n".join(lines) + "\n\n## Notes\nfoo\n"

    ok = [
        ("no cost line at all", wrap()),
        ("no ledger at all", "## Summary\n- chore\n"),
        ("est-cost-usd with prices date", wrap("est-cost-usd: 12.34 (prices 2026-11-03)")),
        ("est-cost-usd integer and bare", wrap("est-cost-usd: 7")),
        ("est-cost-usd beside the measured lines", wrap("subagent-tokens: 5", "orchestrator-tokens: 6",
                                                         "est-cost-usd: 0.42 (prices 2026-11-03)")),
        ("subagent-tokens and turns lines", wrap("subagent-tokens: 1234567", "turns: 12")),
        ("bulleted cost lines", wrap("- subagent-tokens: 5", "* orchestrator-tokens: 6")),
        ("a measured cost line", wrap("cost: usd 1.5")),
        ("budget-exceeded, zero", wrap("budget-exceeded: 0")),
        ("budget-exceeded with a role split", wrap("budget-exceeded: 2 (implementer 1, completeness-check 1)")),
        ("cost ledger off, marker alone", wrap("cost-ledger: off")),
        ("cost ledger off, bulleted marker", wrap("- cost-ledger: off")),
        ("cost ledger off beside budget-exceeded (a count of agents, not cost)",
         wrap("cost-ledger: off", "budget-exceeded: 1 (implementer 1)")),
        ("a template line in an HTML comment", wrap("<!-- subagent-tokens: ~5k -->", "subagent-tokens: 5")),
        ("an example in a code fence", wrap("```", "subagent-tokens: ~5k", "subagent-tokens: 1", "```", "subagent-tokens: 5")),
        ("a cost line outside `## Gates` is not read", "subagent-tokens: ~5k\n\n## Gates\n- gate: y — 0 findings\n"),
    ]
    bad = [
        ("duplicate est-cost-usd line", wrap("est-cost-usd: 1.00", "est-cost-usd: 2.00")),
        ("est-cost-usd with a dollar sign", wrap("est-cost-usd: $1.00")),
        ("est-cost-usd with two decimal points", wrap("est-cost-usd: 1.2.3")),
        ("est-cost-usd with a tilde", wrap("est-cost-usd: ~1.00")),
        ("est-cost-usd with a thousands comma", wrap("est-cost-usd: 1,000.00")),
        ("est-cost-usd with a bare decimal point", wrap("est-cost-usd: .5")),
        ("est-cost-usd with a malformed prices date", wrap("est-cost-usd: 1.00 (prices soon)")),
        ("est-cost-usd with trailing prose", wrap("est-cost-usd: 1.00 approx")),
        ("est-cost-usd with non-ASCII digits", wrap("est-cost-usd: ١.00")),
        ("duplicate subagent-tokens line", wrap("subagent-tokens: 1", "subagent-tokens: 2")),
        ("estimated subagent-tokens", wrap("subagent-tokens: ~5k")),
        ("subagent-tokens with a thousands comma", wrap("subagent-tokens: 1,234")),
        ("subagent-tokens with a unit", wrap("subagent-tokens: 5k")),
        ("subagent-tokens with non-ASCII digits", wrap("subagent-tokens: ١٢")),
        ("estimated orchestrator-tokens", wrap("orchestrator-tokens: ~80k")),
        ("orchestrator-tokens with a comma", wrap("orchestrator-tokens: 1,234")),
        ("duplicate orchestrator-tokens line", wrap("orchestrator-tokens: 1", "orchestrator-tokens: 2")),
        ("a bare legacy tokens line", wrap("tokens: 1234")),
        ("subagent-tokens together with tokens", wrap("subagent-tokens: 9", "tokens: 5")),
        ("estimated turns", wrap("turns: about 10")),
        ("cost without usd", wrap("cost: 1.5")),
        ("role split not summing to the total", wrap("budget-exceeded: 3 (implementer 1)")),
        ("unknown role in the split", wrap("budget-exceeded: 1 (reviewer 1)")),
        ("duplicate budget-exceeded line", wrap("budget-exceeded: 1", "budget-exceeded: 2")),
        ("budget-exceeded with 5000 digits", wrap("budget-exceeded: " + "9" * 5000)),
        ("budget-exceeded role count with 5000 digits", wrap("budget-exceeded: 1 (gate " + "9" * 5000 + ")")),
        ("budget-exceeded with non-ASCII digits", wrap("budget-exceeded: \u0663\u0663")),
        ("cost ledger off with est-cost-usd", wrap("cost-ledger: off", "est-cost-usd: 1.00")),
        ("cost ledger off with subagent-tokens", wrap("cost-ledger: off", "subagent-tokens: 5")),
        ("cost ledger off with orchestrator-tokens", wrap("cost-ledger: off", "orchestrator-tokens: 9")),
        ("cost ledger off with turns", wrap("cost-ledger: off", "turns: 2")),
        ("cost ledger off with cost", wrap("cost-ledger: off", "cost: usd 1.5")),
        ("cost ledger off with a tokens line", wrap("cost-ledger: off", "tokens: 5")),
        ("cost-ledger: on is not a value", wrap("cost-ledger: on")),
        ("cost-ledger with a layer named", wrap("cost-ledger: off (git config, local)")),
        ("doubled cost-ledger marker", wrap("cost-ledger: off", "cost-ledger: off")),
    ]
    fails, ran = [], [0]

    def check(name, cond):
        ran[0] += 1
        if not cond:
            fails.append(name)

    for name, body in ok:
        check("accepted case rejected: %s -> %r" % (name, check_body(body)), not check_body(body))
    for name, body in bad:
        check("rejected case accepted: " + name, bool(check_body(body)))
    # Never echoed: problem text is fixed strings plus integers.
    for line in ("cost-ledger: SECRET", "subagent-tokens: ~SECRET", "tokens: 424242", "est-cost-usd: SECRET"):
        probs = check_body(wrap(line))
        check("a bad line is not echoed: " + line.split(":")[0], probs and not any("SECRET" in p or "424242" in p for p in probs))
    check("the retired tokens line points at subagent-tokens",
          any("retired" in p and "subagent-tokens" in p for p in check_body(wrap("tokens: 1234"))))
    # Readers.
    full = wrap("subagent-tokens: 2594324", "orchestrator-tokens: 1997645", "est-cost-usd: 1.57 (prices 2026-11-03)")
    check("readers: subagent-tokens", subagent_tokens(full) == 2594324)
    check("readers: orchestrator-tokens", orchestrator_tokens(full) == 1997645)
    check("readers: est-cost-usd", math.isclose(est_cost_usd(full), 1.57))
    check("readers: on is not disabled", not ledger_disabled(full) and has_cost_signal(full))
    check("readers: the off marker", ledger_disabled(wrap("cost-ledger: off")) and has_cost_signal(wrap("cost-ledger: off")))
    check("readers: no signal", not has_cost_signal(wrap()) and subagent_tokens(wrap()) is None)
    check("readers: a commented or fenced line is not read",
          subagent_tokens(wrap("<!-- subagent-tokens: 9 -->")) is None
          and subagent_tokens(wrap("```", "subagent-tokens: 9", "```")) is None)
    check("readers: malformed is None, not 0", subagent_tokens(wrap("subagent-tokens: ~5k")) is None
          and est_cost_usd(wrap("est-cost-usd: $1")) is None)
    check("readers: non-ASCII or over-long digits are None",
          subagent_tokens(wrap("subagent-tokens: ١٢")) is None
          and subagent_tokens(wrap("subagent-tokens: " + "9" * 5000)) is None)
    check("readers: budget-exceeded", budget_exceeded(wrap("budget-exceeded: 2 (implementer 2)")) == (2, {"implementer": 2})
          and budget_exceeded(wrap("budget-exceeded: 3 (implementer 1)")) is None)
    check("readers: a template quote in `## Notes` is not read",
          subagent_tokens("## Gates\n- gate: y — 0 findings\n\n## Notes\nsubagent-tokens: 5\n") is None)
    check("strip_comments: closed, unclosed", strip_comments("a<!--x-->b<!--y") == "ab")
    import time
    t0 = time.time()
    check_body("## Gates\n" + "<!--" * 20000)
    check("20k unclosed comment openers check in under 1s", time.time() - t0 < 1)
    t0 = time.time()
    padded = "## Gates" + " " * 20000 + "x\n" + "# a" + " " * 20000 + "b\n" + "## Gates ##\nsubagent-tokens: 7\n"
    check_body(padded)
    check("a heading padded with 20k spaces checks in under 1s", time.time() - t0 < 1)
    check("a closed ATX heading (`## Gates ##`) still opens the section", subagent_tokens(padded) == 7)
    check("budget readers: huge or non-ASCII counts are None, never a crash",
          budget_exceeded(wrap("budget-exceeded: " + "9" * 5000)) is None
          and budget_exceeded(wrap("budget-exceeded: \u0663\u0663")) is None)
    # The CLI.
    import io
    import tempfile
    with tempfile.TemporaryDirectory(prefix="cost-ledger-lines-2128-") as tmp:
        good, badf = os.path.join(tmp, "good.md"), os.path.join(tmp, "bad.md")
        with open(good, "w", encoding="utf-8") as f:
            f.write(full)
        with open(badf, "w", encoding="utf-8") as f:
            f.write(wrap("cost-ledger: off", "subagent-tokens: 5"))
        check("cli: clean file exits 0", main(["--file", good], io.StringIO(), io.StringIO()) == 0)
        check("cli: bad file exits 1", main(["--file", badf], io.StringIO(), io.StringIO()) == 1)
        check("cli: missing file exits 2", main(["--file", os.path.join(tmp, "nope.md")], io.StringIO(), io.StringIO()) == 2)
        check("cli: path outside the allowed roots exits 2", main(["--file", "/etc/passwd"], io.StringIO(), io.StringIO()) == 2)
        check("cli: no args exits 2", main([], io.StringIO(), io.StringIO()) == 2)
    if fails:
        for f in fails:
            print("self-test FAIL: " + f, file=sys.stderr)
        return 1
    print("cost_ledger_lines self-test OK (%d checks; %d accept, %d reject)" % (ran[0], len(ok), len(bad)))
    return 0


def main(argv, out=sys.stdout, err=sys.stderr):
    if argv == ["--self-test"]:
        return self_test()
    if len(argv) == 2 and argv[0] == "--file":
        try:
            path = resolve_within(file_roots(), argv[1])
            with open(path, "rb") as f:
                body = f.read(16 << 20).decode("utf-8", errors="replace")
        except (OSError, PathEscapeError):
            print("cost_ledger_lines: cannot read the --file path", file=err)
            return 2
        return report(body, out, err)
    print("usage: cost_ledger_lines.py --file <description.md> | --self-test", file=err)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
