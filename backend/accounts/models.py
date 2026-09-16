import hashlib
import secrets

from django.contrib.auth.models import AbstractUser
from django.core.cache import cache
from django.core.validators import MaxLengthValidator
from django.db import models
from django.db.models import UniqueConstraint
from django.db.models.functions import Lower
from django.utils import timezone

PAT_PREFIX = "vbn_"
PAT_MAX_PER_USER = 10

# ---------------------------------------------------------------------------
# Personal Access Token scopes (#1110)
# ---------------------------------------------------------------------------
# The vocabulary is STRICTLY NON-HIERARCHICAL: no scope implies any other.
# `admin` does not grant `read` or `write`, `write` does not grant `read`, and
# nothing at all grants `mcp:read` / `mcp:write`. This is deliberate — a
# hierarchy is what turns a least-privilege credential back into a full-
# authority one the first time someone adds a convenience implication.
SCOPE_READ = "read"
SCOPE_WRITE = "write"
SCOPE_ADMIN = "admin"
SCOPE_MCP_READ = "mcp:read"
SCOPE_MCP_WRITE = "mcp:write"

PAT_SCOPES = (
    SCOPE_READ,
    SCOPE_WRITE,
    SCOPE_ADMIN,
    SCOPE_MCP_READ,
    SCOPE_MCP_WRITE,
)

# Scopes that a legacy (scopes IS NULL) token may never satisfy, no matter how
# much REST authority it carries.
MCP_SCOPES = frozenset({SCOPE_MCP_READ, SCOPE_MCP_WRITE})

# Applied when POST /api/v1/auth/tokens/ omits `scopes`. Reproduces today's
# non-admin REST behavior so existing integrations keep working, while making
# `admin` and the `mcp:*` surface opt-in. A write path must never persist NULL
# — NULL is reachable only by tokens that predate this field.
PAT_DEFAULT_SCOPES = [SCOPE_READ, SCOPE_WRITE]

INVITE_LINK_PREFIX = "vbnl_"
MAX_ACTIVE_INVITE_LINKS = 50  # Soft cap per instance — prevents token flood from a compromised admin

# Shared by models.py and adapter.py — defined here to avoid circular imports.
REGISTRATION_MODE_CACHE_KEY = "site_setting_registration_mode"
REGISTRATION_MODE_CACHE_TTL = 60  # seconds

UPLOADS_ENABLED_CACHE_KEY = "site_setting_uploads_enabled"
UPLOADS_ENABLED_CACHE_TTL = 60  # seconds

# Single source of truth for the notice length cap, shared by the model
# validator and the admin serializer so the two can never disagree.
MAINTENANCE_MESSAGE_MAX_LENGTH = 1000

MAINTENANCE_CACHE_KEY = "site_setting_maintenance"
MAINTENANCE_CACHE_TTL = 60  # seconds

# Shown to users when maintenance mode is on and the operator left the message
# blank. Kept here (not in the middleware) so the API 503 body and the SPA
# banner can never drift apart.
DEFAULT_MAINTENANCE_MESSAGE = (
    "Visiban is in maintenance mode. You can still read boards and cards, "
    "but changes are temporarily disabled. Please try again shortly."
)


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


def get_maintenance_state() -> tuple[bool, str]:
    """Return ``(active, message)`` for instance-wide maintenance mode.

    WHY this is cached: ``MaintenanceModeMiddleware`` consults this on *every*
    request, not just writes. An uncached read would add one ``SiteSetting``
    query to every single request the instance serves — a permanent,
    always-on cost paid by the 99.99% of installs that never turn maintenance
    mode on. The 60s TTL is the ceiling only when nothing writes; the real
    propagation path is ``SiteSetting.save()`` → ``invalidate_maintenance_mode_cache()``,
    which is instant because production runs a shared Valkey/Redis cache, so
    every worker sees the flip at once. That is what satisfies the issue's
    "no restart required" requirement.

    The tuple is cached as a unit rather than as two keys so a reader can never
    observe a half-updated state (mode flipped on, message still the old one).
    """
    cached = cache.get(MAINTENANCE_CACHE_KEY)
    if cached is not None:
        return cached
    setting = SiteSetting.get()
    value = (setting.maintenance_mode, setting.maintenance_message)
    cache.set(MAINTENANCE_CACHE_KEY, value, MAINTENANCE_CACHE_TTL)
    return value


def get_maintenance_message(message: str = "") -> str:
    """Return the operator's notice, falling back to the built-in default."""
    return message.strip() or DEFAULT_MAINTENANCE_MESSAGE


