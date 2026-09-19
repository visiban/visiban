import hashlib
import logging
import secrets

from django.contrib.auth.models import AbstractUser
from django.core.cache import cache
from django.core.validators import MaxLengthValidator
from django.db import models, transaction
from django.db.models import UniqueConstraint
from django.db.models.functions import Lower
from django.utils import timezone

logger = logging.getLogger(__name__)

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


def _invalidate_site_setting_caches():
    """Evict every cached projection of the SiteSetting singleton.

    Never raises. A cache eviction is a propagation optimization, not part of
    the write: the setting is already durable in the database, and the worst
    consequence of a failed eviction is that workers keep serving the previous
    value until the 60s TTL expires.

    Letting the exception out would be strictly worse, and since #1126 it would
    be dangerous. This now runs inside ``AdminSettingsView.patch``'s (and the
    management command's) transaction, so an unhandled cache error would roll
    the setting change back — meaning a Valkey/Redis outage could stop an
    operator turning maintenance mode ON, at exactly the moment a cache outage
    makes them want to. Degrading to a 60s propagation delay is the right trade;
    refusing the write is not.
    """
    for invalidate in (
        invalidate_registration_mode_cache,
        invalidate_uploads_enabled_cache,
        invalidate_maintenance_mode_cache,
    ):
        try:
            invalidate()
        except Exception:
            # No setting values in the log line — only the failure itself.
            logger.warning(
                "SiteSetting cache eviction failed (%s); workers may serve the "
                "previous value until the TTL expires",
                invalidate.__name__,
                exc_info=True,
            )


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
        #
        # Done TWICE, deliberately (#1126). The immediate eviction is the
        # original behavior and is what makes the new value visible to any
        # reader in this same process — including a test, which runs inside a
        # transaction that never commits.
        #
        # The repeat at commit time closes a race that only exists once the
        # caller wraps this in a transaction, which AdminSettingsView.patch now
        # does so the setting and its audit rows land together: evicting a key
        # mid-transaction lets another worker read the still-old *committed* row
        # and repopulate the cache with a stale value, which would then survive
        # until the 60s TTL expired — precisely the "no restart required"
        # guarantee get_maintenance_state() exists to provide. Evicting again
        # after commit means the next reader repopulates from the new row.
        #
        # cache.delete is idempotent, so the second eviction costs a round trip
        # and nothing else. Under autocommit both fire back to back.
        _invalidate_site_setting_caches()
        transaction.on_commit(_invalidate_site_setting_caches)

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


# ---------------------------------------------------------------------------
# Admin action audit log (#1126)
# ---------------------------------------------------------------------------

# The SiteSetting fields captured by snapshot_site_setting(), so the three write
# paths (admin API, management command, Django admin) all diff the same set.
#
# This tuple is consumed ONLY by snapshot_site_setting(). record_site_setting_changes()
# below does NOT loop over it — it is a hand-written branch per field, and that
# is deliberate: each field needs its own decision about what is safe to persist
# into an append-only, queryable table, and about which action name describes it.
# Do not "simplify" those branches into a loop over this tuple. Today every
# SiteSetting field is an enum, a boolean or the admin's own notice text; the
# day one of them holds an SMTP password or an OIDC client secret, a generic
# loop would copy that value verbatim into the audit log, and the rows are never
# rewritten.
AUDITED_SITE_SETTING_FIELDS = (
    "maintenance_mode",
    "maintenance_message",
    "registration_mode",
    "uploads_enabled",
)


def snapshot_site_setting(setting) -> dict:
    """Capture the audited fields of ``setting`` before it is mutated.

    Returned as a plain dict rather than a model copy so a caller can hold it
    across a ``save()`` without carrying a second instance that might itself be
    written back by accident.
    """
    return {field: getattr(setting, field) for field in AUDITED_SITE_SETTING_FIELDS}


