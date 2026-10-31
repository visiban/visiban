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
`PendingAccountActionMiddleware` or recorded as serving no session HTML, and
that every route under the gated prefixes, Django admin views included, has a
recorded forced-change decision (`gated` or `exempt: <reason>`) that the
middleware keeps for each pending flag.
It enumerates Rule 6 too, through `GroupPlacementEntryPointTests`: every
function that writes `Board.group` must call the shared group-admin check or be
allowlisted.
It also pins the registration and OAuth adapter call sites to the shared
functions and to `registration_token_kind` (Rule 4 dispatch). It does not
enumerate Rule 3 (the revocation table is a review checklist), Rule 5, Rule 9,
Rule 10 or Rule 13 (review checklists, pinned by the tests named under each), and it
does not test locking; the concurrent tests for each consume-once path do.
Rules 11 and 12 are enumerated by their own tests instead:
`groups/tests/test_group_member_guards.py` `GroupMembershipEntryPointTests`
(Rule 11) and `boards/tests/test_analytics_panel_min_role_1826.py`
`AnalyticsExtensionsEntryPointTests` (Rule 12). Both rules also keep their
shared function outside `visiban/authorization.py` (`groups/services.py`
`lock_membership_for_removal_or_demotion` and `boards/permissions.py`
`analytics_extensions_for_role`), an accepted deviation from step 5 of
[How to add a rule](#how-to-add-a-rule).
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
| REST authentication | `accounts/authentication.py` `PATAuthentication`; DRF `SessionAuthentication` and `TokenAuthentication` (`DEFAULT_AUTHENTICATION_CLASSES`) | `resolve_personal_access_token` rejects a PAT whose user is inactive (`visiban.authorization.INACTIVE`); `SessionAuthentication` and DRF's `TokenAuthentication` check `user.is_active`. The session-only account rules (first password, email and username change, provider disconnect; a first password, and an email change on an account with no usable password, also need a recent provider sign-in recorded in that session, Rule 3 "Password change sources" and "Account email change", #1260, #1932) require the accepting authenticator to be a `SessionAuthentication` (`accounts/credentials.py` `request_is_interactive_session`, #1839): an extension authenticator that returns `(user, None)` is refused by them, and must not subclass `SessionAuthentication` unless it really authenticates from the cookie session. |
| Login and session issuance | `accounts/views.py` `ThrottledLoginView`; `accounts/backends.py` `EmailBackend`; `accounts/adapter.py` `SocialRegistrationAdapter` | `ModelBackend` and `EmailBackend.authenticate` call `user_can_authenticate` (inactive users are refused); `ThrottledLoginView` mints the DRF `Token` only after authentication succeeds; for existing social accounts allauth's `respond_user_inactive` handles an inactive user |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware` | `_authenticate_and_authorize` calls `_enforce_account_state`, which calls `visiban.authorization.account_state_denial` and returns the gate's message and code |
| WebSocket ticket mint | `accounts/views.py` `WSTicketView` | Explicit `permission_classes`: `IsAuthenticated`, both pending-change gates, `TokenHasScope`; the ticket is bound to the login session only when `accounts/ws_auth.py` `credential_for_request` finds the request authenticated by a session (the positive check in `accounts/credentials.py` `request_is_interactive_session`, #1839), so an authenticator that returns no credential object, even on a request carrying a session cookie, gets a 403 |
| WebSocket handshake | `accounts/ws_auth.py` `TicketAuthMiddleware`, `_resolve_ticket_user`; Channels `AuthMiddlewareStack` | `_resolve_ticket_user` refuses an inactive user at redemption (`visiban.authorization.INACTIVE`); `AuthMiddlewareStack` resolves the session user through Django's auth backends |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer.connect`, `_check_access` | `connect` refuses an unauthenticated scope user or one with no recorded credential, then calls `visiban.authorization.authorize_account`; the periodic re-check runs `accounts/ws_auth.py` `load_live_ws_user`, which calls `authorize_account` on a freshly loaded row |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer.connect`, `_check_access` | Same as the board consumer: same `connect` refusal and `authorize_account` call; periodic re-check runs `load_live_ws_user` |
| Invite link redemption | `boards/views/invites.py` `JoinBoardView`; `groups/views.py` `JoinGroupView`; the grant at email confirmation (#1704): `boards/invites.py` `redeem_reserved_board_invites`, `groups/invite_registration.py` `redeem_reserved_group_invites` | Join: POST declares `IsAuthenticated`, both pending-change gates and `TokenHasScope`; GET is `AllowAny`. Grant at confirmation: an inactive account is granted nothing and keeps its reservation (`user.is_active` checked before any invite is read) |
| Notification producers | `boards/signals.py` `notify_on_card_moved`; `boards/management/commands/notify_stale_cards.py`; `boards/management/commands/notify_due_soon.py`; `boards/views/cards.py` comment mentions and watchers (`member_ids`); `boards/utils.py` `notify_new_mentions`; `boards/services/cards.py` assignment (assignee validated by `_get_assignable_member_ids` in `boards/serializers.py` before the write); `boards/views/boards.py` board-invite (recipient is the member just created) | The invariant is split. Membership is per producer: `boards/services/notifications.py` `create_notifications` has no central membership check, so each producer limits its recipients to `boards/utils.py` `_get_effective_member_ids` before creating a row. An assignee is not evidence of current access. An author adding a producer re-checks membership there. Active status is central: `create_notifications` drops inactive recipients in one bulk query, so every producer inherits it and no row or `post_notification_created` signal is produced for them (`boards/tests/test_notify_stale_cards.py`, `boards/tests/test_notifications.py`, `boards/tests/test_notification_inactive_recipients.py`) |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin.import_board`, `import_trello` | Served by `BoardViewSet`, so its explicit permission list |
| OAuth signup and connect | `accounts/adapter.py` `SocialRegistrationAdapter.pre_social_login`, `save_user` | Signup creates the account in the same flow; existing-account matching in `_handle_email_collision` considers active users only (`visiban.authorization.principal_is_active`). A `process=connect` callback for an inactive account, or one with a forced change pending, is refused (`visiban.authorization.account_state_denial`) before anything is linked, with a redirect to the SPA |
| allauth session views | `/accounts/` (`visiban/urls.py`, allauth's urlconf and the project's overrides) | `visiban/middleware.py` `PendingAccountActionMiddleware`, which evaluates `visiban.authorization.account_state_denial` limited to `FORCED_CHANGE_GATES`: an authenticated account with a forced change pending is redirected to `FRONTEND_URL` on GET and HEAD and refused with 403 on any other method. Exceptions are decided on the resolved view, not the path, and are listed in `PENDING_ACTION_EXEMPT_VIEWS`: logout, the password-reset pages, the email-confirmation redirect, static result pages, and each installed provider's SSO login and callback (connect is refused by the adapter, row above). Every exception is a view an anonymous visitor reaches with the same effect, or one that applies the gate itself. `/accounts/password/change/` and `/accounts/password/set/` redirect to the SPA's Settings page; the four `/accounts/password/reset/` pages redirect to the SPA's `/forgot-password` and `/reset-password/<uid>/<token>` routes (`accounts.views.PasswordResetRedirectView` and its key subclasses, #1554; a malformed key also redirects to `/forgot-password`, and the key redirect is `no-store` with `Referrer-Policy: no-referrer`), keeping allauth's URL names so the exemptions above still apply. Prefixes in `PENDING_ACTION_EXTRA_GATED_PREFIXES` and view names in `PENDING_ACTION_EXTRA_EXEMPT_VIEWS` (both default empty; the extension point for an installed extension package) extend the gate and its exceptions; malformed entries fail the `accounts.E004` and `accounts.E006` system checks, an exempt-view entry naming a view that can serve a path under `/accounts/` or `/admin/` (regex and converter mounts included; unboundable routes count), or an OSS view (not one from the root URLconf's `extension_urlpatterns`) under an extra gated prefix, is reported by `accounts.E007` and ignored by the middleware at runtime (checks do not run under gunicorn/ASGI), and `accounts.E005` fails startup if `MIDDLEWARE` drops the middleware or places it before `AuthenticationMiddleware`. Unauthenticated requests pass, so sign-in works; inactive accounts are refused by the auth backends and allauth's `respond_user_inactive` |
| Django admin | `/admin/` (`django.contrib.admin.site`); `accounts/admin.py` `VisibanUserAdmin`; `boards/admin.py` `BoardMembershipAdmin` | Django's `AdminSite` requires an active staff user; `PendingAccountActionMiddleware` applies the forced-change gates to every admin view the same way as for `/accounts/`, with `/admin/logout/` the only exception. `/admin/password_change/` redirects to the SPA's Settings page. The Group admin (`accounts/admin.py` `SuperuserOnlyGroupAdmin`) is limited to active superusers for list, view, add, change, delete and app-index visibility (#1617; `accounts/tests/test_admin_group_restrictions.py`). The workspace group admin (`groups/admin.py` `GroupAdmin`) is likewise limited to active superusers and is read-only apart from its "Transfer ownership" action (`groups/tests/test_admin_transfer_ownership.py`) |
| Django admin (email, login identity and API token models) | `accounts/admin.py` `SuperuserOnlyAdminMixin`; admins for allauth `EmailAddress`, `SocialAccount`, `SocialToken`, `SocialApp` and DRF `TokenProxy` | Each stock admin is re-registered with the mixin, so view, add, change, delete and the module entry are limited to active superusers regardless of the model permissions a staff account holds (`accounts/tests/test_admin_third_party_restrictions.py`) |
| Django admin (Sites) | `accounts/admin.py` `SuperuserOnlyAdminMixin`; admin for `django.contrib.sites` `Site` | The Sites admin is re-registered with the mixin, so view, add, change, delete and the module entry are limited to active superusers regardless of the model permissions a staff account holds (#1621; `accounts/tests/test_admin_sites_restrictions.py`) |
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
| REST | `boards/permissions.py` `get_board_role`; `groups/models.py` `user_has_group_access` (group endpoints), `group_access_resolver` (its bulk form, used by `GroupSerializer` for the group list and retrieve) | Role resolved from current membership on every request; an ancestor group listed for navigation but not covered by the predicate is serialized navigation-only (`GroupSerializer._NAVIGATION_ONLY_EMPTY`); a `GroupSerializer` with no viewer in its context also renders navigation-only, and full-detail callers opt out with `full_group_access` (`groups/tests/test_group_serializer_context_guard.py` requires every construction to pass `context`) |
| REST board list, detail, star, update/destroy and cross-board card query | `boards/views/_helpers.py` `get_accessible_boards_queryset` and its predicate `board_access_q` (used by `boards/views/boards.py` `BoardViewSet.get_queryset` and `boards/views/card_query.py` `CardQueryViewSet`; `board_access_q` is also applied by `groups/views.py` `GroupViewSet.boards` GET, `descendant_boards` and `descendant_boards_paged`); `groups/models.py` `get_group_ids_for_board_access` | Group-derived board access is read from current `GroupMembership` rows only (the same source as `get_board_role`, with the same depth reach), so removing a membership ends access |
| REST authentication | `PATAuthentication`; DRF `SessionAuthentication`, `TokenAuthentication` | Each checks `user.is_active` on every request |
| Login and session issuance | `accounts/views.py` `ThrottledLoginView`; `accounts/backends.py` `EmailBackend` | `user_can_authenticate` refuses inactive users at login; allauth `respond_user_inactive` handles existing social accounts |
| Personal access tokens and DRF auth token | `accounts/admin_views.py` `AdminUserDeactivateView._revoke_invite_links` | Deletes the user's PATs and DRF auth `Token` (`accounts/credentials.py` `revoke_auth_token`); invoked by `AdminUserDeactivateView.post` and by `AdminUserDetailView.patch` when `is_active` becomes false |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware`; `mcp_server/tools.py` | `resolve_personal_access_token` rejects inactive users; tools import `get_board_role` and `get_board_roles` |
| WebSocket handshake | `accounts/ws_auth.py` `_resolve_ticket_user`; Channels `AuthMiddlewareStack` | Ticket redemption refuses an inactive user; the session handshake uses Django's auth backends |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer` | Periodic and per-frame re-check: `_refresh_role` calls `load_live_ws_user` (`authorize_account` on a fresh row, live credential) and `_lookup_role` resolves the current role with `get_board_role`; a denial closes with 4003, a check that raises drops the frame and closes with 1011 (reconnectable) |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer` | Periodic re-check: `_refresh_access` calls `load_live_ws_user`; `_has_access` uses `user_has_group_access`, the predicate REST group endpoints gate through; a denial closes with 4003, a check that raises drops the frame and closes with 1011 (reconnectable) |
| Site invite links | `accounts/invite_utils.py` `validate_invite_token`, `site_invite_creator_admits`, `revoke_site_invite_links` | `visiban.authorization.invite_creator_is_valid` (the site rule is `site_invite_creator_admits`, which calls `sender_may_admit_accounts`: an active site admin) is evaluated at redemption under the row lock, for REST and OAuth signup alike, so a creator deactivated, deleted or demoted by any route stops admitting accounts; `revoke_site_invite_links` sets `revoked_at` on the creator's unused links on deactivation (`AdminUserDeactivateView.post`, `AdminUserDetailView.patch` with `is_active` false) on user deletion (`accounts/signals.py` `revoke_site_invites_of_deleted_creator`, a `pre_delete` receiver covering every deletion path), and on loss of site admin (`AdminUserDetailView.patch` with `is_site_admin` false, `set_site_admin --revoke` (both refuse an account that is still a superuser, since superuser status implies site admin), and a superuser-status change that removes the account's site-admin access); the Django admin user form revokes on deactivation (`accounts/admin.py` `VisibanUserAdmin.save_model` through `accounts/admin_views.py` `apply_access_loss_revocations`) and, because its superuser change keeps `is_site_admin` and `can_access_all_content` consistent (`accounts/signals.py`), on loss of site-admin access |
| Public board share link | `boards/views/share.py` `ShareBoardView.get`; `boards/services/share_links.py` `share_enabler_has_standing`, `revoke_lapsed_share_links` | The enabler recorded in `Board.share_enabled_by` must still be active and a board `admin` or `site_admin` on the board, re-derived on every public read; a link with no recorded enabler fails that check (#1939); the link is cleared on deactivation, deletion, demotion or removal of the enabler on the routes listed in Rule 3 (#1865) |
| Board invite links | `boards/views/invites.py` `JoinBoardView.get`, `JoinBoardView.post`; `boards/invites.py` `sender_is_board_admin` | `visiban.authorization.invite_creator_is_valid` (the board rule is `sender_is_board_admin`) is evaluated at preview and at join; `_revoke_pending_board_invites` revokes on deactivation, including from the Django admin user form (`VisibanUserAdmin.save_model`); `boards/models.py` `revoke_board_invite_links_of_deleted_creator` (a `pre_delete` receiver covering every deletion path) revokes on user delete |
| Group invite links | `groups/invite_registration.py` `_sender_still_admits`; `groups/views.py` `sender_is_group_admin`, `_revoke_lapsed_admin_invite_links`; `groups/views.py` `_revoke_lapsed_subtree_invite_links` (re-parent); `groups/models.py` `revoke_invite_links_of_deleted_creator` (user delete); `accounts/admin_views.py` `AdminUserDeactivateView._revoke_group_invite_links` | Sender standing is evaluated at preview and redemption through `visiban.authorization.invite_creator_is_valid` (the group rule is `sender_is_group_admin`), and at registration also `sender_may_admit_accounts`; links are revoked when the sender is deactivated (including from the Django admin user form, `VisibanUserAdmin.save_model`), deleted, or their admin rights lapse (including by the group being re-parented; links lapsed before #1513 are backfilled by migration `groups/0017`; shareable admin links minted before #1727 are revoked by migration `groups/0023`, and `JoinGroupView` refuses any admin link, #1940, #2006) (`_revoke_lapsed_admin_invite_links` is revocation housekeeping, not the access decision; see [advisory copies](authorization-entry-points.md#advisory-copies-of-the-creator-rule)) |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin` | Runs as an authenticated REST request, so role is read from current state |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter` | `_handle_email_collision` considers active users only |
| Django admin | `boards/admin.py` `BoardMembershipAdmin` | Membership changes made in the admin emit the `EVT_MEMBER_ADDED`, `EVT_MEMBER_UPDATED` and `EVT_MEMBER_REMOVED` board events through `_BoardEventAdminMixin`; a save writes only the fields the administrator changed and is refused when the form was rendered against an older state of the membership (see the Django admin change forms row below) |
| Admin API | `accounts/admin_views.py` `AdminUserDetailView.patch`, `AdminUserDeactivateView.post` | Deactivation revokes PATs, the DRF auth token and pending invites in the same operation |
| Superuser status change (model save) | `accounts/signals.py` `capture_prior_superuser_state`, `ensure_superuser_is_site_admin` | Superuser status, `is_site_admin` and `can_access_all_content` stay consistent: a stored `is_superuser` true to false change clears the other two and calls `apply_access_loss_revocations`; a save of a superuser that leaves either derived flag false sets both again (#1614), and `AdminPatchUserSerializer` refuses clearing either flag on a superuser, rechecked on the locked row in `AdminUserDetailView.patch` (#1597, #1614); the Django admin user form is covered by the model-save signal, so a form save cannot leave `can_access_all_content` cleared on a superuser (#1614); `VisibanUserAdmin.get_readonly_fields` makes `is_superuser` read-only for non-superusers (#1579) |
| Django admin (email, login identity and API token models) | `accounts/admin.py` `SuperuserOnlyAdminMixin` | The admins that can change another account's email addresses, social accounts or API tokens are limited to active superusers (#1618) |
| Django admin | `accounts/admin.py` `VisibanUserAdmin.save_model` | Calls `accounts/admin_views.py` `apply_access_loss_revocations`, the helper `AdminUserDetailView.patch` uses, in the same transaction as the save |
| Django admin (user form account guards) | `accounts/admin.py` `VisibanUserChangeForm`, `VisibanUserAdmin.save_model` | For every actor, superusers included, the form refuses deactivating the actor's own account or a board owner (`accounts/admin_views.py` `deactivation_refusal`, the helper `AdminUserDetailView.patch` also uses; #1577) and removing the actor's own superuser status (`demotion_refusal`). The last-active-site-admin refusal on deactivation, and the last-active-superuser and last-active-site-admin refusals on removing superuser status, are specific to the form; the API path does not use those branches. The guards run on an active-to-inactive or superuser-to-non-superuser transition only, so saving an already-inactive account is not refused (an intentional difference from the API, which evaluates every `is_active=false` request). `save_model` repeats the checks under one pk-ordered lock on the target and the active site-admin and superuser rows. The shell and management commands are the only unguarded routes. In the admin API (`accounts/admin_views.py` `superuser_target_refusal`, used by `AdminUserDetailView.patch`, `AdminUserDeactivateView.post` and `AdminUserClearLockoutView.post`, which clears the sign-in lockout), a superuser account's `is_active`, `can_access_all_content` and `must_change_password` are changed by superusers only; the refusal is a `400` with a `detail`, re-checked on the locked row |
| Django admin (user delete) | `accounts/admin.py` `VisibanUserAdmin.delete_view`, `guarded_delete_selected` (the `delete_selected` action), `delete_model`, `delete_queryset`, `_lock_and_check_admins`, `_lock_cards_then_targets`; `user_deletion_refusals` | A delete applies the account guards to every actor, superusers included: not the actor's own account, not a board owner (`Board.owner` is CASCADE, so the boards and their cards would go too; the refusal shows a count, not board names; `accounts/admin_views.py` `deactivation_refusal`, #1616), and not the last active site admin or last active superuser. The delete view and the bulk action refuse with an error message and delete nothing; a bulk delete is judged as a set, is all-or-nothing, and also refuses a selection that would remove every active site admin or superuser; the bulk action runs in one transaction so a refusal leaves no deletion log entries. `delete_model` and `delete_queryset` judge the rules again under three locks, in this order: (1) the targets, the actor and the active site-admin and superuser rows, one pk-ordered `FOR NO KEY UPDATE` (the flag-based rules and the actor's standing, including a target promoted or an actor demoted since the request started, are judged on these locked rows; `FOR NO KEY UPDATE` does not block the `FOR KEY SHARE` a card write or board insert takes on a user row); (2) every card the delete will write (the owned boards' cards and the cards carrying a reference to a target), one pk-ordered `FOR UPDATE`; (3) the target rows, one pk-ordered `FOR UPDATE`, after which the refusals are judged again, so the owned-boards rule is checked against boards committed up to that point. The guard decisions are judged on locked rows and a board is never silently deleted by a delete that did not check it: a board insert that has reached COMMIT before step (3) is seen by the re-check and the delete is refused; an insert still in flight takes its foreign-key lock on the owner only at COMMIT (the key is deferred), so it waits for the delete and then fails its foreign key. Cards are locked before the target rows, the order a card writer uses, for the cards snapshotted at step (2). The limit: a card that gains a reference to a target between steps (2) and (3) is not locked, and the cascade's update of it can deadlock with a writer holding that card; PostgreSQL aborts one side, which can be the delete, and nothing is lost. Tables not scoped to a card (invite links, export log, group rows) are not locked. A user who owns groups (`Group.owner` is CASCADE, so their groups, subgroups and memberships would go too) is refused until ownership is transferred, in the page check and again at step (3) (the refusal shows a count). A non-superuser actor may delete only accounts that are not another staff, superuser or site-admin account (`_is_protected_other_account`), judged on the locked rows at step (1) as well. The shell and management commands are the only unguarded routes |
| Django admin (user form fields and visibility) | `accounts/admin.py` `VisibanUserAdmin.get_readonly_fields`, `get_queryset` | For a non-superuser: `is_staff`, `is_superuser`, `groups` and `user_permissions` are read-only; `email`, `username`, `first_name`, `last_name` and `is_active` of a staff, superuser or site-admin account other than the actor's own are read-only; superuser accounts are not listed or editable (these limits apply to non-superuser staff only). `get_fieldsets` (which adds the hidden `row_version`), `row_version` and `save_related` do not alter these field and visibility limits: read-only fields stay out of the form and of `row_version`, and `save_related` writes only many-to-many fields the form carries (#1622) |
| Django admin (user password form) | `accounts/admin.py` `VisibanUserAdmin.user_change_password` | The per-user password form is refused for a non-superuser when the target is a staff, superuser or site-admin account other than the actor's own. These limits apply to non-superuser staff only; superusers edit these fields and set these passwords |
| Writes to the user row from a request-start copy | `accounts/serializers.py` `UserSerializer.update` (`/auth/me/`, `/auth/user/`); `accounts/views.py` `ChangePasswordView`, `TokenRevokingPasswordChangeView`; `VisibanPasswordResetConfirmSerializer.save`; `accounts/adapter.py` `RegistrationAdapter.set_password`, `SocialRegistrationAdapter.pre_social_login` (social-account connect); `accounts/admin.py` `VisibanUserAdmin.save_model`, `VisibanUserAdmin.save_related`, `VisibanUserChangeForm.clean` | Account state is not overwritten from a request-start copy: profile updates save only the validated fields (`update_fields`); the two REST password-change routes re-read the row under `accounts/credentials.py` `lock_user_row` and save only `password`; reset-confirm and allauth's password hook save only `password`; a social-account connect judges account state on a separate fresh read and hands allauth a fresh row with only `last_login` loaded (`_connect_target`), so allauth's save writes only that column (#1624); the Django admin change form takes the concrete fields that are unchanged at submit time from the row read under the lock, and `VisibanUserAdmin.save_related` writes only the many-to-many fields (`groups`, `user_permissions`) the administrator changed; the form renders a hidden `row_version` (a keyed digest of the stored values of the fields it writes, groups and permissions included), and a submission made against an older state of the account is refused: `VisibanUserChangeForm.clean` compares it with the row read when the submission arrives (form error), `save_model` compares it again with the row and its groups and permissions read under the lock, and `save_related` re-reads the groups and permissions before writing them (a refusal at either step rolls the save back and redirects to the change page with an error message); a submission without `row_version` skips the comparisons and still keeps the stored value of every field left alone (#1619, #1622, `accounts/tests/test_stale_user_row_writes.py`, `accounts/tests/test_admin_user_form_concurrent_edits.py`) |
| Django admin change forms for privilege-bearing records | `visiban/admin_row_version.py` `RowVersionFormMixin`, `RowVersionAdminMixin`; `accounts/admin.py` `SuperuserOnlyGroupAdmin` (`GroupAdminForm`), `SiteSettingAdmin` (`SiteSettingAdminForm`), `VisibanUserAdmin`; `accounts/admin.py` `LockedRowVersionAdminMixin` (the admins for email addresses, social accounts, social apps, social tokens, API tokens and sites, whose digest is computed from stored values because those models carry no version column); `boards/admin.py` `BoardAdmin` (`BoardAdminForm`), `BoardMembershipAdmin` (`BoardMembershipAdminForm`) | A save writes only the fields the administrator changed (a record deleted after the form rendered is refused, not re-created): every other concrete field is taken from the row read under the row lock (`keep_unchanged_fields`), and `save_related` writes only the many-to-many fields that changed (a group's `permissions`). Each change form renders a hidden `row_version`, a keyed digest of the stored values of the fields it writes (many-to-many included), and a submission made against an older state is refused: the form's `clean` compares it with the row read when the submission arrives (form error), `save_model` compares it again with the row read under the lock (`check_row_version`), and `save_related` re-reads the many-to-many values before writing them. A refusal under the lock rolls the save back, together with any board event and `transaction.on_commit` broadcast it queued, and redirects to the change page with an error message. `SiteSettingAdmin` takes the merged values and the audit snapshot from the same locked row, so the audit diff and the save describe the same transition. A submission without `row_version` skips the comparisons and still keeps the stored value of every field left alone. Extension point: a subclass that writes further fields extends the form's `row_version_fields` (#1622, #1642, `accounts/tests/test_admin_group_sitesetting_concurrent_edits.py`, `accounts/tests/test_admin_third_party_concurrent_edits.py`, `boards/tests/test_admin_board_concurrent_edits.py`, whose interleaving cases run on PostgreSQL) |

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
| DRF auth `Token` | dj-rest-auth login via `accounts/views.py` `ThrottledLoginView`; `TokenAuthentication` | Logout (dj-rest-auth `LogoutView` deletes `request.user.auth_token`); account deactivation (`AdminUserDeactivateView._revoke_invite_links`, also from `VisibanUserAdmin.save_model` through `apply_access_loss_revocations`); every password change, reset and admin-set password (`accounts/credentials.py` `revoke_auth_token`, called from `finalize_password_change`, `require_password_change_after_admin_set` and `revoke_credentials_after_operator_reset`, so every caller in the next rows revokes it); on the REST change routes (`ChangePasswordView`, `TokenRevokingPasswordChangeView`) a request authenticated with the `Token` gets a replacement in the response's optional `key` field (`reissue_auth_token`, same transaction and user-row lock), while a session caller stays signed in through `update_session_auth_hash`; `TokenAuthentication` checks `user.is_active` on each request; an open socket minted from it re-checks the key digest in `accounts/ws_auth.py` `_credential_ref_is_live`. Issuance at login (`ThrottledLoginView.login`) and those helpers are serialized on the user row (`accounts/credentials.py` `lock_user_row`); login re-reads the row under the lock and issues the `Token` only while the stored password hash is the one the credentials were verified against and the account is active (`accounts/tests/test_credential_row_lock.py`) |
| Personal access token | `accounts/models.py` `PersonalAccessToken`; `accounts/authentication.py` `resolve_personal_access_token` | Explicit delete (`PersonalAccessTokenDeleteView`), expiry (`pat_is_expired`), deactivation (`_revoke_invite_links`, also from `VisibanUserAdmin.save_model` through `apply_access_loss_revocations`), and a password change or reset through the web interface, the API, the Django admin or the operator command line, through the helpers in `accounts/credentials.py` (see the next rows), which delete all of the user's PATs. Token creation (`PersonalAccessTokenListCreateView.post`) and those helpers are serialized on the user row (`accounts/credentials.py` `lock_user_row`); creation re-reads its credential under the lock (`accounts/tests/test_credential_row_lock.py`) |
| Password change sources | `accounts/credentials.py` `finalize_password_change`, called by `accounts/views.py` `ChangePasswordView` and `TokenRevokingPasswordChangeView`, by `accounts/forms.py` `VisibanChangePasswordForm` and `VisibanSetPasswordForm`, which stay configured as allauth's change and set forms and finalize in the same transaction as the save wherever allauth's own views are mounted (an extension or test URLconf), with `accounts/password_signals.py` receivers for allauth's `password_changed` and `password_set` signals as an idempotent backstop, and by `accounts/adapter.py` `RegistrationAdapter.set_password` (the hook allauth's change, set and reset-from-key flows store the password through; the save and the finalize step share one transaction, so a failed finalize rolls the password back), and by `accounts/admin.py` `VisibanUserAdmin.user_change_password` when staff set their own password. On the two REST change routes, setting a first password on an account with no usable password requires an interactive session: `accounts/credentials.py` `first_password_requires_session` refuses any request that was not authenticated by a `SessionAuthentication` (see the shared session check below) with 403 before any write (#1609, #1839; `accounts/tests/test_password_change_auth_token.py`). On those same two routes, and only after that session check passes, the session must also hold a recent provider sign-in to the account (#1260): `accounts/credentials.py` `first_password_requires_recent_login` (via `session_recently_signed_in_by_provider`) reads allauth's per-session authentication records (written into the session by allauth's social-login and social-signup flows at sign-in time; not `User.last_login`, which is per user, so a fresh sign-in on another device would make an old copied cookie look recent) and passes only a `socialaccount` record within `ACCOUNT_REAUTHENTICATION_TIMEOUT` (allauth's default, 300 seconds; the same window as the email-change and provider-connect rules, and the same check an email change on an account with no usable password uses, see the Account email change row, #1932) whose provider and uid are an identity linked to this account, so a record written while the session was anonymous (for example by a provider sign-in that stopped part way) and kept when the session then signed in by another route, such as the REST login (Django keeps session data across a login), does not count for a different account; allauth's provider flow itself signs a signed-in user out before it writes a record. allauth's `did_recently_authenticate` is not used because it treats an account with no password or MFA as always recent. It fails closed: a session with no `socialaccount` record within the window is refused, including one signed in by a REST login, a password login or `force_login`, none of which writes one (allauth has always written the record on a provider sign-in, so a session that signed in through a provider shortly before #1260 shipped still passes inside the window). The rule raises the bar for a copied session cookie; it is not a bound on a session holder who first connects a provider identity of their own (connecting to an account with no usable password is not recent-auth gated, see the provider-connect rule, and sends the owner a notice), since that identity is already a lasting way in. An account with no usable password and no linked identity can never pass, and is pointed to password reset by the refusal message. The refusal is 403 `{"detail": ..., "code": "recent_login_required"}` before any write, from `ChangePasswordView` (after the new-password strength check, under the row lock) and from `VisibanPasswordChangeSerializer.validate` (ahead of the set-password form's strength check), the same per-route ordering as the session check; the SPA's Settings page turns the code into a "sign in again" message (`accounts/tests/test_password_change_auth_token.py` `_FirstPasswordSessionOnlyCases`, `accounts/tests/test_first_password_recent_login.py`). The other routes that can write a first password are deliberately outside this rule: password reset (REST reset-confirm and allauth's reset-from-key, which the project routes redirect to the SPA) proves control of a verified mailbox instead, and on an account with no usable password an address can only be added or changed with the same recent provider sign-in this rule requires (Account email change row, #1932); allauth's set page (`/accounts/password/set/`, with `VisibanSetPasswordForm` and `RegistrationAdapter.set_password` behind it) is redirected to the SPA by the project URLconf; the Django admin's password form (`VisibanUserAdmin.user_change_password`) is a staff surface that already sets other accounts' passwords with the `change_user` permission, so a stolen staff session is a broader problem than this rule addresses; and the `changepassword` and `ensure_site_admin` operator commands need shell access. The shared session check, `accounts/credentials.py` `request_is_interactive_session`, is positive and is the one definition used by the first-password, email-change, username-change and provider-disconnect rules: on a DRF request the authenticator that accepted it (`request.successful_authenticator`) must be a `SessionAuthentication` (or a subclass) and `request.auth` must be `None`, so an authenticator that returns `(user, None)`, a `force_authenticate`d request, and any token authenticator an extension adds are all refused without being listed; a request that is not a DRF `Request` (including a DRF request's underlying `request._request`, onto which DRF copies `auth`) has no authenticator to inspect and is refused. The WebSocket ticket route uses the same predicate to decide whether a ticket is bound to the login session (`accounts/ws_auth.py` `credential_for_request`). An extension authenticator that returns `(user, None)` is therefore refused by these rules, and must not subclass `SessionAuthentication` unless it really authenticates from the cookie session (`accounts/tests/test_interactive_session_check.py`). allauth's change and set views are session-only and redirect to the SPA. Both REST change views are limited per user by the `password_change` throttle scope, and a wrong current password consumes the account's allauth `login_failed` per-account bucket through `accounts/password_attempts.py` (`begin_current_password_check` / `current_password_accepted`, called from `ChangePasswordView` and `VisibanPasswordChangeSerializer`), so a locked-out account is refused here too; the shared demo account is exempt, as at login (`accounts/tests/test_password_change_attempt_limits.py`). Django's `check_password` hasher upgrade does not call any of these; `accounts/models.py` `User.check_password` and `acheck_password` write the upgraded hash only while the row still holds the hash it was derived from (a conditional `UPDATE` checked by row count), so every caller (`ModelBackend`, `EmailBackend`, the change-password and allauth flows) leaves a password set by another transaction in place, and the REST login re-check under `lock_user_row` then refuses the login (`accounts/tests/test_credential_row_lock.py`, #1601) | Clears `must_change_password` and deletes the user's PATs and DRF `Token`; when the account had no usable password before the write (read from the locked row before the save in `ChangePasswordView`, `TokenRevokingPasswordChangeView`, `VisibanSetPasswordForm` and `RegistrationAdapter.set_password`; the `password_set` signal means a first password by definition), `finalize_password_change(first_password=True)` sends the same after-commit notice to the account email and every verified address as the reset row below (`accounts/admin.py` `VisibanUserAdmin.user_change_password` passes it for the actor's own account, from the hash read under the lock before the form runs), once per user object so a route that finalizes twice sends one (`accounts/tests/test_no_password_account_notices.py`); the operator command line is a separate row below; the two REST views reissue the `Token` to a caller that authenticated with it. The project routes `/accounts/password/change/`, `/accounts/password/set/` and the admin's own `/admin/password_change/` redirect to the SPA's Settings page (`AdminPasswordChangeRedirectView`) |
| Password reset | `accounts/views.py` `ThrottledPasswordResetConfirmView`; `accounts/serializers.py` `VisibanPasswordResetConfirmSerializer`; allauth's `/accounts/password/reset/key/` page, which the project routes redirect to the SPA (#1554); `accounts/forms.py` `VisibanResetPasswordKeyForm` and the `password_reset` signal receiver stay as defense in depth for a URLconf that mounts allauth's view (`accounts/tests/allauth_reset_urls.py`) | `validate` refuses a link when the account no longer has a verified address (`password_reset_still_allowed`); both routes call `accounts/credentials.py` `finalize_password_reset` in the same transaction as the password save, which clears `must_change_password` and deletes the user's PATs and DRF `Token`; when the account had no usable password before the reset (read from the locked row before the save), the account email and every verified address on the account (oldest first, at most ten) are sent a notice after commit, one message per address (`accounts/no_password_notices.py` `notify_verified_addresses_of_first_password`; `finalize_password_reset` passes the flag to `finalize_password_change`, which sends it once, and the `password_reset` signal backstop does not repeat it; a first password set by the signed-in user is covered by the Password change sources row); the REST `save` also clears the login lockout; the new password hash changes the session auth hash that sessions and open sockets compare |
| Django admin password | `accounts/admin.py` `VisibanUserAdmin.user_change_password` (`/admin/accounts/user/<id>/password/`) | When the stored hash changes on another user's account: `require_password_change_after_admin_set` sets `must_change_password` (when a usable password was set, not when password sign-in was disabled) and deletes the user's PATs and DRF `Token`; their sessions end because the session auth hash changes. On the actor's own account: `finalize_password_change`. A user created through the admin with a usable password is created with `must_change_password` set (`VisibanUserAdmin.save_model`). The `ensure_site_admin` management command, when it sets a password on an existing account, uses the same helper under the user-row lock |
| Password and profile writes against a concurrent credential change | `accounts/views.py` `ChangePasswordView`, `TokenRevokingPasswordChangeView` (with `accounts/serializers.py` `VisibanPasswordChangeSerializer`); `UserSerializer.update`; `VisibanPasswordResetConfirmSerializer.save`; `accounts/adapter.py` `RegistrationAdapter.set_password`, `SocialRegistrationAdapter.pre_social_login` (social-account connect); `accounts/admin.py` `VisibanUserAdmin.save_model`, `VisibanUserAdmin.save_related`, `VisibanUserChangeForm.clean` | Password writes use the stored record: the two REST change routes verify the current password against, and write the new hash to, the row read under `lock_user_row` (the first-password session requirement is evaluated against that same row); profile updates, reset-confirm and allauth's password hook write only the columns they change; a social-account connect writes only `last_login`, from a fresh read; the Django admin change form takes the concrete fields that are unchanged at submit time from the row read under the lock, writes only the many-to-many fields the administrator changed (`VisibanUserAdmin.save_related`), and refuses a submission made against an older state of the account, comparing the rendered `row_version` in `VisibanUserChangeForm.clean` and again under the row lock in `save_model` and `save_related` (#1619, #1622, `accounts/tests/test_stale_user_row_writes.py` and `accounts/tests/test_admin_user_form_concurrent_edits.py`, whose interleaving cases run on PostgreSQL) |
| Account email change | `accounts/serializers.py` `UserSerializer.validate_email`, shared by `PATCH`/`PUT /api/v1/auth/user/` (dj-rest-auth `UserDetailsView` with `CurrentUserSerializer`) and `PATCH /api/v1/auth/me/` (`accounts/views.py` `CurrentUserView`); the pending-change request in `accounts/email_change.py` `request_email_change` is reached only from that serializer | Changing the stored address, or requesting a change confirmed from the new mailbox under `EMAIL_VERIFICATION=mandatory`, requires an interactive session: `accounts/credentials.py` `email_change_requires_session` refuses any request that was not authenticated by a session (`request_is_interactive_session`, the same positive check as the first-password rule above) with 403 before anything is written, in every `EMAIL_VERIFICATION` mode. Omitting `email` or sending the stored value unchanged is not a change, so token profile edits of other fields still apply (`accounts/tests/test_email_change_session_required.py`). On a session, a change on an account with a usable password also needs the correct `current_password` in the same request (`accounts/credentials.py` `email_change_requires_current_password`, checked in `UserSerializer.to_internal_value` before any other email validation, so no "address taken" answer reaches a caller who has not given it): a missing or wrong value is a 400 `current_password` error with nothing written, in every `EMAIL_VERIFICATION` mode, and a wrong value draws on the account's allauth `login_failed` budget through `accounts/password_attempts.py`, as at the password-change routes. The accepted password is verified against the stored account: `UserSerializer.update` re-reads the row under `accounts/credentials.py` `lock_user_row`, in the transaction that writes the change, and refuses with the same 400 `current_password` error when the stored password hash is no longer the one that was checked, as Personal Access Token creation does (`accounts/tests/test_email_change_locked_password.py`). Accounts without a usable password are not asked for one, since they have no password to confirm and an owner who has lost the primary mailbox must still be able to recover the account. Instead, on a session, a change on such an account needs a recent provider sign-in to the account recorded in that session (`accounts/credentials.py` `email_change_requires_recent_login`, via `session_recently_signed_in_by_provider`, the check the first-password rule in the Password change sources row uses, with the same window and the same fail-closed reading, #1932): without one the change is refused with 403 `{"detail": ..., "code": "recent_login_required"}` (the first-password rule's `code`, which the SPA's Settings page turns into a "sign in again" message) in `UserSerializer.to_internal_value`, before any other email validation and with nothing written, in every `EMAIL_VERIFICATION` mode, including the pending-change request under `mandatory`; the stored value sent back unchanged is not a change (`accounts/tests/test_email_change_recent_login.py`). Like the first-password rule it raises the bar for a copied session cookie and is not a bound on a session holder who first connects a provider identity of their own (see the provider-connect row). Those accounts are also sent a notice: an address added to or confirmed on the account is reported to the account's current email (never to the added address), on allauth's "Add" action (`email_added`), on every route that confirms an address (`email_confirmed`: the REST verify-email endpoint, allauth's confirmation page, the `EmailAddress` admin's verify action) (the superuser-only `EmailAddress` admin add and change forms can save an address as verified without `email_confirmed`, so they send no notice; that is a deliberate exception for a trusted operator surface, and only the verify action notifies) and on the pending-change request under `mandatory` (`accounts/no_password_notices.py` `notify_primary_of_address_change`, deferred with `on_commit`; skipped when the confirmation moved `User.email`, since the previous-address notice below reaches that mailbox), in every `EMAIL_VERIFICATION` mode (`accounts/tests/test_no_password_account_notices.py`). The reset gate (`accounts/forms.py` `_ResetLinkGateMixin`) is deliberately unchanged so `EMAIL_VERIFICATION=none` installs keep password reset (`accounts/tests/test_email_change_reauth.py`). `/accounts/email/` (`accounts/views.py` `VisibanEmailView`) is a Django view behind allauth's `login_required` and accepts sessions only; its "Add" and "Make Primary" actions require a recent reauthentication for an account with a usable password (`VisibanEmailView.post` raises allauth's `ReauthenticationRequired`, which `AccountMiddleware` turns into a redirect to `/accounts/reauthenticate/`), since an added address is one password reset looks accounts up by. For an account with no usable password, which allauth would treat as always recently authenticated, the same two actions need the recent provider sign-in above (`session_recently_signed_in_by_provider`); without one `VisibanEmailView.post` adds an error message and redirects back to the page with nothing added or changed (#1932, `accounts/tests/test_email_change_recent_login.py` `ManageEmailPageRecentLoginTests`). Its other actions (re-send verification, remove) add no address and are not gated. "Recent" is allauth's own window, `ACCOUNT_REAUTHENTICATION_TIMEOUT` (left at its default, 300 seconds): a sign-in recorded by allauth's flows (its HTML password login, a social-provider login, a reset from key, or the reauthenticate page) within that window counts; a REST API login (`ThrottledLoginView`, how the SPA signs in) records none, so an SPA session is always asked. Every committed change of `User.email` to a different address, whichever route made it, sends a notice to the previous address (`accounts/signals.py` `capture_prior_email` and `notify_previous_email`, deferred with `on_commit`; `accounts/email_change.py` `send_previous_address_notice`, which does not include the new address and never logs either). Editing an email in the Django admin (the staff-only, loopback-by-default surface, including the superuser-only `EmailAddress` admin) is not gated by the current-password rule; it sends the previous-address notice only. Editing another account's email through the admin API is tracked in #215. Connecting a sign-in provider has its own row below. `DELETE /api/v1/auth/me/pending-email/` (`PendingEmailView.delete`) and `POST /api/v1/auth/me/pending-email/resend/` (`PendingEmailResendView.post`) take no address and are interactive-session only too: each refuses a non-session request (`request_is_interactive_session`) with the same 403 before looking up the pending change, so the answer does not reveal whether one exists (`accounts/tests/test_pending_email_actions.py` `PendingEmailSessionOnlyTests`). One deliberate exemption: a token `PATCH` that sends `email` equal to the stored address while a change is pending still withdraws it (`UserSerializer.update`), because an unchanged email is not a change under `email_change_requires_session`; it can only undo a pending change, never add or confirm an address. A site admin's edits to another account's email go through the Django admin only (`SuperuserOnlyAdminMixin`, Rule 2); the admin API PATCH serializer (`accounts/admin_views.py` `AdminPatchUserSerializer`) has no email field; the admin output serializer and the account-create serializer do carry it |
| Sign-in provider connect | allauth's connect round trip (`POST /accounts/<provider>/login/?process=connect`, started from Settings → Security and the post-login prompt), decided in `accounts/adapter.py` `SocialRegistrationAdapter.pre_social_login` (`_require_recent_authentication`); `accounts/social_connect.py` `notify_provider_connected` (allauth's `social_account_added` signal) and `send_provider_connected_notice`. allauth's headless API is not installed, and the REST API has no connect endpoint (`/api/v1/auth/me/connected-accounts/` lists and disconnects only) | A connected provider is a further way to sign in to the account, so adding one is gated like an email change. For an account with a usable password, a callback that would link a new provider identity requires a recent authentication (allauth's `did_recently_authenticate`, the same window as `/accounts/email/`: `ACCOUNT_REAUTHENTICATION_TIMEOUT`, default 300 seconds; a REST API login records none, so an SPA session is asked); otherwise it redirects to `/accounts/reauthenticate/` with `next` set to the provider's connect start, links nothing, and keeps the pending-prompt identity binding for the retry. No connect state is stored for resumption, so an abandoned reauthentication leaves nothing a later one could complete. The check runs after the account-state refusal and applies whenever the provider identity has no stored `SocialAccount` row, including when allauth's email authentication matched the user by email; it is skipped for an identity already linked to the same account (nothing is added); an identity linked to another account is refused with `provider_already_connected`. `ACCOUNT_REAUTHENTICATION_REQUIRED` stays off, so allauth's other flows are unchanged. An account without a usable password connects without being asked, and its primary address (the primary `EmailAddress` row, else `User.email`) is sent a fixed-text notice after commit (no provider, identity, name or link; skipped if a password was set before the send; failures logged by user id and exception type only). That notice reaches the account holder only while the primary address is theirs, so it relies on the account email change rules in the row above (the session requirement, the recent provider sign-in an account without a usable password needs, and the notice to the previous address). Attaching a provider in the Django admin (`SocialAccount`, superuser-only, Rule 2) is a deliberate exception: it is an operator action, not gated and sends no notice. Signing in with a provider (`process=login`) is not affected. Revoked by disconnecting the provider (`DELETE /api/v1/auth/me/connected-accounts/<provider>/`, interactive session only: `ConnectedAccountDetailView.delete` refuses any request that was not authenticated by a session, via `request_is_interactive_session`, with 403 before the provider is looked up, #1794; `accounts/tests/test_social_connect.py`); a deactivated account cannot sign in through it. Tests: `accounts/tests/test_social_connect_reauth.py`; the redirect without a recent authentication, the email-authentication match, the connect after one and the no-password notice are each run under `EMAIL_VERIFICATION` `none`, `optional` and `mandatory` |
| Account username change | `accounts/serializers.py` `UserSerializer.to_internal_value` (`_check_username_change_needs_session`), shared by `PATCH`/`PUT /api/v1/auth/user/` (dj-rest-auth `UserDetailsView` with `CurrentUserSerializer`) and `PATCH /api/v1/auth/me/` (`accounts/views.py` `CurrentUserView`); `POST /api/v1/auth/choose-username/` (`accounts/views.py` `ChooseUsernameView`) | Changing the username requires an interactive session: `accounts/credentials.py` `username_change_requires_session` refuses any request that was not authenticated by a session (`request_is_interactive_session`, the same positive check as the email rule above) with 403 before field validation and before anything is written, so the answer does not depend on whether the name is taken. `POST /auth/choose-username/` also refuses a token while `must_change_username` is set, even for the stored name, so a token cannot dismiss a forced rename. Omitting `username` or sending the stored value unchanged is not a change, so token profile edits of other fields still apply (`accounts/tests/test_username_change_session_required.py`). Out of scope: a site admin editing another user's account (`accounts/admin.py` protects identity fields in the Django admin; the admin REST API creates accounts but does not rename them) and identity-provider sign-up, which generates a username for a new account. |
| Operator password reset | `operator_commands/management/commands/changepassword.py` (replaces Django's `changepassword`; the app is listed before `django.contrib.auth` in `INSTALLED_APPS` so its command name wins) | The save and `accounts/credentials.py` `revoke_credentials_after_operator_reset` share one `transaction.atomic()` under `lock_user_row`: the user's PATs and DRF `Token` are deleted; sessions end because the session auth hash changes. `must_change_password` is deliberately not set (the operator is usually the account owner, as in the first-boot recovery path). The `accounts.E008` (`changepassword`) and `accounts.E009` (`createsuperuser`) system checks, each silenceable on its own, fail startup if a settings include removes the app and Django's command takes over. The save also writes an `AdminActionLog` entry (`user.password_set`, source `cli`, no actor, metadata `target_id` and `target_username` only) in the same transaction, so a failed log write rolls the password back (`accounts/tests/test_cli_password_action_log.py`). The `ensure_site_admin` bootstrap deliberately differs: it sets `must_change_password`, because the password it generates is temporary and is written to a file (`docs/getting-started/first-boot.md`). Tests: `accounts/tests/test_management_commands.py`, `accounts/tests/test_forced_change_session_exemptions.py` |
| Demo-site seed password | `boards/management/commands/seed_demo_data.py` `_ensure_demo_site_users` (`--demo-site`) | When the account already exists, the re-set takes `lock_user_row`, then deletes the user's PATs and DRF `Token` (`revoke_auth_token`) in the same `transaction.atomic()` as the password save (#1600). A new account has nothing to revoke. `must_change_password` is deliberately not set on any of the four accounts (the visitor account signs in with a published password; the seeder does not set it for the other three accounts either), so this surface does not use `require_password_change_after_admin_set`; it is an explicit exception to the forced-change step of the shared finalization and is guarded by `--demo-site` (`boards/tests/test_seed_demo_data.py`) |
| Command-line password set (action log) | `accounts/management/commands/ensure_site_admin.py`; `accounts/management/commands/provision_fuzz_token.py` (`--set-random-password`); `operator_commands/management/commands/changepassword.py`; `operator_commands/management/commands/createsuperuser.py` (replaces Django's; wraps the `create_superuser` call; no entry when the account is created with an unusable password, since no password was set) | Each writes an `AdminActionLog` entry (`user.password_set`, source `cli`, no actor, metadata `target_id` and `target_username` only) in the same `transaction.atomic()` as the password save, so a failed log write rolls the password back; the password, its hash and the generated one-time password are never stored. Tests: `accounts/tests/test_cli_password_action_log.py` |
| Admin API account creation (action log) | `accounts/admin_views.py` `AdminUsersView.post` (`POST /api/v1/admin/users/`) | Writes `user.password_set` (source `admin_api`, actor the acting admin, metadata `target_id` and `target_username` only) inside the view's `transaction.atomic()`, so a failed log write creates no account. Tests: `accounts/tests/test_admin_create_user_action_log_1801.py` |
| Benchmark user password (action log exception) | `boards/management/commands/benchmark.py` (`bench_user`) | Explicit exception: no action log entry. The command requires `DEBUG` and creates a throwaway account with a random password that is never shown or reused. Pinned by `boards/tests/test_benchmark_command.py` `test_bench_user_password_set_is_not_in_the_admin_action_log` |
| Demo-site seed password (action log exception) | `boards/management/commands/seed_demo_data.py` `_ensure_demo_site_users` (`--demo-site`) | Explicit exception: no action log entry. `--demo-site` requires `DEMO_MODE=true`, and the hourly `--reset-database` empties every table including the action log (`docs/administration/demo-data.md`), so an entry would not outlive the next reset. Pinned by `boards/tests/test_seed_demo_data.py` `test_demo_site_password_sets_are_not_in_the_admin_action_log` |
| WebSocket ticket | `accounts/ws_auth.py` `issue_ws_ticket`, `consume_ws_ticket`, `_resolve_ticket_user` | Single use, `WS_TICKET_TTL` expiry, refused for an inactive user or a minting credential that is no longer live; a session-bound ticket is minted only for a request the positive session check accepts (`credential_for_request`, #1839), so an authenticator that returns no credential object gets no ticket |
| Open WebSocket | `accounts/ws_auth.py` `ws_credential_is_live`, `load_live_ws_user` | Recorded credential no longer live, password changed since handshake (`auth_hash`), account inactive (4003 at the next re-check) |
| Public board share link | `boards/views/share.py` `ShareBoardView`, which resolves the link by `Board.share_token_hash` (the SHA-256 of the token, as invite links store theirs; `Board.hash_share_token`) and never by the stored token (#1880); `boards/models.py` `Board.share_token`, `share_token_hash`, `share_token_expires_at`, `share_enabled_by` | Clearing `share_token` and `share_token_hash` on the board: every route below writes all of `Board.SHARE_LINK_CLEARED`, and the view also requires a non-null `share_token` whose own hash is the stored hash, so a hash left behind, or a token changed without its hash (a previous-release backend during a rolling upgrade), cannot keep a link alive (#1880) (`boards/views/boards.py` `BoardViewSet.share` DELETE, which also clears `share_enabled_by`; a share POST replaces the token and hash together through `Board.issue_share_token`); `share_token_expires_at` (the view returns 410 once it has passed); loss of the enabler's standing (#1865): `BoardViewSet.share` POST records the caller in `share_enabled_by` after re-deriving its standing (a fresh read of the account and of the board) under the board row lock, and the link lasts only while that account is active with an effective role of board `admin` or `site_admin` on the board (`boards/services/share_links.py` `share_enabler_has_standing`, re-derived from current state with `get_board_role` / `get_board_roles`, so an account still an admin another way keeps it). `revoke_lapsed_share_links` clears the token, expiry and enabler with a conditional `UPDATE` (same enabler, same token) and records `board.updated`, in the transaction of the change, on deactivation (`accounts/admin_views.py` `AdminUserDeactivateView._revoke_invite_links`, so the deactivate endpoint, `AdminUserDetailView.patch` and `VisibanUserAdmin.save_model` through `apply_access_loss_revocations`), on loss of `is_site_admin` or `can_access_all_content` (`apply_access_loss_revocations`, also reached from the superuser-status signal; `set_site_admin --revoke`), on a board role change, removal or direct add (a direct membership outranks a group-derived role: `BoardViewSet.members` POST for an update or a create, `remove_member`; `boards/admin.py` `BoardMembershipAdmin.save_model` on change and add, `delete_model`, `delete_queryset`), on a board owner or group change (`BoardAdmin.save_model`, `BoardViewSet.move_group`, `BoardViewSet.perform_update` when `group` changes), on a group role change or removal (`groups/views.py` `GroupViewSet.update_member` PATCH and DELETE), on joining a group (the nearest group role wins, so a lower role nearer the board lowers it: `JoinGroupView.post` and `groups/invite_registration.py` `_grant_membership` when a membership is created; board invites never lower a role, `boards/invites.py` `_would_create_membership`), and on a group re-parent or delete for the boards of the subtree (`GroupViewSet._update_with_broadcast` through `_revoke_lapsed_subtree_share_links`, `GroupViewSet.destroy`); user deletion clears the links the user enabled (`boards/models.py` `clear_share_links_of_deleted_enabler`, a `pre_delete` receiver, since `SET_NULL` alone would leave a link with no recorded enabler). `ShareBoardView.get` re-checks the enabler's standing on every read, before the expiry check, and answers 404 and clears the link when it has lapsed, which covers any route not listed and a share POST racing a deactivation or a group role change, neither of which holds the board row. A link with a null `share_enabled_by` (enabled before the enabler was recorded (for example under 1.1, or 1.2.0-beta.3 and earlier)) has no standing (#1939): `share_enabler_has_standing(None, board)` is false, so the view answers it with the same 404 and clears it (`revoke_lapsed_share_links(board_ids=..., include_unrecorded=True)`, matching `share_enabled_by IS NULL` and the token); the access-change sweeps above leave such links to the view, and no enabler is inferred for them. `BoardFullSerializer._has_live_share_link` reports such a link as no link (`share_link_active` false, `share_token` and its expiry null). A share POST on such a board issues a new link that records the caller. Tests: `boards/tests/test_share_link.py` `ShareFieldsWithoutRecordedEnablerTests`, `boards/tests/test_share_link_enabler.py` (`assert_cleared` checks the hash on every route), `boards/tests/test_share_token_hash.py` |
| Site invite link | `accounts/invite_utils.py` `validate_invite_token`, `consume_invite_token` | `revoked_at`, `expires_at`, `used_at`; `site_invite_creator_admits` re-evaluated at redemption; `revoke_site_invite_links` for links a deactivated or demoted creator made |
| Board invite link | `boards/views/invites.py` `JoinBoardView`; `boards/invites.py` `redeem_reserved_board_invites` (grant at email confirmation, #1704); `boards/models.py` `BoardInviteLink` | `revoked_at`, `expires_at`, `used_at`; `sender_is_board_admin` re-evaluated at preview and join; at confirmation `board_link_registration_refusal` re-checks revocation, expiry, use, role and sender standing on the locked row and releases the reservation on a refusal |
| Group invite link | `groups/views.py` `JoinGroupView`; `groups/invite_registration.py` `redeem_reserved_group_invites` (grant at email confirmation, #1704); `groups/models.py` `GroupInviteLink` | `is_active`, `expires_at`, `used_at`; sender standing re-evaluated by `_sender_still_admits` and `sender_is_group_admin`; at confirmation `group_link_registration_refusal` re-checks revocation, expiry, use, role and sender standing on the locked row and releases the reservation on a refusal |
| OAuth pending invite | `accounts/adapter.py` `SocialRegistrationAdapter.is_open_for_signup` | Invalid or expired token clears `PENDING_INVITE_SESSION_KEY` |
| Grants edited in the Django admin (group permissions, board membership `role` and `is_moderator`, board `owner` and `group`, workspace group `owner`, site settings) | `accounts/admin.py` `SuperuserOnlyGroupAdmin`, `SiteSettingAdmin`; `boards/admin.py` `BoardMembershipAdmin`, `BoardAdmin`; `groups/admin.py` `GroupAdmin` | `groups.admin.GroupAdmin` is superuser-only and read-only (no change form, so the row-version text below does not apply to it); its one write, the "Transfer ownership" action, runs `groups.services.transfer_group_ownership` (shared with the REST endpoint) under row locks, guarded by `expected_owner_id` (the owner recorded in the rendered confirm form, so a stale page is refused and moves nothing), and is recorded in the admin log. A revocation committed by any route (the REST API, another admin form) is not undone by a later save of a form rendered before it: the save writes only the fields the administrator changed, and a form whose `row_version` no longer matches the stored record is refused (`visiban/admin_row_version.py`) |

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
| Site invite (registration) | `accounts/invite_utils.py` `validate_invite_token`, `consume_invite_token` | `select_for_update()` on validation; conditional `used_at IS NULL` update checked by row count. An emailed invite's recipient binding (`visiban/invite_recipient.py` `require_recipient`, #1703) is checked first in `consume_invite_token` on the locked row, so a mismatch consumes nothing; a bound invite redeemed without an account is refused |
| Group invite (registration) | `groups/invite_registration.py` `validate_group_registration_token`, `redeem_group_registration_token` | `select_for_update()` on validation, after the group row lock (`lock_invite_group`, `FOR NO KEY UPDATE`, #1638) so a registration cannot race a group delete; `redeem_group_registration_token` re-takes it and refuses a group deleted since validation; conditional `used_at` update checked by row count. An emailed invite's recipient binding (`visiban/invite_recipient.py` `require_recipient`, #1678) is checked on the locked row before the stamp, so a mismatch consumes nothing. A stored role outside the group membership roles is refused. Under `EMAIL_VERIFICATION=mandatory` with the invited address not yet verified (`grant_awaits_verification`, #1704), the stamp is replaced by a conditional reservation (`reserved_for` set where `used_at` and `reserved_for` are NULL and the link is active, checked by row count): no membership, no `used_at`, and a second sign-up that would also wait is refused. A sign-up that does not wait claims the invite with one conditional update on `used_at IS NULL` that also clears any other account's `reserved_for`, checked by row count, so consume-once holds across a takeover |
| Board invite (join) | `boards/views/invites.py` `JoinBoardView.post` | `select_for_update()` on the link row inside the request transaction, taken after the board row lock (`FOR NO KEY UPDATE`, #1631) so a join cannot race a board delete. The emailed invite's recipient binding (`visiban/invite_recipient.py` `recipient_admits`, #1678) is checked on the locked row before `redeem`, so a mismatch (`403 invite_recipient_mismatch`) writes nothing. A reservation held for an account awaiting confirmation (#1704) is not checked here: the join consumes the invite, and that account is granted nothing later |
| Group invite (join) | `groups/views.py` `JoinGroupView.post` | `select_for_update()` on the link row inside the request transaction, taken after the group row lock (`lock_invite_group`, `FOR NO KEY UPDATE`, #1638) so a join cannot race a group delete; recipient binding (`recipient_admits`, #1678) checked on the locked row before the membership write and `used_at` stamp. A reservation held for an account awaiting confirmation (#1704) is not checked here: the join consumes the invite, and that account is granted nothing later |
| Board invite (registration) | `boards/invites.py` `validate_board_registration_token`, `redeem_board_registration_token` | `select_for_update()` on validation, after the board row lock (`lock_invite_board`, #1631); conditional update on `used_at IS NULL, revoked_at IS NULL` checked by row count. Recipient binding (`require_recipient`, #1678) is checked before the claim. Under `EMAIL_VERIFICATION=mandatory` with the invited address not yet verified (#1704), the claim sets `reserved_for` instead (also conditional on `reserved_for IS NULL`, checked by row count), granting nothing. A sign-up that does not wait claims the invite in the same conditional update that clears another account's `reserved_for`, checked by row count |
| Group and board invite (grant at email confirmation) | `visiban/invite_recipient.py` `grant_reserved_invites` (allauth `email_confirmed` receiver), `boards/invites.py` `redeem_reserved_board_invites`, `groups/invite_registration.py` `redeem_reserved_group_invites` | Per reserved invite, in its own transaction: board row lock then `select_for_update()` on the invite row (group: group row lock, then the invite row; `GroupViewSet.destroy` locks the group row and its subgroups first, so a grant and a group delete queue whole, #1638); the confirmed address must match the recipient binding (`confirmed_address_admits`), else nothing changes; the registration rules are re-applied on the locked row (revoked, used, expired, grantable role, sender standing, email invites enabled), and a refusal releases the reservation and grants nothing; then a conditional update on `used_at IS NULL`, `reserved_for = <account>` (board: `revoked_at IS NULL`; group: `is_active`) checked by row count before the membership write. Board grants go through `redeem`, which records `member.added` with `record_board_event` (published on commit); group grants publish `member.added` with a robust `transaction.on_commit`. A failure on one invite is logged with ids only and rolled back without failing the confirmation or the other invites. The grant receiver is connected before the email-change receiver, so an error there cannot leave the invite reserved after the address is verified. Only allauth's `email_confirmed` triggers the grant: an address marked verified without it leaves the invite reserved, and the existing-account join paths above ignore a reservation and consume the invite, which is the recovery path. A reservation made before the site switched to CLOSED is still granted at confirmation. Concurrent confirmations, a confirmation racing a join, and two simultaneous takeovers each give one grant (`boards/tests/test_invite_grant_after_verification.py`, PostgreSQL) |
| Registration dispatch | `accounts/registration_tokens.py` `registration_token_kind` | Routes to the site, group or board validate and redeem functions above |
| Email and password signup | `accounts/views.py` `InviteRegisterView.post` | Runs in `transaction.atomic`; validates and redeems through `registration_token_kind`. A submitted address that does not match an emailed site, group or board invite's binding (`InviteRegisterView.perform_create` through `signup_address_admits`, #1678, #1703) is refused with `400` after the form validates and before the account is created; redemption re-checks it on the created account. Under `EMAIL_VERIFICATION=mandatory`, a group or board invite whose address is not yet verified is reserved for the account and granted at confirmation (#1704, rows above); a site invite admits the account itself and is consumed at registration in every mode. In INVITE_ONLY mode (site, group and board invites) the signup confirmation mail is sent only after the transaction commits, never under the row locks registration holds (#1639); a send that fails after the commit is logged and the account stands (`201`), the user asks again through `POST /api/v1/auth/registration/resend-email/` (`ResendEmailThrottle`), and under `EMAIL_VERIFICATION=mandatory` the `201` body still reads "Verification e-mail sent.". Open-mode signup holds no such lock and sends inline |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter.save_user`, `_redeem_invite` | Validate and redeem in one transaction; a recipient-binding mismatch at redemption (#1678, #1703; site invites through `consume_invite_token`) rolls the account back and redirects with `auth_error=invite_recipient_mismatch`. Under `EMAIL_VERIFICATION=mandatory`, a group or board invite is granted at sign-up only when the provider reported the invited address as verified; otherwise it is reserved and granted at confirmation (#1704) |
| WebSocket ticket | `accounts/ws_auth.py` `consume_ws_ticket` | Single use decided by the return value of `cache.delete()` |
| JSON, CSV and Trello import | `boards/views/import_export.py` | No consume-once token on this surface |
| Admin actions | `accounts/admin_views.py` `AdminInviteLinkRevokeView.delete` | Revocation sets `revoked_at` on the link |
| Password reset link (REST) | `accounts/serializers.py` `VisibanPasswordResetConfirmSerializer.save` | Single use, decided under the user row lock (`reset_link_still_valid` on the locked row) |
| Password reset link (HTML) | `accounts/forms.py` `VisibanResetPasswordKeyForm.save` | Single use, decided under the user row lock; the page shows its invalid-link page for a link that no longer validates, and a submit that overlaps another is refused |

## Rule 5: User references resolve against active users, and imports within the caller's scope

**Rule.** The instance user directory is intentionally open to signed-in users:
user search and member add by id resolve against active accounts on the
instance; the user object they return carries only `id`, `username`,
`display_name` and `avatar_url`. Search matches only the fields it returns. On the member-add and member-removal
routes listed below, an id that matches no user, an inactive user, or (for
removal) an active user with no membership on the target gets the same
response, status and body. Existing memberships of inactive users stay
listed and editable; the active-user filter applies when a membership is
created. The refusal to modify or remove a site admin's membership (for a
caller who is not a site admin) applies only to a membership that already
exists on that board or group; a target with no membership gets the response
any other target gets, whatever the target's site role (#1706). Adding a site
admin to a board is therefore an ordinary add: for a caller who is not a site
admin, the add and update response and the `member.added` and `member.updated`
events it produces (live and in the change feed) omit `is_site_admin` for every
target; `member.added` events from invite redemption keep their documented
payload, which each subscriber receives according to their role, so a
site-admin target and an ordinary one have the same shape, and a new direct row
never lowers a site admin's effective role (when the caller is not a site admin
and the target is a site admin with no direct row, the stored role is the higher
of the requested role and the role the user already holds on the board; for any
other target a direct row keeps its ordinary precedence over a group-inherited
role). The add itself is visible to board admins and notifies the target.
The add endpoint re-checks the refusal on the locked membership row, so a
membership created while a request waited for the board lock is judged too.

The board member list (`/full/` `members`) follows the same line (#1714). For a
reader who is not a site admin (neither board role `site_admin` nor
`User.is_site_admin`), it lists the board's own members only (direct,
group-inherited and the owner), not every all-content user on the instance, and
a board admin among those readers gets `is_site_admin` only on rows backed by a
membership on this board: the rows the refusal above applies to, which the
Members tab locks. Group-inherited and owner rows carry no flag for them, since
a change to such a row is an ordinary add. A site-admin reader gets the full
roster and the flag on every row. `site_admin_roster_visible` holds this rule.

`site_admin_roster_visible(role, viewer_is_site_admin)` returns true when the
reader's board role is `site_admin` (which is what `can_access_all_content`
resolves to) or the reader has `User.is_site_admin`, so a reader with
instance-wide content access who is not `is_site_admin` already gets the full
roster; the function is deliberately unchanged (#1717). The Members-tab lock
keys on the row being membership-backed (`id` not null) plus the flag, not on
which readers receive the flag. Pinned by
`test_all_content_reader_gets_full_roster` and
`SiteAdminRosterVisibleUnitTests.test_rule` in
`backend/boards/tests/test_member_site_admin_flag.py`.

Imports are narrower by design. When an import file names users as assignees,
the names resolve only against active users the importer can already see: the
importer, co-members of their boards and groups, and the target group (a site
admin or an all-content user matches every active user). A name outside that
pool is dropped, so a file cannot assign work to an arbitrary account.

Imported history rows (JSON movement `moved_by`, activity `actor`) and imported
comments (JSON comment `author`, Trello comment authors) are not resolved at
all, inside the pool or out of it: each row is recorded under the importer and
keeps the source's name as text in `imported_from_username` (#1675, #1702),
which the timeline, comment list, History view and exports display. A new import
path that writes history rows or comments applies the same rule rather than
linking them to accounts.

Card assignees follow a separate scope (#1716). The assignable set for a board is its owner, users with `can_access_all_content`, and members whose resolved role is not viewer. The set follows the same ladder as `get_board_role`: a user with an explicit board membership row is judged by that row alone (a viewer row, or a row whose role is outside the enum, excludes them even if a group would make them a member), and a group-inherited role (nearest ancestor group, as in `get_board_role`) applies only to users with no explicit row. A viewer role alone never makes a user assignable. The effective member set used for notification recipients follows the same ladder, so an out-of-enum row grants no recipient status either. REST card create and update and the MCP `create_card` and `update_card` username lookup all use this set (`_get_assignable_member_ids`).

Scope of this rule: the surfaces in the table below. Comment mentions are
validated against board membership by their own check (`boards/utils.py`,
`extract_mentions`) and are not covered here.

**Why.** The uploader controls an import file, so it resolves against the
narrower pool and drops what it cannot match. The directory lookups are open on
purpose (a board admin must be able to find anyone to add), so their invariant is
the status filter and the uniform response, not scope.

| Surface | Entry point | Enforced via |
|---|---|---|
| JSON import | `boards/views/import_export.py` `BoardImportExportMixin._import_json` | `_resolve_import_users` (assignee); history rows and comments use the importer plus `_imported_from_username` |
| CSV import | `boards/views/import_export.py` `BoardImportExportMixin._import_csv` | `_resolve_import_users` (assignee; CSV import writes no history rows) |
| Trello import | `boards/views/import_export.py` `BoardImportExportMixin.import_trello` | `boards/services/trello_import.py` `visible_users`, `match_members` (card members only; comments use the importer and keep the author name in `imported_from_username`; Trello import writes no movement or activity rows) |
| User search | `accounts/views.py` `UserSearchView` | Filters `is_active=True`; matches `username` and `display_name` only |
| Board member add or role change | `boards/views/boards.py` `BoardViewSet.members` | An existing membership is updated as is (the site-admin refusal applies to it); a new one requires an active user, whatever the user's site role. Unknown and inactive ids answer the same `404`. Also checks the submitted `role` is a string within `BoardMembership.Role.values` |
| Group member role change | `groups/views.py` `GroupViewSet.update_member` (PATCH) | Same lookup and `404`; the site-admin refusal is evaluated after the membership lookup |
| Board and group member removal | `boards/views/boards.py` `BoardViewSet.remove_member`; `groups/views.py` `GroupViewSet.update_member` (DELETE) | Resolved through the membership row: no membership answers the same `404` whatever the id is, and the site-admin refusal is evaluated after that lookup; an inactive user with a membership can be removed |
| Card assignee (REST) | `boards/serializers.py` `CardSerializer.__init__` (`assignee_id` queryset), `boards/views/cards.py`, `boards/views/_helpers.py` | `boards/utils.py` `_get_assignable_member_ids`: owner, `can_access_all_content` users, and members whose role resolves through the `get_board_role` ladder to a non-viewer role (#1716, #1866). Pinned by `boards/tests/test_viewer_assignee.py` (`MemberSetLadderTests`, which also compares both sets with `get_board_role`) |
| Card assignee (MCP) | `mcp_server/tools.py` `create_card`, `update_card` | One lookup shared by both tools: username matched case-insensitively within `_get_assignable_member_ids`; anything outside it gets the uniform assignee error. Pinned through `update_card` by `mcp_server/tests/test_mcp_crud.py` |
| MCP | `mcp_server/tools.py` | No import tool; user references resolve through the caller's accessible boards |
| Board member list | `boards/serializers.py` `BoardFullSerializer.get_members` | `site_admin_roster_visible` (all-content rows, and `is_site_admin` on rows with no membership, for site-admin readers only), then `site_admin_field_visible`. The other member-row surfaces (members POST response, `member.*` events, change feed) only ever carry a real membership row |

## Rule 6: Placing a board in a group needs group admin

**Rule.** Every API path that puts a board into a group requires the caller to
be an admin of that group or of an ancestor (or a site admin with all-content
access). The refusal shape differs by surface and is listed per row below.

**Why.** A board placed in a group is visible to its members and administered by
its admins, so the role needed must not depend on which endpoint is used.

| Surface | Entry point | Enforced via | Refusal |
|---|---|---|---|
| Create in group | `groups/views.py` `GroupViewSet.boards` (POST) | `_require_group_admin` | `404` for a group the caller cannot see, `403` for a visible group they do not administer |
| Board `group` field | `boards/serializers.py` `BoardSerializer.validate_group` | `_require_group_admin` | One `400` (`{"group": [...]}`) for a missing, invisible or non-administered group |
| Move group | `boards/views/boards.py` `BoardViewSet.move_group` | `resolve_group_for_board_placement` | `404` for a missing, malformed or invisible group, `403` for a visible group they do not administer |
| JSON, CSV and Trello import | `boards/views/import_export.py` `_resolve_import_group` | `resolve_group_for_board_placement` | Same as move group |
| Django admin board form | `boards/admin.py` `BoardAdmin` / `BoardAdminForm` (`fields = "__all__"`, so `group` is editable) | Not covered by this rule | Staff-only surface; see the exception below |

Exception: the Django admin board form is limited to staff accounts holding the
board model permissions and is a site-operator tool, not a group-scoped API, so
it is intentionally outside the enumeration. The API rows are covered per
surface: create in group by `groups/tests/test_groups.py`
`test_non_admin_cannot_create_board_in_group`, the board `group` field by
`boards/tests/test_board_group_field_validation.py`, and move group and the
imports by `boards/tests/test_group_placement_roles.py`. The entry-point test
(`GroupPlacementEntryPointTests`) checks every API surface in this table; the
Django admin row is the exception named above.

## Rule 7: Board-scoped routes answer 404 to callers with no access

**Rule.** A board-scoped route answers `404 Not Found` to a caller with no access
to the board, the same as for a board that does not exist. `403 Forbidden` is
reserved for a caller who can see the board but whose role is below the minimum
for the action.

**Why.** `BoardViewSet.retrieve`, MCP and media already answer `404` to
non-members. A nested route that answered differently would make the status code
depend on whether a board id exists.

| Surface | Entry point | Enforced via |
|---|---|---|
| Nested REST routes (members, cards, columns, swimlanes, labels, custom fields, analytics, export, invites, git lens) | `boards/views/_helpers.py` `get_board_for_user` | Raises `404` when the board is missing or the caller has no role on it; callers raise `403` for an insufficient role afterward |
| Board detail | `boards/views/boards.py` `BoardViewSet.get_queryset` | Queryset scoped to accessible boards (`get_accessible_boards_queryset`; a board is in it exactly when `get_board_role` returns a role), so `retrieve`, update, destroy and `star` answer `404` |
| Media | `boards/views/media.py` `ServeMediaView` | `404` for a non-member |
| MCP | `mcp_server/tools.py` | `404`-equivalent not-found result for inaccessible boards |

## Rule 8: Per-recipient event fields are gated on every broadcast and replay surface

**Rule.** A board event is fanned out to every subscriber and stored once in the
change feed. The events and fields listed here are filtered per recipient on
each surface that delivers them:

- per-user events (`boards/permissions.py` `PER_USER_EVENTS`: `board.star_changed`,
  `saved_filter.created`, `saved_filter.deleted`; plus `group.star_changed` on the
  group channel) reach only the user named in `data.user_id`
  (`per_user_event_visible`). Writers persist them with `actor_id` set to that
  user, which is what the feed filters on;
- `is_moderator` on `member.added` / `member.updated` is shown to admin and
  site_admin recipients, and to any recipient on their own row
  (`moderator_field_visible`);
- `is_site_admin` on the same events, and `invite` on `member.added`, are shown
  to admin and site_admin recipients only (`site_admin_field_visible`,
  `invite_field_visible`);
- `is_starred` (`ACTOR_SCOPED_FIELDS`) on `board.created`, `board.updated`,
  `group.created` and `group.updated` (`ACTOR_SCOPED_FIELD_EVENTS`) is the acting
  user's own value and is shown only to that user (`without_actor_scoped_fields`).
  The actor comes from the `actor_id` the broadcast helpers put on the
  channel-layer message beside the envelope (never on the wire), or from the feed
  row's `actor_id`; writers of these events pass it, the Django-admin board
  writes and group ownership transfer included (there the value is a constant
  `false`, since no request context exists). A frame or row without an actor
  omits the field for everyone;
- admin-only board fields (`ADMIN_ONLY_BOARD_FIELDS`) are dropped for every
  recipient (`without_admin_only_board_fields`);
- admin-only swimlane custom field values are never in a broadcast payload, and
  change-feed swimlane rows are re-filtered at read time against the board's
  current shareable definitions.

An unknown recipient role or identity hides the field or the event.

**Why.** The writer has no recipient to filter for, and the change feed replays
stored payloads, so the gate has to run where the recipient is known. A gate on
one surface only leaves the same field readable through another.

| Surface | Entry point | Enforced via |
|---|---|---|
| Board WebSocket | `boards/consumers.py` `BoardConsumer.board_event` | Per-user drop (`per_user_event_visible`), then `moderator_field_visible`, `site_admin_field_visible`, `invite_field_visible` on `MODERATOR_BEARING_EVENTS`, using the subscriber's re-resolved role, then `without_actor_scoped_fields` against the message's `actor_id` |
| Group WebSocket | `groups/consumers.py` `GroupConsumer.group_event` | Per-user drop over `GROUP_PER_USER_EVENTS` (derived from `PER_USER_EVENTS`), then `without_actor_scoped_fields` against the message's `actor_id`. There is no `is_moderator`, `is_site_admin` or `invite` strip on this surface: the group channel's `member.added` carries a `GroupMembershipSerializer` row, which has none of those fields |
| Change feed | `boards/views/boards.py` `BoardViewSet.events`; `boards/serializers.py` `BoardEventSerializer.to_representation` | The view excludes other users' `PER_USER_EVENTS` rows in the page query; the serializer applies the three member-field helpers with the reader's role, `without_admin_only_board_fields`, `without_actor_scoped_fields` against the row's `actor_id`, and the swimlane re-filter (`shareable_swimlane_field_ids`). `group.created` / `group.updated` are not persisted, so the feed has no group rows |
| Broadcast and persist (write time) | `boards/broadcast.py` `broadcast_board_event`, `record_board_event`, `persist_board_event`; `groups/broadcast.py` `broadcast_group_event` | `without_admin_only_board_fields`; `without_viewer_specific_group_fields` on every group event (drops `can_place_boards`, #1692); swimlane payloads built from the public `SwimlaneSerializer`; `actor_id` carried on the channel-layer message for the consumers' `without_actor_scoped_fields` |
| REST board and members | `boards/serializers.py` `BoardFullSerializer.get_members`, `get_swimlanes`; `BoardMembershipSerializer.to_representation` | `moderator_field_visible`, `site_admin_field_visible` (on `/full/`, also `site_admin_roster_visible`, Rule 5); `SwimlaneAdminSerializer` for admin and site_admin only |
| Board export | `boards/views/import_export.py` `BoardImportExportMixin.export` | Admin-only swimlane definitions and their values are included for admin exporters only |

Coverage: `boards/tests/test_event_payload_scoping.py` (per-user events on both
channels and the feed, `invite`, swimlane re-filtering, and a check that every
`*star_changed` and `saved_filter.*` event is in the per-user sets),
`boards/tests/test_actor_scoped_event_fields.py` (`is_starred` per recipient on
both channels for each write path, and in the feed for every reader role),
`boards/tests/test_board_events.py` `ReadSideStrippingTests` (including the
shared-helper identity check), `boards/tests/test_share_link.py`
`ShareLinkActiveFieldTests` (`share_link_active` is in `ADMIN_ONLY_BOARD_FIELDS`
and null below admin on `/full/`), `boards/tests/test_consumer_role_refresh.py`, and
`boards/tests/test_member_site_admin_flag.py`.

## Rule 9: Role writers validate against the model enum, and role readers fail closed

**Rule.** Every code path that stores a board or group role validates the
request-supplied value against the model's role enum (`Role.values`) before the
write, and rejects a non-string or out-of-set value. Every helper that resolves a
role from a stored row treats a value outside the enum as no role, not as a
role: `choices` is not enforced on save, so the stored string cannot be trusted
to be a member of the enum.

**Why.** Role comparisons treat an unknown string as meaningful (a ladder that
ranks known roles can rank an unknown one anywhere). Validation at the writer
keeps bad values out; the fail-closed reader bounds the damage of one that
arrives by any other route, any non-API write.

| Surface | Entry point | Enforced via |
|---|---|---|
| Board member add or role change (REST) | `boards/views/boards.py` `BoardViewSet.members` | The submitted `role` must be a string within `BoardMembership.Role.values`, else `400`, before any row is written |
| Group member role change (REST) | `groups/views.py` `GroupViewSet.update_member` (PATCH) | The submitted `role` must be within `GroupMembership.Role.values`, else `400` |
| Board invite links, link and email (REST) | `boards/serializers.py` `BoardInviteLinkCreateSerializer`, `BoardInviteLinkEmailSerializer`; `boards/models.py` `BoardInviteLink.generate` | A `ChoiceField` limited to the roles an invite may grant; `generate` repeats the check against `GRANTABLE_ROLES` (a subset of `Role.values`) |
| Group invite links, link and email (REST) | `groups/serializers.py` `GroupInviteLinkCreateSerializer`, `GroupInviteLinkEmailSerializer` | A `ChoiceField` over `GROUP_INVITE_LINK_ROLE_CHOICES` (every role but `admin`, Rule 13) in both serializers, for a shareable link and for an emailed invite (#2006) |
| Invite redemption at registration | `boards/invites.py` `role_is_grantable`, `_would_create_membership`; `groups/invite_registration.py` `group_link_registration_refusal` | The stored link role must be in the grantable set (`GRANTABLE_ROLES`) or `GroupMembership.Role.values`, else the invite is refused as invalid |
| Group invite preview and redemption (REST) | `groups/views.py` `JoinGroupView.get`, `JoinGroupView.post` | The stored link role must be within `GroupMembership.Role.values` (and not `admin`, Rule 13), else the same `404` as a revoked link (preview and join), before any membership is written or the invite consumed; matches `group_link_registration_refusal` (#2015). Pinned by `groups/tests/test_join_group_role_validation_2015.py` |
| Assignable and notification member sets | `boards/utils.py` `_get_effective_member_ids`, `_get_assignable_member_ids` | Follow the `get_board_role` ladder: an explicit row is judged by that row alone, so a row outside `BoardMembership.Role.values` grants nothing and group membership does not re-admit it; a group role outside `GroupMembership.Role.values` is skipped and the nearest ancestor group decides. Pinned by `boards/tests/test_viewer_assignee.py` `MemberSetLadderTests` (#1866) |
| Board roster on `/full/` | `boards/serializers.py` `BoardFullSerializer.get_members` | Group-inherited roles use the same nearest-ancestor rule and skip out-of-enum group roles. Explicit rows are listed as stored, including out-of-enum ones, so admins can see and remove them; those display differences are tracked in #1905. Pinned by `FullRosterLadderTests` |
| Board export threshold (REST) | `boards/views/import_export.py` `_effective_export_min_role`, `_can_export_at_min_role` (also used by the movement export in `boards/views/analytics.py`); `boards/serializers.py` `BoardSerializer.export_min_role` | The serializer field is a `ChoiceField` over `Board.ExportMinRole.choices`; the model field declares the same `choices`, so the admin form enforces them too, and migration 0086 maps any stored out-of-set value to `admin`. MCP has no export action. A stored `export_min_role` outside that set is treated as `admin` (owners and site admins still pass), not as `viewer`. Pinned by `boards/tests/test_export_controls.py` `ExportMinRoleUnrecognizedValueTests` (#1725) |
| Board role resolution (all transports) | `boards/permissions.py` `get_board_role`, `get_board_roles` | A stored board membership role outside `BoardMembership.Role.values` resolves to no access; a stored group role outside `GroupMembership.Role.values` is skipped in the ancestor walk (`_nearest_ancestor_role`); the moderator flag is honored only for an in-enum role |
| Board list and card query scoping | `boards/views/_helpers.py` `get_accessible_boards_queryset`, `board_access_q`; `groups/views.py` `GroupViewSet.boards` GET, `_descendant_boards_queryset` (serves `descendant_boards` and `descendant_boards_paged`) | A stored board membership role outside `BoardMembership.Role.values` admits no board through that membership and, as in `get_board_role`, is not overridden by group membership; the board owner is admitted regardless |
| Group-derived board scoping | `groups/models.py` `get_group_ids_for_board_access` | Only group memberships whose stored role is within `GroupMembership.Role.values` contribute groups (`_access_memberships`, shared with the group access predicates below) |
| Group access: REST nested routes, group list and retrieve | `groups/models.py` `user_has_group_access` (behind `groups/views.py` `_require_group_member`), `group_access_resolver` (`navigation_only`), `get_accessible_group_ids` (`GroupViewSet.get_queryset`, `resolve_group_for_board_placement`) | Only memberships whose stored role is within `GroupMembership.Role.values` grant access or list a group (`_access_memberships`), so a row outside the enum grants no group route, list entry or channel, as it grants no board role. Group ownership alone is not a rung: the owner holds a direct admin row (Rule 11) (#1829). Pinned by `groups/tests/test_group_role_fail_closed_1829.py` |
| Group member roster | `groups/views.py` `GroupViewSet.members` | An inherited row whose stored role is outside the enum is skipped, and the nearest ancestor row within the enum is listed instead. Direct rows are listed as stored, including out-of-enum ones, so admins can see and remove them (#1829) |
| Group invite preview and join, consumed links | `groups/views.py` `_is_member` | A member of the group may follow a consumed link of theirs without the creator check; only a row within `GroupMembership.Role.values` counts as membership (#1829) |
| Card comment, attachment and checklist writes (REST) | `boards/views/cards.py` `CardViewSet.comments`, `delete_comment`, `attachments`, `delete_attachment`, `checklist`, `checklist_item`, `checklist_reorder` | The resolved role must be in the allow-list `boards/services/cards.py` `ANNOTATION_ROLES` (collaborator, member, admin, site admin), not merely other than viewer, so a role added later gets no write access until listed (#1829, as #875 did for `set_collapsed`) |
| Import user matching pool | `boards/services/trello_import.py` `visible_users` (Rule 5) | Only the importer's own board and group memberships within the enum make their co-members matchable (#1829) |
| Default board choice (REST) | `accounts/serializers.py` `UserSerializer` (`default_board_id`) | The choice is limited to boards where the user holds a membership within `BoardMembership.Role.values`; any other id is a `400` (#1829) |
| WebSocket (board) | `boards/consumers.py` `_lookup_role` | The role comes from `get_board_role`; the consumer accepts no role from a frame |
| WebSocket (group) | `groups/consumers.py` `_user_can_access_group_id`, `GroupConsumer._board_visible` | Access is `user_has_group_access`, which ignores a membership outside the enum; `board.created` and `board.updated` frames are forwarded only when `get_board_role` resolves a role on that board for the subscriber, so an explicit board row outside the enum withholds them as on the board channel (#1829); the consumer accepts no role from a frame |
| MCP | `mcp_server/tools.py` `_resolve_board` | Roles come from `get_board_role` and `get_board_roles`; no tool writes a membership role |

Coverage: `boards/tests/test_members_role_validation.py` (writer rejection,
stored out-of-enum board and group roles, bulk resolver, moderator flag),
`groups/tests/test_groups.py` (`test_invalid_role_returns_400`,
`test_all_valid_roles_are_accepted`, `test_invalid_invite_link_role_returns_400`),
`boards/tests/test_group_derived_board_access.py` `StoredRoleTests` (board list,
retrieve and card query), `groups/tests/test_group_role_fail_closed_1829.py`
(group predicates, REST routes, list, roster, group WebSocket handshake and
board frames), `boards/tests/test_card_annotation_roles_1829.py` (comment,
attachment and checklist allow-list) and `boards/tests/test_import_user_scope.py`
`test_rows_with_an_unrecognized_role_do_not_widen_the_pool`.

Readers that still count a group membership outside the enum, accepted as
display or availability effects that grant nothing: the group `member_count`
(`groups/counts.py` `annotate_group_counts`, which counts the direct rows the
roster lists), and an invite join (`groups/views.py` `JoinGroupView.post`,
`groups/invite_registration.py`), whose `get_or_create` keeps such an existing
row instead of replacing it, so the user stays without access.

## Rule 10: A second transport is no broader than REST for the same role

**Rule.** Where a feature reaches the same data over a second transport
(WebSocket, MCP, change feed, export), its access predicate and its output
field set for a given role are no broader than the REST ones for that role.
The predicate is shared code where possible (one function called by every
transport) and the output is either built from the REST serializer or from an
explicit allow-list pinned by a test to the REST field set. A field REST omits
for a role is omitted on every other transport for that role.

**Why.** Hand-written shapes and copied predicates drift: a field added to one
serializer, or a rule tightened on one endpoint, does not reach a copy. A deny
list on the second transport fails open on the next field added; an allow-list
fails closed.

| Surface | Entry point | Enforced via |
|---|---|---|
| WebSocket (group) | `groups/consumers.py` `_user_can_access_group_id`, `GroupConsumer._board_visible` | Calls `groups/models.py` `user_has_group_access`, the predicate REST `_require_group_member` uses, at connect and at every periodic re-check. A `board.created` or `board.updated` frame, which carries a full board, is forwarded only to a subscriber on whom `get_board_role` resolves a role for that board, the predicate of REST board detail and `BoardConsumer` (#1829); the verdict is cached per board for the access re-check window. `board.deleted` (identifiers only: `board_uid`, and `board_id` on a move-out) is accepted as ungated, since access cannot be resolved for a deleted board and a client needs it to drop a listed row |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer`, `_lookup_role` | Role from `boards/permissions.py` `get_board_role`, the helper REST uses; per-recipient field gating is Rule 8 |
| MCP (access) | `mcp_server/tools.py` `_resolve_board`, `list_boards` | `_resolve_board` takes the role from `get_board_role`, and a missing board and an inaccessible board are answered alike (Rule 7). `list_boards` starts from `boards/views/_helpers.py` `get_accessible_boards_queryset`, the queryset `BoardViewSet.get_queryset` uses; the role comes from the shared `get_board_roles`, and a board with no resolved role is omitted. `mcp_server/tests/test_mcp.py` covers the listing |
| MCP (output) | `mcp_server/tools.py` `board_snapshot`, `_serialize_user`, `_swimlanes_payload`, `_serialize_card` | Explicit allow-list shapes, not `BoardFullSerializer`; web-session-only fields (share token, share-link expiry and `share_link_active`, capabilities, members, current role) are absent (`test_mcp.py` `test_web_only_fields_are_never_exposed`); users carry only the REST user fields and no email; admin-only swimlane fields are included for admin roles only |
| Change feed and board export | `boards/serializers.py` `BoardEventSerializer.to_representation`; `boards/views/import_export.py` `BoardImportExportMixin.export` | Rule 8 rows: per-reader field gating with the reader's role |

Coverage: `mcp_server/tests/test_mcp.py` (`UserFieldParityTests`, which pins
user-bearing keys and card keys to the REST serializers for the lowest role, and
`test_web_only_fields_are_never_exposed`), `boards/tests/test_consumer_role_refresh.py`,
and the Rule 8 tests.

## Rule 11: A group keeps its owner as an admin member and at least one active admin

**Rule.** A group's owner keeps a membership with the `admin` role, and member
removal, demotion and user deletion are refused when they would leave the group
without an active admin. A request that would remove or demote the owner, or remove or
demote the last active admin, is refused. Deactivated admins do not
count. The account's active flag is read at check time and is not covered by the
group lock. The owner leaves through ownership transfer or by deleting the group.

**Why.** A group with no active admin is repaired through its owner (ownership transfer
or deletion) or, for a departed owner, by a superuser's ownership transfer. Both checks
are judged under the group row lock, so two concurrent requests that each change
a different admin cannot both pass.

| Surface | Entry point | Enforced via |
|---|---|---|
| Group member role change and removal (REST) | `groups/views.py` `GroupViewSet.update_member` | `groups/services.py` `lock_membership_for_removal_or_demotion`: group row `FOR NO KEY UPDATE`, then the admin rows and the target row in one pk-ordered statement; refused with `400` |
| Group ownership transfer (REST) | `groups/views.py` `GroupViewSet.transfer_ownership` | `groups/services.py` `transfer_group_ownership`: the new owner must already be an admin and the previous owner stays an admin; the group row is locked `FOR UPDATE`, which queues with the member-change lock |
| Group ownership transfer (Django admin) | `groups/admin.py` `GroupAdmin` transfer action | The same `transfer_group_ownership` function |
| User delete (Django admin: delete page, `delete_model`, `delete_queryset` and the **Delete selected users** action) | `accounts/admin.py` `VisibanUserAdmin.delete_view`, `delete_model`, `delete_queryset`, `guarded_delete_selected` | `user_deletion_refusals` refuses deleting a group owner, and refuses a delete that would leave a group the targets actively administer with no active admin outside the deleted set (`groups/services.py` `groups_left_without_admin`, counting with the shared `admin_minimum_q` / `counts_toward_admin_minimum` predicate). Under the delete's locks, `VisibanUserAdmin._lock_and_check_admins` takes those groups' rows `FOR NO KEY UPDATE` (`lock_groups_administered_by`) after the user rows, so the delete and a member change or ownership transfer on the same group queue |

The Django admin is the only route that deletes accounts, apart from the shell
and the `benchmark` management command's own fixture account: the admin API
and the site-admin panel deactivate instead, there is no self-service account
delete, and there is no OSS deprovisioning hook.
The `GroupMembership.user` cascade it runs is not visible to
`GroupMembershipEntryPointTests`, which is why the row above names its own check.

Coverage: `groups/tests/test_group_member_guards.py` (owner and last-admin
refusals on both methods, a demotion queued behind an ownership transfer, and
`GroupMembershipEntryPointTests`, which scans the backend for a function that
deletes or demotes a `GroupMembership` and requires it to call
`lock_membership_for_removal_or_demotion` or be allowlisted with a reason);
`accounts/tests/test_admin_user_delete_group_admin.py` (the user delete on the
delete page and the bulk action, a set judged as a whole, an inactive admin not
counted, the re-check under the locks, and on PostgreSQL a delete and a demotion
queued on the group row in both orders).

Existing data: migration `groups/0022_restore_group_owner_admin_rows` gives
every group's owner a direct `admin` membership, promoting a non-admin row or
adding a missing one, so the owner half of the rule holds for every existing
group (`groups/tests/test_group_owner_admin_repair_1786.py`).

The owner's group access rests on that row alone: since #1829 no group access
predicate has an ownership rung (`get_accessible_group_ids` had one), so an
owner whose row is missing or carries a role outside the enum sees the group
like any non-member. A superuser repairs it with the Django admin transfer,
which offers only the group's other active members as the new owner; for a
group with no other member, someone with access to all content first adds
one through the API.

## Rule 12: Extension panels are filtered on the caller's role before they run

**Rule.** Every surface that renders `ANALYTICS_EXTENSIONS` panels gets the
callables to run from `boards/permissions.py` `analytics_extensions_for_role`,
passing the board role it authorized the request with. A panel whose declared
`min_role` ranks above that role (on the `boards/invites.py` `ROLE_RANK` ladder)
is never called. A missing, `None` or invalid `min_role` means `admin`, and a
`None` or unknown caller role gets no panels.

**Why.** Panels are enterprise or third-party code that OSS cannot read, and the
surface that renders them (the board summary) is readable by viewers. Leaving the
role check to each panel meant one forgotten check exposed that panel's data to
every viewer, with nothing to notice it. Filtering before the call also keeps a
panel's queries and side effects from running for a caller who may not see it.
Failing closed on an undeclared value means a new panel is admin-only until its
author opts it in.

| Surface | Entry point | Enforced via |
|---|---|---|
| Board summary (REST) | `boards/views/analytics.py` `BoardAnalyticsMixin.summary` | `analytics_extensions_for_role(role)` with the role from `get_board_for_user`, before any panel is called |

No other surface calls the panels: `BoardAnalyticsMixin.analytics`, MCP, the
WebSocket consumers, the public share link and board export do not render them.
A new surface that does is added to this table and calls the same function.

Coverage: `boards/tests/test_analytics_panel_min_role_1826.py` (the role matrix
with call counts, owner, all-content access, group-inherited and overridden
roles, non-member `404`, unset and invalid `min_role`, and
`AnalyticsExtensionsEntryPointTests`, which scans the backend for any reference
to `ANALYTICS_EXTENSIONS` outside `boards/hooks.py` and `boards/permissions.py`).

## Rule 13: An invite never grants admin, and a shared link always expires

**Rule.** An invite link, shared or emailed, on a board or a group, cannot grant
the `admin` role and has an expiry of at most 30 days. A request for `admin` or
for no expiry is refused with `400`, not narrowed. Binding an emailed invite to
one address (#1678) does not make admin acceptable: a forwarded or misdirected
email still mints a group admin (#2006). The
limits are checked when a link is created. Group links created before the limits
applied were handled once by migration `groups/0023` (#1940): unused shareable
admin links were revoked and unused never-expiring ones were given a 7-day
expiry. A legacy link already expiring more than 30 days out keeps its expiry,
and `JoinGroupView` refuses any shareable admin link (#1727, #1940). An emailed
group admin invite minted before #2006 is not revoked by a migration; it is
refused at preview, join and registration instead (it expires within 30 days).

**Why.** A shareable link is a bearer credential: it can be forwarded or pasted
anywhere, and whoever holds it gets its grant. A group admin is board admin on
every board in the group's subtree, so an admin link that never expires is a
standing, transferable grant of that whole subtree. Group admin is granted by changing a member's role, never by invite; expiry
bounds how long a leaked link is useful.

| Surface | Entry point | Enforced via |
|---|---|---|
| Board invite link create (REST) | `boards/views/invites.py` `BoardInviteLinksMixin.invite_links` (POST) | `boards/serializers.py` `BoardInviteLinkCreateSerializer`: `role` is a `ChoiceField` without `admin`, `expiry_days` is a required `ChoiceField` over `BOARD_INVITE_EXPIRY_DAYS` (1, 7, 30); `boards/models.py` `BoardInviteLink.generate` repeats the role check against `GRANTABLE_ROLES` |
| Board emailed invite (REST) | `boards/views/invites.py` `BoardInviteLinksMixin.invite_link_send` | `boards/serializers.py` `BoardInviteLinkEmailSerializer`: no `admin`; `expiry_days` over `BOARD_INVITE_EXPIRY_DAYS`, default 7 |
| Group invite link create (REST) | `groups/views.py` `GroupViewSet.invite_links` (POST) | `groups/serializers.py` `GroupInviteLinkCreateSerializer`: `role` over `GROUP_INVITE_LINK_ROLE_CHOICES` (no `admin`); `expiry_days` an integer from 1 to `GROUP_INVITE_LINK_MAX_EXPIRY_DAYS` (30), default `GROUP_INVITE_LINK_DEFAULT_EXPIRY_DAYS` (7), `null` refused; the view always sets `expires_at`; `groups/models.py` `GroupInviteLink.generate` refuses `admin` on a shareable link (`delivery` `link`) for any other caller |
| Group emailed invite (REST) | `groups/views.py` `GroupViewSet.invite_link_send` | `groups/serializers.py` `GroupInviteLinkEmailSerializer`: `role` over `GROUP_INVITE_LINK_ROLE_CHOICES` (no `admin`, #2006); `expiry_days` from 1 to `GROUP_INVITE_EMAIL_MAX_EXPIRY_DAYS` (30), default 7; `groups/models.py` `GroupInviteLink.generate` refuses `admin` for any delivery, and an emailed invite without an address |
| Group admin invite redemption (REST) | `groups/views.py` `JoinGroupView.get` (preview), `JoinGroupView.post` (join) | Both refuse any link with role `admin`, shareable or emailed, with `404`, the same as a revoked link, so one reactivated, written by a script or emailed before #2006 grants nothing (#1940, #2006). Migration `groups/0023` revokes the shareable ones that existed at upgrade |
| Group admin invite redemption (registration) | `groups/invite_registration.py` `group_link_registration_refusal` (validation, and the grant at email confirmation) | An `admin` role answers `invite_invalid`, so a pre-#2006 emailed admin invite cannot create an account into the group either (#2006) |
| Changing an existing link | none | No route updates a board or group invite link: the group routes are `GET`/`POST` `invite-links/` and `DELETE` `invite-links/{link_id}/`, and the board routes are the same; `PATCH` and `PUT` answer `405`. Neither model is registered in the Django admin |
| Seeded data | `boards/management/commands/seed_demo_data.py` (the demo group's link) | Created with the `member` role and a 30-day expiry |
| MCP, WebSocket, import | none | No tool, consumer or import format creates an invite link |

Site invite links (`accounts/admin_views.py` `InviteLinkCreateSerializer`) are
not covered: they grant no board or group role, only registration, and only a
site admin creates them.

Coverage: `groups/tests/test_group_invite_link_limits_1727.py` (admin refused on
a shareable group link and in `generate`, emailed `admin` refused with `400` and nothing minted or sent, member still works, a pre-#2006 emailed admin invite refused at join, preview and registration, explicit `null`,
over-30, zero and negative expiry refused, omitted expiry defaults to 7 days,
`PATCH`/`PUT` answer `405`, a pre-existing shareable admin link is refused at
join and preview with `404`), `groups/tests/test_group_invite_legacy_link_revoke_1940.py` and
`groups/tests/test_group_invite_legacy_link_revoke_executor_1940.py` (migration
`groups/0023` revokes unused shareable admin links and caps never-expiring
ones, directly and under `migrate`), `groups/tests/test_groups.py`
(`test_all_invite_link_roles_can_be_created`),
`boards/tests/test_board_invites.py` (the board create serializer),
`boards/tests/test_seed_demo_data.py`
(`test_demo_group_has_label_and_invite_link`).

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
   `boards/tests/test_import_user_scope.py` covers it. Rule 6 is not in that
   position: its API surfaces are several call sites of a shared check
   (`_require_group_admin`, directly or through
   `resolve_group_for_board_placement`), so the test finds every function that
   writes `Board.group` and requires it to call the check or be allowlisted.
   The Django admin form is a separate, staff-only exception.
6. Keep gap tracking out of this page. A surface that needs work is an issue,
   not a row annotation.

When a change adds a new transport or entry point, add it to the table of every
rule that applies to it in the same change.
