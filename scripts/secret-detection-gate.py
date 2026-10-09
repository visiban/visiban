#!/usr/bin/env python3
"""Fail CI on unsuppressed GitLab secret-detection findings (#1537).

GitLab's analyzers exit 0 even when they detect a secret, so the component's
`secret_detection` job reports findings but can never fail on them. This reads
its gl-secret-detection-report.json and fails on any finding that is not
covered by an unexpired entry in .gitlab/secret-detection-suppressions.json.

Every finding blocks regardless of severity: a leaked secret has no "Low". The
component's ruleset is separate from .gitleaks.toml (which gitleaks-scan and
gitleaks-history use), so its fixture/example hits need their own allowlist;
an expiring list forces each acceptance to be revisited.

Suppression rules (matching, glob safety, 90-day max expiry) are shared with
sast-severity-gate.py. This gate additionally requires each entry's `reason`
to cite a tracking issue as `#NNNN`.

The matched secret is never printed: only rule name and file:line.

Usage: secret-detection-gate.py <gl-secret-detection-report.json> <suppressions.json>
       secret-detection-gate.py --self-test

--self-test builds synthetic reports and proves the gate still fires (#1093:
a gate that stops detecting goes green and looks like a clean codebase).
"""
import datetime
import importlib.util
import json
import os
import re
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "sast_severity_gate", os.path.join(_HERE, "sast-severity-gate.py"))
_sast = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_sast)

ISSUE_REF = re.compile(r"#\d+")


def main(report_path, supp_path, today=None):
    today = today or datetime.date.today()
    try:
        active, errors = _sast.load_suppressions(supp_path, today)
    except (OSError, ValueError, AttributeError) as exc:
        print(f"secret-detection-gate: ERROR: cannot read suppressions {supp_path}: {exc}")
        return 1
    for entry in list(active):
        if not ISSUE_REF.search(str(entry["reason"])):
            errors.append(f"suppression for {entry['rule']} in {entry['file']} "
                          "has no tracking issue (#NNNN) in its reason")
            active.remove(entry)
    # Fail closed: this job runs whenever secret_detection runs, so a missing,
    # empty or unparsable report means the scan did not complete.
    try:
        with open(report_path, encoding="utf-8") as fh:
            report = json.load(fh)
        if not isinstance(report, dict):
            raise ValueError("report is not a JSON object")
        vulns = report.get("vulnerabilities")
        if not isinstance(vulns, list):
            raise ValueError("'vulnerabilities' is missing or not a list")
    except FileNotFoundError:
        print(f"secret-detection-gate: ERROR: {report_path} not found; "
              "secret_detection produced no report")
        return 1
    except (OSError, ValueError) as exc:
        print(f"secret-detection-gate: ERROR: unusable report {report_path}: {exc}")
        return 1
    blocking = [
        v for v in vulns
        if not isinstance(v, dict) or not _sast.is_suppressed(v, active)
    ]
    print(f"secret-detection-gate: {len(vulns)} finding(s); "
          f"{len(blocking)} unsuppressed")
    for v in blocking:
        if not isinstance(v, dict):
            print("  [malformed finding entry]")
            continue
        loc = v.get("location", {})
        print(f"  {v.get('name')} {loc.get('file')}:{loc.get('start_line')}")
    for err in errors:
        print(f"  ERROR: {err}")
    return 1 if blocking or errors else 0


def self_test():
    """Assert exit codes against synthetic inputs; return 0 only if all hold."""
    today = datetime.date(2026, 10, 8)

    def finding(name="Password in URL", file="docs/a.md"):
        return {"severity": "Critical", "name": name,
                "identifiers": [{"value": name}],
                "location": {"file": file, "start_line": 3}}

    good = {"rule": "Password in URL", "file": "docs/a.md",
            "reason": "doc example (#1537)", "expires": "2026-11-01"}
    one = {"vulnerabilities": [finding()]}
    cases = [
        ("unsuppressed finding", one, [], 1),
        ("unsuppressed Low severity", {"vulnerabilities": [dict(finding(), severity="Low")]}, [], 1),
        ("clean report", {"vulnerabilities": []}, [], 0),
        ("suppressed finding", one, [good], 0),
        ("glob suppression", one, [dict(good, file="docs/*.md")], 0),
        ("suppression for another file", one, [dict(good, file="docs/b.md")], 1),
        ("suppression for another rule", one, [dict(good, rule="AWS Access Key ID")], 1),
        ("one of two suppressed", {"vulnerabilities": [finding(), finding(file="docs/c.md")]},
         [good], 1),
        ("expired suppression", {"vulnerabilities": []}, [dict(good, expires="2026-10-01")], 1),
        ("expired suppression no longer covers", one, [dict(good, expires="2026-10-01")], 1),
        ("expiry beyond 90 days", {"vulnerabilities": []}, [dict(good, expires="2027-06-01")], 1),
        ("missing-field suppression", {"vulnerabilities": []}, [{"rule": "x"}], 1),
        ("reason without issue ref", one, [dict(good, reason="just because")], 1),
        ("wildcard-only file", one, [dict(good, file="**/*")], 1),
        ("report without vulnerabilities key", {}, [], 1),
        ("non-list vulnerabilities", {"vulnerabilities": {}}, [], 1),
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
    print("secret-detection-gate self-test:", "FAILED" if failures else "passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        sys.exit(self_test())
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