class AdminActionLog(models.Model):
    """Append-only record of instance-wide admin control-plane actions (#1126).

    Why this exists
    ---------------
    ``SiteSetting`` carries instance-wide switches any site admin can flip —
    maintenance mode most consequentially, since it takes write access away
    from everyone at once. Before this table the only trace of such a flip was
    the singleton row's own state: it showed the *current* value and nothing
    about who set it or when. On an instance with more than one site admin
    that makes "who put us into maintenance, and when did it end?" unanswerable
    during a retrospective, which is the question an incident review opens with.

    Scope — deliberately narrow
    ---------------------------
    This is a record of a fixed, enumerable set of admin control-plane actions,
    not a general-purpose audit-log product. Configurable retention, arbitrary
    per-object diffing, SIEM export and compliance reporting are explicitly out
    of scope and belong to the enterprise edition (see
    ``docs/architecture/open-core-boundary.md``). What is here is the same shape
    ``BoardExportLog`` (#842) already established for a board-scoped action,
    lifted to instance scope.

    Why ``actor_id`` is a plain integer and not a ForeignKey
    -------------------------------------------------------
    Same reasoning as ``boards.BoardEvent``: this table is append-only, and a
    ForeignKey would quietly break that. ``on_delete=SET_NULL`` lets deleting a
    user rewrite who did what — and *who* is this table's entire reason to
    exist, so the one edit a FK would permit is the one that must not happen.
    Nothing is given up: the actor is rendered from local columns, so a page of
    rows cannot N+1 on a join, and no code ever traverses the relation.

    Why ``actor_username`` outlives the account
    -------------------------------------------
    ``actor_id`` alone degrades to a dangling integer once the account is gone,
    which answers "who" with a number nobody can resolve. The username is
    therefore snapshotted at write time and kept verbatim.

    This is a deliberate divergence from how the rest of the codebase treats a
    departed user: invite links and group ownership report ``null`` for an
    anonymized creator (see ``docs/api/groups.md``), and that is correct for a
    convenience attribution field. It is not correct for a security audit
    record of a privileged instance-wide action — a retrospective that cannot
    name the actor has no value. The retention consequence is real and is
    documented for operators in ``docs/api/admin.md``; do not "fix" this to
    match the anonymization pattern without replacing it with something that
    still answers the question.

    Retention
    ---------
    There is deliberately no pruner. ``BoardEvent`` has one because it records
    every board mutation; this table records deliberate admin actions and grows
    by a handful of rows a month, so a retention job would be machinery with
    nothing to do. Retention *policy* tooling is an enterprise concern per the
    open-core boundary — if volume ever justifies pruning (e.g. once #785 adds
    impersonation events), that is the point to revisit, not before.

    Known gap
    ---------
    ``SiteSetting`` can also be written directly from ``manage.py shell`` or any
    other raw ORM caller. Those writes are structurally unauditable here: the
    only choke point that sees all of them is ``SiteSetting.save()``, which has
    no actor to record. Every deliberate operator path (admin API, the
    ``maintenance_mode`` command, Django admin) is instrumented; a raw ORM write
    is not. An empty log therefore means "no audited path made this change",
    not "nothing happened".
    """

    class Action(models.TextChoices):
        """Vocabulary for ``action``, as ``<subject>.<verb>`` (matching the
        WebSocket event-name convention used elsewhere in the project).

        Deliberately NOT passed to the field as ``choices=``. Django emits no
        database constraint from ``choices`` — only a Python-level validator and
        a migration on every enum edit — so declaring it here and validating at
        the serializer boundary costs nothing and keeps history verbatim, the
        same trade ``BoardExportLog.role_at_export`` and ``BoardEvent.event``
        already make. Adding #785's impersonation action is then an enum
        addition, not a schema change.
        """

        MAINTENANCE_MODE_ENABLED = "maintenance_mode.enabled", "Maintenance mode enabled"
        MAINTENANCE_MODE_DISABLED = "maintenance_mode.disabled", "Maintenance mode disabled"
        MAINTENANCE_MESSAGE_CHANGED = "maintenance_message.changed", "Maintenance notice changed"
        REGISTRATION_MODE_CHANGED = "registration_mode.changed", "Registration mode changed"
        UPLOADS_ENABLED = "uploads_enabled.enabled", "File uploads enabled"
        UPLOADS_DISABLED = "uploads_enabled.disabled", "File uploads disabled"

    class Source(models.TextChoices):
        """Which operator path performed the action."""

        ADMIN_API = "admin_api", "Admin REST API"
        DJANGO_ADMIN = "django_admin", "Django admin site"
        CLI = "cli", "Management command"

    action = models.CharField(
        max_length=64,
        help_text=(
            "What happened, as '<subject>.<verb>'. One of: maintenance_mode.enabled, "
            "maintenance_mode.disabled, maintenance_message.changed, "
            "registration_mode.changed, uploads_enabled.enabled, uploads_enabled.disabled. "
            "Validated at the serializer boundary, not by a column constraint."
        ),
    )
    actor_id = models.BigIntegerField(
        null=True,
        blank=True,
        help_text=(
            "User who performed the action; NULL when there was no authenticated "
            "actor (e.g. a management command). Deliberately not a ForeignKey — "
            "see the model docstring."
        ),
    )
    actor_username = models.CharField(
        max_length=150,
        blank=True,
        default="",
        help_text=(
            "Username captured at write time so the actor stays identifiable after "
            "the account is deleted. Blank when there was no authenticated actor."
        ),
    )
    source = models.CharField(
        max_length=20,
        default=Source.ADMIN_API,
        help_text="Operator path used: admin_api, django_admin, or cli.",
    )
    metadata = models.JSONField(
        default=dict,
        blank=True,
        help_text=(
            "Action-specific detail — e.g. {'from': ..., 'to': ...} for a changed "
            "value. Keys are additive-only: never remove or repurpose one, since "
            "existing rows are never rewritten."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "admin_action_logs"
        # The `-id` tiebreak is load-bearing, not decoration: a single PATCH that
        # both enables maintenance mode and edits the notice writes two rows with
        # the same auto_now_add timestamp. Ordering on created_at alone leaves
        # their relative order undefined, which lets an offset-paginated read
        # drop or repeat one across a page boundary.
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["-created_at"], name="aal_created_idx"),
            models.Index(fields=["action", "-created_at"], name="aal_action_created_idx"),
        ]

    def __str__(self):
        return f"{self.action} by {self.actor_username or '<system>'} @ {self.created_at}"

    @classmethod
    def record(cls, *, action, source, actor=None, metadata=None):
        """Append one audit row.

        ``actor`` is a ``User`` or ``None``; only its pk and username are read,
        so an ``AnonymousUser`` degrades to the no-actor case rather than raising.
        """
        username = getattr(actor, "username", "") or ""
        return cls.objects.create(
            action=action,
            actor_id=getattr(actor, "pk", None),
            actor_username=username[:150],
            source=source,
            metadata=metadata or {},
        )


