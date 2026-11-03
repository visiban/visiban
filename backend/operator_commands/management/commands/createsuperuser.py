"""Operator account creation that records itself in the admin action log.

Replaces Django's ``createsuperuser`` with the same arguments, prompts and
validation. The one difference is the final step: the ``create_superuser`` call
that stores the account and its password runs in one transaction with an
``AdminActionLog`` entry (``user.password_set``, source ``cli``), so a failed
log write leaves no account behind. Registry Rule 3 in
``docs/development/security-invariants.md`` lists this caller.

Django builds the account at the end of a long ``handle`` that mixes prompting
and creation, so the creation call is wrapped rather than the method copied;
that keeps the prompts, ``--noinput`` handling and validation Django's own.
No entry is written when the account is created with an unusable password
(``--noinput`` without ``DJANGO_SUPERUSER_PASSWORD``): no password was set,
which matches the Django admin add-user path. The two access flags the account
gets from superuser status are always recorded, as ``user.site_admin_granted``
and ``user.all_content_granted`` (#1830).
"""

from django.contrib.auth.management.commands import (
    createsuperuser as django_createsuperuser,
)
from django.db import transaction

from accounts.models import AdminActionLog, record_access_flag_changes


class _RecordingManager:
    """Manager view whose ``create_superuser`` also writes the log entry."""

    def __init__(self, manager, database):
        self._manager = manager.db_manager(database)
        self._database = database

    def __getattr__(self, name):
        return getattr(self._manager, name)

    def create_superuser(self, **user_data):
        with transaction.atomic(using=self._database):
            user = self._manager.create_superuser(**user_data)
            if user.has_usable_password():
                # Same transaction as the account write: a failed log write
                # rolls the account back. Only id and username are stored.
                AdminActionLog.record(
                    action=AdminActionLog.Action.USER_PASSWORD_SET,
                    source=AdminActionLog.Source.CLI,
                    metadata={"target_id": user.pk, "target_username": user.username},
                )
            # A new account held neither flag before superuser status gave it both.
            record_access_flag_changes(
                prior={"is_site_admin": False, "can_access_all_content": False},
                target=user,
                source=AdminActionLog.Source.CLI,
            )
            return user


class _RecordingUserModel:
    """Delegates to the user model, swapping in the recording manager."""

    def __init__(self, model):
        self._model = model

    def __call__(self, *args, **kwargs):
        return self._model(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._model, name)

    @property
    def _default_manager(self):
        # db_manager(database) is applied by Django; we need the database too,
        # so hand back a shim that defers to the recording manager.
        return _ManagerShim(self._model._default_manager)


class _ManagerShim:
    def __init__(self, manager):
        self._manager = manager

    def db_manager(self, database):
        return _RecordingManager(self._manager, database)

    def __getattr__(self, name):
        return getattr(self._manager, name)


class Command(django_createsuperuser.Command):
    help = "Create a superuser account and record it in the admin action log."

    def handle(self, *args, **options):
        real_model = self.UserModel
        self.UserModel = _RecordingUserModel(real_model)
        try:
            return super().handle(*args, **options)
        finally:
            self.UserModel = real_model
