from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """Extended user model. django-allauth handles OAuth linkage."""
    avatar_url = models.URLField(blank=True)

    class Meta:
        db_table = "users"
