"""Pure unit tests for the lens normalization/pivot and provider fetch logic.

These require neither the database nor the git_lens app to be installed (the
providers/types modules import no Django models), so they run in the main test
suite regardless of the GIT_LENS_ENABLED flag. Upstream HTTP is mocked.
"""
from unittest.mock import MagicMock, patch

from django.core.cache import cache
from django.test import SimpleTestCase

from git_lens import providers
from git_lens.types import LensConfig, LensFilters, LensLabel, LensUser, NormalizedIssue


def _issue(number=1, state="open", labels=None, milestone=None, assignees=None,
           milestone_due=None, milestone_state=None):
    return NormalizedIssue(
        number=number,
        title=f"#{number}",
        url=f"https://example/{number}",
        state=state,
        labels=[LensLabel(name=n) for n in (labels or [])],
        assignees=[LensUser(username=u) for u in (assignees or [])],
        milestone=milestone,
        milestone_due=milestone_due,
        milestone_state=milestone_state,
    )


def _resp(json_data, status=200, headers=None):
    m = MagicMock()
    m.status_code = status
    m.json.return_value = json_data
    m.headers = headers or {}
    return m


class LensFiltersActiveTests(SimpleTestCase):
    """`.active` gates the shorter filtered-cache TTL and the provenance banner's
    "filtered" badge. Every dimension must independently trip it — the existing
    view-level tests only exercise combinations (e.g. labels+assignee together),
    which would pass even if one dimension alone were wired wrong."""

    def test_inactive_when_all_fields_are_default(self):
        self.assertFalse(LensFilters().active)

    def test_active_for_state_alone(self):
        self.assertTrue(LensFilters(state="open").active)

    def test_active_for_milestone_alone(self):
        self.assertTrue(LensFilters(milestone="1.2").active)

    def test_active_for_labels_alone(self):
        self.assertTrue(LensFilters(labels=("bug",)).active)

    def test_active_for_assignee_alone(self):
        self.assertTrue(LensFilters(assignee="alice").active)


class PivotTests(SimpleTestCase):
    def test_status_columns_from_scoped_labels(self):
        issues = [
            _issue(1, labels=["status::To Do", "bug"]),
            _issue(2, labels=["status::Done"]),
        ]
        cols, _swim, issues = providers.apply_pivot(issues, LensConfig("status", "milestone"))
        labels = [c.label for c in cols]
        self.assertIn("To Do", labels)
        self.assertIn("Done", labels)
        self.assertEqual(issues[0].column_keys, ["To Do"])

    def test_status_falls_back_to_state_when_no_status_labels(self):
        issues = [_issue(1, state="open", labels=["bug"]), _issue(2, state="closed")]
        cols, _swim, _ = providers.apply_pivot(issues, LensConfig("status", "milestone"))
        self.assertEqual([c.key for c in cols], ["open", "closed"])
        self.assertEqual([c.label for c in cols], ["Open", "Closed"])

    def test_no_status_bucket_pinned_last(self):
        issues = [_issue(1, labels=["status::Doing"]), _issue(2, labels=["bug"])]
        cols, _swim, _ = providers.apply_pivot(issues, LensConfig("status", "milestone"))
        self.assertEqual(cols[-1].key, "__nostatus__")
        self.assertEqual(cols[-1].label, "No status")

    def test_milestone_swimlanes_with_none_lane_last(self):
        issues = [_issue(1, milestone="v1.2"), _issue(2, milestone=None)]
        _cols, swim, _ = providers.apply_pivot(issues, LensConfig("state", "milestone"))
        self.assertEqual(swim[0].label, "v1.2")
        self.assertEqual(swim[-1].key, "__none__")
        self.assertEqual(swim[-1].label, "(no milestone)")

    def test_label_swimlane_duplicates_issue_into_each_lane(self):
        issues = [_issue(1, labels=["frontend", "backend"])]
        _cols, swim, issues = providers.apply_pivot(issues, LensConfig("state", "label"))
        self.assertCountEqual(issues[0].swimlane_keys, ["frontend", "backend"])
        self.assertCountEqual([s.key for s in swim], ["frontend", "backend"])

    def test_assignee_swimlane_unassigned_lane(self):
        issues = [_issue(1, assignees=["alice"]), _issue(2, assignees=[])]
        _cols, swim, _ = providers.apply_pivot(issues, LensConfig("state", "assignee"))
        self.assertEqual(swim[-1].label, "(unassigned)")


