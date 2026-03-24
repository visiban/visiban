from django.db.models.signals import post_save
from django.dispatch import receiver


def _connect_user_signals():
    """Register post_save signal on the User model.

    Called from AccountsConfig.ready() so the import is deferred until Django
    is fully initialized and AUTH_USER_MODEL is resolved.
    """
    from django.contrib.auth import get_user_model
    User = get_user_model()

    @receiver(post_save, sender=User, dispatch_uid="accounts.ensure_superuser_is_site_admin")
    def ensure_superuser_is_site_admin(sender, instance, **kwargs):
        """Keep is_site_admin in sync with is_superuser.

        When a superuser is created (e.g. via createsuperuser or the ensure_site_admin
        management command) they should automatically hold the is_site_admin flag so
        the admin API is accessible from the first login, without requiring a separate
        step.  We use update_fields to avoid a recursive save loop.
        """
        if instance.is_superuser and not instance.is_site_admin:
            sender.objects.filter(pk=instance.pk).update(
                is_site_admin=True,
                can_access_all_content=True,
            )
            # Refresh the in-memory instance so callers see the updated values.
            instance.is_site_admin = True
            instance.can_access_all_content = True
