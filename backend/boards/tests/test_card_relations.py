"""Typed card-to-card relations — CRUD, directionality, RBAC, IDOR, broadcast (#449).

Grouped by the thing that can break:

* ``CardRelationCrudTests`` — the happy paths, and the bidirectional display
  that is the whole point of storing one canonical direction.
* ``CardRelationValidationTests`` — every invariant that is not a database
  constraint: self-relations, duplicates, mutual blocks, symmetric
  normalization.
* ``CardRelationRbacTests`` — who may link and unlink.
* ``CardRelationIdorTests`` — cross-board targets. A relation names two cards by
  PK, and checking only the one in the URL would leak the existence and title
  of a card on a board the caller is not a member of. These are security
  requirements, not quality checks.
* ``CardRelationBlockerCountTests`` — the card-face scalar, including the
  archived-blocker rule and the `relates_to` exclusion.
* ``CardRelationCascadeTests`` — what happens to a relation when a card dies.
* ``CardRelationBroadcastTests`` — both ends broadcast, and only after commit.
* ``CardRelationExposureTests`` — what the public share-link payload does and
  does not carry.
* ``CardRelationQueryCountTests`` — the N+1 guard the issue names as an
  explicit acceptance criterion.
"""

import json
from unittest.mock import patch

from django.db import connection, transaction
from django.db.utils import IntegrityError
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from boards.models import Card, CardRelation
from boards.serializers import CardSerializer, PublicCardSerializer, _card_queryset
from boards.tests.conftest import (
    _make_board, _make_card, _make_column, _make_membership, _make_swimlane,
    _make_user,
)

T = CardRelation.Type


