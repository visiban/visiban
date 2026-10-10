# Security Invariants Registry

Some security rules apply on more than one transport. A fix on one transport
(for example REST) is incomplete until every other surface that must enforce
the same rule has been checked. This page lists each rule and every surface that
must enforce it, so a reviewer of a change that touches a rule can walk the
whole row instead of only the surface in the diff.

The `security-review`, `rbac-check`, `completeness-check` and `architect` agents
read this page. For any diff that touches a listed rule, they verify every
surface in that rule's table and report a surface that does not enforce the rule
as a finding.

The `threat-model` skill (`.claude/skills/threat-model/SKILL.md`) is the
architecture-stage counterpart: it runs before `architect` on a feature that adds
an auth path, an authorization boundary change, external data ingress, an
OSS-to-enterprise extension point or an anonymous read surface, and walks this
registry's rows as part of its method. It reasons about design; the agents above
audit code.

## How to read a rule

Each rule has a statement, the reason it exists, and a table:

| Column | Meaning |
|---|---|
| Surface | The transport or flow through which the rule can be reached |
| Entry point | The file and function (or class) where a request on that surface starts |
| Enforced via | The code that applies the rule on that surface today |

Entry points use file and function names, not line numbers, so the table
survives edits. Paths are relative to `backend/`. Where a rule has a shared
implementation, it lives in `visiban/authorization.py` and the "Enforced via"
column names it. `accounts/tests/test_auth_entry_points.py` enforces Rules 1
and 2: it discovers every routed REST and non-DRF view, every routed WebSocket
consumer, the MCP transport, every invite-link model, and every function that
looks an invite up by its token, and fails when one skips the shared function.
It also checks that each top-level path segment with a route is either gated by
`PendingAccountActionMiddleware` or recorded as serving no session HTML.
It also pins the registration and OAuth adapter call sites to the shared
functions and to `registration_token_kind` (Rule 4 dispatch). It does not
enumerate Rule 3 (the revocation table is a review checklist) or Rule 5, and it
does not test locking; the concurrent tests for each consume-once path do.
[Authorization Entry Points](authorization-entry-points.md) says what each
entry point calls and how that test finds them.

## Rule 1: Account-state gates apply to every transport

**Rule.** An account with a forced change pending (`must_change_password`,
`must_change_username`) or that is inactive is refused on every transport, not
only REST.

**Why.** The gates are easy to add as DRF permission classes and forget
everywhere else. A client that cannot call REST should not be able to read or
write the same data over MCP, a socket, an invite link or an import.

