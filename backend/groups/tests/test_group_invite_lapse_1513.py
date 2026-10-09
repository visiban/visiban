"""Re-parenting a group and deleting a creator revoke stale invite links (#1513).

Neither path admits anyone (preview/join re-check the creator), but the links
would otherwise stay ``is_active`` and keep holding per-group cap slots.
"""

from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from accounts.models import User
from groups.models import Group, GroupInviteLink, GroupMembership


class ReparentRevokesLapsedLinksTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create_user(username="actor", password="pw")
        self.ancestor_admin = User.objects.create_user(username="anc", password="pw")
        self.old_root = Group.objects.create(name="Old", owner=self.ancestor_admin)
        self.new_root = Group.objects.create(name="New", owner=self.actor)
        self.moved = Group.objects.create(name="Moved", owner=self.actor, parent=self.old_root)
        self.child = Group.objects.create(name="Child", owner=self.actor, parent=self.moved)
        GroupMembership.objects.create(group=self.old_root, user=self.ancestor_admin, role="admin")
        GroupMembership.objects.create(group=self.moved, user=self.actor, role="admin")
        GroupMembership.objects.create(group=self.new_root, user=self.actor, role="admin")
        # Admin only through the old ancestor chain (member below).
        GroupMembership.objects.create(group=self.moved, user=self.ancestor_admin, role="member")
        self.inherited, _ = GroupInviteLink.generate(self.child, self.ancestor_admin)
        self.kept, _ = GroupInviteLink.generate(self.moved, self.actor)
        self.client = APIClient()
        self.client.force_authenticate(self.actor)

    def _reparent(self, parent):
        return self.client.patch(f"/api/v1/groups/{self.moved.pk}/", {"parent": parent}, format="json")

    def test_reparent_revokes_links_whose_creator_loses_inherited_admin(self):
        self.assertEqual(self._reparent(self.new_root.pk).status_code, 200)
        self.inherited.refresh_from_db()
        self.kept.refresh_from_db()
        self.assertFalse(self.inherited.is_active)
        self.assertTrue(self.kept.is_active)

    def test_rename_without_reparent_revokes_nothing(self):
        r = self.client.patch(f"/api/v1/groups/{self.moved.pk}/", {"name": "X"}, format="json")
        self.assertEqual(r.status_code, 200)
        self.inherited.refresh_from_db()
        self.assertTrue(self.inherited.is_active)

    def test_reparent_keeps_link_when_creator_still_admin(self):
        GroupMembership.objects.filter(group=self.new_root, user=self.actor).update(role="admin")
        GroupMembership.objects.create(group=self.new_root, user=self.ancestor_admin, role="admin")
        self.assertEqual(self._reparent(self.new_root.pk).status_code, 200)
        self.inherited.refresh_from_db()
        self.assertTrue(self.inherited.is_active)

    def test_reparent_to_root_revokes_and_frees_cap_slot(self):
        self.assertEqual(self._reparent(None).status_code, 200)
        self.inherited.refresh_from_db()
        self.assertFalse(self.inherited.is_active)


