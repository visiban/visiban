"""Issue-lens provider backends and the read-only fetch/normalize pipeline.

A provider is a pure callable ``(token, repo, config) -> LensData``. It fetches
a single public repository's issues using the caller's own credentials (GitHub:
the user's OAuth token; GitLab: anonymous for public projects) and normalizes
them onto the provider-neutral shapes in ``git_lens.types``.

Strict boundary (keeps this an OSS read-lens, never a TruePPM-style sync hub):
no webhooks, no background/scheduled fetch, no write-back, no cross-repo
aggregation, no issue-history analytics. Each call is a point-in-time projection
of one source, triggered by a user request.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import quote

import requests
from django.utils import timezone

from .types import (
    LensAxis,
    LensConfig,
    LensData,
    LensLabel,
    LensUser,
    NormalizedIssue,
    PipelineEvidence,
)

# --- tuning ---------------------------------------------------------------
PER_PAGE = 100
MAX_PAGES = 3  # hard cap → at most 300 issues per board in v1
MAX_ISSUES = PER_PAGE * MAX_PAGES
# Branches + open MRs are only fetched for the "pipeline" column dim, and are
# capped harder than issues: the linking only needs recent/active branches and
# the open-MR set, so a low cap keeps the extra outbound calls bounded.
MAX_AUX_PAGES = 2  # ≤ 200 branches and ≤ 200 open MRs considered for pipeline linking
REQUEST_TIMEOUT = 10  # seconds
GITLAB_BASE = "https://gitlab.com"  # v1: gitlab.com only (self-managed is a later tier)

_STATUS_PREFIXES = ("status::", "status:")
_NO_STATUS = "__nostatus__"
_NONE = "__none__"

# Pipeline column dimension — a fixed, opinionated software workflow derived from
# repo state (issue + branch + MR). Keys are internal enum values; labels are
# resolved below, never read from a board's editable column names (which would
# break on renames / non-English instances).
_PIPELINE_KEYS = ["backlog", "todo", "doing", "review", "done"]
_PIPELINE_LABELS = {
    "backlog": "Backlog",
    "todo": "To Do",
    "doing": "Doing",
    "review": "Review",
    "done": "Done",
}

# The issue number a branch (or an MR's source branch) is for, tolerant of the
# common prefixed conventions: "746-title", "feat/746-title", "fix/746-x" all → 746.
# The number must be a whole token (bounded by start / slash / dash / underscore) so
# "release/1.2.0" or "v2-foo" don't spuriously match.
_BRANCH_ISSUE_RE = re.compile(r"(?:^|[/_-])(\d{1,7})(?=[-_/]|$)")
# Default closing keywords (GitLab & GitHub both honor these in MR/PR descriptions).
_CLOSES_RE = re.compile(
    r"\b(?:clos(?:e|es|ed|ing)|fix(?:es|ed|ing)?|resolv(?:e|es|ed|ing))\b[:\s]+#(\d+)",
    re.IGNORECASE,
)
_MENTION_RE = re.compile(r"#(\d+)")


# --- errors ---------------------------------------------------------------
class LensError(Exception):
    """Base for any upstream/provider failure surfaced to the client."""


class LensAuthError(LensError):
    """The caller needs to (re)connect their provider account, or the token expired."""


class LensNotFound(LensError):
    """Repo/project not found or not public."""


class LensRateLimited(LensError):
    """The provider is throttling requests."""

    def __init__(self, message: str = "", retry_after: str | None = None):
        super().__init__(message)
        self.retry_after = retry_after


# --- registry (internal; public hook deferred to keep-decision) -----------
_REGISTRY: dict[str, Callable[[str | None, str, LensConfig], LensData]] = {}


def register(provider_id: str):
    def _deco(fn):
        _REGISTRY[provider_id] = fn
        return fn

    return _deco


def get_provider(provider_id: str):
    return _REGISTRY.get(provider_id)


def available_providers() -> list[str]:
    return sorted(_REGISTRY)


# --- pivot (shared by all providers) --------------------------------------
def _status_from_labels(labels: list[LensLabel]) -> str | None:
    for lbl in labels:
        low = lbl.name.lower()
        for pref in _STATUS_PREFIXES:
            if low.startswith(pref):
                value = lbl.name[len(pref):].strip()
                if value:
                    return value
    return None


def _pipeline_key(issue: NormalizedIssue) -> str:
    """Approved precedence ladder (first match wins). ``closed`` always wins, so a
    stale branch on a closed issue still reads as Done. An open MR (whether it
    closes or only references the issue) outranks a bare branch."""
    if issue.state == "closed":
        return "done"
    if issue.has_open_pr:
        return "review"
    if issue.has_branch:
        return "doing"
    if issue.milestone:
        return "todo"
    return "backlog"


def _issue_num_from_branch(name: str) -> int | None:
    m = _BRANCH_ISSUE_RE.search(name or "")
    return int(m.group(1)) if m else None


@dataclass
class _PR:
    """Provider-neutral view of one open merge/pull request, for issue linking."""

    number: int
    url: str
    source_branch: str
    title: str
    body: str


def _link_pipeline(issues: list[NormalizedIssue], branch_names: list[str], prs: list[_PR]):
    """Populate has_branch / has_open_pr / pipeline_evidence on each issue from the
    repo's branches and open MRs. Pure function over already-fetched data — the
    provider-specific API shapes are normalized to ``branch_names`` and ``_PR``
    before this runs, so the linking rules live in one place for every provider."""
    branch_by_num: dict[int, str] = {}
    for name in branch_names:
        n = _issue_num_from_branch(name)
        if n is not None:
            branch_by_num.setdefault(n, name)

    # An MR that *closes* an issue outranks one that merely references it.
    closing_mr: dict[int, _PR] = {}
    ref_mr: dict[int, _PR] = {}
    for pr in prs:
        text = f"{pr.title}\n{pr.body}"
        closes = {int(m.group(1)) for m in _CLOSES_RE.finditer(text)}
        mentions = {int(m.group(1)) for m in _MENTION_RE.finditer(text)}
        bn = _issue_num_from_branch(pr.source_branch)
        if bn is not None:
            mentions.add(bn)  # the issue the MR's source branch is built on
        for n in closes:
            closing_mr.setdefault(n, pr)
        for n in mentions - closes:
            ref_mr.setdefault(n, pr)

    for issue in issues:
        num = issue.number
        branch = branch_by_num.get(num)
        closing = closing_mr.get(num)
        mr = closing or ref_mr.get(num)
        issue.has_branch = branch is not None
        issue.has_open_pr = mr is not None
        if branch is not None or mr is not None:
            issue.pipeline_evidence = PipelineEvidence(
                branch=branch,
                mr_number=mr.number if mr else None,
                mr_url=mr.url if mr else None,
                mr_closes=closing is not None,
            )


def _paginate(url, headers, base_params, raise_for, cap=MAX_AUX_PAGES) -> list[dict]:
    """Fetch a paginated list endpoint up to ``cap`` pages, raising on upstream
    errors via the provider's ``raise_for``. Shared by the branch/MR aux fetches."""
    items: list[dict] = []
    for page in range(1, cap + 1):
        resp = requests.get(
            url,
            headers=headers,
            params={**base_params, "per_page": PER_PAGE, "page": page},
            timeout=REQUEST_TIMEOUT,
        )
        raise_for(resp)
        batch = resp.json()
        if not batch:
            break
        items.extend(batch)
        if len(batch) < PER_PAGE:
            break
    return items


