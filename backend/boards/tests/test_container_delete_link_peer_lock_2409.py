"""Link-peer lock order on the container deletes and the peer re-read (#2409).

#2383 made the single-card paths take the card and its parent/child link
peers in pk order (``card_links.lock_card_and_link_peers``). This covers the
rest of the bug class:

* Every container delete (REST column, swimlane and board destroys, the
  Django-admin deletes, the seed ``--wipe`` through ``delete_boards_locked``)
  takes its cards **and their link peers** in the one pk-ordered statement of
  ``services.cards.lock_cards_for_cascade``, so it never holds its own card
  while waiting on a peer a link write holds.
* Both lock takers read the peers before the lock and re-read them under it:
  a link committed in between is a mismatch, rolled back to a savepoint and
  retried, so the peer it added is locked too.

PostgreSQL only: row locks are not observable on SQLite.
"""

import threading
from unittest import mock, skipUnless

from django.contrib import admin as django_admin
from django.db import OperationalError, connection, connections, transaction
from django.test import RequestFactory, TestCase, TransactionTestCase

from boards.admin import CardAdmin
from boards.models import Board, Card, CardActivity, CardParentLink, Column
from boards.services import card_links
from boards.services import cards as card_services
from boards.services.errors import ContainerChanged, LinksChanged
from boards.tests.conftest import _make_column, _make_swimlane
# The module, not the class: a class imported here would be collected twice.
from boards.tests import test_card_link_hardening_2383 as _h2383
from boards.tests.test_card_parent_links import HOLD_TIMEOUT, _LinkFixture


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class ContainerDeleteLinkPeerLockOrderTests(_LinkFixture, TransactionTestCase):
    """The container's cards and their peers are locked together, in pk order.

    The parent is created first, so its pk is the lower one; each container
    below holds the child. A "link writer" thread holds the parent and then
    takes the child with ``NOWAIT``. The delete must wait on the parent
    without holding the child, so that ``NOWAIT`` succeeds; before #2409 the
    delete held the child first, the ``NOWAIT`` failed, and a waiting writer
    would have been aborted by PostgreSQL as a deadlock.
    """

    _run = _h2383.LinkPeerLockOrderTests._run
    _assert_waits_on_peer_without_holding_card = (
        _h2383.LinkPeerLockOrderTests._assert_waits_on_peer_without_holding_card
    )

    def setUp(self):
        self._setup_boards()
        self.assertLess(self.parent.pk, self.child.pk)
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        # A second column and swimlane, so deleting the child's is never the
        # board's last one.
        _make_column(self.cboard, name="Spare col", order=1)
        _make_swimlane(self.cboard, name="Spare lane", order=1)

    def _rest_delete(self, url):
        def delete():
            return self._client(self.owner).delete(url)

        res = self._assert_waits_on_peer_without_holding_card(delete)
        self.assertEqual(res.status_code, 204, res.content)
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())
        self.assertFalse(CardParentLink.objects.exists())
        # The surviving peer still records the unlink (#1104).
        self.assertTrue(
            CardActivity.objects.filter(card=self.parent, event_type="child_unlinked").exists()
        )

    def test_rest_column_delete(self):
        self._rest_delete(f"/api/v1/boards/{self.cboard.pk}/columns/{self.col_c.pk}/")

    def test_rest_swimlane_delete(self):
        self._rest_delete(f"/api/v1/boards/{self.cboard.pk}/swimlanes/{self.lane_c.pk}/")

    def test_rest_board_delete(self):
        self._rest_delete(f"/api/v1/boards/{self.cboard.pk}/")

    def test_django_admin_bulk_card_delete(self):
        def delete():
            request = RequestFactory().post("/")
            request.user = self.owner
            CardAdmin(Card, django_admin.site).delete_queryset(
                request, Card.objects.filter(pk=self.child.pk),
            )

        self._assert_waits_on_peer_without_holding_card(delete)
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())

    def _admin_container_delete(self, kind, mode):
        """Run one Django-admin container or user delete behind the peer lock."""
        from accounts.models import User

        staff = User.objects.create_superuser(
            username="staff2409", password="pass", email="s2409@example.com"
        )
        target = {
            "column": self.col_c, "swimlane": self.lane_c,
            "board": self.cboard, "user": self.owner,
        }[kind]
        if kind == "user":
            # _LinkFixture makes the owner own both boards, which would put the
            # parent inside the delete's cascade. Hand the parent's board to
            # someone else so the parent is a peer outside the container.
            other = User.objects.create_user(
                username="pown2409", password="pass", email="pown2409@example.com"
            )
            self.pboard.owner = other
            self.pboard.save(update_fields=["owner"])
            # The user delete also locks every card that references the user
            # (created_by, assignee), so the parent must not reference them.
            Card.objects.filter(pk=self.parent.pk).update(created_by=other, assignee=None)
        model_admin = django_admin.site._registry[type(target)]

        def delete():
            request = RequestFactory().post("/")
            request.user = staff
            # The user-delete guard (#1616) refuses a board owner; this test is
            # about lock order, so it is stubbed for the user kind only.
            guard = (
                mock.patch("accounts.admin.user_deletion_refusals", return_value=[])
                if kind == "user" else mock.MagicMock()
            )
            with guard:
                if mode == "model":
                    model_admin.delete_model(request, type(target).objects.get(pk=target.pk))
                else:
                    model_admin.delete_queryset(
                        request, type(target).objects.filter(pk=target.pk)
                    )

        self._assert_waits_on_peer_without_holding_card(delete)
        self.assertFalse(type(target).objects.filter(pk=target.pk).exists())
        self.assertFalse(Card.objects.filter(pk=self.child.pk).exists())

    def test_seed_wipe_delete_boards_locked(self):
        self._assert_waits_on_peer_without_holding_card(
            lambda: card_services.delete_boards_locked(Board.objects.filter(pk=self.cboard.pk))
        )
        self.assertFalse(Board.objects.filter(pk=self.cboard.pk).exists())
        self.assertTrue(Card.objects.filter(pk=self.parent.pk).exists())


