from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Extended user model. django-allauth handles OAuth linkage."""
    avatar_url = models.URLField(blank=True)
    display_name = models.CharField(max_length=150, blank=True)
    is_site_admin = models.BooleanField(default=False)
    must_change_password = models.BooleanField(default=False)

    class Meta:
        db_table = "users"
