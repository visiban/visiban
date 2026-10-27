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
see" as "fine". There is no bypass variable, and the commit judged is the
one the job checked out: a CI_COMMIT_SHA or --sha pointing anywhere else
(a pipeline variable can override CI_COMMIT_SHA) refuses. Known gap: the
guard gates only the tag pipeline. `main`'s own docs-deploy publishes a
release's versioned docs when the release merge lands, before any tag
exists. To get past a refusal, fix the
main pipeline: retry the failed job there (or fix forward and re-tag), then
retry `release-main-pipeline-guard` in the tag pipeline. See
docs/maintainers/known-ci-failures.md.

Usage
-----
  python3 scripts/wait-for-main-pipeline.py [--sha SHA]          # SHA defaults to $CI_COMMIT_SHA
  python3 scripts/wait-for-main-pipeline.py --check-ci-file .gitlab-ci.yml
  python3 scripts/wait-for-main-pipeline.py --self-test

`--check-ci-file` keeps the lists below in step with `.gitlab-ci.yml`. Each
of these fails it:
  * a listed name that is not a job, or a job in two contradictory lists
  * a PUBLISH_JOBS entry whose `needs:` lacks the guard, or has it with
    `optional: true`
  * an ALWAYS_REQUIRED job that does not run automatically on every main
    pipeline, for example because its main rule gained `changes:` or
    `when: manual`
  * a job outside EXEMPT_JOBS that can be `manual` on main
  * an unlisted job that can run on a tag pipeline and either sits in the
    `deploy` stage or `needs:` a publish job; it must be in PUBLISH_JOBS or
    TAG_READONLY
The two list assumptions matter because a drift there would surface only at
tag time, and the guard reads its lists from the tagged commit, so that tag
could never pass.

How it reads `rules:`: line by line, through `extends:` and resolved `<<:`
anchors, first match wins. Each `if:` is evaluated as `||` of `&&` of
comparisons on CI_PIPELINE_SOURCE, CI_COMMIT_TAG, CI_COMMIT_BRANCH and
CI_MERGE_REQUEST_*. Anything else (another variable, parentheses, an
unresolvable merge, an inline or !reference rules value) is "unknown", and
unknown always resolves toward a failure: tag-runnable for discovery, and not
"always" or possibly-manual for the list checks. It does not model `exists:`
or `changes:` contents.

One shape it still cannot see, and does not claim to: a job that publishes
from a non-deploy stage and needs no publish job.

