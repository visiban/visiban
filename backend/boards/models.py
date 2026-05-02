import uuid

from django.contrib.postgres.indexes import GinIndex
from django.core.validators import MaxValueValidator
from django.db import models
from django.conf import settings

from boards.uid import _generate_uid


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
        help_text="When enabled, card moves into a column at or over its WIP limit are blocked with a 409 response. Board admins can override with ?force=true.",
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
        help_text="When enabled, card moves into a column that would exceed its weight budget are blocked with a 409 response. Board admins can override with ?force=true.",
    )
    share_token = models.UUIDField(
        null=True, blank=True, default=None, editable=False, unique=True,
        help_text="Public share token. Null means sharing is disabled. Never set directly — use the share action.",
    )
    share_token_expires_at = models.DateTimeField(
        null=True, blank=True, default=None,
        help_text=(
            "Optional TTL on the public share link (#804). Null means the token "
            "never expires. Past this timestamp the share endpoint returns 410 "
            "Gone — the token is not auto-rotated, only refused."
        ),
    )
    export_min_role = models.CharField(
        max_length=20,
        default="viewer",
        help_text=(
            "Minimum BoardMembership.Role required to export this board (#843). "
            "Default ``viewer`` preserves pre-1.1 behavior where every role with "
            "read access can export. Owners and site admins always bypass this "
            "threshold. The valid values are viewer / collaborator / member / "
            "admin — validated at the serializer layer so the DB column stays "
            "a simple CharField that will accept future values without a "
            "schema migration."
        ),
    )
    card_density = models.CharField(
        max_length=20,
        default="comfortable",
        help_text=(
            "Per-board card layout density (#961). Drives how much metadata "
            "renders on the card face: ``comfortable`` shows one urgency badge "
            "and one primary label, ``compact`` adds due date and weight, "
            "``dense`` shows everything (today's pre-1.1 layout). New boards "
            "default to ``comfortable`` so first-time users get the cleaner "
            "scan; existing boards are migrated to ``dense`` to preserve their "
            "current visual. Validated at the serializer layer."
        ),
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "boards"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name


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

    class Meta:
        db_table = "columns"
        ordering = ["position"]
        unique_together = [["board", "position"], ["board", "name"]]

    def __str__(self):
        return f"{self.board.name} / {self.name}"


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

    class Meta:
        db_table = "swimlanes"
        ordering = ["position"]
        unique_together = ["board", "name"]

    def __str__(self):
        return self.name


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
    # Optimistic concurrency control — incremented on every mutation (move,
    # update, archive).  Clients send the version they have; the server
    # rejects the request with 409 if it has been modified in the meantime.
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

    class Meta:
        db_table = "cards"
        ordering = ["position"]
        indexes = [
            # Composite index to speed up WIP count queries: filter by board + column,
            # then filter active cards (archived_at IS NULL). Avoids a full table scan
            # when enforcement is enabled and card moves are frequent.
            models.Index(fields=["board", "column", "archived_at"], name="card_board_col_archived_idx"),
            # Trigram indexes for server-side card search (icontains on title and
            # description). pg_trgm supports ILIKE with leading wildcards — without
            # these a full sequential scan runs on every search request.
            # Requires: CREATE EXTENSION IF NOT EXISTS pg_trgm (migration 0030).
            GinIndex(fields=["title"], name="card_title_trgm_idx", opclasses=["gin_trgm_ops"]),
            GinIndex(fields=["description"], name="card_desc_trgm_idx", opclasses=["gin_trgm_ops"]),
        ]

    def __str__(self):
        return self.title


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
    """

    class MovementType(models.TextChoices):
        MOVE = "move", "Move"
        ARCHIVED = "archived", "Archived"
        UNARCHIVED = "unarchived", "Unarchived"

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="movements")
    from_column = models.ForeignKey(
        Column, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    to_column = models.ForeignKey(
        Column, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    from_swimlane = models.ForeignKey(
        Swimlane, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    to_swimlane = models.ForeignKey(
        Swimlane, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    from_column_name = models.CharField(max_length=255, blank=True, default="")
    to_column_name = models.CharField(max_length=255, blank=True, default="")
    from_swimlane_name = models.CharField(max_length=255, blank=True, default="")
    to_swimlane_name = models.CharField(max_length=255, blank=True, default="")
    # Stable UIDs captured at write time — parallel to the *_name fields above.
    # Rows where the FK was already NULL at migration time cannot be backfilled
    # and remain ""; this is intentional and consistent with the _name fields.
    from_column_uid = models.CharField(max_length=16, blank=True, default="")
    to_column_uid = models.CharField(max_length=16, blank=True, default="")
    from_swimlane_uid = models.CharField(max_length=16, blank=True, default="")
    to_swimlane_uid = models.CharField(max_length=16, blank=True, default="")
    moved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    moved_at = models.DateTimeField(auto_now_add=True, db_index=True)
    notes = models.CharField(max_length=500, blank=True)
    movement_type = models.CharField(
        max_length=20,
        choices=MovementType.choices,
        default=MovementType.MOVE,
    )

    class Meta:
        db_table = "card_movements"
        ordering = ["-moved_at"]
        indexes = [
            # Speeds up per-card movement history queries (card detail timeline,
            # analytics dwell-time calculations) by covering the card FK and the
            # default descending moved_at ordering in a single B-tree scan.
            models.Index(fields=["card", "-moved_at"], name="movement_card_moved_idx"),
        ]


class CardComment(models.Model):
    """A text comment left by a user on a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="comments")
    author = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

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

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="activities")
    event_type = models.CharField(max_length=30, choices=EventType.choices)
    from_value = models.TextField(blank=True)
    to_value = models.TextField(blank=True)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "card_activities"
        ordering = ["-created_at"]
        indexes = [
            # Covers per-card activity queries (card detail timeline, always
            # ordered by descending created_at). Avoids sequential scans on
            # boards with heavy activity history.
            models.Index(fields=["card", "-created_at"], name="activity_card_created_idx"),
        ]


class CardChecklist(models.Model):
    """A checklist item (to-do) attached to a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="checklist_items")
    text = models.CharField(max_length=500)
    is_checked = models.BooleanField(default=False)
    position = models.IntegerField(default=0)
    # Ownership field — mirrors the pattern on CardComment and CardAttachment so
    # collaborators can only edit/delete items they created. Nullable so existing
    # rows (before this migration) remain valid; the view layer treats null
    # created_by as "no ownership restriction" for backward compatibility.
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
        help_text="Number of cards included in the export payload."
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
