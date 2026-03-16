import logging
import uuid
from django.db import models
from django.db.models import Q
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

# Maximum depth used when walking group hierarchies.  This cap prevents
# unbounded query chains on deep or accidentally cyclic group trees.
# Six levels covers all realistic organizational structures; hierarchies
# deeper than this are unusual and likely indicate a data modelling issue.
# If the cap is reached during a traversal a warning is emitted (see below)
# so operators can detect and address overly deep trees.
_GROUP_TRAVERSAL_MAX_DEPTH = 6


def get_accessible_group_ids(user):
    """
    Return all group IDs accessible to user: groups where they are a direct
    member/owner, plus all descendant sub-groups of those groups.
    Site admins have access to all groups.

    Descendant discovery is capped at _GROUP_TRAVERSAL_MAX_DEPTH iterations.
    Groups nested deeper than this limit will not appear in the result set.
    """
    if getattr(user, "is_site_admin", False):
        return set(Group.objects.values_list("id", flat=True))
    direct_ids = set(
        Group.objects.filter(
            Q(owner=user) | Q(memberships__user=user)
        ).values_list("id", flat=True)
    )
    all_ids = set(direct_ids)
    frontier = set(direct_ids)
    for depth in range(_GROUP_TRAVERSAL_MAX_DEPTH):
        if not frontier:
            break
        children = set(
            Group.objects.filter(parent__in=frontier)
            .exclude(id__in=all_ids)
            .values_list("id", flat=True)
        )
        all_ids |= children
        frontier = children
    else:
        # The for-loop completed all iterations without the frontier emptying,
        # meaning the group tree may extend beyond the traversal cap.
        if frontier:
            logger.warning(
                "Group descendant traversal capped at depth %d for user %s. "
                "Groups nested deeper than this limit are not included in the accessible set.",
                _GROUP_TRAVERSAL_MAX_DEPTH,
                getattr(user, "pk", user),
            )
    return all_ids


class Group(models.Model):
    """A workspace that groups boards and members; supports nested subgroups up to 6 levels deep."""

    class DefaultMemberRole(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    name = models.CharField(max_length=255)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="owned_groups"
    )
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="subgroups"
    )
    default_board_member_role = models.CharField(
        max_length=20,
        choices=DefaultMemberRole.choices,
        default=DefaultMemberRole.MEMBER,
    )
    allowed_priorities = models.JSONField(
        default=list,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "groups"

    def __str__(self):
        return self.name

    def get_allowed_priorities(self):
        """Return allowed_priorities, falling back to all priorities if empty."""
        if self.allowed_priorities:
            return self.allowed_priorities
        return ["low", "medium", "high", "urgent"]

    def ancestors(self, max_depth=_GROUP_TRAVERSAL_MAX_DEPTH):
        """Return list of ancestor groups from immediate parent up to root.

        The traversal is capped at *max_depth* levels (default:
        _GROUP_TRAVERSAL_MAX_DEPTH) to guard against runaway queries on
        unexpectedly deep or cyclic trees.  A warning is emitted if the cap
        is hit so operators can detect the truncation.
        """
        chain = []
        node = self.parent
        depth = 0
        while node and depth < max_depth:
            chain.append(node)
            node = node.parent
            depth += 1
        if node is not None:
            # Loop exited because of the depth cap, not because we reached the
            # root.  Remaining ancestors were silently omitted.
            logger.warning(
                "Group ancestor traversal capped at depth %d for group %s (id=%s). "
                "Ancestors at deeper levels were not returned.",
                max_depth,
                self.name,
                self.pk,
            )
        return chain


class GroupLabel(models.Model):
    """Shared label library for a group — copied to new boards on creation."""
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="labels")
    name = models.CharField(max_length=50)
    color = models.CharField(max_length=7, default="#EAB308")

    class Meta:
        db_table = "group_labels"
        unique_together = ["group", "name"]

    def __str__(self):
        return f"{self.group.name} / {self.name}"


class GroupMembership(models.Model):
    """Junction table recording a user's role in a group (admin/member/collaborator/viewer)."""

    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="group_memberships"
    )
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_memberships"
        unique_together = ["group", "user"]


class GroupInviteLink(models.Model):
    """A shareable invite link that grants the recipient a specified role in a group on use."""

    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="invite_links")
    token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    is_active = models.BooleanField(default=True)
    name = models.CharField(max_length=100, blank=True, default="")
    role = models.CharField(
        max_length=16, choices=Role.choices, default=Role.MEMBER
    )
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "group_invite_links"

    @property
    def is_expired(self):
        return self.expires_at is not None and self.expires_at < timezone.now()


class GroupFavorite(models.Model):
    """Records that a user has starred a group; unique per user-group pair."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="group_favorites"
    )
    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="favorites")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_favorites"
        unique_together = ["user", "group"]
