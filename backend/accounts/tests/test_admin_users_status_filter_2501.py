"""``status`` filter and ``counts`` on GET /api/v1/admin/users/ (#2501).

The admin Users page's All / Active / Deactivated / Admins pills need the
filter applied server-side, before paging, so ``count`` (and "Showing x-y of
N") is the filter's total and not a filtered slice of one page.
"""
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework import status
from rest_framework.test import APIClient

from accounts.models import User

URL = "/api/v1/admin/users/"


def _user(username, *, active=True, site_admin=False):
    u = User.objects.create_user(username=username, email=f"{username}@example.com", password="pw-12345678!")
    User.objects.filter(pk=u.pk).update(is_active=active, is_site_admin=site_admin)
    return u


class AdminUsersStatusFilterTests(TestCase):
    def setUp(self):
        # admin (active admin), alice + bob (active), carol (deactivated),
        # dave (deactivated admin): the case that makes the counts overlap.
        self.admin = _user("admin", site_admin=True)
        _user("alice")
        _user("bob")
        _user("carol", active=False)
        _user("dave", active=False, site_admin=True)
        self.client = APIClient()
        self.client.force_authenticate(User.objects.get(pk=self.admin.pk))

    def _names(self, r):
        return [u["username"] for u in r.json()["results"]]

    def test_absent_status_lists_everyone(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.json()["count"], 5)
        self.assertEqual(self._names(r), ["admin", "alice", "bob", "carol", "dave"])

    def test_empty_and_all_match_absent(self):
        for value in ("", "all", "  all  "):
            with self.subTest(value=value):
                r = self.client.get(URL, {"status": value})
                self.assertEqual(r.status_code, status.HTTP_200_OK)
                self.assertEqual(r.json()["count"], 5)

    def test_active(self):
        r = self.client.get(URL, {"status": "active"})
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(self._names(r), ["admin", "alice", "bob"])
        self.assertEqual(r.json()["count"], 3)

    def test_deactivated(self):
        r = self.client.get(URL, {"status": "deactivated"})
        self.assertEqual(self._names(r), ["carol", "dave"])
        self.assertEqual(r.json()["count"], 2)

    def test_admins_includes_a_deactivated_admin(self):
        r = self.client.get(URL, {"status": "admins"})
        self.assertEqual(self._names(r), ["admin", "dave"])
        self.assertEqual(r.json()["count"], 2)

    def test_unknown_status_is_400_with_coded_body(self):
        for value in ("bogus", "Active", "inactive"):
            with self.subTest(value=value):
                r = self.client.get(URL, {"status": value})
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                body = r.json()
                self.assertEqual(body["code"], "invalid_query_param")
                self.assertIsInstance(body["detail"], str)

    def test_status_combines_with_search(self):
        r = self.client.get(URL, {"status": "deactivated", "search": "car"})
        self.assertEqual(self._names(r), ["carol"])
        self.assertEqual(r.json()["count"], 1)

    def test_filter_applies_before_paging(self):
        for i in range(4):
            _user(f"zz-off{i}", active=False)
        r = self.client.get(URL, {"status": "deactivated", "page_size": 2, "offset": 2})
        body = r.json()
        self.assertEqual(body["count"], 6)
        self.assertEqual(len(body["results"]), 2)
        self.assertTrue(all(not u["is_active"] for u in body["results"]))

    def test_counts_are_site_totals_without_search(self):
        r = self.client.get(URL)
        self.assertEqual(r.json()["counts"], {"all": 5, "active": 3, "deactivated": 2, "admins": 2})

    def test_counts_ignore_status_but_follow_search(self):
        """Facet counts: each pill shows what clicking it would return for this search."""
        r = self.client.get(URL, {"status": "deactivated", "search": "d"})
        # "d" matches only admin and dave (in username and email).
        self.assertEqual(r.json()["count"], 1)
        self.assertEqual(r.json()["counts"], {"all": 2, "active": 1, "deactivated": 1, "admins": 2})

    def test_each_count_equals_that_filters_count(self):
        for search in ("", "d", "bob"):
            counts = self.client.get(URL, {"search": search}).json()["counts"]
            for name, total in counts.items():
                with self.subTest(search=search, status=name):
                    r = self.client.get(URL, {"search": search, "status": name})
                    self.assertEqual(r.json()["count"], total)

    def test_counts_are_one_aggregate_query(self):
        with CaptureQueriesContext(connection) as plain:
            self.client.get(URL, {"status": "all"})
        with CaptureQueriesContext(connection) as filtered:
            self.client.get(URL, {"status": "deactivated"})
        self.assertEqual(len(plain.captured_queries), len(filtered.captured_queries))
        aggregates = [q["sql"] for q in plain.captured_queries if q["sql"].count("COUNT(") >= 4]
        self.assertEqual(len(aggregates), 1, aggregates)

    def test_non_admin_is_refused_whatever_the_status(self):
        self.client.force_authenticate(User.objects.get(username="alice"))
        r = self.client.get(URL, {"status": "admins"})
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
