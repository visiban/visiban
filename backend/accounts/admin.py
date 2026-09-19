from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from django.db import transaction

from .models import (
    AdminActionLog,
    SiteSetting,
    User,
    record_site_setting_changes,
    snapshot_site_setting,
)

admin.site.register(User, UserAdmin)


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
