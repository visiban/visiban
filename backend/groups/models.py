import hashlib
import logging
import secrets
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
    # Use can_access_all_content (not is_site_admin) — the documented privilege
    # model reserves is_site_admin for /api/admin/* UI access only, while
    # can_access_all_content is the flag that grants broad content read/write.
    # Using is_site_admin here would let a site admin without can_access_all_content
    # enumerate all groups, violating the documented flag semantics.
    if getattr(user, "can_access_all_content", False):
        return set(Group.objects.values_list("id", flat=True))
    direct_ids = set(
        Group.objects.filter(
            Q(owner=user) | Q(memberships__user=user)
        ).values_list("id", flat=True)
    )
    all_ids = set(direct_ids)
    # Walk UP: include ancestor groups so the user can navigate to their
    # subgroup through the sidebar tree.  Ancestors are read-only — the user
    # won't have write permissions on them unless they have an explicit
    # membership there.
    ancestor_frontier = set(
        Group.objects.filter(id__in=direct_ids, parent__isnull=False)
        .values_list("parent_id", flat=True)
    )
    for _ in range(_GROUP_TRAVERSAL_MAX_DEPTH):
        if not ancestor_frontier:
            break
        all_ids |= ancestor_frontier
        ancestor_frontier = set(
            Group.objects.filter(id__in=ancestor_frontier, parent__isnull=False)
            .exclude(id__in=all_ids)
            .values_list("parent_id", flat=True)
        )
    # Walk DOWN: include descendant sub-groups.
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
    description = models.TextField(blank=True, default="")
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

    GROUP_INVITE_PREFIX = "vbng_"

    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    group = models.ForeignKey(Group, on_delete=models.CASCADE, related_name="invite_links")
    token_hash = models.CharField(max_length=64, unique=True, db_index=True, null=True)
    prefix = models.CharField(max_length=8, blank=True, default="")
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

    @classmethod
    def generate(cls, group, created_by, name="", role=None, expires_at=None):
        """Create a new invite link with a hashed token. Returns (instance, raw_token)."""
        raw = cls.GROUP_INVITE_PREFIX + secrets.token_hex(20)
        hashed = hashlib.sha256(raw.encode()).hexdigest()
        instance = cls.objects.create(
            group=group,
            created_by=created_by,
            token_hash=hashed,
            prefix=raw[:8],
            name=name,
            role=role or cls.Role.MEMBER,
            expires_at=expires_at,
            is_active=True,
        )
        return instance, raw

    @classmethod
    def lookup_by_token(cls, raw_token):
        """Look up an active invite link by its raw token. Returns instance or None."""
        hashed = hashlib.sha256(raw_token.encode()).hexdigest()
        try:
            return cls.objects.get(token_hash=hashed, is_active=True)
        except cls.DoesNotExist:
            return None


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