def apply_pivot(issues: list[NormalizedIssue], config: LensConfig):
    """Compute the column and swimlane axes from the issues and assign each
    issue its ``column_keys``/``swimlane_keys``. Mutates the issues in place and
    returns ``(columns, swimlanes, issues)``."""
    column_dim = config.column_dim
    swimlane_dim = config.swimlane_dim

    # Fallback: if "status" columns were requested but no issue carries a status
    # label, degrade to open/closed columns so the board isn't a single column.
    if column_dim == "status" and not any(_status_from_labels(i.labels) for i in issues):
        column_dim = "state"

    def col_keys(issue: NormalizedIssue) -> list[str]:
        if column_dim == "pipeline":
            return [_pipeline_key(issue)]
        if column_dim == "state":
            return [issue.state]
        status = _status_from_labels(issue.labels)
        return [status] if status else [_NO_STATUS]

    def swim_keys(issue: NormalizedIssue) -> list[str]:
        if swimlane_dim == "assignee":
            return [a.username for a in issue.assignees] or [_NONE]
        if swimlane_dim == "label":
            return [lbl.name for lbl in issue.labels] or [_NONE]
        return [issue.milestone] if issue.milestone else [_NONE]  # milestone (default)

    col_seen: list[str] = []
    swim_seen: list[str] = []
    for issue in issues:
        issue.column_keys = col_keys(issue)
        issue.swimlane_keys = swim_keys(issue)
        for c in issue.column_keys:
            if c not in col_seen:
                col_seen.append(c)
        for s in issue.swimlane_keys:
            if s not in swim_seen:
                swim_seen.append(s)

    def col_label(key: str) -> str:
        return {
            **_PIPELINE_LABELS,
            "__nostatus__": "No status",
            "open": "Open",
            "closed": "Closed",
        }.get(key, key)

    none_label = {
        "milestone": "(no milestone)",
        "assignee": "(unassigned)",
        "label": "(no label)",
    }.get(swimlane_dim, "(none)")

    # Column ordering: fixed for state; the full fixed workflow for pipeline (every
    # column always shown, even when empty, so "Doing"/"Review" don't vanish);
    # alphabetical for status with the synthetic "No status" bucket pinned last.
    if column_dim == "state":
        ordered_cols = [c for c in ("open", "closed") if c in col_seen]
    elif column_dim == "pipeline":
        ordered_cols = list(_PIPELINE_KEYS)
    else:
        ordered_cols = sorted(c for c in col_seen if c != _NO_STATUS)
        if _NO_STATUS in col_seen:
            ordered_cols.append(_NO_STATUS)

    ordered_swims = sorted(s for s in swim_seen if s != _NONE)
    if _NONE in swim_seen:
        ordered_swims.append(_NONE)

    columns = [LensAxis(key=k, label=col_label(k)) for k in ordered_cols]
    swimlanes = [
        LensAxis(key=k, label=none_label if k == _NONE else k) for k in ordered_swims
    ]
    return columns, swimlanes, issues


