# Which function each entry point calls to enforce a security rule
<a id="authorization-entry-points"></a>

A new view, consumer, or transport calls the shared function for each rule that applies to it, and a CI test fails if it doesn't.

**Why it matters:** Visiban can be reached over several transports: the REST API, the MCP server, the board and group WebSocket consumers, invite links and the allauth OAuth adapter. Some security rules apply on all of them, so this page says what to call before you merge.

**Go deeper:** The rules themselves, and the surfaces each one covers, are in the [Security Invariants Registry](security-invariants.md). This page covers the code you call to apply them.

## Why one function per rule

Each rule has one definition in `backend/visiban/authorization.py`. Every entry point calls it, and `backend/accounts/tests/test_auth_entry_points.py` fails CI when an entry point doesn't.

**Why it matters:** Each rule used to be written again on every transport. A fix to one copy left the other copies unfixed, and a reviewer found each gap only by happening to look at the other transport.

## The shared functions

| Rule | Function | Called from |
|---|---|---|
| Account state (Rule 1): inactive, or a forced password or username change pending | `authorize_account(user)` returns a bool; `account_state_denial(user)` returns the refusing `AccountGate` (with its `message` and `code`) or `None` | WebSocket handshake (`BoardConsumer.connect`, `GroupConsumer.connect`); WebSocket re-check (`accounts/ws_auth.py` `load_live_ws_user`); MCP (`mcp_server/auth.py` `_enforce_account_state`); OAuth connect (`SocialRegistrationAdapter.pre_social_login`, connect branch) |
| Account state, one gate at a time | The `AccountGate` objects `INACTIVE`, `PENDING_PASSWORD_CHANGE`, `PENDING_USERNAME_CHANGE` | REST permission classes `MustNotHavePendingPasswordChange` and `MustNotHavePendingUsernameChange` (each holds its gate as `gate`); `PATAuthentication` through `resolve_personal_access_token` (`INACTIVE`); WebSocket ticket redemption `_resolve_ticket_user` (`INACTIVE`) |
| Active principal | `principal_is_active(user)` | Every gate above; the OAuth adapter's existing-account match (`_handle_email_collision`); the board, group and site invite creator rules (`sender_may_admit_accounts`) |
| Invite creator standing (Rule 2) | `invite_creator_is_valid(link, board=None)` | `JoinBoardView.get` and `.post`; `JoinGroupView.get` and `.post`; registration through a board or group invite (`_sender_still_admits` in `boards/invites.py` and `groups/invite_registration.py`); registration through a site invite (`accounts/invite_utils.py` `validate_invite_token`), and the admin site invite list and caps (`effective_site_invite_status`, `live_site_invite_count`) |
| Who may admit new accounts | `sender_may_admit_accounts(sender)` | Registration through a board or group invite, before `invite_creator_is_valid`; the site invite creator rule (`accounts/invite_utils.py` `site_invite_creator_admits`) |
| Current role on a board or group (Rule 2) | `boards.permissions.get_board_role`, `groups.models.user_has_group_access` | REST, MCP tools, both consumers' handshake and re-check |
| Consume-once registration tokens (Rule 4) | `accounts.registration_tokens.registration_token_kind` (unchanged) | `InviteRegisterView`, `SocialRegistrationAdapter.save_user` |
| Placing a board in a group (Rule 6) | `groups/views.py` `_require_group_admin`; `resolve_group_for_board_placement` (move group and JSON, CSV and Trello import) | Every function in the installed apps that writes `Board.group` (an attribute assignment, or `group=` passed to `Board` create or to `.save()` and `.update()`) must call the shared check or be in `GROUP_PLACEMENT_ALLOWLIST` with a reason; every writable `group` field on a `Board` serializer must have a `validate_group` that reaches `_require_group_admin`; the wrappers are pinned in `GROUP_PLACEMENT_PINS`. Per-surface role behavior is covered by `groups/tests/test_groups.py`, `boards/tests/test_board_group_field_validation.py` and `boards/tests/test_group_placement_roles.py` |
| Import user scoping (Rule 5) | `boards/services/trello_import.py` `visible_users` (unchanged); JSON and CSV reach it through `boards/views/import_export.py` `_resolve_import_users` | `BoardImportExportMixin` only. Intentionally outside the enumeration test: it's already one shared function, and every import format enters through the one mixin, so there's no second transport for a copy to drift on. `boards/tests/test_import_user_scope.py` covers it |

