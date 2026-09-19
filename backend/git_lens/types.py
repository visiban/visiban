"""Provider-neutral data shapes for the issue board lens.

Every provider (GitHub, GitLab, and any future provider) maps its upstream
issue JSON onto these dataclasses. The view layer and serializers only ever
see these shapes — never provider-specific payloads — so the frontend renders
one board model regardless of source.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class LensConfig:
    """The pivot the caller asked for. ``column_dim``/``swimlane_dim`` come from
    the persisted LensConnection, optionally overridden per-request."""

    column_dim: str = "status"
    swimlane_dim: str = "milestone"


@dataclass(frozen=True)
class LensFilters:
    """Per-request issue filters. Distinct from the pivot (``LensConfig``): these
    narrow *which* issues are fetched. All of them are applied server-side where
    the provider supports it (so they can surface issues beyond the fetch budget);
    text search is applied client-side and never reaches here.

    ``milestone`` is a milestone title, or the synthetic ``"__none__"`` for issues
    with no milestone, or ``None`` for all.

    ``labels`` is an AND set (an issue must carry every listed label), already
    canonicalized by ``views._parse_filters``: stripped, deduped, sorted and capped.
    It is a ``tuple`` rather than a ``list`` because this dataclass is ``frozen``
    and a mutable default would make instances unhashable — and because the sorted
    ordering is part of the value, not a rendering detail: it is what keeps
    ``?labels=b,a`` and ``?labels=a,b`` on a single cache key.

    ``assignee`` is a single username. Deliberately singular: neither GitLab
    (``assignee_username``) nor GitHub (``assignee``) can express "assigned to any
    of N" in one call, so accepting a list here would promise a semantic the
    providers cannot deliver.
    """

    state: str | None = None       # "open" | "closed" | None (all)
    milestone: str | None = None
    labels: tuple[str, ...] = ()   # AND-ed; pre-sorted/deduped/capped
    assignee: str | None = None    # single username

    @property
    def active(self) -> bool:
        return bool(self.state or self.milestone or self.labels or self.assignee)


@dataclass
class LensLabel:
    name: str
    color: str = "888888"  # hex WITHOUT leading '#'; the frontend prepends it


@dataclass
class LensUser:
    username: str
    avatar_url: str = ""


@dataclass
class PipelineEvidence:
    """Why an issue landed in its ``pipeline`` column — surfaced on the card so the
    derived placement (Doing/Review) is never a black box. Populated by the provider
    during fetch; ``None`` when the issue has no linked branch or open MR."""

    branch: str | None = None       # the feature branch name driving "Doing", if any
    mr_number: int | None = None    # the linked open MR/PR number driving "Review", if any
    mr_url: str | None = None
    mr_closes: bool = False          # True when the MR's closing pattern targets this issue


@dataclass
class NormalizedIssue:
    number: int
    title: str
    url: str
    state: str  # "open" | "closed"
    labels: list[LensLabel] = field(default_factory=list)
    assignees: list[LensUser] = field(default_factory=list)
    milestone: str | None = None
    # Milestone metadata carried through normalization so "current milestone"
    # detection (which milestone is being worked on now) can use due date + state
    # without a second API call. A milestone's state/due is the same across all its
    # issues, so reading them off any issue is sufficient. Additive, default-None.
    milestone_due: str | None = None    # ISO date (GitLab due_date / GitHub due_on)
    milestone_state: str | None = None  # "active"/"open" vs "closed"
    # Which lane(s) this issue maps to. Plural by design: an issue matching N
    # swimlane values renders in N lanes (never hide information).
    column_keys: list[str] = field(default_factory=list)
    swimlane_keys: list[str] = field(default_factory=list)
    # Pipeline-derivation signals (populated only when the "pipeline" column_dim is
    # requested; the fetch is otherwise unchanged). Additive, default-empty fields
    # keep the provider→view contract backward compatible.
    has_branch: bool = False
    has_open_pr: bool = False
    pipeline_evidence: PipelineEvidence | None = None


@dataclass
class LensAxis:
    key: str
    label: str
    # Only ever set for the milestone swimlane axis: marks the milestone currently
    # being worked on (so the frontend sorts it first + badges it). Always False on
    # columns and on non-milestone swimlanes. Additive, default-False.
    is_current: bool = False


@dataclass
class LensData:
    columns: list[LensAxis]
    swimlanes: list[LensAxis]
    issues: list[NormalizedIssue]
    fetched_at: str  # ISO 8601
    source_provider: str
    source_repo: str
    source_url: str
    truncated: bool = False
    total_count: int | None = None
    # All milestone titles in the repo (not just those on the fetched issues), so
    # the milestone filter can offer a milestone whose issues fall outside the
    # fetch budget — the whole point of server-side milestone filtering.
    available_milestones: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "columns": [asdict(c) for c in self.columns],
            "swimlanes": [asdict(s) for s in self.swimlanes],
            "issues": [asdict(i) for i in self.issues],
            "fetched_at": self.fetched_at,
            "source": {
                "provider": self.source_provider,
                "repo": self.source_repo,
                "url": self.source_url,
            },
            "truncated": self.truncated,
            "total_count": self.total_count,
            "available_milestones": self.available_milestones,
        }
