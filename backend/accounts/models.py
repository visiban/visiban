from django.contrib.auth.models import AbstractUser
from django.db import models


class SiteSetting(models.Model):
    """Singleton model for instance-wide configuration. Always access via SiteSetting.get()."""

    require_invite_for_registration = models.BooleanField(
        default=False,
        help_text=(
            "When enabled, self-registration is blocked. "
            "New accounts can only be created by site admins via the admin panel."
        ),
    )

    class Meta:
        db_table = "site_settings"

    def save(self, *args, **kwargs):
        # Enforce singleton: the row always has pk=1.
        self.pk = 1
        super().save(*args, **kwargs)

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj


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
    date_format = models.CharField(max_length=16, blank=True, default="MM/DD/YYYY")
    time_format = models.CharField(max_length=4, blank=True, default="12h")
    number_locale = models.CharField(max_length=16, blank=True, default="en-US")

    class Meta:
        db_table = "users"
