import uuid

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
    allowed_priorities = models.JSONField(
        default=list,
        help_text="Allowed card priorities on this board. Empty list means all priorities are allowed.",
    )
    enforce_wip_limits = models.BooleanField(
        default=True,
        help_text="When enabled, card moves into a column at or over its WIP limit are blocked with a 409 response. Board admins can override with ?force=true.",
    )
    enforce_weight_limits = models.BooleanField(
        default=True,
        help_text="When enabled, card moves into a column that would exceed its weight budget are blocked with a 409 response. Board admins can override with ?force=true.",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "boards"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name


class BoardMembership(models.Model):
    """Junction table recording a user's role on a board (admin/member/collaborator/viewer)."""

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

    class Meta:
        db_table = "columns"
        ordering = ["position"]
        unique_together = ["board", "position"]

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
    """
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
    moved_at = models.DateTimeField(auto_now_add=True)
    notes = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "card_movements"
        ordering = ["-moved_at"]


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


class CardChecklist(models.Model):
    """A checklist item (to-do) attached to a card."""

    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="checklist_items")
    text = models.CharField(max_length=500)
    is_checked = models.BooleanField(default=False)
    position = models.IntegerField(default=0)

    class Meta:
        db_table = "card_checklist_items"
        ordering = ["position"]

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
        blank=True,
        default="",
    )
    verb = models.CharField(max_length=500)
    card = models.ForeignKey(Card, on_delete=models.CASCADE, null=True, blank=True)
    board = models.ForeignKey(Board, on_delete=models.CASCADE, null=True, blank=True)
    read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "notifications"
        ordering = ["-created_at"]
