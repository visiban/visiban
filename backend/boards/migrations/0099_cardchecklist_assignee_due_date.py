# #445: per-item assignee and due date on checklist items, plus two History
# event types. Both columns are nullable, so this is additive and zero-downtime.
# The assignee FK is added with db_index=False so AddField builds no index here;
# 0100 builds it concurrently in its own non-atomic migration. The event_type
# AlterField only extends choices and runs no SQL.

import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("boards", "0098_board_event_prune_type_mark"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name="cardchecklist",
            name="assignee",
            field=models.ForeignKey(
                blank=True,
                db_index=False,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="assigned_checklist_items",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddField(
            model_name="cardchecklist",
            name="due_date",
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name='cardactivity',
            name='event_type',
            field=models.CharField(choices=[('priority_change', 'Priority changed'), ('weight_change', 'Weight changed'), ('assignee_change', 'Assignee changed'), ('label_change', 'Labels changed'), ('description_change', 'Description changed'), ('comment_added', 'Comment added'), ('attachment_added', 'Attachment added'), ('attachment_deleted', 'Attachment deleted'), ('title_change', 'Title changed'), ('checklist_item_added', 'Checklist item added'), ('checklist_item_checked', 'Checklist item checked'), ('checklist_item_unchecked', 'Checklist item unchecked'), ('checklist_item_deleted', 'Checklist item deleted'), ('checklist_item_assigned', 'Checklist item assigned'), ('checklist_item_due_changed', 'Checklist item due date changed'), ('due_date_change', 'Due date changed'), ('blocked', 'Blocked'), ('unblocked', 'Unblocked')], max_length=30),
        ),
    ]
