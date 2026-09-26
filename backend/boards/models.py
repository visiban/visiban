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
            "and one primary label, ``standard`` adds due date and weight, "
            "``dense`` shows everything (today's pre-1.1 layout). New boards "
            "default to ``comfortable`` so first-time users get the cleaner "
            "scan; existing boards are migrated to ``dense`` to preserve their "
            "current visual. The middle tier is named ``standard`` rather than "
            "``compact`` to avoid colliding with the per-user *Card layout: "
            "Compact / Expanded* toolbar pref. Validated at the serializer layer."
        ),
    )
    show_wip_at_limit = models.BooleanField(
        default=False,
        help_text=(
            "When enabled, a column's header stat row shows a calm 'WIP n/n' "
            "indicator (in place of the normal card count) once the column's "
            "card count exactly equals its wip_limit (#973). Purely ambient — "
            "does not affect move enforcement, which is controlled by "
            "enforce_wip_limits / enforce_wip_hard. Off by default so existing "
            "boards are unchanged."
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
        # Added in 1.2 (#356). Purely additive: ``action_type`` is a CharField
        # with ``choices`` and no database CHECK constraint, so a new value emits
        # no DDL and locks nothing. Existing clients that switch on the value
        # must treat an unknown action_type as generic — the API docs say so.
        DUE_SOON = "due_soon", "due soon"

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

    #: One enum, referenced rather than copied — a second five-member enum would
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
    # The cap is 3 rather than the card face's 2 because row chips stack
    # *vertically* down that column, so three pinned fields cost three lines
    # rather than competing for one line's width. Raising this trades rows
    # visible on screen for metadata per row.
    MAX_PINNED_PER_BOARD = 3
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