class _RelationTestBase(TestCase):
    """A board with three cards and an authenticated admin client."""

    def setUp(self):
        self.owner = _make_user("rel_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board)
        self.lane = _make_swimlane(self.board)
        self.card_a = _make_card(self.col, self.lane, title="Card A")
        self.card_b = _make_card(self.col, self.lane, title="Card B", position=1)
        self.card_c = _make_card(self.col, self.lane, title="Card C", position=2)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        # Suppress the channel layer; broadcast wiring has its own test class.
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()
        self.addCleanup(self._broadcast_patcher.stop)

    def _url(self, card, relation_id=None):
        base = f"/api/v1/boards/{self.board.id}/cards/{card.id}/relations/"
        return base if relation_id is None else f"{base}{relation_id}/"

    def _link(self, from_card, to_card, direction="blocks", client=None):
        """POST a relation from ``from_card``'s point of view.

        ``direction`` is what the API takes — "blocks", "blocked_by" or
        "relates_to" — not the stored ``relation_type``.
        """
        return (client or self.client).post(
            self._url(from_card),
            {"to_card": to_card.id, "direction": direction},
            format="json",
        )

    def _codes(self, response):
        """The machine-checkable `code` slugs on a 400 body (#1115 shape)."""
        return response.data.get("code", [])


class CardRelationCrudTests(_RelationTestBase):
    def test_create_blocks_relation(self):
        r = self._link(self.card_a, self.card_b)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["relation_type"], "blocks")
        self.assertEqual(r.data["direction"], "blocks")
        self.assertEqual(r.data["card"]["id"], self.card_b.id)
        self.assertEqual(r.data["card"]["title"], "Card B")
        self.assertFalse(r.data["card"]["archived"])
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_relation_is_bidirectional_in_display(self):
        """One stored row must read forwards from A and backwards from B.

        This is the payoff for storing a single canonical direction: the
        inverse is derived, so it cannot drift out of sync with the forward
        reading.
        """
        self._link(self.card_a, self.card_b)

        from_a = self.client.get(self._url(self.card_a)).data
        self.assertEqual(len(from_a), 1)
        self.assertEqual(from_a[0]["direction"], "blocks")
        self.assertEqual(from_a[0]["card"]["id"], self.card_b.id)

        from_b = self.client.get(self._url(self.card_b)).data
        self.assertEqual(len(from_b), 1)
        self.assertEqual(from_b[0]["direction"], "blocked_by")
        self.assertEqual(from_b[0]["card"]["id"], self.card_a.id)
        # Same underlying row, so the same relation id from both ends.
        self.assertEqual(from_a[0]["id"], from_b[0]["id"])

    def test_delete_removes_relation_from_both_cards(self):
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        r = self.client.delete(self._url(self.card_a, relation_id))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(self.client.get(self._url(self.card_a)).data, [])
        self.assertEqual(self.client.get(self._url(self.card_b)).data, [])

    def test_delete_from_the_far_end(self):
        """A relation is unlinkable from either card — both display it."""
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        r = self.client.delete(self._url(self.card_b, relation_id))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_relates_to_reads_the_same_from_both_ends(self):
        self._link(self.card_a, self.card_b, "relates_to")
        from_a = self.client.get(self._url(self.card_a)).data
        from_b = self.client.get(self._url(self.card_b)).data
        self.assertEqual(from_a[0]["direction"], "relates_to")
        self.assertEqual(from_b[0]["direction"], "relates_to")
        self.assertEqual(from_a[0]["card"]["id"], self.card_b.id)
        self.assertEqual(from_b[0]["card"]["id"], self.card_a.id)

    def test_list_orders_blocked_by_before_blocks_before_relates_to(self):
        self._link(self.card_a, self.card_b, "relates_to")  # relates_to
        self._link(self.card_a, self.card_c, "blocks")      # a blocks c
        self._link(self.card_b, self.card_a, "blocks")      # a blocked by b
        directions = [r["direction"] for r in self.client.get(self._url(self.card_a)).data]
        self.assertEqual(directions, ["blocked_by", "blocks", "relates_to"])

    def test_empty_list_for_card_with_no_relations(self):
        self.assertEqual(self.client.get(self._url(self.card_a)).data, [])

    def test_blocked_by_inverts_the_stored_row(self):
        """"X blocks this card" must be expressible from this card's panel.

        The request names a direction; the serializer decides which card
        becomes `from_card`. Without this, the only way to record "A is blocked
        by B" would be to POST to B's endpoint.
        """
        r = self._link(self.card_a, self.card_b, "blocked_by")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(r.data["direction"], "blocked_by")
        self.assertEqual(r.data["card"]["id"], self.card_b.id)

        relation = CardRelation.objects.get()
        self.assertEqual(relation.from_card_id, self.card_b.id)
        self.assertEqual(relation.to_card_id, self.card_a.id)
        self.assertEqual(relation.relation_type, T.BLOCKS)

    def test_blocked_by_and_blocks_are_the_same_relation_from_two_ends(self):
        self._link(self.card_a, self.card_b, "blocked_by")
        from_b = self.client.get(self._url(self.card_b)).data
        self.assertEqual(from_b[0]["direction"], "blocks")
        self.assertEqual(from_b[0]["card"]["id"], self.card_a.id)

    def test_blocked_by_raises_this_cards_blocker_count(self):
        self._link(self.card_a, self.card_b, "blocked_by")
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        by_id = {c["id"]: c for c in r.data["cards"]}
        self.assertEqual(by_id[self.card_a.id]["blocker_count"], 1)
        self.assertEqual(by_id[self.card_b.id]["blocker_count"], 0)

    def test_blocked_by_duplicate_of_an_existing_blocks_is_rejected(self):
        """The same fact stated from the other end is still the same row."""
        self._link(self.card_a, self.card_b, "blocks")
        r = self._link(self.card_b, self.card_a, "blocked_by")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("relation_exists", self._codes(r))
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_relation_records_its_creator(self):
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        self.assertEqual(
            CardRelation.objects.get(pk=relation_id).created_by_id, self.owner.id
        )


