"""Card-link hardening (#2383): the link-write throttle and the link lock order.

* ``card_link_write`` throttles the three link writes per user, on top of the
  ``user`` scope; the children read is not counted.
* A single-card delete (REST and Django admin) and a Django-admin move of a
  linked card take the card and its link peers in pk order
  (``card_links.lock_card_and_link_peers``), the order every link write takes,
  so neither holds its own card while waiting on a peer a link write holds.
"""

import threading
from unittest import mock, skipUnless

from django.conf import settings
from django.contrib import admin as django_admin
from django.core.cache import cache
from django.db import connection, connections, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase
from rest_framework.throttling import UserRateThrottle

from boards.admin import CardAdmin
from boards.models import Card, CardParentLink
from boards.tests.conftest import _make_board, _make_card, _make_column, _make_swimlane
from boards.tests.lock_wait import assert_blocked_on_lock
from boards.tests.test_card_parent_links import HOLD_TIMEOUT, Role, _LinkFixture
from boards.views.cards import CardLinkWriteThrottle, _is_link_write


class CardLinkWriteThrottleTests(_LinkFixture, TestCase):
    def setUp(self):
        cache.clear()
        self._setup_boards()
        self.member = self._user("cl2383_m", parent_role=Role.MEMBER, child_role=Role.MEMBER)
        self.client = self._client(self.member)
        self.second_child = _make_card(self.col_c, self.lane_c, title="second")
        self.parent_url = f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/parent/"
        self.children_url = f"/api/v1/boards/{self.pboard.pk}/cards/{self.parent.pk}/children/"

    def test_scope_is_configured(self):
        rates = settings.REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]
        self.assertIn("card_link_write", rates)
        self.assertEqual(CardLinkWriteThrottle.scope, "card_link_write")

    def test_link_writes_share_one_budget_and_the_children_read_is_not_counted(self):
        with mock.patch.object(CardLinkWriteThrottle, "get_rate", return_value="3/hour"):
            self.assertEqual(self._link(self.client).status_code, 201)
            self.assertEqual(self._link(self.client, child=self.second_child).status_code, 201)
            for _ in range(3):
                self.assertEqual(self.client.get(self.children_url).status_code, 200)
            # Parent-side unlink is the third write.
            res = self.client.delete(f"{self.children_url}{self.second_child.pk}/")
            self.assertEqual(res.status_code, 204, res.content)
            # Child-side unlink is the fourth: refused, and nothing is unlinked.
            res = self.client.delete(self.parent_url)
            self.assertEqual(res.status_code, 429)
            self.assertIn("Retry-After", res)
            # A create is refused the same way.
            self.assertEqual(self._link(self.client, child=self.second_child).status_code, 429)
            # The read is still answered once the write budget is spent.
            self.assertEqual(self.client.get(self.children_url).status_code, 200)
        self.assertEqual(
            list(CardParentLink.objects.values_list("parent_id", "child_id")),
            [(self.parent.pk, self.child.pk)],
        )

    def test_budget_is_per_user(self):
        other = self._user("cl2383_o", parent_role=Role.MEMBER, child_role=Role.MEMBER)
        with mock.patch.object(CardLinkWriteThrottle, "get_rate", return_value="1/hour"):
            self.assertEqual(self._link(self.client).status_code, 201)
            self.assertEqual(self._link(self.client, child=self.second_child).status_code, 429)
            self.assertEqual(
                self._link(self._client(other), child=self.second_child).status_code, 201,
            )

    def test_default_user_scope_still_applies_to_link_writes(self):
        """Appended, not replacing: the ``user`` scope keeps counting link writes."""
        with mock.patch.object(
            UserRateThrottle, "get_rate", autospec=True,
            side_effect=lambda self: "1/hour" if self.scope == "user" else "100/hour",
        ):
            self.assertEqual(self._link(self.client).status_code, 201)
            self.assertEqual(self.client.delete(self.parent_url).status_code, 429)

    def test_other_card_writes_are_not_counted(self):
        owner = self._client(self.owner)
        with mock.patch.object(CardLinkWriteThrottle, "get_rate", return_value="1/hour"):
            res = owner.patch(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/",
                {"title": "renamed"}, format="json",
            )
            self.assertEqual(res.status_code, 200, res.content)
            self.assertEqual(self._link(owner).status_code, 201)


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class IsLinkWriteAbsentInputTests(TestCase):
    """#1075: a view with no resolvable action is never a link write, and never raises."""

    def test_view_without_action_is_not_a_link_write(self):
        request = mock.Mock(method="POST")
        self.assertFalse(_is_link_write(object(), request))

    def test_view_with_none_action_is_not_a_link_write(self):
        request = mock.Mock(method="DELETE")
        self.assertFalse(_is_link_write(mock.Mock(action=None), request))


