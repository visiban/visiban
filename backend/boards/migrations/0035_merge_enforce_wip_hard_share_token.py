from django.db import migrations


class Migration(migrations.Migration):
    """Merge migration — resolves the two leaf nodes created when
    0033_board_enforce_wip_hard (from #341) and 0034_board_share_token (from
    #348) were both rebased onto 0032_add_saved_filter independently.
    """

    dependencies = [
        ("boards", "0033_board_enforce_wip_hard"),
        ("boards", "0034_board_share_token"),
    ]

    operations = []
