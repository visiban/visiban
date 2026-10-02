#!/usr/bin/env python3
"""File or update the tracking issue for a red `backend-schema-fuzz-deep` run (#1383).

`backend-schema-fuzz-deep` runs only on the consolidated Nightly schedule and
is `allow_failure: true`, so a finding does not turn the shared nightly
pipeline red (TruePPM `api:fuzz` precedent). That makes the failure easy to
miss: a yellow job inside a green pipeline emails nobody. This script is the
durable signal instead. On a failed run it keeps exactly ONE open issue for
deep-fuzz findings: it creates it if none is open, otherwise it appends a note
with this run's pipeline, job and seed, so repeated nights pile onto one
thread rather than spawning one issue per night.

A red deep run is a REAL, replayable defect, never a flake (#1165): the seed
only picks which part of the input space a run explores. The issue body says
so, and points at the triage steps in docs/api/openapi.md.

Opt-in and fail-open, same posture as scripts/kaizen_yield_watch.py:
  * the token is FUZZ_DEEP_API_TOKEN, falling back to KAIZEN_API_TOKEN (both a
    project access token with `api` scope); with neither set it prints what it
    would have filed and exits 0;
  * any API error is a warning and exit 0 -- this runs in `after_script` of a
    job that has already failed, and must never mask or replace that failure.

Usage:
  python3 scripts/fuzz_deep_file_issue.py [--seed-file /tmp/fuzz_seed]
  python3 scripts/fuzz_deep_file_issue.py --self-test
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TITLE = "backend-schema-fuzz-deep: nightly schema-fuzz finding"
LABELS = "bug,ci"


def warn(msg):
    print(f"fuzz-deep-file-issue: WARNING - {msg}", file=sys.stderr)


def api(method, url, token, data=None):
    headers = {"PRIVATE-TOKEN": token, "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def read_seed(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read().strip() or "unknown"
    except OSError:
        return "unknown"


def clean_seed(seed):
    """The seed is a decimal integer (secrets.randbits(64), or FUZZ_SEED).
    Anything else, including a multi-line value, becomes "invalid", so a
    crafted FUZZ_SEED cannot carry GitLab quick actions (/close, /label ...)
    into the issue or note."""
    s = (seed or "").strip()
    return s if s.isdigit() else "invalid"


def clean_field(value, default):
    """One CI-variable value, made safe to embed inline in Markdown: first line
    only, no backticks, no leading '/'. GitLab runs a quick action only from a
    line that starts with '/', so a value that cannot start a line cannot
    trigger one."""
    first = (value or "").replace("\r", "\n").split("\n", 1)[0]
    first = first.replace("`", "").strip().lstrip("/").strip()
    return first or default


def strip_quick_actions(text):
    """Belt and braces: drop any line of the final body that would be read as
    a quick action."""
    return "\n".join(line for line in text.split("\n")
                     if not line.lstrip().startswith("/"))


def run_details(env, seed):
    pipeline = clean_field(env.get("CI_PIPELINE_URL"), "(pipeline URL unavailable)")
    job = clean_field(env.get("CI_JOB_URL"), "(job URL unavailable)")
    sha = clean_field(env.get("CI_COMMIT_SHORT_SHA"), "unknown")
    seed = clean_seed(seed)
    return (
        f"- Pipeline: {pipeline}\n"
        f"- Job: {job}\n"
        f"- Commit: `{sha}`\n"
        f"- Seed: `{seed}`\n"
    )


def issue_body(details, project_url):
    project_url = clean_field(project_url, "https://gitlab.com/visiban/visiban")
    doc = (f"{project_url}/-/blob/main/docs/api/openapi.md"
           "#a-red-backend-schema-fuzz-job-is-never-a-flake")
    return (
        "The nightly `backend-schema-fuzz-deep` job failed. It is `allow_failure: true` "
        "so it does not red the shared Nightly pipeline, which is why this issue exists.\n\n"
        "**This is a real, replayable defect, not a flake (#1165).** A green re-run only "
        "means a different seed missed the failing input. Do not retry the job or add a "
        "`backend/schemathesis-baseline.json` entry to make it pass.\n\n"
        "Triage: read the `FAILURES` section of the job log, then follow "
        f"[A red `backend-schema-fuzz` job is never a flake]({doc}). "
        "A 5xx is an endpoint bug, an undocumented 4xx needs declaring, and a schema "
        "mismatch needs the serializer or its annotation fixed.\n\n"
        "Later failing nights are appended to this issue as comments. Close it once "
        "every finding listed here is fixed.\n\n"
        "## First failing run\n\n" + details
    )


def file_or_update(env, seed, api_fn=api):
    """Returns a short status string; never raises on API failure."""
    token = env.get("FUZZ_DEEP_API_TOKEN") or env.get("KAIZEN_API_TOKEN")
    details = run_details(env, seed)
    if not token:
        print("fuzz-deep-file-issue: no FUZZ_DEEP_API_TOKEN / KAIZEN_API_TOKEN set; "
              "report only. Would file or update:")
        print(f"  title: {TITLE}")
        print("  " + details.replace("\n", "\n  "))
        return "report-only"
    base = env.get("CI_API_V4_URL", "https://gitlab.com/api/v4")
    project = env.get("CI_PROJECT_ID")
    if not project:
        warn("CI_PROJECT_ID is unset; cannot locate the project. Failing open.")
        return "inconclusive"
    try:
        q = urllib.parse.quote(TITLE)
        existing = api_fn("GET", f"{base}/projects/{project}/issues?state=opened"
                          f"&in=title&search={q}", token)
        match = [i for i in existing if i.get("title") == TITLE]
        if match:
            iid = match[0]["iid"]
            api_fn("POST", f"{base}/projects/{project}/issues/{iid}/notes", token,
                   {"body": strip_quick_actions("Failed again.\n\n" + details)})
            print(f"fuzz-deep-file-issue: added a note to open issue #{iid}")
            return f"noted:{iid}"
        made = api_fn("POST", f"{base}/projects/{project}/issues", token,
                      {"title": TITLE, "description": strip_quick_actions(issue_body(
                           details, env.get("CI_PROJECT_URL"))),
                       "labels": LABELS})
        print(f"fuzz-deep-file-issue: filed {made.get('web_url', '(no URL returned)')}")
        return "filed"
    except (urllib.error.URLError, ValueError, OSError, KeyError, TypeError) as exc:
        warn(f"issue filing inconclusive ({exc}); failing open")
        return "inconclusive"


def self_test():
    env = {"CI_PROJECT_ID": "1", "CI_API_V4_URL": "https://example.invalid/api/v4",
           "CI_PIPELINE_URL": "https://example.invalid/p/1",
           "CI_JOB_URL": "https://example.invalid/j/2", "CI_COMMIT_SHORT_SHA": "abc1234"}
    failures = []

    def expect(name, got, want):
        if got != want:
            failures.append(f"{name}: expected {want!r}, got {got!r}")

    # 1. No token: report only, and the API is never touched.
    def no_call(*_a, **_k):
        raise AssertionError("API must not be called without a token")
    expect("no token", file_or_update(dict(env), "42", no_call), "report-only")

    # 2. An open issue with the exact title exists: a note is added, no new issue.
    calls = []

    def existing_api(method, url, _token, data=None):
        calls.append((method, url, data))
        if method == "GET":
            # A near-miss title from `search` must not count as the tracker.
            return [{"iid": 7, "title": TITLE + " (old)"}, {"iid": 9, "title": TITLE}]
        return {}
    got = file_or_update(dict(env, FUZZ_DEEP_API_TOKEN="t"), "42", existing_api)
    expect("existing issue", got, "noted:9")
    posts = [c for c in calls if c[0] == "POST"]
    expect("existing issue posts", [p[1].rsplit("/projects/1", 1)[1] for p in posts],
           ["/issues/9/notes"])
    if posts and "`42`" not in posts[0][2]["body"]:
        failures.append("existing issue: note does not carry the seed")

    # 3. No open issue: one is created, with the seed and the never-a-flake rule.
    calls.clear()

    def empty_api(method, url, _token, data=None):
        calls.append((method, url, data))
        return [] if method == "GET" else {"web_url": "https://example.invalid/i/1"}
    got = file_or_update(dict(env, KAIZEN_API_TOKEN="t"), "42", empty_api)
    expect("new issue (KAIZEN_API_TOKEN fallback)", got, "filed")
    created = [c for c in calls if c[0] == "POST"]
    if len(created) != 1 or not created[0][1].endswith("/projects/1/issues"):
        failures.append(f"new issue: expected one POST to /issues, got {created!r}")
    elif "not a flake" not in created[0][2]["description"]:
        failures.append("new issue: body lost the not-a-flake rule")

    # 4. API error: fail open, never raise.
    def broken_api(*_a, **_k):
        raise urllib.error.URLError("boom")
    expect("api error", file_or_update(dict(env, FUZZ_DEEP_API_TOKEN="t"), "42", broken_api),
           "inconclusive")

    # 5. Quick-action smuggling (#1383 completeness-check): a multi-line seed
    #    and CI-variable text starting a line with '/' must never reach a body.
    calls.clear()
    hostile = dict(env, FUZZ_DEEP_API_TOKEN="t",
                   CI_PIPELINE_URL="https://example.invalid/p/1\n/close",
                   CI_JOB_URL="/label ~security",
                   CI_COMMIT_SHORT_SHA="abc`\n/assign @someone",
                   CI_PROJECT_URL="https://example.invalid\n/confidential")
    for api_fn in (existing_api, empty_api):
        calls.clear()
        file_or_update(dict(hostile), "42\n/close", api_fn)
        for _m, _u, data in calls:
            if not data:
                continue
            body = data.get("body") or data.get("description") or ""
            bad = [ln for ln in body.split("\n") if ln.lstrip().startswith("/")]
            if bad:
                failures.append(f"quick action reached a body: {bad!r}")
            if "Seed: `invalid`" not in body:
                failures.append("a multi-line seed was not replaced by 'invalid'")
    expect("clean_seed digits", clean_seed(" 11904822046389351554\n"), "11904822046389351554")
    expect("clean_seed junk", clean_seed("12 /close"), "invalid")
    expect("clean_field leading slash", clean_field("/close", "d"), "close")

    if failures:
        for f in failures:
            print(f"self-test FAILED: {f}", file=sys.stderr)
        return 1
    print("fuzz_deep_file_issue --self-test: OK (report-only, note-on-existing, "
          "file-new, fail-open, quick-action sanitizing)")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--seed-file", default="/tmp/fuzz_seed")
    args = p.parse_args(argv)
    if args.self_test:
        return self_test()
    file_or_update(dict(os.environ), read_seed(args.seed_file))
    return 0


if __name__ == "__main__":
    sys.exit(main())
