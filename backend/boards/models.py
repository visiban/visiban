from django.db import models
from django.conf import settings


class Board(models.Model):
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="owned_boards"
    )
    members = models.ManyToManyField(
        settings.AUTH_USER_MODEL, through="BoardMembership", related_name="boards"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "boards"
        ordering = ["-updated_at"]

    def __str__(self):
        return self.name


class BoardMembership(models.Model):
    class Role(models.TextChoices):
        ADMIN = "admin"
        MEMBER = "member"
        VIEWER = "viewer"

    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships"
    )
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "board_memberships"
        unique_together = ["board", "user"]


class Column(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="columns")
    name = models.CharField(max_length=255)
    position = models.IntegerField(default=0)
    color = models.CharField(max_length=7, default="#6B7280")
    wip_limit = models.IntegerField(null=True, blank=True)
    weight_limit = models.IntegerField(null=True, blank=True)

    class Meta:
        db_table = "columns"
        ordering = ["position"]
        unique_together = ["board", "position"]

    def __str__(self):
        return f"{self.board.name} / {self.name}"


class Customer(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="customers")
    name = models.CharField(max_length=255)
    contact_email = models.EmailField(blank=True)
    notes = models.TextField(blank=True)
    position = models.IntegerField(default=0)
    color = models.CharField(max_length=7, default="#3B82F6")
    is_collapsed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "customers"
        ordering = ["position"]
        unique_together = ["board", "name"]

    def __str__(self):
        return self.name


class Label(models.Model):
    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="labels")
    name = models.CharField(max_length=50)
    color = models.CharField(max_length=7, default="#EAB308")

    class Meta:
        db_table = "labels"
        unique_together = ["board", "name"]

    def __str__(self):
        return self.name


class Card(models.Model):
    class Priority(models.TextChoices):
        LOW = "low"
        MEDIUM = "medium"
        HIGH = "high"
        URGENT = "urgent"

    board = models.ForeignKey(Board, on_delete=models.CASCADE, related_name="cards")
    column = models.ForeignKey(Column, on_delete=models.CASCADE, related_name="cards")
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="cards")
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

    class Meta:
        db_table = "cards"
        ordering = ["position"]

    def __str__(self):
        return self.title


class CardMovement(models.Model):
    """
    Automatic audit log entry created whenever a card is moved between
    columns and/or customers. Full pipeline movement history with timestamps.
    """
    card = models.ForeignKey(Card, on_delete=models.CASCADE, related_name="movements")
    from_column = models.ForeignKey(
        Column, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    to_column = models.ForeignKey(
        Column, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    from_customer = models.ForeignKey(
        Customer, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    to_customer = models.ForeignKey(
        Customer, on_delete=models.SET_NULL, null=True, related_name="+"
    )
    moved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True
    )
    moved_at = models.DateTimeField(auto_now_add=True)
    notes = models.CharField(max_length=500, blank=True)

    class Meta:
        db_table = "card_movements"
        ordering = ["-moved_at"]


class CardComment(models.Model):
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
    class EventType(models.TextChoices):
        PRIORITY_CHANGE = "priority_change", "Priority changed"
        WEIGHT_CHANGE = "weight_change", "Weight changed"
        ASSIGNEE_CHANGE = "assignee_change", "Assignee changed"
        LABEL_CHANGE = "label_change", "Labels changed"
        DESCRIPTION_CHANGE = "description_change", "Description changed"
        COMMENT_ADDED = "comment_added", "Comment added"
        ATTACHMENT_ADDED = "attachment_added", "Attachment added"
        ATTACHMENT_DELETED = "attachment_deleted", "Attachment deleted"

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