| Surface | Entry point | Enforced via |
|---|---|---|
| REST | `visiban/settings.py` `REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"]` | `visiban.permissions.MustNotHavePendingPasswordChange` and `MustNotHavePendingUsernameChange` come from the defaults; each delegates to its shared gate (`visiban.authorization.PENDING_PASSWORD_CHANGE`, `PENDING_USERNAME_CHANGE`). Documented exceptions that declare their own `permission_classes` so a forced-change user can reach them: `CurrentUserView`, `ChangePasswordView`, `ChooseUsernameView`, `/auth/user/` and `/auth/password/change/` (`visiban/urls.py`). Every `/api/v1/auth/` route is registered explicitly and anchored in `visiban/urls.py`, matching both slash forms, so each resolves to an explicitly chosen view (the project's override, or a deliberately kept stock view: logout, resend-email); dj-rest-auth's urlconfs are not included (`accounts/tests/test_auth_routes.py`). The OpenAPI schema views (`visiban/urls.py`) declare `IsAuthenticated, TokenHasScope`. `boards/views/boards.py` `BoardViewSet` and `accounts/views.py` `WSTicketView` declare an explicit list that includes both gates |
| REST authentication | `accounts/authentication.py` `PATAuthentication`; DRF `SessionAuthentication` and `TokenAuthentication` (`DEFAULT_AUTHENTICATION_CLASSES`) | `resolve_personal_access_token` rejects a PAT whose user is inactive (`visiban.authorization.INACTIVE`); `SessionAuthentication` and DRF's `TokenAuthentication` check `user.is_active` |
| Login and session issuance | `accounts/views.py` `ThrottledLoginView`; `accounts/backends.py` `EmailBackend`; `accounts/adapter.py` `SocialRegistrationAdapter` | `ModelBackend` and `EmailBackend.authenticate` call `user_can_authenticate` (inactive users are refused); `ThrottledLoginView` mints the DRF `Token` only after authentication succeeds; for existing social accounts allauth's `respond_user_inactive` handles an inactive user |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware` | `_authenticate_and_authorize` calls `_enforce_account_state`, which calls `visiban.authorization.account_state_denial` and returns the gate's message and code |
| WebSocket ticket mint | `accounts/views.py` `WSTicketView` | Explicit `permission_classes`: `IsAuthenticated`, both pending-change gates, `TokenHasScope` |
| WebSocket handshake | `accounts/ws_auth.py` `TicketAuthMiddleware`, `_resolve_ticket_user`; Channels `AuthMiddlewareStack` | `_resolve_ticket_user` refuses an inactive user at redemption (`visiban.authorization.INACTIVE`); `AuthMiddlewareStack` resolves the session user through Django's auth backends |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer.connect`, `_check_access` | `connect` refuses an unauthenticated scope user or one with no recorded credential, then calls `visiban.authorization.authorize_account`; the periodic re-check runs `accounts/ws_auth.py` `load_live_ws_user`, which calls `authorize_account` on a freshly loaded row |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer.connect`, `_check_access` | Same as the board consumer: same `connect` refusal and `authorize_account` call; periodic re-check runs `load_live_ws_user` |
| Invite link redemption | `boards/views/invites.py` `JoinBoardView`; `groups/views.py` `JoinGroupView` | POST declares `IsAuthenticated`, both pending-change gates and `TokenHasScope`; GET is `AllowAny` |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin.import_board`, `import_trello` | Served by `BoardViewSet`, so its explicit permission list |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter.pre_social_login`, `save_user` | Signup creates the account in the same flow; existing-account matching in `_handle_email_collision` considers active users only (`visiban.authorization.principal_is_active`) |
| allauth HTML views | `/accounts/` (`visiban/urls.py`, allauth's urlconf and the project's overrides) | `visiban/middleware.py` `PendingAccountActionMiddleware`: an authenticated account with a forced change pending (`visiban.authorization.has_pending_account_action`) is redirected to the SPA on GET and HEAD and refused with 403 on any other method; `/accounts/logout/` is the only exception. Prefixes listed in the `PENDING_ACTION_EXTRA_GATED_PREFIXES` setting (default empty; the extension point for an installed extension package's session-based HTML pages) are gated the same way, and a malformed entry fails the `accounts.E004` system check. Unauthenticated requests pass, so sign-in works; inactive accounts are refused by the auth backends and allauth's `respond_user_inactive` |
| Django admin | `accounts/admin.py` `VisibanUserAdmin`; `boards/admin.py` `BoardMembershipAdmin` | Django's `AdminSite` requires an active staff user for `/admin/`; `PendingAccountActionMiddleware` applies the forced-change gates to all of `/admin/` the same way as for `/accounts/`, with `/admin/logout/` the only exception |
| Admin API | `accounts/admin_views.py` `AdminUserDetailView`, `AdminUserDeactivateView` | `_ADMIN_PERMISSIONS` |

## Rule 2: A deactivated, removed or demoted principal loses access

**Rule.** A principal who is deactivated, removed from a board or group, or
demoted loses access everywhere, including open connections and credentials
already issued. Access is re-derived from current state, not from state captured
when the credential was issued.

**Why.** Credentials outlive the decision that granted them. A cached role, an
open socket or a previously minted token keeps working unless the surface
re-checks.

| Surface | Entry point | Enforced via |
|---|---|---|
| REST | `boards/permissions.py` `get_board_role`; `groups/models.py` `get_accessible_group_ids` | Role resolved from current membership on every request |
| REST authentication | `PATAuthentication`; DRF `SessionAuthentication`, `TokenAuthentication` | Each checks `user.is_active` on every request |
| Login and session issuance | `accounts/views.py` `ThrottledLoginView`; `accounts/backends.py` `EmailBackend` | `user_can_authenticate` refuses inactive users at login; allauth `respond_user_inactive` handles existing social accounts |
| Personal access tokens | `accounts/admin_views.py` `AdminUserDeactivateView._revoke_invite_links` | Deletes the user's PATs; invoked by `AdminUserDeactivateView.post` and by `AdminUserDetailView.patch` when `is_active` becomes false |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware`; `mcp_server/tools.py` | `resolve_personal_access_token` rejects inactive users; tools import `get_board_role` and `get_board_roles` |
| WebSocket handshake | `accounts/ws_auth.py` `_resolve_ticket_user`; Channels `AuthMiddlewareStack` | Ticket redemption refuses an inactive user; the session handshake uses Django's auth backends |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer` | Periodic and per-frame re-check: `_refresh_role` calls `load_live_ws_user` (`authorize_account` on a fresh row, live credential) and `_lookup_role` resolves the current role with `get_board_role`; a failed check closes with 4003 |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer` | Periodic re-check: `_refresh_access` calls `load_live_ws_user`; `_has_access` uses `get_accessible_group_ids` |
| Site invite links | `accounts/invite_utils.py` `validate_invite_token`, `site_invite_creator_admits`, `revoke_site_invite_links` | `visiban.authorization.invite_creator_is_valid` (the site rule is `site_invite_creator_admits`, which calls `sender_may_admit_accounts`: an active site admin) is evaluated at redemption under the row lock, for REST and OAuth signup alike, so a creator deactivated, deleted or demoted by any route stops admitting accounts; `revoke_site_invite_links` sets `revoked_at` on the creator's unused links on deactivation (`AdminUserDeactivateView.post`, `AdminUserDetailView.patch` with `is_active` false) and on loss of site admin (`AdminUserDetailView.patch` with `is_site_admin` false, `set_site_admin --revoke`) |
| Board invite links | `boards/views/invites.py` `JoinBoardView.get`, `JoinBoardView.post`; `boards/invites.py` `sender_is_board_admin` | `visiban.authorization.invite_creator_is_valid` (the board rule is `sender_is_board_admin`) is evaluated at preview and at join; `_revoke_pending_board_invites` revokes on deactivation |
| Group invite links | `groups/invite_registration.py` `_sender_still_admits`; `groups/views.py` `sender_is_group_admin`, `_revoke_lapsed_admin_invite_links`; `groups/views.py` `_revoke_lapsed_subtree_invite_links` (re-parent); `groups/models.py` `revoke_invite_links_of_deleted_creator` (user delete); `accounts/admin_views.py` `AdminUserDeactivateView._revoke_group_invite_links` | Sender standing is evaluated at preview and redemption through `visiban.authorization.invite_creator_is_valid` (the group rule is `sender_is_group_admin`), and at registration also `sender_may_admit_accounts`; links are revoked when the sender is deactivated, deleted, or their admin rights lapse (including by the group being re-parented) (`_revoke_lapsed_admin_invite_links` is revocation housekeeping, not the access decision; see [advisory copies](authorization-entry-points.md#advisory-copies-of-the-creator-rule)) |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin` | Runs as an authenticated REST request, so role is read from current state |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter` | `_handle_email_collision` considers active users only |
| Django admin | `boards/admin.py` `BoardMembershipAdmin` | Membership changes made in the admin emit the `EVT_MEMBER_ADDED`, `EVT_MEMBER_UPDATED` and `EVT_MEMBER_REMOVED` board events through `_BoardEventAdminMixin` |
| Admin API | `accounts/admin_views.py` `AdminUserDetailView.patch`, `AdminUserDeactivateView.post` | Deactivation revokes PATs and pending invites in the same operation |

## Rule 3: Anything that grants access declares what revokes it

**Rule.** Every mechanism that grants access (socket, invite link, token,
session) has a stated revocation path covering the relevant events:
deactivation, role removal, password change, logout and creator removal. A new
grant mechanism lists those events in its docstring and in the table below
before it merges.

**Why.** A grant with no declared revocation is the source of the standing
access described in Rule 2.

| Grant | Entry point | Revoked by |
|---|---|---|
| Session | Django session (`SessionAuthentication`) | Logout, a password change (the session auth hash is an HMAC of the password hash), deactivation (`ModelBackend` refuses inactive users) |
| DRF auth `Token` | dj-rest-auth login via `accounts/views.py` `ThrottledLoginView`; `TokenAuthentication` | Logout (dj-rest-auth `LogoutView` deletes `request.user.auth_token`); password reset and admin-set password (`accounts/credentials.py` `revoke_auth_token`); `TokenAuthentication` checks `user.is_active` on each request; an open socket minted from it re-checks the key digest in `accounts/ws_auth.py` `_credential_ref_is_live` |
| Personal access token | `accounts/models.py` `PersonalAccessToken`; `accounts/authentication.py` `resolve_personal_access_token` | Explicit delete (`PersonalAccessTokenDeleteView`), expiry (`pat_is_expired`), deactivation (`_revoke_invite_links`), and a password change or reset through the web interface, the API or the Django admin, through the helpers in `accounts/credentials.py` (see the next three rows), which delete all of the user's PATs |
| Password change sources | `accounts/credentials.py` `finalize_password_change`, called by `accounts/views.py` `ChangePasswordView` and `TokenRevokingPasswordChangeView`, by `accounts/forms.py` `VisibanChangePasswordForm` and `VisibanSetPasswordForm` (allauth's `/accounts/password/change/` and `/accounts/password/set/`) in the same transaction as the save, with `accounts/password_signals.py` receivers for allauth's `password_changed` and `password_set` signals as an idempotent backstop, and by `accounts/adapter.py` `RegistrationAdapter.set_password` (the hook allauth's change, set and reset-from-key flows store the password through; the save and the finalize step share one transaction, so a failed finalize rolls the password back), and by `accounts/admin.py` `VisibanUserAdmin.user_change_password` when staff set their own password. Django's `check_password` hasher upgrade does not call any of these | Clears `must_change_password` and deletes the user's PATs. The admin's own `/admin/password_change/` page redirects to the SPA (`AdminPasswordChangeRedirectView`) |
| Password reset | `accounts/views.py` `ThrottledPasswordResetConfirmView`; `accounts/serializers.py` `VisibanPasswordResetConfirmSerializer`; allauth's `/accounts/password/reset/key/` page (`accounts/forms.py` `VisibanResetPasswordKeyForm`; `password_reset` signal receiver as a backstop) | `validate` refuses a link when the account no longer has a verified address (`password_reset_still_allowed`); both routes call `accounts/credentials.py` `finalize_password_reset` in the same transaction as the password save, which clears `must_change_password` and deletes the user's PATs and DRF `Token`; the REST `save` also clears the login lockout; the new password hash changes the session auth hash that sessions and open sockets compare |
| Django admin password | `accounts/admin.py` `VisibanUserAdmin.user_change_password` (`/admin/accounts/user/<id>/password/`) | When the stored hash changes on another user's account: `require_password_change_after_admin_set` sets `must_change_password` (when a usable password was set, not when password sign-in was disabled) and deletes the user's PATs and DRF `Token`; their sessions end because the session auth hash changes. On the actor's own account: `finalize_password_change`. A user created through the admin with a usable password is created with `must_change_password` set (`VisibanUserAdmin.save_model`) |
| WebSocket ticket | `accounts/ws_auth.py` `issue_ws_ticket`, `consume_ws_ticket`, `_resolve_ticket_user` | Single use, `WS_TICKET_TTL` expiry, refused for an inactive user or a minting credential that is no longer live |
| Open WebSocket | `accounts/ws_auth.py` `ws_credential_is_live`, `load_live_ws_user` | Recorded credential no longer live, password changed since handshake (`auth_hash`), account inactive (4003 at the next re-check) |
| Public board share link | `boards/views/share.py` `ShareBoardView`; `boards/models.py` `Board.share_token`, `share_token_expires_at` | Clearing `share_token` on the board (`boards/views/boards.py`), `share_token_expires_at` (the view returns 410 once it has passed) |
| Site invite link | `accounts/invite_utils.py` `validate_invite_token`, `consume_invite_token` | `revoked_at`, `expires_at`, `used_at`; `site_invite_creator_admits` re-evaluated at redemption; `revoke_site_invite_links` for links a deactivated or demoted creator made |
| Board invite link | `boards/views/invites.py` `JoinBoardView`; `boards/models.py` `BoardInviteLink` | `revoked_at`, `expires_at`, `used_at`; `sender_is_board_admin` re-evaluated at preview and join |
| Group invite link | `groups/views.py` `JoinGroupView`; `groups/models.py` `GroupInviteLink` | `is_active`, `expires_at`, `used_at`; sender standing re-evaluated by `_sender_still_admits` and `sender_is_group_admin` |
| OAuth pending invite | `accounts/adapter.py` `SocialRegistrationAdapter.is_open_for_signup` | Invalid or expired token clears `PENDING_INVITE_SESSION_KEY` |

## Rule 4: Consume-once tokens are consumed at the gate, under a lock

**Rule.** A single-use invite or token is claimed atomically
(`select_for_update()` or a conditional `UPDATE ... WHERE used_at IS NULL`
checked by row count) at the point of validation, not validated at one step and
redeemed best-effort at a later one. The gap between the two lets concurrent
requests both pass. Tests for these paths run concurrently and assert that two
simultaneous redemptions of one token yield exactly one success.

**Why.** See the "Secure code" section of the root `CLAUDE.md`, which holds the
canonical wording.

| Surface | Entry point | Enforced via |
|---|---|---|
| Site invite (registration) | `accounts/invite_utils.py` `validate_invite_token`, `consume_invite_token` | `select_for_update()` on validation; conditional `used_at IS NULL` update checked by row count |
| Group invite (registration) | `groups/invite_registration.py` `validate_group_registration_token`, `redeem_group_registration_token` | `select_for_update()` on validation; conditional `used_at` update checked by row count |
| Board invite (join) | `boards/views/invites.py` `JoinBoardView.post` | `select_for_update()` on the link row inside the request transaction |
| Group invite (join) | `groups/views.py` `JoinGroupView.post` | `select_for_update()` on the link row inside the request transaction |
| Board invite (registration) | `boards/invites.py` `validate_board_registration_token`, `redeem_board_registration_token` | `select_for_update()` on validation; conditional update on `used_at IS NULL, revoked_at IS NULL` checked by row count |
| Registration dispatch | `accounts/registration_tokens.py` `registration_token_kind` | Routes to the site, group or board validate and redeem functions above |
| Email and password signup | `accounts/views.py` `InviteRegisterView.post` | Runs in `transaction.atomic`; validates and redeems through `registration_token_kind` |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter.save_user`, `_redeem_invite` | Validate and redeem in one transaction |
| WebSocket ticket | `accounts/ws_auth.py` `consume_ws_ticket` | Single use decided by the return value of `cache.delete()` |
| JSON, CSV and Trello import | `boards/views/import_export.py` | No consume-once token on this surface |
| Admin actions | `accounts/admin_views.py` `AdminInviteLinkRevokeView.delete` | Revocation sets `revoked_at` on the link |

## Rule 5: User references in imports resolve only within the caller's scope

**Rule.** When an import file names users (assignee, actor, mover), the names
resolve only against users the importer can already see: the importer,
co-members of their boards and groups, and the target group. A name outside that
pool is dropped, so the import neither assigns to nor confirms the existence of
any other account.

**Why.** The uploader controls the file. Resolving against all users turns the
matched count into an existence oracle for every account on the instance.

| Surface | Entry point | Enforced via |
|---|---|---|
| JSON import | `boards/views/import_export.py` `BoardImportExportMixin._import_json` | `_resolve_import_users` |
| CSV import | `boards/views/import_export.py` `BoardImportExportMixin._import_csv` | `_resolve_import_users` |
| Trello import | `boards/views/import_export.py` `BoardImportExportMixin.import_trello` | `boards/services/trello_import.py` `visible_users`, `match_members` |
| Invite emails and member add | `boards/views/boards.py` `BoardViewSet.members`; `groups/views.py` `GroupViewSet.members` | Not an import surface; listed so a reviewer of a new bulk-add path checks it against this rule |
| MCP | `mcp_server/tools.py` | No import tool; user references resolve through the caller's accessible boards |

## How to add a rule

1. Write the rule as a statement of behavior, not an implementation: what must
   be true, on which principals, and why it is a rule.
2. Enumerate every surface that can reach the protected behavior. Start from this
   list and add any new transport: REST, MCP, WebSocket, invite links, JSON and
   CSV import, Trello import, OAuth signup, admin actions, personal access
   tokens.
3. For each surface, read the code and record the entry point (file and function
   or class, no line numbers) and the code that enforces the rule today. Do not
   record a surface as enforcing the rule from memory; open the file.
4. Add the new rule as its own section above, with a table in the same format.
5. If the rule has a shared implementation, put it in
   `backend/visiban/authorization.py` and extend
   `backend/accounts/tests/test_auth_entry_points.py` so the test discovers
   every surface in the rule's table (see
   [Authorization Entry Points](authorization-entry-points.md)). A surface listed
   here and not checked by the test, or the reverse, is a defect in one of the
   two. Exception: Rule 5 already resolves every import format's names through
   one shared function, `boards/services/trello_import.py` `visible_users`
   (JSON and CSV reach it through `_resolve_import_users`), and every format
   enters through the one import mixin. With no second transport for a copy to
   drift on, it is intentionally outside the enumeration;
   `boards/tests/test_import_user_scope.py` covers it.
6. Keep gap tracking out of this page. A surface that needs work is an issue,
   not a row annotation.

When a change adds a new transport or entry point, add it to the table of every
rule that applies to it in the same change.
