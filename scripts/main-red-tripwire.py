#!/usr/bin/env python3
"""Tripwire for a red `main` (#2460): one tracking issue, opened while red, closed when green.

Runs at the end of every main push pipeline (never schedule). It reads that
pipeline's jobs and:
  * red   (a non-allow_failure job failed): opens the single `main is red`
          issue (label `ci`), or comments on it if already open;
  * green: comments on and closes the open issue.
Token: KAIZEN_API_TOKEN (api scope, protected), else GITLAB_API_TOKEN. GITLAB_API_TOKEN
is read_api only, so without KAIZEN_API_TOKEN the write fails and the job warns
loudly instead of failing (fail open; the job is allow_failure). The MR-side
brake is scripts/main-red-guard.py.

Usage: python3 scripts/main-red-tripwire.py | --self-test
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import main_red_common as c  # noqa: E402


def run(client: c.Client, env: dict, out=print) -> int:
    pipeline_id, url = env.get("CI_PIPELINE_ID"), env.get("CI_PIPELINE_URL", "")
    sha = (env.get("CI_COMMIT_SHA") or "")[:12]
    try:
        failed = c.blocking_failures(client.jobs(int(pipeline_id)))
        issue = client.tracking_issue()
        if failed:
            body = (
                f"main pipeline {url} (commit {sha}) has failing job(s): "
                + ", ".join(f"`{n}`" for n in failed)
                + f".\n\nMerges are blocked by `main-red-guard` until this is fixed; a fix MR carries the `{c.ESCAPE_LABEL}` label."
            )
            if issue is None:
                made = client.call(
                    "POST", "/issues", form={"title": c.ISSUE_TITLE, "labels": c.ISSUE_LABEL, "description": body}
                )
                out(f"Opened tracking issue {made.get('web_url', '')}")
            else:
                client.call("POST", f"/issues/{int(issue['iid'])}/notes", form={"body": body})
                out(f"Commented on tracking issue {issue.get('web_url', '')}")
        elif issue is not None:
            client.call(
                "POST",
                f"/issues/{int(issue['iid'])}/notes",
                form={"body": f"main is green again in pipeline {url} (commit {sha}); closing."},
            )
            client.call("PUT", f"/issues/{int(issue['iid'])}", form={"state_event": "close"})
            out(f"Closed tracking issue {issue.get('web_url', '')}")
        else:
            out("main is green and no tracking issue is open.")
    except (c.ApiError, ValueError, KeyError, TypeError) as exc:
        out(f"WARNING: red-main tripwire could not update the tracking issue ({exc}); FAILING OPEN. "
            "Writing needs KAIZEN_API_TOKEN (api scope); see docs/maintainers/known-ci-failures.md.")
    return 0


def _self_test() -> int:
    import json

    problems: list = []

    def make(jobs, issues, fail_writes=False):
        calls: list = []

        def fetch(method, url, headers, body):
            calls.append((method, url.split("/projects/1")[1].split("?")[0], (body or b"").decode()))
            if method != "GET" and fail_writes:
                raise c.ApiError("HTTP 403")
            if "/jobs" in url:
                return json.dumps(jobs).encode()
            if url.split("?")[0].endswith("/issues") and method == "GET":
                return json.dumps(issues).encode()
            return json.dumps({"web_url": "http://x/issues/1"}).encode()

        return c.Client("http://x/api/v4", "1", "tok", fetch), calls

    def go(client):
        log: list = []
        rc = run(client, {"CI_PIPELINE_ID": "9", "CI_PIPELINE_URL": "http://x/p/9", "CI_COMMIT_SHA": "a" * 40}, log.append)
        return rc, "\n".join(log)

    def check(name, cond, extra):
        if not cond:
            problems.append(f"{name}: {extra}")

    red = [{"name": "script-tests", "status": "failed", "allow_failure": False},
           {"name": "oidc-smoke", "status": "failed", "allow_failure": True}]
    green = [{"name": "lint", "status": "success", "allow_failure": False},
             {"name": "oidc-smoke", "status": "failed", "allow_failure": True}]
    open_issue = [{"iid": 7, "title": c.ISSUE_TITLE, "web_url": "http://x/issues/7"}]
    other = [{"iid": 8, "title": "main is red, maybe", "web_url": "http://x/issues/8"}]

    cl, calls = make(red, [])
    rc, log = go(cl)
    posts = [x for x in calls if x[0] == "POST"]
    check("red, none open: opens one issue", rc == 0 and len(posts) == 1 and posts[0][1] == "/issues"
          and "script-tests" in posts[0][2] and "oidc-smoke" not in posts[0][2] and "labels=ci" in posts[0][2], calls)
    cl, calls = make(red, open_issue)
    rc, log = go(cl)
    check("red, one open: comments, creates nothing",
          [x[:2] for x in calls if x[0] != "GET"] == [("POST", "/issues/7/notes")], calls)
    cl, calls = make(red, other)
    go(cl)
    check("non-exact title is not reused", any(x[:2] == ("POST", "/issues") for x in calls), calls)
    cl, calls = make(green, open_issue)
    rc, log = go(cl)
    check("green, one open: comments then closes",
          [x[:2] for x in calls if x[0] != "GET"] == [("POST", "/issues/7/notes"), ("PUT", "/issues/7")]
          and "state_event=close" in calls[-1][2], calls)
    cl, calls = make(green, [])
    go(cl)
    check("green, none open: no writes", all(x[0] == "GET" for x in calls), calls)
    cl, calls = make(red, [], fail_writes=True)
    rc, log = go(cl)
    check("write failure fails open loudly", rc == 0 and "WARNING" in log and "FAILING OPEN" in log, log)
    if problems:
        print("self-test FAILED:\n  " + "\n  ".join(map(str, problems)), file=sys.stderr)
        return 1
    print("self-test OK")
    return 0


def main() -> int:
    if "--self-test" in sys.argv[1:]:
        return _self_test()
    api, pid, pipe = os.environ.get("CI_API_V4_URL"), os.environ.get("CI_PROJECT_ID"), os.environ.get("CI_PIPELINE_ID")
    token = os.environ.get("KAIZEN_API_TOKEN") or os.environ.get("GITLAB_API_TOKEN")
    if not (api and pid and pipe and token):
        print("WARNING: red-main tripwire needs CI_API_V4_URL, CI_PROJECT_ID, CI_PIPELINE_ID and "
              "KAIZEN_API_TOKEN/GITLAB_API_TOKEN; FAILING OPEN without updating the tracking issue.")
        return 0
    return run(c.Client(api, pid, token), dict(os.environ))


if __name__ == "__main__":
    sys.exit(main())
