#!/usr/bin/env python3
"""Fail CI on unsuppressed High/Critical SAST findings (#1071).

The GitLab SAST component has no native severity threshold, so this reads its
gl-sast-report.json. Why a suppression file with expiry instead of inline
ignores: semgrep runs via the component's analyzer, which gives us no stable
inline-ignore contract; an expiring list forces temporary acceptances to be
revisited rather than quietly becoming permanent.

Usage: sast-severity-gate.py <gl-sast-report.json> <suppressions.json>
       sast-severity-gate.py --self-test

--self-test builds synthetic reports and proves the gate still fires (#1093:
a gate that stops detecting goes green and looks like a clean codebase).
"""
import datetime
import fnmatch
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import PathEscapeError, cli_roots, resolve_within  # noqa: E402

BLOCKING = {"critical", "high"}
MAX_DAYS = 90


GLOB_CHARS = set("*?[")


def too_loose(entry):
    """Reject entries that would match (nearly) everything.

    `rule` is matched exactly, so it only needs to be non-trivial. `file` is an
    exact path or a glob (fnmatch syntax, `*` also crosses `/`); a glob must
    keep at least one literal path character so `*`, `**` and `**/*` cannot
    silently suppress every finding.
    """
    rule, path = str(entry["rule"]).strip(), str(entry["file"]).strip()
    if not rule or set(rule) <= GLOB_CHARS | {"/", "."}:
        return "rule is empty or wildcard-only"
    if not path or not (set(path) - GLOB_CHARS - {"/", "."}):
        return "file is empty or wildcard-only"
    return None


def load_suppressions(path, today):
    """Return (active, errors). Expired or malformed entries are errors."""
    with open(path, encoding="utf-8") as fh:
        entries = json.load(fh).get("suppressions", [])
    active, errors = [], []
    for e in entries:
        missing = [k for k in ("rule", "file", "reason", "expires") if not e.get(k)]
        if missing:
            errors.append(f"suppression {e!r} is missing {missing}")
            continue
        loose = too_loose(e)
        if loose:
            errors.append(f"suppression {e!r} rejected: {loose}")
            continue
        try:
            exp = datetime.date.fromisoformat(e["expires"])
        except ValueError:
            errors.append(f"suppression {e!r} has an invalid expires date")
            continue
        if exp < today:
            errors.append(f"suppression for {e['rule']} in {e['file']} expired {e['expires']}")
        elif (exp - today).days > MAX_DAYS:
            errors.append(f"suppression for {e['rule']} expires more than {MAX_DAYS} days out")
        else:
            active.append(e)
    return active, errors


def is_suppressed(vuln, active):
    """True only if an entry matches BOTH the rule and the file.

    rule: exact equality with the finding's name or one identifiers[].value.
    file: exact path, or an fnmatch glob (e.g. `scripts/*.py`). No substring or
    bare-prefix matching: a prefix like `scripts/` would silently cover every
    future finding in that tree.
    """
    path = vuln.get("location", {}).get("file", "")
    names = {vuln.get("name", "")} | {i.get("value", "") for i in vuln.get("identifiers", [])}
    for s in active:
        file_ok = path == s["file"] or (
            bool(GLOB_CHARS & set(s["file"])) and fnmatch.fnmatchcase(path, s["file"])
        )
        if s["rule"] in names and file_ok:
            return True
    return False


def main(report_path, supp_path, today=None):
    today = today or datetime.date.today()
    # Confine CLI-supplied paths to the repo / cwd / temp dir (#1549, S8707).
    try:
        supp_path = resolve_within(cli_roots(), supp_path)
        report_path = resolve_within(cli_roots(), report_path)
    except PathEscapeError as exc:
        print(f"sast-severity-gate: ERROR: {exc}", file=sys.stderr)
        return 2
    try:
        active, errors = load_suppressions(supp_path, today)
    except (OSError, ValueError, AttributeError) as exc:
        print(f"sast-severity-gate: ERROR: cannot read suppressions {supp_path}: {exc}")
        return 1
    # Fail closed: the caller only runs this gate when semgrep-sast is part of
    # the pipeline (the job's rules mirror the component's SAST_DISABLED), so a
    # missing or unparsable report means the scan did not complete.
    try:
        with open(report_path, encoding="utf-8") as fh:
            report = json.load(fh)
        if not isinstance(report, dict):
            raise ValueError("report is not a JSON object")
        vulns = report.get("vulnerabilities", [])
        if not isinstance(vulns, list):
            raise ValueError("'vulnerabilities' is not a list")
    except FileNotFoundError:
        print(f"sast-severity-gate: ERROR: {report_path} not found; semgrep-sast produced no report")
        return 1
    except (OSError, ValueError) as exc:
        print(f"sast-severity-gate: ERROR: unusable report {report_path}: {exc}")
        return 1
    blocking = [
        v for v in vulns
        if isinstance(v, dict)
        and str(v.get("severity", "")).lower() in BLOCKING
        and not is_suppressed(v, active)
    ]
    counts = {}
    for v in vulns:
        sev = str(v.get("severity", "unknown")) if isinstance(v, dict) else "unknown"
        counts[sev] = counts.get(sev, 0) + 1
    print(f"sast-severity-gate: {len(vulns)} finding(s) {counts}; "
          f"{len(blocking)} blocking (High/Critical, unsuppressed)")
    for v in blocking:
        loc = v.get("location", {})
        print(f"  [{v.get('severity')}] {v.get('name')} {loc.get('file')}:{loc.get('start_line')}")
    for err in errors:
        print(f"  ERROR: {err}")
    return 1 if blocking or errors else 0