def record_site_setting_changes(*, before: dict, after, actor, source) -> list:
    """Append an audit row for each audited SiteSetting field that actually changed.

    ``before`` is a :func:`snapshot_site_setting` dict taken before mutation;
    ``after`` is the saved instance.

    Only real transitions are recorded. A PATCH that sets ``maintenance_mode``
    to the value it already held writes nothing — an audit log padded with
    non-events makes "how long were we in maintenance?" unanswerable, because
    every row then looks like a transition. This is also why the diff is done
    here rather than from ``update_fields``: a field can be *submitted* without
    being *changed*.

    Callers must invoke this inside the same transaction as the save, so a
    rolled-back change cannot leave behind a row claiming it happened.
    """
    Action = AdminActionLog.Action
    pending: list[tuple[str, dict]] = []

    if before["maintenance_mode"] != after.maintenance_mode:
        enabling = after.maintenance_mode
        # The notice users actually saw, so a retro can read it off this row
        # without correlating with a separate message.changed row.
        #
        # Which side that is depends on direction, and getting it wrong is easy:
        # when enabling, it is the new notice (what users are about to be
        # shown); when disabling, it is the OLD one (what they were shown for
        # the duration of the window). A single PATCH that both clears the
        # notice and switches maintenance off would otherwise record the
        # disable with an empty message and lose what was displayed.
        message = after.maintenance_message if enabling else before["maintenance_message"]
        pending.append((
            Action.MAINTENANCE_MODE_ENABLED if enabling else Action.MAINTENANCE_MODE_DISABLED,
            {"message": (message or "")[:MAINTENANCE_MESSAGE_MAX_LENGTH]},
        ))

    if before["maintenance_message"] != after.maintenance_message:
        pending.append((
            Action.MAINTENANCE_MESSAGE_CHANGED,
            {
                "from": (before["maintenance_message"] or "")[:MAINTENANCE_MESSAGE_MAX_LENGTH],
                "to": (after.maintenance_message or "")[:MAINTENANCE_MESSAGE_MAX_LENGTH],
            },
        ))

    if before["registration_mode"] != after.registration_mode:
        pending.append((
            Action.REGISTRATION_MODE_CHANGED,
            {"from": before["registration_mode"], "to": after.registration_mode},
        ))

    if before["uploads_enabled"] != after.uploads_enabled:
        pending.append((
            Action.UPLOADS_ENABLED if after.uploads_enabled else Action.UPLOADS_DISABLED,
            {},
        ))

    return [
        AdminActionLog.record(action=action, source=source, actor=actor, metadata=metadata)
        for action, metadata in pending
    ]
