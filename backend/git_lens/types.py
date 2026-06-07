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
    narrow *which* issues are fetched. ``state``/``milestone`` are applied
    server-side where the provider supports it (so they can surface issues beyond
    the fetch budget); text search is applied client-side and never reaches here.

    ``milestone`` is a milestone title, or the synthetic ``"__none__"`` for issues
    with no milestone, or ``None`` for all.
    """

    state: str | None = None       # "open" | "closed" | None (all)
    milestone: str | None = None

    @property
    def active(self) -> bool:
        return bool(self.state or self.milestone)


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