class CardRelationValidationTests(_RelationTestBase):
    def test_self_relation_rejected_with_400(self):
        r = self._link(self.card_a, self.card_a)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("self_relation", self._codes(r))
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_self_relation_also_rejected_by_the_database(self):
        """The serializer is the 400; the check constraint is the backstop.

        Asserted separately because the constraint is the half that survives a
        future code path that forgets to go through the serializer.
        """
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                CardRelation.objects.create(
                    from_card=self.card_a, to_card=self.card_a,
                    relation_type=T.BLOCKS,
                )

    def test_duplicate_relation_rejected_with_400(self):
        self._link(self.card_a, self.card_b)
        r = self._link(self.card_a, self.card_b)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("relation_exists", self._codes(r))
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_unique_constraint_enforced_by_the_database(self):
        self._link(self.card_a, self.card_b)
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                CardRelation.objects.create(
                    from_card=self.card_a, to_card=self.card_b,
                    relation_type=T.BLOCKS,
                )

    def test_same_pair_may_hold_different_relation_types(self):
        """unique_together includes relation_type, so blocks + relates_to coexist."""
        self.assertEqual(self._link(self.card_a, self.card_b, "blocks").status_code, 201)
        self.assertEqual(
            self._link(self.card_a, self.card_b, "relates_to").status_code, 201
        )
        self.assertEqual(CardRelation.objects.count(), 2)

    def test_mutual_block_rejected_with_400(self):
        """A blocks B, then B blocks A — a contradiction the UI cannot render."""
        self._link(self.card_a, self.card_b)
        r = self._link(self.card_b, self.card_a)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("relation_cycle", self._codes(r))
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_longer_cycles_are_deliberately_allowed(self):
        """A→B→C→A is permitted — see CardRelation's docstring for why.

        Pinned as a test so the decision is visible rather than looking like an
        oversight, and so reversing it is a deliberate edit to this assertion.
        """
        self._link(self.card_a, self.card_b)
        self._link(self.card_b, self.card_c)
        r = self._link(self.card_c, self.card_a)
        self.assertEqual(r.status_code, status.HTTP_201_CREATED)
        self.assertEqual(CardRelation.objects.count(), 3)

    def test_relates_to_is_normalized_so_duplicates_from_either_end_collide(self):
        """The symmetric-type dedup: (A,B) and (B,A) must not both be stored."""
        first = self._link(self.card_a, self.card_b, "relates_to")
        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        second = self._link(self.card_b, self.card_a, "relates_to")
        self.assertEqual(second.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("relation_exists", self._codes(second))
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_relates_to_stored_with_lower_card_id_first(self):
        self._link(self.card_b, self.card_a, "relates_to")
        relation = CardRelation.objects.get()
        self.assertEqual(relation.from_card_id, min(self.card_a.id, self.card_b.id))
        self.assertEqual(relation.to_card_id, max(self.card_a.id, self.card_b.id))

    def test_unknown_relation_type_rejected(self):
        r = self.client.post(
            self._url(self.card_a),
            {"to_card": self.card_b.id, "direction": "duplicates"},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_archived_card_rejected_as_a_new_relation_target(self):
        self.card_b.archived_at = timezone.now()
        self.card_b.save(update_fields=["archived_at"])
        r = self._link(self.card_a, self.card_b)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("archived_card", self._codes(r))


class CardRelationRbacTests(_RelationTestBase):
    def _client_for(self, role):
        # Username left to the factory's auto-increment: two callers may ask for
        # the same role in one test (see the cross-user ownership test below),
        # and a role-derived username would collide on `unique_username_ci`.
        user = _make_user()
        _make_membership(self.board, user, role)
        client = APIClient()
        client.force_authenticate(user)
        return client

    def test_viewer_cannot_create_relation(self):
        r = self._link(self.card_a, self.card_b, client=self._client_for("viewer"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_viewer_cannot_delete_relation(self):
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        r = self._client_for("viewer").delete(self._url(self.card_a, relation_id))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_viewer_may_still_read_relations(self):
        self._link(self.card_a, self.card_b)
        r = self._client_for("viewer").get(self._url(self.card_a))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.data), 1)

    def test_collaborator_cannot_create(self):
        """One tier stricter than checklist items, deliberately.

        A checklist item annotates the card it is on; a relation changes how a
        *different* card reads for the whole board. Collaborators have
        read-only access to card state, and this is card state.
        """
        r = self._link(self.card_a, self.card_b, client=self._client_for("collaborator"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_collaborator_cannot_delete(self):
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        r = self._client_for("collaborator").delete(self._url(self.card_a, relation_id))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(CardRelation.objects.count(), 1)

    def test_collaborator_may_still_read_relations(self):
        self._link(self.card_a, self.card_b)
        r = self._client_for("collaborator").get(self._url(self.card_a))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.data), 1)

    def test_member_and_admin_may_create_and_delete(self):
        for role in ("member", "admin"):
            with self.subTest(role=role):
                CardRelation.objects.all().delete()
                client = self._client_for(role)
                created = self._link(self.card_a, self.card_b, client=client)
                self.assertEqual(created.status_code, status.HTTP_201_CREATED)
                removed = client.delete(self._url(self.card_a, created.data["id"]))
                self.assertEqual(removed.status_code, status.HTTP_204_NO_CONTENT)

    def test_site_admin_may_create_and_delete_without_membership(self):
        """Pins the SITE_ADMIN branch of the allow-list.

        A site admin has no BoardMembership row here; the role resolves through
        `can_access_all_content` in get_board_role(). Asserted rather than
        trusted, so a future reordering of that precedence ladder fails here.
        """
        site_admin = _make_user("rel_site_admin", can_access_all_content=True)
        client = APIClient()
        client.force_authenticate(site_admin)
        created = self._link(self.card_a, self.card_b, client=client)
        self.assertEqual(created.status_code, status.HTTP_201_CREATED)
        removed = client.delete(self._url(self.card_a, created.data["id"]))
        self.assertEqual(removed.status_code, status.HTTP_204_NO_CONTENT)

    def test_a_member_may_remove_a_relation_another_member_created(self):
        """Relations are shared board objects, not per-creator content.

        Deliberate: unlike checklist items there is no ownership gate. A member
        can already retitle, reassign and move both endpoint cards, so
        withholding "unlink them" would be an arbitrary line — and `created_by`
        names who drew the link, not who owns either card, so "your own
        relation" is not a coherent notion here. `created_by` is for
        attribution, not authorization.
        """
        author = self._client_for("member")
        relation_id = self._link(self.card_a, self.card_b, client=author).data["id"]
        other = self._client_for("member")
        r = other.delete(self._url(self.card_a, relation_id))
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_non_member_gets_403(self):
        outsider = _make_user("rel_outsider")
        client = APIClient()
        client.force_authenticate(outsider)
        r = self._link(self.card_a, self.card_b, client=client)
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_anonymous_gets_401_or_403(self):
        r = self._link(self.card_a, self.card_b, client=APIClient())
        self.assertIn(
            r.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
        )


class CardRelationIdorTests(_RelationTestBase):
    """Both ends of a relation must be verified, not just the one in the URL."""

    def setUp(self):
        super().setUp()
        self.other_owner = _make_user("rel_other_owner")
        self.other_board = _make_board(self.other_owner, name="Other Board")
        self.other_col = _make_column(self.other_board)
        self.other_lane = _make_swimlane(self.other_board)
        self.other_card = _make_card(
            self.other_col, self.other_lane, title="Secret Card",
        )

    def test_cannot_link_to_a_card_on_another_board(self):
        r = self._link(self.card_a, self.other_card)
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("cross_board", self._codes(r))
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_nonexistent_card_is_indistinguishable_from_a_cross_board_one(self):
        """Same code and same message either way, so a caller cannot probe for
        the existence of a card on a board they cannot see."""
        missing = self.client.post(
            self._url(self.card_a),
            {"to_card": 99_999_999, "direction": "blocks"},
            format="json",
        )
        cross = self._link(self.card_a, self.other_card)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(self._codes(missing), self._codes(cross))
        self.assertEqual(missing.data["detail"], cross.data["detail"])

    def test_cannot_link_from_the_far_board_inward(self):
        """`blocked_by` must not become a back door around the board scope."""
        r = self._link(self.card_a, self.other_card, "blocked_by")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_rejection_does_not_leak_the_other_card_title(self):
        r = self._link(self.card_a, self.other_card)
        self.assertNotIn("Secret Card", json.dumps(r.data))

    def test_cannot_operate_on_a_card_from_another_board(self):
        """The card in the URL is scoped to the board in the URL."""
        r = self.client.get(
            f"/api/v1/boards/{self.board.id}/cards/{self.other_card.id}/relations/"
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_cannot_delete_a_relation_that_does_not_touch_this_card(self):
        """A relation PK alone is not authorization to delete it."""
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        r = self.client.delete(self._url(self.card_c, relation_id))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(CardRelation.objects.count(), 1)


class CardRelationBlockerCountTests(_RelationTestBase):
    def _card_face(self, card):
        refetched = _card_queryset(Card.objects.filter(pk=card.pk)).get()
        return CardSerializer(refetched, context={"board": self.board}).data

    def test_blocker_count_zero_by_default(self):
        self.assertEqual(self._card_face(self.card_a)["blocker_count"], 0)

    def test_blocked_card_has_a_blocker(self):
        self._link(self.card_a, self.card_b)
        self.assertEqual(self._card_face(self.card_b)["blocker_count"], 1)

    def test_blocking_card_is_not_itself_blocked(self):
        """Only the `to_card` end counts — direction is the whole point."""
        self._link(self.card_a, self.card_b)
        self.assertEqual(self._card_face(self.card_a)["blocker_count"], 0)

    def test_relates_to_never_counts_as_a_blocker(self):
        self._link(self.card_a, self.card_b, "relates_to")
        self.assertEqual(self._card_face(self.card_b)["blocker_count"], 0)

    def test_multiple_blockers_counted(self):
        self._link(self.card_a, self.card_c)
        self._link(self.card_b, self.card_c)
        self.assertEqual(self._card_face(self.card_c)["blocker_count"], 2)

    def test_archived_blocker_does_not_count(self):
        """A card must not render as blocked by a card that is off the board."""
        self._link(self.card_a, self.card_b)
        self.card_a.archived_at = timezone.now()
        self.card_a.save(update_fields=["archived_at"])
        self.assertEqual(self._card_face(self.card_b)["blocker_count"], 0)

    def test_archived_blocker_is_still_listed_and_flagged(self):
        """Excluded from the count, but visible so it can be deleted."""
        self._link(self.card_a, self.card_b)
        self.card_a.archived_at = timezone.now()
        self.card_a.save(update_fields=["archived_at"])
        rows = self.client.get(self._url(self.card_b)).data
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["card"]["archived"])

    def test_cold_path_without_prefetch_agrees_with_the_prefetched_path(self):
        """The fallback in _blocker_count must not disagree with the fast path."""
        self._link(self.card_a, self.card_c)
        self._link(self.card_b, self.card_c)
        cold = CardSerializer(
            Card.objects.get(pk=self.card_c.pk), context={"board": self.board}
        ).data
        self.assertEqual(cold["blocker_count"], self._card_face(self.card_c)["blocker_count"])
        self.assertEqual(cold["blocker_count"], 2)

    def test_blocker_count_present_on_the_full_board_payload(self):
        self._link(self.card_a, self.card_b)
        r = self.client.get(f"/api/v1/boards/{self.board.id}/full/")
        by_id = {c["id"]: c for c in r.data["cards"]}
        self.assertEqual(by_id[self.card_b.id]["blocker_count"], 1)
        self.assertEqual(by_id[self.card_a.id]["blocker_count"], 0)

    def test_blocker_count_present_on_the_cross_board_card_query(self):
        self._link(self.card_a, self.card_b)
        r = self.client.get("/api/v1/cards/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("blocker_count", r.data["results"][0])


class CardRelationCascadeTests(_RelationTestBase):
    def test_deleting_the_blocking_card_removes_the_relation(self):
        self._link(self.card_a, self.card_b)
        self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/")
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_deleting_the_blocked_card_removes_the_relation(self):
        self._link(self.card_a, self.card_b)
        self.client.delete(f"/api/v1/boards/{self.board.id}/cards/{self.card_b.id}/")
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_deleting_the_board_removes_relations(self):
        self._link(self.card_a, self.card_b)
        self.board.delete()
        self.assertEqual(CardRelation.objects.count(), 0)

    def test_deleting_the_creator_keeps_the_relation(self):
        """created_by is SET_NULL — a departing user must not unlink cards."""
        creator = _make_user("rel_leaver")
        _make_membership(self.board, creator, "member")
        client = APIClient()
        client.force_authenticate(creator)
        self._link(self.card_a, self.card_b, client=client)
        creator.delete()
        relation = CardRelation.objects.get()
        self.assertIsNone(relation.created_by_id)


class CardRelationBroadcastTests(_RelationTestBase):
    """A relation change alters two cards, so it publishes two frames."""

    def setUp(self):
        super().setUp()
        # Replace the base-class patch with one we can assert against.
        self._broadcast_patcher.stop()
        self.broadcast = patch("boards.broadcast.broadcast_board_event").start()
        self.addCleanup(patch.stopall)

    def test_create_broadcasts_card_updated_for_both_ends(self):
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self.card_a, self.card_b)
        self.assertEqual(self.broadcast.call_count, 2)
        events = {c.args[1] for c in self.broadcast.call_args_list}
        self.assertEqual(events, {"card.updated"})
        card_ids = {c.args[2]["id"] for c in self.broadcast.call_args_list}
        self.assertEqual(card_ids, {self.card_a.id, self.card_b.id})

    def test_delete_broadcasts_card_updated_for_both_ends(self):
        relation_id = self._link(self.card_a, self.card_b).data["id"]
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(self._url(self.card_a, relation_id))
        self.assertEqual(self.broadcast.call_count, 2)
        card_ids = {c.args[2]["id"] for c in self.broadcast.call_args_list}
        self.assertEqual(card_ids, {self.card_a.id, self.card_b.id})

    def test_broadcast_payload_carries_the_updated_blocker_count(self):
        """The payload must be re-fetched after the write, not before it."""
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self.card_a, self.card_b)
        payloads = {c.args[2]["id"]: c.args[2] for c in self.broadcast.call_args_list}
        self.assertEqual(payloads[self.card_b.id]["blocker_count"], 1)
        self.assertEqual(payloads[self.card_a.id]["blocker_count"], 0)

    def test_broadcast_payload_is_a_complete_card(self):
        """A partial payload would wipe the card in every connected client."""
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self.card_a, self.card_b)
        payload = self.broadcast.call_args_list[0].args[2]
        for field in ("id", "uid", "title", "column", "swimlane", "priority", "version"):
            self.assertIn(field, payload)

    def test_rejected_relation_broadcasts_nothing(self):
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self.card_a, self.card_a)
        self.assertEqual(self.broadcast.call_count, 0)


