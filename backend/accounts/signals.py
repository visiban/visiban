import logging

from django.db import connection, transaction
from django.db.models.signals import post_save, pre_delete, pre_save
from django.dispatch import receiver

logger = logging.getLogger(__name__)


def _connect_user_signals():
    """Register post_save signal on the User model.

    Called from AccountsConfig.ready() so the import is deferred until Django
    is fully initialized and AUTH_USER_MODEL is resolved.
    """
    from django.contrib.auth import get_user_model
    User = get_user_model()

    @receiver(pre_delete, sender=User, dispatch_uid="accounts.revoke_deleted_creator_site_invites")
    def revoke_site_invites_of_deleted_creator(sender, instance, **kwargs):
        """Revoke a user's pending site invite links before the user row goes (#1578).

        so they stop appearing as pending and stop counting against the
        site invite cap. A pre_delete receiver covers every deletion path (admin API, Django admin
        ``delete_selected``, shell, ``QuerySet.delete()``).
        """
        from .invite_utils import revoke_site_invite_links

        revoke_site_invite_links(instance)

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
            # FOR NO KEY UPDATE, not FOR UPDATE: the post_save that follows a
            # demotion revokes group invite links, waiting on link rows while
            # this lock is held, and a join holding a link row needs FOR KEY
            # SHARE on the creator's row, which FOR UPDATE conflicts with (a
            # deadlock). This save never changes the pk; a changed unique key
            # is escalated by PostgreSQL itself.
            qs = qs.select_for_update(no_key=True)
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
        """Keep is_site_admin and can_access_all_content in sync with is_superuser.

        When a superuser is created (e.g. via createsuperuser or the ensure_site_admin
        management command) they should automatically hold the is_site_admin flag so
        the admin API is accessible from the first login, without requiring a separate
        step.  We use update_fields to avoid a recursive save loop. A save that
        leaves either derived flag false on a superuser re-grants both (#1614),
        so no route can leave all-content access cleared on a superuser.

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
        if instance.is_superuser and not (
            instance.is_site_admin and instance.can_access_all_content
        ):
            # Conditional on the stored row still being a superuser: this
            # instance may be stale, and a demotion committed since it was
            # loaded must not be undone by a re-grant (#1614).
            granted = sender.objects.filter(pk=instance.pk, is_superuser=True).update(
                is_site_admin=True,
                can_access_all_content=True,
            )
            if granted:
                logger.info(
                    "Re-granted derived access flags on superuser pk=%s "
                    "(is_site_admin %s->True, can_access_all_content %s->True)",
                    instance.pk,
                    instance.is_site_admin,
                    instance.can_access_all_content,
                )
                # Refresh the in-memory instance so callers see the updated values.
                instance.is_site_admin = True
                instance.can_access_all_content = True

    @receiver(pre_save, sender=User, dispatch_uid="accounts.capture_prior_email")
    def capture_prior_email(sender, instance, update_fields=None, **kwargs):
        """Remember the stored email so post_save can tell the old address it changed.

        A receiver rather than a call in each view so that every route that
        writes ``User.email`` is covered, including allauth's own flows
        (``EmailAddress.set_as_primary`` saves ``User.email`` with
        ``update_fields``) and the Django admin. Skipped for inserts and for
        saves that cannot write the column, so the extra read only happens on
        full saves and saves that name ``email``.
        """
        instance._prior_email = None
        # A fixture load (``loaddata``) is not an account change and must not
        # mail anyone.
        if kwargs.get("raw") or instance.pk is None or instance._state.adding:
            return
        if update_fields is not None and "email" not in update_fields:
            return
        instance._prior_email = (
            sender.objects.filter(pk=instance.pk).values_list("email", flat=True).first()
        )

    @receiver(post_save, sender=User, dispatch_uid="accounts.notify_previous_email")
    def notify_previous_email(sender, instance, created=False, raw=False, **kwargs):
        """Send the previous address a notice once an email change commits.

        Only an actual move to a different mailbox counts: a case-only
        re-spelling is the same address and sends nothing. Deferred with
        ``on_commit`` so a change that rolls back never mails anyone, and the
        SMTP session is not held inside the transaction.
        """
        prior = getattr(instance, "_prior_email", None)
        instance._prior_email = None
        if raw or created or not prior:
            return
        if prior.strip().lower() == (instance.email or "").strip().lower():
            return
        from .email_change import send_previous_address_notice

        user_id = instance.pk
        transaction.on_commit(lambda: send_previous_address_notice(user_id, prior))
