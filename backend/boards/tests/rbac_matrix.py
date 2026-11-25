"""Shared machinery for the generated role x endpoint matrix (#1573).

``test_rbac_matrix_1573.py`` owns the expected-outcome table; this module owns
the parts that must not drift from it:

* ``enumerate_write_routes()`` reads every POST/PUT/PATCH/DELETE operation from
  the generated OpenAPI schema, so a new route appears here without anyone
  editing a list;
* ``PRINCIPALS`` and ``POLICIES`` name the seven principals and which of them a
  policy admits;
* ``MatrixWorld`` builds one board with a fixture object for each path
  parameter the matrix can resolve.
"""

import re

from django.db import transaction

from accounts.models import User
from boards.models import (
    Board,
    BoardInviteLink,
    BoardMembership,
    Card,
    CardChecklist,
    CardComment,
    Column,
    CustomFieldDefinition,
    CustomFieldSet,
    Label,
    SavedFilter,
    Swimlane,
)

WRITE_METHODS = ("POST", "PUT", "PATCH", "DELETE")

NON_MEMBER = "non_member"
VIEWER = "viewer"
COLLABORATOR = "collaborator"
MEMBER = "member"
BOARD_ADMIN = "board_admin"
SITE_ADMIN = "site_admin"
ALL_CONTENT = "all_content"

PRINCIPALS = (NON_MEMBER, VIEWER, COLLABORATOR, MEMBER, BOARD_ADMIN, SITE_ADMIN, ALL_CONTENT)

# A principal with the instance-wide content flag acts as SITE_ADMIN on every
# board (boards.permissions.get_board_role), so each policy lists them together.
_CONTENT = (SITE_ADMIN, ALL_CONTENT)

# Which principals a policy admits. "Admits" means the permission layer lets the
# request through to validation; the request body is empty, so an admitted
# principal usually sees a 400 or 404 from the handler, never a 403.
POLICIES = {
    "admin": frozenset((BOARD_ADMIN, *_CONTENT)),
    "mutate": frozenset((MEMBER, BOARD_ADMIN, *_CONTENT)),
    "annotate": frozenset((COLLABORATOR, MEMBER, BOARD_ADMIN, *_CONTENT)),
    "any_member": frozenset((VIEWER, COLLABORATOR, MEMBER, BOARD_ADMIN, *_CONTENT)),
    "authenticated": frozenset(PRINCIPALS),
}

SKIP_PREFIX = "skip:"

_PARAM = re.compile(r"\{(\w+)\}")


def enumerate_write_routes():
    """Return sorted ``(METHOD, path_template)`` pairs for every write operation.

    Scoped to board-scoped routes: anything under ``/api/v1/boards/``. Group
    routes are covered by ``groups/tests`` and listed in the module docstring of
    ``test_rbac_matrix_1573.py`` as the remaining slice.
    """
    from drf_spectacular.generators import SchemaGenerator

    schema = SchemaGenerator().get_schema(request=None, public=True)
    routes = set()
    for path, item in schema["paths"].items():
        if not path.startswith("/api/v1/boards/"):
            continue
        for method in item:
            if method.upper() in WRITE_METHODS:
                routes.add((method.upper(), path))
    return sorted(routes)


def route_params(path):
    """Return ``[(param_name, preceding_segment)]`` for each ``{param}`` in *path*."""
    segments = path.strip("/").split("/")
    found = []
    for index, segment in enumerate(segments):
        match = _PARAM.fullmatch(segment)
        if match:
            found.append((match.group(1), segments[index - 1] if index else ""))
    return found


