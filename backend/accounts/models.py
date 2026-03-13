from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Extended user model. django-allauth handles OAuth linkage."""
    avatar_url = models.URLField(blank=True)
    display_name = models.CharField(max_length=150, blank=True)
    is_site_admin = models.BooleanField(default=False)
    must_change_password = models.BooleanField(default=False)
    timezone = models.CharField(max_length=64, blank=True, default="")
    notif_card_assigned = models.BooleanField(default=True)
    notif_mentioned = models.BooleanField(default=True)
    notif_due_soon = models.BooleanField(default=False)
    notif_card_moved = models.BooleanField(default=False)
    notif_comment_added = models.BooleanField(default=False)

    class Meta:
        db_table = "users"
