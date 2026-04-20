"""Unit tests for Group.ancestors() — ancestor chain traversal with depth cap."""
from django.test import TestCase

from accounts.models import User
from groups.models import Group, GroupMembership


def _make_group(owner, name="G", parent=None):
    group = Group.objects.create(name=name, owner=owner, parent=parent)
    GroupMembership.objects.create(group=group, user=owner, role=GroupMembership.Role.ADMIN)
    return group


class GroupAncestorsTests(TestCase):
    def setUp(self):
        self.user = User.objects.create_user(username="u", password="pass")

    def test_root_group_returns_empty_list(self):
        root = _make_group(self.user, "Root")
        self.assertEqual(root.ancestors(), [])

    def test_depth_1_returns_direct_parent(self):
        root = _make_group(self.user, "Root")
        child = _make_group(self.user, "Child", parent=root)
        self.assertEqual(child.ancestors(), [root])

    def test_depth_3_returns_ordered_chain_nearest_first(self):
        root = _make_group(self.user, "Root")
        mid = _make_group(self.user, "Mid", parent=root)
        leaf = _make_group(self.user, "Leaf", parent=mid)
        # ancestors() walks from immediate parent toward root
        self.assertEqual(leaf.ancestors(), [mid, root])

    def test_traversal_capped_at_max_depth(self):
        # Build a chain of 8 groups: root → g1 → … → g7
        node = _make_group(self.user, "Root")
        for i in range(7):
            node = _make_group(self.user, f"G{i}", parent=node)
        # node is now 8 levels deep; ancestors() caps at 6 (_GROUP_TRAVERSAL_MAX_DEPTH)
        chain = node.ancestors()
        self.assertEqual(len(chain), 6)

    def test_traversal_cap_emits_warning(self):
        node = _make_group(self.user, "Root")
        for i in range(7):
            node = _make_group(self.user, f"D{i}", parent=node)
        with self.assertLogs("groups.models", level="WARNING") as cm:
            node.ancestors()
        self.assertTrue(any("capped" in line for line in cm.output))
