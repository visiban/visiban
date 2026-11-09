import functools

from django import forms
from django.contrib import admin, messages
from django.contrib.admin.actions import delete_selected
from django.contrib.admin.utils import unquote
from django.contrib.auth.admin import GroupAdmin, UserAdmin
from django.contrib.auth.hashers import is_password_usable
from django.contrib.auth.forms import UserChangeForm
from django.contrib.auth.models import Group as AuthGroup
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.models import Q
from django.http import HttpResponseRedirect
from django.urls import reverse

from visiban.admin_row_version import (
    RowVersionAdminMixin,
    RowVersionField,
    RowVersionFormMixin,
    StaleSubmission,
)

from .models import (
    AdminActionLog,
    SiteSetting,
    User,
    record_access_flag_changes,
    record_site_setting_changes,
    snapshot_site_setting,
)
from boards.models import Board, Card, Column
from boards.admin_mixins import ContainerChangedAdminMixin
from boards.services.cards import lock_cards_for_cascade

from .credentials import finalize_password_change, require_password_change_after_admin_set


#: Fields only a superuser may edit in the Django admin user form (#1577).
#: Fields only a superuser changes on another account that ``_is_protected_other_account`` covers.
_PROTECTED_IDENTITY_FIELDS = ("email", "username", "first_name", "last_name", "is_active")

_SUPERUSER_ONLY_FIELDS = ("is_staff", "is_superuser", "groups", "user_permissions")


STALE_FORM_MESSAGE = (
    "This account was changed after this page was opened. Reload the page and "
    "make your changes again."
)

#: Shown after a redirect to the change page, which then shows the current state.
STALE_SAVE_MESSAGE = (
    "This account was changed after this page was opened, so nothing was saved. "
    "The page now shows the current state of the account; make your changes again."
)


class VisibanUserChangeForm(RowVersionFormMixin, UserChangeForm):
    """The user change form with the admin API's account guards.

    ``VisibanUserAdmin.get_form`` sets ``guard_actor`` to the requesting user.
    The guards apply to every actor: deactivating one's own account, a board
    owner or the last active site admin, and removing one's own or the last
    active superuser status, are refused. Refusals are form errors so they
    render on the form and nothing is saved.

    ``row_version`` records the account's stored values, for the fields this
    form writes, as the form rendered them (#1622; the shared mechanism is in
    ``visiban/admin_row_version.py``). A submission made against an older
    state of the account is refused:

    - ``clean`` compares it with the row read when the submission arrives and
      refuses with a form error asking for a reload;
    - ``VisibanUserAdmin.save_model`` compares it again with the row (and
      its groups and permissions) read under the row lock, and
      ``save_related`` re-reads the groups and permissions before writing
      them; a mismatch there rolls the save back and redirects to the change
      page with an error message.

    A submission without ``row_version`` (not produced by the rendered form)
    skips both comparisons; it carries no privilege, since the same
    administrator could submit any values. Such a submission still keeps the
    stored value of every field the administrator left alone.
    """

    guard_actor = None

    row_version = RowVersionField(required=False)
    stale_form_message = STALE_FORM_MESSAGE

    def clean(self):
        # RowVersionFormMixin.clean refuses a stale row_version first (#1622).
        cleaned = super().clean()
        actor = self.guard_actor
        stored = self.instance  # clean() runs before the instance is updated
        if actor is None or not stored.pk:
            return cleaned
        from .admin_views import deactivation_refusal, demotion_refusal

        if stored.is_active and "is_active" in self.fields and cleaned.get("is_active") is False:
            refusal = deactivation_refusal(stored, actor, include_last_site_admin=True)
            if refusal is not None:
                raise ValidationError(_refusal_message(refusal), code="deactivation_refused")
        if stored.is_superuser and "is_superuser" in self.fields and cleaned.get("is_superuser") is False:
            refusal = demotion_refusal(stored, actor)
            if refusal is not None:
                raise ValidationError(_refusal_message(refusal), code="demotion_refused")
        return cleaned


def _is_protected_other_account(actor, target):
    """True for a staff, superuser, site-admin or all-content account other than *actor*'s own.

    The Django admin's account-changing and delete routes are superuser-only
    for these accounts: a staff account's Django permissions (groups, user
    permissions) are not comparable between actor and target, so no
    "broader than the actor" test is attempted and the whole class stays with
    superusers. An all-content account is in the class because only a superuser
    grants that flag (#1830), so the account is administered at the same level.
    """
    return (
        target is not None
        and target.pk != actor.pk
        and (
            target.is_staff
            or target.is_superuser
            or target.is_site_admin
            or target.can_access_all_content
        )
    )


def _refusal_message(refusal):
    # Board names stay out of the form message; the count is enough here.
    message = refusal.body["detail"]
    boards = refusal.body.get("owned_boards")
    if boards:
        message += f" Owned boards: {len(boards)}."
    return message


class DeletionRefused(Exception):
    """A user delete was refused; ``messages`` are shown to the administrator (#1616)."""

    def __init__(self, messages_):
        super().__init__("; ".join(messages_))
        self.messages = list(messages_)


