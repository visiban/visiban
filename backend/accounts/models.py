import hashlib
import secrets

from django.contrib.auth.models import AbstractUser
from django.core.cache import cache
from django.db import models
from django.db.models import UniqueConstraint
from django.db.models.functions import Lower
from django.utils import timezone

PAT_PREFIX = "vbn_"
PAT_MAX_PER_USER = 10

INVITE_LINK_PREFIX = "vbnl_"
MAX_ACTIVE_INVITE_LINKS = 50  # Soft cap per instance — prevents token flood from a compromised admin

# Shared by models.py and adapter.py — defined here to avoid circular imports.
REGISTRATION_MODE_CACHE_KEY = "site_setting_registration_mode"
REGISTRATION_MODE_CACHE_TTL = 60  # seconds

UPLOADS_ENABLED_CACHE_KEY = "site_setting_uploads_enabled"
UPLOADS_ENABLED_CACHE_TTL = 60  # seconds


def get_registration_mode() -> str:
    """Return registration_mode, using a short-lived cache to avoid a DB hit on every request."""
    mode = cache.get(REGISTRATION_MODE_CACHE_KEY)
    if mode is None:
        mode = SiteSetting.get().registration_mode
        cache.set(REGISTRATION_MODE_CACHE_KEY, mode, REGISTRATION_MODE_CACHE_TTL)
    return mode


def invalidate_registration_mode_cache():
    """Evict the cached registration_mode so the next read hits the DB."""
    cache.delete(REGISTRATION_MODE_CACHE_KEY)


def get_uploads_enabled() -> bool:
    """Return whether file uploads are enabled, using a short-lived cache to
    avoid a DB hit on every attachment request."""
    cached = cache.get(UPLOADS_ENABLED_CACHE_KEY)
    if cached is not None:
        return cached
    value = SiteSetting.get().uploads_enabled
    cache.set(UPLOADS_ENABLED_CACHE_KEY, value, UPLOADS_ENABLED_CACHE_TTL)
    return value


def invalidate_uploads_enabled_cache():
    """Evict the cached uploads_enabled so the next read hits the DB."""
    cache.delete(UPLOADS_ENABLED_CACHE_KEY)


class SiteSetting(models.Model):
    """Singleton model for instance-wide configuration. Always access via SiteSetting.get()."""

    class RegistrationMode(models.TextChoices):
        OPEN = "open", "Open — anyone can register"
        INVITE_ONLY = "invite_only", "Invite-only — only users with a valid invite link can register"
        CLOSED = "closed", "Closed — self-registration is disabled; admins create accounts manually"

    registration_mode = models.CharField(
        max_length=16,
        choices=RegistrationMode.choices,
        default=RegistrationMode.OPEN,
        help_text="Controls who can self-register. 'open' = anyone; 'invite_only' = valid invite link required; 'closed' = admin-created accounts only.",
    )
    uploads_enabled = models.BooleanField(
        default=True,
        help_text="When False, attachment uploads are disabled for all users.",
    )

    class Meta:
        db_table = "site_settings"

    def save(self, *args, **kwargs):
        # Enforce singleton: the row always has pk=1.
        self.pk = 1
        super().save(*args, **kwargs)
        # Invalidate caches so the new values take effect immediately without
        # waiting for the TTL to expire.
        invalidate_registration_mode_cache()
        invalidate_uploads_enabled_cache()

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    @property
    def require_invite_for_registration(self):
        """Backward-compat shim: returns True when registration is not open."""
        return self.registration_mode != self.RegistrationMode.OPEN


