"""Shared fixtures and factory helpers for the boards test suite.

The module-level ``_make_*`` functions can be imported directly by TestCase-based
tests.  The ``pytest.fixture`` wrappers expose the same factories as injectable
fixtures for future pytest-style (non-TestCase) tests.

Migrate per-file ``_make_*`` helper functions to use these factories incrementally.
Files migrated so far: test_card_move, test_rbac, test_wip_enforcement (#557).
"""

from contextlib import contextmanager
from unittest.mock import patch

from django.forms.models import model_to_dict

try:
    import pytest
    _PYTEST_AVAILABLE = True
except ImportError:
    _PYTEST_AVAILABLE = False

from accounts.models import User
from boards.models import (
    Board,
    BoardEvent,
    BoardMembership,
    Card,
    CardActivity,
    CardAttachment,
    CardChecklist,
    CardComment,
    CardMovement,
    Column,
    Swimlane,
)

# ---------------------------------------------------------------------------
# Importable factory helpers (usable directly from TestCase setUp)
# ---------------------------------------------------------------------------

_user_counter = 0


def _make_user(username=None, password="pass", **kwargs):
    """Create and return a User.

    ``username`` defaults to a unique auto-generated name so tests that don't
    care about the username never collide.  Pass ``**kwargs`` for fields like
    ``notif_stale=True``.
    """
    global _user_counter
    _user_counter += 1
    if username is None:
        username = f"user{_user_counter}"
    return User.objects.create_user(username=username, password=password, **kwargs)


def _make_board(owner, name="Test Board", **kwargs):
    """Create a Board and register *owner* as ADMIN.

    Pass ``**kwargs`` to set non-default Board fields (e.g.
    ``staleness_threshold_days=3``, ``enforce_wip_limits=True``).
    """
    board = Board.objects.create(name=name, owner=owner, **kwargs)
    BoardMembership.objects.create(
        board=board, user=owner, role=BoardMembership.Role.ADMIN
    )
    return board


def _make_column(board, name="Backlog", order=0, **kwargs):
    """Create a Column on *board*.  ``order`` maps to ``position``."""
    return Column.objects.create(board=board, name=name, position=order, **kwargs)


def _make_swimlane(board, name="General", order=0, **kwargs):
    """Create a Swimlane on *board*.  ``order`` maps to ``position``."""
    return Swimlane.objects.create(board=board, name=name, position=order, **kwargs)


def _make_card(column, swimlane, title="Test Card", **kwargs):
    """Create a Card in *column*/*swimlane*.

    ``created_by`` defaults to the board owner.  Pass ``**kwargs`` for fields
    like ``position``, ``assignee``, ``archived_at``.
    """
    board = column.board
    kwargs.setdefault("created_by", board.owner)
    kwargs.setdefault("position", 0)
    return Card.objects.create(
        board=board,
        column=column,
        swimlane=swimlane,
        title=title,
        **kwargs,
    )


def _make_membership(board, user, role="member"):
    """Add *user* to *board* at *role*, updating the existing row if present.

    Returns the BoardMembership instance.  ``role`` must be one of
    ``"admin"``, ``"member"``, ``"collaborator"``, or ``"viewer"``.
    """
    membership, _ = BoardMembership.objects.get_or_create(
        board=board,
        user=user,
        defaults={"role": role},
    )
    if membership.role != role:
        membership.role = role
        membership.save(update_fields=["role"])
    return membership


# ---------------------------------------------------------------------------
# RBAC denied-write assertions (#1402)
# ---------------------------------------------------------------------------
#
# A bare `assertEqual(resp.status_code, 403)` only proves the *response* was
# rejected. A regression that mutates state, records a CardMovement, writes a
# CardActivity/BoardEvent row, or broadcasts an event and *then* returns 403
# would pass every test in the RBAC matrix unnoticed. The movement audit
# trail is the product's differentiator, so this is the highest-value gap a
# permission test can leave open.

PATCH_BROADCAST = "boards.broadcast.broadcast_board_event"