Environment
-----------
  CI_API_V4_URL, CI_PROJECT_ID, CI_COMMIT_SHA, CI_DEFAULT_BRANCH: supplied by GitLab CI.
  GITLAB_API_TOKEN (required): a personal access token with the `read_api`
      scope, owned by an account with Reporter role or higher on the project
      (a dedicated bot user, not a maintainer's own account), stored masked +
      protected. Not a project or group access token: on GitLab.com those
      need Premium, and the `visiban` group is on the Free plan. Sent as
      PRIVATE-TOKEN and never printed.
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

# Jobs that run on a release tag in the deploy stage (or after a publish job)
# but write nothing anywhere, so they need no guard. --check-ci-file fails on
# any tag-runnable deploy-stage job that is in neither this nor PUBLISH_JOBS.
TAG_READONLY = {
    "arm64-runner-preflight": "reads the Runners API so the arm64 legs fail fast instead of hanging",
    "latest-tag-stability-check": "reads the registries to check :latest after the manifests",
}

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

_TOP_KEY = re.compile(r"^([^\s#][^#]*?):\s*(?:&([\w.-]+))?\s*(?:#.*)?$")
_ANCHORS = "\0anchors"  # pseudo-block: anchor name -> top-level key that defines it


def _all_blocks(text: str) -> dict[str, list[str]]:
    """Top-level key -> its indented lines, hidden templates (`.name`) included."""
    blocks: dict[str, list[str]] = {}
    anchors: list[str] = []
    current: str | None = None
    for line in text.splitlines():
        if line and not line[0].isspace() and not line.startswith("#"):
            m = _TOP_KEY.match(line)
            current = m.group(1).strip().strip("'\"") if m else None
            if current is not None:
                blocks[current] = []
                if m.group(2):
                    anchors.append(f"{m.group(2)}={current}")
            continue
        if current is not None:
            blocks[current].append(line)
    blocks[_ANCHORS] = anchors
    return blocks


def _job_blocks(text: str) -> dict[str, list[str]]:
    return {k: v for k, v in _all_blocks(text).items() if not k.startswith((".", "\0"))}


def _parents(blocks: dict[str, list[str]], name: str) -> tuple[list[str], bool]:
    """(keys to inherit from, in lookup order; whether a `<<:` merge could not be resolved).

    A YAML `<<: *anchor` merge is applied before `extends:`, so its keys rank
    above every extended template; among extended templates the last wins."""
    anchors = dict(a.split("=", 1) for a in blocks.get(_ANCHORS, []))
    merged, unresolved = [], False
    for line in blocks[name]:
        m = re.match(r"^  <<:\s*\*([\w.-]+)\s*$", line)
        if m:
            if m.group(1) in anchors:
                merged.append(anchors[m.group(1)])
            else:
                unresolved = True
        elif re.match(r"^  <<:", line):
            unresolved = True
    ext = _section(blocks[name], "extends")
    extended = re.findall(r"[.\w][\w.:-]*", " ".join(ext)) if ext else []
    return merged + list(reversed(extended)), unresolved


_NOT_JOBS = frozenset({"stages", "workflow", "variables", "default", "include", "image", "services", "cache"})


def _section(block: list[str], key: str) -> list[str] | None:
    """The job-level `key:` (two-space indent) as [inline value, child lines...], or None."""
    for i, line in enumerate(block):
        m = re.match(rf"^  {re.escape(key)}:(.*)$", line)
        if not m:
            continue
        out = [m.group(1).split("#", 1)[0]]
        for nxt in block[i + 1 :]:
            if not nxt.strip() or nxt.lstrip().startswith("#"):
                continue
            if len(nxt) - len(nxt.lstrip()) <= 2:
                break
            out.append(nxt.split("#", 1)[0])
        return out
    return None


def _needs_text(block: list[str]) -> str:
    sec = _section(block, "needs")
    return " ".join(sec) if sec else ""


def _effective(blocks: dict[str, list[str]], name: str, key: str, seen: frozenset = frozenset()) -> list[str] | None:
    """`key` for a job, following `extends:` (own value first, then the last template that sets it)."""
    if name in seen or name not in blocks:
        return None
    own = _section(blocks[name], key)
    if own is not None:
        return own
    for parent in _parents(blocks, name)[0]:
        found = _effective(blocks, parent, key, seen | {name})
        if found is not None:
            return found
    return None


def _has_merge_key(blocks: dict[str, list[str]], name: str, seen: frozenset = frozenset()) -> bool:
    """True if the job or anything it inherits from has a `<<:` merge this reader cannot resolve."""
    if name in seen or name not in blocks:
        return False
    parents, unresolved = _parents(blocks, name)
    return unresolved or any(_has_merge_key(blocks, p, seen | {name}) for p in parents)


def _rule_items(rules: list[str]) -> list[str] | None:
    """Split a `rules:` section into its list items; None when it cannot be split."""
    items: list[str] = []
    item_indent: int | None = None
    for line in rules[1:]:
        m = re.match(r"^(\s*)- ", line)
        if m and (item_indent is None or len(m.group(1)) == item_indent):
            item_indent = len(m.group(1))
            items.append(line)
        elif items:
            items[-1] += "\n" + line
    if not items and rules[0].strip():
        return None  # an inline, anchored or !reference rules value
    return items


_ATOM_EQ = re.compile(r"""^\$(\w+)\s*(==|!=|=~|!~)\s*(.+)$""")


def _atom(atom: str, ctx: str) -> bool | None:
    """Can one `if:` comparison be true in a `ctx` pipeline ("tag": a v* tag push;
    "main": a push to the default branch)? None = this reader cannot tell."""
    atom = atom.strip().strip("()").strip()
    m = _ATOM_EQ.match(atom)
    if m:
        var, op, val = m.group(1), m.group(2), m.group(3).strip().strip("'\"")
    elif re.fullmatch(r"\$\w+", atom):
        var, op, val = atom[1:], "set", ""
    else:
        return None
    if var == "CI_PIPELINE_SOURCE" and op in ("==", "!="):
        # A tag pipeline's source is `push`. A main pipeline the guard may judge
        # is `push` or `web` (ACCEPTED_SOURCES): true for both is True, for
        # neither is False, and for only one is "possibly" (None).
        results = {(src == val) == (op == "==") for src in (("push",) if ctx == "tag" else ACCEPTED_SOURCES)}
        return results.pop() if len(results) == 1 else None
    if var == "CI_COMMIT_TAG":
        if ctx == "tag":
            return None if op in ("!=", "!~") else True
        return op in ("!=", "!~")  # unset on a branch pipeline
    if var == "CI_COMMIT_BRANCH":
        if ctx == "tag":
            return op in ("!=", "!~")  # unset on a tag pipeline
        if op == "set":
            return True
        if val in ("$CI_DEFAULT_BRANCH", "main"):
            return op == "=="
        if op == "==" and val.startswith("$") is False:
            return False
        return None
    if var.startswith("CI_MERGE_REQUEST") or var == "CI_OPEN_MERGE_REQUESTS":
        return op in ("!=", "!~")
    return None


def _cond(text: str, ctx: str) -> bool | None:
    """Evaluate an `if:` expression: `||` of `&&` of atoms; None when unknown."""
    text = text.split("#", 1)[0].strip().strip("'\"")
    if "(" in text:
        return None
    ors = []
    for part in text.split("||"):
        ands = [_atom(a, ctx) for a in part.split("&&")]
        if any(a is False for a in ands):
            ors.append(False)
        elif all(a is True for a in ands):
            ors.append(True)
        else:
            ors.append(None)
    if any(o is True for o in ors):
        return True
    if all(o is False for o in ors):
        return False
    return None


def _item_parts(item: str) -> tuple[str | None, str | None, bool]:
    cond = re.search(r"\bif:\s*(.+)", item)
    when = re.search(r"\bwhen:\s*(\w+)", item)
    conditional = re.search(r"\b(changes|exists):", item) is not None
    return (cond.group(1) if cond else None, when.group(1) if when else None, conditional)


def _runs_on_tag(blocks: dict[str, list[str]], name: str) -> bool:
    """Can this job run in a `v*` tag pipeline? Errs toward yes.

    First matching rule wins. On a tag pipeline `changes:` is always true, so it
    is ignored. An item whose `if:` is certainly true decides it (`when: never`
    = no); certainly false is skipped; unknown counts as yes unless it is a
    `when: never`, which is then skipped. No rules, or rules this reader cannot
    see (`<<:` merge, an inline or !reference value) = yes.
    """
    rules = _effective(blocks, name, "rules")
    if rules is None:
        return True
    items = _rule_items(rules)
    if items is None:
        return True
    for item in items:
        cond, when, _ = _item_parts(item)
        c = True if cond is None else _cond(cond, "tag")
        if c is False:
            continue
        if when == "never":
            if c is True:
                return False
            continue
        return True
    return False


def _main_outcome(blocks: dict[str, list[str]], name: str) -> str:
    """How a job behaves on every push to main: "always" (runs, automatically,
    whatever the merge touched), "manual-possible", "conditional", or "unknown".
    Used to check the list assumptions, so unknown never reads as "always"."""
    job_when = " ".join(_effective(blocks, name, "when") or []).strip()
    rules = _effective(blocks, name, "rules")
    if rules is None:
        if _has_merge_key(blocks, name):
            return "unknown"
        return "manual-possible" if job_when == "manual" else "always"
    items = _rule_items(rules)
    if items is None:
        return "unknown"
    manual = False
    for item in items:
        cond, when, conditional = _item_parts(item)
        c = True if cond is None else _cond(cond, "main")
        if c is False:
            continue
        effective_when = when or job_when or "on_success"
        if effective_when == "manual":
            manual = True
        if c is None:
            return "manual-possible" if manual else "unknown"
        if conditional:
            continue
        if effective_when == "never":
            return "manual-possible" if manual else "conditional"
        if manual:
            return "manual-possible"
        return "always"
    return "manual-possible" if manual else "conditional"


def _guard_need_problem(block: list[str], guard: str) -> str | None:
    """None if the job hard-needs the guard; else why not (missing, or `optional: true`)."""
    sec = _section(block, "needs")
    if not sec:
        return "does not list it in its needs:"
    guard_re = re.compile(rf"(?<![\w.-]){re.escape(guard)}(?![\w.-])")
    text = " ".join(sec)
    if not guard_re.search(text):
        return "does not list it in its needs:"
    # Flow form: [a, {job: guard, optional: true}]; block form: "- job: guard\n  optional: true".
    for chunk in re.findall(r"\{[^}]*\}", sec[0]) + (_rule_items(sec) or []):
        if guard_re.search(chunk) and re.search(r"\boptional:\s*true\b", chunk):
            return "needs it with `optional: true`, which would let it publish without the guard"
    return None


def check_ci_file(
    path: str,
    *,
    always: tuple = ALWAYS_REQUIRED,
    warn: dict = WARN_TOLERATED,
    exempt: dict = EXEMPT_JOBS,
    publish: tuple = PUBLISH_JOBS,
    readonly: dict | None = None,
    guard: str = GUARD_JOB,
) -> list[str]:
    readonly = TAG_READONLY if readonly is None else readonly
    with open(path, encoding="utf-8") as fh:
        everything = _all_blocks(fh.read())
    blocks = {k: v for k, v in everything.items() if not k.startswith((".", "\0")) and k not in _NOT_JOBS}
    problems = []
    for label, names in (
        ("ALWAYS_REQUIRED", always),
        ("WARN_TOLERATED", warn),
        ("EXEMPT_JOBS", exempt),
        ("PUBLISH_JOBS", publish),
        ("TAG_READONLY", readonly),
        ("GUARD_JOB", (guard,)),
    ):
        for name in names:
            if name not in blocks:
                problems.append(f"{label}: {name!r} is not a job in {path}")
    for name in sorted(set(always) & set(exempt)):
        problems.append(f"{name!r} is both ALWAYS_REQUIRED and EXEMPT_JOBS")
    for name in sorted(set(warn) & set(exempt)):
        problems.append(f"{name!r} is both WARN_TOLERATED and EXEMPT_JOBS")
    for name in sorted(set(publish) & set(readonly)):
        problems.append(f"{name!r} is both PUBLISH_JOBS and TAG_READONLY")
    for name in publish:
        if name in blocks:
            why = _guard_need_problem(blocks[name], guard)
            if why:
                problems.append(f"PUBLISH_JOBS: {name!r} {why} ({guard!r})")
    # The list assumptions the runtime verdict rests on. A drift here would only
    # surface at tag time, and since the guard re-reads these lists from the
    # tagged commit, that tag could then never pass: catch it on the MR instead.
    for name in always:
        if name in blocks:
            outcome = _main_outcome(everything, name)
            if outcome != "always":
                problems.append(
                    f"ALWAYS_REQUIRED: {name!r} must run automatically on every main pipeline, "
                    f"but its rules read as {outcome!r} (a `changes:`/manual rule, or rules this "
                    "check cannot read); move it out of ALWAYS_REQUIRED or restore an unconditional main rule"
                )
    for name in sorted(blocks):
        if name in exempt or name == guard:
            continue
        outcome = _main_outcome(everything, name)
        if outcome == "manual-possible":
            problems.append(
                f"{name!r} can be `manual` on a main pipeline, where an un-played manual job refuses "
                "every release; add it to EXEMPT_JOBS with a reason, or make it automatic"
            )
        elif outcome == "unknown":
            problems.append(
                f"{name!r}: this check cannot read its rules, so it cannot rule out a `manual` job on "
                "main; simplify the rules or add it to EXEMPT_JOBS with a reason"
            )
    # Discovery, so a new publish job cannot be forgotten: every job that can
    # run on a tag pipeline and either sits in the `deploy` stage or needs a
    # publish job must be classified as PUBLISH_JOBS (gated) or TAG_READONLY.
    publish_re = re.compile(r"(?<![\w.-])(?:" + "|".join(map(re.escape, publish)) + r")(?![\w.-])") if publish else None
    for name in sorted(blocks):
        if name == guard or name in publish or name in readonly:
            continue
        if not _runs_on_tag(everything, name):
            continue
        stage = " ".join(_effective(everything, name, "stage") or ["test"]).strip() or "test"
        needs = " ".join(_effective(everything, name, "needs") or [])
        if stage == "deploy" or (publish_re and publish_re.search(needs)):
            problems.append(
                f"{name!r} can run on a release tag (stage {stage}) but is in neither PUBLISH_JOBS "
                f"(gated on {guard}) nor TAG_READONLY"
            )
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

    # 1b. the verdict is the jobs', never the pipeline's top-level status: a
    # main pipeline stays `manual`/`running` (docs-deploy waiting) or reads
    # `failed`/`blocked` for an exempt job while every required job is green.
    for top in ("manual", "running", "failed", "blocked", "canceled", "skipped"):
        rc, log, _ = run(Fake([dict(push[0], status=top)], {900: green_jobs()}))
        check(f"top-level status {top!r} with every required job green -> allowed", rc == 0, log)
    rc, log, _ = run(Fake(push, {900: replace(green_jobs(), "frontend-test", status="failed")}))
    check("top-level status 'success' with a required job failed -> refused",
          rc == 1 and "frontend-test: failed" in log, log)

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

    # 13b. a pipeline that never gets any jobs is not a pass
    rc, log, _ = run(Fake(push, {900: []}), timeout=120, poll=30)
    check("main pipeline with no jobs -> refused at the timeout", rc == 1 and "no jobs yet" in log, log)

    # 14. unknown status
    rc, log, _ = run(Fake(push, {900: green_jobs() + [job("helm-lint", "frobnicated")]}))
    check("unknown job status -> refused", rc == 1 and "unknown status" in log, log)

    # 15. auth, through the real entry point (run_guard): GITLAB_API_TOKEN is
    # required, sent only as PRIVATE-TOKEN, never JOB-TOKEN, never printed.
    sha40 = "c0ffee" + "1" * 34
    push40 = [dict(push[0], sha=sha40)]
    env = {
        "CI_API_V4_URL": api, "CI_PROJECT_ID": "42", "CI_COMMIT_SHA": sha40, "CI_DEFAULT_BRANCH": "main",
        "CI_JOB_TOKEN": "glcbt-must-never-be-sent", "GITLAB_API_TOKEN": token,
        "MAIN_PIPELINE_GUARD_POLL_SECONDS": "10",
    }
    repo_tmp = tempfile.TemporaryDirectory(prefix="wfmp-1154-repo-")
    repo = repo_tmp.name
    os.makedirs(os.path.join(repo, ".git", "refs", "heads"))

    def set_head(content):
        with open(os.path.join(repo, ".git", "HEAD"), "w", encoding="utf-8") as fh:
            fh.write(content + "\n")

    set_head(sha40)  # a CI checkout is a detached HEAD

    def guard(env, fake, repo_dir=repo):
        clock = Clock()
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(out):
            rc = run_guard(env, [], fetch=fake, sleep=clock.sleep, clock=clock, repo_dir=repo_dir)
        return rc, out.getvalue()

    push = push40  # the remaining run_guard cases use the full SHA
    fake = Fake(push, {900: green_jobs()})
    rc, log = guard(env, fake)
    hdrs = [h for _, h in fake.calls]
    check("GITLAB_API_TOKEN sent as PRIVATE-TOKEN",
          rc == 0 and bool(hdrs) and all(h.get("PRIVATE-TOKEN") == token for h in hdrs), log)
    check("JOB-TOKEN never sent", not any("JOB-TOKEN" in h or "glcbt" in str(h) for h in hdrs))
    check("token value never printed", token not in log)
    check("pipelines query is scoped to ref=main and the SHA",
          "ref=main" in fake.calls[0][0] and f"sha={sha40}" in fake.calls[0][0])
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

    # 15b. the guard vouches only for the commit actually checked out: an
    # overridden CI_COMMIT_SHA (or --sha) pointing at another, green commit refuses.
    older = "0ld" + "2" * 37
    fake = Fake([dict(push[0], sha=older)], {900: green_jobs()})
    rc, log = guard(dict(env, CI_COMMIT_SHA=older), fake)
    check("CI_COMMIT_SHA overridden to another (green) commit -> refused before any API call",
          rc == 1 and not fake.calls and "checked out here is" in log, log)
    fake = Fake(push, {900: green_jobs()})
    rc, log = guard(env, fake, repo_dir=os.path.join(repo, "no-such-dir"))
    check("no readable checkout (GIT_STRATEGY: none) -> refused", rc == 1 and not fake.calls, log)
    set_head("ref: refs/heads/main")
    with open(os.path.join(repo, ".git", "refs", "heads", "main"), "w", encoding="utf-8") as fh:
        fh.write(sha40 + "\n")
    rc, log = guard(env, Fake(push, {900: green_jobs()}))
    check("HEAD as a symbolic ref resolves through refs/", rc == 0, log)
    os.remove(os.path.join(repo, ".git", "refs", "heads", "main"))
    with open(os.path.join(repo, ".git", "packed-refs"), "w", encoding="utf-8") as fh:
        fh.write(f"# pack-refs\n{sha40} refs/heads/main\n")
    rc, log = guard(env, Fake(push, {900: green_jobs()}))
    check("HEAD as a symbolic ref resolves through packed-refs", rc == 0, log)
    set_head(sha40)
    repo_tmp.cleanup()

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
                  publish=("pub-inline", "pub-list"), readonly={}, guard="guard")
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

        # Discovery: a tag-runnable deploy-stage job (or one that needs a publish
        # job) must be classified, so a new publish job cannot skip the guard.
        disc = os.path.join(tmp, "disc.yml")
        tag = "    - if: '$CI_COMMIT_TAG =~ /^v[0-9]+/'\n"
        main_only = "    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n"
        with open(disc, "w", encoding="utf-8") as fh:
            fh.write(
                "guard:\n  stage: lint\n"
                ".deploy-tpl:\n  stage: deploy\n  rules:\n" + tag +
                "pub:\n  extends: .deploy-tpl\n  needs: [guard]\n"
                "ro-check:\n  extends: .deploy-tpl\n  needs: [pub]\n"
                "main-only:\n  stage: deploy\n  rules:\n" + main_only +
                "    - if: '$CI_PIPELINE_SOURCE == \"schedule\"'\n"
                "never-on-tag:\n  stage: deploy\n  rules:\n    - if: '$CI_COMMIT_TAG'\n      when: never\n"
                "    - when: manual\n"
                "test-on-tag:\n  stage: test\n  rules:\n    - changes:\n        - x/**/*\n" + main_only +
                "new-publish:\n  extends: .deploy-tpl\n  needs: []\n"
                "bare-changes-deploy:\n  stage: deploy\n  rules:\n    - changes:\n        - y/*\n"
                "after-pub:\n  rules:\n" + tag + "  needs:\n    - job: pub\n"
            )
        dkw = dict(always=(), warn={}, exempt={}, publish=("pub",), readonly={"ro-check": ""}, guard="guard")
        p = check_ci_file(disc, **dkw)
        flagged = sorted(n for n in ("new-publish", "bare-changes-deploy", "after-pub", "main-only",
                                     "never-on-tag", "test-on-tag", "ro-check", "pub")
                         if any(f"'{n}' can run on a release tag" in x for x in p))
        check("--check-ci-file flags unclassified tag-runnable deploy jobs and jobs after a publish job, "
              "following extends: and first-match rules",
              flagged == ["after-pub", "bare-changes-deploy", "new-publish"]
              and sum("can run on a release tag" in x for x in p) == 3, p)
        p = check_ci_file(disc, **dict(dkw, readonly={}))
        check("--check-ci-file flags a read-only tag job once it leaves TAG_READONLY",
              any("'ro-check' can run" in x for x in p), p)

        # Rules the old reader read as tag-false: `!=` on the MR source, and `||`.
        disc2 = os.path.join(tmp, "disc2.yml")
        with open(disc2, "w", encoding="utf-8") as fh:
            fh.write(
                "guard:\n  stage: lint\n"
                "not-mr:\n  stage: deploy\n  rules:\n    - if: '$CI_PIPELINE_SOURCE != \"merge_request_event\"'\n"
                "or-tag:\n  stage: deploy\n  rules:\n    - if: '$CI_COMMIT_BRANCH == \"x\" || $CI_COMMIT_TAG'\n"
                "odd-var:\n  stage: deploy\n  rules:\n    - if: '$SOME_FLAG == \"true\"'\n"
                "sched-only:\n  stage: deploy\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"schedule\" && $X == \"1\"'\n"
                "branch-and-push:\n  stage: deploy\n  rules:\n"
                "    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"push\"'\n"
                "pub-opt:\n  stage: deploy\n  needs:\n    - job: guard\n      optional: true\n"
                "pub-opt-flow:\n  stage: deploy\n  needs: [{job: guard, optional: true}]\n"
                "pub-ok:\n  stage: deploy\n  needs:\n    - job: guard\n      optional: false\n"
            )
        p = check_ci_file(disc2, always=(), warn={}, exempt={}, publish=("pub-opt", "pub-opt-flow", "pub-ok"),
                          readonly={}, guard="guard")
        flagged = sorted(n for n in ("not-mr", "or-tag", "odd-var", "sched-only", "branch-and-push")
                         if any(f"'{n}' can run on a release tag" in x for x in p))
        check("discovery: `!= merge_request_event`, `||` with the tag, and unknown variables count as "
              "tag-runnable; schedule-only and branch-only rules do not",
              flagged == ["not-mr", "odd-var", "or-tag"], p)
        check("a guard need marked `optional: true` (block or flow form) is flagged; `optional: false` is not",
              sum("optional: true" in x for x in p) == 2 and not any("'pub-ok'" in x for x in p), p)

        # The list assumptions: ALWAYS_REQUIRED really runs on every main
        # pipeline, and no un-exempted job can sit `manual` on main.
        lists = os.path.join(tmp, "lists.yml")
        with open(lists, "w", encoding="utf-8") as fh:
            fh.write(
                "guard:\n  stage: lint\n"
                ".r-anchor: &r-anchor\n  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n"
                "plain:\n  script: [x]\n"
                "main-rule:\n  rules:\n    - changes: [a/*]\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n"
                "via-anchor:\n  <<: *r-anchor\n"
                "narrowed:\n  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n      changes: [b/*]\n"
                "bad-anchor:\n  <<: *missing\n"
                "manual-main:\n  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'\n      when: manual\n"
                "manual-catchall:\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"schedule\"'\n      when: never\n"
                "    - when: manual\n"
                "manual-job-level:\n  when: manual\n"
                "manual-mr-only:\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"merge_request_event\"'\n      when: manual\n"
                "manual-web:\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"web\"'\n      when: manual\n"
                "push-only:\n  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"push\"'\n"
                "manual-exempt:\n  when: manual\n"
            )
        lkw = dict(warn={}, publish=(), readonly={}, guard="guard", exempt={"manual-exempt": ""})
        p = check_ci_file(lists, always=("plain", "main-rule", "via-anchor"), **lkw)
        check("ALWAYS_REQUIRED jobs with an unconditional main rule (direct, after a changes: rule, "
              "or through a `<<:` anchor) pass", not any("ALWAYS_REQUIRED" in x for x in p), p)
        p = check_ci_file(lists, always=("narrowed", "bad-anchor", "manual-main", "push-only"), **lkw)
        check("ALWAYS_REQUIRED job narrowed by changes:, behind an unresolvable merge, manual, or "
              "push-only (a web-triggered main pipeline, which the guard also judges, lacks it) -> flagged",
              sum("ALWAYS_REQUIRED" in x for x in p) == 4, p)
        manual = sorted(n for n in ("manual-main", "manual-catchall", "manual-job-level", "manual-mr-only",
                                    "manual-web", "manual-exempt", "plain", "bad-anchor")
                        if any(x.startswith(f"'{n}'") and ("manual" in x or "cannot read" in x) for x in p))
        check("a job that can be manual on main and is not exempt is flagged (and an unreadable one); "
              "MR-only manual and exempt jobs are not",
              manual == ["bad-anchor", "manual-catchall", "manual-job-level", "manual-main", "manual-web"], p)

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