class User(AbstractUser):
    """Extended user model. django-allauth handles OAuth linkage."""
    # Uses blank=True (empty string) rather than null=True as the "no avatar"
    # sentinel.  The 1.0 API contract is: absent avatar → "".  Changing this
    # to null=True post-1.0 would be a breaking serializer change.
    avatar_url = models.URLField(blank=True)
    display_name = models.CharField(max_length=150, blank=True)
    is_site_admin = models.BooleanField(default=False)
    can_access_all_content = models.BooleanField(
        default=False,
        help_text="Grants read/write access to all boards and groups on this instance regardless of membership. Independent of is_site_admin.",
    )
    must_change_password = models.BooleanField(default=False)
    must_change_username = models.BooleanField(default=False)
    timezone = models.CharField(max_length=64, blank=True, default="")
    notif_card_assigned = models.BooleanField(default=True)
    notif_mentioned = models.BooleanField(default=True)
    notif_due_soon = models.BooleanField(default=False)
    notif_card_moved = models.BooleanField(default=False)
    notif_comment_added = models.BooleanField(default=False)
    notif_board_invite = models.BooleanField(default=True)
    date_format = models.CharField(max_length=16, blank=True, default="MM/DD/YYYY")
    time_format = models.CharField(max_length=4, blank=True, default="12h")
    number_locale = models.CharField(max_length=16, blank=True, default="en-US")
    close_editor_on_enter = models.BooleanField(default=True)
    has_completed_tour = models.BooleanField(default=False)
    # The board to open automatically after login. SET_NULL so that deleting a
    # board never cascades to deleting the user. The frontend verifies access
    # before redirecting to prevent an IDOR leak via a stale FK.
    default_board = models.ForeignKey(
        "boards.Board",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    class Meta:
        db_table = "users"
        constraints = [
            UniqueConstraint(Lower("username"), name="unique_username_ci"),
        ]
        indexes = [
            # Partial index covering only the tiny set of site-admin users.
            # BoardFullSerializer.get_members() filters by can_access_all_content=True
            # on every /full/ request; without this index the query scans the full
            # user table even though virtually all rows have the field False.
            models.Index(
                fields=["can_access_all_content"],
                name="user_can_access_all_idx",
                condition=models.Q(can_access_all_content=True),
            ),
        ]


class PersonalAccessToken(models.Model):
    """Named, revocable API token for a user.

    The raw token value is generated once and never stored — only a SHA-256
    hash is persisted. On every authenticated request the hash of the
    Authorization header value is compared against this column.

    Invariants:
    - A user may hold at most PAT_MAX_PER_USER (10) active tokens.
    - All tokens for a user are deleted when their password is changed
      (enforced in ChangePasswordView) so that a compromised account cannot
      retain API access after a credential reset.
    - expires_at is nullable; null means the token never expires.
    """

    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name="personal_access_tokens",
    )
    name = models.CharField(max_length=64)
    # First 8 chars of the raw token ("vbn_XXXX") — safe for display.
    prefix = models.CharField(max_length=8)
    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "personal_access_tokens"
        ordering = ["-created_at"]

    @classmethod
    def generate(cls, user, name, expires_at=None):
        """Create a new token, persist the hash, return (instance, raw_token).

        The raw_token is the only time the plain-text value is available — the
        caller must return it to the user exactly once and never again.
        """
        raw = PAT_PREFIX + secrets.token_hex(20)  # "vbn_" + 40 hex chars
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        prefix = raw[:8]
        instance = cls.objects.create(
            user=user,
            name=name,
            prefix=prefix,
            token_hash=token_hash,
            expires_at=expires_at,
        )
        return instance, raw


class InviteLink(models.Model):
    """Site-wide registration invite link.

    The raw token is generated once and never stored — only a SHA-256 hash is
    persisted. The raw value is returned exactly once at creation.

    Invariants:
    - At most MAX_ACTIVE_INVITE_LINKS (50) non-expired, non-revoked, non-used
      links may be active at once (enforced at the view layer).
    - single_use links are consumed atomically via select_for_update() at
      registration time to prevent race-condition double-use.
    - All pending links created by a user are automatically revoked when that
      user is deactivated (enforced in AdminUserDeactivateView).
    """

    VALID_TTL_DAYS = (1, 7, 30)  # Choices offered in the UI; None = never expires.

    token_hash = models.CharField(max_length=64, unique=True, db_index=True)
    # First 8 chars of the raw token ("vbnl_XXX") — safe for display.
    prefix = models.CharField(max_length=8)
    created_by = models.ForeignKey(
        User,
        on_delete=models.SET_NULL,
        null=True,
        related_name="created_invite_links",
    )
    expires_at = models.DateTimeField(null=True, blank=True)
    single_use = models.BooleanField(default=False)
    used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "invite_links"
        ordering = ["-created_at"]

    @classmethod
    def generate(cls, created_by, expires_at=None, single_use=False):
        """Create a new link, persist the hash, return (instance, raw_token).

        The raw_token is the only time the plain-text value is available — the
        caller must return it to the user exactly once and never again.
        """
        raw = INVITE_LINK_PREFIX + secrets.token_hex(20)  # "vbnl_" + 40 hex chars
        token_hash = hashlib.sha256(raw.encode()).hexdigest()
        prefix = raw[:8]
        instance = cls.objects.create(
            created_by=created_by,
            token_hash=token_hash,
            prefix=prefix,
            expires_at=expires_at,
            single_use=single_use,
        )
        return instance, raw

    @property
    def status(self):
        """Return human-readable status: pending / used / expired / revoked."""
        if self.revoked_at:
            return "revoked"
        if self.used_at:
            return "used"
        if self.expires_at and self.expires_at < timezone.now():
            return "expired"
        return "pending"

    @property
    def is_valid(self):
        return self.status == "pending"
