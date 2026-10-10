"""allauth password signal receivers (#1551).

allauth's HTML views (``accounts/password/change/``, ``accounts/password/set/``
and ``accounts/password/reset/key/...``) save the password through the
project's forms in ``accounts.forms``, which apply the follow-up from
``accounts.credentials`` in the same transaction as the save. After the save,
allauth sends ``password_changed``, ``password_set`` or ``password_reset``;
these receivers run the same idempotent helpers again as a backstop, so a
password-setting form that does not finalize still ends in the same state.
Connected in ``AccountsConfig.ready``.

The REST routes do not send these signals: dj-rest-auth's serializers save
through Django's ``SetPasswordForm``, and ``ChangePasswordView`` calls
``set_password`` directly (``accounts/tests/test_forced_change_html_surfaces.py``
pins this). A receiver that raises is not caught, so the request fails.
"""

from __future__ import annotations

from . import credentials


def finalize_on_password_changed(sender, request, user, **kwargs):
    """allauth ``password_changed``: the user changed their own password."""
    credentials.finalize_password_change(user)


def finalize_on_password_set(sender, request, user, **kwargs):
    """allauth ``password_set``: a password-less (social-only) user set one."""
    credentials.finalize_password_change(user)


def finalize_on_password_reset(sender, request, user, **kwargs):
    """allauth ``password_reset``: a password was set from a reset link."""
    credentials.finalize_password_reset(user)


def connect_password_signals():
    from allauth.account.signals import password_changed, password_reset, password_set

    password_changed.connect(
        finalize_on_password_changed,
        dispatch_uid="accounts.finalize_on_password_changed",
    )
    password_set.connect(
        finalize_on_password_set,
        dispatch_uid="accounts.finalize_on_password_set",
    )
    password_reset.connect(
        finalize_on_password_reset,
        dispatch_uid="accounts.finalize_on_password_reset",
    )
