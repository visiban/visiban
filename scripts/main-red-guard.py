#!/usr/bin/env python3
"""MR-pipeline brake for a red `main` (#2460).

Fails when the latest FINISHED `main` push pipeline failed on a non-allow_failure
job, naming the job and the `main is red` tracking issue. An MR labeled
`main-fix` passes, so the fix for red main can itself merge. The label is read
live from the API (and from CI_MERGE_REQUEST_LABELS) so adding it and retrying
the job works without a new pipeline.

Anonymous reads (the project is public; MR pipelines from unprotected branches
have no protected token). Any inconclusive lookup fails OPEN with a loud
warning, same convention as scripts/check-suppression-issues.sh: a flaky API
must never become a hard block on every MR.

Usage: python3 scripts/main-red-guard.py | --self-test
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main_red_common as c  # noqa: E402


def has_escape(csv: str) -> bool:
    return c.ESCAPE_LABEL in [x.strip() for x in (csv or "").split(",")]


def run(client: c.Client, env: dict, out=print) -> int:
    if has_escape(env.get("CI_MERGE_REQUEST_LABELS", "")):
        out(f"INFO: MR carries the '{c.ESCAPE_LABEL}' label; red-main guard skipped.")
        return 0
    try:
        iid = env.get("CI_MERGE_REQUEST_IID")
        if iid:  # live labels: the pipeline's copy is stale once a label is added
            mr = client.get(f"/merge_requests/{int(iid)}")
            if isinstance(mr, dict) and has_escape(",".join(mr.get("labels") or [])):
                out(f"INFO: MR carries the '{c.ESCAPE_LABEL}' label (live); red-main guard skipped.")
                return 0
        pipe = c.latest_finished_main(client)
        if pipe is None:
            out("WARNING: no finished main push pipeline found; red-main guard FAILING OPEN.")
            return 0
        if pipe.get("status") == "success":
            out(f"OK: latest finished main pipeline {pipe['id']} is green.")
            return 0
        failed = c.blocking_failures(client.jobs(pipe["id"]))
        try:
            issue = client.tracking_issue()
        except (c.ApiError, KeyError, TypeError):
            issue = None
    except (c.ApiError, ValueError, KeyError, TypeError) as exc:
        out(f"WARNING: red-main lookup inconclusive ({exc}); guard FAILING OPEN.")
        return 0
    if not failed:
        out(f"WARNING: main pipeline {pipe['id']} failed but no blocking job was found; FAILING OPEN.")
        return 0
    tracker = issue.get("web_url") if issue else f"the open '{c.ISSUE_TITLE}' issue (label {c.ISSUE_LABEL})"
    out(f"ERROR: main is red: {', '.join(failed)} failed in main pipeline {pipe.get('web_url') or pipe['id']}.")
    out(f"       Tracking issue: {tracker}")
    out(f"       Fix main first. A fix MR carries the '{c.ESCAPE_LABEL}' label (add it, then retry this job).")
    return 1


def _self_test() -> int:
    import json

    problems: list = []

    def fake(pipes, jobs, mr_labels=(), issues=(), fail=None):
        def fetch(method, url, headers, body):
            if fail:
                raise c.ApiError(fail)
            assert "PRIVATE-TOKEN" not in headers, "guard must read anonymously"
            if "/merge_requests/" in url:
                return json.dumps({"labels": list(mr_labels)}).encode()
            if "/jobs" in url:
                return json.dumps(c.fake_page(jobs, url)).encode()
            if "/pipelines?" in url:
                return json.dumps(pipes).encode()
            if "/issues?" in url:
                return json.dumps(list(issues)).encode()
            raise AssertionError(url)

        return c.Client("http://x/api/v4", "1", None, fetch)

    def go(client, labels="", iid=None):
        log: list = []
        env = {"CI_MERGE_REQUEST_LABELS": labels}
        if iid:
            env["CI_MERGE_REQUEST_IID"] = iid
        return run(client, env, log.append), "\n".join(log)

    def check(name, cond, log):
        if not cond:
            problems.append(f"{name}: {log}")

    red_jobs = [
        {"name": "script-tests", "status": "failed", "allow_failure": False},
        {"name": "oidc-smoke", "status": "failed", "allow_failure": True},
        {"name": "lint", "status": "success", "allow_failure": False},
    ]
    issue = [{"title": c.ISSUE_TITLE, "web_url": "http://x/issues/9"}]
    red = [{"id": 5, "status": "running"}, {"id": 4, "status": "failed", "web_url": "http://x/p/4"}, {"id": 3, "status": "success"}]
    rc, log = go(fake(red, red_jobs, issues=issue))
    check("red main fails", rc == 1 and "script-tests" in log and "issues/9" in log and "oidc-smoke" not in log, log)
    rc, log = go(fake(red, red_jobs, issues=issue), labels="ci,main-fix")
    check("main-fix label passes", rc == 0, log)
    rc, log = go(fake(red, red_jobs, mr_labels=["main-fix"]), iid="7")
    check("live main-fix label passes", rc == 0, log)
    rc, log = go(fake(red, red_jobs, mr_labels=["other"]), labels="mainfix,main-fix-not", iid="7")
    check("similar label names do not pass", rc == 1, log)
    rc, log = go(fake([{"id": 4, "status": "success"}, {"id": 3, "status": "failed"}], red_jobs))
    check("green latest finished passes (older red ignored)", rc == 0 and "green" in log, log)
    rc, log = go(fake([{"id": 6, "status": "canceled"}, {"id": 5, "status": "running"}], red_jobs))
    check("no finished pipeline fails open", rc == 0 and "WARNING" in log, log)
    rc, log = go(fake([], red_jobs))
    check("empty pipeline list fails open", rc == 0 and "WARNING" in log, log)
    rc, log = go(fake(red, red_jobs, fail="HTTP 503"))
    check("API error fails open loudly", rc == 0 and "WARNING" in log and "FAILING OPEN" in log, log)
    rc, log = go(fake(red, [{"name": "x", "status": "failed", "allow_failure": True}]))
    check("failed pipeline with no blocking job fails open", rc == 0 and "WARNING" in log, log)
    rc, log = go(fake(red, red_jobs, issues=[]))
    check("red without a tracking issue still fails, naming it generically", rc == 1 and "open 'main is red' issue" in log, log)
    # Paging: 100 passing jobs on page 1, the blocking failure only on page 2.
    paged = [{"name": f"ok-{i}", "status": "success", "allow_failure": False} for i in range(c.PER_PAGE)]
    paged.append({"name": "page-two-job", "status": "failed", "allow_failure": False})
    rc, log = go(fake(red, paged, issues=issue))
    check("a failure on jobs page 2 still fails the guard", rc == 1 and "page-two-job" in log, log)
    if problems:
        print("self-test FAILED:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print("self-test OK")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return _self_test()
    api, pid = os.environ.get("CI_API_V4_URL"), os.environ.get("CI_PROJECT_ID")
    if not api or not pid:
        print("WARNING: CI_API_V4_URL/CI_PROJECT_ID unset; red-main guard FAILING OPEN.")
        return 0
    return run(c.Client(api, pid), dict(os.environ))


if __name__ == "__main__":
    sys.exit(main())
