"""Pure unit tests for the lens normalization/pivot and provider fetch logic.

These require neither the database nor the git_lens app to be installed (the
providers/types modules import no Django models), so they run in the main test
suite regardless of the GIT_LENS_ENABLED flag. Upstream HTTP is mocked.
"""
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from git_lens import providers
from git_lens.types import LensConfig, LensLabel, LensUser, NormalizedIssue


def _issue(number=1, state="open", labels=None, milestone=None, assignees=None):
    return NormalizedIssue(
        number=number,
        title=f"#{number}",
        url=f"https://example/{number}",
        state=state,
        labels=[LensLabel(name=n) for n in (labels or [])],
        assignees=[LensUser(username=u) for u in (assignees or [])],
        milestone=milestone,
    )


def _resp(json_data, status=200, headers=None):
    m = MagicMock()
    m.status_code = status
    m.json.return_value = json_data
    m.headers = headers or {}
    return m


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


class GitHubFetchTests(SimpleTestCase):
    @patch("git_lens.providers.requests.get")
    def test_filters_pull_requests(self, mock_get):
        mock_get.return_value = _resp([
            {"number": 1, "title": "real issue", "html_url": "u", "state": "open", "labels": [], "assignees": []},
            {"number": 2, "title": "a PR", "html_url": "u", "state": "open", "labels": [], "assignees": [], "pull_request": {"url": "x"}},
        ])
        data = providers.github_fetch("tok", "o/r", LensConfig("state", "milestone"))
        self.assertEqual([i.number for i in data.issues], [1])

    @patch("git_lens.providers.requests.get")
    def test_pagination_and_truncation(self, mock_get):
        full = [{"number": n, "title": "t", "html_url": "u", "state": "open", "labels": [], "assignees": []}
                for n in range(providers.PER_PAGE)]
        mock_get.return_value = _resp(full)  # every page full → hits page cap
        data = providers.github_fetch("tok", "o/r", LensConfig("state", "milestone"))
        self.assertTrue(data.truncated)
        self.assertIsNone(data.total_count)
        self.assertEqual(mock_get.call_count, providers.MAX_PAGES)

    @patch("git_lens.providers.requests.get")
    def test_404_raises_not_found(self, mock_get):
        mock_get.return_value = _resp({}, status=404)
        with self.assertRaises(providers.LensNotFound):
            providers.github_fetch("tok", "o/r", LensConfig())

    @patch("git_lens.providers.requests.get")
    def test_rate_limit_detected(self, mock_get):
        mock_get.return_value = _resp({}, status=403, headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "999"})
        with self.assertRaises(providers.LensRateLimited):
            providers.github_fetch("tok", "o/r", LensConfig())

    @patch("git_lens.providers.requests.get")
    def test_label_color_default_when_missing(self, mock_get):
        mock_get.return_value = _resp([
            {"number": 1, "title": "t", "html_url": "u", "state": "open",
             "labels": [{"name": "bug", "color": None}], "assignees": []},
        ])
        data = providers.github_fetch("tok", "o/r", LensConfig())
        self.assertEqual(data.issues[0].labels[0].color, "888888")


class GitLabFetchTests(SimpleTestCase):
    @patch("git_lens.providers.requests.get")
    def test_state_normalized_and_anonymous(self, mock_get):
        mock_get.return_value = _resp([
            {"iid": 7, "title": "t", "web_url": "u", "state": "opened",
             "labels": [{"name": "bug", "color": "#ff0000"}], "assignees": [], "milestone": {"title": "v2"}},
        ])
        data = providers.gitlab_fetch(None, "g/p", LensConfig("status", "milestone"))
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
            providers.gitlab_fetch(None, "g/p", LensConfig())


class RegistryTests(SimpleTestCase):
    def test_builtin_providers_registered(self):
        self.assertEqual(providers.available_providers(), ["github", "gitlab"])
        self.assertIsNotNone(providers.get_provider("github"))
        self.assertIsNone(providers.get_provider("bitbucket"))
