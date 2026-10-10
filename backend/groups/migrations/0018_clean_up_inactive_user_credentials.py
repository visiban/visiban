from django.db import migrations
from django.utils import timezone


def clean_up_inactive_user_credentials(apps, schema_editor):
    """One-time cleanup of tokens and pending invites belonging to inactive accounts (#1583).

    Applies the deactivation housekeeping of #1510/#1563 (delete personal access
    tokens; revoke pending site, board and group invite links) to accounts that
    are already inactive. Scope: creators that are inactive; links whose creator
    is NULL or still active are out of scope.

    The rule mirrors ``AdminUserDeactivateView._revoke_invite_links`` over
    historical models (the live helper takes a real user and broadcasts
    events, neither of which a migration can do). Consumed links keep their
    history (``used_at`` set; #1445). As a one-time sweep it sends no live updates and leaves
    ``revoked_by`` empty. Data-only; reverse is a no-op because
    deleted tokens cannot be restored and revoked rows are indistinguishable
    from normally revoked ones.
    """
    User = apps.get_model("accounts", "User")
    PersonalAccessToken = apps.get_model("accounts", "PersonalAccessToken")
    InviteLink = apps.get_model("accounts", "InviteLink")
    BoardInviteLink = apps.get_model("boards", "BoardInviteLink")
    GroupInviteLink = apps.get_model("groups", "GroupInviteLink")

    inactive = list(User.objects.filter(is_active=False).values_list("pk", flat=True))
    if not inactive:
        return
    now = timezone.now()
    # Chunked so the IN list stays small on installs with many inactive accounts.
    for start in range(0, len(inactive), 500):
        ids = inactive[start:start + 500]
        PersonalAccessToken.objects.filter(user_id__in=ids).delete()
        InviteLink.objects.filter(
            created_by_id__in=ids, used_at__isnull=True, revoked_at__isnull=True,
        ).update(revoked_at=now)
        BoardInviteLink.objects.filter(
            created_by_id__in=ids, used_at__isnull=True, revoked_at__isnull=True,
        ).update(revoked_at=now)
        GroupInviteLink.objects.filter(
            created_by_id__in=ids, is_active=True, used_at__isnull=True,
        ).update(is_active=False)


# Lives in ``groups`` so it orders after groups/0017 and can depend on the
# accounts, boards and groups migrations without reordering older ones.
class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0035_invite_link_delivery"),
        ("boards", "0070_boardexportlog_row_count_help_text"),
        ("groups", "0017_deactivate_lapsed_admin_invite_links"),
    ]

    operations = [
        migrations.RunPython(clean_up_inactive_user_credentials, migrations.RunPython.noop),
    ]
