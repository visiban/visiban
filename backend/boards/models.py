import hashlib
import logging
import types
import uuid

from django.contrib.postgres.indexes import GinIndex
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models, transaction
from django.db.models.signals import post_delete, pre_delete
from django.dispatch import receiver
from django.utils import timezone
from django.conf import settings

from boards.uid import _generate_uid

logger = logging.getLogger(__name__)


class BoardTemplate(models.Model):
    """
    A pre-configured board layout that users can select at board creation time.
    Templates are seeded via a data migration and are not user-editable —
    they are applied once at board creation to create columns and a first swimlane.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=100)
    slug = models.SlugField(max_length=100, unique=True)
    description = models.CharField(max_length=120)
    icon = models.CharField(max_length=32, blank=True)
    lane_label = models.CharField(
        max_length=50, blank=True,
        help_text="Label shown in the swimlane prompt (e.g. 'Account', 'Project').",
    )
    lane_placeholder = models.CharField(
        max_length=100, blank=True,
        help_text="Placeholder text in the first-swimlane name input.",
    )
    columns_json = models.JSONField(
        default=list,
        help_text="Ordered list of column dicts: [{name, color, position}].",
    )
    sort_order = models.PositiveSmallIntegerField(default=0)
    is_active = models.BooleanField(default=True)

    class Meta:
        db_table = "board_templates"
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name


class Board(models.Model):
    """A kanban board containing columns, swimlanes, cards, and members."""

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="owned_boards"
    )
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL, through="BoardMembership", related_name="boards"
    )
    group = models.ForeignKey(
        "groups.Group", null=True, blank=True, on_delete=models.SET_NULL, related_name="boards"
    )
    staleness_threshold_days = models.PositiveIntegerField(default=7)
    stale_warning_pct = models.PositiveSmallIntegerField(
        default=50,
        validators=[MaxValueValidator(100)],
        help_text=(
            "Percentage of staleness_threshold_days at which heatmap cells turn yellow. "
            "At 100% of the threshold they turn red. Must be 0–100."
        ),
    )
    allowed_priorities = models.JSONField(
        default=list,
        help_text="Allowed card priorities on this board. Empty list means all priorities are allowed.",
    )
    enforce_wip_limits = models.BooleanField(
        default=True,
        help_text=(
            "When enabled, moving, creating, or restoring a card into a column at or over its "
            "WIP limit is blocked with a 409 response, as is saving a card in the Django admin. "
            "Board admins can override with ?force=true (not in the Django admin). "
            "Board import is not checked."
        ),
    )
    enforce_wip_hard = models.BooleanField(
        default=False,
        help_text=(
            "When True, WIP limits become a hard stop for all roles including board admins. "
            "No override is possible. Active regardless of enforce_wip_limits."
        ),
    )
    enforce_weight_limits = models.BooleanField(
        default=True,
        help_text=(
            "When enabled, moving, creating, or restoring a card into a column that would exceed "
            "its weight budget, or raising a card's weight with PATCH/PUT, is blocked with a 409 "
            "response, as is saving a card in the Django admin. Board admins can override with "
            "?force=true (not in the Django admin). Board import is not checked."
        ),
    )
    share_token = models.UUIDField(
        null=True, blank=True, default=None, editable=False, unique=True,
        help_text="Public share token. Null means sharing is disabled. Never set directly — use the share action.",
    )
    # SHA-256 of the share token (#1880), the value public share links are
    # resolved by, as the invite models resolve theirs by ``token_hash``. Set
    # and cleared together with ``share_token`` (``issue_share_token``,
    # ``SHARE_LINK_CLEARED``). ``share_token`` itself stays for the admin-only
    # API fields that return it and is not used to look a link up. No
    # field-level unique/index: the unique constraint in Meta.constraints is
    # built concurrently in its own migration. Never serialized.
    share_token_hash = models.CharField(
        max_length=64, null=True, blank=True, default=None, editable=False,
    )
    share_token_expires_at = models.DateTimeField(
        null=True, blank=True, default=None,
        help_text=(
            "Optional TTL on the public share link (#804). Null means the token "
            "never expires. Past this timestamp the share endpoint returns 410 "
            "Gone — the token is not auto-rotated, only refused."
        ),
    )
    # The admin who enabled the current share link (#1865). The link lasts only
    # while that account keeps the standing that let it enable sharing (active,
    # and board admin or site admin on this board): losing it clears the link
    # (``boards.services.share_links.revoke_lapsed_share_links``) and the public view
    # re-checks it on every read. A link with NULL here (enabled before this
    # field existed) has no standing: the public view refuses and clears it
    # until a board admin enables sharing again (#1939). SET_NULL alone would
    # turn a deleted enabler's link into such a link, so a pre_delete receiver
    # clears the link first. db_index=False: the partial index in Meta.indexes
    # is built concurrently in its own migration. Never serialized.
    share_enabled_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+", db_index=False, editable=False,
    )
    class ExportMinRole(models.TextChoices):
        """Board-relative roles accepted as an export threshold (#843, #1725).

        The allowed set for the serializer field, the admin form and the model
        field; a test ties the export gate's rank table to the same values.
        ``site_admin`` and ``owner`` are deliberately absent: they always
        bypass the threshold, so they are not meaningful setting values.
        """
        VIEWER = "viewer"
        COLLABORATOR = "collaborator"
        MEMBER = "member"
        ADMIN = "admin"

    export_min_role = models.CharField(
        max_length=20,
        default="viewer",
        choices=ExportMinRole.choices,
        help_text=(
            "Minimum BoardMembership.Role required to export this board (#843). "
            "Limits only the export action and its file formats (board and "
            "movement exports); it does not change what a member can read "
            "through the board, card list, or MCP endpoints. "
            "Default ``viewer`` preserves pre-1.1 behavior where every role with "
            "read access can export. Owners and site admins always bypass this "
            "threshold. The valid values are viewer / collaborator / member / "
            "admin — validated at the serializer layer; a stored value outside "
            "that set is treated as admin-only by the export gate."
        ),
    )
    card_density = models.CharField(
        max_length=20,
        default="comfortable",
        help_text=(
            "Per-board card layout density (#961). Drives how much metadata "
            "renders on the card face: ``comfortable`` shows one urgency badge "
            "and one primary label, ``standard`` adds due date and weight, "
            "``dense`` shows everything (today's pre-1.1 layout). New boards "
            "default to ``comfortable`` so first-time users get the cleaner "
            "scan; existing boards are migrated to ``dense`` to preserve their "
            "current visual. The middle tier is named ``standard`` rather than "
            "``compact`` to avoid colliding with the per-user *Card layout: "
            "Compact / Expanded* toolbar pref. Validated at the serializer layer."
        ),
    )
    # ``db_default`` keeps the DB-level default so an old pod's INSERT that omits
    # this column survives a rolling deploy (#1661).
    show_wip_at_limit = models.BooleanField(
        default=False,
        db_default=False,
        help_text=(
            "When enabled, a column's header stat row shows a calm 'WIP n/n' "
            "indicator (in place of the normal card count) once the column's "
            "card count exactly equals its wip_limit (#973). Purely ambient — "
            "does not affect move enforcement, which is controlled by "
            "enforce_wip_limits / enforce_wip_hard. Off by default so existing "
            "boards are unchanged."
        ),
    )
    # ``db_default`` as well as ``default``: AddField with only ``default`` drops
    # the column default after backfilling, so an older pod creating a board
    # mid-rolling-deploy (its INSERT omits this column) would hit NOT NULL.
    show_row_chip_field_names = models.BooleanField(
        default=True,
        db_default=True,
        help_text=(
            "When enabled (the default), pinned custom-field chips on a "
            "swimlane row label each value with its field name, e.g. "
            "'AD: Diane Foster' (#1418). When disabled, row chips show the "
            "value alone; the name stays in the chip tooltip, for screen "
            "readers, and in the row's field list. Checkbox fields always "
            "show their name. Board-level admin setting, not a per-viewer "
            "preference; card-face chips are unaffected."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "boards"
        ordering = ["-updated_at"]
        indexes = [
            # Serves the enabler lookup when an account loses access, and the
            # SET_NULL update on account delete. Partial: only boards whose
            # share link records its enabler have a value.
            models.Index(
                fields=["share_enabled_by"],
                name="board_share_enabled_by_idx",
                condition=models.Q(share_enabled_by__isnull=False),
            ),
        ]
        constraints = [
            # Serves the public share-link lookup (#1880). Partial: only boards
            # with a share link have a hash, and a partial unique constraint is
            # a plain unique index on every backend, which boards/0089 builds
            # with CREATE UNIQUE INDEX CONCURRENTLY.
            models.UniqueConstraint(
                fields=["share_token_hash"], name="board_share_token_hash_uniq",
                condition=models.Q(share_token_hash__isnull=False),
            ),
        ]

    #: The column values of a board with no share link. Every route that
    #: clears a link writes all four, so the hash a link is resolved by never
    #: outlives its token (#1880).
    SHARE_LINK_CLEARED = types.MappingProxyType({
        "share_token": None,
        "share_token_hash": None,
        "share_token_expires_at": None,
        "share_enabled_by": None,
    })
    #: The share-link columns, for ``update_fields`` and ``refresh_from_db``.
    SHARE_LINK_FIELDS = tuple(SHARE_LINK_CLEARED)

    def __str__(self):
        return self.name

    @staticmethod
    def hash_share_token(token):
        """Return the stored hash of a share token (#1880).

        SHA-256 hex, the scheme the invite models use for ``token_hash``, over
        the canonical UUID string (lowercase, hyphenated), so every spelling
        ``uuid.UUID`` accepts for one token hashes the same. Raises
        ``ValueError`` for a value that is not a UUID. Migration
        ``boards/0088_backfill_board_share_token_hash`` inlines this; a test
        keeps the two in step.
        """
        canonical = str(token if isinstance(token, uuid.UUID) else uuid.UUID(str(token)))
        return hashlib.sha256(canonical.encode()).hexdigest()

    def issue_share_token(self):
        """Set a fresh share token and its hash on this instance; return the token.

        Does not save: the caller saves ``share_token`` and
        ``share_token_hash`` (with any other share fields) in one write.
        """
        token = uuid.uuid4()
        self.share_token = token
        self.share_token_hash = self.hash_share_token(token)
        return token

    def clear_share_link(self):
        """Set every share-link column to its cleared value on this instance (no save)."""
        for name, value in self.SHARE_LINK_CLEARED.items():
            setattr(self, name, value)

    def has_live_share_link(self):
        """True when this board has a share link that can resolve.

        The single rule behind both ``/full/``'s ``share_link_active``
        (``BoardFullSerializer._has_live_share_link``) and the ``active`` flag
        of the ``share_link.updated`` event
        (``boards.services.share_links.share_link_state_payload``), so the two
        cannot drift apart. A link with no recorded enabler never resolves
        (#1939), so it counts as no link. If this rule is ever re-derived
        (for example from ``share_token_hash`` once the stored token goes),
        change it here and both readers follow.
        """
        return self.share_token is not None and self.share_enabled_by_id is not None


class BoardMembership(models.Model):
    """Junction table recording a user's role on a board.

    Role hierarchy (highest to lowest):
      - ADMIN       Full board control: manage members, columns, swimlanes, labels,
                    board settings, and all card operations.
      - MEMBER      Create, edit, move, archive, and delete cards (own cards or any
                    card when is_moderator=True). Add/delete comments, attachments,
                    and checklist items.
      - COLLABORATOR  Read-only access to cards. May add/delete own comments,
                    add/delete own attachments, and add/edit/delete checklist items.
                    Cannot create, update, move, or delete cards.
      - VIEWER      Read-only. Cannot add comments, attachments, or checklist items.

    The COLLABORATOR role is intentionally distinct from MEMBER: it is suited for
    external contributors (e.g. contractors, support staff) who need to annotate
    work without being able to change card state.  This distinction is enforced in
    CardViewSet (perform_create, update, move, archive) and is the stable public
    API contract from 1.0 onward.
    """

    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MEMBER)
    is_moderator = models.BooleanField(
        default=False,
        help_text="Grants content-moderation rights (delete/archive others' content) without full admin.",
    )
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "board_memberships"
        unique_together = ["board", "user"]


class BoardInviteLink(models.Model):
    """A board-scoped invite token that grants a board role on redemption (#1444).

    The third invite kind beside the site ``InviteLink`` (``vbnl_``) and the
    ``GroupInviteLink`` (``vbng_``); its tokens carry the ``vbnb_`` prefix.
    Only the SHA-256 of the raw token is stored. The raw value travels once —
    in the invite email — and is never returned by the API.

    Roles are deliberately capped at member/collaborator/viewer: an invite is a
    bearer credential, and a forwarded email must never be able to mint a
    board admin.

    ``delivery`` supports ``link`` for the shareable multi-use links of #439;
    #1444 itself only mints ``email`` invites (single-use, one address).

    An emailed invite is bound to the address it was sent to (#1678): only a
    keyed hash of that address is stored (``recipient_hash``), and redemption
    compares it with the redeeming account's addresses. Shareable links store
    NULL and stay usable by whoever holds them.
    """

    BOARD_INVITE_PREFIX = "vbnb_"

    class Delivery(models.TextChoices):
        LINK = "link"
        EMAIL = "email"

    class Role(models.TextChoices):
        MEMBER = "member"
        COLLABORATOR = "collaborator"
        VIEWER = "viewer"

    #: The only roles an invite may ever grant. Enforced in ``generate()`` and
    #: again at redemption, not just in the serializer, so no future caller
    #: (shareable links, #439; a management command) can mint or honor an
    #: admin-granting bearer token.
    GRANTABLE_ROLES = frozenset(Role.values)

    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="invite_links")
    token_hash = models.CharField(max_length=64, unique=True)
    # First 8 chars of the raw token ("vbnb_XXX") — safe for display.
    prefix = models.CharField(max_length=8)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        related_name="created_board_invite_links",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    name = models.CharField(max_length=100, blank=True, default="")
    role = models.CharField(max_length=20, choices=Role.choices, default=Role.MEMBER)
    # Nullable at the column level for #439's shareable links; the email send
    # path always sets it.
    expires_at = models.DateTimeField(null=True, blank=True)
    single_use = models.BooleanField(default=False)
    used_at = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    revoked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="revoked_board_invite_links",
    )
    # Successful redemptions, for audit; a single-use invite stops at 1.
    use_count = models.PositiveIntegerField(default=0)
    delivery = models.CharField(max_length=8, choices=Delivery.choices, default=Delivery.LINK)
    # Keyed hash of the emailed invite's address (#1678; see
    # visiban/invite_recipient.py). NULL for shareable links and for emailed
    # invites minted before #1678, which redeem as they always have. Never
    # serialized.
    recipient_hash = models.CharField(max_length=64, null=True, blank=True, editable=False)
    # The account this emailed invite is waiting on (#1704). Under
    # EMAIL_VERIFICATION=mandatory, registering with the invited address while
    # it is still unverified records the new account here instead of granting
    # the membership; the grant happens when that account confirms the invited
    # address (``boards.invites.redeem_reserved_board_invites``). NULL in every
    # other case. SET_NULL: deleting the account releases the invite.
    # db_index=False because the index is declared in Meta.indexes (partial)
    # and built concurrently in its own migration. Never serialized.
    reserved_for = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="+", db_index=False, editable=False,
    )

    class Meta:
        db_table = "board_invite_links"
        indexes = [
            # Serves the confirmation lookup and the SET_NULL update on account
            # delete. Partial: only invites awaiting a confirmation have a value.
            models.Index(
                fields=["reserved_for"],
                name="board_invite_reserved_for_idx",
                condition=models.Q(reserved_for__isnull=False),
            ),
        ]
        constraints = [
            # Same invariant as GroupInviteLink: only a single-use invite can be
            # consumed, so a stamped used_at on a multi-use link (which would
            # report it "used" and block every later join) cannot be written.
            models.CheckConstraint(
                condition=models.Q(single_use=True) | models.Q(used_at__isnull=True),
                name="board_invite_link_used_at_requires_single_use",
            ),
        ]

    @property
    def is_expired(self):
        from django.utils import timezone

        return self.expires_at is not None and self.expires_at < timezone.now()

    @property
    def status(self):
        """pending / used / expired / revoked, with the precedence the site and
        group invite models use: revoked > used > expired > pending."""
        if self.revoked_at:
            return "revoked"
        if self.used_at:
            return "used"
        if self.is_expired:
            return "expired"
        return "pending"

    @classmethod
    def _hash_token(cls, raw_token):
        import hashlib

        return hashlib.sha256(raw_token.encode()).hexdigest()

    @classmethod
    def generate(
        cls, board, created_by, *, role=None, expires_at=None, single_use=False,
        delivery=None, name="", recipient_email=None,
    ):
        """Create an invite with a hashed token. Returns ``(instance, raw_token)``.

        ``recipient_email`` (the send-invite endpoint's address) binds the
        invite to that address (#1678); only its keyed hash is stored.
        """
        import secrets

        from visiban.invite_recipient import hash_recipient

        role = role or cls.Role.MEMBER
        if role not in cls.GRANTABLE_ROLES:
            raise ValueError(f"A board invite cannot grant the role {role!r}.")
        delivery = delivery or cls.Delivery.LINK
        recipient_hash = hash_recipient(recipient_email)
        # An emailed invite is always bound to its address (#1678): minting one
        # without an address would silently create an invite anyone can use.
        if delivery == cls.Delivery.EMAIL and recipient_hash is None:
            raise ValueError("An emailed board invite needs a recipient_email.")
        raw = cls.BOARD_INVITE_PREFIX + secrets.token_hex(20)
        instance = cls.objects.create(
            board=board,
            created_by=created_by,
            token_hash=cls._hash_token(raw),
            prefix=raw[:8],
            name=name,
            role=role,
            expires_at=expires_at,
            single_use=single_use,
            delivery=delivery,
            recipient_hash=recipient_hash,
        )
        return instance, raw

    @classmethod
    def lookup_by_token(cls, raw_token):
        """Return the invite for ``raw_token`` whatever its state, or None.

        Unlike ``GroupInviteLink.lookup_by_token`` this also returns revoked
        invites: the join endpoints answer a known-but-unusable token with
        ``410 {code: "revoked"}`` rather than a 404 (#1444). Read-only — the
        join path takes its own row lock.
        """
        try:
            return cls.objects.select_related("created_by", "board").get(
                token_hash=cls._hash_token(raw_token),
            )
        except cls.DoesNotExist:
            return None


class BoardInviteRedemption(models.Model):
    """Durable record of who redeemed a board invite, and what it granted (#1444).

    The ``member.added`` change-feed row also names the invite, but the board
    event feed is pruned after 30 days; this table is the provenance that
    survives. ``membership_created`` is False when the redeemer already had
    equal or higher access and nothing was granted. No column is added to
    ``board_memberships`` for this.
    """

    class Via(models.TextChoices):
        JOIN = "join"
        REGISTRATION = "registration"

    invite = models.ForeignKey(BoardInviteLink, on_delete=models.CASCADE, related_name="redemptions")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True,
        related_name="board_invite_redemptions",
    )
    role_granted = models.CharField(max_length=20)
    membership_created = models.BooleanField(default=False)
    via = models.CharField(max_length=16, choices=Via.choices)
    redeemed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "board_invite_redemptions"
        constraints = [
            models.UniqueConstraint(fields=["invite", "user"], name="board_invite_redemption_unique_user"),
        ]


class BoardFavorite(models.Model):
    """Records that a user has starred a board; unique per user-board pair."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="board_favorites"
    )
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="favorites")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "board_favorites"
        unique_together = ["user", "board"]


class Column(models.Model):
    """A vertical stage column on a board (e.g. Backlog, In Progress, Done)."""

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="columns")
    name = models.CharField(max_length=255)
    position = models.IntegerField(default=0)
    color = models.CharField(max_length=7, default="#6B7280")
    wip_limit = models.IntegerField(null=True, blank=True)
    weight_limit = models.IntegerField(null=True, blank=True)
    allow_card_creation = models.BooleanField(default=False)
    is_done = models.BooleanField(
        default=False,
        help_text="Columns marked as done are used as completion targets for cycle-time and throughput metrics.",
    )
    # Explicit column policy (#1101): entry criteria and definition of done,
    # one versioned JSON object, shape and rules in boards.column_policy.
    # Nullable with no default, so the column is catalog-only on PostgreSQL
    # and an older pod's INSERT that omits it stores NULL (no policy).
    policy = models.JSONField(null=True, blank=True, default=None)

    class Meta:
        db_table = "columns"
        ordering = ["position"]
        unique_together = [["board", "position"], ["board", "name"]]

    def __str__(self):
        return f"{self.board.name} / {self.name}"

    def clean(self):
        # The Django admin edits ``policy`` as raw JSON; hold it to the same
        # shape the API enforces (#1101) and store the normalized form.
        from .column_policy import PolicyError, normalize_policy

        super().clean()
        try:
            self.policy = normalize_policy(self.policy)
        except PolicyError as exc:
            raise ValidationError({"policy": str(exc)}) from None


class Swimlane(models.Model):
    """A horizontal row grouping cards on a board, typically representing a customer or workstream."""

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="swimlanes")
    name = models.CharField(max_length=255)
    contact_email = models.EmailField(blank=True)
    notes = models.TextField(blank=True)
    position = models.IntegerField(default=0)
    color = models.CharField(max_length=7, default="#3B82F6")
    is_collapsed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class LimitEnforcement(models.TextChoices):
        """How a swimlane's own limits are enforced (#1150).

        The two column modes, chosen per lane. ``NULL`` (no choice) inherits
        the board flags exactly as a column does, so a board that never sets
        this behaves as before. A warn-only mode was deliberately left out of
        1.3 (#2048): adding a value later is additive, removing one is not.
        """

        BLOCK = "block", "Block (board admins can override)"
        HARD = "hard", "Hard (no override for any role)"

    # Per-row limits (#1150). All four are nullable with no default, so the
    # columns are catalog-only on PostgreSQL and an older pod's INSERT that
    # omits them stores NULL: no limit, which is today's behavior. The rules
    # they feed live in ``boards.services.cards.enforce_column_limits``; the
    # OpenAPI descriptions in ``visiban.field_enforcement``.
    wip_limit = models.IntegerField(null=True, blank=True, validators=[MinValueValidator(1)])
    weight_limit = models.IntegerField(null=True, blank=True, validators=[MinValueValidator(1)])
    limit_enforcement = models.CharField(
        max_length=8, null=True, blank=True, default=None, choices=LimitEnforcement.choices,
    )
    # Which columns' cards count toward this row's limits: a list of column
    # ids, or NULL for "every column not marked done". Ids rather than names
    # so a rename or reorder never changes what counts. A column delete
    # removes its id (``boards.signals.prune_swimlane_limit_columns``).
    limit_column_ids = models.JSONField(null=True, blank=True, default=None)

    class Meta:
        db_table = "swimlanes"
        ordering = ["position"]
        unique_together = ["board", "name"]

    def __str__(self):
        return self.name

    def counts_column(self, column):
        """Whether cards in ``column`` count toward this row's limits."""
        if self.limit_column_ids is None:
            return not column.is_done
        if not isinstance(self.limit_column_ids, list):
            # Only a raw ORM write can store a non-list (the API, admin and
            # import validate it). Fail closed: every column counts.
            return True
        return column.pk in self.limit_column_ids


class Label(models.Model):
    """A color-coded tag that can be applied to cards on a board."""

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="labels")
    name = models.CharField(max_length=50)
    color = models.CharField(max_length=7, default="#EAB308")

    class Meta:
        db_table = "labels"
        unique_together = ["board", "name"]

    def __str__(self):
        return self.name


class Card(models.Model):
    """A work item positioned in a column/swimlane cell on a board."""

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)

    class Priority(models.TextChoices):
        """Priority levels available for a card."""
        LOW = "low"
        MEDIUM = "medium"
        HIGH = "high"
        URGENT = "urgent"

    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="cards")
    column = models.ForeignKey(Column, on_delete=models.CASCADE, related_name="cards")
    swimlane = models.ForeignKey(Swimlane, on_delete=models.CASCADE, related_name="cards")
    title = models.CharField(max_length=500)
    description = models.TextField(blank=True)
    priority = models.CharField(max_length=10, choices=Priority.choices, default=Priority.MEDIUM)
    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_cards",
    )
    labels = models.ManyToManyField(Label, blank=True, related_name="cards")
    due_date = models.DateField(null=True, blank=True)
    weight = models.IntegerField(default=1)
    position = models.IntegerField(default=0)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        related_name="created_cards",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Optimistic concurrency control — incremented by a field update
    # (update_card), a block or unblock (block_card/unblock_card, #1149), a
    # move (move_card) and a Django admin change save
    # (CardAdmin.save_model, #2040, including one that only archives or
    # restores) only; archive_card/unarchive_card, comments, attachments,
    # checklists and relations leave it unchanged.
    # Clients send the version they have; the server rejects the request with
    # 409 if it has been modified in the meantime. The web client also drops a
    # card copy whose version is lower than the one it holds (#1969), so the
    # value must never go down.
    # Source of change: Gemini Pro external codebase review (2026-04-01).
    version = models.PositiveIntegerField(default=1)
    # Soft-delete: set when a card is archived; null for active cards.
    # Analytics uses this as the terminal timestamp so dwell time reflects
    # only the active period, not the time since archiving.
    archived_at = models.DateTimeField(null=True, blank=True, db_index=True)
    # Re-notification guard for description @mentions.
    # Stores the PKs of users already notified for a mention in this card's
    # description; prevents duplicate notifications when the description is
    # edited without removing an existing @username.
    mentioned_user_ids = models.JSONField(default=list, blank=True)
    # Manual blocked state (#1149), denormalized from the open ``CardBlock``
    # row so the board payload reads it from the card row with no join. Both
    # are written only by ``services.cards.block_card`` / ``unblock_card``,
    # which keep them in step with ``CardBlock`` under the card lock; the
    # REST serializer treats them as read-only. ``blocked_at`` NULL means
    # "not manually blocked" — a relation block (#449) is separate and is
    # counted by ``blocker_count``. db_default on the reason so an INSERT from
    # an older release during a rolling upgrade still succeeds.
    blocked_at = models.DateTimeField(null=True, blank=True)
    blocked_reason = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
        db_default="",
    )

    class Meta:
        db_table = "cards"
        ordering = ["position"]
        indexes = [
            # Composite index to speed up WIP count queries: filter by board + column,
            # then filter active cards (archived_at IS NULL). Avoids a full table scan
            # when enforcement is enabled and card moves are frequent.
            models.Index(fields=["board", "column", "archived_at"], name="card_board_col_archived_idx"),
            # Supports the cross-board card query endpoint (#1112): filtering by
            # board and ordering/cursoring on updated_at (?board=, ?updated_since=,
            # cursor pagination on (updated_at, id)). Partial + descending because
            # both existing card-list consumers (CardViewSet.get_queryset(),
            # BoardFullSerializer.get_cards()) — and the dominant query shape on the
            # new endpoint, since include_archived defaults off — filter out archived
            # cards; indexing the (usually much smaller) active-card subset only keeps
            # the index cheaper to build and maintain. Built CONCURRENTLY per #1081 —
            # see the migration that adds this index.
            models.Index(
                fields=["board", "-updated_at"],
                name="card_board_updated_idx",
                condition=models.Q(archived_at__isnull=True),
            ),
            # Trigram indexes for server-side card search. They serve ILIKE on
            # the bare columns, not Django's icontains (which PostgreSQL gets as
            # UPPER(col) LIKE). Card search therefore filters with the
            # ``ci_contains`` lookup (boards/lookups.py), which renders ILIKE on
            # PostgreSQL (#1809). Verified once on PostgreSQL 17 (60k cards, 20
            # boards) against the real GET /api/v1/cards/ query (board_id IN,
            # ORDER BY updated_at DESC, id DESC, LIMIT 51): a selective term
            # plans a BitmapOr over both trigram indexes, not card_board_updated_idx.
            # Broad terms (e.g. "the") and 1-2 character terms still seq-scan and
            # may be slower than before (ILIKE folds case per row; icontains
            # evaluated UPPER on the constant once). Board search-as-you-type has
            # no minimum term length, so short terms always take that path.
            # Re-measurement is tracked in #2063.
            # Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm (migration 0030).
            GinIndex(fields=["title"], name="card_title_trgm_idx", opclasses=["gin_trgm_ops"]),
            GinIndex(fields=["description"], name="card_desc_trgm_idx", opclasses=["gin_trgm_ops"]),
        ]

    def __str__(self):
        return self.title