def _finalize(issues, truncated, provider, repo, source_url, config) -> LensData:
    columns, swimlanes, issues = apply_pivot(issues, config)
    return LensData(
        columns=columns,
        swimlanes=swimlanes,
        issues=issues,
        fetched_at=timezone.now().isoformat(),
        source_provider=provider,
        source_repo=repo,
        source_url=source_url,
        truncated=truncated,
        # When truncated we don't know the true total without extra calls, so omit it.
        total_count=None if truncated else len(issues),
    )


# --- GitHub ---------------------------------------------------------------
def _raise_for_github(resp: requests.Response) -> None:
    if resp.status_code == 200:
        return
    if resp.status_code == 404:
        raise LensNotFound("Repository not found or not public.")
    if resp.status_code in (401, 403):
        if resp.headers.get("X-RateLimit-Remaining") == "0":
            raise LensRateLimited(retry_after=resp.headers.get("X-RateLimit-Reset"))
        if resp.status_code == 401:
            raise LensAuthError("GitHub authentication failed.")
        raise LensRateLimited()  # 403 without remaining header → abuse/secondary limit
    raise LensError(f"GitHub API error ({resp.status_code}).")


def _github_issue(raw: dict) -> NormalizedIssue:
    milestone = raw.get("milestone")
    return NormalizedIssue(
        number=raw["number"],
        title=raw.get("title") or "",
        url=raw.get("html_url", ""),
        state=raw.get("state", "open"),
        labels=[
            LensLabel(name=lbl["name"], color=(lbl.get("color") or "888888"))
            for lbl in raw.get("labels", [])
            if isinstance(lbl, dict)
        ],
        assignees=[
            LensUser(username=a.get("login", ""), avatar_url=a.get("avatar_url", ""))
            for a in raw.get("assignees", [])
        ],
        milestone=milestone.get("title") if milestone else None,
    )


@register("github")
def github_fetch(token: str | None, repo: str, config: LensConfig) -> LensData:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    # Encode each path segment so a crafted repo_slug cannot alter the API path
    # (defense in depth alongside the serializer's strict validation).
    repo_path = "/".join(quote(seg, safe="") for seg in repo.split("/"))

    issues: list[NormalizedIssue] = []
    truncated = False
    for page in range(1, MAX_PAGES + 1):
        resp = requests.get(
            f"https://api.github.com/repos/{repo_path}/issues",
            headers=headers,
            params={"state": "all", "per_page": PER_PAGE, "page": page},
            timeout=REQUEST_TIMEOUT,
        )
        _raise_for_github(resp)
        batch = resp.json()
        if not batch:
            break
        for raw in batch:
            # The GitHub issues endpoint also returns pull requests; skip them.
            if "pull_request" in raw:
                continue
            issues.append(_github_issue(raw))
        if len(batch) < PER_PAGE:
            break
    else:
        truncated = True  # hit the page cap with full pages → more may exist

    if config.column_dim == "pipeline":
        _enrich_github_pipeline(issues, repo_path, headers)

    return _finalize(issues, truncated, "github", repo, f"https://github.com/{repo}", config)


