from django.db import connection, transaction
from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver


def _connect_user_signals():
    """Register post_save signal on the User model.

    Called from AccountsConfig.ready() so the import is deferred until Django
    is fully initialized and AUTH_USER_MODEL is resolved.
    """
    from django.contrib.auth import get_user_model
    User = get_user_model()

    @receiver(pre_save, sender=User, dispatch_uid="accounts.capture_prior_superuser_state")
    def capture_prior_superuser_state(sender, instance, update_fields=None, **kwargs):
        """Remember the stored access flags so post_save can detect a real demotion.

        Only a stored True -> False change of ``is_superuser`` matters, so the
        stored row is the reference (not the in-memory value, which callers
        may have mutated before loading). Skipped for inserts and for saves
        that cannot write ``is_superuser``.
        """
        instance._prior_access_state = None
        instance._derived_flags_need_write = False
        if instance.pk is None or instance._state.adding:
            return
        if update_fields is not None and "is_superuser" not in update_fields:
            return
        qs = sender.objects.filter(pk=instance.pk)
        # Inside a transaction the stored row is locked so a concurrent change
        # cannot slip between this read and the write. This is defensive:
        # the revocations that follow are idempotent, so a double run is
        # harmless; outside one (the plain
        # shell path) there is no lock to hold and the read is best-effort.
        if connection.in_atomic_block:
            qs = qs.select_for_update()
        prior = qs.values(
            "is_superuser", "is_active", "is_site_admin", "can_access_all_content"
        ).first()
        instance._prior_access_state = prior
        if prior and prior["is_superuser"] and not instance.is_superuser:
            # Cleared here so a full save writes the flags in the same UPDATE
            # as the demotion. A save restricted by update_fields cannot be
            # widened from a signal, so post_save writes them in that case.
            instance.is_site_admin = False
            instance.can_access_all_content = False
            instance._derived_flags_need_write = update_fields is not None and not {
                "is_site_admin",
                "can_access_all_content",
            } <= set(update_fields)

    @receiver(post_save, sender=User, dispatch_uid="accounts.ensure_superuser_is_site_admin")
    def ensure_superuser_is_site_admin(sender, instance, **kwargs):
        """Keep is_site_admin in sync with is_superuser.

        When a superuser is created (e.g. via createsuperuser or the ensure_site_admin
        management command) they should automatically hold the is_site_admin flag so
        the admin API is accessible from the first login, without requiring a separate
        step.  We use update_fields to avoid a recursive save loop.

        The reverse also holds (#1579): removing superuser status removes the
        two flags derived from it, and runs the same access-loss housekeeping
        as the other revocation routes. Both flags are cleared even for a user
        who was also granted site admin explicitly; the rule is deliberately
        simple and an administrator can re-grant site admin afterwards, which
        is safer than leaving elevated access behind. Only an actual stored
        True -> False transition triggers this, so ordinary saves of non-superusers
        never touch these flags. Enforcing "at least one site admin remains"
        is not enforced by this receiver.
        """
        prior = getattr(instance, "_prior_access_state", None)
        instance._prior_access_state = None
        if prior and prior["is_superuser"] and not instance.is_superuser:
            from .admin_views import apply_access_loss_revocations

            with transaction.atomic():
                if getattr(instance, "_derived_flags_need_write", False):
                    sender.objects.filter(pk=instance.pk).update(
                        is_site_admin=False,
                        can_access_all_content=False,
                    )
                # Deactivation has its own routes; compare only the other flags.
                apply_access_loss_revocations(
                    instance, None, {**prior, "is_active": instance.is_active}
                )
            return
        if instance.is_superuser and not instance.is_site_admin:
            sender.objects.filter(pk=instance.pk).update(
                is_site_admin=True,
                can_access_all_content=True,
            )
            # Refresh the in-memory instance so callers see the updated values.
            instance.is_site_admin = True
            instance.can_access_all_content = True