class MatrixWorld:
    """One board, seven principals, and a fixture row per resolvable path param."""

    # The segment before a path parameter names the resource it addresses.
    RESOURCE_BY_SEGMENT = {
        "boards": "board",
        "cards": "card",
        "columns": "column",
        "swimlanes": "swimlane",
        "labels": "label",
        "field-sets": "field_set",
        "comments": "comment",
        "checklist": "checklist_item",
        "saved-filters": "saved_filter",
        "invite-links": "invite_link",
        "members": "member_user",
        "dimension-plans": "dimension_field",
    }

    def __init__(self):
        self.owner = User.objects.create_user(username="mx-owner", password="pass")
        self.board = Board.objects.create(name="Matrix board", owner=self.owner)
        BoardMembership.objects.create(
            board=self.board, user=self.owner, role=BoardMembership.Role.ADMIN
        )
        self.column = Column.objects.create(
            board=self.board, name="Todo", position=0, allow_card_creation=True
        )
        self.column2 = Column.objects.create(board=self.board, name="Done", position=1)
        self.swimlane = Swimlane.objects.create(board=self.board, name="Lane", position=0)
        self.label = Label.objects.create(board=self.board, name="bug", color="#112233")
        self.field_set = CustomFieldSet.objects.create(board=self.board, name="Set", position=0)
        self.dimension_field = CustomFieldDefinition.objects.create(
            board=self.board, name="Track", field_type="text", position=0, is_dimension=True,
        )
        self.card = Card.objects.create(
            board=self.board, column=self.column, swimlane=self.swimlane,
            title="Fixture card", created_by=self.owner, position=0,
        )
        self.comment = CardComment.objects.create(card=self.card, author=self.owner, body="hi")
        self.checklist_item = CardChecklist.objects.create(
            card=self.card, text="item", position=0, created_by=self.owner
        )
        self.saved_filter = SavedFilter.objects.create(
            board=self.board, user=self.owner, name="mine", state_json={},
        )
        self.invite_link = BoardInviteLink.objects.create(
            board=self.board, role=BoardMembership.Role.VIEWER, created_by=self.owner,
            token_hash="a" * 64, prefix="aaaaaaaa",
        )
        self.users = {}
        for name in PRINCIPALS:
            self.users[name] = self._make_principal(name)

    def _make_principal(self, name):
        flags = {
            SITE_ADMIN: {"is_site_admin": True, "can_access_all_content": True},
            ALL_CONTENT: {"can_access_all_content": True},
        }.get(name, {})
        user = User.objects.create_user(username=f"mx-{name}", password="pass", **flags)
        if name in (VIEWER, COLLABORATOR, MEMBER, BOARD_ADMIN):
            BoardMembership.objects.create(
                board=self.board, user=user,
                role={
                    VIEWER: BoardMembership.Role.VIEWER,
                    COLLABORATOR: BoardMembership.Role.COLLABORATOR,
                    MEMBER: BoardMembership.Role.MEMBER,
                    BOARD_ADMIN: BoardMembership.Role.ADMIN,
                }[name],
            )
        return user

    def fixture_for(self, resource):
        return {
            "board": self.board.pk,
            "card": self.card.pk,
            "column": self.column.pk,
            "swimlane": self.swimlane.pk,
            "label": self.label.pk,
            "field_set": self.field_set.pk,
            "comment": self.comment.pk,
            "checklist_item": self.checklist_item.pk,
            "saved_filter": self.saved_filter.pk,
            "invite_link": self.invite_link.pk,
            "member_user": self.owner.pk,
            "dimension_field": self.dimension_field.pk,
        }.get(resource)

    def resolve_url(self, path):
        """Fill *path*'s parameters with fixture ids; ``None`` when one has no fixture."""
        url = path
        for name, segment in route_params(path):
            if name == "board_pk":
                value = self.board.pk
            else:
                value = self.fixture_for(self.RESOURCE_BY_SEGMENT.get(segment))
            if value is None:
                return None
            url = url.replace("{%s}" % name, str(value), 1)
        return url


def assign_ownership(world, user):
    """Make *user* the author of the fixture card, comment, and checklist item.

    Members and collaborators may edit only content they created (ownership
    gate, covered by ``test_ownership_gating.py``). The matrix tests the *role*
    gate, so each request runs as the author of what it touches; otherwise every
    below-admin principal reads as denied on an edit route for the wrong reason.
    """
    Card.objects.filter(pk=world.card.pk).update(created_by=user)
    CardComment.objects.filter(pk=world.comment.pk).update(author=user)
    CardChecklist.objects.filter(pk=world.checklist_item.pk).update(created_by=user)


def run_rolled_back(callable_):
    """Run *callable_* in a savepoint that is always rolled back; return its value.

    Allowed principals reach real handlers (a DELETE with an empty body can
    succeed), so every request must leave the shared world untouched.
    """
    with transaction.atomic():
        try:
            return callable_()
        finally:
            transaction.set_rollback(True)
