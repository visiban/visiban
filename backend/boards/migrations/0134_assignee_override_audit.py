# #1923 MR A / #2584, step 1 of 4: the assignee-override switch, who set a
# card's assignee, and the two append-only audit tables (CardOverride,
# BoardSettingChange).
#
# ``Card.assigned_by`` is added with ``db_constraint=False`` so Django emits no
# FOREIGN KEY clause (adding one VALID would scan ``cards`` under SHARE ROW
# EXCLUSIVE). 0135 adds it NOT VALID, 0136 validates it, 0137 builds the
# partial index concurrently -- the #1799 sequence (0119..0123). The column is
# nullable with no default, so this AddField is catalog-only. The two new
# tables carry their indexes inline: an empty table is exempt.

import django.db.models.deletion
import django.utils.timezone
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('boards', '0133_cards_can_have_children_help_text'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='BoardSettingChange',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('setting', models.CharField(max_length=100)),
                ('old_value', models.CharField(blank=True, db_default='', default='', max_length=100)),
                ('new_value', models.CharField(blank=True, db_default='', default='', max_length=100)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                'db_table': 'board_setting_changes',
                'ordering': ['-created_at', '-id'],
            },
        ),
        migrations.CreateModel(
            name='CardOverride',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('card_uid', models.CharField(blank=True, db_default='', default='', max_length=16)),
                ('card_title', models.CharField(blank=True, db_default='', default='', max_length=500)),
                ('column_name', models.CharField(blank=True, db_default='', default='', max_length=255)),
                ('column_uid', models.CharField(blank=True, db_default='', default='', max_length=16)),
                ('kind', models.CharField(choices=[('entry_requirements', 'Entry requirements'), ('stage_gates', 'Stage gates'), ('wip', 'WIP limit'), ('weight', 'Weight limit')], max_length=20)),
                ('trigger', models.CharField(choices=[('move', 'Move'), ('create', 'Create'), ('restore', 'Restore'), ('weight_update', 'Weight update')], max_length=20)),
                ('actor_basis', models.CharField(choices=[('admin', 'Board admin'), ('site_admin', 'Site admin'), ('assignee', 'Assignee')], max_length=20)),
                ('reason', models.CharField(blank=True, db_default='', default='', max_length=500)),
                ('unmet', models.JSONField(blank=True, default=list)),
                ('created_at', models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                'db_table': 'card_overrides',
                'ordering': ['-created_at', '-id'],
            },
        ),
        migrations.AddField(
            model_name='board',
            name='allow_assignee_override',
            field=models.BooleanField(db_default=False, default=False, help_text="When enabled, a card's assignee (board role member or higher) can move it past a Block WIP or weight limit with a reason, unless they assigned the card to themselves. Hard limits still stop everyone. Every flip is recorded in BoardSettingChange."),
        ),
        migrations.AddField(
            model_name='card',
            name='assigned_by',
            field=models.ForeignKey(blank=True, db_constraint=False, db_index=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AlterField(
            model_name='cardactivity',
            name='event_type',
            field=models.CharField(choices=[('priority_change', 'Priority changed'), ('weight_change', 'Weight changed'), ('assignee_change', 'Assignee changed'), ('label_change', 'Labels changed'), ('description_change', 'Description changed'), ('comment_added', 'Comment added'), ('attachment_added', 'Attachment added'), ('attachment_deleted', 'Attachment deleted'), ('title_change', 'Title changed'), ('checklist_item_added', 'Checklist item added'), ('checklist_item_checked', 'Checklist item checked'), ('checklist_item_unchecked', 'Checklist item unchecked'), ('checklist_item_deleted', 'Checklist item deleted'), ('checklist_item_assigned', 'Checklist item assigned'), ('checklist_item_due_changed', 'Checklist item due date changed'), ('due_date_change', 'Due date changed'), ('blocked', 'Blocked'), ('unblocked', 'Unblocked'), ('custom_field_changed', 'Custom field changed'), ('parent_linked', 'Parent linked'), ('parent_unlinked', 'Parent unlinked'), ('child_linked', 'Child linked'), ('child_unlinked', 'Child unlinked'), ('children_removed_board_deleted', 'Children removed: board deleted'), ('parent_removed_board_deleted', 'Parent removed: board deleted'), ('planned_released', 'Planned child released'), ('needed_changed', 'Needed changed'), ('override_used', 'Override used')], max_length=30),
        ),
        migrations.AddField(
            model_name='boardsettingchange',
            name='actor',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='boardsettingchange',
            name='board',
            field=models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, related_name='setting_changes', to='boards.board'),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='actor',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='assigned_by',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to=settings.AUTH_USER_MODEL),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='board',
            field=models.ForeignKey(db_index=False, on_delete=django.db.models.deletion.CASCADE, related_name='+', to='boards.board'),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='card',
            field=models.ForeignKey(blank=True, db_index=False, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='overrides', to='boards.card'),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='column',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='boards.column'),
        ),
        migrations.AddField(
            model_name='cardoverride',
            name='movement',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='boards.cardmovement'),
        ),
        migrations.AddIndex(  # concurrency-exempt: table created in this migration, empty
            model_name='boardsettingchange',
            index=models.Index(fields=['board', '-created_at'], name='setting_change_board_idx'),
        ),
        migrations.AddIndex(  # concurrency-exempt: table created in this migration, empty
            model_name='cardoverride',
            index=models.Index(fields=['card', '-created_at'], name='override_card_created_idx'),
        ),
        migrations.AddIndex(  # concurrency-exempt: table created in this migration, empty
            model_name='cardoverride',
            index=models.Index(fields=['board', '-created_at'], name='override_board_created_idx'),
        ),
    ]
