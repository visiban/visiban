# #2718, step 3 of 3: drop the pre-lt/lte operand rule.
#
# 0154 added "entry_req_operand_iff_needed_v2" NOT VALID and validated it. This
# migration only removes the old constraint (catalog-only), atomic, in its own
# transaction so a failure here cannot wedge 0154's non-atomic steps.
#
# Reverse: re-adding the old rule fails while any lt/lte row exists (the old
# rule refuses an operand on them); delete those rows before rolling back.
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("boards", "0154_entry_requirement_lt_lte"),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name="columnentryrequirement",
            name="entry_req_operand_iff_needed",
        ),
    ]