def set_null_keeping_board(collector, field, sub_objs, using):
    """``on_delete`` for ``CardMovement.card``: SET_NULL that keeps the row reachable (#1469).

    A movement written by an older release during a rolling upgrade has no
    ``board`` or card snapshot yet. Plain SET_NULL would leave such a row with
    neither a card nor a board: hidden from the board's History and never
    removed with the board. So, before the card goes, fill ``board`` and the
    snapshot on exactly those rows, from the card being deleted, then defer to
    SET_NULL. For every row written by this release the extra UPDATE matches
    nothing (one indexed statement per deleted batch of cards).

    Skipped for the admin's ``NestedObjects``, which runs the collector only
    to list what a delete would remove (on a GET) and must not write.
    Python-level only: ``on_delete`` emits no SQL, like SET_NULL.
    """
    from django.contrib.admin.utils import NestedObjects

    if not isinstance(collector, NestedObjects):
        card = Card.objects.using(using).filter(pk=models.OuterRef("card_id"))
        sub_objs.filter(board__isnull=True).update(
            board_id=models.Subquery(card.values("board_id")[:1]),
            card_uid=models.Subquery(card.values("uid")[:1]),
            card_title=models.Subquery(card.values("title")[:1]),
        )
    models.SET_NULL(collector, field, sub_objs, using)