# The row counts checked on every call. CardActivity and CardMovement are the
# two audit-trail tables; BoardEvent is the persisted feed row a broadcast is
# derived from (see boards.broadcast.broadcast_board_event and
# boards.services.cards._broadcast_after_commit).
_DENIED_WRITE_COUNT_MODELS = (
    Card,
    CardComment,
    CardAttachment,
    CardChecklist,
    CardMovement,
    CardActivity,
    BoardEvent,
)


def _denied_write_counts(extra_models=None):
    models = _DENIED_WRITE_COUNT_MODELS + tuple(extra_models or ())
    return {m.__name__: m.objects.count() for m in models}


def _denied_write_target_snapshot(target):
    """Return a comparable snapshot of *target*'s persisted fields.

    Returns the sentinel string ``"<deleted>"`` if the row no longer exists,
    so a denied delete that actually ran is caught as a mutation rather than
    raising ``DoesNotExist`` out of the helper.

    Limitation: ``model_to_dict()`` skips non-editable fields, so a denied
    write that silently re-saved the row touching only a non-editable field
    (e.g. an ``auto_now=True`` ``updated_at`` with no other change, and no
    row-count change) would not be caught here or by the count check.
    """
    if target is None:
        return None
    model_cls = type(target)
    try:
        fresh = model_cls.objects.get(pk=target.pk)
    except model_cls.DoesNotExist:
        return "<deleted>"
    return model_to_dict(fresh)


@contextmanager
def assert_denied_write_noop(testcase, *, target=None, extra_models=None):
    """Assert that a denied (expected-403) write request changed nothing.

    Wrap only the client call that is expected to be denied::

        with assert_denied_write_noop(self, target=self.card):
            resp = self.client.patch(url, {"title": "Changed"})
        self.assertEqual(resp.status_code, status.HTTP_403_FORBIDDEN)

    On exit this asserts:

    * Card / CardComment / CardAttachment / CardChecklist / CardMovement /
      CardActivity / BoardEvent row counts are unchanged, plus any
      ``extra_models`` (e.g. ``(Column,)``, ``(Swimlane,)``, ``(Board,)``,
      ``(BoardMembership,)``) relevant to a non-card endpoint.
    * *target*'s persisted fields (if given) are unchanged — including the
      case where it was deleted outright.
    * ``boards.broadcast.broadcast_board_event`` was never invoked — even
      after any queued ``transaction.on_commit`` callbacks are flushed, so a
      view that defers its broadcast cannot slip past a bare
      ``assert_not_called()`` taken before the callbacks ever ran.

    ``testcase`` must be a ``django.test.TestCase`` (this uses its
    ``captureOnCommitCallbacks``). The caller is still responsible for
    asserting the response status itself — this only proves the request was
    a true no-op.
    """
    counts_before = _denied_write_counts(extra_models)
    target_before = _denied_write_target_snapshot(target)

    with patch(PATCH_BROADCAST) as mock_broadcast:
        with testcase.captureOnCommitCallbacks(execute=True):
            yield mock_broadcast
        mock_broadcast.assert_not_called()

    testcase.assertEqual(
        _denied_write_counts(extra_models),
        counts_before,
        "Denied write changed a persisted row count "
        "(see assert_denied_write_noop in boards/tests/conftest.py)",
    )
    if target is not None:
        testcase.assertEqual(
            _denied_write_target_snapshot(target),
            target_before,
            f"Denied write mutated {type(target).__name__} pk={getattr(target, 'pk', None)}",
        )


# ---------------------------------------------------------------------------
# pytest fixture wrappers (injectable into pytest-style tests)
# ---------------------------------------------------------------------------


if _PYTEST_AVAILABLE:
    @pytest.fixture
    def make_user(db):
        """pytest fixture: factory that creates a User."""
        return _make_user

    @pytest.fixture
    def make_board(db):
        """pytest fixture: factory that creates a Board with its owner as ADMIN."""
        return _make_board

    @pytest.fixture
    def make_column(db):
        """pytest fixture: factory that creates a Column."""
        return _make_column

    @pytest.fixture
    def make_swimlane(db):
        """pytest fixture: factory that creates a Swimlane."""
        return _make_swimlane

    @pytest.fixture
    def make_card(db):
        """pytest fixture: factory that creates a Card."""
        return _make_card

    @pytest.fixture
    def make_membership(db):
        """pytest fixture: factory that adds a user to a board at a given role."""
        return _make_membership