def self_test():
    """Assert exit codes against synthetic inputs; return 0 only if all hold."""
    today = datetime.date(2026, 10, 8)
    vuln = lambda sev: {"severity": sev, "name": "SSRF", "identifiers": [{"value": "rule.x"}],
                        "location": {"file": "scripts/a.py", "start_line": 1}}
    good = {"rule": "SSRF", "file": "scripts/a.py", "reason": "r", "expires": "2026-11-01"}
    cases = [
        ("unsuppressed High", {"vulnerabilities": [vuln("High")]}, [], 1),
        ("unsuppressed Critical", {"vulnerabilities": [vuln("Critical")]}, [], 1),
        ("suppressed High", {"vulnerabilities": [vuln("High")]}, [good], 0),
        ("expired suppression", {"vulnerabilities": []}, [dict(good, expires="2026-10-01")], 1),
        ("missing-field suppression", {"vulnerabilities": []}, [{"rule": "SSRF"}], 1),
        ("bad-date suppression", {"vulnerabilities": []}, [dict(good, expires="soon")], 1),
        ("expiry beyond 90 days", {"vulnerabilities": []}, [dict(good, expires="2027-06-01")], 1),
        ("glob file suppression", {"vulnerabilities": [vuln("High")]},
         [dict(good, file="scripts/*.py")], 0),
        ("rule matches identifier value", {"vulnerabilities": [vuln("High")]},
         [dict(good, rule="rule.x")], 0),
        ("suppression for another file", {"vulnerabilities": [vuln("High")]},
         [dict(good, file="scripts/b.py")], 1),
        ("suppression for another rule", {"vulnerabilities": [vuln("High")]},
         [dict(good, rule="XSS")], 1),
        ("prefix-only file match", {"vulnerabilities": [vuln("High")]},
         [dict(good, file="scripts/")], 1),
        ("substring-only rule match", {"vulnerabilities": [vuln("High")]},
         [dict(good, rule="SS")], 1),
        ("wildcard-only file", {"vulnerabilities": [vuln("High")]},
         [dict(good, file="**/*")], 1),
        ("wildcard-only rule", {"vulnerabilities": [vuln("High")]},
         [dict(good, rule="*")], 1),
        ("Medium only", {"vulnerabilities": [vuln("Medium"), vuln("Low")]}, [], 0),
    ]
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        supp, rep = os.path.join(tmp, "s.json"), os.path.join(tmp, "r.json")

        def run(label, report_text, supps, want):
            nonlocal failures
            with open(supp, "w", encoding="utf-8") as fh:
                json.dump({"suppressions": supps}, fh)
            if report_text is not None:
                with open(rep, "w", encoding="utf-8") as fh:
                    fh.write(report_text)
            elif os.path.exists(rep):
                os.remove(rep)
            got = main(rep, supp, today)
            ok = got == want
            failures += not ok
            print(f"  self-test {'ok  ' if ok else 'FAIL'} {label}: exit {got}, want {want}")

        for label, report, supps, want in cases:
            run(label, json.dumps(report), supps, want)
        run("missing report", None, [], 1)
        run("empty report", "", [], 1)
        run("non-JSON report", "not json", [], 1)
        run("top-level list report", "[]", [], 1)
        # Paths outside the allowed roots are rejected before any open() (#1549).
        outside = "/etc/passwd"
        for label, args in (("report outside roots", (outside, supp)),
                            ("suppressions outside roots", (rep, outside))):
            got = main(*args, today)
            ok = got == 2
            failures += not ok
            print(f"  self-test {'ok  ' if ok else 'FAIL'} {label}: exit {got}, want 2")
        run("in-repo path still works", json.dumps({"vulnerabilities": []}), [], 0)
    print("sast-severity-gate self-test:", "FAILED" if failures else "passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