class CardRelationPeerBroadcastTests(_RelationTestBase):
    """Archiving, restoring or deleting a blocker moves the OTHER card's count.

    That other card gets no frame from the archive/delete event itself — those
    carry only the acted-on card's uid — so without an explicit peer broadcast
    every connected client keeps rendering a blocked indicator for a blocker
    that is no longer on the board.
    """

    def setUp(self):
        super().setUp()
        self._broadcast_patcher.stop()
        self.broadcast = patch("boards.broadcast.broadcast_board_event").start()
        self.addCleanup(patch.stopall)
        # card_a blocks card_b.
        with self.captureOnCommitCallbacks(execute=True):
            self._link(self.card_a, self.card_b)
        self.broadcast.reset_mock()

    def _payload_for(self, card_id):
        for call in self.broadcast.call_args_list:
            if call.args[1] == "card.updated" and call.args[2].get("id") == card_id:
                return call.args[2]
        return None

    def test_archiving_the_blocker_tells_the_blocked_card(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/archive/"
            )
        payload = self._payload_for(self.card_b.id)
        self.assertIsNotNone(payload, "no card.updated for the blocked card")
        self.assertEqual(payload["blocker_count"], 0)

    def test_restoring_the_blocker_tells_the_blocked_card(self):
        self.client.post(f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/archive/")
        self.broadcast.reset_mock()
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/unarchive/"
            )
        payload = self._payload_for(self.card_b.id)
        self.assertIsNotNone(payload, "no card.updated for the re-blocked card")
        self.assertEqual(payload["blocker_count"], 1)

    def test_deleting_the_blocker_tells_the_blocked_card(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.delete(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/"
            )
        payload = self._payload_for(self.card_b.id)
        self.assertIsNotNone(payload, "no card.updated for the blocked card")
        self.assertEqual(payload["blocker_count"], 0)

    def test_archiving_an_unrelated_card_broadcasts_no_peer_updates(self):
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_c.id}/archive/"
            )
        updates = [c for c in self.broadcast.call_args_list if c.args[1] == "card.updated"]
        self.assertEqual(updates, [])

    def test_archiving_the_blocked_card_does_not_broadcast_for_its_blocker(self):
        """Direction matters: card_b blocks nothing, so nothing follows it."""
        with self.captureOnCommitCallbacks(execute=True):
            self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_b.id}/archive/"
            )
        self.assertIsNone(self._payload_for(self.card_a.id))