def _admin_delete_test(kind, mode):
    def test(self):
        self._admin_container_delete(kind, mode)

    return test


# One generated test per admin caller (column, swimlane, board and user, each
# through delete_model and delete_queryset), each on a fresh fixture.
for _kind in ("column", "swimlane", "board", "user"):
    for _mode in ("model", "queryset"):
        setattr(
            ContainerDeleteLinkPeerLockOrderTests,
            f"test_django_admin_{_kind}_delete_{_mode}",
            _admin_delete_test(_kind, _mode),
        )


@skipUnless(connection.vendor == "postgresql", "row locks are only observable on PostgreSQL")
class PeerReadUnderLockTests(_LinkFixture, TransactionTestCase):
    """A link committed between the unlocked peer read and the lock is caught
    by the re-read under the lock, and its peer is locked on the retry."""

    def setUp(self):
        self._setup_boards()

    def _link_in_another_transaction(self):
        def create():
            try:
                CardParentLink.objects.create(parent=self.parent, child=self.child)
            finally:
                connections.close_all()

        t = threading.Thread(target=create)
        t.start()
        t.join(HOLD_TIMEOUT)
        self.assertFalse(t.is_alive(), "the link insert never finished")

    def _stale_first_peer_read(self):
        """Patch ``link_peer_pks``: its first call commits a link and then
        returns the peer set as it was before that link."""
        real = card_links.link_peer_pks
        calls = []

        def stale_once(cards):
            calls.append(1)
            if len(calls) == 1:
                before = real(cards)
                self._link_in_another_transaction()
                return before
            return real(cards)

        return mock.patch.object(card_links, "link_peer_pks", side_effect=stale_once), calls

    def _parent_is_locked(self):
        results = {}

        def probe():
            try:
                with transaction.atomic():
                    list(
                        Card.objects.select_for_update(nowait=True)
                        .filter(pk=self.parent.pk).values_list("pk", flat=True)
                    )
                results["probe"] = "free"
            except OperationalError:
                results["probe"] = "locked"
            finally:
                connections.close_all()

        t = threading.Thread(target=probe)
        t.start()
        t.join(HOLD_TIMEOUT)
        return results.get("probe") == "locked"

    def test_single_card_lock_retries_and_locks_the_new_peer(self):
        patcher, calls = self._stale_first_peer_read()
        with patcher, transaction.atomic():
            card_links.lock_card_and_link_peers(self.child.pk)
            self.assertTrue(self._parent_is_locked(), "the newly linked peer was not locked")
        # First attempt: stale read + re-read; second attempt: read + re-read.
        self.assertEqual(len(calls), 4)

    def test_container_lock_retries_and_locks_the_new_peer(self):
        patcher, calls = self._stale_first_peer_read()
        with patcher, transaction.atomic():
            card_services.lock_cards_for_cascade(
                Card.objects.filter(board=self.cboard),
                entry_columns=Column.objects.filter(board=self.cboard),
                boards=Board.objects.filter(pk=self.cboard.pk),
            )
            self.assertTrue(self._parent_is_locked(), "the newly linked peer was not locked")
        self.assertEqual(len(calls), 4)

    def test_single_card_lock_gives_up_with_links_changed(self):
        """A card whose peer set never matches ends in a 409, not a loop."""
        with mock.patch.object(card_links, "link_peer_pks", side_effect=[set(), {self.parent.pk}] * 3):
            with self.assertRaises(LinksChanged) as ctx, transaction.atomic():
                card_links.lock_card_and_link_peers(self.child.pk)
        self.assertIsInstance(ctx.exception, ContainerChanged)
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.body()["code"], "links_changed")

    def test_outside_a_transaction_refuses_to_run(self):
        """Absent input (#1075): with no transaction to hold the locks, the
        helper raises instead of silently taking nothing."""
        CardParentLink.objects.create(parent=self.parent, child=self.child)
        with self.assertRaises(RuntimeError):
            card_links.lock_card_and_link_peers(self.child.pk)


class AdminFormLinksChangedTests(_LinkFixture, TestCase):
    """The admin change form answers an exhausted peer-lock retry as a form
    error, not a 500 (#2409). Runs on any database: the helper is stubbed."""

    def test_links_changed_is_a_form_error(self):
        from boards.tests.test_admin_card_cell_entry_race import _admin_post_data

        self._setup_boards()
        type(self.owner).objects.filter(pk=self.owner.pk).update(is_superuser=True, is_staff=True)
        self.owner.refresh_from_db()
        request = RequestFactory().post("/")
        request.user = self.owner
        model_admin = CardAdmin(Card, django_admin.site)
        child = Card.objects.get(pk=self.child.pk)
        data = _admin_post_data(child, title="Renamed 2409", mentioned_user_ids="[]")
        with mock.patch("boards.admin.lock_card_and_link_peers", side_effect=LinksChanged()):
            form = model_admin.get_form(request, obj=child)(data, instance=child)
            self.assertFalse(form.is_valid())
        self.assertIn(LinksChanged.detail, form.non_field_errors())
