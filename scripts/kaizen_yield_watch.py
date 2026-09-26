#!/usr/bin/env python3
"""Continuous /kaizen signal: incremental gate-yield watch (issue #1144).

`/kaizen` (issue #1094) computes per-gate yield from the MR `## Gates` ledger,
but only when someone remembers to run it. This script keeps a *running*
count instead: it reads a committed JSON state file, folds in only the MRs
merged since the last run, and reports every (gate, diff-shape) pair whose
consecutive-zero streak has reached the threshold. With explicit opt-in it
files one GitLab issue per new candidate proposing the narrowing. It NEVER
edits CLAUDE.md or the fast-path table -- that stays a reviewed change.

Reuse, not reinvention: ledger grammar and the gate-line parser come from
scripts/kaizen_gate_ledger.py (the mechanical half of /kaizen), and the
threshold is its MIN_RUNS_FOR_VERDICT (10). /kaizen states no *consecutive*
threshold and no diff-shape dimension (it computes per-gate totals over a
window), so this script defines both -- see docs/development/kaizen-yield-watch.md.

Outcome semantics (never conflated -- that is the whole signal):
  N findings (N>0)  -> run; resets the streak
  0 findings        -> run; streak += 1
  n/a               -> gate did not apply; streak untouched, not a run
  skipped           -> compliance signal; streak untouched, not a run
  deliverable/prose -> no yield information; streak untouched
Deliverable gates (changelog, docs-writer, test-scaffold) are never tracked.

Usage:
  python3 scripts/kaizen_yield_watch.py                       # report only
  python3 scripts/kaizen_yield_watch.py --write-state FILE    # also emit new state
  python3 scripts/kaizen_yield_watch.py --file-issues         # opt-in: file issues
  python3 scripts/kaizen_yield_watch.py --input mrs.json      # offline
  python3 scripts/kaizen_yield_watch.py --self-test

Fails OPEN: any inconclusive GitLab API lookup is a warning and exit 0 -- this
is signal gathering, not a correctness gate, and must never block an MR.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import kaizen_gate_ledger as ledger  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_STATE = os.path.join(REPO_ROOT, ".claude", "kaizen-yield-state.json")
DEFAULT_DECLINED = os.path.join(REPO_ROOT, ".claude", "kaizen-declined.json")
THRESHOLD = ledger.MIN_RUNS_FOR_VERDICT  # consecutive zero-finding runs
SHAPES = ("feat", "fix", "docs", "chore")
STATE_VERSION = 1


def warn(msg):
    print(f"kaizen-yield-watch: WARNING - {msg}", file=sys.stderr)


def diff_shape(mr):
    """Bucket an MR by its branch prefix (feat/fix/docs/chore, else other).

    The fast-path table is organized by change class, and the branch prefix is
    the only class signal the API returns without fetching diffs.
    """
    prefix = (mr.get("source_branch") or "").split("/", 1)[0].lower()
    return prefix if prefix in SHAPES else "other"


def empty_state():
    return {"version": STATE_VERSION, "last_merged_at": "", "last_iid": 0,
            "threshold": THRESHOLD, "pairs": {}, "proposed": []}


def load_state(path):
    if not os.path.exists(path):
        return empty_state()
    with open(path, encoding="utf-8") as fh:
        state = json.load(fh)
    for k, v in empty_state().items():
        state.setdefault(k, v)
    return state


def load_declined(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return {d["id"] for d in json.load(fh)}
    except (OSError, ValueError, KeyError, TypeError):
        return set()


def mr_outcomes(mr):
    """One outcome per tracked gate per MR: 'positive' | 'zero'.

    Gates with n/a, skipped, prose or malformed outcomes yield nothing, so
    they cannot move a streak. If a gate appears twice, positive wins.
    """
    out = {}
    for name, text in ledger.extract_gate_lines(mr.get("description") or ""):
        if name in ledger.DELIVERABLE_GATES or not text:
            continue
        kind, value = ledger.parse_outcome(text)
        if kind != "findings":
            continue
        if value > 0:
            out[name] = "positive"
        else:
            out.setdefault(name, "zero")
    return out


def fold(state, mrs):
    """Fold MRs (any order) newer than the state watermark into the state.

    Idempotent: MRs at or before (last_merged_at, last_iid) are skipped, so
    re-running with an uncommitted state file never double-counts.
    """
    mark = (state["last_merged_at"], state["last_iid"])
    fresh = sorted(
        (m for m in mrs if m.get("merged_at") and
         (m["merged_at"], m.get("iid", 0)) > mark),
        key=lambda m: (m["merged_at"], m.get("iid", 0)))
    for mr in fresh:
        shape = diff_shape(mr)
        for gate, outcome in mr_outcomes(mr).items():
            p = state["pairs"].setdefault(
                f"{gate}|{shape}",
                {"streak": 0, "runs": 0, "zero": 0, "positive": 0, "evidence": []})
            p["runs"] += 1
            if outcome == "zero":
                p["zero"] += 1
                p["streak"] += 1
                p["evidence"] = (p["evidence"] + [mr.get("iid")])[-state["threshold"]:]
            else:
                p["positive"] += 1
                p["streak"] = 0
                p["evidence"] = []
        state["last_merged_at"], state["last_iid"] = mr["merged_at"], mr.get("iid", 0)
    # A streak that broke may be re-raised later.
    state["proposed"] = [k for k in state["proposed"]
                         if state["pairs"].get(k, {}).get("streak", 0) >= state["threshold"]]
    return len(fresh)


def candidates(state, declined):
    """Pairs at/over threshold, not already proposed, not declined in kaizen."""
    found = []
    for key, p in sorted(state["pairs"].items()):
        gate, shape = key.split("|")
        if p["streak"] < state["threshold"] or key in state["proposed"]:
            continue
        if f"{gate}:fast-path-candidate" in declined:
            continue
        found.append((key, gate, shape, p))
    return found


def issue_title(gate, shape, n):
    return f"harness: narrow `{gate}` trigger on {shape} diffs ({n} consecutive 0-finding runs)"


def issue_body(gate, shape, p, threshold):
    mrs = ", ".join(f"!{i}" for i in p["evidence"])
    return (
        f"Automated proposal from the kaizen yield watch (#1144). **Human review "
        f"required; nothing has been changed.**\n\n"
        f"## Evidence\n"
        f"- Gate: `{gate}`\n- Diff shape (branch prefix): `{shape}`\n"
        f"- Consecutive runs with `0 findings`: {p['streak']} (threshold {threshold}, "
        f"the `/kaizen` MIN_RUNS_FOR_VERDICT)\n"
        f"- Lifetime on this shape: {p['runs']} runs, {p['positive']} with findings\n"
        f"- Most recent MRs in the streak: {mrs}\n\n"
        f"## Proposal\n"
        f"Consider narrowing the trigger for `{gate}` on `{shape}` diffs in the "
        f"CLAUDE.md fast-path table. Narrow the trigger, never delete the gate "
        f"(`/kaizen` rule). `n/a` and `skipped` lines were not counted.\n\n"
        f"Caveat: a streak is absence of evidence. Confirm the gate did not run "
        f"on trivially safe diffs only before acting.\n")


def api(method, url, token, data=None):
    headers = {"PRIVATE-TOKEN": token, "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def fetch_merged(args):
    """Merged MRs newer than the state watermark. Returns None on API failure."""
    if args.input:
        with open(args.input, encoding="utf-8") as fh:
            return json.load(fh)
    base = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
    project = os.environ.get("CI_PROJECT_ID") or urllib.parse.quote(args.project, safe="")
    token = os.environ.get("KAIZEN_API_TOKEN") or os.environ.get("GITLAB_API_TOKEN")
    headers = {"PRIVATE-TOKEN": token} if token else {}
    since = urllib.parse.quote(args.since_hint) if args.since_hint else ""
    mrs = []
    for page in range(1, args.max_pages + 1):
        url = (f"{base}/projects/{project}/merge_requests?state=merged&per_page=100"
               f"&page={page}&order_by=updated_at&sort=desc"
               + (f"&updated_after={since}" if since else ""))
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                batch = json.loads(resp.read().decode())
        except (urllib.error.URLError, ValueError, OSError) as exc:
            warn(f"could not fetch merged MRs ({exc}); failing open")
            return None
        mrs.extend(batch)
        if len(batch) < 100:
            break
        if page == args.max_pages:
            warn(f"hit the {args.max_pages}-page cap; MRs may be missing - commit the state artifact more often")
    return mrs


def file_issues(found, args, threshold):
    """Opt-in outward action: one issue per candidate, deduped by title."""
    token = os.environ.get("KAIZEN_API_TOKEN")
    base = os.environ.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
    project = os.environ.get("CI_PROJECT_ID") or urllib.parse.quote(args.project, safe="")
    filed = []
    for key, gate, shape, p in found:
        title = issue_title(gate, shape, p["streak"])
        if not token:
            warn("--file-issues set but KAIZEN_API_TOKEN is empty; report only")
            return filed
        try:
            q = urllib.parse.quote(f"harness: narrow `{gate}` trigger on {shape} diffs")
            existing = api("GET", f"{base}/projects/{project}/issues?state=opened"
                           f"&in=title&search={q}", token)
            if existing:
                print(f"  skip {key}: open issue already exists (#{existing[0]['iid']})")
                filed.append(key)
                continue
            made = api("POST", f"{base}/projects/{project}/issues", token, {
                "title": title, "description": issue_body(gate, shape, p, threshold),
                "labels": "ci,developer-experience,tech-debt"})
            print(f"  filed {key}: {made.get('web_url')}")
            filed.append(key)
        except (urllib.error.URLError, ValueError, OSError, KeyError) as exc:
            warn(f"issue filing for {key} inconclusive ({exc}); failing open")
    return filed


def run(args):
    state = load_state(args.state)
    args.since_hint = state["last_merged_at"]
    mrs = fetch_merged(args)
    if mrs is None:
        return 0
    n = fold(state, mrs)
    found = candidates(state, load_declined(args.declined))
    print(f"kaizen-yield-watch: folded {n} newly merged MR(s); watermark "
          f"{state['last_merged_at'] or 'none'}; threshold {state['threshold']}.")
    tracked = sorted(state["pairs"].items(), key=lambda kv: -kv[1]["streak"])
    print(f"{'gate|shape':<34} {'streak':>6} {'runs':>5} {'>0':>4}")
    for key, p in tracked:
        print(f"{key:<34} {p['streak']:>6} {p['runs']:>5} {p['positive']:>4}")
    if not found:
        print("No new narrowing candidates.")
    for key, gate, shape, p in found:
        print(f"\nCANDIDATE {key}: {p['streak']} consecutive 0-finding runs")
        if not args.file_issues:
            print("  (dry run) would file:", issue_title(gate, shape, p["streak"]))
    if found and args.file_issues:
        state["proposed"] = sorted(set(state["proposed"]) | set(file_issues(found, args, state["threshold"])))
    if args.write_state:
        with open(args.write_state, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        print(f"State written to {args.write_state} (commit it to persist the running count).")
    return 0


def self_test():
    """Prove the watch fires on a known-bad streak and ignores n/a/skipped."""
    def mr(iid, when, lines, branch="feat/x"):
        body = "## Gates\n" + "\n".join(f"- gate: {l}" for l in lines)
        return {"iid": iid, "merged_at": when, "description": body, "source_branch": branch}
    ok = True

    def check(cond, msg):
        nonlocal ok
        if not cond:
            print(f"kaizen-yield-watch --self-test: FAIL - {msg}", file=sys.stderr)
            ok = False

    st = empty_state()
    mrs = [mr(i, f"2026-01-{i:02d}T00:00:00Z",
              ["perf-check — 0 findings", "changelog — fragment added", "rbac-check — n/a (no views)"])
           for i in range(1, THRESHOLD + 1)]
    fold(st, mrs)
    found = candidates(st, set())
    check([f[0] for f in found] == ["perf-check|feat"], "10 zeros on one shape must yield exactly perf-check|feat")
    check("changelog|feat" not in st["pairs"], "deliverable gate must not be tracked")
    check("rbac-check|feat" not in st["pairs"], "n/a must not create or advance a streak")

    check(fold(st, mrs) == 0 and st["pairs"]["perf-check|feat"]["runs"] == THRESHOLD, "re-fold must be idempotent")
    check(not candidates(st, {"perf-check:fast-path-candidate"}), "declined gate must be suppressed")

    st2 = empty_state()
    mixed = mrs[:-1] + [mr(99, "2026-02-01T00:00:00Z", ["perf-check — 2 findings"])]
    fold(st2, mixed)
    check(not candidates(st2, set()), "a finding must reset the streak")

    st3 = empty_state()
    fold(st3, mrs[:5] + [mr(50, "2026-01-06T12:00:00Z", ["perf-check — skipped (user)"])] + mrs[5:])
    check(st3["pairs"]["perf-check|feat"]["streak"] == THRESHOLD, "skipped must neither reset nor advance")

    st4 = empty_state()
    fold(st4, [mr(i, f"2026-01-{i:02d}T00:00:00Z", ["perf-check — 0 findings"],
                  branch="fix/y" if i % 2 else "feat/y") for i in range(1, THRESHOLD + 1)])
    check(not candidates(st4, set()), "zeros split across shapes must not pool")

    st5 = empty_state()
    fold(st5, mrs)
    st5["proposed"] = ["perf-check|feat"]
    check(not candidates(st5, set()), "an already-proposed pair must not be re-raised")
    fold(st5, [mr(100, "2026-03-01T00:00:00Z", ["perf-check — 1 finding"])])
    check(st5["proposed"] == [], "a broken streak must clear the proposed flag")

    with tempfile.TemporaryDirectory() as d:
        inp = os.path.join(d, "mrs.json")
        with open(inp, "w") as fh:
            json.dump(mrs, fh)
        ns = argparse.Namespace(state=os.path.join(d, "none.json"), declined=os.path.join(d, "none2.json"),
                                input=inp, file_issues=True, write_state=os.path.join(d, "out.json"),
                                project="x/y", max_pages=1)
        os.environ.pop("KAIZEN_API_TOKEN", None)
        check(run(ns) == 0 and os.path.exists(ns.write_state), "end-to-end run must fail open without a token")
    if ok:
        print("kaizen-yield-watch --self-test: OK - fires on a 10-zero streak; ignores n/a, skipped, "
              "deliverables; resets on findings; idempotent; does not pool shapes.")
        return 0
    return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default=DEFAULT_STATE)
    ap.add_argument("--declined", default=DEFAULT_DECLINED)
    ap.add_argument("--input", help="offline: JSON list of MR objects (iid, merged_at, source_branch, description)")
    ap.add_argument("--project", default=ledger.DEFAULT_PROJECT)
    ap.add_argument("--max-pages", type=int, default=5)
    ap.add_argument("--write-state", metavar="FILE")
    ap.add_argument("--file-issues", action="store_true", help="opt-in: file one issue per new candidate")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    try:
        sys.exit(run(args))
    except Exception as exc:  # fail open: never block an MR on signal gathering
        warn(f"unexpected error ({type(exc).__name__}: {exc}); failing open")
        sys.exit(0)


if __name__ == "__main__":
    main()
