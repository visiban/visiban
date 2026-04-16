"""Tests verifying that composite indexes on CardActivity and CardComment exist (#496).

We check that the expected index names appear in the model Meta.indexes list so
that any accidental removal is caught by the test suite rather than silently
regressing query performance.
"""
from django.test import TestCase

from boards.models import CardActivity, CardComment


class CompositeIndexPresenceTests(TestCase):
    """The composite indexes introduced in migration 0045 must be declared in Meta."""

    def _index_names(self, model):
        return {idx.name for idx in model._meta.indexes}

    def test_cardactivity_composite_index_exists(self):
        """CardActivity.Meta.indexes must include activity_card_created_idx."""
        self.assertIn("activity_card_created_idx", self._index_names(CardActivity))

    def test_cardcomment_composite_index_exists(self):
        """CardComment.Meta.indexes must include comment_card_created_idx."""
        self.assertIn("comment_card_created_idx", self._index_names(CardComment))

    def test_cardactivity_index_covers_card_and_created_at(self):
        """The CardActivity composite index must cover the card FK and created_at (descending)."""
        idx = next(
            (i for i in CardActivity._meta.indexes if i.name == "activity_card_created_idx"),
            None,
        )
        self.assertIsNotNone(idx, "activity_card_created_idx not found in CardActivity._meta.indexes")
        self.assertEqual(list(idx.fields), ["card", "-created_at"])

    def test_cardcomment_index_covers_card_and_created_at(self):
        """The CardComment composite index must cover the card FK and created_at (ascending)."""
        idx = next(
            (i for i in CardComment._meta.indexes if i.name == "comment_card_created_idx"),
            None,
        )
        self.assertIsNotNone(idx, "comment_card_created_idx not found in CardComment._meta.indexes")
        self.assertEqual(list(idx.fields), ["card", "created_at"])
