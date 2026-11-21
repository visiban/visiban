"""Shared helpers for the red-main guard (#2460): main-red-tripwire.py + main-red-guard.py.

Why: nothing stopped merges while `main` was red (7 consecutive red main
pipelines in the 2026-11-21 audit, all with green MR pipelines). GitLab Free has
no merge trains, so the guard is built from jobs: the tripwire records red main
in one tracking issue, the guard fails MR pipelines while the latest finished
main push pipeline is red. See docs/maintainers/known-ci-failures.md.

The verdict is `unknown` on any lookup problem; callers fail OPEN on unknown
(same convention as scripts/check-suppression-issues.sh).
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

ISSUE_TITLE = "main is red"
ISSUE_LABEL = "ci"
ESCAPE_LABEL = "main-fix"
FINISHED = ("success", "failed")  # canceled/skipped/running say nothing about main
PER_PAGE = 100


class ApiError(Exception):
    pass


# fetch(method, url, headers, body_or_None) -> bytes
Fetch = Callable[[str, str, dict, "bytes | None"], bytes]


def urllib_fetch(method: str, url: str, headers: dict, body: "bytes | None") -> bytes:
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:  # noqa: S310 - API URL from CI env
            return resp.read()
    except urllib.error.HTTPError as exc:
        raise ApiError(f"HTTP {exc.code} from {method} {url}") from None
    except (urllib.error.URLError, OSError) as exc:
        raise ApiError(f"{method} {url} failed: {type(exc).__name__}") from None


class Client:
    def __init__(self, api_url: str, project_id: str, token: "str | None" = None, fetch: Fetch = urllib_fetch):
        self.base = f"{api_url.rstrip('/')}/projects/{urllib.parse.quote(str(project_id), safe='')}"
        self.token = token or None
        self.fetch = fetch

    def call(self, method: str, path: str, params: "dict | None" = None, form: "dict | None" = None):
        url = f"{self.base}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        headers = {"Accept": "application/json", "User-Agent": "visiban-main-red-guard"}
        if self.token:
            headers["PRIVATE-TOKEN"] = self.token
        body = None
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        raw = self.fetch(method, url, headers, body)
        try:
            return json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise ApiError(f"non-JSON response from {method} {url}") from None

    def get(self, path: str, params: "dict | None" = None):
        return self.call("GET", path, params)

    def jobs(self, pipeline_id: int) -> list:
        out: list = []
        for page in range(1, 11):  # a main pipeline has >100 jobs; never judge a partial list
            data = self.get(
                f"/pipelines/{int(pipeline_id)}/jobs",
                {"per_page": PER_PAGE, "page": page, "include_retried": "false"},
            )
            if not isinstance(data, list) or not all(isinstance(j, dict) and "name" in j for j in data):
                raise ApiError("jobs response is not a list of job objects")
            out.extend(data)
            if len(data) < PER_PAGE:
                return out
        raise ApiError("more than 1000 jobs; refusing to judge a partial list")

    def tracking_issue(self) -> "dict | None":
        """The open `main is red` issue, if any (exact title match)."""
        data = self.get(
            "/issues",
            {"state": "opened", "labels": ISSUE_LABEL, "search": ISSUE_TITLE, "in": "title", "per_page": 20},
        )
        if not isinstance(data, list):
            raise ApiError("issues response is not a list")
        for issue in data:
            if isinstance(issue, dict) and issue.get("title") == ISSUE_TITLE:
                return issue
        return None


def blocking_failures(jobs: list) -> list:
    """Names of failed jobs that are not allow_failure (those turn a pipeline red)."""
    return sorted({j["name"] for j in jobs if j.get("status") == "failed" and not j.get("allow_failure")})


def latest_finished_main(client: Client) -> "dict | None":
    """Newest finished (success/failed) push pipeline on main, or None."""
    data = client.get(
        "/pipelines", {"ref": "main", "source": "push", "order_by": "id", "sort": "desc", "per_page": 20}
    )
    if not isinstance(data, list) or not all(isinstance(p, dict) and "id" in p for p in data):
        raise ApiError("pipelines response is not a list of pipeline objects")
    for pipe in sorted(data, key=lambda p: p["id"], reverse=True):
        if pipe.get("status") in FINISHED:
            return pipe
    return None


def fake_page(items: list, url: str) -> list:
    """Self-test helper: slice `items` the way the API pages a list (page/per_page
    query params, defaults 1/20), so the fakes exercise Client.jobs' paging."""
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    page, per_page = int(q.get("page", ["1"])[0]), int(q.get("per_page", ["20"])[0])
    return items[(page - 1) * per_page : page * per_page]
