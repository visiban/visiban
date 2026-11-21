#!/usr/bin/env python3
"""Tripwire for a red `main` (#2460): one tracking issue, opened while red, closed when green.

Runs in the built-in `.post` stage (after every other stage) of every main push
pipeline (never schedule). It reads that
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


UNFINISHED = ("running", "pending", "created")


def run(client: c.Client, env: dict, out=print) -> int:
    pipeline_id, url = env.get("CI_PIPELINE_ID"), env.get("CI_PIPELINE_URL", "")
    sha = (env.get("CI_COMMIT_SHA") or "")[:12]
    try:
        jobs = client.jobs(int(pipeline_id))
        failed = c.blocking_failures(jobs)
        own = env.get("CI_JOB_NAME", "main-red-tripwire")
        # Not judgeable as green while any other job is still in flight: closing the
        # issue on a pipeline that has not finished could turn red later. A failure is
        # decisive on its own, so this only gates the green (close) path.
        unfinished = sorted({j["name"] for j in jobs if j.get("status") in UNFINISHED and j.get("name") != own})
        # A newer main push pipeline that already finished owns the issue state: an
        # older pipeline's late .post job must not close (or reopen) over it. The
        # job's resource_group serializes concurrent tripwires; this check orders them.
        newest = c.latest_finished_main(client)
        if newest is not None and int(newest["id"]) > int(pipeline_id):
            out(f"Skipping: newer main pipeline {newest['id']} already finished ({newest.get('status')}); "
                f"pipeline {pipeline_id} is stale, so the tracking issue is left as is.")
            return 0
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
        elif unfinished:
            out("Not judgeable yet: still " + "/".join(UNFINISHED) + ": " + ", ".join(unfinished) + "; leaving the tracking issue as is.")
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

    def make(jobs, issues, fail_writes=False, pipelines=()):
        calls: list = []

        def fetch(method, url, headers, body):
            calls.append((method, url.split("/projects/1")[1].split("?")[0], (body or b"").decode()))
            if method != "GET" and fail_writes:
                raise c.ApiError("HTTP 403")
            if "/jobs" in url:
                return json.dumps(c.fake_page(jobs, url)).encode()
            if url.split("?")[0].endswith("/pipelines"):
                return json.dumps(list(pipelines)).encode()
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
    running_green = green + [{"name": "backend-test", "status": "running", "allow_failure": False}]
    cl, calls = make(running_green, open_issue)
    rc, log = go(cl)
    check("green so far but a job is running: no close, logs it",
          rc == 0 and all(x[0] == "GET" for x in calls) and "Not judgeable" in log and "backend-test" in log, (calls, log))
    own_job = green + [{"name": "main-red-tripwire", "status": "running", "allow_failure": True}]
    cl, calls = make(own_job, open_issue)
    go(cl)
    check("its own running job is ignored", any(x[0] == "PUT" for x in calls), calls)
    cl, calls = make(running_green + [{"name": "x", "status": "failed", "allow_failure": False}], open_issue)
    go(cl)
    check("a failure is decisive even with jobs running", [x[:2] for x in calls if x[0] != "GET"] == [("POST", "/issues/7/notes")], calls)
    cl, calls = make(green, [])
    go(cl)
    check("green, none open: no writes", all(x[0] == "GET" for x in calls), calls)
    cl, calls = make(red, [], fail_writes=True)
    rc, log = go(cl)
    check("write failure fails open loudly", rc == 0 and "WARNING" in log and "FAILING OPEN" in log, log)
    newer_done = [{"id": 10, "status": "success"}, {"id": 9, "status": "running"}]
    cl, calls = make(red, open_issue, pipelines=newer_done)
    rc, log = go(cl)
    check("a newer finished main pipeline exists: no writes, logs why",
          rc == 0 and all(x[0] == "GET" for x in calls) and "newer main pipeline 10" in log, (calls, log))
    cl, calls = make(green, open_issue, pipelines=[{"id": 10, "status": "failed"}])
    go(cl)
    check("an older green pipeline never closes over a newer red one", all(x[0] == "GET" for x in calls), calls)
    newer_running = [{"id": 11, "status": "running"}, {"id": 10, "status": "pending"}, {"id": 8, "status": "failed"}]
    cl, calls = make(red, [], pipelines=newer_running)
    go(cl)
    check("a newer pipeline still running: proceeds and writes",
          [x[:2] for x in calls if x[0] != "GET"] == [("POST", "/issues")], calls)
    paged = [{"name": f"ok-{i}", "status": "success", "allow_failure": False} for i in range(c.PER_PAGE)]
    paged.append({"name": "page-two-job", "status": "failed", "allow_failure": False})
    cl, calls = make(paged, open_issue)
    go(cl)
    check("a failure on jobs page 2 reads as red (comments, never closes)",
          [x[:2] for x in calls if x[0] != "GET"] == [("POST", "/issues/7/notes")] and "page-two-job" in calls[-1][2], calls)
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
