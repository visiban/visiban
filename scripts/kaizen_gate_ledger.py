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
"""
from __future__ import annotations

import argparse
import json
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

    for mr in mrs:
        desc = mr.get("description") or ""
        iid = mr.get("iid")
        if find_gates_section_present(desc):
            adopted += 1
        for name, outcome_text in extract_gate_lines(desc):
            if name == "completeness-check" and ROUND2_RE.search(outcome_text):
                name += ROUND2_SUFFIX
            gs = gates.setdefault(name, GateStats(name=name))
            if not outcome_text:
                gs.malformed += 1
                per_mr_malformed.append((iid, name, outcome_text))
                continue
            kind, value = parse_outcome(outcome_text)
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

    return {
        "window": total,
        "adopted": adopted,
        "gates": gates,
        "malformed": per_mr_malformed,
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

    return "\n".join(lines)


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
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", type=validate_project, default=DEFAULT_PROJECT, help="GitLab project: visiban/visiban or visiban/visiban-enterprise (default: %(default)s)")
    parser.add_argument("--window", type=validate_window, default=DEFAULT_WINDOW, help="Number of most-recently-merged MRs to audit (default: %(default)s)")
    parser.add_argument("--input", help="Read MR objects from this local JSON file instead of calling glab (offline/test mode)")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON instead of a text table")
    args = parser.parse_args()

    mrs = load_mrs(args)
    result = analyze(mrs)

    if args.json:
        print(json.dumps(to_jsonable(result), indent=2))
    else:
        print(render_text(result))


if __name__ == "__main__":
    main()
