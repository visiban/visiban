from django.contrib.auth.models import AbstractUser
from django.core.cache import cache
from django.db import models

# Shared by models.py and adapter.py — defined here to avoid circular imports.
REGISTRATION_MODE_CACHE_KEY = "site_setting_registration_mode"
REGISTRATION_MODE_CACHE_TTL = 60  # seconds


def invalidate_registration_mode_cache():
    """Evict the cached registration_mode so the next read hits the DB."""
    cache.delete(REGISTRATION_MODE_CACHE_KEY)


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

    class Meta:
        db_table = "site_settings"

    def save(self, *args, **kwargs):
        # Enforce singleton: the row always has pk=1.
        self.pk = 1
        super().save(*args, **kwargs)
        # Invalidate the adapter's cache so the new mode takes effect
        # immediately without waiting for the TTL to expire.
        invalidate_registration_mode_cache()

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
    close_editor_on_enter = models.BooleanField(default=True)
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