class CardRelationBroadcastCommitTests(TransactionTestCase):
    """The publish must be deferred until the transaction commits.

    ``TransactionTestCase`` because ``TestCase`` wraps each test in a
    transaction that never commits, so ``on_commit`` callbacks would not fire
    at all and this assertion would be vacuous.
    """

    def setUp(self):
        self.owner = _make_user("rel_commit_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board)
        self.lane = _make_swimlane(self.board)
        self.card_a = _make_card(self.col, self.lane, title="A")
        self.card_b = _make_card(self.col, self.lane, title="B", position=1)
        self.client = APIClient()
        self.client.force_authenticate(self.owner)

    def test_relation_rolled_back_by_a_failing_commit_broadcasts_nothing(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            with transaction.atomic():
                CardRelation.objects.create(
                    from_card=self.card_a, to_card=self.card_b,
                    relation_type=T.BLOCKS,
                )
                r = self.client.post(
                    f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/relations/",
                    {"to_card": self.card_b.id, "direction": "blocks"},
                    format="json",
                )
                # Duplicate of the row created above — rejected, nothing published.
                self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
                transaction.set_rollback(True)
        self.assertEqual(mock_broadcast.call_count, 0)

    def test_successful_relation_publishes_after_commit(self):
        with patch("boards.broadcast.broadcast_board_event") as mock_broadcast:
            r = self.client.post(
                f"/api/v1/boards/{self.board.id}/cards/{self.card_a.id}/relations/",
                {"to_card": self.card_b.id, "direction": "blocks"},
                format="json",
            )
            self.assertEqual(r.status_code, status.HTTP_201_CREATED)
            self.assertEqual(mock_broadcast.call_count, 2)
        CardRelation.objects.all().delete()
        Card.objects.all().delete()


class CardRelationExposureTests(_RelationTestBase):
    """What the anonymous share-link payload does and does not carry."""

    def setUp(self):
        super().setUp()
        self._link(self.card_a, self.card_b)
        r = self.client.post(f"/api/v1/boards/{self.board.id}/share/")
        self.token = r.data["share_token"]
        self.anon = APIClient()

    def test_public_card_serializer_exposes_blocker_count(self):
        self.assertIn("blocker_count", PublicCardSerializer().fields)

    def test_public_card_serializer_does_not_expose_relations(self):
        """The relation rows carry created_by/created_at — actor metadata that
        #926's whitelist deliberately keeps off the anonymous payload."""
        fields = PublicCardSerializer().fields
        self.assertNotIn("relations", fields)
        self.assertNotIn("outgoing_relations", fields)
        self.assertNotIn("incoming_relations", fields)

    def test_public_board_payload_carries_the_blocked_signal(self):
        r = self.anon.get(f"/api/share/{self.token}/")
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        by_uid = {c["uid"]: c for c in r.data["cards"]}
        self.assertEqual(by_uid[self.card_b.uid]["blocker_count"], 1)
        self.assertEqual(by_uid[self.card_a.uid]["blocker_count"], 0)

    def test_public_board_payload_leaks_no_relation_metadata(self):
        r = self.anon.get(f"/api/share/{self.token}/")
        body = json.dumps(r.data)
        self.assertNotIn("created_by", body)
        self.assertNotIn("relation_type", body)

    def test_relations_endpoint_is_not_reachable_anonymously(self):
        r = self.anon.get(self._url(self.card_a))
        self.assertIn(
            r.status_code, (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
        )


class CardRelationPeerBroadcastQueryCountTests(_RelationTestBase):
    """Archiving a card that blocks many others must cost ONE query per peer.

    Every peer needs its own `card.updated` frame, and each frame is one
    `BoardEvent` row — that INSERT is irreducible, and it is what the #1114
    resumable cursor reads. What is *not* irreducible is the rendering: one
    `_card_queryset` pass per peer would be roughly seven queries each. They
    are rendered in a single batched pass instead, so the marginal cost of a
    peer is exactly the one INSERT. This test is what stops that regressing
    back to a per-peer render.
    """

    def _archive_query_count(self, card):
        url = f"/api/v1/boards/{self.board.id}/cards/{card.id}/archive/"
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.post(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return len(ctx)

    def test_archive_cost_is_flat_in_the_number_of_blocked_cards(self):
        # Blocker with one blocked card.
        one_target = _make_card(self.col, self.lane, title="blocks one", position=10)
        blocked = _make_card(self.col, self.lane, title="blocked", position=11)
        CardRelation.objects.create(
            from_card=one_target, to_card=blocked, relation_type=T.BLOCKS,
        )
        few = self._archive_query_count(one_target)

        # Blocker with eight blocked cards.
        many_target = _make_card(self.col, self.lane, title="blocks many", position=20)
        for i in range(8):
            other = _make_card(self.col, self.lane, title=f"b{i}", position=30 + i)
            CardRelation.objects.create(
                from_card=many_target, to_card=other, relation_type=T.BLOCKS,
            )
        many = self._archive_query_count(many_target)

        # Seven more peers may cost seven more feed-row INSERTs and nothing
        # else. A per-peer render would make this roughly seven times larger.
        self.assertEqual(
            many - few, 7,
            f"archiving cost {few} queries with 1 blocked card and {many} with 8 "
            f"— {many - few} extra for 7 extra peers, expected 7. The peer "
            "broadcast is rendering one card at a time again.",
        )


class CardRelationQueryCountTests(TestCase):
    """No N+1 on /full/ with relations — an explicit acceptance criterion.

    The budget assertions live in ``test_query_counts.py``; what is pinned here
    is the property that matters, measured rather than read off the code: the
    query count must not move when relations are added.
    """

    def setUp(self):
        self.owner = _make_user("rel_qc_owner")
        self.board = _make_board(self.owner)
        self.col = _make_column(self.board)
        self.lane = _make_swimlane(self.board)
        self.cards = [
            _make_card(self.col, self.lane, title=f"C{i}", position=i)
            for i in range(12)
        ]
        self.client = APIClient()
        self.client.force_authenticate(self.owner)
        self._broadcast_patcher = patch("boards.broadcast.broadcast_board_event")
        self._broadcast_patcher.start()
        self.addCleanup(self._broadcast_patcher.stop)

    def _full_query_count(self):
        url = f"/api/v1/boards/{self.board.id}/full/"
        self.client.get(url)  # warm any lazy caches
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        return len(ctx)

    def test_full_query_count_constant_as_relations_are_added(self):
        baseline = self._full_query_count()
        # Chain every card to the next: 11 relations across 12 cards.
        for earlier, later in zip(self.cards, self.cards[1:]):
            CardRelation.objects.create(
                from_card=earlier, to_card=later, relation_type=T.BLOCKS,
            )
        after = self._full_query_count()
        self.assertEqual(
            baseline, after,
            f"full/ query count grew from {baseline} to {after} when relations "
            "were added — blocker_count is issuing a per-card query.",
        )

    def test_full_adds_exactly_one_query_for_the_relations_prefetch(self):
        """The prefetch is one query for the page, not one per card."""
        for earlier, later in zip(self.cards, self.cards[1:]):
            CardRelation.objects.create(
                from_card=earlier, to_card=later, relation_type=T.BLOCKS,
            )
        url = f"/api/v1/boards/{self.board.id}/full/"
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            self.client.get(url)
        relation_queries = [
            q for q in ctx.captured_queries if "card_relations" in q["sql"]
        ]
        self.assertEqual(
            len(relation_queries), 1,
            f"expected exactly 1 card_relations query, got {len(relation_queries)}",
        )

    def test_public_board_has_no_per_card_relation_query(self):
        for earlier, later in zip(self.cards, self.cards[1:]):
            CardRelation.objects.create(
                from_card=earlier, to_card=later, relation_type=T.BLOCKS,
            )
        token = self.client.post(
            f"/api/v1/boards/{self.board.id}/share/"
        ).data["share_token"]
        anon = APIClient()
        url = f"/api/share/{token}/"
        anon.get(url)
        with CaptureQueriesContext(connection) as ctx:
            anon.get(url)
        relation_queries = [
            q for q in ctx.captured_queries if "card_relations" in q["sql"]
        ]
        self.assertEqual(len(relation_queries), 1)
