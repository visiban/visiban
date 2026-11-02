<a id="open-core-boundary"></a>

# What is OSS and what is Enterprise

The OSS vs enterprise classification for every feature area where the boundary has been formally decided. This is the canonical reference — when a feature appears here, the ruling supersedes any informal discussion in issue comments.

**Guiding principle:** "Can a small team work together effectively without this?" If no → OSS core. If yes → enterprise candidate.

**Why it matters:** this page records each feature's classification and its rulings. Check the [Classification table](#classification-table) before building or documenting anything that might be Enterprise.

**Go deeper:** [Detailed rulings](#detailed-rulings) for split features, [OSS extension points](#oss-extension-points-implementation-status) for what Enterprise plugs into.

---

## Classification table

| Feature | Classification | Rationale summary | Issue |
|---|---|---|---|
| Username/password login | OSS | Authentication prerequisite | — |
| Google OAuth | OSS | Existing stack | — |
| GitHub OAuth | OSS | Existing stack | — |
| GitLab OAuth | OSS | Existing stack | — |
| OIDC authentication (generic) | OSS | Extension of existing OAuth stack; no new dependency | #349 |
| SSO / SAML | Enterprise | See OIDC vs SAML ruling below | — |
| Card-level activity (CardMovement) | OSS | Core collaborative feature — teams need their own card history | — |
| AdminActionLog (instance admin control-plane actions) | OSS | Fixed, narrow record of a closed set of admin toggles (maintenance mode, registration mode, uploads, email config); no configurable retention or SIEM export. See [Audit log (split)](#audit-log-split) | #1126 |
| BoardExportLog (board export history) | OSS | Fixed, narrow record of successful board exports (actor, role, format, row count); no configurable retention or SIEM export. See [Audit log (split)](#audit-log-split) | #842 |
| Issue Board Lens (read-only GitHub/GitLab issue board) | OSS | A small team's own visibility into the external GitHub/GitLab work it tracks outside Visiban; `GIT_LENS_ENABLED`-gated, read-only, no write-back to the provider. See [Issue Board Lens](#issue-board-lens-oss) below | #1062 |
| MCP server (AI agent tool/resource access) | OSS | Core team-automation surface — the tools, resources, and Bearer-token auth a small team needs to let its own AI agents read and act on boards. See [MCP server](#mcp-server-oss-vs-mcp-enterprise-upgrade-enterprise) below | #511 |
| System-wide compliance audit log | Enterprise | Compliance tooling; card-level history in OSS is sufficient for small teams | #350→enterprise |
| Hard WIP enforcement | OSS | Core Kanban mechanism; soft-only enforcement does not work | #344 |
| Outgoing webhooks (per-board, signed, best-effort) | OSS (planned, not yet implemented; open in #863, milestone 1.3) | Minimum integration surface for a team tool; delivered from the change feed with no task queue. Reversed from Enterprise on 2026-04-15 | #863 |
| Webhook operations layer (guaranteed delivery, delivery log + replay, account-wide subscriptions, delivery audit) | Enterprise | Reliability and support tooling for hosted and large operators; basic webhooks work without it | enterprise #44 |
| Saved filters per user per board | OSS | Basic productivity feature for boards with many swimlanes | #343 |
| Movement history search + filter view | OSS | Teams need to query their own audit trail | #342 |
| Movement history delivery report export (CSV/PDF) | Enterprise | Formatted compliance/client reporting artifact | #342 note |
| Per-swimlane analytics (basic) | OSS | Teams managing work per client/swimlane need row-level visibility | #341 |
| Advanced analytics (velocity trends, CFD, exports) | Enterprise | Beyond basic visibility; serves analytics/compliance buyers | #341 note |
| Single-swimlane focus mode | OSS | Core navigation for boards with many swimlanes | #340 |
| Read-only board share / guest link (basic) | OSS | Sharing status with external stakeholders is a basic collaboration need | #348 |
| Branded client portal / custom-domain share | Enterprise | White-label extension of base share link | #348 note |
| User offboarding flow (deactivate + transfer) | OSS | Basic team membership management | #347 |
| Invite link controls (expiry, single-use, revoke) | OSS | Basic security hygiene for any team onboarding members | #346 |
| External ref field on Card (PR/issue link) | OSS | Basic workflow data field; Phase 1 of GitHub/GitLab integration | #352 Phase 1 |
| Auto PR-to-card link from commits/PRs | OSS | Superseded #352 Phase 2 once outgoing webhooks stopped being Enterprise; rescoped as a per-board *inbound* webhook from the git provider. The auto-transition-on-merge slice still needs an enterprise-check before build (see #857) | #857 |
| URL filter state persistence (bookmarkable views) | OSS | Basic navigation feature for all users | #353 OSS portion |
| Filtered share link for external clients | Enterprise | Combines base share token with filter state; guest-link layer | #353 enterprise portion |
| Dark/light mode theme toggle | OSS | Basic accessibility; per-user preference | #355 |
| Org-enforced theme policy (white-label) | Enterprise | Org-level branding control | — |
| Transactional email notifications (SMTP) | OSS | Core async-team collaboration; teams with absent members need email delivery | #356 |
| External channel delivery (Slack, Teams) | Enterprise | Third-party service integrations | enterprise #34 |
| Inbound card creation via email | Enterprise | Integration concern; teams can create cards directly | enterprise #1 |
| PATs (user-tied, full-access) | OSS | Machine credentials for CI/CD | — |
| Service account tokens (board-scoped, read-only/write) | Enterprise | Strict security policy orgs; small teams work around it with PATs | enterprise #17 |
| SAML 2.0 / ADFS | Enterprise | Separate library; enterprise identity buyers | enterprise #4 |
| SCIM directory sync / JIT provisioning | Enterprise | Identity management at scale; invite links cover OSS onboarding | #714 |
| Automation rules (if/then triggers) | Enterprise | Advanced automation; small teams work without it | enterprise #69 |
| IP allowlisting | Enterprise | Organization-scale access control | enterprise #7 |
| Custom RBAC roles | Enterprise | Granular permissions beyond admin/member/viewer | enterprise #6 |
| SLA tracking and aging alerts | Enterprise | Advanced time-tracking; small teams use cycle time data in OSS | enterprise #10 |
| Recurring cards | Enterprise | Automation concern | enterprise #11 |
| Advanced analytics (cycle time dists, CFD) | Enterprise | Beyond OSS basic analytics | enterprise #12 |
| Scheduled report emails | Enterprise | Automated digest delivery | enterprise #13 |
| Custom dashboards (multi-board widgets) | Enterprise | Advanced cross-board visibility | enterprise #14 |
| Slack/Teams notifications | Enterprise | Third-party integrations | enterprise #16 |
| Board template visual editor | Enterprise | Basic template creation via API/admin, or installed-package registration (see `TEMPLATE_PROVIDERS`, #1115), is sufficient for OSS | enterprise #3 |
| Data retention policies (auto-delete/archive) | Enterprise | Compliance/legal-hold tooling; manual archiving is OSS | enterprise #19 |
| Multi-tenancy / organization management | Enterprise | Multiple groups under one billing entity | enterprise #21 |
| Usage quotas and plan limits | Enterprise | SaaS tier management | enterprise #22 |
| White-labeling | Enterprise | Custom branding | enterprise #23 |
| Guided multi-source migration wizard (visual import-from-external-tools UI) | Enterprise | Migration tooling for onboarding at scale. The import endpoints and formats themselves (Trello, JSON, CSV) are OSS: see [Board import (OSS) vs migration wizard (Enterprise)](#board-import-oss-vs-migration-wizard-enterprise) | enterprise #24 |
| Form engine for card intake | Enterprise | Borderline; revisit if intake teams are a common OSS persona | enterprise #32 |
| Google Calendar integration | Enterprise | External service | enterprise #2 |

---

## Detailed rulings

### OIDC authentication (OSS) vs SAML / SCIM (Enterprise)

**Decided — #714.** Generic OIDC via `allauth.socialaccount.providers.openid_connect` is OSS. It extends the Google/GitHub/GitLab OAuth stack already in the codebase, and `django-allauth` is already a dependency, so no new package is needed. Confirmed as the right boundary before 1.0: removing it post-1.0 would be a breaking API change.

SAML and ADFS need a separate library (e.g. `python3-saml` or `djangosaml2`) and serve organizations with centralized IdP-managed identity. SCIM 2.0 directory sync and JIT provisioning are the other enterprise identity differentiators: they automate account lifecycle at scale, which invite-link onboarding covers for small teams in OSS.

| Method | Classification | Status | Library |
|---|---|---|---|
| Google OAuth | OSS | Shipped | `allauth` (already present) |
| GitHub OAuth | OSS | Shipped | `allauth` (already present) |
| GitLab OAuth | OSS | Shipped | `allauth` (already present) |
| Generic OIDC | OSS | Shipped | `allauth` (already present) |
| SAML 2.0 / ADFS | Enterprise | Planned | separate library required |
| SCIM directory sync / JIT | Enterprise | Planned | separate library required |

> **OIDC note.** The configuration plumbing (env vars, provider registration, settings guard) is implemented and unit-tested. CI validates the end-to-end login flow against Keycloak. Other providers (Okta, Authentik, Dex) have not been tested end-to-end; report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349). The boundary ruling is final; see [Authentication docs](../administration/authentication.md) for details.

**Issues:** #349 (OIDC implementation), #714 (boundary decision), enterprise #4 (SAML), enterprise — (SCIM)

---

### Audit log (split)

The audit log is split across OSS and enterprise by scope:

**OSS — card-level activity**

`CardMovement` and `CardActivity` record what happened to individual cards. Teams rely on this daily, and it stays in OSS.

**OSS — feature-scoped security logs**

Two further OSS tables each record a *fixed, enumerable* set of privileged actions. Each is narrow to one feature, not a general-purpose audit product:

- **`AdminActionLog`** (#1126) records instance-wide admin control-plane actions: maintenance mode enabled/disabled, the maintenance notice changed, registration mode changed, uploads enabled/disabled, email settings changes, and password events (set or disabled for another account in the Django admin, and passwords set by the `ensure_site_admin`, `changepassword` and `provision_fuzz_token` management commands, source `cli`). It is read-only via `GET /api/v1/admin/action-log/`, restricted to site admins (`_ADMIN_PERMISSIONS`), with no write or delete endpoint. There is deliberately no retention pruner (the table grows by a handful of rows a month), and no configurable retention, arbitrary per-object diffing, or SIEM export. See the "Scope — deliberately narrow" section of the model docstring (`backend/accounts/models.py`).
- **`BoardExportLog`** (#842) records successful board exports for a single board: actor, role held at export time, export format, row count, and timestamp. It is read-only via `GET /api/v1/boards/{id}/export-history/`, restricted to board admins (and site admins). `AdminActionLog` reuses this table's shape, lifted to instance scope (see its docstring).

Both answer "who did this privileged thing, and when?" for a bounded action, not as a general compliance audit trail. Neither takes configuration, diffs arbitrary objects, or exports anywhere, which keeps them in OSS rather than the enterprise product below.

**Enterprise — system-wide compliance audit log**

A compliance audit log records board lifecycle events (created, deleted, archived), membership changes, and admin actions **beyond the closed set `AdminActionLog` already covers in OSS**, configurable per the operator's compliance policy rather than a fixed enum. It may export to a SIEM and enforce configurable retention. It serves security and compliance buyers, not small teams.

> **Reconciling with `AdminActionLog` / `BoardExportLog` (#1248).** "Admin actions" in the paragraph above describes the enterprise product's *configurable, system-wide* scope. It is not a rule that any record of an admin action belongs in enterprise. The two OSS tables are deliberately narrow (a closed set of control-plane toggles, and board exports) with no retention configuration and no SIEM export. That narrowness keeps them in OSS. If either ever grows configurable retention, arbitrary diffing, or SIEM export, revisit this ruling; until then they are the OSS side of the split, not candidates for it.

**OSS extension points required** (before the enterprise audit log can be built; none of the signals or the setting below exist in `boards/signals.py` or settings yet):

```python
# boards/signals.py — PLANNED, not yet implemented. OSS is to fire these; enterprise subscribes
post_board_created    # sender=Board, kwargs: board, actor
post_board_deleted    # sender=Board, kwargs: board_id, name, actor
post_member_added     # sender=BoardMembership, kwargs: board, user, role, actor
post_member_removed   # sender=BoardMembership, kwargs: board, user, actor
```

A `VISIBAN_AUDIT_BACKEND` setting (defaulting to `NullAuditBackend`) is planned and not yet implemented; it must be defined in OSS settings so enterprise can register its audit recorder without modifying OSS files.

**Issue:** OSS extension points tracked in #350 (transferred to enterprise repo; OSS signal and `VISIBAN_AUDIT_BACKEND` work tracked in #367, milestone 1.7).

---

### WIP enforcement (OSS)

WIP limits (`wip_limit` on Column) and the enforcement mode, soft (advisory toast) vs hard (blocked move), are OSS. A small team cannot manage capacity with soft-only enforcement. The board setting `enforce_wip_hard` (boolean, default `false`) toggles the mode. No enterprise extension point is needed.

**Issue:** #344. Note: enterprise repo issue #9 was closed as a duplicate; work belongs here.

---

### Movement history: view (OSS) vs export (Enterprise)

The board-level movement history view, filterable by swimlane, column, date range, and assignee, is OSS: without it, teams cannot query their own audit trail.

Structured delivery report export (CSV/PDF, formatted for client or QBR presentation) is enterprise. The OSS view exposes the `MOVEMENT_EXPORT_BACKENDS` hook list (`boards/hooks.py`) so enterprise can attach export formatters without modifying OSS view code.

**Issue:** #342

---

### Per-swimlane analytics: basic (OSS) vs advanced (Enterprise)

Basic per-swimlane analytics (cards in flight, average cycle time, cards moved to Done in the last 30 days) are OSS, since teams managing work per client/swimlane need row-level visibility. Advanced analytics (velocity trends over time, bottleneck detection, historical period comparisons, exportable reports) are enterprise.

The OSS analytics summary exposes an `ANALYTICS_EXTENSIONS` registration point (`boards/hooks.py`) so enterprise can add panels without modifying OSS view files. The summary returns the panels in `extension_panels`, and the Summary tab renders `stats` and `table` panels below the swimlane table (see the [payload contract](../api/boards.md#extension-panel-payload)).

**Authorization is OSS's job, not each panel's (#1826).** A panel declares the lowest board role that may see it with a `min_role` attribute on the callable. The summary drops every panel above the caller's role before calling any panel, so a panel that forgets a role check cannot leak to viewers. **Behavior change for extension authors in 1.2:** a panel with no `min_role`, or an invalid one, is admin-only (fail closed). Enterprise panels registered before 1.2 must set `min_role` to stay visible to non-admin members. See [panel visibility by role](../api/boards.md#panel-visibility-by-role) and [Security Invariants](../development/security-invariants.md) Rule 12.

**Issue:** #341

---

### Board import (OSS) vs migration wizard (Enterprise)

**Decision (#1982, 2026-10-31).** Board import and export are OSS, per the guiding principle: a team must be able to bring its own data in and take it out. OSS owns the import endpoints and formats (Trello, JSON and CSV), their envelopes, and the single-source importer UIs, including the Trello import wizard (#456). Only the cross-source guided/bulk migration flow (enterprise #24) is Enterprise. This clarifies and supersedes the earlier row, "External tool import wizard = Enterprise", which read as if OSS import were out of bounds; the shipped OSS importers stay OSS.

**Import and the custom-field signals (#1897).** A bulk import writes rows with `bulk_create`, so it does not send `custom_field_value_changed` or `swimlane_custom_field_value_changed`, nor any other signal for rows written that way (`Board` and `BoardMembership` rows are created individually, so their `post_save` receivers do fire): an import is not a user edit. An Enterprise audit trail built on those signals therefore will not see imported values. What an import does run is the value-policy hooks (`CUSTOM_FIELD_VALIDATORS` and `SWIMLANE_CUSTOM_FIELD_VALIDATORS`), so an extension's validation cannot be bypassed by importing. Those two lists are looked up by name string, so their names are pinned by `boards/tests/test_extensibility.py`.

**Issue:** #1982 (import ruling), #1897 (signal behavior). Enterprise migration flow in enterprise #24.

---

### Outgoing webhooks (OSS) vs webhook operations (Enterprise)

> **Status.** The OSS ruling is decided, but the feature is **planned and not yet implemented**: #863 is open on the 1.3 milestone and no webhook model, view, or dispatch command exists in the codebase.

Basic outgoing webhooks are OSS: per-board subscriptions, HMAC-signed, delivered in order from the [board change feed](../api/events.md) by a scheduled command, with best-effort retry. This reverses the original Enterprise ruling: on 2026-04-15 enterprise #39 was closed in favor of an OSS implementation (#740, consolidated into #863 on 2026-09-14). Webhooks are the minimum integration surface a team tool is evaluated on, and self-hosted alternatives commonly ship them free.

The operations layer is Enterprise: guaranteed delivery on a durable queue, a delivery log with replay, account-wide subscriptions, and a delivery audit trail. They make webhooks supportable at hosted or large-operator scale. A small team works without them, and consumers needing exact delivery can poll the change feed directly.

**OSS extension points:**

- **The change feed** (#1114, shipped in 1.2) is the delivery source. It is durable, ordered, and replayable by cursor, and it covers every board event type. The Enterprise dispatcher reads it exactly as the OSS one does.
- **`BOARD_EVENT_HOOKS`** (`boards/hooks.py`; **planned, not yet implemented**, tracked in #863) will be a list-append hook called on commit from `record_board_event()` with `(board_id, event_type, event_id)`. It is a nudge only ("check the feed now"), so a missed call self-heals from the cursor.

The earlier design, `post_card_created/moved/closed/updated` signals plus a `VISIBAN_WEBHOOK_BACKEND` setting, is **superseded and will not be built**. The change feed covers far more than four card events. For in-process card lifecycle reactions (such as automation), use `CARD_MUTATION_HOOKS`.

**Issue:** OSS webhooks in #863. Enterprise operations layer in enterprise #44. Slack/Teams channel apps are separate — see [Transactional email notifications vs channel integrations](#transactional-email-notifications-oss-vs-channel-integrations-enterprise).

---

### PATs (OSS) vs service account tokens (Enterprise)

OSS Personal Access Tokens are user-tied and limited to 10 per user. Since 1.2 they also carry [scopes](../features/personal-access-tokens.md#scopes) (`read`, `write`, `admin`, `mcp:read`, `mcp:write`), so a token can have less authority than its owner. That suffices for small teams doing CI/CD automation and for giving an AI agent least-privilege access.

Scoped tokens moved into OSS with #1110 and are no longer an enterprise differentiator. The MCP server is OSS and agent credentials are issued against OSS PATs, so least privilege for a credential a user is *told* to hand to an agent is necessary, not premium. Withholding it would have shipped an OSS feature that can only be used unsafely.

Enterprise service account tokens differ on the axis that actually separates them: they are **not tied to a real user account**. They survive offboarding, do not inherit a person's board memberships, and suit strict security environments that prohibit personal credentials in automation. Enterprise may also add **per-board** scoping; OSS scopes constrain the kind of operation, not the set of boards.

**Boundary documentation:** see [Personal Access Tokens](../features/personal-access-tokens.md) for OSS PAT scope. The service-account distinction must be documented in the enterprise repo before enterprise #17 is implemented.

---

### Transactional email notifications (OSS) vs channel integrations (Enterprise)

SMTP delivery of in-app notification events (card assigned, @mention, due date, card moved) is OSS: teams with members who aren't watching the board all day need email. Slack/Teams channel delivery and other third-party integrations are enterprise.

**OSS extension point:** `post_notification_created` (`boards/signals.py`), shipped in 1.2 lets enterprise subscribe additional delivery backends (Slack, Teams, richer email templates) without modifying OSS files. Every OSS notification creation path routes through `boards.services.notifications.create_notifications`, which makes the seam complete: three of the six creation sites use `bulk_create`, which sends no `post_save`, so a per-model signal would have silently skipped them. A test in `boards/tests/test_extensibility.py` fails if a new creation site bypasses the funnel.

**Issue:** OSS transactional email tracked in #356. Enterprise channel delivery in enterprise #34.

---

### Data retention (split)

Manual card archiving is OSS. Automated retention policies (auto-archive or delete cards older than an admin-configured threshold) are enterprise compliance tooling.

**Issue:** enterprise #19.

---

### Issue Board Lens (OSS)

The [Issue Board Lens](../features/issue-board-lens.md) (a read-only kanban view of a public GitHub or GitLab repository's issues, pivoted onto columns and swimlanes) is OSS. Per the guiding principle, a small team needs visibility into the external work (issues, PRs) it tracks outside Visiban: a core day-to-day concern, not an advanced add-on. It is flag-gated (`GIT_LENS_ENABLED`, off by default) and strictly read-only, with no sync, no webhooks, and no write-back to the provider, which keeps it a bounded visibility feature rather than an integration platform.

**Issue:** #1062 (tracking issue — "Classified OSS (enterprise-check)"; base lens shipped via MR !842 and follow-ups).

---

### MCP server (OSS) vs MCP enterprise upgrade (Enterprise)

The [MCP server](../features/mcp-server.md) — exposing boards, columns, swimlanes, cards, and the movement audit trail to an MCP-compatible AI agent over Bearer-token auth — is OSS. Letting a team's own agents and automations read and act on its boards, scoped by the same PATs the team already issues for CI/CD, is as core a day-to-day workflow concern as the human UI; withholding it would mean shipping an OSS feature (scoped PATs, #1110) that can only be used safely with a client enterprise alone provides.

The feature doc's ["Upgrade path to enterprise"](../features/mcp-server.md#upgrade-path-to-enterprise) section names the planned enterprise differentiators: OAuth 2.1 (so a client no longer needs a long-lived Bearer token managed by hand), analytics tools, prompt templates, and RBAC-scoped tool visibility (hiding tools a caller's role could never use, rather than returning `permission_denied` when they're called). **None of this is implemented yet** — it is a planned boundary, not a shipped one. Revisit this ruling's enterprise half once any part of it lands.

**Issue:** #511 (MCP server OSS scaffold). The planned enterprise upgrade path has no enterprise issue recorded yet.

---

## OSS extension points — implementation status

| Extension point | Required by | Status |
|---|---|---|
| Enterprise URL extension point (`enterprise.urls.enterprise_urlpatterns`) | All enterprise URL registrations | ✅ Implemented — `visiban/urls.py` (#715) |
| Enterprise settings include (`enterprise.settings.*`) | All enterprise settings overrides | ✅ Implemented — `visiban/settings.py` (#716). Constraint (#1337): the include must not replace `ACCOUNT_PASSWORD_RESET_TOKEN_GENERATOR` with anything that is not `accounts.tokens.VisibanPasswordResetTokenGenerator` or a subclass of it — subclasses are accepted. System check `accounts.E001` (Error) stops startup otherwise; `SILENCED_SYSTEM_CHECKS = ["accounts.E001"]` is the explicit opt-out. |
| `extension_urlpatterns` module attribute (`visiban/urls.py`) | Pending-action gate: tells an extension's own routes from OSS routes (`visiban.middleware.oss_gated_view_names`, `accounts.E007`) | ✅ Implemented — #1593. **Stable (1.0+ compatibility rules).** It is a list holding the *same pattern objects* that are appended to `urlpatterns` from `enterprise.urls.enterprise_urlpatterns`; the gate matches them by object identity. An extension must keep its routes in `enterprise_urlpatterns` and must not re-wrap, copy, or rebuild them (for example a new `path()`/`re_path()` around the same view) after that list is handed to OSS, or its routes are silently treated as OSS routes. Pinned by `accounts/tests/test_forced_change_session_exemptions.py`. Identity rule: [Authorization entry points](../development/authorization-entry-points.md) and the [security invariants registry](../development/security-invariants.md) |
| `PENDING_ACTION_EXTRA_GATED_PREFIXES` setting (`visiban/settings.py`) | Extension packages that mount their own session-based HTML pages (for example `/sso/`) | ✅ Implemented — #1551. **Stable.** Tuple of path prefixes, each with a leading and trailing slash, that `PendingAccountActionMiddleware` gates like `/accounts/` and `/admin/`. Default `()`. Validated by `accounts.E004`. See [Authorization entry points](../development/authorization-entry-points.md) |
| `PENDING_ACTION_EXTRA_EXEMPT_VIEWS` setting (`visiban/settings.py`) | Extension views a user with a pending forced change must still reach (for example an SSO callback) | ✅ Implemented — #1561. **Stable.** Tuple of exact resolved view names; each must meet the admission rule in [Authorization entry points](../development/authorization-entry-points.md). Default `()`. Validated by `accounts.E006`; a name that resolves to an OSS-gated view is rejected by `accounts.E007` and ignored at runtime |
| `TicketAuthMiddleware` (`accounts/ws_auth.py`) | WebSocket routing, including `enterprise.routing.enterprise_websocket_urlpatterns` | ✅ Implemented. **Stable.** Authenticates a WebSocket upgrade from a `?ticket=` parameter. Must be nested *inside* `AuthMiddlewareStack` (`AuthMiddlewareStack(TicketAuthMiddleware(URLRouter(...)))`); see its docstring for why, and [WebSockets](../api/websockets.md) for the handshake |
| `accounts.E001`–`E009` and `accounts.W001`–`W002` system checks (`accounts/checks.py`) | Startup guard rails for the extension surface above | ✅ Implemented. **Stable IDs.** `E001` reset-token generator lost the address binding (#1337), `E002` allauth by-code password reset enabled (#1314, #1337), `W001` session engine cannot support WebSocket credential revocation (#1483), `E003` `FRONTEND_URL` under a gated path (#1551), `E004` malformed `PENDING_ACTION_EXTRA_GATED_PREFIXES` entry, `E005` pending-action middleware missing from `MIDDLEWARE` or placed before `AuthenticationMiddleware` (#1561), `E006` malformed `PENDING_ACTION_EXTRA_EXEMPT_VIEWS` entry, `E007` exempt view that is OSS-gated (#1589, #1593), `E008` `changepassword` command no longer provided by `operator_commands`, `E009` the same for `createsuperuser` (#1801, #1824; [security invariants](../development/security-invariants.md) Rule 3), `W002` wildcard `ALLOWED_HOSTS` with no public origin listed in `CORS_ALLOWED_ORIGINS` / `CSRF_TRUSTED_ORIGINS` and no exact public host in `ALLOWED_HOSTS` (#1697). IDs are never reused or renumbered, so `SILENCED_SYSTEM_CHECKS` entries keep working |
| Enterprise WebSocket routing extension point (`enterprise.routing.enterprise_websocket_urlpatterns`) | All enterprise WebSocket URL registrations | ✅ Implemented — `visiban/asgi.py`, mirrors the HTTP URL extension point above; silently skipped (`ImportError`) when the enterprise package is not installed (#1009) |
| `post_board_created/deleted/member_added/removed` signals | Enterprise audit log (enterprise #28) | Not yet implemented — tracked in #367 |
| `VISIBAN_AUDIT_BACKEND` setting | Enterprise audit log | Not yet implemented — tracked in #367 |
| `post_card_created/moved/closed/updated` signals (superseded) | — | Superseded, will not be built: card lifecycle is covered by `CARD_MUTATION_HOOKS` (below) and every board event by the change feed (#1114) |
| `VISIBAN_WEBHOOK_BACKEND` setting (superseded) | — | Superseded, will not be built: webhooks are OSS (#863); the Enterprise operations layer (enterprise #44) consumes the change feed and `BOARD_EVENT_HOOKS` |
| `CARD_MUTATION_HOOKS` list (`boards/hooks.py`) | Enterprise automation (enterprise #69) and any in-process reaction to card create/update/move/delete/archive/restore | ✅ Implemented — `boards/hooks.py`, fired on commit from `boards/services/cards.py` (handler exceptions are logged and swallowed; handlers cannot veto or roll back the write); pinned by `boards/tests/test_card_mutation_hooks.py` |
| Board change feed (`GET /api/v1/boards/{id}/events/`) | OSS webhooks (#863), Enterprise webhook operations (enterprise #44), any out-of-process consumer | ✅ Implemented — #1114, contract in [`docs/api/events.md`](../api/events.md) |
| `BOARD_EVENT_HOOKS` list (`boards/hooks.py`) | Enterprise webhook operations (enterprise #44) — wake signal for a queue-backed dispatcher | Not yet implemented — planned in #863 |
| `VISIBAN_AUTOMATION_BACKEND` setting | Enterprise automation (enterprise #69) | Not yet implemented |
| `MOVEMENT_EXPORT_BACKENDS` list (`boards/hooks.py`) | Enterprise delivery report export (#342 enterprise) | ✅ Implemented — `boards/hooks.py`. The queryset handed to a backend holds movements of live cards only (`card` is never `None`): the retained history of hard-deleted cards (#1469) is filtered out until the contract is widened to say rows may have `card=None` (#1796) |
| `ANALYTICS_EXTENSIONS` list (`boards/hooks.py`) | Enterprise advanced analytics (#341 enterprise) | ✅ Implemented — `boards/hooks.py`, consumed by `boards/views/analytics.py` into the summary's `extension_panels`, rendered by the Summary tab (`SummaryView` / `ExtensionPanels`, #1770). Payload contract (additive-only): [`docs/api/boards.md`](../api/boards.md#extension-panel-payload). Each callable declares `min_role` (`viewer` / `collaborator` / `member` / `admin` / `site_admin`); OSS filters on the caller's board role through `boards.permissions.analytics_extensions_for_role` before calling any panel, and an unset or invalid `min_role` means `admin` (fail closed, changed in 1.2, #1826). The callable signature `(board, request) -> dict` is unchanged |
| `TEMPLATE_PROVIDERS` list (`boards/hooks.py`) | External board-template registration by installed packages (#1115; tracked further in #504) | ✅ Implemented — `boards/hooks.py` + `boards/template_sync.py`, synced via `post_migrate` in `BoardsConfig.ready()` |
| `CUSTOM_FIELD_VALIDATORS` list (`boards/hooks.py`) | Enterprise per-type custom field validators, **card** values (#371) | ✅ Implemented — `boards/hooks.py`, applied at the serializer boundary |
| `SWIMLANE_CUSTOM_FIELD_VALIDATORS` list (`boards/hooks.py`) | Enterprise per-type custom field validators, **swimlane row** values (#1140) | ✅ Implemented — `boards/hooks.py`, applied at the serializer boundary. A separate list from the card one, not a widening of it: a validator registered against the card signature may read card-only attributes, so feeding it a swimlane definition could raise. A validator that is generic across both levels registers in both lists. |
| `custom_field_value_changed` signal (`boards/signals.py`) | Enterprise custom field change audit trail, **card** values (#371) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/custom_fields.py`. Not sent by bulk import — see [Board import](#board-import-oss-vs-migration-wizard-enterprise). |
| `swimlane_custom_field_value_changed` signal (`boards/signals.py`) | Enterprise custom field change audit trail, **swimlane row** values (#1140) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/custom_fields.py`. Separate from the card signal for the same reason as the validator list above — reusing it would mean sending `card=None` to receivers that guarantee a card. Not sent by bulk import — see [Board import](#board-import-oss-vs-migration-wizard-enterprise). |
| `post_notification_created` signal (`boards/signals.py`) | Enterprise channel delivery (enterprise #34) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/notifications.py` (#356). **Opposite dispatch convention to the two custom-field signals above:** sent *after* the enclosing transaction commits (via `transaction.on_commit`) and with `send_robust`, so a receiver that raises is logged and dropped and cannot roll back the notification it is reporting or fail the request. When no transaction is open — both notification management commands, and the description-mention path — `on_commit` runs the callback immediately and synchronously, so a receiver doing network I/O owns its own timeout. Kwargs: `notification`, `recipient`, `actor`, `context` (a per-`action_type` dict carrying detail that is not reachable from the row, such as the comment body or the from/to column names). |
| `BaseSnapshotStorage` / `SNAPSHOT_STORAGE_BACKEND` | Enterprise S3 snapshots (enterprise #37) | Not yet implemented |
| `post_reminder_due` signal | Enterprise reminder delivery (enterprise #35) | Not yet implemented |

### Overriding `REST_FRAMEWORK` from the enterprise settings include

`visiban/settings.py` ends with `from enterprise.settings import *`, so assigning a new `REST_FRAMEWORK` dict **replaces** the OSS one rather than merging into it. An enterprise override must start from a copy of the OSS dict (or update individual keys in place) and keep every key OSS relies on, including those added in 1.2:

- `DEFAULT_FILTER_BACKENDS` must keep `visiban.filters.CodedDjangoFilterBackend` (#1832). It answers a malformed query parameter with `{detail, code: "invalid_query_param"}`. Falling back to the stock `DjangoFilterBackend` changes that 400 body, which is part of the API contract.
- `DEFAULT_THROTTLE_RATES` must keep every scope OSS defines (`user_search`, `card_query`, `board_import`, `invite_email_*`, `password_change`, and the rest). A view that names a scope missing from this dict fails with `ImproperlyConfigured` on its first throttled request. Add enterprise scopes by updating the dict, not by replacing it.
- `DEFAULT_THROTTLE_CLASSES` must stay in place. Dropping it removes the global anon/user limits from every view that does not name its own throttle classes (scoped throttles are attached per view).
- `NUM_PROXIES` keys every per-IP throttle and `visiban.utils.get_client_ip`. Dropping it falls back to DRF's default (`None`): DRF then keys throttles on the whole client-controlled `X-Forwarded-For` string, so a client can pick a fresh bucket per request and bypass per-IP throttles, and `get_client_ip` falls back to `REMOTE_ADDR`, so every client shares the proxy's address for the admin allowlist, allauth rate limits and the MCP pre-auth throttle.
- `DEFAULT_AUTHENTICATION_CLASSES` must keep `accounts.authentication.PATAuthentication` first, because it makes DRF answer authentication failures with 401 instead of 403. `DEFAULT_PERMISSION_CLASSES` must keep `rest_framework.permissions.IsAuthenticated`, `MustNotHavePendingPasswordChange`, `MustNotHavePendingUsernameChange` and `accounts.permissions.TokenHasScope`. `IsAuthenticated` matters most: both forced-change gates return `True` for anonymous requests, so it is the only thing blocking anonymous access on views that use the default permissions (for example `PendingEmailView`, `ConnectedAccountsView` and `ConnectedAccountDetailView`). Dropping any of them silently removes the forced-change gate or personal access token scopes ([Security Invariants](../development/security-invariants.md)). An extension authenticator that returns `(user, None)` is no longer treated as a session: setting a first password, changing the email address or username, and disconnecting a sign-in provider answer `403` for it, and so does minting a WebSocket ticket (#1839). An extension authenticator must not subclass `SessionAuthentication` unless it really authenticates from the cookie session.
- `DEFAULT_PARSER_CLASSES` must keep `rest_framework.parsers.JSONParser`, `visiban.parsers.LimitedFormParser` and `visiban.parsers.LimitedMultiPartParser`, in that order (#2072). The two form parsers answer a form body over Django's upload limits with the documented JSON `400`: `DATA_UPLOAD_MAX_NUMBER_FILES` and `DATA_UPLOAD_MAX_NUMBER_FIELDS` for a multipart or urlencoded body, and `DATA_UPLOAD_MAX_MEMORY_SIZE` for a multipart body only (a JSON or urlencoded body over it still answers HTML, tracked in [#2073](https://gitlab.com/visiban/visiban/-/issues/2073)). Dropping the key falls back to DRF's stock parsers, which let Django answer those bodies with an undocumented HTML `400`. The same holds for an enterprise view or `@action` that pins `parser_classes`: it must use the `visiban.parsers` classes, not DRF's `FormParser` or `MultiPartParser`.
- `DEFAULT_PAGINATION_CLASS` (`visiban.pagination.OffsetCountPagination`; the default page size of 50 is hardcoded there, `PAGE_SIZE` is not read), `DEFAULT_VERSIONING_CLASS`, `DEFAULT_VERSION`, `ALLOWED_VERSIONS` and `DEFAULT_SCHEMA_CLASS` are part of the public API contract.

OSS currently sets no `EXCEPTION_HANDLER`. If one is added, an override must copy it too.

```python
# enterprise/settings/...
from visiban.settings import REST_FRAMEWORK  # noqa: F401

REST_FRAMEWORK["DEFAULT_THROTTLE_RATES"]["my_enterprise_scope"] = "60/min"
```

!!! note "Verification scope (#1876)"
    The check that no enterprise `ANALYTICS_EXTENSIONS` panel lacks `min_role` covered only the `main` branch of `visiban/visiban-enterprise`, which held no panel registrations at the time. It says nothing about private forks or out-of-tree add-ons.
