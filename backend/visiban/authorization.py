"""Shared authorization rules that every transport calls (#1517).

Visiban is reachable over several transports: REST (DRF), MCP, two Channels
WebSocket consumers, invite links and the allauth adapter. A rule that applies
to all of them used to be restated on each one, and a fix to one copy left its
siblings unfixed until a reviewer happened to look. This module holds one
definition of each such rule; every entry point calls it, and
``accounts/tests/test_auth_entry_points.py`` discovers the entry points
structurally and fails when one does not. The rules themselves are listed in
``docs/development/security-invariants.md``; how to wire a new entry point is
in ``docs/development/authorization-entry-points.md``.

Two rules live here:

- **Account state** (registry Rule 1): an inactive account, or one with a
  forced password or username change pending, is refused. Each condition is an
  :class:`AccountGate`. DRF's permission classes, the MCP middleware, the
  WebSocket handshake and the WebSocket re-check all evaluate the same gate
  objects, so the predicate, the message and the machine-readable code cannot
  drift between transports.
- **Invite creator standing** (registry Rule 2): a board or group invite link
  admits people only while its creator still could. :func:`invite_creator_is_valid`
  is the single entry for that question at preview and redemption, and
  :func:`sender_may_admit_accounts` is the extra rung registration needs.

This module deliberately has no imports from the apps at module scope: it is
imported by ``visiban.permissions``, which DRF loads while settings are still
being read.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Iterable


# ---------------------------------------------------------------------------
# Account state (registry Rule 1)
# ---------------------------------------------------------------------------


def principal_is_active(user) -> bool:
    """True if *user* exists and is active.

    The first rung of every account and invite-creator check. ``None`` (a
    deleted invite creator, ``created_by`` set NULL) is inactive, not an error.
    """
    return user is not None and bool(getattr(user, "is_active", False))


def has_pending_password_change(user) -> bool:
    """True if *user* carries the forced password-change flag.

    Missing attribute counts as clear, so an ``AnonymousUser`` or a stub never
    raises here; unauthenticated callers are refused elsewhere.
    """
    return bool(getattr(user, "must_change_password", False))


def has_pending_username_change(user) -> bool:
    """True if *user* carries the forced username-change flag (see above)."""
    return bool(getattr(user, "must_change_username", False))


def has_pending_account_action(user) -> bool:
    """True if *user* must complete a forced password or username change."""
    return has_pending_password_change(user) or has_pending_username_change(user)


@dataclass(frozen=True)
class AccountGate:
    """One account-state condition that refuses a principal on every transport.

    ``message`` and ``code`` are the client-facing contract. REST emits them
    through the DRF permission classes in ``visiban.permissions`` and MCP
    copies them into its JSON-RPC error, so both transports give one answer.
    Changing either string is an API change (see the backward-compatibility
    rules in the root ``CLAUDE.md``).
    """

    name: str
    message: str
    code: str
    predicate: Callable[[Any], bool]

    def blocks(self, user) -> bool:
        """True if this gate refuses *user*."""
        return bool(self.predicate(user))


INACTIVE = AccountGate(
    name="inactive",
    message="User account is disabled.",
    code="account_inactive",
    predicate=lambda user: not principal_is_active(user),
)

PENDING_PASSWORD_CHANGE = AccountGate(
    name="pending_password_change",
    message="You must change your password before continuing.",
    # DRF's PermissionDenied default code. The REST permission class declares
    # no ``code`` of its own, so this is what REST has always emitted.
    code="permission_denied",
    predicate=has_pending_password_change,
)

PENDING_USERNAME_CHANGE = AccountGate(
    name="pending_username_change",
    message="You must choose a new username before continuing.",
    code="must_change_username",
    predicate=has_pending_username_change,
)

#: Evaluation order. Inactive first: a disabled account is refused for being
#: disabled, whatever else is pending. The two forced-change gates keep the
#: order of ``REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"]``, so MCP reports
#: the same gate REST would when both flags are set.
ACCOUNT_GATES: tuple[AccountGate, ...] = (
    INACTIVE,
    PENDING_PASSWORD_CHANGE,
    PENDING_USERNAME_CHANGE,
)

#: The gates a forced-change exempt endpoint still applies. Used by the REST
#: views that a user with a pending change must reach to clear it.
FORCED_CHANGE_GATES: frozenset[AccountGate] = frozenset(
    {PENDING_PASSWORD_CHANGE, PENDING_USERNAME_CHANGE}
)


def _evaluate_account_gates(user, exempt: frozenset[AccountGate]) -> AccountGate | None:
    """Core of :func:`account_state_denial` and :func:`authorize_account`.

    Private and looked up as a module global by both public functions, so the
    entry-point enumeration test can replace it with a spy and see every
    caller of either function, whichever one the caller imported.
    """
    for gate in ACCOUNT_GATES:
        if gate in exempt:
            continue
        if gate.blocks(user):
            return gate
    return None


def account_state_denial(user, *, exempt: Iterable[AccountGate] = ()) -> AccountGate | None:
    """The first :class:`AccountGate` that refuses *user*, or ``None``.

    For callers that must report *why* (MCP returns the gate's message and
    code). *exempt* lists gates the caller deliberately skips; an entry point
    that skips one must say why at the call site.
    """
    return _evaluate_account_gates(user, frozenset(exempt))


def authorize_account(user, *, exempt: Iterable[AccountGate] = ()) -> bool:
    """True if *user*'s account state lets it use Visiban on any transport.

    The call every non-REST entry point makes (WebSocket handshake and
    re-check, MCP). REST reaches the same gates through the permission classes
    in ``visiban.permissions``, which evaluate one gate each so that a view can
    opt out of exactly one (see ``ChooseUsernameView``).
    """
    return _evaluate_account_gates(user, frozenset(exempt)) is None


# ---------------------------------------------------------------------------
# Invite creator standing (registry Rule 2)
# ---------------------------------------------------------------------------

#: Invite-link models whose creator's standing is re-checked when the link is
#: previewed or redeemed, mapped to the dotted path of the rule that checks it.
#: :func:`invite_creator_is_valid` dispatches through this table, so it is the
#: only place a kind is registered. The enumeration test walks every model
#: that carries both ``token_hash`` and ``created_by`` and fails for one that
#: is in neither this table nor its documented exceptions, so a new invite kind
#: cannot ship without a creator rule.
#:
#: A rule is called as ``rule(link)``, or ``rule(link, board)`` when the caller
#: passes a pre-loaded board (board links only).
INVITE_CREATOR_RULES: dict[str, str] = {
    "accounts.InviteLink": "accounts.invite_utils.site_invite_creator_admits",
    "boards.BoardInviteLink": "boards.invites.sender_is_board_admin",
    "groups.GroupInviteLink": "groups.views.sender_is_group_admin",
}


def invite_creator_is_valid(link, *, board=None) -> bool:
    """True while *link*'s creator may still add people through it.

    Re-evaluated at preview and at redemption, never trusted from mint time:
    a creator who was deactivated, deleted or lost admin rights must not keep
    admitting people through links already in flight.

    *board* is an optimization for board links (the caller usually has it
    loaded with its group ancestry). Raises ``TypeError`` for a link kind with
    no registered rule: an unknown kind must fail loudly, not be treated as
    valid.
    """
    from django.utils.module_loading import import_string

    target = INVITE_CREATOR_RULES.get(link._meta.label)
    if target is None:
        raise TypeError(f"No invite creator rule registered for {link._meta.label}")
    # Resolved per call (import_string reads the module attribute), so the rule
    # stays patchable where it is defined.
    rule = import_string(target)
    return rule(link) if board is None else rule(link, board)


def sender_may_admit_accounts(sender) -> bool:
    """True if *sender* may admit brand-new accounts on an INVITE_ONLY site.

    The account-level rung of registration through a board or group invite
    (#1444, #1445): only an active site admin may admit new people, the same
    people who can mint site invites. The link-level rung (still an admin of
    the board or group) is :func:`invite_creator_is_valid`; callers check this
    first because it needs no query.
    """
    return principal_is_active(sender) and bool(getattr(sender, "is_site_admin", False))