The session-based HTML surfaces, allauth's pages under `/accounts/` and the
Django admin under `/admin/`, run no DRF permission class. For an authenticated
account they apply the forced-change gates through
`visiban/middleware.py` `PendingAccountActionMiddleware`, which calls
`account_state_denial(user, ...)` limited to `FORCED_CHANGE_GATES` (an inactive
account's session already resolves to an anonymous user). The enumeration test
checks that every routed top-level path segment is either one of that
middleware's gated prefixes or listed in `NOT_SESSION_HTML` with a reason, so a
new top-level HTML mount is reported until someone decides. It gives every
route under the gated prefixes a forced-change decision in
`FORCED_CHANGE_ROUTE_DECISIONS`, either `gated` or `exempt: <reason>`, and
checks the middleware's answer for each pending flag: a gated route redirects
GET to `FRONTEND_URL` and refuses POST with 403, an exempt one reaches its
view. Django admin site views are `gated` by rule, with `admin/logout/` the
recorded exception, and each of their routes is exercised too. A new route
with no decision, a decision the middleware doesn't keep, and a decision for a
route that no longer exists all fail the test. An installed extension package
gates its own session-based HTML prefixes through the setting
`PENDING_ACTION_EXTRA_GATED_PREFIXES` and exempts its own views through
`PENDING_ACTION_EXTRA_EXEMPT_VIEWS` (see [Enterprise](#enterprise)).

**Which views may be exempt.** The middleware decides on the view the path
resolves to (`PENDING_ACTION_EXEMPT_VIEWS`, by URL name, or by dotted view path
for an unnamed route), never on the shape of the path. A view qualifies only
when an anonymous visitor reaches it with the same effect, so a pending session
gains nothing a signed-out browser doesn't have (logout, the password-reset
pages, the email-confirmation redirect, static result pages), or when it
applies the forced-change gate itself: the SSO login and callback of each
installed provider qualify because `SocialRegistrationAdapter.pre_social_login`
refuses a `process=connect` callback for an inactive account or one with a pending change. A view that changes
the signed-in account (email addresses, connected providers, passwords) is
never exempt.

The admission rule above is documented policy. The code enforces a subset (`visiban.middleware.oss_gated_view_names`). The middleware ignores, and system check `accounts.E007` reports, a `PENDING_ACTION_EXTRA_EXEMPT_VIEWS` entry that names, other than a view already exempt in OSS,

- any view that can serve a path under the built-in `/accounts/` or `/admin/`
  prefixes, whoever mounted it (including admin model views whose routes take
  arguments); or
- any OSS view that can serve a path under a `PENDING_ACTION_EXTRA_GATED_PREFIXES`
  entry.

"Can serve" is decided on each URL pattern's matching rules, not on its printed route (#1593). All of these count:

- a regex alternation such as `^(?:accounts|admin)/`,
- a leading converter such as `<str:section>/` (which can be `accounts`),
- a `path` converter, and
- an unanchored regex (Django applies it with `search()`).

A route whose reach the walk can't bound (a regex that would have to match past the end of the gated prefix, a custom converter, an unknown pattern class such as `LocalePrefixPattern`) is counted. The check fails safe and may reject a name that couldn't in fact reach a gated path; rename that URL.

**Extension routes.** An extension's own views are the top-level patterns the root URLconf took from its extension point: `visiban/urls.py` keeps them in `extension_urlpatterns` (filled from `enterprise.urls.enterprise_urlpatterns`).

- Those count only under the built-in prefixes, so an extension can exempt its own view under its own prefix.
- A root URLconf without `extension_urlpatterns` (a project that replaces `ROOT_URLCONF` instead of using the extension point) marks every route as OSS. Such a project must declare `extension_urlpatterns` in its root module for its own views under an extra prefix to be exemptible.
- Extension routes are identified by object identity: a top-level pattern counts as the extension's own only if it's the same object listed in `enterprise_urlpatterns` (and so in `extension_urlpatterns`). An extension must register the pattern objects it exposes.
- Wrapping or copying them, or listing an OSS pattern object in `enterprise_urlpatterns`, mislabels routes. An OSS `include()` wrapped inside an extension's own include is treated as extension routes in full.
- A literal endpoint regex without an end anchor (`^acc`) is matched with `search()` by Django and so counts as open-ended: it can serve `/accounts/x`.

REST keeps DRF permission classes. They evaluate the same gate objects as the
other transports, one gate per class, so that an endpoint a pending user must
reach to clear the flag (for example `ChooseUsernameView`) can leave out exactly
one gate.

## Adding an entry point

**A REST view.** Do nothing. A view that keeps `DEFAULT_PERMISSION_CLASSES`
gets both forced-change gates. If the view declares its own
`permission_classes`, include `MustNotHavePendingPasswordChange` and
`MustNotHavePendingUsernameChange` in the list. If the view must serve
a user who hasn't authenticated, or one with a pending change, add it to
`REST_GATE_ALLOWLIST` in the test with a one-line reason and the exact routes
it's mounted at. To exempt only one method, use the key `"module.View:GET"`.
An entry covers only the routes it lists, so mounting the same view somewhere
new needs a new decision. A route ending in `*` is a prefix: `accounts/oidc/*`
covers every route under `accounts/oidc/`. A bare `*` (or `/*`), which would
cover every mount, is refused, and so is an entry with no reason or no routes.
An entry marked `optional` may match nothing, for a view that exists only in
some configurations; it's never reported as stale, whether its routes are
exact or prefixes.

**A non-DRF Django view.** No DRF permission class runs on it. Write a DRF
view instead, or add it to `NON_DRF_ALLOWLIST` with a reason and its routes.
Mount it under `/accounts/` or `/admin/` so `PendingAccountActionMiddleware`
applies the forced-change gates, and record its decision in
`FORCED_CHANGE_ROUTE_DECISIONS` (an exemption also needs its view name in
`PENDING_ACTION_EXEMPT_VIEWS` and must meet the rule above); a new top-level
path segment fails the test until it's added to the middleware's prefixes or
to `NOT_SESSION_HTML`.
Entries name exact view classes, not modules, so a view that a new allauth
release adds is reported until someone reviews it. Views served by
`django.contrib.admin.site` itself are recognized per view (they require an
active staff session); a view merely mounted under an `admin` namespace isn't.

**A new DRF authentication class.** The REST inactive-account gate is applied
by the authentication classes, so the test accepts only the ones in
`ACTIVE_CHECKING_AUTHENTICATORS`. Check that the new class refuses an inactive
user, then add it to that list.

**A WebSocket consumer.** In `connect`, refuse an unauthenticated scope or one
with no recorded credential (4001). Then call `authorize_account(user)` before
any database lookup, and close with 4003 when it returns false. Don't pass
`exempt`: the handshake has no forced-change flow. Run the
periodic access re-check through `load_live_ws_user(self.scope)`. The test
opens a socket to every consumer routed by `visiban.asgi.application`,
including enterprise patterns, and fails if the handshake doesn't consult the
shared gates.

**An MCP tool.** Do nothing. Tools are reachable only through the mounted MCP
app, and `BearerAuthMiddleware` wraps that app and applies the gates to every
request. A new MCP *transport* must be wrapped in `BearerAuthMiddleware`.

**An invite link kind.** A model with a `token_hash` and a `created_by` field
is treated as an invite link. Register its creator rule in
`INVITE_CREATOR_RULES` (`invite_creator_is_valid` dispatches through that
table), and call `invite_creator_is_valid` at preview and at redemption. Claim the token atomically under a lock (Rule 4).

**An allauth hook.** Override it on `RegistrationAdapter` or
`SocialRegistrationAdapter`. Don't rely on allauth's default. The test checks
that the configured adapters are the project's own classes and that they
override the signup hooks. `RegistrationAdapter.set_password` is such a hook: allauth's
change, set and reset-from-key flows store the password through it, and it saves the
password and runs `finalize_password_change` in one transaction.

## How the enforcement test finds entry points

The test discovers entry points from the running configuration. It keeps no list of them, so a new entry point is checked without anyone adding it:

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
  exempted and the socket wasn't accepted. The test also parses each
  consumer's source (and its project base classes) and requires a call to
  `load_live_ws_user` for its re-check; a mention in a comment doesn't count.
- **MCP:** calls the transport's `_authenticate_and_authorize` with the spy in
  place. When the MCP SDK is installed, it also checks that the mounted app is
  wrapped in `BearerAuthMiddleware`.
- **Invites:** lists every installed model that has `token_hash` and
  `created_by`. It then parses every non-test module of the installed apps and
  finds each function that looks one of those models up by its token
  (`lookup_by_token`, `_hash_token`, or a `token_hash=` filter). Each one must
  call `invite_creator_is_valid` or a registration refusal function, unless its
  model is a documented exception.
- **Pinned call sites:** `REQUIRED_SHARED_CALLS` names the join views, the
  registration refusal functions, `_sender_still_admits` and the OAuth
  adapter's `_handle_email_collision`, with the shared calls each must make.
  The registration paths must call `registration_token_kind`. All of these are
  checked as real calls in the parsed source, so a mention in a comment does
  not count.

Each checker also has a negative test: a synthetic view, viewset action, consumer, authenticator or invite model that skips the shared check must be reported. This proves the checker can fail.

**The allowlists can't go stale.** A view and route pair that matches no discovered entry point fails the test, and so does an allowlisted view that already applies both gates. Entries for views that exist only in some configurations (an OIDC provider installed only when its settings are present) are marked optional.

## Advisory copies of the creator rule

A few places restate part of the invite creator rule inline instead of calling the shared function. They aren't entry points. None of them decides whether a link admits anyone, so a drift there can't grant access: registration and joining re-check through the shared functions, under the invite's row lock.

| Location | What it's | Why it isn't routed through the shared function |
|---|---|---|
| `boards/invites.py` `board_link_can_register_cheap` | The `can_register` label on the site-admin invite list | Query-free on purpose: the list spans every board, and resolving each sender's role per row would cost a query per (board, sender) pair. Advisory only |
| `boards/invites.py` `board_link_registration_refusal`, `groups/invite_registration.py` `group_link_registration_refusal` (the "not for registration" branch) | Classifies the link kind to pick a refusal code | The authorization decision in the same function is `_sender_still_admits`, which calls `sender_may_admit_accounts` and `invite_creator_is_valid` |
| `groups/views.py` `_revoke_lapsed_admin_invite_links` | Revokes a demoted admin's unused links | Revocation housekeeping in bulk; a link it misses is still refused at preview and join by `invite_creator_is_valid` |

Each site has a comment pointing at the shared function.

## Enterprise

The test also runs in the enterprise mirror. Enterprise URL patterns and
WebSocket routes registered through the extension points are discovered and
checked like OSS ones.

Enterprise records its own exceptions without editing the OSS test, through an
optional module, `enterprise.auth_entry_point_allowlist`. The test imports it
when it's installed and skips it when it isn't. The module may define:

- `REST_GATE_ALLOWLIST` and `NON_DRF_ALLOWLIST`: dicts keyed like the OSS ones
  (`"module.View"` or `"module.View:GET"`). Each value is a dict
  `{"reason": "...", "routes": ["api/v1/..."], "optional": False}`, so the
  module doesn't have to import the test.
- `NOT_SESSION_HTML`: a dict of top-level URL segment to reason, for segments
  that serve no session-based HTML (for example a DRF-only `scim`). Single
  segments only, a reason is required, and an OSS segment can't be redefined.
- `PENDING_ACTION_EXTRA_GATED_PREFIXES`: the extension's session-based HTML
  prefixes (for example `("/sso/",)`). This declares them for the test only;
  the middleware gates a prefix when it's in the Django setting
  `PENDING_ACTION_EXTRA_GATED_PREFIXES` (default `()`), so the enterprise
  settings include must set that too. The test fails for a declared prefix the
  setting doesn't contain.
- `FORCED_CHANGE_ROUTE_DECISIONS`: a dict of route to `"gated"` or
  `"exempt: <reason>"` for the extension's routes under the extension's own
  gated prefix. An exempt route's view name must be in the Django setting
  `PENDING_ACTION_EXTRA_EXEMPT_VIEWS` (default `()`; exact view names only,
  checked by `accounts.E006` and `accounts.E007`), which is what the middleware
  reads. Views under `/accounts/` and `/admin/`, and OSS views under the
  extension's prefix, can't be exempted by this setting; the extension's own
  views are the routes it adds through `enterprise_urlpatterns`. The route must
  meet the rule under "Which views may be exempt" above. An
  OSS route can't be redefined.
- `ACTIVE_CHECKING_AUTHENTICATORS`: a tuple of additional authenticator classes
  that refuse inactive accounts. Each must be a concrete DRF authenticator:
  `BaseAuthentication` itself, a subclass that doesn't implement
  `authenticate`, or anything that isn't a class is refused, because it would
  make the check accept every authenticator.

The entries are merged with the OSS lists, validated by the same rules as the
OSS entries (a reason, at least one route, no bare `*`), and get the same
checks, including the stale-entry check. An entry that repeats an OSS key fails the test: the
module adds decisions, it doesn't override OSS ones.

## Feature-flagged routes

The Issue Board Lens views are mounted only with `GIT_LENS_ENABLED`. The main backend CI job runs with the flag off, so the `backend-test-git-lens` job also runs this test with the flag on, and the lens views are enumerated there. The allowlists contain no flag-dependent entries, so the stale-entry check passes either way.

## How the group-placement scan finds them

`GroupPlacementEntryPointTests` parses every non-test module of the installed
apps with `ast` and reports each function that assigns `.group` or `.group_id`,
passes `group=` to a `Board` create or to `.save()` / `.update()`, or calls the
reverse manager `.boards.add`, `.boards.set` or `.boards.create`. Each reported
function must call `_require_group_admin`, `resolve_group_for_board_placement`,
`_check_group_change` or `_resolve_import_group`, or be listed in
`GROUP_PLACEMENT_ALLOWLIST` with a reason. A runtime pass also requires every
writable `group` field on a `Board` serializer to validate through the check.
The scan is syntactic and presence-only; it misses `setattr`, `**kwargs`
create or update, `bulk_update` and `save(update_fields=["group"])`.
