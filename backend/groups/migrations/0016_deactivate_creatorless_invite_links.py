from django.db import migrations


def deactivate_creatorless_links(apps, schema_editor):
    """Free cap slots held by links whose creator was deleted before #1513.

    ``created_by`` is SET_NULL, so such links stayed ``is_active`` forever. They
    already admit nobody (preview/join refuse a creatorless link); this only
    stops them being listed as active and counted toward the per-group cap.
    Consumed single-use links (``used_at`` set) keep their history (#1445).
    Data-only: no schema change, no lock beyond the row updates.
    """
    GroupInviteLink = apps.get_model("groups", "GroupInviteLink")
    GroupInviteLink.objects.filter(
        created_by__isnull=True, is_active=True, used_at__isnull=True,
    ).update(is_active=False)


class Migration(migrations.Migration):

    dependencies = [
        ("groups", "0015_invite_link_delivery"),
    ]

    operations = [
        # Reverse is a no-op: the deactivated rows cannot be told apart from
        # ones revoked normally, and reactivating them would be unsafe.
        migrations.RunPython(deactivate_creatorless_links, migrations.RunPython.noop),
    ]