class LinkPeerLockOrderTests(_LinkFixture, TransactionTestCase):
    """The card and its link peers are locked in pk order before the card alone.

    The parent is created first, so its pk is the lower one; the paths below
    act on the child. A "link writer" thread holds the parent (its first lock
    in pk order) and is about to take the child (its second). The path under
    test must wait on the parent WITHOUT holding the child, so the writer's
    ``NOWAIT`` lock on the child succeeds. When the path took the child first
    (the residual this closes), that lock failed and, had the writer waited,
    PostgreSQL would have aborted one of the two with a deadlock error.
    """

    def setUp(self):
        self._setup_boards()
        self.assertLess(self.parent.pk, self.child.pk)
        CardParentLink.objects.create(parent=self.parent, child=self.child)

    def _run(self, name, fn, results):
        def run():
            try:
                results[name] = fn()
            except Exception as exc:  # surfaced by the assertions below
                results[name] = exc
            finally:
                connections.close_all()

        t = threading.Thread(target=run, name=name)
        t.start()
        return t

    def _assert_waits_on_peer_without_holding_card(self, fn):
        held, release, results = threading.Event(), threading.Event(), {}

        def link_writer():
            with transaction.atomic():
                list(Card.objects.select_for_update().filter(pk=self.parent.pk).values_list("pk", flat=True))
                held.set()
                release.wait(HOLD_TIMEOUT)
                list(
                    Card.objects.select_for_update(nowait=True)
                    .filter(pk=self.child.pk).values_list("pk", flat=True)
                )
            return "ok"

        writer = self._run("link_writer", link_writer, results)
        self.assertTrue(held.wait(HOLD_TIMEOUT), "link writer never took the parent lock")
        path = self._run("path", fn, results)
        assert_blocked_on_lock(self, path, "the path did not wait on the peer's lock")
        release.set()
        writer.join(HOLD_TIMEOUT)
        path.join(HOLD_TIMEOUT)
        self.assertEqual(
            results.get("link_writer"), "ok",
            f"the path held the child card while waiting on its peer: {results.get('link_writer')!r}",
        )
        if isinstance(results.get("path"), Exception):
            self.fail(f"path raised {results['path']!r}")
        return results["path"]

    def _admin_request(self):
        request = RequestFactory().post("/")
        request.user = self.owner
        return request

    def test_rest_card_delete(self):
        def delete():
            return self._client(self.owner).delete(
                f"/api/v1/boards/{self.cboard.pk}/cards/{self.child.pk}/"
            )

        res = self._assert_waits_on_peer_without_holding_card(delete)
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())
        self.assertFalse(CardParentLink.objects.exists())

    def test_django_admin_card_delete(self):
        def delete():
            with transaction.atomic():
                CardAdmin(Card, django_admin.site).delete_model(
                    self._admin_request(), Card.objects.get(pk=self.child.pk),
                )

        self._assert_waits_on_peer_without_holding_card(delete)
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())

    def test_django_admin_move_to_another_board(self):
        other_board = _make_board(self.owner, name="Elsewhere 2383")
        col, lane = _make_column(other_board), _make_swimlane(other_board)

        def move():
            child = Card.objects.get(pk=self.child.pk)
            child.board, child.column, child.swimlane = other_board, col, lane
            with transaction.atomic():
                CardAdmin(Card, django_admin.site).save_model(self._admin_request(), child, None, True)

        self._assert_waits_on_peer_without_holding_card(move)
        self.assertEqual(Card.objects.get(pk=self.child.pk).board_id, other_board.pk)
        self.assertFalse(CardParentLink.objects.exists())

    def test_card_without_links_locks_only_itself(self):
        """No peers: the helper takes nothing, and the parent stays free."""
        CardParentLink.objects.all().delete()
        from boards.services.card_links import lock_card_and_link_peers

        with transaction.atomic():
            lock_card_and_link_peers(self.child.pk)
            results = {}

            def probe():
                with transaction.atomic():
                    return list(
                        Card.objects.select_for_update(nowait=True)
                        .filter(pk__in=[self.parent.pk, self.child.pk]).values_list("pk", flat=True)
                    )

            t = self._run("probe", probe, results)
            t.join(HOLD_TIMEOUT)
        self.assertEqual(sorted(results["probe"]), [self.parent.pk, self.child.pk])
