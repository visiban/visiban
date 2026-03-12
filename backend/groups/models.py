import uuid
from django.db import models
from django.db.models import Q
from django.conf import settings
from django.utils import timezone


def get_accessible_group_ids(user):
    """
    Return all group IDs accessible to user: groups where they are a direct
    member/owner, plus all descendant sub-groups of those groups.
    Site admins have access to all groups.
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
    for _ in range(6):  # cap recursion depth
        if not frontier:
            break
        children = set(
            Group.objects.filter(parent__in=frontier)
            .exclude(id__in=all_ids)
            .values_list("id", flat=True)
        )
        all_ids |= children
        frontier = children
    return all_ids


class Group(models.Model):
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

    def ancestors(self, max_depth=6):
        """Return list of ancestor groups from immediate parent up to root."""
        chain = []
        node = self.parent
        depth = 0
        while node and depth < max_depth:
            chain.append(node)
            node = node.parent
            depth += 1
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
    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        VIEWER = "viewer"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="group_memberships"
    )
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "group_memberships"
        unique_together = ["group", "user"]


class GroupInviteLink(models.Model):
    class Role(models.TextChoices):
        MEMBER = "member"
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
        max_length=10, choices=Role.choices, default=Role.MEMBER
    )
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "group_invite_links"

    @property
    def is_expired(self):
        return self.expires_at is not None and self.expires_at < timezone.now()