def invalidate_maintenance_mode_cache():
    """Evict the cached maintenance state so the next read hits the DB."""
    cache.delete(MAINTENANCE_CACHE_KEY)


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
    # Defaults to False so that an existing install upgrading to this release
    # behaves exactly as it did before — the 503 write-block is unreachable
    # until an operator deliberately turns it on. Both columns are defaulted
    # (never NOT NULL without a default) per the zero-downtime migration rule.
    maintenance_mode = models.BooleanField(
        default=False,
        help_text="When True, non-admin write requests are rejected with 503 and all users see a maintenance notice.",
    )
    # The 1000-character cap is also declared on the admin serializer, which is
    # where API input is validated. It is repeated here as a model validator
    # because the serializer is not the only write path: Django admin registers
    # SiteSetting with no custom ModelForm, and management commands and shell
    # sessions write the field directly. Without this, those paths could store
    # an unbounded notice that then lands in every 503 body on the instance.
    maintenance_message = models.TextField(
        blank=True,
        default="",
        validators=[MaxLengthValidator(MAINTENANCE_MESSAGE_MAX_LENGTH)],
        help_text="Plain-text notice shown to users while maintenance mode is active. Blank uses the built-in default.",
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
        invalidate_maintenance_mode_cache()

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

    class Theme(models.TextChoices):
        SYSTEM = "system", "Follow operating system preference"
        DARK = "dark", "Always dark"
        LIGHT = "light", "Always light"

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
    theme = models.CharField(
        max_length=8,
        choices=Theme.choices,
        default=Theme.SYSTEM,
        blank=True,
    )
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
    - scopes is nullable; null means "legacy" (see the field comment).
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
    # Allow-list of scopes this token carries. THREE distinct states — note that
    # the empty-list meaning is the INVERSE of the other list-valued JSONFields
    # in this codebase (Board.allowed_priorities, Group.allowed_priorities,
    # where [] means "no restriction"):
    #   None  — "legacy": issued before #1110, carries the owner's full REST
    #           authority exactly as before, but can never satisfy an mcp:*
    #           requirement. Reachable only by pre-existing rows; no write path
    #           may persist None.
    #   []    — NO authority at all. Denied everywhere. Not "unrestricted".
    #   [...] — exactly the listed scopes, with no implication between them.
    scopes = models.JSONField(null=True, blank=True, default=None)
    # The scope requirement this token actually satisfied on its most recent
    # request ("legacy" for an unscoped token). Recorded rather than a constant
    # so the audit trail shows the authority that was exercised, not the
    # authority that was configured. Written in the same UPDATE as last_used_at
    # — the PAT hot path must not gain a second write.
    last_used_scope = models.CharField(max_length=64, null=True, blank=True)

    class Meta:
        db_table = "personal_access_tokens"
        ordering = ["-created_at"]

    @classmethod
    def generate(cls, user, name, expires_at=None, scopes=None):
        """Create a new token, persist the hash, return (instance, raw_token).

        The raw_token is the only time the plain-text value is available — the
        caller must return it to the user exactly once and never again.

        `scopes=None` creates a legacy, unscoped token. Every API write path
        passes an explicit list; the default exists so that pre-#1110 callers
        (and the tests that assert pre-#1110 behavior) keep working unchanged.
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
            scopes=scopes,
        )
        return instance, raw

    @property
    def is_legacy(self) -> bool:
        """True for tokens issued before scopes existed (scopes IS NULL).

        Deliberately distinguishes None from [] — an empty list is an explicit
        grant of nothing, not an absent grant.
        """
        return self.scopes is None


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
    # Defense-in-depth audit counter: incremented on every successful
    # consumption, even for multi-use links. If a multi-use link is leaked,
    # this gives operators visibility into how widely it was used before
    # they revoked it.
    use_count = models.PositiveIntegerField(default=0)

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


class InviteLinkRedemption(models.Model):
    """Per-email record of a multi-use invite link redemption (#925).

    A multi-use invite link (``InviteLink.single_use=False``) can otherwise be
    redeemed multiple times by the same email — defeating the "one invite per
    person" expectation when the link leaks.  Storing a SHA-256 hash of the
    normalised email (lowercase + strip; no Gmail dot/plus collapsing — that
    would silently break legitimate aliasing) and enforcing a unique constraint
    on ``(invite_link, email_hash)`` blocks repeat redemptions while keeping
    audit data hash-only for privacy.

    Hash-only storage is irreversible: operators investigating "who redeemed
    this link" see only hashes.  This is intentional; the trade-off is that
    debugging requires the original email to recompute the hash.

    Single-use links do not need this table — the existing ``used_at`` flag
    already gates re-use.
    """

    invite_link = models.ForeignKey(
        InviteLink,
        on_delete=models.CASCADE,
        related_name="redemptions",
    )
    email_hash = models.CharField(max_length=64)
    redeemed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "invite_link_redemptions"
        unique_together = [("invite_link", "email_hash")]
        indexes = [
            models.Index(
                fields=["invite_link", "redeemed_at"],
                name="invite_redm_invite__idx",
            ),
        ]