def user_deletion_refusals(targets, actor):
    """Reasons *targets* may not be deleted by *actor*, as admin-facing strings.

    Deleting a user cascades to the boards they own (``Board.owner`` is
    CASCADE), so the deactivation rules apply to a delete as well: no
    self-deletion and no deleting a board owner before the boards are
    transferred (``deactivation_refusal``, the rule the form and the admin API
    share), and never the last active site admin or the last active
    superuser, mirroring ``demotion_refusal`` (#1616).

    A bulk delete is judged as a set: each account is checked on its own, and
    the active site admins and superusers left outside the set must be
    non-empty, because two accounts that are each "not the last" can be the
    last two. The same rules apply to every actor, superusers included, as on
    the change form. ``delete_model`` and ``delete_queryset`` call this twice
    under row locks (see ``VisibanUserAdmin._lock_and_check_admins`` and
    ``_lock_cards_then_targets``): the administrator flags and counts cannot
    move once the first lock is held, and the owned-boards rule is judged
    again after the target rows are locked ``FOR UPDATE``. Board names are not
    shown, only a count, as on the form.

    Deleting a user also cascades to the groups they own (``Group.owner`` is
    CASCADE), so ownership of every owned group is transferred first, and a
    non-superuser actor may delete only accounts that are not another staff,
    superuser, site-admin or all-content account (``_is_protected_other_account``).

    The delete also removes the targets' group memberships
    (``GroupMembership.user`` is CASCADE), so it keeps the group rule that
    ``lock_membership_for_removal_or_demotion`` keeps for a single membership
    change: every group the targets actively administer must keep an active
    admin outside the set (``groups.services.groups_left_without_admin``).
    Under the delete's locks the rows of those groups are held from statement
    1 on (``lock_groups_administered_by``), so a membership removal, demotion
    or ownership transfer on them queues behind the delete. Statement 1 also
    holds the account rows of those groups' other admins
    (``admin_accounts_of_groups_administered_by``), so their active flag
    cannot change under the count: a concurrent deactivation queues (#1814).
    A promotion of a target, or an ownership transfer to one, locks the
    target's account row first (``groups.services.lock_member_accounts``), so
    it queues behind the delete too. An account made a group admin after
    statement 1 is counted by the statement 3 re-check without its row held;
    a superuser ownership transfer to an active member recovers a group left
    without an active admin.
    """
    from .admin_views import deactivation_refusal

    targets = list(targets)
    reasons = []
    for target in targets:
        refusal = deactivation_refusal(target, actor)
        if refusal is None:
            continue
        if refusal.body.get("code") == "owned_boards":
            count = len(refusal.body.get("owned_boards", []))
            reason = (
                "User owns boards that must be transferred before deletion "
                f"(owned boards: {count})."
            )
        elif target.pk == actor.pk:
            reason = "You cannot delete your own account."
        else:
            reason = "This account cannot be deleted."
        reasons.append(f"{target}: {reason}")
    from groups.models import Group
    from groups.services import groups_left_without_admin

    for target in targets:
        if not actor.is_superuser and _is_protected_other_account(actor, target):
            reasons.append(f"{target}: Only a superuser can delete this account.")
        # Group.owner is CASCADE: the groups, their subgroups and memberships
        # would go with the owner, so ownership is transferred first.
        group_count = Group.objects.filter(owner=target).count()
        if group_count:
            reasons.append(
                f"{target}: User owns groups that must be transferred before "
                f"deletion (owned groups: {group_count}). A superuser can use "
                "the Groups admin's \"Transfer ownership\" action."
            )
    target_pks = {t.pk for t in targets}
    single = len(targets) == 1
    for flag, singular, plural in (
        ("is_site_admin", "the last active site admin", "every active site admin"),
        ("is_superuser", "the last active superuser", "every active superuser"),
    ):
        if any(getattr(t, flag) and t.is_active for t in targets):
            outside = User.objects.filter(**{flag: True, "is_active": True}).exclude(
                pk__in=target_pks
            )
            if not outside.exists():
                reasons.append(f"Cannot delete {singular if single else plural}.")
    # Judged as a set, like the administrator flags above: two admins that are
    # each "not the last" of a group can be its last two.
    stranded = groups_left_without_admin(target_pks)
    if stranded:
        whom = "the last active admin" if single else "every active admin"
        reasons.append(
            f"Cannot delete {whom} of a group (groups: {len(stranded)}). Make "
            "another active member an admin of the group first."
        )
    return reasons


def guarded_delete_selected(modeladmin, request, queryset):
    """The ``delete_selected`` action with the user-delete guards applied (#1616).

    Atomic by design: when any selected account is refused, nothing is deleted
    and every reason is shown, so a partial delete never leaves the
    administrator guessing what happened. Checked before the confirmation page
    and again on the confirming POST. The stock action runs in one
    transaction so the deletion log entries Django writes roll back with a
    refusal raised under the row lock.
    """
    if not modeladmin.has_delete_permission(request):
        raise PermissionDenied
    reasons = user_deletion_refusals(queryset, request.user)
    if not reasons:
        try:
            with transaction.atomic():
                return delete_selected(modeladmin, request, queryset)
        except DeletionRefused as exc:
            reasons = exc.messages
    for reason in reasons:
        modeladmin.message_user(request, reason, messages.ERROR)
    modeladmin.message_user(request, "No accounts were deleted.", messages.ERROR)
    return None


functools.update_wrapper(guarded_delete_selected, delete_selected)