# Like SET_NULL: the collector need not evaluate sub_objs before calling this.
set_null_keeping_board.lazy_sub_objs = True


class AppendOnlyViolation(Exception):
    """An application write tried to change or delete a ``CardMovement`` (#1469)."""


class CardMovement(models.Model):
    """
    Automatic audit log entry created whenever a card is moved between
    columns and/or swimlanes. Full pipeline movement history with timestamps.

    The FK fields (from_column, to_column, from_swimlane, to_swimlane) use
    SET_NULL so that deleting a column or swimlane does not cascade-delete the
    movement history. The corresponding *_name fields are denormalized copies of
    the names at write time, ensuring the human-readable history is preserved
    even after the referenced column/swimlane is deleted.

    The movement_type field distinguishes regular moves from archive/restore
    system events. This allows history consumers to filter out system events
    (e.g. exclude_type=archived,unarchived) and focus on workflow transitions.

    Append-only (#1469). Hard-deleting a card keeps its movements: ``card`` is
    SET_NULL and ``card_uid`` / ``card_title`` keep the card identifiable.
    Only deleting the whole board removes them, through ``board`` (CASCADE),
    apart from an operator's audited ``purge_card_history`` run (#1797).
    ``save()`` refuses to update an existing row and ``delete()`` always
    refuses; both are a guard against accidental application writes, not
    tamper-proofing — a queryset ``update()``/``delete()`` bypasses them, and
    the deletion collector relies on that (SET_NULL is a queryset update).
    """

    # Mutation testing (#1503): the no-mutate pragmas below mark a schema
    # constant (max_length, blank, db_index, related_name, index definition)
    # that no behavioral test can observe and that CI `migration-check` already
    # guards. The pragma is per physical line, so each field is split so that
    # the constants sit on their own lines and the behavioral arguments
    # (default, on_delete, null, choices) stay mutated and tested.
    class MovementType(models.TextChoices):
        MOVE = "move", "Move"
        ARCHIVED = "archived", "Archived"
        UNARCHIVED = "unarchived", "Unarchived"

    # SET_NULL, not CASCADE (#1469): a hard-deleted card keeps its history.
    # The row then reads its identity from card_uid / card_title below.
    # set_null_keeping_board is SET_NULL plus filling board and the snapshot
    # on rows that lack them (rows an older release wrote mid-upgrade).
    card = models.ForeignKey(
        Card,
        on_delete=set_null_keeping_board,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        related_name="movements",  # pragma: no mutate -- schema constant (migration-check)
    )
    # The board the movement happened on, captured at write time (#1469). It is
    # what still ties a deleted card's history to its board: the board-level
    # History reads by it, and deleting the board cascades through it. Nullable
    # only because rows predating migration 0080's backfill (or written by an
    # older release during a rolling upgrade) may not carry it yet.
    board = models.ForeignKey(
        Board,
        on_delete=models.CASCADE,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        db_index=False,  # pragma: no mutate -- schema constant (migration-check)
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    # The card's uid and title at the time of the movement (#1469), parallel to
    # the *_column_name / *_column_uid snapshots below. Read only when ``card``
    # is NULL; a live card's current uid/title is served instead, so payloads
    # for live cards are unchanged. db_default so an INSERT from an older
    # release that does not know these columns still succeeds.
    card_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
        db_default="",
    )
    card_title = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
        db_default="",
    )
    from_column = models.ForeignKey(
        Column,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    to_column = models.ForeignKey(
        Column,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    from_swimlane = models.ForeignKey(
        Swimlane,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    to_swimlane = models.ForeignKey(
        Swimlane,
        on_delete=models.SET_NULL,
        null=True,
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    from_column_name = models.CharField(
        max_length=255,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    to_column_name = models.CharField(
        max_length=255,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    from_swimlane_name = models.CharField(
        max_length=255,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    to_swimlane_name = models.CharField(
        max_length=255,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    # Stable UIDs captured at write time — parallel to the *_name fields above.
    # Rows where the FK was already NULL at migration time cannot be backfilled
    # and remain ""; this is intentional and consistent with the _name fields.
    from_column_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    to_column_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    from_swimlane_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    to_swimlane_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    moved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    moved_at = models.DateTimeField(
        auto_now_add=True,
        db_index=True,  # pragma: no mutate -- schema constant (migration-check)
    )
    notes = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
    )
    movement_type = models.CharField(
        max_length=20,  # pragma: no mutate -- schema constant (migration-check)
        choices=MovementType.choices,
        default=MovementType.MOVE,
    )
    # Set only on rows created by a board import with history (#1675). An
    # imported row is attributed to the importer (``moved_by``) and this keeps
    # the username the source file named as plain text, so the original author
    # stays readable without being matched to a local account. ``""`` means the
    # file named nobody; NULL means the row was not imported. History imported
    # by earlier versions also carries NULL, since the original name was not kept.
    imported_from_username = models.CharField(
        max_length=150,  # pragma: no mutate -- schema constant (migration-check)
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
    )

    class Meta:
        db_table = "card_movements"
        ordering = ["-moved_at"]
        indexes = [
            # Speeds up per-card movement history queries (card detail timeline,
            # analytics dwell-time calculations) by covering the card FK and the
            # default descending moved_at ordering in a single B-tree scan.
            models.Index(
                fields=["card", "-moved_at"],  # pragma: no mutate -- schema constant (migration-check)
                name="movement_card_moved_idx",  # pragma: no mutate -- schema constant (migration-check)
            ),
            # Board-level History (#1469) reads by board, newest first; the
            # board-delete cascade's DELETE ... WHERE board_id IN (...) uses it
            # too. Built concurrently in migration 0081.
            models.Index(
                fields=["board", "-moved_at"],  # pragma: no mutate -- schema constant (migration-check)
                name="movement_board_moved_idx",  # pragma: no mutate -- schema constant (migration-check)
            ),
        ]

    def save(self, *args, **kwargs):
        """Insert only (#1469): an existing movement is never rewritten.

        A pk already set means Django would try an UPDATE, so that is refused
        too. On insert, fill the board and card snapshots from the card when
        the caller did not; services pass the card instance, so this reads the
        cached object and costs no query. ``bulk_create`` skips ``save()``,
        so the import path sets them itself.
        """
        if self.pk is not None or not self._state.adding:
            raise AppendOnlyViolation(
                "CardMovement rows are append-only; an existing movement cannot be changed."
            )
        if self.card_id is not None:
            card = self.card
            if self.board_id is None:
                self.board_id = card.board_id
            if not self.card_uid:
                self.card_uid = card.uid
            if not self.card_title:
                self.card_title = card.title
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        """Refused (#1469): movements leave only with their board.

        The board-delete cascade deletes them with a queryset-level SQL delete
        that never calls this method, so that path is unaffected. So does the
        operator's ``purge_card_history`` command (#1797), the one deliberate,
        audited exception.
        """
        raise AppendOnlyViolation(
            "CardMovement rows are append-only; a movement is removed only by deleting "
            "its board or by an operator's purge_card_history run."
        )


class CardComment(models.Model):
    """A text comment left by a user on a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    # Same meaning as CardMovement.imported_from_username (#1675, #1702): set
    # only on comments created by an import, whose ``author`` is the importer.
    # It keeps the name the source named (a JSON file's ``author``, a Trello
    # member's display name) as plain text, never matched to an account.
    # ``""`` means the source named nobody; NULL means the comment was posted
    # on this board, or imported by an earlier version that did not keep it.
    imported_from_username = models.CharField(
        max_length=150,  # pragma: no mutate -- schema constant (migration-check)
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
    )

    class Meta:
        db_table = "card_comments"
        ordering = ["created_at"]
        indexes = [
            # Covers per-card comment list queries (card detail, always ordered
            # by ascending created_at). Avoids a sequential scan on large boards.
            models.Index(fields=["card", "created_at"], name="comment_card_created_idx"),
        ]


class CardActivity(models.Model):
    """Immutable audit log entry for a field change or action on a card."""

    class EventType(models.TextChoices):
        """Types of field-change events that are logged as card activity."""
        PRIORITY_CHANGE = "priority_change", "Priority changed"
        WEIGHT_CHANGE = "weight_change", "Weight changed"
        ASSIGNEE_CHANGE = "assignee_change", "Assignee changed"
        LABEL_CHANGE = "label_change", "Labels changed"
        DESCRIPTION_CHANGE = "description_change", "Description changed"
        COMMENT_ADDED = "comment_added", "Comment added"
        ATTACHMENT_ADDED = "attachment_added", "Attachment added"
        ATTACHMENT_DELETED = "attachment_deleted", "Attachment deleted"
        TITLE_CHANGE = "title_change", "Title changed"
        CHECKLIST_ITEM_ADDED = "checklist_item_added", "Checklist item added"
        CHECKLIST_ITEM_CHECKED = "checklist_item_checked", "Checklist item checked"
        CHECKLIST_ITEM_UNCHECKED = "checklist_item_unchecked", "Checklist item unchecked"
        CHECKLIST_ITEM_DELETED = "checklist_item_deleted", "Checklist item deleted"
        DUE_DATE_CHANGE = "due_date_change", "Due date changed"
        # Manual block state (#1149). ``blocked``: to_value is the reason.
        # ``unblocked``: from_value is the reason the block carried, to_value
        # the optional resolution. The full record with durations lives in
        # ``CardBlock``; these rows keep the card's activity trail complete.
        BLOCKED = "blocked", "Blocked"
        UNBLOCKED = "unblocked", "Unblocked"

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="activities")
    event_type = models.CharField(max_length=30, choices=EventType.choices)
    from_value = models.TextField(blank=True)
    to_value = models.TextField(blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # Same meaning as CardMovement.imported_from_username (#1675): the source
    # file's username for an imported row, whose ``actor`` is the importer.
    imported_from_username = models.CharField(
        max_length=150,  # pragma: no mutate -- schema constant (migration-check)
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
    )

    class Meta:
        db_table = "card_activities"
        ordering = ["-created_at"]
        indexes = [
            # Covers per-card activity queries (card detail timeline, always
            # ordered by descending created_at). Avoids sequential scans on
            # boards with heavy activity history.
            models.Index(fields=["card", "-created_at"], name="activity_card_created_idx"),
        ]


class CardBlock(models.Model):
    """One manual block of a card, from block to unblock (#1149).

    Blocked is a *state*, not a dependency: a card can be blocked on the
    customer, a vendor or a decision, none of which is a card a ``blocks``
    relation (#449) could point at. Each block is one row; ``unblocked_at``
    NULL means the block is still open, and at most one row per card is open
    (``cardblock_one_open_per_card``). The open row's ``blocked_at`` and
    ``reason`` are mirrored onto ``Card.blocked_at`` / ``Card.blocked_reason``
    so the board payload needs no join.

    Its own table rather than ``CardMovement`` rows (architect review,
    2026-11-01): movements feed the dwell and cycle-time math (#1532), and a
    block is not a change of cell. Rows are written only by
    ``services.cards.block_card`` / ``unblock_card`` (and the JSON import),
    and an unblock only fills the closing fields of the open row; nothing
    rewrites a closed block. ``column`` is where the card sat when it was
    blocked, so blocked time can be summed per column even after the card
    moves on or the column is deleted (``column_name`` / ``column_uid`` keep
    it readable, like ``CardMovement``'s ``*_name`` snapshots).

    Hard-deleting a card keeps its blocks, like its movements (#1469):
    ``card`` is SET_NULL and ``card_uid`` / ``card_title`` keep the row
    identifiable. Deleting the board removes them through ``board``.
    """

    card = models.ForeignKey(
        Card,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        db_index=False,  # pragma: no mutate -- covered by cardblock_card_blocked_idx
        related_name="blocks",  # pragma: no mutate -- schema constant (migration-check)
    )
    # Captured at write time (#1469 pattern): what ties a deleted card's
    # blocks to its board, and what the board-level analytics read by.
    board = models.ForeignKey(
        Board,
        on_delete=models.CASCADE,
        db_index=False,  # pragma: no mutate -- covered by cardblock_board_blocked_idx
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    card_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    card_title = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    # A plain default, not auto_now_add: the JSON import restores the file's
    # timestamp, and auto_now_add would overwrite it on INSERT.
    blocked_at = models.DateTimeField(default=timezone.now)
    blocked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    reason = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
    )
    unblocked_at = models.DateTimeField(null=True, blank=True)
    unblocked_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    resolution = models.CharField(
        max_length=500,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    column = models.ForeignKey(
        Column,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        related_name="+",  # pragma: no mutate -- schema constant (migration-check)
    )
    column_name = models.CharField(
        max_length=255,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    column_uid = models.CharField(
        max_length=16,  # pragma: no mutate -- schema constant (migration-check)
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
        default="",
    )
    # Same meaning as CardMovement.imported_from_username (#1675): set only on
    # rows created by a board import, whose ``blocked_by`` is the importer. It
    # keeps the username the file named as the blocker, as plain text.
    imported_from_username = models.CharField(
        max_length=150,  # pragma: no mutate -- schema constant (migration-check)
        null=True,
        blank=True,  # pragma: no mutate -- schema constant (migration-check)
    )

    class Meta:
        db_table = "card_blocks"
        ordering = ["-blocked_at", "-id"]
        indexes = [
            # Per-card block history (card detail, newest first).
            models.Index(fields=["card", "-blocked_at"], name="cardblock_card_blocked_idx"),
            # Board analytics: blocked time per column and top reasons.
            models.Index(fields=["board", "-blocked_at"], name="cardblock_board_blocked_idx"),
        ]
        constraints = [
            # The service checks this under the card lock; the constraint is
            # the backstop that keeps Card.blocked_at and the open row from
            # ever disagreeing about which block is current.
            models.UniqueConstraint(
                fields=["card"],
                condition=models.Q(unblocked_at__isnull=True),
                name="cardblock_one_open_per_card",
            ),
        ]

    def __str__(self):
        return f"{self.card_uid}: {self.reason}"


class CardChecklist(models.Model):
    """A checklist item (to-do) attached to a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="checklist_items")
    text = models.CharField(max_length=500)
    is_checked = models.BooleanField(default=False)
    position = models.IntegerField(default=0)
    # Ownership field — mirrors the pattern on CardComment and CardAttachment so
    # collaborators can only edit/delete items they created. Nullable so existing
    # rows (before this migration) remain valid; the view layer treats null
    # created_by as moderator-only (fails closed, #1943).
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_checklist_items",
    )

    class Meta:
        db_table = "card_checklist_items"
        ordering = ["position"]
        indexes = [
            # Covers the default ORDER BY position for a given card without a
            # filesort on cards with many checklist items.
            models.Index(fields=["card", "position"], name="checklist_card_pos_idx"),
        ]

    def __str__(self):
        return self.text


class CardAttachment(models.Model):
    """A file uploaded and attached to a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="attachments")
    file = models.FileField(upload_to="attachments/%Y/%m/")
    filename = models.CharField(max_length=255)
    size = models.PositiveBigIntegerField()
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "card_attachments"
        ordering = ["-uploaded_at"]


@receiver(post_delete, sender=CardAttachment, dispatch_uid="boards_remove_deleted_attachment_file")
def remove_file_of_deleted_attachment(sender, instance, **kwargs):
    """Remove an attachment's file from storage once its row is gone (#1817).

    A post_delete receiver, not a call in one delete view, so every path that
    cascades attachment rows is covered: card, column, swimlane and board
    deletes, Django admin ``delete_selected``, ``QuerySet.delete()`` and the
    single-attachment endpoint. Without it the rows vanish but the file names
    and contents outlive the card in media storage.

    Storage deletion is irreversible, so it is deferred to commit: if the
    surrounding transaction rolls back (the row survives) the file must too
    (#1584). The shared-name check runs at commit time, after the cascade, so a
    row that still points at the same path (possible through Django admin)
    keeps its file. Failure-isolated: a storage error is logged by class only
    (never a path) and must not drop other on_commit callbacks, such as the
    deferred board broadcast. The ``purge_orphaned_attachments`` command is the
    repair path for a file this misses.
    """
    file_name = instance.file.name if instance.file else ""
    # Uploads always land under attachments/; refuse anything else (or a ``..``
    # that stays inside MEDIA_ROOT) so a name written by a future import path
    # can never make this receiver delete a file outside that tree.
    if not file_name.startswith("attachments/") or ".." in file_name.split("/"):
        return
    file_storage = instance.file.storage
    pk = instance.pk

    def _remove_file():
        try:
            if CardAttachment.objects.filter(file=file_name).exclude(pk=pk).exists():
                return
            file_storage.delete(file_name)
        except Exception as exc:
            logger.warning(
                "attachment file removal failed after commit: %s",
                type(exc).__name__,
            )

    transaction.on_commit(_remove_file, robust=True)


class Notification(models.Model):
    """An in-app notification delivered to a user about a card or board event.

    The ``verb`` field stores a human-readable summary assembled from
    system-controlled templates; it is displayed via React text content (never
    innerHTML) so user-supplied substrings are escaped by the framework.

    ``actor`` and ``action_type`` provide structured data for future use cases
    such as notification grouping, i18n, or programmatic filtering. They are
    intentionally separate from ``verb`` so callers can render a localized
    message without re-parsing a free-form string.
    """

    class ActionType(models.TextChoices):
        ASSIGNED = "assigned", "assigned"
        MENTIONED = "mentioned", "mentioned"
        CARD_MOVED = "card_moved", "card moved"
        STALE = "stale", "stale"
        BOARD_INVITE = "board_invite", "board invite"
        # Added in 1.2 (#356). Purely additive: ``action_type`` is a CharField
        # with ``choices`` and no database CHECK constraint, so a new value emits
        # no DDL and locks nothing. Existing clients that switch on the value
        # must treat an unknown action_type as generic — the API docs say so.
        DUE_SOON = "due_soon", "due soon"
        # Added in 1.2 (#1277). Additive in exactly the same way as DUE_SOON:
        # no CHECK constraint, so migration 0062 is state-only. Recipients are the
        # card's implicit watchers (creator + assignee); see card_watcher_ids().
        COMMENT_ADDED = "comment_added", "comment added"

    recipient = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications"
    )
    # actor is the user who triggered the notification; stored as a FK so we
    # can look up display names without embedding them directly in ``verb``.
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="triggered_notifications",
    )
    action_type = models.CharField(
        max_length=32,
        choices=ActionType.choices,
        blank=False,
    )
    verb = models.CharField(max_length=500)
    card = models.ForeignKey(Card, on_delete=models.CASCADE, null=True, blank=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, null=True, blank=True)
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notifications"
        ordering = ["-created_at"]
        indexes = [
            # Covers the default notification list query: unread notifications
            # for a recipient, ordered by most recent first. Avoids a sequential
            # scan on the notifications table for the badge count and inbox list.
            models.Index(fields=["recipient", "read", "-created_at"], name="notif_recipient_unread_idx"),
        ]


class SavedFilter(models.Model):
    """A named filter combination saved by a user for a specific board.

    Filters are private to the owning user — no sharing across board members.
    Shared presets are deferred to a future release so the RBAC model can be
    designed properly (see #343 follow-up).

    ``state_json`` stores the serialized FilterState object from the frontend:
    {search, assigneeIds, labelIds, priorities, dueDate}. Shape validation
    lives in the serializer so malformed payloads (including from future
    board-import flows) never reach the database. The frontend also
    normalizes defensively on load via ``hydrateFilter`` in useSavedFilters.

    ``state_version`` is a monotonically increasing integer stamped on
    every write. It exists so that when the ``state_json`` shape eventually
    changes in a non-additive way (e.g. ``assigneeIds: number[]`` → UID
    strings), the frontend can dispatch to a version-specific migrator. No
    registry exists yet — we will not cargo-cult one until there is a real
    v2 (#698). Existing rows backfill to ``1`` via the column default.

    All columns are nullable or have defaults so this migration is zero-downtime.
    """

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="saved_filters",
    )
    board = models.ForeignKey(
        Board,
        on_delete=models.CASCADE,
        related_name="saved_filters",
    )
    name = models.CharField(max_length=100)
    state_json = models.JSONField(
        default=dict,
        help_text="Serialized FilterState: {search, assigneeIds, labelIds, priorities, dueDate}.",
    )
    state_version = models.PositiveSmallIntegerField(
        default=1,
        help_text="Schema version for state_json. Bump when the shape changes in a non-additive way.",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "saved_filters"
        ordering = ["name"]
        # One name per user per board — prevents duplicate filter names from
        # being created via rapid concurrent requests.
        unique_together = ["user", "board", "name"]

    def __str__(self):
        return f"{self.user} / {self.board} / {self.name}"


class BoardExportLog(models.Model):
    """Audit entry for a successful board export (#842).

    Written by ``BoardImportExportMixin.export`` after the response body is
    assembled. Deliberately records only successful exports — a denied
    attempt never reached the data, so it is not an exfiltration event.
    Failed-export logging is tracked as a 1.2 follow-up.

    The ``actor`` FK is SET_NULL so the audit row survives user
    deactivation — admins investigating a past export must still be able to
    see *who* ran it even after that user has been removed. ``role_at_export``
    is captured verbatim at write time rather than recomputed on read, so
    subsequent role changes do not rewrite history. The special sentinel
    ``"owner"`` is used when the actor is the board owner (distinct from a
    promoted admin); ``"site_admin"`` is used when a site admin without
    board membership exports.
    """

    board = models.ForeignKey(
        Board, on_delete=models.CASCADE, related_name="export_logs"
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="board_export_logs",
    )
    role_at_export = models.CharField(
        max_length=20,
        help_text=(
            "Board role the actor held when the export ran. "
            "One of: viewer, collaborator, member, admin, owner, site_admin. "
            "Captured verbatim so later role changes do not rewrite history."
        ),
    )
    export_format = models.CharField(
        max_length=20,
        help_text="Export format string as requested (e.g. ``json`` / ``csv``).",
    )
    row_count = models.PositiveIntegerField(
        help_text=(
            "Number of rows exported: cards for a board export, "
            "movements for a movement-history export."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "board_export_logs"
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["board", "-created_at"], name="bel_board_created_idx"),
        ]

    def __str__(self):
        return f"{self.board_id} / {self.actor_id} / {self.export_format} @ {self.created_at}"


class BoardEvent(models.Model):
    """One committed board mutation, appended to a durable, resumable feed (#1114).

    Why this exists
    ---------------
    Before this table the only way to observe a board mutation from outside the
    Django process was to hold a WebSocket open. ``broadcast_board_event`` is
    fire-and-forget, so a consumer that dropped its connection could not ask
    "what did I miss?" — it had to re-fetch ``/full/`` and diff. A second front
    end, CRM-style sync jobs and the MCP REST client all need a cursor they can
    resume from instead.

    A row is written by ``boards.broadcast.record_board_event`` **inside the same
    transaction as the mutation it describes**, and the broadcast that publishes
    it is registered with ``transaction.on_commit``. A rolled-back mutation
    therefore writes no row and sends nothing: both halves fall out of the
    transaction rather than out of extra bookkeeping.

    ``data`` is the broadcast payload verbatim, so the feed row and the
    WebSocket frame carry the same bytes and a consumer can switch between the
    two without a second representation to reconcile.

    Why ``board_id`` and ``actor_id`` are plain integers and not ForeignKeys
    ----------------------------------------------------------------------
    This table is append-only, and a ForeignKey would quietly break that:
    ``on_delete=CASCADE`` on ``board`` lets deleting a board rewrite the history
    a consumer was mid-way through reading, and ``SET_NULL`` on ``actor`` lets
    deactivating a user rewrite who did what. ``board.deleted`` is itself an
    emitted event type that must be persisted, and under a CASCADE FK that row
    could never survive the transaction that produced it.

    Nothing is given up for it. Read access is resolved through
    ``get_board_for_user`` on the board id, not through the relation, so scoping
    is unchanged; and because ``actor_id`` is a local column rather than a join,
    serializing a page of events cannot N+1 on the actor. Row lifecycle belongs
    to retention pruning (``manage.py prune_board_events``), not to referential
    integrity.

    The one sanctioned rewrite (#1816)
    ----------------------------------
    ``manage.py purge_card_history`` is an operator's erase-on-request, and a
    card's stored payloads (``card.created``, ``card.updated``,
    ``card.unarchived`` and the ``card``/``movement`` objects of
    ``card.moved``) hold its title, description, block reason, notes, custom
    field values and external reference. Deleting those rows would put gaps in a cursor
    stream that consumers page through, so the purge **redacts** them instead:
    the content values become ``null``, every key stays, and ``redacted_at``
    records when. Nothing else updates a stored row.
    """

    board_id = models.BigIntegerField(
        help_text="Board this event belongs to. Deliberately not a ForeignKey — see the model docstring.",
    )
    event = models.CharField(
        max_length=64,
        help_text="Event type, exactly as broadcast over the WebSocket (e.g. 'card.moved').",
    )
    data = models.JSONField(
        default=dict,
        help_text="The broadcast payload, verbatim — identical to the WebSocket frame's 'data' object.",
    )
    actor_id = models.BigIntegerField(
        null=True,
        blank=True,
        help_text="User who caused the event; NULL for events with no authenticated actor.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    redacted_at = models.DateTimeField(
        null=True,
        blank=True,
        help_text=(
            "When purge_card_history redacted this row's card content (#1816); "
            "NULL for a row that was never redacted."
        ),
    )

    class Meta:
        db_table = "board_events"
        # id order is the feed's contract: the `after` cursor is an id, and ids
        # are monotonic per insert, so ordering by id is ordering by commit
        # sequence. Never reorder by created_at — two rows can share a timestamp.
        ordering = ["id"]
        indexes = [
            # Serves the only read query the feed has: board scope + id > cursor,
            # returned in id order.
            models.Index(fields=["board_id", "id"], name="bev_board_id_idx"),
            # Serves the retention pruner's single scan.
            models.Index(fields=["created_at"], name="bev_created_idx"),
        ]

    def __str__(self):
        return f"{self.pk} / board {self.board_id} / {self.event}"


class CustomFieldDefinition(models.Model):
    """A typed metadata field that every card on one board may carry (#371).

    Labels are untyped tags: they can say "backend" but not "hypervisors = 4".
    A definition is the *schema* half of that — the board-scoped declaration of
    a name, a type, and (for dropdowns) the permitted choices. The per-card half
    is :class:`CustomFieldValue`.

    Why an auto PK plus ``uid`` rather than the UUID PK the issue sketched:
    every other board-scoped model here (Column, Swimlane, Label, Card) uses an
    integer PK for the URL and a random ``uid`` as the stable external handle,
    and the nested routers, the WebSocket payloads and the export format all
    assume that shape. A UUID PK on this one model would buy nothing the ``uid``
    does not already provide and would make it the odd one out.

    The two caps below are enforced at the serializer boundary (see
    ``boards.serializers.assert_definition_caps``) rather than by a database
    constraint, because neither is expressible as one: both are counts over a
    board's rows.
    """

    class FieldType(models.TextChoices):
        """Value types a definition can declare. Casting/validation is per type."""
        TEXT = "text"
        NUMBER = "number"
        DATE = "date"
        DROPDOWN = "dropdown"
        CHECKBOX = "checkbox"
        # Text-backed like every other type; the value is validated as an
        # absolute http(s) URL on write (#1390, see
        # ``boards.serializers._normalize_custom_field_value``).
        URL = "url", "URL"
        # Several of the definition's ``choices_json`` at once (#1391). Still
        # text-backed: the value is a canonical compact JSON array string,
        # entries ordered as in ``choices_json`` (see
        # ``boards.custom_field_types``). The wire value stays a string.
        MULTI_SELECT = "multi_select", "Multi-select"

    # EAV with a cap: /full/ joins every card against every value row, so an
    # uncapped field count is a Cartesian blow-up waiting to happen. 500 cards
    # x 30 fields = 15,000 value rows, which the prefetch handles in one query.
    MAX_PER_BOARD = 30
    # Card-face real estate. The card is a summary, not a record view.
    MAX_PINNED_PER_BOARD = 2
    # Cap on a stored value, enforced in the serializer. It is not cosmetic: the
    # (field_definition, value) index below is a btree, and PostgreSQL rejects an
    # index tuple larger than ~2704 bytes at INSERT time. 500 characters cannot
    # exceed that even at 4 bytes per character, so no legal value can be written
    # and then fail to index. Raising this cap later is backward compatible;
    # lowering it is not, so it starts deliberately conservative.
    MAX_VALUE_LENGTH = 500

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    board = models.ForeignKey(
        Board, on_delete=models.CASCADE, related_name="custom_field_definitions"
    )
    name = models.CharField(max_length=100)
    field_type = models.CharField(
        max_length=20, choices=FieldType.choices, default=FieldType.TEXT
    )
    choices_json = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Permitted values, used only when field_type is 'dropdown'. Stored on "
            "the definition rather than in a separate table so the choices are "
            "always loaded with the field they belong to."
        ),
    )
    position = models.IntegerField(default=0)
    show_on_card = models.BooleanField(
        default=False,
        help_text="Pin this field's value to the card face. Max 2 per board.",
    )
    is_required = models.BooleanField(
        default=False,
        help_text=(
            "Declared but NOT enforced in v1 — the column exists so the flag can "
            "be set and read before enforcement lands. Do not add enforcement "
            "without a release note: it would turn existing valid card writes "
            "into 400s."
        ),
    )
    help_text = models.CharField(max_length=255, blank=True)
    # Display-only number formatting (#1391). Meaningful only when field_type is
    # "number" — the serializer refuses them on any other type and clears them
    # when a field is retyped away from number. They never touch the stored
    # value: CustomFieldValue.value stays the plain number string, so export,
    # filtering and sorting all keep working on the raw number. Typed columns
    # rather than a JSON config blob so the API schema (and the fuzz/parity
    # checks built on it) can describe each option exactly. ``db_default`` keeps
    # a database DEFAULT so pre-0065 code still running mid-deploy can INSERT.
    number_prefix = models.CharField(max_length=10, blank=True, default="", db_default="")
    number_suffix = models.CharField(max_length=10, blank=True, default="", db_default="")
    # Fixed decimal places for display; null means "as typed" (pre-#1391 behavior).
    number_decimals = models.PositiveSmallIntegerField(null=True, blank=True)
    # Per-choice display color (#1391): ``{choice_text: palette_key}``, keys a
    # subset of ``choices_json`` and values from the closed palette in
    # ``boards.custom_field_types.CHOICE_COLOR_KEYS`` — palette *keys*, never
    # hex, so the frontend owns the light/dark rendering and contrast. A
    # separate map rather than objects inside ``choices_json`` so ``choices``
    # stays the plain string list every existing client, export and template
    # reads. Display-only: values are never touched. The serializer prunes
    # entries for choices that no longer exist and clears the map when the
    # field is retyped away from a choice type. ``db_default`` keeps a database
    # DEFAULT so pre-0066 code still running mid-deploy can INSERT.
    choice_colors = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, output_field=models.JSONField()),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "custom_field_definitions"
        ordering = ["position", "id"]
        # (board, position) keeps the display order unambiguous — the reorder
        # action does a two-pass update to stay inside it, same as columns.
        # (board, name) makes a field addressable by name, which the CSV export
        # header and the (future) import both rely on.
        unique_together = [("board", "position"), ("board", "name")]

    def __str__(self):
        return f"{self.board_id} / {self.name}"


class CustomFieldValue(models.Model):
    """One card's value for one :class:`CustomFieldDefinition` (#371).

    A single ``value`` text column holds every type. The alternative — one
    typed column per type — trades a cast for a table full of sparse nulls and
    a migration every time a type is added; casting and validation live in the
    serializer instead. Typed columns (``value_number``, ``value_date``) are
    deferred to the enterprise analytics work that would actually need SUM/AVG.

    A row is only written when a card has a value: clearing a field deletes the
    row rather than storing an empty string, so "unset" has exactly one
    representation.
    """

    card = models.ForeignKey(
        Card, on_delete=models.CASCADE, related_name="custom_field_values"
    )
    field_definition = models.ForeignKey(
        CustomFieldDefinition, on_delete=models.CASCADE, related_name="values"
    )
    value = models.TextField(blank=True)

    class Meta:
        db_table = "custom_field_values"
        # No Meta.ordering: ordering by the definition's position would force a
        # join on every query that touches this table. The read path orders
        # explicitly in its Prefetch queryset instead, paying for the join once.
        unique_together = [("card", "field_definition")]
        indexes = [
            # Supports "which cards have <value> for <field>" lookups. No OSS
            # query uses it yet — server-side filtering is not in this phase —
            # but the table is empty today, so building it now is free, and
            # building it later on a populated table is not.
            models.Index(
                fields=["field_definition", "value"], name="cfv_definition_value_idx"
            ),
        ]

    def __str__(self):
        return f"{self.card_id} / {self.field_definition_id}"


class SwimlaneCustomFieldDefinition(models.Model):
    """A typed metadata field that every swimlane row on one board may carry (#1140).

    The row-level counterpart to :class:`CustomFieldDefinition`. A swimlane
    represents an entity — an account, a customer, a project, a candidate — and
    before this everything but ``name``/``contact_email``/``notes`` had to be
    stuffed into ``notes`` as prose that cannot be filtered or sorted.

    **Why a separate table rather than a ``target_type`` discriminator on
    :class:`CustomFieldDefinition`:** the discriminator shares one row space
    between two owners, and every existing card-level reader would then have to
    filter for its own scope or silently start seeing row fields. Three of those
    readers reach a 1.0 response body — ``BoardFullSerializer``'s
    ``custom_field_definitions``, the CSV export header list, and the per-board
    cap count — so a missed filter is a contract break that no test failure
    announces. It would also mean altering ``unique_together`` and adding a
    check constraint on a populated ``custom_field_values`` table, which under
    ``docs/development/database-migrations.md`` is three migrations, two of them
    ``atomic = False`` and therefore without rollback. A second table costs one
    ``CreateModel`` pair and changes no existing response.

    What is *not* duplicated is the behavior: the type enum below is
    :class:`CustomFieldDefinition`'s by reference, and the value normalizer, the
    validator hooks and the cap helper in ``boards.serializers`` are shared
    outright. Same pattern, second owner.
    """

    #: One enum, referenced rather than copied — a second copy of the enum would
    #: be free to drift, and the TypeScript side has a single ``CustomFieldType``
    #: union that both models' definitions are checked against.
    FieldType = CustomFieldDefinition.FieldType

    # Re-derived for swimlane cardinality rather than copied from the card cap
    # of 30, whose justification does not transfer. That cap bounds the /full/
    # join at an assumed 500 cards (``_IMPORT_MAX_CARDS``) x 30 fields = 15,000
    # value rows. The parallel row ceiling is ``_IMPORT_MAX_SWIMLANES`` = 100, so
    # the join constraint alone would permit 150 — it does not bind here.
    # What binds instead is that row values ride in the *same* /full/ response
    # as card values: budgeting them at a tenth of the card side keeps them from
    # materially growing the board payload. 100 swimlanes x 15 fields = 1,500
    # value rows, one prefetch query. 15 covers the account/customer case
    # (owner, ARR, region, tier, renewal, CSM, health, segment) with headroom.
    # Raising a cap later is backward compatible; lowering it is not, so this
    # starts deliberately conservative — the same asymmetry as MAX_VALUE_LENGTH.
    MAX_PER_BOARD = 15
    # Row-header real estate. Note the swimlane label panel is *not* a
    # full-width band — it is a sticky left column, `sidebarWidth ?? 220`px
    # wide, already carrying the drag handle, the name, contact_email and the
    # collapse control. It is narrower than the ~250px card face, not wider.
    # The cap is 8 rather than the card face's 2 because row chips stack
    # *vertically* down that column, so eight pinned fields cost eight lines
    # rather than competing for one line's width. Raising this trades rows
    # visible on screen for metadata per row. It was 3 until #1416 raised it so
    # the Sales Territory (Overlay) demo can pin AD, AE, OAE, OSA and SVC; 8 is
    # a deliberately generous interim cap and the right number is to be revisited
    # in 1.3 (see the follow-up UX issue).
    MAX_PINNED_PER_BOARD = 8
    # Referenced, not re-chosen. The constraint behind the number is the same
    # one the card model documents: ``scfv_definition_value_idx`` is a btree,
    # and PostgreSQL rejects an index tuple over ~2704 bytes at INSERT time, so
    # no legal value may be writable and then fail to index. Two independently
    # chosen limits on the same constraint would be free to drift.
    MAX_VALUE_LENGTH = CustomFieldDefinition.MAX_VALUE_LENGTH

    uid = models.CharField(max_length=16, unique=True, editable=False, default=_generate_uid)
    board = models.ForeignKey(
        Board, on_delete=models.CASCADE, related_name="swimlane_custom_field_definitions"
    )
    name = models.CharField(max_length=100)
    field_type = models.CharField(
        max_length=20,
        choices=CustomFieldDefinition.FieldType.choices,
        default=CustomFieldDefinition.FieldType.TEXT,
    )
    choices_json = models.JSONField(
        default=list,
        blank=True,
        help_text=(
            "Permitted values, used only when field_type is 'dropdown'. Stored on "
            "the definition rather than in a separate table so the choices are "
            "always loaded with the field they belong to."
        ),
    )
    position = models.IntegerField(default=0)
    show_on_row = models.BooleanField(
        default=False,
        help_text="Pin this field's value to the swimlane row header. Max 3 per board.",
    )
    is_admin_only = models.BooleanField(
        default=True,
        help_text=(
            "Serve this field's values only to board admins, reusing the existing "
            "SwimlaneSerializer/SwimlaneAdminSerializer split rather than adding a "
            "second visibility rule. Defaults to True because the default is not "
            "symmetrically reversible: loosening a field later is an additive, "
            "per-field admin action, while tightening one would change what an "
            "existing install already exposes — a 1.0 contract break. Rows carry "
            "entity data (this model was called Customer until migration 0005), "
            "so the safe default is the closed one."
        ),
    )
    is_required = models.BooleanField(
        default=False,
        help_text=(
            "Declared but NOT enforced in v1 — the column exists so the flag can "
            "be set and read before enforcement lands. Do not add enforcement "
            "without a release note: it would turn existing valid swimlane writes "
            "into 400s."
        ),
    )
    help_text = models.CharField(max_length=255, blank=True)
    # Display-only number formatting (#1391) — same columns and same rules as
    # CustomFieldDefinition's; see the notes there. Duplicated because the two
    # models deliberately share no abstract base.
    number_prefix = models.CharField(max_length=10, blank=True, default="", db_default="")
    number_suffix = models.CharField(max_length=10, blank=True, default="", db_default="")
    number_decimals = models.PositiveSmallIntegerField(null=True, blank=True)
    # Per-choice display color (#1391) — same column and same rules as
    # CustomFieldDefinition.choice_colors; see the notes there.
    choice_colors = models.JSONField(
        default=dict, blank=True, db_default=models.Value({}, output_field=models.JSONField()),
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "swimlane_custom_field_definitions"
        ordering = ["position", "id"]
        # Same two reasons as the card-level model: (board, position) keeps the
        # display order unambiguous for the two-pass reorder, and (board, name)
        # makes a field addressable by name, which the export header relies on.
        unique_together = [("board", "position"), ("board", "name")]

    def __str__(self):
        return f"{self.board_id} / {self.name}"


class SwimlaneCustomFieldValue(models.Model):
    """One swimlane's value for one :class:`SwimlaneCustomFieldDefinition` (#1140).

    Storage decisions are :class:`CustomFieldValue`'s, deliberately: one untyped
    text column for every type, casting and validation at the serializer
    boundary, and a row written only when a value exists so that "unset" has
    exactly one representation. Typed columns stay deferred to the enterprise
    analytics work that would actually need SUM/AVG.

    Values die with their swimlane through the FK cascade, and with their board
    through ``Swimlane.board``'s cascade — no cleanup path of its own.
    """

    swimlane = models.ForeignKey(
        Swimlane, on_delete=models.CASCADE, related_name="custom_field_values"
    )
    field_definition = models.ForeignKey(
        SwimlaneCustomFieldDefinition, on_delete=models.CASCADE, related_name="values"
    )
    value = models.TextField(blank=True)

    class Meta:
        db_table = "swimlane_custom_field_values"
        # No Meta.ordering, same reason as CustomFieldValue: ordering by the
        # definition's position would force a join on every query touching this
        # table. The read path orders explicitly in its Prefetch queryset.
        unique_together = [("swimlane", "field_definition")]
        indexes = [
            models.Index(
                fields=["field_definition", "value"], name="scfv_definition_value_idx"
            ),
        ]

    def __str__(self):
        return f"{self.swimlane_id} / {self.field_definition_id}"


class CardRelation(models.Model):
    """A typed, directional link between two cards on the same board (#449).

    **Why one canonical direction rather than two mirrored rows or a symmetric
    M2M:** "A blocks B" and "B is blocked by A" are the same fact stated from
    two ends. Storing both would make every write a two-row transaction and
    leave the pair free to drift out of sync; storing one and deriving the
    inverse at read time makes the inverse unrepresentable-as-wrong. The
    serializer resolves direction by asking which side of the row the card in
    hand sits on: rows reached through ``outgoing_relations`` read forwards
    ("blocks"), rows reached through ``incoming_relations`` read backwards
    ("blocked by").

    **Why same-board only:** enforced in the view, not here — Django's
    ``CheckConstraint`` cannot span a join, so ``from_card.board_id ==
    to_card.board_id`` has no database-level expression. Cross-board relations
    are deferred, and admitting one would leak the existence and title of a
    card on a board the requesting user may not be a member of.

    **Cycles:** self-relations are rejected by ``cardrel_no_self_relation``
    below and direct two-cycles (A blocks B while B blocks A) by the
    serializer. Longer cycles (A→B→C→A) are deliberately NOT detected: that
    needs an unbounded graph walk on the write path against the busiest table
    in the schema, and nothing in v1 consumes the graph as an ordering — the
    only readers are a count and a list, both of which render correctly in a
    cycle. Revisit if "auto-clear when the blocker resolves" ever lands, where
    a cycle becomes a livelock rather than a curiosity.
    """

    class Type(models.TextChoices):
        """Relation types. ``duplicates`` is deferred — do not add it here
        without also adding it to ``SYMMETRIC_TYPES`` below if it is symmetric."""
        BLOCKS = "blocks", "Blocks"
        RELATES_TO = "relates_to", "Relates to"

    #: Types whose meaning does not depend on which end you read them from.
    #: These are normalized at write time (lower card id becomes ``from_card``)
    #: so that ``unique_together`` actually dedupes them — without the
    #: normalization, (A, B, relates_to) and (B, A, relates_to) are two distinct
    #: rows that both satisfy the constraint, and a card ends up listing the
    #: same neighbor twice because two people added it from opposite ends.
    SYMMETRIC_TYPES = frozenset({Type.RELATES_TO})

    from_card = models.ForeignKey(
        Card, on_delete=models.CASCADE, related_name="outgoing_relations"
    )
    to_card = models.ForeignKey(
        Card, on_delete=models.CASCADE, related_name="incoming_relations"
    )
    relation_type = models.CharField(max_length=20, choices=Type.choices)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="created_card_relations",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "card_relations"
        unique_together = [("from_card", "to_card", "relation_type")]
        indexes = [
            # Serves the blocker_count prefetch, which is always
            # `WHERE to_card_id IN (...) AND relation_type = 'blocks'`.
            # `to_card` leads so the IN() drives the scan; `relation_type`
            # trails so the blocks-only filter is satisfied from the index.
            #
            # There is deliberately NO index on `from_card` alone: the
            # unique_together above already creates a composite unique index
            # with `from_card` leading, which Postgres uses for `from_card`
            # lookups. A second one would be dead weight on every write.
            models.Index(
                fields=["to_card", "relation_type"], name="cardrel_to_type_idx"
            ),
        ]
        constraints = [
            # A card cannot block or relate to itself. Declared at the database
            # level rather than left to the serializer because it is the one
            # invariant here that gets materially harder to add later: on a
            # populated table it needs AddConstraintNotValid + ValidateConstraint
            # plus a cleanup migration for whatever rows slipped through. On a
            # table created in the same migration it is free.
            #
            # ``condition=`` rather than ``check=``: the latter is deprecated in
            # Django 5.1+ and removed in 6.0. The older ``check=`` spelling still
            # in ``groups/models.py`` predates the deprecation.
            models.CheckConstraint(
                condition=~models.Q(from_card=models.F("to_card")),
                name="cardrel_no_self_relation",
            ),
        ]

    def __str__(self):
        return f"{self.from_card_id} {self.relation_type} {self.to_card_id}"


def _has_unsafe_chars(value):
    """Whitespace, C0/DEL control characters, or invisible Unicode formatting.

    ``str.isspace()`` misses the Cf/Zl/Zp categories (zero-width space, bidi
    overrides), which can visually spoof a reference on the card face or hide
    inside a URL host.
    """
    import unicodedata

    return any(
        ch.isspace() or ord(ch) < 32 or ord(ch) == 127
        or unicodedata.category(ch) in ("Cf", "Zl", "Zp")
        for ch in value
    )


def validate_external_ref_ref(value):
    """Referenced by migration 0061 — do not rename or remove.

    ``CardExternalRef.ref`` rule (#352): freeform, but no whitespace or
    invisible characters. Run by the API serializer and by ``full_clean()``."""
    if _has_unsafe_chars(value):
        raise ValidationError("Must not contain whitespace, control, or formatting characters.")


def validate_external_ref_url(value):
    """Referenced by migration 0061 — do not rename or remove.

    ``CardExternalRef.url`` rule (#352). Run as a field validator by the API
    serializer and by ``full_clean()``, so any writer — the REST API, JSON import, or
    an integration writing the table directly — gets the same guarantee.

    The URL is rendered as an ``href``, so anything but an absolute http(s)
    URL with a host is an XSS vector. Backslashes are rejected because
    browsers treat ``\\`` as ``/`` in http(s) URLs while Python's parser does
    not, so ``http://evil.com\\github.com`` would read as one host here and
    open another in the browser. Credentials (``user:pass@``) are rejected so
    they are never stored or displayed. The host is deliberately not checked
    against the provider — self-hosted forges live on arbitrary hosts.
    """
    from urllib.parse import urlsplit

    if _has_unsafe_chars(value):
        raise ValidationError("Must not contain whitespace, control, or formatting characters.")
    if "\\" in value:
        raise ValidationError("Enter a valid URL.")
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 — raises ValueError on a malformed port
    except ValueError:
        raise ValidationError("Enter a valid URL.")
    # urlsplit lower-cases the scheme, so "JaVaScript:" is caught here too.
    if parts.scheme not in ("http", "https"):
        raise ValidationError("Only http and https URLs are allowed.")
    if not parts.hostname:
        raise ValidationError("Enter a valid URL.")
    # Browsers percent-decode the host before resolving it; Python keeps the
    # literal "%". Rejecting it keeps both sides agreeing on the real host.
    if "%" in parts.hostname:
        raise ValidationError("Enter a valid URL.")
    if "@" in parts.netloc:
        raise ValidationError("URLs containing credentials are not allowed.")


class CardExternalRef(models.Model):
    """A card's link to a merge request / pull request on an external forge (#352).

    Exposed on the card API as ``external_ref: {provider, ref, url} | null``.
    That shape is a stable public contract from 1.2: the enterprise auto-link
    integration reads and writes it, so the field names and value rules must
    not change.

    **Why a child table rather than a JSONField or three columns on ``cards``:**
    the enterprise lookup is "find cards linked to provider X, ref Y". A
    JSONField makes that an unindexable key query whose semantics differ
    between SQLite (worktree tests) and Postgres, and three columns on
    ``cards`` would need a concurrent index build plus a NOT VALID/VALIDATE
    constraint dance on the busiest table. A new table is created with its
    index for free and leaves ``cards`` untouched.

    **Why OneToOne:** Phase 1 is one link per card. A later multi-link feature
    alters this to a ForeignKey on a small table and adds an ``external_refs``
    list to the API, keeping ``external_ref`` as the primary — additive.

    Validation (http/https scheme only, no userinfo, no whitespace in ``ref``)
    is done by the ``ref``/``url`` field validators below. The API serializer
    runs the same validators; any other writer gets them via
    ``full_clean()``, which callers writing rows directly must call.
    """

    class Provider(models.TextChoices):
        GITLAB = "gitlab", "GitLab"
        GITHUB = "github", "GitHub"
        OTHER = "other", "Other"

    card = models.OneToOneField(
        Card, on_delete=models.CASCADE, related_name="external_ref"
    )
    provider = models.CharField(max_length=16, choices=Provider.choices)
    # Freeform: "owner/repo#123" (GitHub), "group/proj!45" (GitLab), or
    # anything for "other". Stored exactly as given — no case normalization.
    ref = models.CharField(max_length=255, validators=[validate_external_ref_ref])
    # CharField rather than URLField: scheme validation is done by the
    # validate_external_ref_url field validator (run by full_clean() and by
    # the API serializer), and URLField's default max_length of 200 is too
    # short for real forge URLs.
    url = models.CharField(max_length=2048, validators=[validate_external_ref_url])
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "card_external_refs"
        indexes = [
            # Serves the enterprise "which cards link this PR?" lookup. Deliberately
            # NOT unique: the same PR can be linked from several cards (and boards),
            # and a global unique constraint would leak cross-board existence of a
            # link through the integrity error it raises.
            models.Index(fields=["provider", "ref"], name="cardextref_provider_ref_idx"),
        ]

    def __str__(self):
        return f"{self.provider}:{self.ref}"


@receiver(pre_delete, sender=settings.AUTH_USER_MODEL, dispatch_uid="boards_clear_deleted_enabler_share_links")
def clear_share_links_of_deleted_enabler(sender, instance, **kwargs):
    """Clear the public share links a user enabled before the user row goes (#1865).

    ``Board.share_enabled_by`` is SET_NULL, which on its own would leave the
    link in place with no recorded enabler, the state of a link enabled
    before the field existed. A pre_delete receiver covers every deletion
    path, as ``revoke_board_invite_links_of_deleted_creator`` below does.
    Boards the user owns are skipped: they are deleted with the user
    (``Board.owner`` is CASCADE), and an event row recorded for one here would
    reference a board the delete has already collected.
    """
    enabled = list(
        Board.objects.filter(share_enabled_by=instance, share_token__isnull=False)
        .exclude(owner=instance)
        .values_list("pk", flat=True).order_by("pk")
    )
    if not enabled:
        return

    from . import broadcast as _board_broadcast
    from .serializers import BoardSerializer

    for board_id in enabled:
        # Keywords spelled out (the columns of Board.SHARE_LINK_CLEARED): the
        # group-placement entry-point check reads update() keywords statically.
        updated = Board.objects.filter(pk=board_id, share_enabled_by=instance).update(
            share_token=None, share_token_hash=None, share_token_expires_at=None,
            share_enabled_by=None,
        )
        if not updated:
            continue
        board = Board.objects.filter(pk=board_id).first()
        if board is not None:
            _board_broadcast.record_board_event(
                board_id, _board_broadcast.EVT_BOARD_UPDATED, BoardSerializer(board).data,
            )
            # The cleared share state, for admin sessions only (#1967).
            from .services.share_links import record_share_link_updated
            record_share_link_updated(board)


@receiver(pre_delete, sender=settings.AUTH_USER_MODEL, dispatch_uid="boards_revoke_deleted_creator_links")
def revoke_board_invite_links_of_deleted_creator(sender, instance, **kwargs):
    """Revoke a user's pending board invite links before the user row goes (#1578).

    so they stop appearing as pending and stop counting against the
    per-board invite caps. A pre_delete receiver, not a call in one delete view, so
    every deletion path (admin API, Django admin ``delete_selected``, shell,
    cascade, ``QuerySet.delete()``) is covered. Revocation sets ``revoked_at``
    like the explicit revoke path; consumed links keep their history.
    """
    pending = list(
        BoardInviteLink.objects.filter(
            created_by=instance, used_at__isnull=True, revoked_at__isnull=True,
        ).values_list("pk", "board_id")
    )
    if not pending:
        return
    BoardInviteLink.objects.filter(pk__in=[pk for pk, _ in pending]).update(
        revoked_at=timezone.now(),
    )

    from . import broadcast as _board_broadcast

    for link_id, board_id in pending:
        _board_broadcast.record_board_event(
            board_id, _board_broadcast.EVT_INVITE_LINK_REVOKED, {"id": link_id},
        )
