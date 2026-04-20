"""Shared fixtures and factory helpers for the boards test suite.

The module-level ``_make_*`` functions can be imported directly by TestCase-based
tests.  The ``pytest.fixture`` wrappers expose the same factories as injectable
fixtures for future pytest-style (non-TestCase) tests.

Migrate per-file ``_make_*`` helper functions to use these factories incrementally.
Files migrated so far: test_card_move, test_rbac, test_wip_enforcement (#557).
"""

try:
    import pytest
    _PYTEST_AVAILABLE = True
except ImportError:
    _PYTEST_AVAILABLE = False

from accounts.models import User
from boards.models import Board, BoardMembership, Column, Swimlane, Card

# ---------------------------------------------------------------------------
# Importable factory helpers (usable directly from TestCase setUp)
# ---------------------------------------------------------------------------

_user_counter = 0


def _make_user(username=None, password="pass", **kwargs):
    """Create and return a User.

    ``username`` defaults to a unique auto-generated name so tests that don't
    care about the username never collide.  Pass ``**kwargs`` for fields like
    ``notif_due_soon=True``.
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
