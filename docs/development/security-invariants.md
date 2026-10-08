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

## How to read a rule

Each rule has a statement, the reason it exists, and a table:

| Column | Meaning |
|---|---|
| Surface | The transport or flow through which the rule can be reached |
| Entry point | The file and function (or class) where a request on that surface starts |
| Enforced via | The code that applies the rule on that surface today |

Entry points use file and function names, not line numbers, so the table
survives edits. Paths are relative to `backend/`. The enumeration test
planned in #1517 consumes the same surface list as these tables, so a surface
added here is a surface that test must cover.

## Rule 1: Account-state gates apply to every transport

**Rule.** An account with a forced change pending (`must_change_password`,
`must_change_username`) or that is inactive is refused on every transport, not
only REST.

**Why.** The gates are easy to add as DRF permission classes and forget
everywhere else. A client that cannot call REST should not be able to read or
write the same data over MCP, a socket, an invite link or an import.

| Surface | Entry point | Enforced via |
|---|---|---|
| REST | `visiban/settings.py` `REST_FRAMEWORK["DEFAULT_PERMISSION_CLASSES"]` | `visiban.permissions.MustNotHavePendingPasswordChange`, `MustNotHavePendingUsernameChange`; views that set their own `permission_classes` repeat them (for example `boards/views/boards.py` `BoardViewSet`, `boards/views/invites.py` `JoinBoardView`) |
| REST authentication | `accounts/authentication.py` `PATAuthentication` | `resolve_personal_access_token` rejects a PAT whose user is inactive; Django's `ModelBackend` rejects inactive session users |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware` | `_authenticate_and_authorize` calls `_enforce_account_state`, which reuses the REST permission classes |
| WebSocket ticket | `accounts/views.py` `WSTicketView` | REST default permission classes on the ticket endpoint; `accounts/ws_auth.py` `_resolve_ticket_user` rejects inactive users |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer.connect` | `accounts/ws_auth.py` `load_live_ws_user` |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer.connect` | `accounts/ws_auth.py` `load_live_ws_user` |
| Invite link redemption | `boards/views/invites.py` `JoinBoardView`; `groups/views.py` `JoinGroupView` | Permission classes on the POST (same gates as REST) |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin.import_board`, `import_trello` | Served by `BoardViewSet`, so the REST default permission classes |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter.pre_social_login`, `save_user` | Login-time flow; no pending-change state exists before the account does |
| Admin actions | `accounts/admin_views.py` `AdminUserDetailView`, `AdminUserDeactivateView` | `_ADMIN_PERMISSIONS` |

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
| Personal access tokens | `accounts/admin_views.py` `AdminUserDeactivateView._revoke_invite_links` | Deletes the user's PATs on deactivation (shared by the deactivate endpoint and `PATCH is_active=false`) |
| MCP | `mcp_server/auth.py` `BearerAuthMiddleware`; `mcp_server/tools.py` | `resolve_personal_access_token` rejects inactive users; tools resolve the role with `get_board_role` |
| WebSocket (board) | `boards/consumers.py` `BoardConsumer` | Periodic and per-frame re-check through `_refresh_role`, `_lookup_role` and `accounts/ws_auth.py` `load_live_ws_user` |
| WebSocket (group) | `groups/consumers.py` `GroupConsumer` | Periodic re-check through `_refresh_access`, `_has_access` and `load_live_ws_user` |
| Invite links | `boards/invites.py` `sender_is_board_admin`; `groups/invite_registration.py` `_sender_still_admits`; `groups/views.py` `sender_is_group_admin` | Sender's current standing re-checked at preview and redemption |
| Invite links (revocation) | `groups/views.py` `_revoke_lapsed_admin_invite_links`; `accounts/admin_views.py` `AdminUserDeactivateView._revoke_invite_links` | Pending links revoked when the creator is deactivated or loses admin rights |
| JSON, CSV and Trello import | `boards/views/import_export.py` `BoardImportExportMixin` | Runs as an authenticated REST request, so role is read from current state |
| OAuth signup | `accounts/adapter.py` `SocialRegistrationAdapter` | Existing-account matching in `_handle_email_collision` considers active users only |
| Admin actions | `accounts/admin_views.py` `AdminUserDetailView.patch`, `AdminUserDeactivateView.post` | Deactivation revokes tokens and invites in the same operation |

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
| Session | Django session (`SessionAuthentication`) | Logout, password change (session auth hash), deactivation (`ModelBackend` rejects inactive users) |
| Personal access token | `accounts/models.py` `PersonalAccessToken`; `accounts/authentication.py` `resolve_personal_access_token` | Explicit delete (`PersonalAccessTokenDeleteView`), expiry (`pat_is_expired`), deactivation (`_revoke_invite_links`), password change (`accounts/views.py` `TokenRevokingPasswordChangeView`) |
| WebSocket ticket | `accounts/ws_auth.py` `issue_ws_ticket`, `consume_ws_ticket` | Single use and `WS_TICKET_TTL` expiry; refused if the minting credential is already revoked |
| Open WebSocket | `accounts/ws_auth.py` `ws_credential_is_live`, `load_live_ws_user` | Recorded credential no longer live, password changed since handshake, account inactive, access lost (4003 at the next re-check) |
| Site invite link | `accounts/invite_utils.py` `validate_invite_token`, `consume_invite_token` | `revoked_at`, expiry, `used_at`, creator deactivation |
| Board invite link | `boards/views/invites.py` `JoinBoardView`; `boards/invites.py` `sender_is_board_admin` | `revoked_at`, `used_at`, sender no longer a board admin or deactivated |
| Group invite link | `groups/views.py` `JoinGroupView`; `groups/invite_registration.py` `_sender_still_admits` | `is_active`, `used_at`, sender no longer a group admin, site admin or active |
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
5. If the rule is checked by the enumeration test (#1517), make sure the test
   reads the same surface list. A surface listed here and not in the test, or the
   reverse, is a defect in one of the two.
6. Keep gap tracking out of this page. A surface that needs work is an issue,
   not a row annotation.

When a change adds a new transport or entry point, add it to the table of every
rule that applies to it in the same change.
