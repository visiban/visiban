#!/usr/bin/env python3
"""Refuse to publish a release tag whose commit did not pass its own `main` pipeline (#1154).

Why this exists
---------------
GitLab triggers pipelines per ref. Pushing `main` and a `v*` tag at the same
commit starts two independent pipelines, and nothing links them. The tag
pipeline's publish jobs used to be gated only on the test job that happened to
sit in their own `needs:` (`backend-docker-push` <- `backend-test-coverage`,
`frontend-docker-push` <- `frontend-test`), so a tag could publish images, the
Helm chart, the docs and a GitHub release while `playwright-e2e`,
`migration-check`, the SAST gates or anything else was red on that exact
commit. TruePPM shipped a broken release twice from the same gap.

`scripts/release.sh` already refuses to tag unless the pipeline at the merge
commit is green (!947), but that is a client-side check: a tag pushed by hand
skips it, and it reads the pipeline's aggregate `status`, which an
`allow_failure: true` job failing does not turn red. This script is the in-CI
half. The `release-main-pipeline-guard` job runs it in every `v*` tag pipeline,
and every publish job `needs:` that job.

What it checks, and why per job rather than the pipeline status
---------------------------------------------------------------
It resolves the newest `main` pipeline for the tagged SHA (`ref=main`, source
`push` or `web`; never a `schedule` pipeline, which runs a different job set)
and reads that pipeline's jobs, not its top-level status:

* The top-level status of a main pipeline whose `docs-deploy` stayed `manual`
  never resolves cleanly (the `/mass_merge` post-merge hang), and it reads
  `success` when an `allow_failure: true` job failed.
* So every job in the pipeline must be `success` unless it is listed in
  EXEMPT_JOBS below. A failed `allow_failure: true` job (`playwright-e2e`,
  `backend-lint`, the SAST analyzers, `oidc-smoke`) refuses the release.
  Deny-by-default is deliberate: an allowlist of required jobs goes stale by
  omission, so a new gate added later would be silently ungated on a release,
  which is the bug class #1154 was filed about.
* ALWAYS_REQUIRED jobs run on every main push pipeline, so their absence is
  itself a refusal (a job deleted or renamed, or its `rules:` narrowed, cannot
  vanish from the gate quietly). Every other job is change-conditional on main
  (`rules: changes:`, #1266): when the merge did not touch its paths it is
  legitimately absent, and that commit's MR pipeline ran it, since the project
  only merges on a green MR pipeline.
* WARN_TOLERATED jobs may finish `failed` when GitLab reports the failure as an
  allowed exit code (`allow_failure: true` on the job object), and only then.
  `dep-scan-osv` exits 2 for a MEDIUM/LOW advisory by design; exit 1 (HIGH or
  CRITICAL) is reported as `allow_failure: false` and still refuses.

Fail closed
-----------
No main pipeline, an API error, a non-JSON or wrongly shaped response, an
unknown job status, a missing required job, or a pipeline still running when
the timeout expires all refuse to publish. Nothing here ever reads "cannot
see" as "fine". There is no bypass variable. To get past a refusal, fix the
main pipeline: retry the failed job there (or fix forward and re-tag), then
retry `release-main-pipeline-guard` in the tag pipeline. See
docs/maintainers/known-ci-failures.md.

Usage
-----
  python3 scripts/wait-for-main-pipeline.py [--sha SHA]          # SHA defaults to $CI_COMMIT_SHA
  python3 scripts/wait-for-main-pipeline.py --check-ci-file .gitlab-ci.yml
  python3 scripts/wait-for-main-pipeline.py --self-test

`--check-ci-file` fails when a name in any list below is not a job in the CI
file, when a job sits in two lists that contradict each other, or when a
PUBLISH_JOBS entry does not list the guard in its `needs:`. It is how these
lists stay in step with `.gitlab-ci.yml`.

Environment
-----------
  CI_API_V4_URL, CI_PROJECT_ID, CI_COMMIT_SHA, CI_DEFAULT_BRANCH: supplied by GitLab CI.
  GITLAB_API_TOKEN (required): project access token, Reporter role, `read_api`
      scope, masked + protected. Sent as PRIVATE-TOKEN and never printed.
      Unset = refuse, before any request is made. Why a token at all:
      * CI_JOB_TOKEN cannot do this. The pipelines list is not in GitLab's
        job-token endpoint allowlist, and a rejected JOB-TOKEN header turns
        even a public read into a 401 (TruePPM #4040, Visiban #1694). It is
        never sent.
      * Anonymous reads work on a public project but are not reliable enough
        to gate a release on. gitlab.com rate-limits unauthenticated API
        traffic per IP per hour (`ratelimit-name: unauthenticated_traffic_per_ip`).
        A 45-minute poll from a shared runner IP spends that budget alongside
        every other tenant behind the same IP. While writing this, about 60
        reads from one workstation drew 429s with `retry-after` near an hour.
        A refusal caused by someone else's traffic is noise, so the guard
        requires the authenticated limit. It is also the only option for the
        private enterprise mirror, which receives every tag.
  MAIN_PIPELINE_GUARD_TIMEOUT_SECONDS (default 2700): total wait for the main
      pipeline's jobs to finish. A main pipeline takes about 13 minutes.
  MAIN_PIPELINE_GUARD_NOT_FOUND_SECONDS (default 600): how long to wait for a
      main pipeline to exist at all before refusing. A tag on a commit that is
      not on main would otherwise hold a runner for the full timeout.
  MAIN_PIPELINE_GUARD_POLL_SECONDS (default 30): seconds between polls.
  MAIN_PIPELINE_GUARD_MAX_API_ERRORS (default 5): consecutive transient API
      failures (network, 5xx, 429, non-JSON) tolerated before refusing. A
      401/403/404 refuses at once: retrying cannot change it.
None of these knobs can turn a refusal into a pass.

Exit codes: 0 publish may proceed, 1 refused (or a --check-ci-file/--self-test
failure), 2 invocation error (missing CI environment, bad knob value).
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from typing import Callable

GUARD_JOB = "release-main-pipeline-guard"

# Present in every main push pipeline (unconditional `$CI_COMMIT_BRANCH ==
# $CI_DEFAULT_BRANCH` rule). Missing from the pipeline = refuse. A parallel
# job (`backend-test`, `parallel: 8`) matches its `name i/n` instances, and
# every instance must pass.
ALWAYS_REQUIRED = (
    # Test suites: the publish path's own historical `needs:`, plus the rest.
    "backend-test",
    "backend-test-coverage",
    "backend-test-git-lens",
    "backend-test-mcp",
    "frontend-test",
    # Lint-stage gates that run on every main pipeline.
    "docs-version-accuracy",
    "suppressions-check",
    # Security. The two GitLab analyzer components (`semgrep-sast`,
    # `secret_detection`) are `allow_failure: true` and exit 0 on findings; the
    # `*-gate` jobs read their reports and block. A crashed analyzer means no
    # scan ran, so both halves are required on a release.
    "semgrep-sast",
    "sast-severity-gate",
    "secret_detection",
    "secret-detection-gate",
    "gitleaks-scan",
    "gitleaks-history",
    "dep-scan-osv",
)

# Jobs that may finish `failed` on a release commit only when GitLab reports
# the failure as allowed (`allow_failure: true` on the job object, which is
# what an `allow_failure: exit_codes:` match produces).
WARN_TOLERATED = {
    "dep-scan-osv": "exit 2 is the MEDIUM/LOW/unscored warn tier, non-blocking by "
    "design (#1288); exit 1 (HIGH/CRITICAL) reports allow_failure: false and refuses",
}

# Jobs whose status says nothing about the commit. Every job NOT listed here
# must be `success` if it is in the main pipeline, whatever its allow_failure.
EXEMPT_JOBS = {
    GUARD_JOB: "the guard itself; a no-op on branch pipelines",
    "cache-warm-pip": "primes the CI dependency cache; no verdict on the code",
    "cache-warm-pip-test": "primes the CI dependency cache; no verdict on the code",
    "cache-warm-npm": "primes the CI dependency cache; no verdict on the code",
    "backend-docker-push": "publishes :main/:<sha>, not a check; the tag pipeline rebuilds",
    "frontend-docker-push": "publishes :main/:<sha>, not a check; the tag pipeline rebuilds",
    "docs-deploy": "a publish, and `manual` on most main pipelines (the post-merge hang)",
    "backend-benchmark": "manual, on-demand tool (allow_failure: true); never runs unless played",
    "nightly-load-test": "manual on main; the real run is its own schedule",
    "seed-demo-data": "manual, on-demand tool for the hosted demo",
    "image-attest-backfill": "manual, on-demand re-attestation of already-published images",
}

# Every job that writes to a registry, a Pages branch or GitHub on a release
# tag. Each must list GUARD_JOB in its `needs:` directly (not only through a
# chain), so removing an upstream need can never ungate it.
PUBLISH_JOBS = (
    "backend-docker-push",
    "frontend-docker-push",
    "backend-docker-push-arm64",
    "frontend-docker-push-arm64",
    "backend-manifest",
    "frontend-manifest",
    "backend-image-attest",
    "frontend-image-attest",
    "helm-publish",
    "github-release",
    "docs-deploy",
)

ACCEPTED_SOURCES = ("push", "web")
IN_PROGRESS = frozenset(
    {"created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "canceling"}
)
FAILED_STATES = frozenset({"failed", "canceled", "skipped", "manual"})
PER_PAGE = 100
MAX_PAGES = 20

_PARALLEL_SUFFIX = re.compile(r"(?: \d+/\d+|: \[.*\])$")


class ApiError(Exception):
    """Any failure to read a usable answer from the GitLab API.

    `definitive` marks an answer that retrying cannot change (401/403/404 and
    other 4xx except 408/429): the guard refuses at once instead of polling.
    Everything else (network, 5xx, 429 rate limiting, a non-JSON proxy page)
    is retried up to MAIN_PIPELINE_GUARD_MAX_API_ERRORS consecutive times.
    """

    def __init__(self, message: str, definitive: bool = False):
        super().__init__(message)
        self.definitive = definitive


Fetch = Callable[[str, dict], bytes]


def _urllib_fetch(url: str, headers: dict) -> bytes:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310 - https API URL from CI
            return resp.read()
    except urllib.error.HTTPError as exc:
        hint = ""
        if exc.code in (401, 403, 404):
            hint = " (is GITLAB_API_TOKEN valid, unexpired, with read_api and Reporter?)"
        definitive = 400 <= exc.code < 500 and exc.code not in (408, 429)
        raise ApiError(f"HTTP {exc.code} from {url}{hint}", definitive=definitive) from None
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError(f"request to {url} failed: {type(exc).__name__}") from None


class GitLab:
    def __init__(self, api_url: str, project_id: str, token: str | None, fetch: Fetch = _urllib_fetch):
        self.base = f"{api_url.rstrip('/')}/projects/{urllib.parse.quote(str(project_id), safe='')}"
        self.token = token or None
        self.fetch = fetch

    def _get(self, path: str, params: dict) -> object:
        url = f"{self.base}{path}?{urllib.parse.urlencode(params)}"
        headers = {"Accept": "application/json", "User-Agent": "visiban-release-main-pipeline-guard"}
        if self.token:
            headers["PRIVATE-TOKEN"] = self.token
        body = self.fetch(url, headers)
        try:
            return json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise ApiError(f"non-JSON response from {url}") from None

    def latest_main_pipeline(self, sha: str, ref: str) -> dict | None:
        data = self._get(
            "/pipelines", {"ref": ref, "sha": sha, "order_by": "id", "sort": "desc", "per_page": PER_PAGE}
        )
        if not isinstance(data, list) or not all(isinstance(p, dict) and "id" in p for p in data):
            raise ApiError("pipelines response is not a list of pipeline objects")
        # Retried or re-run pipelines at one SHA: pick the newest deterministically,
        # by id, among the sources that run main's full job set.
        candidates = [p for p in data if p.get("source") in ACCEPTED_SOURCES and p.get("sha", sha) == sha]
        return max(candidates, key=lambda p: p["id"]) if candidates else None

    def jobs(self, pipeline_id: int) -> list[dict]:
        out: list[dict] = []
        for page in range(1, MAX_PAGES + 1):
            data = self._get(
                f"/pipelines/{int(pipeline_id)}/jobs",
                {"per_page": PER_PAGE, "page": page, "include_retried": "false"},
            )
            if not isinstance(data, list) or not all(
                isinstance(j, dict) and "name" in j and "status" in j and "id" in j for j in data
            ):
                raise ApiError("jobs response is not a list of job objects")
            out.extend(data)
            if len(data) < PER_PAGE:
                return out
        raise ApiError(f"more than {MAX_PAGES * PER_PAGE} jobs; refusing to judge a partial list")


def base_name(job_name: str) -> str:
    return _PARALLEL_SUFFIX.sub("", job_name)


def evaluate(jobs: list[dict]) -> tuple[str, list[str], list[str], list[str]]:
    """Return (verdict, problems, waiting, notes); verdict is PASS, WAIT or REFUSE."""
    if not jobs:
        return "WAIT", [], ["the pipeline has no jobs yet"], []
    # include_retried=false already hides retried attempts; keep only the newest
    # job per name anyway, so a retried-then-green job can never read as failed
    # (or a retried-then-red one as green) if the API ever returns both.
    latest: dict[str, dict] = {}
    for job in jobs:
        prev = latest.get(job["name"])
        if prev is None or job["id"] > prev["id"]:
            latest[job["name"]] = job
    present = {base_name(n) for n in latest}

    problems: list[str] = []
    waiting: list[str] = []
    notes: list[str] = []
    for name in ALWAYS_REQUIRED:
        if name not in present:
            problems.append(f"{name}: not in the main pipeline, but it runs on every main pipeline")
    for name in sorted(latest):
        job = latest[name]
        base = base_name(name)
        if base in EXEMPT_JOBS:
            continue
        status = job["status"]
        allowed = job.get("allow_failure") is True
        if status == "success":
            continue
        if status in IN_PROGRESS:
            waiting.append(f"{name}: {status}")
        elif status == "failed" and allowed and base in WARN_TOLERATED:
            notes.append(f"{name}: failed with an allowed exit code, tolerated ({WARN_TOLERATED[base]})")
        elif status in FAILED_STATES:
            suffix = " (allow_failure: true, still required on a release)" if allowed else ""
            problems.append(f"{name}: {status}{suffix}")
        else:
            problems.append(f"{name}: unknown status {status!r}; refusing rather than guessing")
    if problems:
        return "REFUSE", problems, waiting, notes
    if waiting:
        return "WAIT", problems, waiting, notes
    return "PASS", problems, waiting, notes


def wait_for_main(
    gl: GitLab,
    sha: str,
    ref: str,
    *,
    timeout: int,
    not_found_timeout: int,
    poll: int,
    max_errors: int,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    start = clock()
    errors = 0
    last_wait: list[str] = []
    seen_pipeline: int | None = None
    while True:
        elapsed = clock() - start
        found = True
        try:
            pipeline = gl.latest_main_pipeline(sha, ref)
            if pipeline is None:
                found = False
                verdict = "WAIT"
                problems: list[str] = []
                notes: list[str] = []
                last_wait = [f"no {ref} pipeline (source {'/'.join(ACCEPTED_SOURCES)}) for {sha} yet"]
            else:
                if pipeline["id"] != seen_pipeline:
                    seen_pipeline = pipeline["id"]
                    print(
                        f"Main pipeline {pipeline['id']} ({pipeline.get('source')}, status "
                        f"{pipeline.get('status')}): {pipeline.get('web_url', '')}"
                    )
                verdict, problems, last_wait, notes = evaluate(gl.jobs(pipeline["id"]))
            errors = 0
        except ApiError as exc:
            errors += 1
            print(f"API error ({errors}/{max_errors}): {exc}", file=sys.stderr)
            if exc.definitive or errors >= max_errors:
                why = "a definitive API error" if exc.definitive else f"{errors} consecutive API failures"
                print(
                    f"REFUSED: could not read the {ref} pipeline for {sha} ({why}). "
                    "Not being able to see the pipeline is not proof it passed.",
                    file=sys.stderr,
                )
                return 1
            verdict, problems, notes = "ERROR", [], []
            last_wait = [f"last API error: {exc}"]

        if verdict == "PASS":
            for note in notes:
                print(f"note: {note}")
            print(f"OK: every required job in {ref} pipeline {seen_pipeline} at {sha} succeeded; publish may proceed.")
            return 0
        if verdict == "REFUSE":
            print(f"REFUSED: {ref} pipeline {seen_pipeline} at {sha} is not green:", file=sys.stderr)
            for line in problems:
                print(f"  - {line}", file=sys.stderr)
            print(
                "Fix main (retry the failed job in that pipeline, or fix forward and re-tag), then "
                f"retry {GUARD_JOB} here. See docs/maintainers/known-ci-failures.md.",
                file=sys.stderr,
            )
            return 1
        if not found and elapsed >= not_found_timeout:
            print(
                f"REFUSED: no {ref} pipeline for {sha} after {int(elapsed)}s. Is the tagged commit on "
                f"{ref}? Release tags must point at a commit whose {ref} pipeline ran.",
                file=sys.stderr,
            )
            return 1
        if elapsed >= timeout:
            print(f"REFUSED: still waiting after {int(elapsed)}s (timeout {timeout}s):", file=sys.stderr)
            for line in last_wait:
                print(f"  - {line}", file=sys.stderr)
            return 1
        if verdict == "WAIT":
            shown = ", ".join(last_wait[:5]) + (f" (+{len(last_wait) - 5} more)" if len(last_wait) > 5 else "")
            print(f"[{int(elapsed)}s] waiting: {shown}")
        sleep(poll)


# ─── --check-ci-file ──────────────────────────────────────────────────────────

_TOP_KEY = re.compile(r"^([^\s#][^#]*?):\s*(?:#.*)?$")


def _job_blocks(text: str) -> dict[str, list[str]]:
    blocks: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith("#"):
            m = _TOP_KEY.match(line)
            current = m.group(1).strip().strip("'\"") if m else None
            if current is not None:
                blocks[current] = []
            continue
        if current is not None:
            blocks[current].append(line)
    return {k: v for k, v in blocks.items() if not k.startswith(".")}


def _needs_text(block: list[str]) -> str:
    for i, line in enumerate(block):
        m = re.match(r"^(\s+)needs:(.*)$", line)
        if not m:
            continue
        indent = len(m.group(1))
        parts = [m.group(2).split("#", 1)[0]]
        for nxt in block[i + 1 :]:
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            if len(nxt) - len(nxt.lstrip()) <= indent:
                break
            parts.append(nxt.split("#", 1)[0])
        return " ".join(parts)
    return ""


def check_ci_file(
    path: str,
    *,
    always: tuple = ALWAYS_REQUIRED,
    warn: dict = WARN_TOLERATED,
    exempt: dict = EXEMPT_JOBS,
    publish: tuple = PUBLISH_JOBS,
    guard: str = GUARD_JOB,
) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        blocks = _job_blocks(fh.read())
    problems = []
    for label, names in (
        ("ALWAYS_REQUIRED", always),
        ("WARN_TOLERATED", warn),
        ("EXEMPT_JOBS", exempt),
        ("PUBLISH_JOBS", publish),
        ("GUARD_JOB", (guard,)),
    ):
        for name in names:
            if name not in blocks:
                problems.append(f"{label}: {name!r} is not a job in {path}")
    for name in sorted(set(always) & set(exempt)):
        problems.append(f"{name!r} is both ALWAYS_REQUIRED and EXEMPT_JOBS")
    for name in sorted(set(warn) & set(exempt)):
        problems.append(f"{name!r} is both WARN_TOLERATED and EXEMPT_JOBS")
    guard_re = re.compile(rf"(?<![\w.-]){re.escape(guard)}(?![\w.-])")
    for name in publish:
        if name in blocks and not guard_re.search(_needs_text(blocks[name])):
            problems.append(f"PUBLISH_JOBS: {name!r} does not list {guard!r} in its needs:")
    return problems


# ─── --self-test ──────────────────────────────────────────────────────────────


def _self_test() -> int:
    failures: list[str] = []
    api = "https://gitlab.example/api/v4"
    token = "glpat-selftest-secret-value"

    ids = iter(range(10, 10**6))

    def job(name, status="success", jid=None, allow_failure=False):
        return {"id": jid or next(ids), "name": name, "status": status, "allow_failure": allow_failure}

    def green_jobs():
        jobs = []
        for name in ALWAYS_REQUIRED:
            if name == "backend-test":
                jobs += [job(f"backend-test {i}/8", jid=100 + i) for i in range(1, 9)]
            else:
                jobs.append(job(name))
        jobs += [job("playwright-e2e", allow_failure=True), job("docs-deploy", "manual", allow_failure=True)]
        jobs += [job("seed-demo-data", "manual", allow_failure=True), job(GUARD_JOB)]
        return jobs

    def replace(jobs, name, **kw):
        return [dict(j, **kw) if j["name"] == name else j for j in jobs]

    class Fake:
        """Routes URLs to canned responses; `pipelines` / `jobs` may be callables of the call count."""

        def __init__(self, pipelines, jobs=None, raw=None, fail_calls=()):
            self.pipelines, self.job_map, self.raw = pipelines, jobs or {}, raw
            self.fail_calls = set(fail_calls)
            self.calls: list[tuple[str, dict]] = []

        def __call__(self, url, headers):
            self.calls.append((url, dict(headers)))
            if len(self.calls) in self.fail_calls:
                raise ApiError(f"HTTP 502 from {url}")
            if self.raw is not None:
                r = self.raw(len(self.calls)) if callable(self.raw) else self.raw
                if isinstance(r, Exception):
                    raise r
                return r
            parsed = urllib.parse.urlparse(url)
            q = dict(urllib.parse.parse_qsl(parsed.query))
            if parsed.path.endswith("/pipelines"):
                p = self.pipelines(len(self.calls)) if callable(self.pipelines) else self.pipelines
                return json.dumps(p).encode()
            m = re.search(r"/pipelines/(\d+)/jobs$", parsed.path)
            assert m, url
            assert q.get("include_retried") == "false", url
            jobs = self.job_map[int(m.group(1))]
            jobs = jobs(len(self.calls)) if callable(jobs) else jobs
            page, per = int(q["page"]), int(q["per_page"])
            return json.dumps(jobs[(page - 1) * per : page * per]).encode()

    class Clock:
        def __init__(self):
            self.t = 0.0

        def __call__(self):
            return self.t

        def sleep(self, s):
            self.t += s

    def run(fake, *, tok=None, timeout=300, nf=60, poll=10, max_errors=3):
        clock = Clock()
        gl = GitLab(api, "42", tok, fetch=fake)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = wait_for_main(
                gl, "abc123", "main", timeout=timeout, not_found_timeout=nf, poll=poll,
                max_errors=max_errors, sleep=clock.sleep, clock=clock,
            )
        return rc, out.getvalue() + err.getvalue(), clock.t

    def check(desc, cond, detail=""):
        if cond:
            print(f"SELF-TEST OK: {desc}")
        else:
            failures.append(desc)
            print(f"SELF-TEST FAIL: {desc} {detail}", file=sys.stderr)

    push = [{"id": 900, "sha": "abc123", "source": "push", "status": "success"}]

    # 1. all green
    rc, log, _ = run(Fake(push, {900: green_jobs()}))
    check("all required jobs green -> publish allowed", rc == 0, log)

    # 2. allow_failure job failed
    rc, log, _ = run(Fake(push, {900: replace(green_jobs(), "playwright-e2e", status="failed")}))
    check("failed allow_failure job (playwright-e2e) -> refused", rc == 1 and "playwright-e2e: failed" in log, log)

    # 3. ALWAYS_REQUIRED job missing
    jobs = [j for j in green_jobs() if j["name"] != "suppressions-check"]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("always-required job missing from main pipeline -> refused", rc == 1 and "suppressions-check: not in" in log, log)

    # 4. change-conditional job absent is fine
    jobs = [j for j in green_jobs() if j["name"] != "playwright-e2e"]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("change-conditional job legitimately absent -> allowed", rc == 0, log)

    # 5. skipped / manual / canceled required job
    for st in ("skipped", "manual", "canceled"):
        rc, log, _ = run(Fake(push, {900: green_jobs() + [job("migration-check", st)]}))
        check(f"required job {st} -> refused", rc == 1 and f"migration-check: {st}" in log, log)

    # 6. no main pipeline -> refused after the not-found timeout, not the full one
    rc, log, waited = run(Fake([]), timeout=3000, nf=60, poll=10)
    check("no main pipeline -> refused after not-found timeout", rc == 1 and "no main pipeline" in log and waited <= 70, log)

    # 7. API errors: HTTP failure, non-JSON body, wrong shape
    rc, log, _ = run(Fake(None, raw=ApiError("HTTP 503 from x")), max_errors=3)
    check("persistent transient API error -> refused after max errors", rc == 1 and "3 consecutive" in log, log)
    fake = Fake(None, raw=ApiError("HTTP 404 from x", definitive=True))
    rc, log, _ = run(fake, max_errors=5)
    check("definitive API error (404) -> refused at once", rc == 1 and len(fake.calls) == 1 and "definitive" in log, log)
    rc, log, _ = run(Fake(None, raw=b"<html>gateway</html>"), max_errors=2)
    check("non-JSON response -> refused", rc == 1 and "non-JSON" in log, log)
    rc, log, _ = run(Fake({"message": "404 Project Not Found"}), max_errors=1)
    check("error object instead of a list -> refused", rc == 1 and "not a list" in log, log)
    rc, log, _ = run(Fake(push, {900: green_jobs()}, fail_calls={1, 2}), max_errors=3)
    check("transient API errors below the limit, then green -> allowed", rc == 0, log)
    rc, log, _ = run(Fake(push, {900: green_jobs()}, fail_calls={1, 2}), max_errors=2)
    check("API errors reaching the limit -> refused even though the pipeline is green", rc == 1, log)

    # The real fetch classifies HTTP codes: 4xx is definitive, except 408/429.
    real_urlopen = urllib.request.urlopen
    try:
        for code, definitive in ((401, True), (404, True), (429, False), (503, False)):
            def boom(req, timeout=None, _code=code):
                raise urllib.error.HTTPError(req.full_url, _code, "x", None, None)
            urllib.request.urlopen = boom
            try:
                _urllib_fetch(f"{api}/projects/42/pipelines", {})
                got = None
            except ApiError as exc:
                got = exc.definitive
            check(f"HTTP {code} is {'definitive' if definitive else 'retried'}", got is definitive, str(got))
    finally:
        urllib.request.urlopen = real_urlopen

    # 8. several pipelines at the SHA: newest push/web wins, schedule ignored
    many = [
        {"id": 950, "sha": "abc123", "source": "schedule", "status": "success"},
        {"id": 940, "sha": "abc123", "source": "push", "status": "failed"},
        {"id": 930, "sha": "abc123", "source": "push", "status": "success"},
    ]
    fake = Fake(many, {950: green_jobs(), 940: replace(green_jobs(), "frontend-test", status="failed"), 930: green_jobs()})
    rc, log, _ = run(fake)
    check("newest push pipeline chosen over older push and newer schedule", rc == 1 and "pipeline 940" in log, log)

    # 9. pagination: a failure on page 2 is seen
    filler = [job(f"filler-{i}", jid=5000 + i) for i in range(130)]
    jobs = green_jobs() + filler + [job("helm-lint", "failed", jid=9999)]
    fake = Fake(push, {900: jobs})
    rc, log, _ = run(fake)
    pages = [u for u, _ in fake.calls if "/jobs?" in u]
    check("failed job on the second jobs page -> refused", rc == 1 and "helm-lint: failed" in log and len(pages) == 2, log)

    # 10. retried jobs: newest attempt wins, both ways
    jobs = green_jobs() + [job("backend-lint", "failed", jid=7000), job("backend-lint", "success", jid=7001)]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("retried job: older failed, newer success -> allowed", rc == 0, log)
    jobs = green_jobs() + [job("backend-lint", "success", jid=7000), job("backend-lint", "failed", jid=7001)]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("retried job: older success, newer failed -> refused", rc == 1, log)
    # The API's order is not a contract: the newer attempt listed first must still win.
    jobs = green_jobs() + [job("backend-lint", "success", jid=7001), job("backend-lint", "failed", jid=7000)]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("retried job listed newest-first: newer success still wins -> allowed", rc == 0, log)

    # 11. still running: polls, then times out; or polls then passes
    running = replace(green_jobs(), "frontend-test", status="running")
    rc, log, waited = run(Fake(push, {900: running}), timeout=120, poll=30)
    check("still running past the timeout -> refused", rc == 1 and "still waiting" in log and waited >= 120, log)
    fake = Fake(lambda n: [] if n == 1 else push, {900: lambda n: running if n < 6 else green_jobs()})
    rc, log, _ = run(fake, timeout=600, poll=30)
    check("not found, then running, then green -> allowed after polling", rc == 0 and "waiting" in log, log)

    # 12. dep-scan-osv warn tier
    rc, log, _ = run(Fake(push, {900: replace(green_jobs(), "dep-scan-osv", status="failed", allow_failure=True)}))
    check("dep-scan-osv allowed-exit-code failure (warn) -> allowed with a note", rc == 0 and "tolerated" in log, log)
    rc, log, _ = run(Fake(push, {900: replace(green_jobs(), "dep-scan-osv", status="failed", allow_failure=False)}))
    check("dep-scan-osv hard failure -> refused", rc == 1, log)
    rc, log, _ = run(Fake(push, {900: green_jobs() + [job("backend-lint", "failed", allow_failure=True)]}))
    check("warn tolerance does not extend to other allow_failure jobs", rc == 1, log)

    # 13. parallel instances
    rc, log, _ = run(Fake(push, {900: replace(green_jobs(), "backend-test 3/8", status="failed")}))
    check("one failed parallel instance -> refused", rc == 1 and "backend-test 3/8: failed" in log, log)
    jobs = [j for j in green_jobs() if not j["name"].startswith("backend-test ")]
    rc, log, _ = run(Fake(push, {900: jobs}))
    check("no parallel instances of an always-required job -> refused", rc == 1 and "backend-test: not in" in log, log)

    # 14. unknown status
    rc, log, _ = run(Fake(push, {900: green_jobs() + [job("helm-lint", "frobnicated")]}))
    check("unknown job status -> refused", rc == 1 and "unknown status" in log, log)

    # 15. auth, through the real entry point (run_guard): GITLAB_API_TOKEN is
    # required, sent only as PRIVATE-TOKEN, never JOB-TOKEN, never printed.
    env = {
        "CI_API_V4_URL": api, "CI_PROJECT_ID": "42", "CI_COMMIT_SHA": "abc123", "CI_DEFAULT_BRANCH": "main",
        "CI_JOB_TOKEN": "glcbt-must-never-be-sent", "GITLAB_API_TOKEN": token,
        "MAIN_PIPELINE_GUARD_POLL_SECONDS": "10",
    }

    def guard(env, fake):
        clock = Clock()
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            rc = run_guard(env, [], fetch=fake, sleep=clock.sleep, clock=clock)
        return rc, out.getvalue()

    fake = Fake(push, {900: green_jobs()})
    rc, log = guard(env, fake)
    hdrs = [h for _, h in fake.calls]
    check("GITLAB_API_TOKEN sent as PRIVATE-TOKEN",
          rc == 0 and bool(hdrs) and all(h.get("PRIVATE-TOKEN") == token for h in hdrs), log)
    check("JOB-TOKEN never sent", not any("JOB-TOKEN" in h or "glcbt" in str(h) for h in hdrs))
    check("token value never printed", token not in log)
    check("pipelines query is scoped to ref=main and the SHA",
          "ref=main" in fake.calls[0][0] and "sha=abc123" in fake.calls[0][0])
    for unset in ("", "  ", None):
        e = {k: v for k, v in env.items() if k != "GITLAB_API_TOKEN"}
        if unset is not None:
            e["GITLAB_API_TOKEN"] = unset
        fake = Fake(push, {900: green_jobs()})
        rc, log = guard(e, fake)
        check(f"GITLAB_API_TOKEN {unset!r} -> refused before any API call",
              rc == 1 and not fake.calls and "GITLAB_API_TOKEN" in log, log)
    fake = Fake(push, {900: green_jobs()})
    rc, log = guard({k: v for k, v in env.items() if k != "CI_PROJECT_ID"}, fake)
    check("missing CI environment -> invocation error, no API call", rc == 2 and not fake.calls, log)
    rc, log = guard(dict(env, MAIN_PIPELINE_GUARD_POLL_SECONDS="0"), Fake(push, {900: green_jobs()}))
    check("an out-of-range knob -> invocation error", rc == 2, log)

    # 16. --check-ci-file on fixtures
    with tempfile.TemporaryDirectory(prefix="wfmp-1154-") as tmp:
        good = os.path.join(tmp, "good.yml")
        with open(good, "w", encoding="utf-8") as fh:
            fh.write(
                "# comment\n.hidden:\n  stage: x\n"
                "guard:\n  rules:\n    - if: '$CI_COMMIT_TAG'\n"
                "always-a:\n  needs: []\n"
                "warn-a:\n  needs: []\n"
                "exempt-a:\n  needs: []\n"
                "lint:colon-name:\n  needs: []\n"
                "pub-inline:\n  needs: [guard, always-a]  # c\n"
                "pub-list:\n  needs:\n    # why\n    - job: guard\n    - job: always-a\n  script: [x]\n"
            )
        kw = dict(always=("always-a", "lint:colon-name"), warn={"warn-a": ""}, exempt={"exempt-a": ""},
                  publish=("pub-inline", "pub-list"), guard="guard")
        check("--check-ci-file passes a consistent fixture", check_ci_file(good, **kw) == [], check_ci_file(good, **kw))
        p = check_ci_file(good, **dict(kw, always=("always-a", "renamed-job")))
        check("--check-ci-file flags a listed job missing from the CI file", any("renamed-job" in x for x in p), p)
        p = check_ci_file(good, **dict(kw, exempt={"always-a": ""}))
        check("--check-ci-file flags a job both required and exempt", any("both" in x for x in p), p)
        p = check_ci_file(good, **dict(kw, publish=("pub-inline", "always-a")))
        check("--check-ci-file flags a publish job without the guard in needs", any("'always-a' does not list" in x for x in p), p)
        p = check_ci_file(good, **dict(kw, exempt={".hidden": ""}))
        check("--check-ci-file does not accept a hidden template as a job", bool(p), p)
        bad = os.path.join(tmp, "bad.yml")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("guard:\n  needs: []\npub-inline:\n  needs: [guard-selftest]\npub-list:\n  script:\n    - echo guard\n"
                     "always-a: {}\nwarn-a: {}\nexempt-a: {}\nlint:colon-name: {}\n")
        p = check_ci_file(bad, **kw)
        check("--check-ci-file: a similarly named need or a mention outside needs does not count",
              sum("does not list" in x for x in p) == 2, p)

    print()
    if failures:
        print(f"SELF-TEST: {len(failures)} case(s) failed.", file=sys.stderr)
        return 1
    print("SELF-TEST: all cases passed.")
    return 0


class UsageError(Exception):
    pass


def _int_env(env: dict, name: str, default: int, minimum: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = minimum - 1
    if value < minimum:
        raise UsageError(f"{name}={raw!r} must be an integer >= {minimum}.")
    return value


def run_guard(
    env: dict,
    argv: list[str],
    *,
    fetch: Fetch = _urllib_fetch,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> int:
    sha = env.get("CI_COMMIT_SHA", "")
    if argv[:1] == ["--sha"] and len(argv) == 2:
        sha = argv[1]
    elif argv:
        print(__doc__.split("Usage", 1)[1].split("Environment", 1)[0], file=sys.stderr)
        return 2
    api, project = env.get("CI_API_V4_URL", ""), env.get("CI_PROJECT_ID", "")
    if not sha or not api or not project:
        print("ERROR: need a SHA (--sha or CI_COMMIT_SHA), CI_API_V4_URL and CI_PROJECT_ID.", file=sys.stderr)
        return 2
    try:
        knobs = dict(
            timeout=_int_env(env, "MAIN_PIPELINE_GUARD_TIMEOUT_SECONDS", 2700, 0),
            not_found_timeout=_int_env(env, "MAIN_PIPELINE_GUARD_NOT_FOUND_SECONDS", 600, 0),
            poll=_int_env(env, "MAIN_PIPELINE_GUARD_POLL_SECONDS", 30, 1),
            max_errors=_int_env(env, "MAIN_PIPELINE_GUARD_MAX_API_ERRORS", 5, 1),
        )
    except UsageError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    token = (env.get("GITLAB_API_TOKEN") or "").strip()
    if not token:
        print(
            "REFUSED: GITLAB_API_TOKEN is not set, so this commit's main pipeline cannot be read "
            "reliably and the release cannot be shown to have passed. Create a project access token "
            "(Reporter, read_api) as a masked, protected CI/CD variable named GITLAB_API_TOKEN. "
            "See docs/maintainers/tokens-and-rotation.md.",
            file=sys.stderr,
        )
        return 1
    ref = env.get("CI_DEFAULT_BRANCH") or "main"
    print(f"Release guard (#1154): checking the {ref} pipeline at {sha}.")
    return wait_for_main(GitLab(api, project, token, fetch=fetch), sha, ref, sleep=sleep, clock=clock, **knobs)


def main(argv: list[str]) -> int:
    # Line-buffer stdout so progress and the stderr verdict interleave in order in the job log.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    if argv[:1] == ["--self-test"]:
        return _self_test()
    if argv[:1] == ["--check-ci-file"] and len(argv) == 2:
        problems = check_ci_file(argv[1])
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        if problems:
            print("Update the lists in scripts/wait-for-main-pipeline.py to match .gitlab-ci.yml.", file=sys.stderr)
            return 1
        print(f"OK: release guard job lists match {argv[1]}.")
        return 0
    return run_guard(dict(os.environ), argv)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
