"""The aged and linked load-test fixtures (#2430, #2424).

Seeds one ``--scale 2`` fixture for the whole class (about ten seconds): the
smallest scale that takes the load-test path.
"""
import datetime
from io import StringIO

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from rest_framework.test import APIClient

from boards.management.commands._load_test_fixtures import (
    GENERATION_SPACING_DAYS,
    LINKED_CHILD_CARDS,
    LINKED_PARENT_BOARDS,
    LOAD_TEST_AGED_BOARD_NAME,
    LOAD_TEST_ANALYTICS_USERNAME,
    LOAD_TEST_LINKED_BOARD_NAME,
    LOAD_TEST_PARENT_BOARD_PREFIX,
)
from boards.models import Board, BoardMembership, Card, CardMovement, CardParentLink
from boards.services.card_links import CHILDREN_PER_PARENT_LIMIT, link_allowed

GENERATIONS = 2


class LoadTestFixtureTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command(
            "seed_demo_data", "--force", "--scale", "2",
            "--aged-generations", str(GENERATIONS), "--linked-boards",
            stdout=StringIO(),
        )
        cls.aged = Board.objects.get(name=LOAD_TEST_AGED_BOARD_NAME)
        cls.linked = Board.objects.get(name=LOAD_TEST_LINKED_BOARD_NAME)
        cls.user = get_user_model().objects.get(username=LOAD_TEST_ANALYTICS_USERNAME)

    # -- aged board ---------------------------------------------------------

    def test_aged_board_has_each_generation_archived(self):
        active = Card.objects.filter(board=self.aged, archived_at__isnull=True).count()
        archived = Card.objects.filter(board=self.aged, archived_at__isnull=False).count()
        self.assertGreater(active, 0)
        self.assertEqual(archived, active * GENERATIONS)

    def test_generations_are_spaced_and_copy_movements_before_their_archive_date(self):
        archived_dates = sorted(
            set(Card.objects.filter(board=self.aged, archived_at__isnull=False)
                .values_list("archived_at", flat=True))
        )
        self.assertEqual(len(archived_dates), GENERATIONS)
        self.assertEqual(
            (archived_dates[1] - archived_dates[0]).days, GENERATION_SPACING_DAYS
        )
        # A copy's history ends before it was archived: otherwise the replay would see a
        # card moving after it left the board, which no real archived card does.
        late = CardMovement.objects.filter(
            board=self.aged, card__archived_at__isnull=False,
            moved_at__gt=archived_dates[-1],
        ).count()
        self.assertEqual(late, 0)

    def test_copies_keep_their_movements_and_get_their_own_uid(self):
        archived = Card.objects.filter(board=self.aged, archived_at__isnull=False)
        self.assertEqual(archived.values("uid").distinct().count(), archived.count())
        with_history = archived.filter(movements__isnull=False).distinct().count()
        self.assertGreater(with_history, 0)
        for mv in CardMovement.objects.filter(card__in=archived[:20]):
            self.assertEqual(mv.card_uid, mv.card.uid)

    def test_copies_are_the_live_cards_shifted_back_one_spacing_per_generation(self):
        """Generation g's copy of live card i has created_at/updated_at (and movements) g spacings earlier.

        bulk_create stamps auto_now_add/auto_now with "now"; the bulk_update that writes the
        shifted values back is what makes the history old, so this is the line that matters.
        """
        live = list(Card.objects.filter(board=self.aged, archived_at__isnull=True).order_by("id"))
        generations = sorted(
            set(Card.objects.filter(board=self.aged, archived_at__isnull=False)
                .values_list("archived_at", flat=True)),
            reverse=True,  # generation 1 is archived most recently
        )
        self.assertEqual(len(generations), GENERATIONS)
        for gen, archived_at in enumerate(generations, start=1):
            shift = datetime.timedelta(days=GENERATION_SPACING_DAYS * gen)
            copies = list(Card.objects.filter(board=self.aged, archived_at=archived_at).order_by("id"))
            self.assertEqual(len(copies), len(live))
            for src, copy in zip(live, copies):
                self.assertEqual(copy.created_at, src.created_at - shift)
                self.assertEqual(copy.updated_at, src.updated_at - shift)
            src_moves = sorted(
                CardMovement.objects.filter(card__in=live).values_list("moved_at", flat=True)
            )
            copy_moves = sorted(
                CardMovement.objects.filter(card__in=copies).values_list("moved_at", flat=True)
            )
            self.assertEqual([m - shift for m in src_moves], copy_moves)

    def test_copying_never_shifts_the_live_cards_history(self):
        """The live half is the unmodified seed: another copy pass must leave it byte for byte alone."""
        from boards.management.commands._load_test_fixtures import copy_archived_generations

        def snapshot():
            return (
                list(Card.objects.filter(board=self.aged, archived_at__isnull=True)
                     .order_by("id").values_list("id", "created_at", "updated_at")),
                list(CardMovement.objects.filter(board=self.aged, card__archived_at__isnull=True)
                     .order_by("id").values_list("id", "moved_at")),
            )

        before = snapshot()
        self.assertTrue(before[0] and before[1])
        copy_archived_generations(self.aged, 1, datetime.datetime(2020, 1, 1, tzinfo=datetime.timezone.utc))
        self.assertEqual(snapshot(), before)

    def test_fixture_boards_are_invisible_to_every_demo_user(self):
        """card_search as demo2/demo3 filters on accessible board ids; their sets must not grow."""
        fixture_ids = Board.objects.filter(
            name__in=(LOAD_TEST_AGED_BOARD_NAME, LOAD_TEST_LINKED_BOARD_NAME)
        ).values_list("pk", flat=True) | Board.objects.filter(
            name__startswith=LOAD_TEST_PARENT_BOARD_PREFIX
        ).values_list("pk", flat=True)
        members = set(
            BoardMembership.objects.filter(board_id__in=list(fixture_ids))
            .values_list("user__username", flat=True)
        )
        self.assertEqual(members, {LOAD_TEST_ANALYTICS_USERNAME})
        self.assertFalse(
            Board.objects.filter(pk__in=list(fixture_ids)).exclude(owner=self.user).exists()
        )

    # -- linked boards ------------------------------------------------------

    def test_every_child_is_linked_across_five_parent_boards(self):
        links = CardParentLink.objects.filter(child__board=self.linked)
        self.assertEqual(links.count(), LINKED_CHILD_CARDS)
        self.assertEqual(Card.objects.filter(board=self.linked).count(), LINKED_CHILD_CARDS)
        parent_boards = set(links.values_list("parent__board_id", flat=True))
        self.assertEqual(len(parent_boards), LINKED_PARENT_BOARDS)

    def test_links_respect_the_two_tier_rule_and_the_per_parent_cap(self):
        for pb in Board.objects.filter(name__startswith=LOAD_TEST_PARENT_BOARD_PREFIX):
            self.assertTrue(pb.cards_can_have_children)
            self.assertTrue(link_allowed(pb, self.linked))
        self.assertFalse(self.linked.cards_can_have_children)
        per_parent = {}
        for parent_id in CardParentLink.objects.values_list("parent_id", flat=True):
            per_parent[parent_id] = per_parent.get(parent_id, 0) + 1
        self.assertLessEqual(max(per_parent.values()), CHILDREN_PER_PARENT_LIMIT)

    def test_full_serves_the_parent_on_linked_cards(self):
        client = APIClient()
        client.force_authenticate(self.user)
        resp = client.get(f"/api/v1/boards/{self.linked.pk}/full/")
        self.assertEqual(resp.status_code, 200)
        cards = resp.json()["cards"]
        self.assertEqual(len(cards), LINKED_CHILD_CARDS)
        self.assertTrue(all(c.get("parent") for c in cards))

    # -- guards -------------------------------------------------------------

    def test_wipe_removes_every_fixture_board(self):
        call_command(
            "seed_demo_data", "--force", "--wipe", "--scale", "2", stdout=StringIO(),
        )
        self.assertFalse(
            Board.objects.filter(
                name__in=(LOAD_TEST_AGED_BOARD_NAME, LOAD_TEST_LINKED_BOARD_NAME)
            ).exists()
        )
        self.assertFalse(Board.objects.filter(name__startswith=LOAD_TEST_PARENT_BOARD_PREFIX).exists())


class LoadTestFixtureArgumentTests(TestCase):
    def test_aged_and_linked_require_a_scaled_fixture(self):
        for extra in (["--aged-generations", "1"], ["--linked-boards"]):
            with self.assertRaises(CommandError):
                call_command("seed_demo_data", "--force", *extra, stdout=StringIO())

    def test_negative_generations_rejected(self):
        with self.assertRaises(CommandError):
            call_command(
                "seed_demo_data", "--force", "--scale", "2", "--aged-generations", "-1",
                stdout=StringIO(),
            )

    def test_zero_generations_seeds_no_aged_board(self):
        call_command(
            "seed_demo_data", "--force", "--scale", "2", "--aged-generations", "0",
            stdout=StringIO(),
        )
        self.assertFalse(Board.objects.filter(name=LOAD_TEST_AGED_BOARD_NAME).exists())