@admin.register(User)
class VisibanUserAdmin(RowVersionAdminMixin, ContainerChangedAdminMixin, UserAdmin):
    """Django's ``UserAdmin`` with the project's password rules applied (#1551).

    A password set through the admin's per-user password form has the same
    follow-up as every other route (registry Rule 3): see
    ``user_change_password``. A user created here must choose their own
    password on first use, as with ``AdminUsersView.post``.

    The admin's own "change my password" page (``/admin/password_change/``) is
    routed to the SPA in ``visiban/urls.py`` instead.

    ``RowVersionAdminMixin`` adds the hidden ``row_version`` to the change
    form, writes only the groups and permissions the administrator changed
    (``save_related``) and answers a refusal under the row lock with a
    message (#1622).
    """

    form = VisibanUserChangeForm
    stale_save_message = STALE_SAVE_MESSAGE

    def get_queryset(self, request):
        """Non-superuser staff do not see superuser accounts."""
        qs = super().get_queryset(request)
        if not request.user.is_superuser:
            qs = qs.filter(is_superuser=False)
        return qs

    def get_form(self, request, obj=None, **kwargs):
        form = super().get_form(request, obj, **kwargs)
        form.guard_actor = request.user
        return form

    def _refuse_privileged_password_target(self, request, id):
        """Only a superuser sets the password of an account ``_is_protected_other_account`` covers.

        The lookup bypasses ``get_queryset`` so a superuser target is refused
        explicitly rather than reported as missing. An account's own password
        form stays available to its owner.
        """
        if request.user.is_superuser:
            return
        try:
            target = (
                admin.ModelAdmin.get_queryset(self, request)
                .filter(pk=unquote(id))
                .only("pk", "is_staff", "is_superuser", "is_site_admin", "can_access_all_content")
                .first()
            )
        except (ValueError, ValidationError):
            return
        if _is_protected_other_account(request.user, target):
            raise PermissionDenied

    def user_change_password(self, request, id, form_url=""):
        """Run Django's view, then apply the password follow-up if it set one.

        Django's view is not reimplemented: whether a password was set is
        decided by comparing the stored hash before and after it runs, not by
        its (translated) success message. GET, an invalid form and a refused
        request leave the hash unchanged and so have no side effects.

        - The actor's own account: the self-service follow-up
          (``finalize_password_change``).
        - Another account: their tokens are revoked and, if a usable password
          was set, the owner must choose a new one
          (``require_password_change_after_admin_set``). Their sessions end
          because the session auth hash derives from the password hash;
          Django refreshes only the actor's own session.
        """
        self._refuse_privileged_password_target(request, id)
        if request.method != "POST":
            return super().user_change_password(request, id, form_url)
        target = self.get_object(request, unquote(id))
        if target is None:
            # Django's view raises the 404 (or 403) itself.
            return super().user_change_password(request, id, form_url)
        with transaction.atomic():
            before = _stored_password_hash(target.pk, lock=True)
            # Protection is judged again with the hash row locked: the target
            # may have become a staff, superuser, site-admin or all-content account, or the
            # actor lost superuser status, since the request started.
            actor_now = User.objects.filter(pk=request.user.pk).first()
            target_now = User.objects.filter(pk=target.pk).first()
            if (
                actor_now is not None
                and not actor_now.is_superuser
                and _is_protected_other_account(actor_now, target_now)
            ):
                raise PermissionDenied
            response = super().user_change_password(request, id, form_url)
            if _stored_password_hash(target.pk) != before:
                target.refresh_from_db()
                if request.user.pk == target.pk:
                    # The hash captured under the lock before the form ran
                    # tells whether this is the account's first password.
                    finalize_password_change(
                        target,
                        first_password=(
                            not is_password_usable(before) and target.has_usable_password()
                        ),
                    )
                else:
                    require_password_change_after_admin_set(target)
                    # Recorded in the same transaction as the password write,
                    # so a rolled-back change leaves no entry. Only the target's
                    # id and username are stored, never the password or hash.
                    AdminActionLog.record(
                        action=(
                            AdminActionLog.Action.USER_PASSWORD_SET
                            if target.has_usable_password()
                            else AdminActionLog.Action.USER_PASSWORD_DISABLED
                        ),
                        source=AdminActionLog.Source.DJANGO_ADMIN,
                        actor=request.user,
                        metadata={
                            "target_id": target.pk,
                            "target_username": target.username,
                        },
                    )
        return response

    def get_readonly_fields(self, request, obj=None):
        """Only a superuser may edit privilege-bearing fields (#1579)."""
        readonly = tuple(super().get_readonly_fields(request, obj))
        if not request.user.is_superuser:
            readonly += tuple(f for f in _SUPERUSER_ONLY_FIELDS if f not in readonly)
            if _is_protected_other_account(request.user, obj):
                # Same predicate as the password form: identity fields feed
                # password reset and ``is_active`` locks the account out, so
                # for these accounts they stay with superusers.
                readonly += tuple(
                    f for f in _PROTECTED_IDENTITY_FIELDS if f not in readonly
                )
        return readonly

    def save_model(self, request, obj, form, change):
        """A user added here with a password must choose their own on first use.

        An account added with password sign-in disabled is left alone: the flag
        would make its owner create a password the administrator chose not to
        give it.
        """
        if not change and obj.has_usable_password():
            obj.must_change_password = True
        if not change:
            # The audit entry shares the save's transaction, so a failed write
            # leaves no account behind. Reuses ``user.password_set``: the
            # administrator chose this account's first password. No entry when
            # sign-in by password is disabled, because no password was set.
            with transaction.atomic():
                super().save_model(request, obj, form, change)
                if obj.has_usable_password():
                    AdminActionLog.record(
                        action=AdminActionLog.Action.USER_PASSWORD_SET,
                        source=AdminActionLog.Source.DJANGO_ADMIN,
                        actor=request.user,
                        metadata={
                            "target_id": obj.pk,
                            "target_username": obj.username,
                        },
                    )
            return
        # Deactivating here applies the same revocation
        # housekeeping as the admin API (#1563). The stored values are read
        # under a row lock before the save because the ModelForm has already
        # written the submitted values onto ``obj``.
        from .admin_views import (
            access_state,
            apply_access_loss_revocations,
            deactivation_refusal,
            demotion_refusal,
        )

        with transaction.atomic():
            # One pk-ordered lock covers the target and every row the guards
            # count (active site admins and active superusers). A single
            # ordered statement gives concurrent saves the same lock order, so
            # they serialize instead of deadlocking, and two accounts removing
            # each other's access cannot both pass the last-admin checks.
            #
            # FOR NO KEY UPDATE, the mode the deactivate endpoint takes: the
            # revocations below wait on invite link rows while this lock is
            # held, and a join that already holds a link row needs FOR KEY
            # SHARE on the creator's row. FOR UPDATE would conflict with it
            # and deadlock; NO KEY UPDATE does not, and still conflicts with
            # itself and FOR UPDATE, so saves and guards still queue. The
            # save does not change the pk; if a submitted unique key (the
            # username) does change, PostgreSQL escalates that UPDATE to the
            # stronger mode by itself.
            locked = list(
                User.objects.select_for_update(no_key=True)
                .filter(
                    Q(pk=obj.pk)
                    | Q(is_site_admin=True, is_active=True)
                    | Q(is_superuser=True, is_active=True)
                )
                .order_by("pk")
            )
            stored = next((u for u in locked if u.pk == obj.pk), None)
            # clean() compared row_version before this lock; compare it again
            # with the locked row so a submission made against an older state
            # of the account is refused (#1622). The groups and permissions
            # read here are checked again in save_related, before they are
            # written.
            self.check_row_version(form, stored)
            if stored is not None and form is not None:
                # The form wrote its values onto the instance Django loaded
                # earlier in this request. Between that load and the lock
                # taken above, another request can change a field the form
                # does not carry (a demotion, a pending password-change
                # flag); those fields must come from the locked row, or this
                # save would write the older values back.
                #
                # The same holds for a field the form carries but the
                # administrator did not change (#1619): the form re-submits
                # every value it rendered, including the read-only password
                # hash, so only the fields in ``changed_data`` take the
                # submitted value. An unbound form (no submission) has no
                # ``changed_data`` to go by, so only the first rule applies.
                self.keep_unchanged_fields(obj, form, stored)
            if stored is not None and not request.user.pk == stored.pk:
                # Protection is judged again on the locked target and the
                # actor's current row: the target may have become a staff,
                # superuser, site-admin or all-content account, or the actor lost
                # superuser status, since the form was built (the read-only
                # fields were chosen from the row loaded at request start).
                actor_now = User.objects.filter(pk=request.user.pk).first()
                if (
                    actor_now is not None
                    and not actor_now.is_superuser
                    and _is_protected_other_account(actor_now, stored)
                    and any(
                        getattr(obj, f) != getattr(stored, f)
                        for f in _PROTECTED_IDENTITY_FIELDS
                    )
                ):
                    raise PermissionDenied
            if (
                stored is not None
                and obj.is_superuser
                and not stored.is_superuser
                and not User.objects.filter(
                    pk=request.user.pk, is_superuser=True, is_active=True
                ).exists()
            ):
                # Superuser status brings all-content access with it, and only
                # a superuser grants that (#1830). The field is read-only for
                # anyone else, but that was chosen from the actor as loaded at
                # request start.
                raise PermissionDenied
            if stored is not None:
                # The form's checks ran before this lock was taken; repeat them
                # against the locked rows. They run after the values above are
                # taken from the locked row, so they judge what this save will
                # write: a stale rendered value the administrator left alone is
                # not a deactivation or demotion.
                if (stored.is_active and not obj.is_active and deactivation_refusal(
                    stored, request.user, include_last_site_admin=True
                )) or (stored.is_superuser and not obj.is_superuser and demotion_refusal(
                    stored, request.user
                )):
                    raise PermissionDenied
            super().save_model(request, obj, form, change)
            if stored is not None:
                prior = access_state(stored)
                apply_access_loss_revocations(obj, request.user, prior)
                # This form does not carry either flag; they move with superuser
                # status (accounts/signals.py), which has updated obj by now.
                record_access_flag_changes(
                    prior=prior,
                    target=obj,
                    actor=request.user,
                    source=AdminActionLog.Source.DJANGO_ADMIN,
                )

    def get_actions(self, request):
        actions = super().get_actions(request)
        if "delete_selected" in actions:
            _func, name, description = actions["delete_selected"]
            actions["delete_selected"] = (guarded_delete_selected, name, description)
        return actions

    def delete_view(self, request, object_id, extra_context=None):
        """Refuse a guarded delete with a message, on the confirm page and on submit (#1616)."""
        obj = self.get_object(request, unquote(object_id))
        if obj is not None and self.has_delete_permission(request, obj):
            reasons = user_deletion_refusals([obj], request.user)
            if reasons:
                return self._deletion_refused(request, reasons)
        try:
            return super().delete_view(request, object_id, extra_context)
        except DeletionRefused as exc:
            return self._deletion_refused(request, exc.messages)

    def _deletion_refused(self, request, reasons):
        for reason in reasons:
            self.message_user(request, reason, messages.ERROR)
        return HttpResponseRedirect(reverse("admin:accounts_user_changelist"))

    @staticmethod
    def _lock_and_check_admins(request, pks):
        """Statement 1: lock the targets, the actor and the active administrators.

        One pk-ordered ``FOR NO KEY UPDATE`` over the targets, the actor,
        every active site admin and superuser (the order ``save_model`` uses)
        and every admin of a group a target actively administers (#1814).
        Row flags (``is_active``, ``is_site_admin``, ``is_superuser``) change
        only through an UPDATE, which conflicts with this lock, and a second
        delete conflicts with it too, so the last-administrator, actor and
        actor-scope checks made here judge state that cannot move until this
        transaction ends. ``FOR NO KEY UPDATE`` is deliberately not
        ``FOR UPDATE``: it does not conflict with the ``FOR KEY SHARE`` that a
        foreign key to the user takes (a card write recording its author, a
        board insert naming its owner). That keeps a writer that already holds
        a card row from being blocked on the user row while this delete waits
        for that card (see ``_lock_cards_then_targets``). It also means this
        statement does *not* protect the owned-boards rule; statement 3 does.
        """
        actor = request.user
        from groups.services import admin_accounts_of_groups_administered_by

        locked = list(
            User.objects.select_for_update(no_key=True)
            .filter(
                Q(pk__in=pks)
                | Q(pk=actor.pk)
                | Q(is_site_admin=True, is_active=True)
                | Q(is_superuser=True, is_active=True)
                # The other admins of the groups the targets administer, so
                # the group-admin count judges active flags that a concurrent
                # deactivation cannot change before this delete commits (#1814).
                | Q(pk__in=admin_accounts_of_groups_administered_by(pks))
            )
            .order_by("pk")
        )
        actor_row = next((u for u in locked if u.pk == actor.pk), None)
        if actor_row is None or not actor_row.is_active:
            raise PermissionDenied
        # The groups the targets actively administer at this point, so for
        # those groups the last-admin count in ``user_deletion_refusals`` (and
        # its re-check in statement 3) judges admin rows that no member change
        # or ownership transfer can alter until this transaction ends. Group
        # rows after user rows, the lock order recorded in groups.services
        # (above ``lock_member_accounts``): a group writer that locks an
        # account row takes it before the group row, and one holding a group
        # row needs at most ``FOR KEY SHARE`` on a user row, which this
        # statement's ``FOR NO KEY UPDATE`` does not block.
        from groups.services import lock_groups_administered_by

        lock_groups_administered_by(pks)
        pk_set = set(pks)
        targets = [u for u in locked if u.pk in pk_set]
        if not actor_row.is_superuser and any(
            _is_protected_other_account(actor_row, t) for t in targets
        ):
            # Judged on the locked rows: a target promoted to staff or
            # superuser, or an actor demoted, since the request started.
            raise DeletionRefused(["Only a superuser can delete this account."])
        reasons = user_deletion_refusals(targets, actor)
        if reasons:
            raise DeletionRefused(reasons)
        return targets

    @staticmethod
    def _cards_to_lock(pks):
        """Cards the delete will write: the owned boards' cards and every card
        that carries a reference to a target.

        The user delete sets those references to NULL (``Card.assignee`` and
        ``created_by``, and the author, actor, uploader or creator on a card's
        movements, comments, activity, checklists, attachments, relations,
        notifications and manual blocks, #1149), which updates the card's rows. Locking the cards
        first keeps the order card, then user, the order a card writer uses.
        """
        from boards.models import (
            CardActivity,
            CardAttachment,
            CardBlock,
            CardChecklist,
            CardComment,
            CardMovement,
            CardRelation,
            Notification,
        )

        referenced = (
            Q(created_by__in=pks)
            | Q(assignee__in=pks)
            | Q(pk__in=CardMovement.objects.filter(moved_by__in=pks).values("card_id"))
            | Q(pk__in=CardComment.objects.filter(author__in=pks).values("card_id"))
            | Q(pk__in=CardActivity.objects.filter(actor__in=pks).values("card_id"))
            | Q(pk__in=CardChecklist.objects.filter(created_by__in=pks).values("card_id"))
            | Q(pk__in=CardAttachment.objects.filter(uploaded_by__in=pks).values("card_id"))
            | Q(pk__in=CardRelation.objects.filter(created_by__in=pks).values("from_card_id"))
            | Q(pk__in=CardRelation.objects.filter(created_by__in=pks).values("to_card_id"))
            # Block history (#1149): blocked_by and unblocked_by are SET_NULL.
            | Q(
                pk__in=CardBlock.objects.filter(Q(blocked_by__in=pks) | Q(unblocked_by__in=pks))
                .exclude(card__isnull=True)
                .values("card_id")
            )
            | Q(
                pk__in=Notification.objects.filter(Q(actor__in=pks) | Q(recipient__in=pks))
                .exclude(card__isnull=True)
                .values("card_id")
            )
        )
        return Card.objects.filter(Q(board__owner__in=pks) | referenced)

    def _lock_cards_then_targets(self, request, pks):
        """Statements 2 and 3, in card, then user order.

        2. The owned boards' rows (``FOR NO KEY UPDATE``), then the cards from
           ``_cards_to_lock`` (one pk-ordered ``FOR UPDATE``), then the owned
           boards' entry columns, all in ``lock_cards_for_cascade``: the
           board -> card -> column order every container delete takes (#1602),
           so this delete and a REST column, swimlane or board delete queue
           rather than invert.
        3. The target user rows, one pk-ordered ``FOR UPDATE``, then the
           refusals are judged again, so the owned-boards rule is checked on
           boards committed up to this point.

        What this guarantees: the guard decisions (self, last site admin,
        last superuser, actor standing and scope) are judged on rows locked
        by statement 1, and a board is never silently deleted by a delete
        that did not check it. A board insert that has already reached
        COMMIT before statement 3 is seen by the re-check, so the delete is
        refused and the board kept. The foreign key from a board to its owner
        is deferred on PostgreSQL, so an insert still in flight takes its
        ``FOR KEY SHARE`` on the owner only at COMMIT: it waits for this
        transaction and then fails its foreign key because the owner is gone,
        and the board is not created.

        Lock order and its limit: a card writer holds a card row (``FOR NO
        KEY UPDATE``) and needs ``FOR KEY SHARE`` on a user row, at COMMIT
        for a deferred foreign key. Statement 1 is ``FOR NO KEY UPDATE``,
        which does not block that ``KEY SHARE``, and statement 2 takes the
        cards that carry a reference to a target before statement 3 takes the
        target rows, so for the cards snapshotted by statement 2 the order is
        card, then user, as a card writer's is. The snapshot is the limit: a
        card that gains a reference to a target after statement 2 and before
        statement 3 (it is assigned to the target, say) is not locked, and
        the cascade's ``SET NULL`` update of it then runs after this
        transaction already holds the target row ``FOR UPDATE``, while a
        writer that holds that card needs ``KEY SHARE`` on the target.
        PostgreSQL reports ``deadlock detected`` and aborts one side, which
        can be this delete (a server error); nothing is lost and the delete
        can be retried. Rows of tables that are not scoped to a card (invite
        links, board export log, group rows and so on) are not locked here
        and are not covered by this argument; statement 1 takes only the
        rows of the groups the targets administer, for the group-admin rule.
        """
        pk_list = list(pks)
        lock_cards_for_cascade(
            self._cards_to_lock(pk_list),
            entry_columns=Column.objects.filter(board__owner__in=pk_list),
            boards=Board.objects.filter(owner__in=pk_list),
        )
        locked = list(
            User.objects.select_for_update().filter(pk__in=pk_list).order_by("pk")
        )
        # The actor row was locked by statement 1 in this transaction, so this
        # read is stable; the in-memory ``request.user`` may predate a demotion.
        actor_row = User.objects.filter(pk=request.user.pk).first() or request.user
        reasons = user_deletion_refusals(locked, actor_row)
        if reasons:
            raise DeletionRefused(reasons)

    def delete_model(self, request, obj):
        # Board.owner is CASCADE, so deleting a user deletes their boards and
        # those boards' cards: lock the cards first, then those boards'
        # columns so no card enters them mid-cascade, in one transaction held
        # across the delete (#1603, #1602; see lock_cards_for_cascade).
        with transaction.atomic():
            self._lock_and_check_admins(request, [obj.pk])
            self._lock_cards_then_targets(request, [obj.pk])
            snapshot = self._delete_event_snapshot([obj.pk])
            super().delete_model(request, obj)
            self._record_delete_events(request, snapshot)

    def delete_queryset(self, request, queryset):
        # A bulk action is not wrapped in a transaction by Django: one outer
        # atomic so the locks outlive the delete (#1603).
        with transaction.atomic():
            pks = list(queryset.values_list("pk", flat=True))
            self._lock_and_check_admins(request, pks)
            self._lock_cards_then_targets(request, pks)
            snapshot = self._delete_event_snapshot(pks)
            super().delete_queryset(request, queryset)
            self._record_delete_events(request, snapshot)

    @staticmethod
    def _delete_event_snapshot(pks):
        """What the delete changes for connected clients, read before it runs (#1635).

        The delete clears ``Card.created_by`` and ``Card.assignee`` (SET_NULL)
        and cascades the targets' board and group memberships, all outside the
        REST views that would announce them, so without frames every client
        keeps showing the deleted user as a card's creator or assignee and as
        a member until it reloads. The rows are nulled or gone once
        ``super().delete_*`` returns, so the affected cards, boards and groups
        are read here, after the locks and the refusal re-check:

        - ``cards``: board id -> pks of the cards whose creator or assignee is
          a target, rendered again after the delete for ``card.updated``.
        - ``boards``: (board id, user id) for every board a target could see as
          a member, directly or through a group or one of its ancestors (the
          boards in the subtree of each group the target belongs to), as
          ``GroupViewSet.update_member`` announces a group member's removal.
        - ``groups``: (group id, user id) for each group membership.

        No ``board.deleted`` or ``group.deleted`` is needed although
        ``Board.owner`` and ``Group.owner`` are CASCADE: ``user_deletion_refusals``
        refuses a target that owns any board or group, and that refusal is
        judged again under the target row locks, so a delete that reaches
        here cascades neither. Owned boards are still excluded below so a
        change to that rule cannot announce cards or members of a deleted board.
        """
        from boards.models import BoardMembership
        from groups.models import GroupMembership
        from groups.services import _subtree_ids

        cards = {}
        for board_id, card_id in (
            Card.objects.filter(Q(created_by__in=pks) | Q(assignee__in=pks))
            .exclude(board__owner__in=pks)
            .values_list("board_id", "pk")
        ):
            cards.setdefault(board_id, set()).add(card_id)

        boards = set(
            BoardMembership.objects.filter(user__in=pks)
            .exclude(board__owner__in=pks)
            .values_list("board_id", "user_id")
        )
        groups = set(GroupMembership.objects.filter(user__in=pks).values_list("group_id", "user_id"))
        subtrees = {}
        for group_id, user_id in groups:
            if group_id not in subtrees:
                subtrees[group_id] = _subtree_ids(group_id)
        board_groups = {}
        if subtrees:
            all_groups = set().union(*subtrees.values())
            for board_id, group_id in (
                Board.objects.filter(group_id__in=all_groups)
                .exclude(owner__in=pks)
                .values_list("pk", "group_id")
            ):
                board_groups.setdefault(group_id, []).append(board_id)
        for group_id, user_id in groups:
            for sub_id in subtrees[group_id]:
                boards.update((board_id, user_id) for board_id in board_groups.get(sub_id, ()))
        return {"cards": cards, "boards": boards, "groups": groups}

    @staticmethod
    def _record_delete_events(request, snapshot):
        """Record the frames ``_delete_event_snapshot`` found, after the delete (#1635).

        Called inside the deleting transaction, after ``super().delete_*``: the
        cards render with the creator and assignee already cleared, and every
        board frame is recorded with ``record_board_event`` (a change-feed row
        in this transaction, the publish deferred to commit), so a delete that
        rolls back announces nothing. Group frames have no feed row and are
        published from one ``on_commit`` callback, as the REST group member
        removal does. Each card is rendered once per board in one prefetch
        pass (``render_card_payloads``), not once per card.
        """
        from boards import broadcast as _board_broadcast
        from boards.views._helpers import render_card_payloads
        from groups import broadcast as _group_broadcast

        actor_id = request.user.pk
        boards_by_id = Board.objects.in_bulk(list(snapshot["cards"]))
        for board_id, card_ids in sorted(snapshot["cards"].items()):
            board = boards_by_id.get(board_id)
            if board is None:
                continue
            for card_data in render_card_payloads(board, card_ids):
                _board_broadcast.record_board_event(
                    board_id, _board_broadcast.EVT_CARD_UPDATED, card_data, actor_id=actor_id
                )
        for board_id, user_id in sorted(snapshot["boards"]):
            _board_broadcast.record_board_event(
                board_id, _board_broadcast.EVT_MEMBER_REMOVED, {"user_id": user_id},
                actor_id=actor_id,
            )
        groups = sorted(snapshot["groups"])
        if groups:
            def _announce(pairs=groups, aid=actor_id):
                for group_id, user_id in pairs:
                    _group_broadcast.broadcast_group_event(
                        group_id, _group_broadcast.EVT_MEMBER_REMOVED, {"user_id": user_id},
                        actor_id=aid,
                    )

            transaction.on_commit(_announce)