def checked_out_sha(repo_dir: str) -> str | None:
    """The commit checked out in repo_dir, read from .git without a git binary
    (the guard's python:3.12-slim image has none). None if it cannot be read."""
    git = os.path.join(repo_dir, ".git")
    try:
        if os.path.isfile(git):  # a worktree or submodule: "gitdir: <path>"
            with open(git, encoding="utf-8") as fh:
                line = fh.read().strip()
            if not line.startswith("gitdir:"):
                return None
            git = os.path.join(repo_dir, line.split(":", 1)[1].strip())
        common = git
        if os.path.isfile(os.path.join(git, "commondir")):
            with open(os.path.join(git, "commondir"), encoding="utf-8") as fh:
                common = os.path.join(git, fh.read().strip())
        with open(os.path.join(git, "HEAD"), encoding="utf-8") as fh:
            head = fh.read().strip()
        if re.fullmatch(r"[0-9a-f]{40}", head):
            return head
        if not head.startswith("ref:"):
            return None
        ref = head.split(":", 1)[1].strip()
        for base in (git, common):
            path = os.path.join(base, ref)
            if os.path.isfile(path):
                with open(path, encoding="utf-8") as fh:
                    value = fh.read().strip()
                return value if re.fullmatch(r"[0-9a-f]{40}", value) else None
        packed = os.path.join(common, "packed-refs")
        if os.path.isfile(packed):
            with open(packed, encoding="utf-8") as fh:
                for line in fh:
                    parts = line.split()
                    if len(parts) == 2 and parts[1] == ref and re.fullmatch(r"[0-9a-f]{40}", parts[0]):
                        return parts[0]
    except OSError:
        return None
    return None


def run_guard(
    env: dict,
    argv: list[str],
    *,
    fetch: Fetch = _urllib_fetch,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    repo_dir: str | None = None,
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
            "reliably and the release cannot be shown to have passed. Create a personal access token "
            "with read_api, owned by an account with Reporter or higher on this project, as a masked, "
            "protected CI/CD variable named GITLAB_API_TOKEN. "
            "See docs/maintainers/tokens-and-rotation.md.",
            file=sys.stderr,
        )
        return 1
    # CI_COMMIT_SHA is an ordinary variable, and a pipeline variable can
    # override it (this project lets Developers set pipeline variables). The
    # checkout is not overridable that way: the runner checks out the job's own
    # commit. So the guard only vouches for the commit actually checked out, and
    # refuses to judge any other one.
    head = checked_out_sha(repo_dir or os.getcwd())
    if head is None or head.lower() != sha.lower():
        print(
            f"REFUSED: asked to check {sha}, but the commit checked out here is "
            f"{head or 'unreadable (no .git, or GIT_STRATEGY: none?)'}. The guard only vouches for the "
            "commit this pipeline is building; a SHA from a variable or an argument is not enough.",
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