def _enrich_github_pipeline(issues, repo_path, headers) -> None:
    """Fetch the repo's branches and open PRs and link them to issues so the
    pipeline columns can place Doing (has branch) / Review (open PR)."""
    branches = _paginate(
        f"https://api.github.com/repos/{repo_path}/branches", headers, {}, _raise_for_github
    )
    pulls = _paginate(
        f"https://api.github.com/repos/{repo_path}/pulls",
        headers,
        {"state": "open"},
        _raise_for_github,
    )
    prs = [
        _PR(
            number=p.get("number"),
            url=p.get("html_url", ""),
            source_branch=(p.get("head") or {}).get("ref", "") or "",
            title=p.get("title") or "",
            body=p.get("body") or "",
        )
        for p in pulls
    ]
    _link_pipeline(issues, [b.get("name", "") for b in branches], prs)


# --- GitLab ---------------------------------------------------------------
def _raise_for_gitlab(resp: requests.Response) -> None:
    if resp.status_code == 200:
        return
    if resp.status_code == 404:
        raise LensNotFound("Project not found or not public.")
    if resp.status_code == 429:
        raise LensRateLimited(retry_after=resp.headers.get("Retry-After"))
    if resp.status_code in (401, 403):
        raise LensAuthError("GitLab authentication failed.")
    raise LensError(f"GitLab API error ({resp.status_code}).")


def _gitlab_issue(raw: dict) -> NormalizedIssue:
    state = "open" if raw.get("state") == "opened" else "closed"
    labels: list[LensLabel] = []
    for lbl in raw.get("labels", []):
        if isinstance(lbl, dict):  # with_labels_details=true → dicts with colors
            labels.append(LensLabel(name=lbl["name"], color=(lbl.get("color") or "#888888").lstrip("#")))
        else:  # plain string fallback
            labels.append(LensLabel(name=lbl))
    milestone = raw.get("milestone")
    return NormalizedIssue(
        number=raw.get("iid") or raw.get("id"),
        title=raw.get("title") or "",
        url=raw.get("web_url", ""),
        state=state,
        labels=labels,
        assignees=[
            LensUser(username=a.get("username", ""), avatar_url=a.get("avatar_url", ""))
            for a in raw.get("assignees", [])
        ],
        milestone=milestone.get("title") if milestone else None,
    )


@register("gitlab")
def gitlab_fetch(token: str | None, repo: str, config: LensConfig) -> LensData:
    # Public GitLab projects are readable anonymously, which sidesteps the
    # read_api-scope gap on Visiban's existing login-only OAuth tokens. We send
    # the token only if one was supplied (raises the rate limit when present).
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    project = quote(repo, safe="")

    issues: list[NormalizedIssue] = []
    truncated = False
    for page in range(1, MAX_PAGES + 1):
        resp = requests.get(
            f"{GITLAB_BASE}/api/v4/projects/{project}/issues",
            headers=headers,
            params={
                "per_page": PER_PAGE,
                "page": page,
                "scope": "all",
                "with_labels_details": "true",
            },
            timeout=REQUEST_TIMEOUT,
        )
        _raise_for_gitlab(resp)
        batch = resp.json()
        if not batch:
            break
        issues.extend(_gitlab_issue(raw) for raw in batch)
        if len(batch) < PER_PAGE:
            break
    else:
        truncated = True

    if config.column_dim == "pipeline":
        _enrich_gitlab_pipeline(issues, f"{GITLAB_BASE}/api/v4/projects/{project}", headers)

    return _finalize(issues, truncated, "gitlab", repo, f"{GITLAB_BASE}/{repo}", config)


def _enrich_gitlab_pipeline(issues, project_base, headers) -> None:
    """Fetch the project's branches and open MRs and link them to issues so the
    pipeline columns can place Doing (has branch) / Review (open MR)."""
    branches = _paginate(
        f"{project_base}/repository/branches", headers, {}, _raise_for_gitlab
    )
    mrs = _paginate(
        f"{project_base}/merge_requests", headers, {"state": "opened"}, _raise_for_gitlab
    )
    prs = [
        _PR(
            number=m.get("iid"),
            url=m.get("web_url", ""),
            source_branch=m.get("source_branch", "") or "",
            title=m.get("title") or "",
            body=m.get("description") or "",
        )
        for m in mrs
    ]
    _link_pipeline(issues, [b.get("name", "") for b in branches], prs)
