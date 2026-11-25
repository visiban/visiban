#!/usr/bin/env python3
"""Fail on a dependency whose license is incompatible with Apache 2.0 (#1755).

Blocked: GPL, AGPL, SSPL and BUSL, in SPDX or classifier spelling, any license
containing the word "proprietary", and an empty or unknown value. LGPL and MPL
are allowed. This is a blocklist: any other lone string passes, including one the
gate does not recognize (such as "Commercial" or "CC-BY-NC-4.0").

An SPDX ``OR`` offers a choice, so one acceptable side is enough, but that side
must be a license the gate recognizes: "GPL-3.0 OR Commercial" is no way out. ``AND``, a
``;``-joined classifier list (pip-licenses) and a license array (license-checker)
must be acceptable in every part.

Usage:
  scripts/license-gate.py --pip <pip-licenses --format=json report>
  scripts/license-gate.py --npm <license-checker --json report>
  scripts/license-gate.py --self-test
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout

from _paths import cli_roots, resolve_within

BLOCKED = (
    ("AGPL", re.compile(r"agpl|affero", re.IGNORECASE)),
    # The lookbehinds keep LGPL, in either spelling, out of the GPL rule.
    (
        "GPL",
        re.compile(
            r"(?<![a-z])gpl|(?<!lesser )(?<!library )general public licen[cs]e"
            r"|gnu public licen[cs]e",
            re.IGNORECASE,
        ),
    ),
    ("SSPL", re.compile(r"sspl|server side public licen[cs]e", re.IGNORECASE)),
    # "BSL-1.0" is the permissive Boost license, so only 1.1 means Business Source.
    ("BUSL", re.compile(r"busl|business source|\bbsl[- ]?1\.1", re.IGNORECASE)),
    ("proprietary", re.compile(r"proprietary", re.IGNORECASE)),
)

# Licenses that can satisfy one side of an OR. Not an allowlist for a lone
# license: that is still judged by BLOCKED and UNIDENTIFIED alone.
RECOGNIZED = re.compile(
    r"\b(?:mit|apache|bsd|0bsd|isc|lgpl|(?:lesser|library) general public|mpl|mozilla"
    r"|psf|python software foundation|python-2|zlib|bsl-1\.0|boost|unlicense|cc0"
    r"|cc-by|public domain|epl|eclipse|artistic|afl|academic free|hpnd"
    r"|historical permission|wtfpl|blueoak|ofl|unicode|tcl|zpl|zope)(?:(?=v\d)|(?![a-z]))",
    re.IGNORECASE,
)

UNIDENTIFIED = re.compile(
    r"^$|^unknown$|^unlicensed$|^none$|^custom:|see license in", re.IGNORECASE
)


def _split_top_level(expression: str, operator: str) -> list[str]:
    parts, depth, start = [], 0, 0
    token = f" {operator} "
    for index, char in enumerate(expression):
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth == 0 and expression.startswith(token, index):
            parts.append(expression[start:index])
            start = index + len(token)
    parts.append(expression[start:])
    return parts


def _wrapped(expression: str) -> bool:
    """True if one pair of parentheses encloses the whole expression."""
    if not (expression.startswith("(") and expression.endswith(")")):
        return False
    depth = 0
    for index, char in enumerate(expression):
        depth += {"(": 1, ")": -1}.get(char, 0)
        if depth == 0:
            return index == len(expression) - 1
    return False


def blocked_reason(expression: str) -> str | None:
    """Why ``expression`` is not acceptable, or None if it is."""
    expression = expression.strip()
    while _wrapped(expression):
        expression = expression[1:-1].strip()

    listed = [part for part in expression.split(";") if part.strip()]
    if len(listed) > 1:
        return next(filter(None, map(blocked_reason, listed)), None)

    choices = _split_top_level(expression, "OR")
    if len(choices) > 1:
        reasons = [blocked_reason(choice) for choice in choices]
        if any(r is None and _recognized(c) for c, r in zip(choices, reasons)):
            return None
        return next(filter(None, reasons), "unidentified")

    required = _split_top_level(expression, "AND")
    if len(required) > 1:
        return next(filter(None, map(blocked_reason, required)), None)

    # license-checker appends "*" to a license it guessed from a file.
    name = expression.rstrip("*").strip()
    if UNIDENTIFIED.search(name):
        return "unidentified"
    return next((label for label, pattern in BLOCKED if pattern.search(name)), None)


def _recognized(expression: str) -> bool:
    """True if every license ``expression`` requires is one the gate knows."""
    expression = expression.strip()
    while _wrapped(expression):
        expression = expression[1:-1].strip()
    for operator in ("OR", "AND"):
        parts = _split_top_level(expression, operator)
        if len(parts) > 1:
            combine = any if operator == "OR" else all
            return combine(
                _recognized(part) and not blocked_reason(part) for part in parts
            )
    listed = [part for part in expression.split(";") if part.strip()]
    if len(listed) > 1:
        return all(map(_recognized, listed))
    return bool(RECOGNIZED.search(expression))


def packages_from_pip(report: object) -> list[tuple[str, str]]:
    return [
        (f"{row['Name']}@{row.get('Version', '?')}", str(row.get("License") or ""))
        for row in report
    ]


def packages_from_npm(report: object) -> list[tuple[str, str]]:
    packages = []
    for name, info in report.items():
        license_value = info.get("licenses") or ""
        if isinstance(license_value, list):
            license_value = ";".join(str(item) for item in license_value)
        packages.append((name, str(license_value)))
    return packages


def violations(packages: list[tuple[str, str]]) -> list[str]:
    found = []
    for name, expression in packages:
        reason = blocked_reason(expression)
        if reason:
            found.append(f"{name}: {expression!r} ({reason})")
    return found


def check(path: str, parse) -> int:
    try:
        # PathEscapeError is a ValueError, so a rejected path fails below too.
        with open(resolve_within(cli_roots(), path), encoding="utf-8") as handle:
            packages = parse(json.load(handle))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"license-gate: cannot read report {path}: {exc!r}", file=sys.stderr)
        return 1
    if not packages:
        print(f"license-gate: {path} lists no packages", file=sys.stderr)
        return 1

    found = violations(packages)
    for line in found:
        print(f"BLOCKED {line}", file=sys.stderr)
    print(f"license-gate: {len(packages)} package(s), {len(found)} blocked")
    return 1 if found else 0


def self_test() -> int:
    blocked = [
        "GPL-2.0",
        "GPL-3.0-only",
        "GPL-2.0-or-later",
        "GPL-3.0+",
        "GPLv3",
        "GPL-2.0*",
        "GPL-2.0 WITH Classpath-exception-2.0",
        "GNU General Public License v3 (GPLv3)",
        "GNU General Public License v2 or later (GPLv2+)",
        "GNU General Public License (GPL)",
        "AGPL-3.0-only",
        "GNU Affero General Public License v3",
        "SSPL-1.0",
        "Server Side Public License",
        "BUSL-1.1",
        "BSL 1.1",
        "Business Source License 1.1",
        "MIT AND GPL-3.0-only",
        "(GPL-2.0 OR AGPL-3.0)",
        "(MIT OR Apache-2.0) AND GPL-3.0",
        "MIT License; GNU General Public License v3 (GPLv3)",
        "",
        "UNKNOWN",
        "UNLICENSED",
        "Custom: LICENSE.txt",
        "SEE LICENSE IN LICENSE",
        "AGPL-3.0-only OR Commercial",
        "AGPL-3.0 OR LicenseRef-Commercial",
        "GPLv3 OR Proprietary",
        "GPL-3.0 OR LATER",
        "GNU GPL v2 OR LATER",
        "GPL-3.0 OR (MIT AND Commercial)",
        "GNU Public License v3",
        "Other/Proprietary License",
        "Proprietary",
    ]
    allowed = [
        "MIT",
        "Apache-2.0",
        "BSD-3-Clause AND TCL",
        "LGPL-3.0-only",
        "LGPL-2.1-or-later",
        "GNU Lesser General Public License v3 (LGPLv3)",
        "GNU Library or Lesser General Public License (LGPL)",
        "GNU Library General Public License v2",
        "MPL-2.0",
        "Mozilla Public License 2.0 (MPL 2.0)",
        "BSL-1.0",
        "(MIT OR GPL-3.0)",
        "GPL-2.0 OR BSD-3-Clause",
        "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
        "GPL-3.0 OR LGPL-3.0",
        "GPLv3 OR LGPLv3",
        "GPL-2.0 OR MPL-2.0",
        "GPL-2.0 OR (MIT AND Apache-2.0)",
    ]
    failures = [f"not blocked: {x!r}" for x in blocked if not blocked_reason(x)]
    failures += [f"wrongly blocked: {x!r}" for x in allowed if blocked_reason(x)]

    pip_rows = [{"Name": "a", "License": "GPL-3.0-only"}, {"Name": "b"}]
    npm_rows = {"c@1": {"licenses": ["MIT", "AGPL-3.0"]}, "d@1": {}}
    for label, packages in (
        ("pip", packages_from_pip(pip_rows)),
        ("npm", packages_from_npm(npm_rows)),
    ):
        if len(violations(packages)) != 2:
            failures.append(f"{label} report fixture: expected 2 violations")

    # check() itself: an empty or unreadable report must fail, not pass quietly.
    reports = (
        ("clean report", '[{"Name": "a", "License": "MIT"}]', 0),
        ("blocked report", '[{"Name": "a", "License": "GPL-3.0"}]', 1),
        ("empty report", "[]", 1),
        ("unparseable report", "not json", 1),
        ("wrong-shape report", "[1]", 1),
        ("missing report", None, 1),
    )
    with tempfile.TemporaryDirectory() as directory:
        for index, (label, content, expected) in enumerate(reports):
            path = os.path.join(directory, f"{index}.json")
            if content is not None:
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)
            # The expected failures print messages that would read as real ones.
            quiet = io.StringIO()
            with redirect_stdout(quiet), redirect_stderr(quiet):
                result = check(path, packages_from_pip)
            if result != expected:
                failures.append(f"{label}: check() returned {result}")

    # A path outside the allowed roots is refused before it is opened.
    quiet = io.StringIO()
    with redirect_stdout(quiet), redirect_stderr(quiet):
        result = check("/etc/passwd", packages_from_pip)
    if result != 1 or "PathEscapeError" not in quiet.getvalue():
        failures.append(f"outside-roots report: not refused ({result})")

    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    total = len(blocked) + len(allowed) + 2 + len(reports) + 1
    print(f"license-gate --self-test: {total} case(s), {len(failures)} failure(s)")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--pip", metavar="REPORT")
    group.add_argument("--npm", metavar="REPORT")
    group.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    if args.pip:
        return check(args.pip, packages_from_pip)
    return check(args.npm, packages_from_npm)


if __name__ == "__main__":
    sys.exit(main())
