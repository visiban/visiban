# Authorization Entry Points

Visiban can be reached over several transports: the REST API, the MCP server,
the board and group WebSocket consumers, invite links and the allauth OAuth
adapter. Some security rules apply on all of them. This page says which shared
function each entry point calls, and how the test that enforces it works, so a
new view, consumer or transport knows what to call before it merges.

The rules themselves, and the surfaces each one covers, are listed in the
[Security Invariants Registry](security-invariants.md). This page covers the
code you call to apply them.

## Why one function per rule

Each rule used to be written again on every transport. A fix to one copy then
left the other copies unfixed, and each gap was found only when a reviewer
happened to look at the other transport. Now each rule has one definition in
`backend/visiban/authorization.py`. Every entry point calls it, and
`backend/accounts/tests/test_auth_entry_points.py` fails CI when an entry point
does not.

## The shared functions

| Rule | Function | Called from |
|---|---|---|
| Account state (Rule 1): inactive, or a forced password or username change pending | `authorize_account(user)` returns a bool; `account_state_denial(user)` returns the refusing `AccountGate` (with its `message` and `code`) or `None` | WebSocket handshake (`BoardConsumer.connect`, `GroupConsumer.connect`); WebSocket re-check (`accounts/ws_auth.py` `load_live_ws_user`); MCP (`mcp_server/auth.py` `_enforce_account_state`) |
| Account state, one gate at a time | The `AccountGate` objects `INACTIVE`, `PENDING_PASSWORD_CHANGE`, `PENDING_USERNAME_CHANGE` | REST permission classes `MustNotHavePendingPasswordChange` and `MustNotHavePendingUsernameChange` (each holds its gate as `gate`); `PATAuthentication` through `resolve_personal_access_token` (`INACTIVE`); WebSocket ticket redemption `_resolve_ticket_user` (`INACTIVE`) |
| Active principal | `principal_is_active(user)` | Every gate above; the OAuth adapter's existing-account match (`_handle_email_collision`); the board and group invite creator rules |
| Invite creator standing (Rule 2) | `invite_creator_is_valid(link, board=None)` | `JoinBoardView.get` and `.post`; `JoinGroupView.get` and `.post`; registration through a board or group invite (`_sender_still_admits` in `boards/invites.py` and `groups/invite_registration.py`) |
| Who may admit new accounts | `sender_may_admit_accounts(sender)` | Registration through a board or group invite, before `invite_creator_is_valid` |
| Current role on a board or group (Rule 2) | `boards.permissions.get_board_role`, `groups.models.get_accessible_group_ids` (unchanged) | REST, MCP tools, both consumers' handshake and re-check |
| Consume-once registration tokens (Rule 4) | `accounts.registration_tokens.registration_token_kind` (unchanged) | `InviteRegisterView`, `SocialRegistrationAdapter.save_user` |

REST keeps DRF permission classes. They evaluate the same gate objects as the
other transports, one gate per class, so that an endpoint a pending user must
reach to clear the flag (for example `ChooseUsernameView`) can leave out exactly
one gate.

## Adding an entry point

**A REST view.** Do nothing. A view that keeps `DEFAULT_PERMISSION_CLASSES`
gets both forced-change gates. If the view declares its own
`permission_classes`, include `MustNotHavePendingPasswordChange` and
`MustNotHavePendingUsernameChange` in the list. If the view really must serve
a user who has not authenticated, or one with a pending change, add it to
`REST_GATE_ALLOWLIST` in the test with a one-line reason and the exact routes
it is mounted at. To exempt only one method, use the key `"module.View:GET"`.
An entry covers only the routes it lists, so mounting the same view somewhere
new needs a new decision.

**A non-DRF Django view.** No DRF permission class runs on it. Write a DRF
view instead, or add it to `NON_DRF_ALLOWLIST` with a reason and its routes.
Entries name exact view classes, not modules, so a view that a new allauth
release adds is reported until someone reviews it. Views served by
`django.contrib.admin.site` itself are recognized per view (they require an
active staff session); a view merely mounted under an `admin` namespace is not.

**A new DRF authentication class.** The REST inactive-account gate is applied
by the authentication classes, so the test accepts only the ones in
`ACTIVE_CHECKING_AUTHENTICATORS`. Check that the new class refuses an inactive
user, then add it to that list.

**A WebSocket consumer.** In `connect`, refuse an unauthenticated scope or one
with no recorded credential (4001). Then call `authorize_account(user)` before
any database lookup, and close with 4003 when it returns false. Do not pass
`exempt`: the handshake has no forced-change flow. Run the
periodic access re-check through `load_live_ws_user(self.scope)`. The test
opens a socket to every consumer routed by `visiban.asgi.application`,
including enterprise patterns, and fails if the handshake does not consult the
shared gates.

**An MCP tool.** Do nothing. Tools are reachable only through the mounted MCP
app, and `BearerAuthMiddleware` wraps that app and applies the gates to every
request. A new MCP *transport* must also be wrapped in `BearerAuthMiddleware`.

**An invite link kind.** A model with a `token_hash` and a `created_by` field
is treated as an invite link. Register its creator rule in
`INVITE_CREATOR_RULES` (`invite_creator_is_valid` dispatches through that
table), and call `invite_creator_is_valid` at preview and at redemption. Claim the token atomically under a lock (Rule 4).

**An allauth hook.** Override it on `RegistrationAdapter` or
`SocialRegistrationAdapter`. Do not rely on allauth's default. The test checks
that the configured adapters are the project's own classes and that they
override the signup hooks.

## How the enforcement test finds entry points

The test discovers entry points from the running configuration. It does not
keep a list of them, so a new entry point is checked without anyone adding it:

- **REST:** walks the root URL resolver. For each DRF view and each HTTP method
  it serves (each viewset action, plus `OPTIONS`), it builds the view and reads
  its effective `get_permissions()` and `get_authenticators()`. A
  `get_permissions()` override that changes by action is therefore checked as
  it runs. `A & B` counts the gates of both sides. `A | B` counts only the gates
  that both sides apply.
- **WebSocket:** walks `visiban.asgi.application`'s websocket middleware down to
  the `URLRouter` and opens a socket to each routed consumer. During that
  handshake, the shared gate evaluator is replaced by a spy that refuses
  everyone. A consumer passes when the spy saw the scope user with no gate
  exempted and the socket was not accepted. The test also parses each
  consumer's source (and its project base classes) and requires a call to
  `load_live_ws_user` for its re-check; a mention in a comment does not count.
- **MCP:** calls the transport's `_authenticate_and_authorize` with the spy in
  place. When the MCP SDK is installed, it also checks that the mounted app is
  wrapped in `BearerAuthMiddleware`.
- **Invites:** lists every installed model that has `token_hash` and
  `created_by`.

Each checker also has a negative test. A synthetic view, viewset action,
consumer, authenticator or invite model that skips the shared check must be
reported. This proves the checker can fail.

The allowlists cannot go stale. A view and route pair that matches no
discovered entry point fails the test, and so does an allowlisted view that
already applies both gates. Entries for views that exist only in some
configurations (an OIDC provider installed only when its settings are present)
are marked optional.

## Enterprise

The test also runs in the enterprise mirror. Enterprise URL patterns and
WebSocket routes registered through the extension points are discovered and
checked like OSS ones. An enterprise view that must be public needs an
allowlist entry, the same as an OSS view.
