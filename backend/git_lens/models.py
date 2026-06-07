from django.conf import settings
from django.db import models

from boards.models import Board


class LensConnection(models.Model):
    """Per-board configuration pointing at one external issue source.

    Provider-neutral on purpose: the ``git_lens`` app slug names the launch
    scope (Git providers), but the model hosts any future provider, so the class
    name avoids baking "Git" in. One lens per board (OneToOne) keeps the model
    minimal and lets the lens reuse the host board's RBAC.
    """

    class Provider(models.TextChoices):
        GITHUB = "github", "GitHub"
        GITLAB = "gitlab", "GitLab"

    board = models.OneToOneField(
        Board, on_delete=models.CASCADE, related_name="lens_connection"
    )
    provider = models.CharField(max_length=16, choices=Provider.choices)
    # "owner/repo" (GitHub) or "group/subgroup/project" (GitLab).
    repo_slug = models.CharField(max_length=255)
    column_dim = models.CharField(max_length=32, default="status")
    swimlane_dim = models.CharField(max_length=32, default="milestone")
    # SET_NULL (not CASCADE): deleting the user who configured the lens must not
    # delete the board's lens connection.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.provider}:{self.repo_slug} → board {self.board_id}"
