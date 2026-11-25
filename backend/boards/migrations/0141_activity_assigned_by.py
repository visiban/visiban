# #2594 step 1 of 4: who assigned the card, on an assignee ``override_used``
# activity, so History can say " · Assigned by {name}".
#
# ``CardActivity.assigned_by`` is added with ``db_constraint=False`` so Django
# emits no FOREIGN KEY clause (adding one VALID would scan ``card_activities``
# under SHARE ROW EXCLUSIVE). 0142 adds it NOT VALID, 0143 validates it, 0144
# builds the partial index concurrently -- the #1923 sequence (0134..0137). The
# column is nullable with no default, so this AddField is catalog-only, and an
# older release's INSERT that does not name it writes NULL.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("boards", "0140_card_dimension_plan"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="cardactivity",
            name="assigned_by",
            field=models.ForeignKey(
                blank=True,
                db_constraint=False,
                db_index=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
