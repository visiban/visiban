#!/usr/bin/env python3
"""Parse the `## Gates` ledger out of merged MR descriptions and compute
per-gate yield, run count, and `## Gates` adoption.

This is the mechanical half of the `/kaizen` skill (`.claude/skills/kaizen/
SKILL.md`). CLAUDE.md requires every MR to carry a `## Gates` section — one
`gate: <name> — <outcome>` line per gate that ran — so that a gate which has
stopped earning its slot can be found and narrowed (issue #1094). Nothing
read that ledger before this script; the numbers only existed as prose in MR
descriptions.

The accepted grammar here is deliberately looser than `.claude/skills/mr/
SKILL.md` documents. Real MR descriptions vary: em dash / en dash / plain
hyphen as the separator, singular "finding" vs plural "findings", bare `n/a`
vs `n/a (reason)`, fenced-code-block gate lists instead of a bullet list, and
non-numeric "deliverable" outcomes (`ran (...)`, `fragment added (...)`,
`deferred to #1117`, `see pipeline`) for gates whose product is an artifact
rather than a finding count. The parser accepts all of these rather than the
single documented form — see `parse_outcome()` below and the SKILL's own
"Parser grammar" section, which states this loosening explicitly so nobody
mistakes strict-format lines for the whole population.

Usage:
    # Live: fetch the last N merged MRs from GitLab via glab
    python3 scripts/kaizen_gate_ledger.py --window 30

    # Offline / test: read MR objects from a local JSON file
    # (same shape as `glab api projects/:id/merge_requests?...` — a list of
    # objects with at least "iid", "title", "description")
    python3 scripts/kaizen_gate_ledger.py --input mrs.json

    # Machine-readable output for the skill to reason over
    python3 scripts/kaizen_gate_ledger.py --window 30 --json

    # Offline proof the readers still fire (CI: cost-ledger-selftest)
    python3 scripts/kaizen_gate_ledger.py --self-test

Cost (#2128). Beside yield, the report reads the cost ledger lines `/mr` and `/wave` write in
`## Gates` (`subagent-tokens:`, `orchestrator-tokens:`, `est-cost-usd:`, or the one marker
`cost-ledger: off`; docs/development/cost-ledger.md) through scripts/cost_ledger_lines.py, the
same reader scripts/cost-table.py renders from. Per-MR est. cost does NOT come from `est-cost-usd:` (#2154):
that line is a go-ahead snapshot whose orchestrator share every MR of a wave repeats. It comes from the
sum of the MR's `## Cost of this MR` comment records that state `Window: S to U` (non-overlapping), read
from the MR's notes; an MR with only a legacy `Window end:` record, no record, or unreadable notes is
excluded from every cost mean, and the report counts and names each exclusion. `subagent-tokens:` stays a
`## Gates` figure (per branch). Each MR is in one cost state: `recorded` (a
well-formed figure), `disabled` (the off marker: nothing recorded, by choice) or `none` (no
figure yet). A disabled MR is never counted as 0 and never averaged; a window or change class
whose MRs are all disabled says so instead of showing a mean. Change class is the branch prefix
(feat/fix/docs/chore, else other), the same proxy scripts/kaizen_yield_watch.py uses.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import os
import urllib.parse
from dataclasses import dataclass, field

# Sibling import must work however the script is loaded (direct run, importlib).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import cli_roots, resolve_within  # noqa: E402
import cost_ledger_lines as cost_lines  # noqa: E402
import importlib.util  # noqa: E402
import decimal  # noqa: E402

DEFAULT_PROJECT = "visiban/visiban"
DEFAULT_WINDOW = 30

# A gate line, optionally bulleted (`-`, `*`, or a numbered-list marker like
# `1.`/`1)`) or fenced, of the form:
#   gate: <name> <dash> <outcome>
#
# The separator is deliberately two alternatives, not one greedy character
# class:
#   - a single em dash (—) or en dash (–), surrounding whitespace optional —
#     these characters are unambiguous (never part of a gate name), so no
#     whitespace is required to disambiguate them from the name.
#   - one or two plain ASCII hyphens, with whitespace REQUIRED on both
#     sides — a bare hyphen *is* ambiguous with a hyphenated gate name
#     (`rbac-check`), so the surrounding space is what proves it's a
#     separator and not part of the name.
# Earlier this was a single `[—–-]+` class, which is greedy: an outcome that
# itself starts with hyphens right after an unspaced dash (e.g. a CLI-flag
# note like `—--bump-numpy to 1.2.3`) had its leading hyphens silently eaten
# as if they were part of the separator, truncating the recorded outcome
# with no signal anything was lost (caught in regression-check on #1094).
# Bounding each alternative to at most two dash characters fixes that without
# losing support for a plain "--" or "-" separator style.
GATE_LINE_RE = re.compile(
    r"^\s*(?:[-*]|\d+[.)])?\s*gate:\s*"
    r"(?P<name>[A-Za-z][A-Za-z0-9_/.]*(?:-[A-Za-z0-9_/.]+)*)"
    r"(?:\s*[—–]\s*|\s+-{1,2}\s+)"
    r"(?P<outcome>.*?)\s*$",
    re.IGNORECASE,
)

# The conditional round-2 full audit of `completeness-check` is recorded under the
# SAME gate name, with `round 2` first in the parenthetical (the gate-name pattern
# above drops labels with spaces or parentheses, so it cannot live in the name):
#   gate: completeness-check — 2 findings (round 2; opus; causes: ...; overlap 1/3)
# analyze() re-keys such a line to `completeness-check:r2` so its yield is measured
# apart from round 1 (#1473).
ROUND2_RE = re.compile(r"\(\s*round[ -]?2\b", re.IGNORECASE)
ROUND2_SUFFIX = ":r2"

GATES_HEADING_RE = re.compile(r"^##\s+Gates\b", re.IGNORECASE | re.MULTILINE)

FINDINGS_RE = re.compile(r"^(?P<n>\d+)\s+findings?\b", re.IGNORECASE)
NA_RE = re.compile(r"^n/?a\b", re.IGNORECASE)
SKIPPED_RE = re.compile(r"^skipped\b", re.IGNORECASE)

# Gates whose mandated output is a deliverable (a fragment file, a doc build)
# rather than a finding count — CLAUDE.md and the mr skill both say `0
# findings` is meaningless for these. A non-numeric outcome on one of these
# is expected, not a data-quality problem. (`changelog` and `test-scaffold`
# are the two the mr skill names explicitly; test-scaffold is reported both
# ways in real data — see the skill's own note on that inconsistency.)
DELIVERABLE_GATES = {"changelog", "docs-writer", "test-scaffold"}

# Thresholds implied by CLAUDE.md's own framing ("0% yield over >=10 runs is
# actionable"; ">50% yield is load-bearing").
MIN_RUNS_FOR_VERDICT = 10
LOAD_BEARING_YIELD_PCT = 50.0


# Change class for the cost tables: the branch prefix, as scripts/kaizen_yield_watch.py's
# diff_shape() buckets it (not imported: that module imports this one).
COST_CLASSES = ("feat", "fix", "docs", "chore")


def change_class(mr) -> str:
    prefix = (mr.get("source_branch") or "").split("/", 1)[0].lower()
    return prefix if prefix in COST_CLASSES else "other"


# Why an MR with a `## Gates` cost line is left out of the cost means (#2154). Fixed text: nothing
# from a note is ever echoed.
EXCLUSION_TEXT = {
    "notes_unreadable": "notes unreadable",
    "notes_not_read": "notes not read",
    "no_record": "no cost record by the token user",
    "legacy_record": "legacy record with no window start (orchestrator row not windowed)",
    "mixed_records": "legacy and windowed records: partial",
    "unparsed_record": "a cost record that does not parse",
    "no_usd": "a record with no USD total",
}

_COST_TABLE = []


def _cost_table():
    """scripts/cost-table.py (a hyphenated name, so loaded by path): the one parser of the cost
    records and the glab notes reader, so this reader writes no second regex for them."""
    if not _COST_TABLE:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cost-table.py")
        spec = importlib.util.spec_from_file_location("cost_table_for_kaizen", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _COST_TABLE.append(mod)
    return _COST_TABLE[0]


def record_cost(own):
    """(est USD, total tokens, record count, exclusion code) from an MR's own cost records
    (cost-table.own_records items). Only records that state `Window: S to U` are summed: they do not
    overlap. One legacy `Window end:` record (orchestrator row cumulative from the session start)
    makes the whole MR unreadable as a cost (`mixed_records` when windowed ones sit beside it), since leaving it out would undercount and adding it
    would double count. No figure is ever read as 0."""
    if not own:
        return None, None, 0, "no_record"
    recs = [o["rec"] for o in own]
    if any(r is None for r in recs):
        return None, None, 0, "unparsed_record"
    if any(r["start"] is None for r in recs):
        # Only windowed records would undercount (the legacy one holds the rest); never sum just that part.
        return None, None, 0, ("mixed_records" if any(r["start"] is not None for r in recs) else "legacy_record")
    usd = [r["total"].get(("usd", "all")) for r in recs]
    tok = [r["total"].get(("tok", "all")) for r in recs]
    if any(v is None for v in usd):
        return None, None, len(recs), "no_usd"
    total_usd = float(sum(usd, decimal.Decimal(0)))
    return total_usd, (None if any(v is None for v in tok) else sum(tok)), len(recs), None


def mr_cost_records(mr):
    """The MR's own cost records, or an exclusion code. `cost_records` (set by attach_cost_records
    from live notes) wins; offline an MR carries GitLab note objects in `notes` and the token user's
    id in `token_user_id` (notes by anyone else are never read), or `notes_unreadable: true`."""
    if mr.get("notes_unreadable") or (mr.get("cost_records") or {}).get("error"):
        return None, "notes_unreadable"
    if isinstance(mr.get("cost_records"), dict):
        return mr["cost_records"]["records"], None
    if isinstance(mr.get("notes"), list):
        uid = mr.get("token_user_id")
        own, _foreign = _cost_table().own_records(mr["notes"], uid if isinstance(uid, int) else None)
        return own, None
    return None, "notes_not_read"


def cost_figures(mr) -> dict:
    """One MR's cost record: state `disabled` (the `cost-ledger: off` marker), `recorded` (at least
    one well-formed figure in `## Gates`) or `none`; the figures (None when absent or malformed,
    never 0); and whether any cost line in `## Gates` failed scripts/cost_ledger_lines.py's checks.

    `est_cost_usd` is the sum of the MR's windowed cost records, not the `## Gates` snapshot
    (`gates_est_cost_usd`, kept for reference only: its orchestrator share is repeated by every MR
    of a wave). `exclusion` says why a `recorded` MR has no `est_cost_usd` (#2154)."""
    desc = mr.get("description") or ""
    fig = {
        "iid": mr.get("iid"),
        "class": change_class(mr),
        "subagent_tokens": cost_lines.subagent_tokens(desc),
        "orchestrator_tokens": cost_lines.orchestrator_tokens(desc),
        "gates_est_cost_usd": cost_lines.est_cost_usd(desc),
        "est_cost_usd": None,
        "record_tokens": None,
        "records": 0,
        "exclusion": None,
        "malformed": bool(cost_lines.check_body(desc)),
    }
    if cost_lines.ledger_disabled(desc):
        fig["state"] = "disabled"
    elif any(fig[k] is not None for k in ("subagent_tokens", "orchestrator_tokens", "gates_est_cost_usd")):
        fig["state"] = "recorded"
        own, why = mr_cost_records(mr)
        if why is None:
            fig["est_cost_usd"], fig["record_tokens"], fig["records"], why = record_cost(own)
        fig["exclusion"] = why
    else:
        fig["state"] = "none"
    return fig


def attach_cost_records(mrs, project, fetch=None):
    """Read the cost comments of each MR that carries a `## Gates` cost line (bounded: an MR with no
    cost line, or `cost-ledger: off`, costs no API call) and set `cost_records` on it. A failed read
    sets {"error": ...}, which the report counts as "notes unreadable"; it is never read as 0.
    `fetch(iid)` -> (own records, error) is injectable for tests; the default is cost-table's
    glab reader, scoped to `project` and reading only the token user's own notes."""
    ct = _cost_table()
    if fetch is None:
        ct.PROJECT["path"] = project
        cache = {}

        def api(method, path, payload=None):
            if path == "user" and "user" in cache:
                return cache["user"]
            out = ct.glab_api(method, path, payload)
            if path == "user" and out[0] == 0:
                cache["user"] = out
            return out

        def fetch(iid):
            own, _foreign, err = ct.read_records(iid, api)
            return own, err
    try:
        for mr in mrs:
            iid = mr.get("iid")
            if not isinstance(iid, int) or isinstance(iid, bool):
                continue
            if cost_figures(dict(mr, cost_records=None, notes=None))["state"] != "recorded":
                continue
            own, err = fetch(iid)
            mr["cost_records"] = {"error": True} if err else {"records": own}
    finally:
        ct.PROJECT["path"] = None


def _mean(values):
    return round(sum(values) / len(values), 2) if values else None


def _cost_state(figs) -> str:
    """`recorded` if any MR recorded a figure, else `disabled` if any said `cost-ledger: off`, else
    `none`. A disabled set is reported as its own state, never as 0 or as "not recorded yet"."""
    if any(f["state"] == "recorded" for f in figs):
        return "recorded"
    if any(f["state"] == "disabled" for f in figs):
        return "disabled"
    return "none"


def analyze_cost(figs, gate_runs) -> dict:
    """Cost by change class and by gate. `gate_runs` maps gate -> {"ran": [(iid, findings)],
    "na": [iid]}. Only `recorded` MRs feed a mean; `disabled` MRs are counted, never averaged.

    The per-gate figures are the MR-level estimate of the MRs a gate ran on (or was n/a on), not
    the gate's own cost: the ledger records cost per MR, not per gate. `findings_per_usd` is the
    gate's findings on those MRs over their summed estimate."""
    usd = {f["iid"]: f["est_cost_usd"] for f in figs if f["state"] == "recorded" and f["est_cost_usd"] is not None}
    classes = {}
    for cls in sorted({f["class"] for f in figs}):
        rs = [f for f in figs if f["class"] == cls]
        rec = [f for f in rs if f["state"] == "recorded"]
        classes[cls] = {
            "mrs": len(rs),
            "recorded": len(rec),
            "disabled": sum(1 for f in rs if f["state"] == "disabled"),
            "state": _cost_state(rs),
            "est_costed": sum(1 for f in rec if f["est_cost_usd"] is not None),
            "mean_est_cost_usd": _mean([f["est_cost_usd"] for f in rec if f["est_cost_usd"] is not None]),
            "mean_subagent_tokens": _mean([f["subagent_tokens"] for f in rec if f["subagent_tokens"] is not None]),
        }
    gates = {}
    for name, runs in sorted(gate_runs.items()):
        ran = [(iid, n) for iid, n in runs["ran"] if iid in usd]
        na = [iid for iid in runs["na"] if iid in usd]
        if not ran and not na:
            continue
        spent = sum(usd[iid] for iid, _ in ran)
        gates[name] = {
            "ran_costed": len(ran),
            "mean_est_cost_usd_ran": _mean([usd[iid] for iid, _ in ran]),
            "na_costed": len(na),
            "mean_est_cost_usd_na": _mean([usd[iid] for iid in na]),
            "findings_per_usd": round(sum(n for _, n in ran) / spent, 2) if spent > 0 else None,
        }
    return {
        "mrs": len(figs),
        "recorded": sum(1 for f in figs if f["state"] == "recorded"),
        "disabled": sum(1 for f in figs if f["state"] == "disabled"),
        "none": sum(1 for f in figs if f["state"] == "none"),
        "malformed": sorted(f["iid"] for f in figs if f["malformed"] and f["iid"] is not None),
        "state": _cost_state(figs),
        "est_costed": len(usd),
        # Recorded MRs left out of every cost mean, by reason code -> MR ids (#2154). Never read as 0.
        "excluded": {code: sorted(f["iid"] for f in figs if f["exclusion"] == code)
                     for code in EXCLUSION_TEXT if any(f["exclusion"] == code for f in figs)},
        "by_class": classes,
        "by_gate": gates,
    }


@dataclass
class GateStats:
    name: str
    zero: int = 0            # numeric outcome, 0 findings
    positive: int = 0        # numeric outcome, >0 findings
    positive_total: int = 0  # sum of finding counts across positive runs
    na: int = 0              # n/a — gate's scope excluded this diff
    skipped: int = 0         # gate applied but was deliberately not run
    unscored: list = field(default_factory=list)  # non-numeric outcomes (raw text)
    malformed: int = 0       # line matched "gate:" but outcome was empty/junk

    @property
    def runs(self) -> int:
        """Numeric (findings-bearing) runs only. n/a is not a run; skipped is
        not a run (the gate did not execute); unscored deliverable outcomes
        are not counted here because they carry no yield information."""
        return self.zero + self.positive

    @property
    def yield_pct(self):
        if self.runs == 0:
            return None
        return round(100.0 * self.positive / self.runs, 1)

    @property
    def verdict(self) -> str:
        if self.name in DELIVERABLE_GATES:
            if self.runs == 0:
                return "deliverable gate — no yield to compute"
            # A handful of MRs report this gate with a numeric findings
            # count anyway; the count is real but incidental — this gate's
            # mandated output is an artifact, not a finding, so don't let a
            # small numeric sample drive a fast-path/load-bearing verdict.
            return f"deliverable gate — {self.runs} numeric line(s) seen, treat as incidental"
        if self.runs < MIN_RUNS_FOR_VERDICT:
            return f"inconclusive (n={self.runs} < {MIN_RUNS_FOR_VERDICT})"
        y = self.yield_pct
        # Compare the integer counts feeding yield_pct rather than the rounded
        # float itself (S1244) — 0% yield means no positive run was seen, which
        # `self.positive == 0` states directly without going through rounding.
        if self.positive == 0:
            return "fast-path candidate (0% yield, narrow the trigger — never delete)"
        if y is not None and y > LOAD_BEARING_YIELD_PCT:
            return "load-bearing (resist trimming)"
        return "normal"


def parse_outcome(outcome: str):
    """Classify one gate line's outcome text.

    Returns a tuple (kind, value) where kind is one of
    "findings", "na", "skipped", "other".
    """
    m = FINDINGS_RE.match(outcome)
    if m:
        return ("findings", int(m.group("n")))
    if NA_RE.match(outcome):
        return ("na", None)
    if SKIPPED_RE.match(outcome):
        return ("skipped", None)
    return ("other", outcome.strip())


def find_gates_section_present(description: str) -> bool:
    """Adoption signal: does this MR carry a `## Gates` heading at all?

    A gate absent from the ledger is invisible, not clean — so adoption is
    tracked independently of whether any individual gate line parses."""
    return bool(GATES_HEADING_RE.search(description or ""))


def extract_gate_lines(description: str):
    """Yield (name, outcome_text) for every line in the description that
    looks like a gate ledger line, anywhere in the description.

    Deliberately not scoped to the text between `## Gates` and the next `##`
    heading: real MRs put gate lines inside fenced code blocks, and a
    "### What the gates changed" subsection after the ledger uses bold names
    (`**architect** — ...`) rather than `gate:` lines, so it never collides
    with this pattern. Scanning the whole description is simpler and matches
    every real sample seen; if a false positive class turns up later, tighten
    this to a section-bounded scan then.
    """
    for line in (description or "").splitlines():
        m = GATE_LINE_RE.match(line)
        if not m:
            continue
        name = m.group("name").strip().lower()
        outcome = m.group("outcome").strip()
        yield name, outcome


def analyze(mrs):
    """Compute per-gate stats and adoption across a list of MR objects."""
    gates: dict[str, GateStats] = {}
    adopted = 0
    total = len(mrs)
    per_mr_malformed = []
    figs = []
    gate_runs: dict[str, dict] = {}

    for idx, mr in enumerate(mrs):
        desc = mr.get("description") or ""
        iid = mr.get("iid")
        if find_gates_section_present(desc):
            adopted += 1
        fig = cost_figures(mr)
        # A missing iid would collide in the cost join; key it by position instead.
        fig["iid"] = iid if iid is not None else "#%d" % idx
        figs.append(fig)
        seen_ran, seen_na = set(), set()
        for name, outcome_text in extract_gate_lines(desc):
            if name == "completeness-check" and ROUND2_RE.search(outcome_text):
                name += ROUND2_SUFFIX
            gs = gates.setdefault(name, GateStats(name=name))
            if not outcome_text:
                gs.malformed += 1
                per_mr_malformed.append((iid, name, outcome_text))
                continue
            kind, value = parse_outcome(outcome_text)
            runs = gate_runs.setdefault(name, {"ran": [], "na": []})
            if kind == "findings" and name not in seen_ran:
                seen_ran.add(name)
                runs["ran"].append((fig["iid"], value))
            elif kind == "na" and name not in seen_na and name not in seen_ran:
                seen_na.add(name)
                runs["na"].append(fig["iid"])
            if kind == "findings":
                if value == 0:
                    gs.zero += 1
                else:
                    gs.positive += 1
                    gs.positive_total += value
            elif kind == "na":
                gs.na += 1
            elif kind == "skipped":
                gs.skipped += 1
            else:
                gs.unscored.append((iid, outcome_text))

    for runs in gate_runs.values():
        ran_iids = {iid for iid, _ in runs["ran"]}
        runs["na"] = [iid for iid in runs["na"] if iid not in ran_iids]

    return {
        "window": total,
        "adopted": adopted,
        "gates": gates,
        "malformed": per_mr_malformed,
        "cost": analyze_cost(figs, gate_runs),
    }


# GitLab caps per_page at 100; a window outside 1..100 is a typo, not a request.
MAX_WINDOW = 100
_PROJECT_RE = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*")


def validate_window(value) -> int:
    """argparse ``type=`` and sink guard: a positive integer MR count."""
    try:
        window = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError(f"--window must be an integer, got {value!r}") from None
    if not 1 <= window <= MAX_WINDOW:
        raise argparse.ArgumentTypeError(f"--window must be between 1 and {MAX_WINDOW}, got {window}")
    return window


def validate_project(value: str) -> str:
    """argparse ``type=`` and sink guard: a plain ``group/project`` path.

    The value is interpolated into the ``glab api`` argv; whitelisting its
    characters keeps option-like (``-x``) or query-smuggling (``?``/``&``/``#``)
    input out of it even though argv is list-form (#1377, S8705).
    """
    # fullmatch (not `$`, which accepts a trailing newline); a segment made only
    # of dots (`.`/`..`) would climb the API path.
    if (
        not _PROJECT_RE.fullmatch(value)
        or value.startswith("-")
        or any(set(seg) <= {"."} for seg in value.split("/"))
    ):
        raise argparse.ArgumentTypeError(f"--project must look like group/project, got {value!r}")
    return value


# Allowlist, not just a format check: the argv gets the constant value from this
# map, never the CLI string, so no user text reaches the subprocess (S8705).
_KNOWN_PROJECTS = {
    "visiban/visiban": "visiban%2Fvisiban",
    "visiban/visiban-enterprise": "visiban%2Fvisiban-enterprise",
}


def load_mrs(args) -> list:
    if args.input:
        with open(resolve_within(cli_roots(), args.input), encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        project_path = _KNOWN_PROJECTS.get(validate_project(args.project))
        if project_path is None:
            print(f"error: --project must be one of {', '.join(_KNOWN_PROJECTS)}", file=sys.stderr)
            sys.exit(1)
        window = validate_window(args.window)
        # Resolve glab once, and pass the endpoint as a single list-form argv
        # element (no shell). project_path is percent-encoded and window is an
        # int, so neither can start an option or add a query parameter.
        glab = shutil.which("glab")
        if glab is None:
            print("error: glab not found on PATH", file=sys.stderr)
            sys.exit(1)
        query = urllib.parse.urlencode(
            {"state": "merged", "per_page": window, "order_by": "updated_at", "sort": "desc"}
        )
        cmd = [glab, "api", f"projects/{project_path}/merge_requests?{query}"]
        try:
            out = subprocess.check_output(cmd, text=True)
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            print(f"error: failed to fetch merged MRs via glab: {exc}", file=sys.stderr)
            sys.exit(1)
        data = json.loads(out)
    if not isinstance(data, list):
        print("error: expected a JSON list of MR objects", file=sys.stderr)
        sys.exit(1)
    return data[: args.window] if args.input else data


def render_text(result) -> str:
    lines = []
    total = result["window"]
    adopted = result["adopted"]
    pct = round(100.0 * adopted / total, 1) if total else 0.0
    lines.append(f"## Gate ledger — last {total} merged MRs")
    lines.append("")
    lines.append(
        f"`## Gates` adoption: {adopted}/{total} ({pct}%) — a gate absent from "
        "an unadopted MR's description is invisible, not clean. Yield below is "
        "computed only over MRs that carry the ledger, so it is a read of a "
        f"{pct}% sample, not the whole branch population."
    )
    lines.append("")
    header = f"{'gate':<24} {'runs':>5} {'zero':>5} {'>0':>4} {'n/a':>5} {'skipped':>8} {'unscored':>9}  yield   verdict"
    lines.append(header)
    lines.append("-" * len(header))

    for name, gs in sorted(result["gates"].items(), key=lambda kv: kv[0]):
        y = gs.yield_pct
        y_str = "n/a" if y is None else f"{y}%"
        lines.append(
            f"{name:<24} {gs.runs:>5} {gs.zero:>5} {gs.positive:>4} {gs.na:>5} "
            f"{gs.skipped:>8} {len(gs.unscored):>9}  {y_str:<6}  {gs.verdict}"
        )

    if result["malformed"]:
        lines.append("")
        lines.append(f"Malformed gate lines (matched `gate:` but no parseable outcome): {len(result['malformed'])}")
        for iid, name, text in result["malformed"][:10]:
            lines.append(f"  !{iid}: gate: {name} — {text!r}")

    lines.append("")
    lines.extend(render_cost(result["cost"]))
    return "\n".join(lines)


def _fmt(v, kind):
    """A cost cell: `-` for no figure (never 0), else USD, a token count, or a ratio."""
    if v is None:
        return "-"
    if kind == "usd":
        return "%.2f USD" % v
    if kind == "tok":
        return "{:,}".format(int(round(v)))
    return "%.2f" % v


def render_cost(cost) -> list:
    """The cost section of the text report. A disabled ledger is its own state, never 0."""
    out = ["## Cost — `est-cost-usd:` is a list-price estimate, not a billed amount (docs/development/cost-ledger.md)", ""]
    out.append(
        f"Cost ledger: {cost['recorded']} recorded, {cost['disabled']} disabled (`cost-ledger: off`), "
        f"{cost['none']} with no cost line, of {cost['mrs']} MRs. Disabled MRs are left out of every mean, "
        "never counted as 0."
    )
    if cost["malformed"]:
        out.append("MRs with a malformed or contradictory cost line (malformed figures are ignored, not read as 0): "
                   + ", ".join("!%s" % i for i in cost["malformed"][:10]))
    if cost["state"] == "disabled":
        out.append(f"(cost ledger disabled on {cost['disabled']} MR(s): nothing recorded, by choice)")
        return out
    if cost["state"] == "none":
        out.append("No MR carries a `subagent-tokens:`, `orchestrator-tokens:` or `est-cost-usd:` line yet.")
        return out
    out.append(
        "Per-MR est. cost is the sum of the MR's `## Cost of this MR` records that state `Window: S to U` "
        "(they do not overlap), not the `## Gates` `est-cost-usd:` snapshot, whose orchestrator share every MR of a wave repeats. "
        f"Costed from records: {cost['est_costed']} of {cost['recorded']} recorded MRs."
    )
    for code, iids in cost["excluded"].items():
        out.append(f"Excluded from every cost mean, {EXCLUSION_TEXT[code]}: {len(iids)} MR(s), "
                   + ", ".join("!%s" % i for i in iids[:10]) + (", ..." if len(iids) > 10 else ""))
    out.append("")
    out.append("By change class (branch prefix; `orchestrator-tokens:` is session spend shared across a wave, so it is "
               "never averaged here):")
    header = f"{'class':<8} {'MRs':>4} {'recorded':>9} {'disabled':>9} {'mean est. cost':>15} {'mean subagent-tokens':>21}"
    out.append(header)
    out.append("-" * len(header))
    for cls, c in cost["by_class"].items():
        if c["state"] == "disabled":
            usd, tok = "disabled", "disabled"
        elif c["state"] == "none":
            usd, tok = "not recorded", "not recorded"
        else:
            usd, tok = _fmt(c["mean_est_cost_usd"], "usd"), _fmt(c["mean_subagent_tokens"], "tok")
        out.append(f"{cls:<8} {c['mrs']:>4} {c['recorded']:>9} {c['disabled']:>9} {usd:>15} {tok:>21}")
    out.append("")
    if not cost["by_gate"]:
        out.append("By gate: no MR has a windowed cost record to read yet.")
        return out
    out.append("By gate (the MR-level estimate of the MRs it ran on vs was n/a on; not the gate's own cost):")
    header = f"{'gate':<28} {'ran':>4} {'mean est. cost (ran)':>21} {'n/a':>4} {'mean est. cost (n/a)':>21} {'findings/USD':>13}"
    out.append(header)
    out.append("-" * len(header))
    for name, g in cost["by_gate"].items():
        out.append(
            f"{name:<28} {g['ran_costed']:>4} {_fmt(g['mean_est_cost_usd_ran'], 'usd'):>21} {g['na_costed']:>4} "
            f"{_fmt(g['mean_est_cost_usd_na'], 'usd'):>21} {_fmt(g['findings_per_usd'], 'ratio'):>13}"
        )
    return out


def to_jsonable(result):
    gates_out = {}
    for name, gs in result["gates"].items():
        gates_out[name] = {
            "runs": gs.runs,
            "zero": gs.zero,
            "positive": gs.positive,
            "positive_total": gs.positive_total,
            "na": gs.na,
            "skipped": gs.skipped,
            "unscored": len(gs.unscored),
            "unscored_samples": gs.unscored[:5],
            "malformed": gs.malformed,
            "yield_pct": gs.yield_pct,
            "verdict": gs.verdict,
        }
    return {
        "window": result["window"],
        "adopted": result["adopted"],
        "adoption_pct": round(100.0 * result["adopted"] / result["window"], 1) if result["window"] else 0.0,
        "gates": gates_out,
        "malformed_count": len(result["malformed"]),
        "cost": result["cost"],
    }


def _gate_row_close(got: dict, want: dict) -> bool:
    """Dict equality that compares the float fields with a tolerance (python:S1244)."""
    if got.keys() != want.keys():
        return False
    return all(
        math.isclose(got[k], want[k]) if isinstance(want[k], float) else got[k] == want[k]
        for k in want
    )


def _attach_check(em, ct, note, rec, t) -> bool:
    """attach_cost_records with an injected fetch: one MR read, one MR with no cost line not read,
    one failed read marked unreadable (and then excluded, never 0)."""
    def desc(*lines):
        return "## Gates\n" + "\n".join(lines) + "\n"
    mrs = [{"iid": 50, "source_branch": "feat/50", "description": desc("est-cost-usd: 3.00")},
           {"iid": 51, "source_branch": "feat/51", "description": desc(f"- gate: perf-check {em} n/a (x)")},
           {"iid": 52, "source_branch": "feat/52", "description": desc("subagent-tokens: 5")}]
    asked = []

    def fetch(iid):
        asked.append(iid)
        return ([] , "boom") if iid == 52 else (ct.own_records([note(1, rec("1.50", t(8), t(9)))], 7)[0], None)

    attach_cost_records(mrs, "visiban/visiban", fetch=fetch)
    c = analyze(mrs)["cost"]
    return (asked == [50, 52] and "cost_records" not in mrs[1] and math.isclose(c["by_class"]["feat"]["mean_est_cost_usd"], 1.5)
            and c["excluded"] == {"notes_unreadable": [52]})


def self_test() -> int:
    """Offline proof that the ledger and cost readers still fire (#1093 house rule). The wider
    regression suite is scripts/tests/kaizen_gate_ledger.test.sh, run in the same CI job."""
    em = "\u2014"

    def mr(iid, branch, *lines):
        return {"iid": iid, "source_branch": branch,
                "description": "## Gates\n" + "\n".join(lines) + "\n\n## Notes\nsubagent-tokens: 777\n"}

    ct = _cost_table()

    def rec(usd, since, until, k=1, prior=None):
        body = f"## Gates\nsubagent-tokens: 100\norchestrator-tokens: 900\nest-cost-usd: {usd}\n"
        return "\n".join(ct.comment_lines(body, 1, until, None, record=k, since=since, prior=prior))

    def note(nid, body, uid=7):
        return {"id": nid, "system": False, "author": {"id": uid}, "body": body}

    t = lambda h: "2026-11-05T%02d:00:00Z" % h  # noqa: E731
    r1 = rec("2.00", t(8), t(9))
    r2 = rec("1.00", t(9), t(10), k=2, prior={"records": [ct.parse_record(r1)], "gaps": []})
    legacy = rec("20.00", None, t(12))

    def cmr(iid, branch, gates_usd, *notes, **kw):
        m = mr(iid, branch, f"- gate: regression-check {em} 1 finding (sonnet)", "subagent-tokens: 100",
               f"est-cost-usd: {gates_usd}")
        return dict(m, token_user_id=7, notes=list(notes), **kw)

    wave = [cmr(30, "feat/30", "5.00", note(1, rec("1.00", t(8), t(9)))),
            cmr(31, "feat/31", "9.00", note(2, rec("2.00", t(9), t(10)))),
            cmr(32, "feat/32", "14.00", note(3, rec("3.00", t(10), t(11))))]
    cc = analyze(wave + [cmr(33, "feat/33", "20.00", note(4, legacy)),
                         cmr(34, "fix/34", "99.00", note(5, r1), note(6, r2)),
                         cmr(35, "fix/35", "7.00"), cmr(36, "docs/36", "7.00", notes_unreadable=True),
                         cmr(37, "chore/37", "7.00", note(7, rec("50.00", t(8), t(9)), uid=8))])["cost"]
    mrs = [
        mr(1, "feat/1", f"- gate: regression-check {em} 2 findings (sonnet)", f"- gate: perf-check {em} n/a (no viewset)",
           "subagent-tokens: 1000", "est-cost-usd: 2.00 (prices 2026-11-03)"),
        mr(2, "feat/2", f"- gate: regression-check {em} 0 findings (sonnet)", f"- gate: perf-check {em} 1 finding (sonnet)",
           "subagent-tokens: 3000", "est-cost-usd: 4.00"),
        mr(3, "fix/3", f"- gate: regression-check {em} 1 finding (sonnet)", "cost-ledger: off"),
        mr(4, "docs/4", f"- gate: regression-check {em} skipped (user said so)", "subagent-tokens: ~5k"),
        {"iid": 5, "source_branch": "chore/5", "description": "## Summary\nno ledger\n"},
    ]
    mrs[0].update(token_user_id=7, notes=[note(8, rec("2.00", t(8), t(9)))])
    mrs[1].update(token_user_id=7, notes=[note(9, rec("4.00", t(8), t(9)))])
    r = analyze(mrs)
    c = r["cost"]
    rc = r["gates"]["regression-check"]
    checks = [
        ("adoption 4/5", r["adopted"] == 4 and r["window"] == 5),
        ("regression-check: 3 runs, 2 positive, 1 skipped", (rc.runs, rc.positive, rc.skipped) == (3, 2, 1)),
        ("perf-check: n/a is not a run", (r["gates"]["perf-check"].runs, r["gates"]["perf-check"].na) == (1, 1)),
        ("cost states: 2 recorded, 1 disabled, 2 none", (c["recorded"], c["disabled"], c["none"]) == (2, 1, 2)),
        ("a `## Notes` figure is not read", math.isclose(c["by_class"]["feat"]["mean_subagent_tokens"], 2000.0)),
        ("feat mean est. cost 3.00", math.isclose(c["by_class"]["feat"]["mean_est_cost_usd"], 3.0)),
        ("a disabled class is disabled, its mean None", c["by_class"]["fix"]["state"] == "disabled"
         and c["by_class"]["fix"]["mean_est_cost_usd"] is None),
        ("a malformed cost line is flagged, not read as 0", c["malformed"] == [4] and c["by_class"]["docs"]["state"] == "none"),
        ("per gate: ran vs n/a and findings per USD", _gate_row_close(c["by_gate"]["perf-check"], {
            "ran_costed": 1, "mean_est_cost_usd_ran": 4.0, "na_costed": 1, "mean_est_cost_usd_na": 2.0, "findings_per_usd": 0.25})),
        ("regression-check findings per USD = 2 / 6.00", math.isclose(c["by_gate"]["regression-check"]["findings_per_usd"], 0.33)),
        ("an all-off window reads disabled", analyze([mrs[2]])["cost"]["state"] == "disabled"
         and "nothing recorded, by choice" in "\n".join(render_cost(analyze([mrs[2]])["cost"]))),
        ("an empty window reads not recorded yet, never 0", analyze([mrs[4]])["cost"]["state"] == "none"
         and "line yet" in "\n".join(render_cost(analyze([mrs[4]])["cost"]))),
        # #2154: per-MR cost is the sum of windowed records, never the overlapping `## Gates` snapshot.
        ("a wave of overlapping snapshots costs its records (mean 2.00), not the snapshots (9.33)",
         math.isclose(analyze(wave)["cost"]["by_class"]["feat"]["mean_est_cost_usd"], 2.0)),
        ("a multi-record MR sums its records (3.00), not its 99.00 snapshot", math.isclose(cc["by_class"]["fix"]["mean_est_cost_usd"], 3.0)),
        ("a legacy record is excluded, not read as 0 or 20.00", cc["excluded"].get("legacy_record") == [33]),
        ("a legacy plus a windowed record is excluded as partial, not summed over its windowed part",
         analyze([cmr(38, "feat/38", "5.00", note(10, legacy), note(11, r2))])["cost"]["excluded"] == {"mixed_records": [38]}),
        ("no record, a foreign-author record and unreadable notes are each excluded",
         cc["excluded"].get("no_record") == [35, 37] and cc["excluded"].get("notes_unreadable") == [36]),
        ("excluded MRs are left out of the feat mean (3 of 4 recorded costed)",
         math.isclose(cc["by_class"]["feat"]["mean_est_cost_usd"], 2.0) and cc["by_class"]["feat"]["est_costed"] == 3),
        ("an MR whose notes were never read is excluded, not 0",
         analyze([mr(40, "feat/40", f"- gate: perf-check {em} n/a (x)", "est-cost-usd: 3.00")])["cost"]["excluded"] == {"notes_not_read": [40]}),
        ("the report counts and names the exclusions", "legacy record with no window start" in "\n".join(render_cost(cc))
         and "!33" in "\n".join(render_cost(cc)) and "notes unreadable" in "\n".join(render_cost(cc))),
        ("attach_cost_records reads only MRs with a cost line, and a failed read is `notes unreadable`",
         _attach_check(em, ct, note, rec, t)),
        ("text and JSON render", "## Cost" in render_text(r) and json.dumps(to_jsonable(r))),
    ]
    fails = [name for name, ok in checks if not ok]
    for name in fails:
        print("self-test FAIL: " + name, file=sys.stderr)
    if fails:
        return 1
    print("kaizen_gate_ledger self-test OK (%d checks)" % len(checks))
    return 0


def main():
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", type=validate_project, default=DEFAULT_PROJECT, help="GitLab project: visiban/visiban or visiban/visiban-enterprise (default: %(default)s)")
    parser.add_argument("--window", type=validate_window, default=DEFAULT_WINDOW, help="Number of most-recently-merged MRs to audit (default: %(default)s)")
    parser.add_argument("--input", help="Read MR objects from this local JSON file instead of calling glab (offline/test mode)")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON instead of a text table")
    args = parser.parse_args()

    mrs = load_mrs(args)
    if not args.input:
        # Live only: read the cost comments of the MRs that carry a cost line (#2154). Offline MRs bring their own `notes`.
        attach_cost_records(mrs, args.project)
    result = analyze(mrs)

    if args.json:
        print(json.dumps(to_jsonable(result), indent=2))
    else:
        print(render_text(result))


if __name__ == "__main__":
    main()