def _stored_password_hash(pk, *, lock=False):
    qs = User.objects.filter(pk=pk)
    if lock:
        qs = qs.select_for_update()
    return qs.values_list("password", flat=True).first()


class SiteSettingAdminForm(RowVersionFormMixin, forms.ModelForm):
    """The site settings form with the rendered-state check.

    ``row_version`` covers every setting the form writes; see
    ``visiban/admin_row_version.py``.
    """

    row_version = RowVersionField(required=False)
    stale_form_message = (
        "The site settings were changed after this page was opened. Reload the "
        "page and make your changes again."
    )

    class Meta:
        model = SiteSetting
        fields = "__all__"


@admin.register(SiteSetting)
class SiteSettingAdmin(RowVersionAdminMixin, admin.ModelAdmin):
    """Singleton admin — clicking 'Site settings' goes straight to the edit form.

    A save writes only the settings the administrator changed, and a form
    rendered against an older state of the settings is refused.
    """

    form = SiteSettingAdminForm
    stale_save_message = (
        "The site settings were changed after this page was opened, so nothing "
        "was saved. The page now shows the current settings; make your changes again."
    )

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

        The same locked row decides what this save writes: a submitted
        ``row_version`` is compared with it (``check_row_version``), and every
        setting the administrator did not change is taken from it
        (``keep_unchanged_fields``) before the audit snapshot, so the audit
        diff and the save describe the same transition. One lock covers both.
        """
        with transaction.atomic():
            previous = SiteSetting.objects.select_for_update().filter(pk=obj.pk).first()
            if change:
                self.check_row_version(form, previous)
                self.keep_unchanged_fields(obj, form, previous)
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


# Django's stock Group admin edits permission sets directly, so it is limited to
# active superusers (#1617).
admin.site.unregister(AuthGroup)


class GroupAdminForm(RowVersionFormMixin, forms.ModelForm):
    """The group form with the rendered-state check.

    ``row_version`` covers the name and the ``permissions`` set; see
    ``visiban/admin_row_version.py``.
    """

    row_version = RowVersionField(required=False)
    stale_form_message = (
        "This group was changed after this page was opened. Reload the page and "
        "make your changes again."
    )

    class Meta:
        model = AuthGroup
        fields = "__all__"


@admin.register(AuthGroup)
class SuperuserOnlyGroupAdmin(RowVersionAdminMixin, GroupAdmin):
    """Django's ``GroupAdmin`` (keeps its permission widgets), superuser-only.

    A save writes only the fields the administrator changed (the
    ``permissions`` set included, in ``save_related``), and a form rendered
    against an older state of the group is refused.
    """

    form = GroupAdminForm
    stale_save_message = (
        "This group was changed after this page was opened, so nothing was saved. "
        "The page now shows the current state of the group; make your changes again."
    )

    def save_model(self, request, obj, form, change):
        """Judge the submission against the group row read under a lock.

        The lock is held by the change view's transaction until
        ``save_related`` has written the permissions, so a second admin save
        of the same group waits for this one and then finds its
        ``row_version`` stale. A permission added to the group by another
        route waits for this lock too (the new row's foreign key takes a
        key-share lock on the group row), but a removal does not;
        ``save_related`` re-reads the set before writing it for that case.
        """
        with transaction.atomic():
            if change:
                stored = AuthGroup.objects.select_for_update().filter(pk=obj.pk).first()
                self.check_row_version(form, stored)
                self.keep_unchanged_fields(obj, form, stored)
            super().save_model(request, obj, form, change)

    @staticmethod
    def _superuser_only(request):
        return bool(request.user.is_active and request.user.is_superuser)

    def has_module_permission(self, request):
        return self._superuser_only(request)

    def has_view_permission(self, request, obj=None):
        return self._superuser_only(request)

    def has_add_permission(self, request):
        return self._superuser_only(request)

    def has_change_permission(self, request, obj=None):
        return self._superuser_only(request)

    def has_delete_permission(self, request, obj=None):
        return self._superuser_only(request)


# ---------------------------------------------------------------------------
# Third-party admins that carry a user's email, login identity or API token,
# plus the Sites admin (#1618, #1621)
#
# These admins hold sign-in identities, credentials or site-wide configuration,
# so access is limited to superusers regardless of model permissions. They stay
# registered for break-glass use.
#
# `allauth`, `django.contrib.sites` and `rest_framework.authtoken` precede
# `accounts` in INSTALLED_APPS, so their admin modules have already registered by the time
# this module is imported. If that ordering changes, or an app is removed,
# startup fails loudly instead of leaving a stock admin unrestricted.
# ---------------------------------------------------------------------------
class SuperuserOnlyAdminMixin:
    """Limit every admin permission hook to active superusers."""

    @staticmethod
    def _is_active_superuser(request):
        return bool(request.user.is_active and request.user.is_superuser)

    def has_module_permission(self, request):
        return self._is_active_superuser(request)

    def has_view_permission(self, request, obj=None):
        return self._is_active_superuser(request)

    def has_add_permission(self, request):
        return self._is_active_superuser(request)

    def has_change_permission(self, request, obj=None):
        return self._is_active_superuser(request)

    def has_delete_permission(self, request, obj=None):
        return self._is_active_superuser(request)


class LockedRowVersionAdminMixin(RowVersionAdminMixin):
    """Change-form saves that write only changed fields and refuse stale forms.

    For the third-party admins, whose models cannot carry a version column of
    their own: the form's ``row_version`` digest is computed from the stored
    values (see ``visiban/admin_row_version.py``). ``save_model`` reads the row
    under a lock, compares the digest, and takes every field the administrator
    left alone from that locked row.
    """

    def save_model(self, request, obj, form, change):
        with transaction.atomic():
            if change:
                # Look the row up by its stored key column: the API token proxy
                # reports its user as ``pk``, and the form may have changed it.
                key = obj._meta.pk.attname
                stored = (
                    type(obj)._default_manager.select_for_update()
                    .filter(**{key: getattr(obj, key)}).first()
                )
                if stored is None:
                    # The record was removed after the form rendered; saving
                    # would create it again, so the submission is refused.
                    raise StaleSubmission
                self.check_row_version(form, stored)
                self.keep_unchanged_fields(obj, form, stored)
            super().save_model(request, obj, form, change)


def _restrict_to_superusers(model):
    """Re-register ``model``'s existing admin with the superuser-only mixin.

    The change form also carries the rendered-state check
    (``LockedRowVersionAdminMixin``): a save writes only the fields the
    administrator changed, and a form rendered against an older state of the
    record is refused (#1642).
    """
    original = type(admin.site._registry[model])
    admin.site.unregister(model)
    form = type(
        f"{model.__name__}RowVersionForm",
        (RowVersionFormMixin, original.form),
        {
            "__module__": __name__,
            "row_version": RowVersionField(required=False),
        },
    )
    restricted = type(
        original.__name__,
        (SuperuserOnlyAdminMixin, LockedRowVersionAdminMixin, original),
        {"__module__": __name__, "form": form},
    )
    admin.site.register(model, restricted)


def _restrict_third_party_admins():
    from allauth.account.models import EmailAddress
    from allauth.socialaccount.models import SocialAccount, SocialApp, SocialToken
    from django.contrib.sites.models import Site
    from rest_framework.authtoken.models import TokenProxy

    for model in (EmailAddress, SocialAccount, SocialApp, SocialToken, TokenProxy, Site):
        _restrict_to_superusers(model)


_restrict_third_party_admins()
