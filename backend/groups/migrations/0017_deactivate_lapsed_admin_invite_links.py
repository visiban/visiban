from django.db import migrations

# Mirrors groups.models._GROUP_TRAVERSAL_MAX_DEPTH; frozen here because a
# migration must not change meaning if the live constant is ever retuned.
_MAX_DEPTH = 6


def deactivate_lapsed_admin_links(apps, schema_editor):
    """Deactivate unused links whose creator no longer administers the group (#1565).

    #1510/#1513 revoke such links going forward, and 0016 handled creators that
    are missing or inactive. Links that went stale earlier with a creator who
    still exists and is active (demoted, removed from the group, or cut off by
    a re-parent) stayed ``is_active``: they admit nobody (join/preview re-check
    the creator) but were listed as active and held cap slots.

    The rule reimplements ``groups.views.sender_is_group_admin`` (the rule
    behind ``invite_creator_is_valid``) over historical models: the creator is
    active and is ``can_access_all_content`` or holds an admin membership on the
    link's group or an ancestor within ``_MAX_DEPTH`` levels. Consumed
    single-use links (``used_at`` set) keep their history (#1445).
    Data-only; reverse is a no-op because deactivated rows are
    indistinguishable from normally revoked ones.
    """
    Group = apps.get_model("groups", "Group")
    GroupMembership = apps.get_model("groups", "GroupMembership")
    GroupInviteLink = apps.get_model("groups", "GroupInviteLink")

    links = list(
        GroupInviteLink.objects.filter(is_active=True, used_at__isnull=True)
        .select_related("created_by")
        .only("pk", "group_id", "created_by__is_active", "created_by__can_access_all_content")
    )
    if not links:
        return
    parent_of = dict(Group.objects.values_list("pk", "parent_id"))
    admin_groups = {}  # creator pk -> set of group ids they administer directly

    def _admin_ids(user_id):
        if user_id not in admin_groups:
            admin_groups[user_id] = set(
                GroupMembership.objects.filter(user_id=user_id, role="admin")
                .values_list("group_id", flat=True)
            )
        return admin_groups[user_id]

    def _still_admin(link):
        creator = link.created_by
        if creator is None or not creator.is_active:
            return False
        if creator.can_access_all_content:
            return True
        admins = _admin_ids(creator.pk)
        node, depth = link.group_id, 0
        while node is not None and depth < _MAX_DEPTH:
            if node in admins:
                return True
            node = parent_of.get(node)
            depth += 1
        return False

    lapsed = [lk.pk for lk in links if not _still_admin(lk)]
    for start in range(0, len(lapsed), 500):
        GroupInviteLink.objects.filter(
            pk__in=lapsed[start:start + 500], is_active=True, used_at__isnull=True,
        ).update(is_active=False)


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0016_deactivate_creatorless_invite_links"),
    ]

    operations = [
        migrations.RunPython(deactivate_lapsed_admin_links, migrations.RunPython.noop),
    ]
