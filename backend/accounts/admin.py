from django.contrib import admin
from django.contrib.admin.utils import unquote
from django.contrib.auth.admin import UserAdmin
from django.db import transaction

from .models import (
    AdminActionLog,
    SiteSetting,
    User,
    record_site_setting_changes,
    snapshot_site_setting,
)
from .credentials import finalize_password_change, require_password_change_after_admin_set


@admin.register(User)
class VisibanUserAdmin(UserAdmin):
    """Django's ``UserAdmin`` with the project's password rules applied (#1551).

    A password set through the admin's per-user password form has the same
    follow-up as every other route (registry Rule 3): see
    ``user_change_password``. A user created here must choose their own
    password on first use, as with ``AdminUsersView.post``.

    The admin's own "change my password" page (``/admin/password_change/``) is
    routed to the SPA in ``visiban/urls.py`` instead.
    """

    def user_change_password(self, request, id, form_url=""):
        """Run Django's view, then apply the password follow-up if it set one.

        Django's view is not reimplemented: whether a password was set is
        decided by comparing the stored hash before and after it runs, not by
        its (translated) success message. GET, an invalid form and a refused
        request leave the hash unchanged and so have no side effects.

        - The actor's own account: the self-service follow-up
          (``finalize_password_change``).
        - Another account: their tokens are revoked and, if a usable password
          was set, the owner must choose a new one
          (``require_password_change_after_admin_set``). Their sessions end
          because the session auth hash derives from the password hash;
          Django refreshes only the actor's own session.
        """
        if request.method != "POST":
            return super().user_change_password(request, id, form_url)
        target = self.get_object(request, unquote(id))
        if target is None:
            # Django's view raises the 404 (or 403) itself.
            return super().user_change_password(request, id, form_url)
        with transaction.atomic():
            before = _stored_password_hash(target.pk, lock=True)
            response = super().user_change_password(request, id, form_url)
            if _stored_password_hash(target.pk) != before:
                target.refresh_from_db()
                if request.user.pk == target.pk:
                    finalize_password_change(target)
                else:
                    require_password_change_after_admin_set(target)
        return response

    def save_model(self, request, obj, form, change):
        """A user added here with a password must choose their own on first use.

        An account added with password sign-in disabled is left alone: the flag
        would make its owner create a password the administrator chose not to
        give it.
        """
        if not change and obj.has_usable_password():
            obj.must_change_password = True
        if not change:
            super().save_model(request, obj, form, change)
            return
        # Deactivating here applies the same revocation
        # housekeeping as the admin API (#1563). The stored values are read
        # under a row lock before the save because the ModelForm has already
        # written the submitted values onto ``obj``.
        from .admin_views import access_state, apply_access_loss_revocations, lock_user_row

        with transaction.atomic():
            try:
                stored = lock_user_row(obj.pk)
            except User.DoesNotExist:
                stored = None
            if stored is not None and form is not None:
                # The form wrote its values onto the instance Django loaded
                # earlier in this request. Between that load and the lock
                # taken above, another request can change a field the form
                # does not carry (a demotion, a pending password-change
                # flag); those fields must come from the locked row, or this
                # save would write the older values back.
                for field in User._meta.concrete_fields:
                    if field.name not in form.fields:
                        setattr(obj, field.attname, getattr(stored, field.attname))
            super().save_model(request, obj, form, change)
            if stored is not None:
                apply_access_loss_revocations(obj, request.user, access_state(stored))


def _stored_password_hash(pk, *, lock=False):
    qs = User.objects.filter(pk=pk)
    if lock:
        qs = qs.select_for_update()
    return qs.values_list("password", flat=True).first()


@admin.register(SiteSetting)
class SiteSettingAdmin(admin.ModelAdmin):
    """Singleton admin — clicking 'Site settings' goes straight to the edit form."""

    def has_add_permission(self, request):
        # Prevent creating additional rows; there is always exactly one.
        return not SiteSetting.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False

    def save_model(self, request, obj, form, change):
        """Audit-log setting changes made through Django admin (#1126).

        Django admin is a genuine operator path for these toggles — it is the
        documented second break-glass route for maintenance mode — and it
        bypasses the REST serializer entirely, so without this override a flip
        made here would leave no entry in the action log.

        The previous state is re-read from the database rather than taken from
        ``obj``: by the time ``save_model`` runs, the ModelForm has already
        written the submitted values onto the instance, so ``obj`` holds the new
        state on both sides of the comparison.

        That re-read is taken under ``select_for_update`` inside the same
        transaction as the save, for the same reason as
        ``AdminSettingsView.patch``: an unlocked read lets a concurrent edit
        land between the snapshot and the save, which yields an audit row
        describing a transition that never happened.
        """
        with transaction.atomic():
            previous = SiteSetting.objects.select_for_update().filter(pk=obj.pk).first()
            # On the add path there is no stored row yet (obj.pk is None, and
            # `pk__exact=None` matches nothing). Diff against the model defaults
            # rather than skipping the audit: that form is reachable on a
            # first-boot instance, and an operator who creates the singleton
            # with maintenance mode already on should not be the one change that
            # goes unrecorded.
            before = snapshot_site_setting(previous if previous else SiteSetting())

            super().save_model(request, obj, form, change)
            record_site_setting_changes(
                before=before,
                after=obj,
                actor=request.user,
                source=AdminActionLog.Source.DJANGO_ADMIN,
            )

    def changelist_view(self, request, extra_context=None):
        # Skip the list view and redirect directly to the single object.
        from django.http import HttpResponseRedirect
        from django.urls import reverse
        obj = SiteSetting.get()
        return HttpResponseRedirect(
            reverse("admin:accounts_sitesetting_change", args=[obj.pk])
        )