class ReparentDeepAndBroadcastTests(ReparentRevokesLapsedLinksTests):
    def test_grandchild_link_revoked_and_broadcast_id_only(self):
        grand = Group.objects.create(name="Grand", owner=self.actor, parent=self.child)
        link, raw = GroupInviteLink.generate(grand, self.ancestor_admin)
        with (
            patch("groups.broadcast.broadcast_group_event") as bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self.assertEqual(self._reparent(self.new_root.pk).status_code, 200)
        link.refresh_from_db()
        self.assertFalse(link.is_active)
        revoked = [c for c in bc.call_args_list if c.args[1] == "invite_link.revoked"]
        self.assertIn((grand.pk, {"id": link.pk}), [(c.args[0], c.args[2]) for c in revoked])
        for c in revoked:
            self.assertEqual(set(c.args[2]), {"id"})
            self.assertNotIn(raw, str(c.args))

    def test_already_lapsed_link_outside_moved_subtree_untouched(self):
        # Pins the delegate scope: re-parenting must only revoke inside the
        # moved subtree, never sweep a creator's other already-lapsed links.
        sibling = Group.objects.create(name="Sib", owner=self.actor)
        lapsed, _ = GroupInviteLink.generate(sibling, self.ancestor_admin)  # not an admin there
        self.assertEqual(self._reparent(self.new_root.pk).status_code, 200)
        lapsed.refresh_from_db()
        self.assertTrue(lapsed.is_active)

    def test_link_outside_moved_subtree_untouched(self):
        other, _ = GroupInviteLink.generate(self.old_root, self.ancestor_admin)
        self.assertEqual(self._reparent(self.new_root.pk).status_code, 200)
        other.refresh_from_db()
        self.assertTrue(other.is_active)


class CreatorDeletionRevokesLinksTests(TestCase):
    def setUp(self):
        self.creator = User.objects.create_user(username="creator", password="pw")
        # Not owned by the creator: Group.owner cascades and would delete the link.
        self.owner = User.objects.create_user(username="owner", password="pw")
        self.group = Group.objects.create(name="G", owner=self.owner)
        GroupMembership.objects.create(group=self.group, user=self.creator, role="admin")
        self.link, _ = GroupInviteLink.generate(self.group, self.creator)
        self.other_user = User.objects.create_user(username="other", password="pw")
        GroupMembership.objects.create(group=self.group, user=self.other_user, role="admin")
        self.other_link, _ = GroupInviteLink.generate(self.group, self.other_user)

    def test_deleting_creator_deactivates_their_links_only(self):
        self.creator.delete()
        self.link.refresh_from_db()
        self.other_link.refresh_from_db()
        self.assertIsNone(self.link.created_by)
        self.assertFalse(self.link.is_active)
        self.assertTrue(self.other_link.is_active)

    def test_consumed_single_use_link_keeps_history(self):
        from django.utils import timezone

        GroupInviteLink.objects.filter(pk=self.link.pk).update(used_at=timezone.now(), single_use=True)
        self.creator.delete()
        self.link.refresh_from_db()
        self.assertTrue(self.link.is_active)

    def test_deletion_broadcasts_link_id_only(self):
        with (
            patch("groups.broadcast.broadcast_group_event") as bc,
            self.captureOnCommitCallbacks(execute=True),
        ):
            self.creator.delete()
        revoked = [c for c in bc.call_args_list if c.args[1] == "invite_link.revoked"]
        self.assertEqual([(c.args[0], c.args[2]) for c in revoked], [(self.group.pk, {"id": self.link.pk})])

    def test_bulk_queryset_delete_deactivates_links(self):
        User.objects.filter(pk__in=[self.creator.pk, self.other_user.pk]).delete()
        self.link.refresh_from_db()
        self.other_link.refresh_from_db()
        self.assertFalse(self.link.is_active)
        self.assertFalse(self.other_link.is_active)


class CreatorlessBackfillMigrationTests(TestCase):
    def test_backfill_deactivates_only_unused_creatorless_links(self):
        import importlib

        from django.apps import apps

        mod = importlib.import_module("groups.migrations.0016_deactivate_creatorless_invite_links")
        owner = User.objects.create_user(username="o", password="pw")
        group = Group.objects.create(name="G", owner=owner)
        orphan, _ = GroupInviteLink.generate(group, owner)
        used, _ = GroupInviteLink.generate(group, owner)
        kept, _ = GroupInviteLink.generate(group, owner)
        from django.utils import timezone

        GroupInviteLink.objects.filter(pk__in=[orphan.pk, used.pk]).update(created_by=None)
        GroupInviteLink.objects.filter(pk=used.pk).update(used_at=timezone.now(), single_use=True)
        inactive = User.objects.create_user(username="gone", password="pw", is_active=False)
        stale, _ = GroupInviteLink.generate(group, inactive)
        mod.deactivate_creatorless_links(apps, None)
        for lk in (orphan, used, kept, stale):
            lk.refresh_from_db()
        self.assertFalse(stale.is_active)
        self.assertFalse(orphan.is_active)
        self.assertTrue(used.is_active)
        self.assertTrue(kept.is_active)
