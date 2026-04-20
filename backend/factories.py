"""Project-wide factory_boy factories for test data creation.

Use these in tests instead of hand-rolling ORM calls in setUp():

    from factories import BoardFactory, CardFactory

    board = BoardFactory()           # owner auto-created, admin membership added
    col   = ColumnFactory(board=board)
    swim  = SwimlaneFactory(board=board)
    card  = CardFactory(column=col, swimlane=swim)

All factories use factory.Sequence() for unique names so tests that run
concurrently or in isolation never collide on unique constraints.

The existing conftest._make_* helpers in boards/tests/conftest.py remain
available for TestCase-based tests that predate this file.  Migrate
incrementally; both patterns can coexist.
"""

import factory
from factory.django import DjangoModelFactory

from django.contrib.auth import get_user_model

from boards.models import Board, BoardMembership, Column, Swimlane, Card, Label
from groups.models import Group, GroupMembership

User = get_user_model()


class UserFactory(DjangoModelFactory):
    class Meta:
        model = User

    username = factory.Sequence(lambda n: f"user{n}")
    email = factory.LazyAttribute(lambda o: f"{o.username}@example.com")
    password = factory.PostGenerationMethodCall("set_password", "testpass123")


class GroupFactory(DjangoModelFactory):
    class Meta:
        model = Group

    name = factory.Sequence(lambda n: f"Group {n}")
    owner = factory.SubFactory(UserFactory)

    @factory.post_generation
    def _add_owner_membership(obj, create, extracted, **kwargs):
        if not create:
            return
        GroupMembership.objects.get_or_create(
            group=obj,
            user=obj.owner,
            defaults={"role": GroupMembership.Role.ADMIN},
        )


class BoardFactory(DjangoModelFactory):
    class Meta:
        model = Board

    name = factory.Sequence(lambda n: f"Board {n}")
    owner = factory.SubFactory(UserFactory)

    @factory.post_generation
    def _add_owner_membership(obj, create, extracted, **kwargs):
        # Mirror the invariant in conftest._make_board: the owner is always ADMIN.
        if not create:
            return
        BoardMembership.objects.get_or_create(
            board=obj,
            user=obj.owner,
            defaults={"role": BoardMembership.Role.ADMIN},
        )


class BoardMembershipFactory(DjangoModelFactory):
    class Meta:
        model = BoardMembership

    board = factory.SubFactory(BoardFactory)
    user = factory.SubFactory(UserFactory)
    role = BoardMembership.Role.MEMBER


class ColumnFactory(DjangoModelFactory):
    class Meta:
        model = Column

    board = factory.SubFactory(BoardFactory)
    name = factory.Sequence(lambda n: f"Column {n}")
    position = factory.Sequence(lambda n: n)
    allow_card_creation = True


class SwimlaneFactory(DjangoModelFactory):
    class Meta:
        model = Swimlane

    board = factory.SubFactory(BoardFactory)
    name = factory.Sequence(lambda n: f"Swimlane {n}")
    position = factory.Sequence(lambda n: n)


class LabelFactory(DjangoModelFactory):
    class Meta:
        model = Label

    board = factory.SubFactory(BoardFactory)
    name = factory.Sequence(lambda n: f"Label {n}")
    color = "#EAB308"


class CardFactory(DjangoModelFactory):
    class Meta:
        model = Card

    # column is the primary anchor; board and swimlane are derived from it so
    # all three always belong to the same board without extra caller ceremony.
    column = factory.SubFactory(ColumnFactory)
    board = factory.SelfAttribute("column.board")
    swimlane = factory.LazyAttribute(lambda o: SwimlaneFactory(board=o.board))
    title = factory.Sequence(lambda n: f"Card {n}")
    created_by = factory.LazyAttribute(lambda o: o.board.owner)
    position = factory.Sequence(lambda n: n)