class MalformedMilestoneMetadataTests(SimpleTestCase):
    """#1085: a provider that sends a non-string milestone_due/milestone_state
    must not crash normalization. ``_current_milestone`` slices milestone_due
    and lower()s milestone_state, so an int/dict/None must all coerce cleanly
    to ``None`` at the ``_github_issue``/``_gitlab_issue`` boundary rather than
    propagating a value that blows up downstream."""

    def test_github_int_milestone_due_and_state_coerced_to_none(self):
        issue = providers._github_issue({
            "number": 1, "title": "t", "html_url": "u", "state": "open",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_on": 20991231, "state": 7},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)
        self.assertEqual(issue.milestone, "v1")

    def test_github_dict_milestone_due_and_state_coerced_to_none(self):
        issue = providers._github_issue({
            "number": 1, "title": "t", "html_url": "u", "state": "open",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_on": {"iso": "2099-12-31"}, "state": {"x": 1}},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)

    def test_github_null_milestone_due_and_state_stay_none(self):
        issue = providers._github_issue({
            "number": 1, "title": "t", "html_url": "u", "state": "open",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_on": None, "state": None},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)

    def test_gitlab_int_milestone_due_and_state_coerced_to_none(self):
        issue = providers._gitlab_issue({
            "iid": 1, "title": "t", "web_url": "u", "state": "opened",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_date": 20991231, "state": 7},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)

    def test_gitlab_dict_milestone_due_and_state_coerced_to_none(self):
        issue = providers._gitlab_issue({
            "iid": 1, "title": "t", "web_url": "u", "state": "opened",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_date": {"iso": "2099-12-31"}, "state": {"x": 1}},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)

    def test_gitlab_null_milestone_due_and_state_stay_none(self):
        issue = providers._gitlab_issue({
            "iid": 1, "title": "t", "web_url": "u", "state": "opened",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_date": None, "state": None},
        })
        self.assertIsNone(issue.milestone_due)
        self.assertIsNone(issue.milestone_state)

    def test_current_milestone_does_not_crash_on_previously_malformed_input(self):
        # End-to-end guard: feeding apply_pivot issues whose milestone metadata
        # came from a malformed provider payload (now coerced to None) must not
        # raise, and such a milestone is simply never marked current (no due date,
        # no pipeline work counted for it in this non-pipeline dim).
        issues = [providers._github_issue({
            "number": 1, "title": "t", "html_url": "u", "state": "open",
            "labels": [], "assignees": [],
            "milestone": {"title": "v1", "due_on": 123, "state": {}},
        })]
        cols, swim, _ = providers.apply_pivot(issues, LensConfig("state", "milestone"))
        self.assertFalse(any(s.is_current for s in swim))


class GitHubFetchTests(SimpleTestCase):
    @patch("git_lens.providers.requests.get")
    def test_filters_pull_requests(self, mock_get):
        mock_get.return_value = _resp([
            {"number": 1, "title": "real issue", "html_url": "u", "state": "open", "labels": [], "assignees": []},
            {"number": 2, "title": "a PR", "html_url": "u", "state": "open", "labels": [], "assignees": [], "pull_request": {"url": "x"}},
        ])
        data = providers.github_fetch("tok", "o/r", LensConfig("state", "milestone"), LensFilters())
        self.assertEqual([i.number for i in data.issues], [1])

    @patch("git_lens.providers.requests.get")
    def test_pagination_and_truncation(self, mock_get):
        full = [{"number": n, "title": "t", "html_url": "u", "state": "open", "labels": [], "assignees": []}
                for n in range(providers.PER_PAGE)]
        mock_get.return_value = _resp(full)  # every page full → hits page cap
        data = providers.github_fetch("tok", "o/r", LensConfig("state", "milestone"), LensFilters())
        self.assertTrue(data.truncated)
        self.assertIsNone(data.total_count)
        self.assertEqual(mock_get.call_count, providers.MAX_PAGES)

    @patch("git_lens.providers.requests.get")
    def test_404_raises_not_found(self, mock_get):
        mock_get.return_value = _resp({}, status=404)
        with self.assertRaises(providers.LensNotFound):
            providers.github_fetch("tok", "o/r", LensConfig(), LensFilters())

    @patch("git_lens.providers.requests.get")
    def test_rate_limit_detected(self, mock_get):
        mock_get.return_value = _resp({}, status=403, headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "999"})
        with self.assertRaises(providers.LensRateLimited):
            providers.github_fetch("tok", "o/r", LensConfig(), LensFilters())

    @patch("git_lens.providers.requests.get")
    def test_label_color_default_when_missing(self, mock_get):
        mock_get.return_value = _resp([
            {"number": 1, "title": "t", "html_url": "u", "state": "open",
             "labels": [{"name": "bug", "color": None}], "assignees": []},
        ])
        data = providers.github_fetch("tok", "o/r", LensConfig(), LensFilters())
        self.assertEqual(data.issues[0].labels[0].color, "888888")


class GitLabFetchTests(SimpleTestCase):
    @patch("git_lens.providers.requests.get")
    def test_state_normalized_and_anonymous(self, mock_get):
        mock_get.return_value = _resp([
            {"iid": 7, "title": "t", "web_url": "u", "state": "opened",
             "labels": [{"name": "bug", "color": "#ff0000"}], "assignees": [], "milestone": {"title": "v2"}},
        ])
        data = providers.gitlab_fetch(None, "g/p", LensConfig("status", "milestone"), LensFilters())
        self.assertEqual(data.issues[0].state, "open")
        self.assertEqual(data.issues[0].number, 7)
        self.assertEqual(data.issues[0].labels[0].color, "ff0000")  # leading '#' stripped
        self.assertEqual(data.issues[0].milestone, "v2")
        # Anonymous: no Authorization header sent for public reads.
        _args, kwargs = mock_get.call_args
        self.assertNotIn("Authorization", kwargs.get("headers", {}))

    @patch("git_lens.providers.requests.get")
    def test_404_raises_not_found(self, mock_get):
        mock_get.return_value = _resp({}, status=404)
        with self.assertRaises(providers.LensNotFound):
            providers.gitlab_fetch(None, "g/p", LensConfig(), LensFilters())


class RegistryTests(SimpleTestCase):
    def test_builtin_providers_registered(self):
        self.assertEqual(providers.available_providers(), ["github", "gitlab"])
        self.assertIsNotNone(providers.get_provider("github"))
        self.assertIsNone(providers.get_provider("bitbucket"))


def _pipe_issue(number, state="open", milestone=None, has_branch=False, has_open_pr=False,
                milestone_due=None, milestone_state=None):
    i = _issue(number, state=state, milestone=milestone,
               milestone_due=milestone_due, milestone_state=milestone_state)
    i.has_branch = has_branch
    i.has_open_pr = has_open_pr
    return i


class CurrentMilestoneTests(SimpleTestCase):
    """`is_current` marks the milestone being worked on. Precedence: due-date
    (column_dim-independent) primary, Doing/Review work as the no-dates fallback
    (pipeline only), nothing otherwise. Only the milestone swimlane is ever marked."""

    def _current(self, issues, column_dim="pipeline"):
        _c, swim, _i = providers.apply_pivot(issues, LensConfig(column_dim, "milestone"))
        cur = [s.key for s in swim if s.is_current]
        return cur[0] if cur else None

    def test_due_date_nearest_upcoming_wins(self):
        issues = [
            _issue(1, milestone="v1.1", milestone_due="2099-12-31"),
            _issue(2, milestone="v1.0", milestone_due="2099-01-01"),
        ]
        self.assertEqual(self._current(issues), "v1.0")

    def test_all_past_due_picks_most_recent(self):
        # An overdue active milestone is still the current one.
        issues = [
            _issue(1, milestone="v0.8", milestone_due="1999-01-01"),
            _issue(2, milestone="v0.9", milestone_due="2000-01-01"),
        ]
        self.assertEqual(self._current(issues), "v0.9")

    def test_no_dates_pipeline_uses_in_progress_work(self):
        issues = [
            _pipe_issue(1, milestone="v1.0", has_branch=True),  # doing
            _pipe_issue(2, milestone="v1.1"),                   # todo (no branch/MR)
        ]
        self.assertEqual(self._current(issues, "pipeline"), "v1.0")

    def test_no_dates_non_pipeline_marks_nothing(self):
        # Doing/Review counts don't exist outside pipeline columns → no guess.
        issues = [
            _pipe_issue(1, milestone="v1.0", has_branch=True),
            _pipe_issue(2, milestone="v1.1"),
        ]
        self.assertIsNone(self._current(issues, "state"))

    def test_no_in_progress_work_and_no_dates_marks_nothing(self):
        issues = [_pipe_issue(1, milestone="v1.0"), _pipe_issue(2, milestone="v1.1")]
        self.assertIsNone(self._current(issues, "pipeline"))

    def test_tie_breaks_on_title(self):
        issues = [
            _issue(1, milestone="v1.1", milestone_due="2099-06-01"),
            _issue(2, milestone="v1.0", milestone_due="2099-06-01"),
        ]
        self.assertEqual(self._current(issues), "v1.0")

    def test_closed_state_milestone_excluded(self):
        # Closed milestone is excluded even with the nearer due date.
        issues = [
            _issue(1, milestone="done-ms", milestone_due="2099-01-01", milestone_state="closed"),
            _issue(2, milestone="active-ms", milestone_due="2099-12-31", milestone_state="active"),
        ]
        self.assertEqual(self._current(issues), "active-ms")

    def test_milestone_with_only_closed_issues_is_not_current(self):
        issues = [_issue(1, state="closed", milestone="v1.0", milestone_due="2099-01-01")]
        self.assertIsNone(self._current(issues))

    def test_none_lane_never_current(self):
        self.assertIsNone(self._current([_issue(1, milestone=None), _issue(2, milestone=None)]))

    def test_only_milestone_swimlane_gets_marked(self):
        issues = [_pipe_issue(1, milestone="v1.0", has_branch=True)]
        _c, swim, _i = providers.apply_pivot(issues, LensConfig("pipeline", "assignee"))
        self.assertFalse(any(s.is_current for s in swim))


class PipelinePivotTests(SimpleTestCase):
    """The pipeline column dim derives a fixed Backlog→Done workflow from repo
    state, via the approved precedence ladder (first match wins)."""

    def _key(self, **kw):
        issues = [_pipe_issue(1, **kw)]
        providers.apply_pivot(issues, LensConfig("pipeline", "milestone"))
        return issues[0].column_keys[0]

    def test_ladder_rungs(self):
        self.assertEqual(self._key(state="closed"), "done")
        self.assertEqual(self._key(state="open", has_open_pr=True), "review")
        self.assertEqual(self._key(state="open", has_branch=True), "doing")
        self.assertEqual(self._key(state="open", milestone="v1"), "todo")
        self.assertEqual(self._key(state="open"), "backlog")

    def test_closed_always_wins(self):
        # A stale branch / lingering MR on a closed issue still reads as Done.
        self.assertEqual(
            self._key(state="closed", has_branch=True, has_open_pr=True), "done"
        )

    def test_review_outranks_doing(self):
        self.assertEqual(self._key(state="open", has_branch=True, has_open_pr=True), "review")

    def test_all_five_columns_always_present_in_order(self):
        # Even with only a single backlog issue, every workflow column renders so
        # Doing/Review never silently vanish.
        cols, _swim, _ = providers.apply_pivot(
            [_pipe_issue(1)], LensConfig("pipeline", "milestone")
        )
        self.assertEqual([c.key for c in cols], ["backlog", "todo", "doing", "review", "done"])
        self.assertEqual([c.label for c in cols], ["Backlog", "To Do", "Doing", "Review", "Done"])


class PipelineLinkTests(SimpleTestCase):
    """`_link_pipeline` populates has_branch / has_open_pr / pipeline_evidence from
    the repo's branches and open MRs, tolerant of prefixed branch conventions."""

    def _link(self, branches, prs):
        issues = [_issue(n) for n in range(1, 40)]
        providers._link_pipeline(issues, branches, prs)
        return {i.number: i for i in issues}

    def test_prefixed_and_bare_branches_link(self):
        by_num = self._link(["feat/12-foo", "34-bar", "fix/sidebar-nothing"], [])
        self.assertTrue(by_num[12].has_branch)
        self.assertEqual(by_num[12].pipeline_evidence.branch, "feat/12-foo")
        self.assertTrue(by_num[34].has_branch)

    def test_branch_false_positive_guard(self):
        # A version-looking branch must not link to issue 1.
        by_num = self._link(["release/1.2.0", "v2-thing"], [])
        self.assertFalse(by_num[1].has_branch)
        self.assertFalse(by_num[2].has_branch)

    def test_mr_closes_vs_references(self):
        prs = [
            providers._PR(number=100, url="u100", source_branch="x", title="t", body="Closes #5"),
            providers._PR(number=101, url="u101", source_branch="y", title="t", body="related to #6"),
        ]
        by_num = self._link([], prs)
        self.assertTrue(by_num[5].has_open_pr)
        self.assertTrue(by_num[5].pipeline_evidence.mr_closes)
        self.assertEqual(by_num[5].pipeline_evidence.mr_number, 100)
        self.assertTrue(by_num[6].has_open_pr)
        self.assertFalse(by_num[6].pipeline_evidence.mr_closes)  # mention only

    def test_mr_source_branch_links_issue(self):
        prs = [providers._PR(number=102, url="u", source_branch="feat/7-x", title="t", body="")]
        by_num = self._link([], prs)
        self.assertTrue(by_num[7].has_open_pr)
        self.assertFalse(by_num[7].pipeline_evidence.mr_closes)

    def test_evidence_carries_branch_and_closing_mr(self):
        prs = [providers._PR(number=103, url="u103", source_branch="x", title="t", body="Fixes #8")]
        by_num = self._link(["feat/8-work"], prs)
        ev = by_num[8].pipeline_evidence
        self.assertEqual(ev.branch, "feat/8-work")
        self.assertEqual(ev.mr_number, 103)
        self.assertTrue(ev.mr_closes)


class PipelineEnrichmentGatingTests(SimpleTestCase):
    """Branches + MRs are fetched ONLY for the pipeline column dim, so other pivots
    don't pay the extra outbound calls."""

    @patch("git_lens.providers.requests.get")
    def test_no_enrichment_calls_for_non_pipeline(self, mock_get):
        mock_get.return_value = _resp([
            {"iid": 1, "title": "t", "web_url": "u", "state": "opened", "labels": [], "assignees": []},
        ])
        providers.gitlab_fetch(None, "g/p", LensConfig("status", "milestone"), LensFilters())
        self.assertEqual(mock_get.call_count, 1)  # issues only

    @patch("git_lens.providers.requests.get")
    def test_enrichment_calls_for_pipeline(self, mock_get):
        mock_get.return_value = _resp([
            {"iid": 1, "title": "t", "web_url": "u", "state": "opened", "labels": [], "assignees": []},
        ])
        providers.gitlab_fetch(None, "g/p", LensConfig("pipeline", "milestone"), LensFilters())
        self.assertEqual(mock_get.call_count, 3)  # issues + branches + open MRs


class FilterTests(SimpleTestCase):
    def setUp(self):
        # _github_milestone_map caches the roster per credential; clear it so these
        # tests never inherit a roster another test planted.
        cache.clear()

    @patch("git_lens.providers.requests.get")
    def test_gitlab_state_and_milestone_are_server_side(self, mock_get):
        mock_get.return_value = _resp([])
        providers.gitlab_fetch(
            None, "g/p", LensConfig("status", "milestone"),
            LensFilters(state="open", milestone="0.3"),
        )
        params = mock_get.call_args_list[0].kwargs["params"]
        self.assertEqual(params.get("state"), "opened")  # open → opened (GitLab vocab)
        self.assertEqual(params.get("milestone"), "0.3")

    @patch("git_lens.providers.requests.get")
    def test_gitlab_no_milestone_maps_to_None_literal(self, mock_get):
        mock_get.return_value = _resp([])
        providers.gitlab_fetch(None, "g/p", LensConfig(), LensFilters(milestone="__none__"))
        self.assertEqual(mock_get.call_args_list[0].kwargs["params"].get("milestone"), "None")

    @patch("git_lens.providers.requests.get")
    def test_github_milestone_resolved_to_number_server_side(self, mock_get):
        """#1067: GitHub milestone filtering moved from client-side to server-side.
        GitHub's issues API takes a milestone NUMBER, so the title is resolved via
        the milestones roster first — the whole point being that the filter then
        reaches issues OUTSIDE the 300-issue fetch budget, which a client-side pass
        over the already-fetched page never could."""
        def by_url(url, **kwargs):
            if url.endswith("/milestones"):
                return _resp([{"title": "0.3", "number": 7}, {"title": "1.2", "number": 8}])
            return _resp([
                {"number": 2, "title": "b", "html_url": "u", "state": "open",
                 "labels": [], "assignees": [], "milestone": {"title": "0.3"}},
            ])

        mock_get.side_effect = by_url
        data = providers.github_fetch(
            "tok", "o/r", LensConfig("state", "milestone"),
            LensFilters(state="open", milestone="0.3"),
        )
        issue_params = mock_get.call_args_list[-1].kwargs["params"]
        self.assertEqual(issue_params.get("state"), "open")
        self.assertEqual(issue_params.get("milestone"), "7")  # title → number
        self.assertEqual({i.number for i in data.issues}, {2})

    @patch("git_lens.providers.requests.get")
    def test_github_no_milestone_sentinel_needs_no_roster_lookup(self, mock_get):
        """GitHub accepts the literal "none", so "__none__" costs zero extra calls."""
        mock_get.return_value = _resp([])
        providers.github_fetch("tok", "o/r", LensConfig(), LensFilters(milestone="__none__"))
        self.assertEqual(mock_get.call_args_list[0].kwargs["params"].get("milestone"), "none")
        for call in mock_get.call_args_list:
            self.assertNotIn("/milestones", call.args[0])

    @patch("git_lens.providers.requests.get")
    def test_github_unknown_milestone_with_complete_roster_returns_empty(self, mock_get):
        """The roster came back short of a full page, so it is complete and the
        title genuinely does not exist upstream. Return an empty board rather than
        falling back — otherwise "no such milestone" is indistinguishable from "no
        matches inside the fetched window". Costs zero issue requests."""
        mock_get.return_value = _resp([{"title": "0.3", "number": 7}])
        data = providers.github_fetch(
            "tok", "o/r", LensConfig("state", "milestone"), LensFilters(milestone="nope")
        )
        self.assertEqual(data.issues, [])
        self.assertFalse(data.truncated)
        self.assertEqual(mock_get.call_count, 1)  # roster only — no issue fetch

    @patch("git_lens.providers.requests.get")
    def test_github_unknown_milestone_with_capped_roster_falls_back_client_side(self, mock_get):
        """A FULL roster page means the title may live on a page we never read, so
        resolution is unknown rather than negative. Degrade to the pre-#1067
        client-side filter and mark the result truncated."""
        full_roster = [{"title": f"m{i}", "number": i} for i in range(providers.PER_PAGE)]

        def by_url(url, **kwargs):
            if url.endswith("/milestones"):
                return _resp(full_roster)
            return _resp([
                {"number": 1, "title": "a", "html_url": "u", "state": "open",
                 "labels": [], "assignees": [], "milestone": {"title": "1.2"}},
                {"number": 2, "title": "b", "html_url": "u", "state": "open",
                 "labels": [], "assignees": [], "milestone": {"title": "0.3"}},
            ])

        mock_get.side_effect = by_url
        data = providers.github_fetch(
            "tok", "o/r", LensConfig("state", "milestone"), LensFilters(milestone="0.3")
        )
        issue_params = mock_get.call_args_list[-1].kwargs["params"]
        self.assertNotIn("milestone", issue_params)  # could not resolve → not sent
        self.assertEqual({i.number for i in data.issues}, {2})  # filtered client-side
        self.assertTrue(data.truncated)  # the set may be incomplete — say so

    @patch("git_lens.providers.requests.get")
    def test_github_milestone_roster_is_cached_per_credential(self, mock_get):
        """The roster is cached under a hash of the TOKEN, never per repo alone:
        GitHub reads use the viewer's own token and may see rosters other board
        members cannot. Two different tokens must not share one cached roster."""
        cache.clear()

        def by_url(url, **kwargs):
            if url.endswith("/milestones"):
                return _resp([{"title": "0.3", "number": 7}])
            return _resp([])

        mock_get.side_effect = by_url
        filters = LensFilters(milestone="0.3")
        providers.github_fetch("tok-a", "o/r", LensConfig(), filters)
        providers.github_fetch("tok-a", "o/r", LensConfig(), filters)  # cached
        roster_calls = [c for c in mock_get.call_args_list if c.args[0].endswith("/milestones")]
        self.assertEqual(len(roster_calls), 1)

        providers.github_fetch("tok-b", "o/r", LensConfig(), filters)  # other token
        roster_calls = [c for c in mock_get.call_args_list if c.args[0].endswith("/milestones")]
        self.assertEqual(len(roster_calls), 2)  # NOT served token-a's roster

    @patch("git_lens.providers.requests.get")
    def test_github_labels_and_assignee_are_server_side(self, mock_get):
        mock_get.return_value = _resp([])
        providers.github_fetch(
            "tok", "o/r", LensConfig("state", "milestone"),
            LensFilters(labels=("backend", "bug"), assignee="alice"),
        )
        params = mock_get.call_args_list[0].kwargs["params"]
        self.assertEqual(params.get("labels"), "backend,bug")
        self.assertEqual(params.get("assignee"), "alice")

    @patch("git_lens.providers.requests.get")
    def test_gitlab_labels_and_assignee_are_server_side(self, mock_get):
        mock_get.return_value = _resp([])
        providers.gitlab_fetch(
            None, "g/p", LensConfig("status", "milestone"),
            LensFilters(labels=("backend", "bug"), assignee="alice"),
        )
        params = mock_get.call_args_list[0].kwargs["params"]
        self.assertEqual(params.get("labels"), "backend,bug")
        self.assertEqual(params.get("assignee_username"), "alice")

    @patch("git_lens.providers.requests.get")
    def test_user_controlled_filter_values_are_passed_as_params_not_interpolated(self, mock_get):
        """Label/assignee are user-controlled and go straight into an outbound
        request. They must ride in `params` (which requests URL-encodes) and never
        be interpolated into the URL, or a crafted value could bolt extra query
        parameters onto the upstream call."""
        mock_get.return_value = _resp([])
        nasty = "bug&state=all#x"
        providers.gitlab_fetch(
            None, "g/p", LensConfig(), LensFilters(labels=(nasty,), assignee=nasty)
        )
        url = mock_get.call_args_list[0].args[0]
        self.assertNotIn(nasty, url)
        self.assertNotIn("?", url)
        params = mock_get.call_args_list[0].kwargs["params"]
        self.assertEqual(params.get("labels"), nasty)  # value preserved verbatim
        self.assertEqual(params.get("assignee_username"), nasty)

    @patch("git_lens.providers.requests.get")
    def test_github_milestone_roster_fetch_error_propagates_before_issue_fetch(self, mock_get):
        """A failure resolving the milestone roster (rate limit, auth, 404, 5xx) must
        raise the same LensError type any other upstream failure does — the view
        layer's degrade-to-stale/clean-error handling doesn't distinguish where in
        the provider call graph the failure occurred, so this only needs proving
        here. No issue request should ever be attempted once resolution has failed,
        or a filtered fetch would silently return an unfiltered issue set."""
        mock_get.return_value = _resp({}, status=404)  # the /milestones lookup 404s
        with self.assertRaises(providers.LensNotFound):
            providers.github_fetch(
                "tok", "o/r", LensConfig("state", "milestone"), LensFilters(milestone="1.2")
            )
        self.assertEqual(mock_get.call_count, 1)  # roster only — no issue fetch attempted

    @patch("git_lens.providers.requests.get")
    def test_available_milestones_derived_from_fetched_issues(self, mock_get):
        mock_get.return_value = _resp([
            {"iid": 1, "title": "a", "web_url": "u", "state": "opened", "labels": [], "assignees": [], "milestone": {"title": "1.2"}},
            {"iid": 2, "title": "b", "web_url": "u", "state": "opened", "labels": [], "assignees": [], "milestone": None},
        ])
        data = providers.gitlab_fetch(None, "g/p", LensConfig(), LensFilters())
        self.assertEqual(data.available_milestones, ["1.2"])  # None dropped, deduped, sorted
