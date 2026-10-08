#!/usr/bin/env python3
"""Fail CI on unsuppressed High/Critical SAST findings (#1071).

The GitLab SAST component has no native severity threshold, so this reads its
gl-sast-report.json. Why a suppression file with expiry instead of inline
ignores: semgrep runs via the component's analyzer, which gives us no stable
inline-ignore contract; an expiring list forces temporary acceptances to be
revisited rather than quietly becoming permanent.

Usage: sast-severity-gate.py <gl-sast-report.json> <suppressions.json>
"""
import datetime
import json
import sys

BLOCKING = {"critical", "high"}
MAX_DAYS = 90


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
    loc = vuln.get("location", {}).get("file", "")
    ident = " ".join(
        [vuln.get("name", "")]
        + [i.get("value", "") for i in vuln.get("identifiers", [])]
    )
    return any(loc.startswith(s["file"]) and s["rule"] in ident for s in active)


def main(report_path, supp_path, today=None):
    today = today or datetime.date.today()
    active, errors = load_suppressions(supp_path, today)
    try:
        with open(report_path, encoding="utf-8") as fh:
            vulns = json.load(fh).get("vulnerabilities", [])
    except FileNotFoundError:
        errors.append(f"{report_path} not found — semgrep-sast did not produce a report")
        vulns = []
    blocking = [
        v for v in vulns
        if str(v.get("severity", "")).lower() in BLOCKING and not is_suppressed(v, active)
    ]
    counts = {}
    for v in vulns:
        sev = str(v.get("severity", "unknown"))
        counts[sev] = counts.get(sev, 0) + 1
    print(f"sast-severity-gate: {len(vulns)} finding(s) {counts}; "
          f"{len(blocking)} blocking (High/Critical, unsuppressed)")
    for v in blocking:
        loc = v.get("location", {})
        print(f"  [{v.get('severity')}] {v.get('name')} {loc.get('file')}:{loc.get('start_line')}")
    for err in errors:
        print(f"  ERROR: {err}")
    return 1 if blocking or errors else 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
