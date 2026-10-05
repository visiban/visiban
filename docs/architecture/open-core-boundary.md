# Open-Core Boundary

The OSS vs enterprise classification for every feature area where the boundary has been formally decided. This is the canonical reference — when a feature appears here, the ruling supersedes any informal discussion in issue comments.

**Guiding principle:** "Can a small team work together effectively without this?" If no → OSS core. If yes → enterprise candidate.

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
| Outgoing webhooks (per-board, signed, best-effort) | OSS | Minimum integration surface for a team tool; delivered from the change feed with no task queue. Reversed from Enterprise on 2026-04-15 | #863 |
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
| Automation rules (if/then triggers) | Enterprise | Advanced automation; small teams work without it | enterprise #8 |
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
| External tool import wizard | Enterprise | Migration tooling | enterprise #24 |
| Form engine for card intake | Enterprise | Borderline; revisit if intake teams are a common OSS persona | enterprise #32 |
| Google Calendar integration | Enterprise | External service | enterprise #2 |

---

## Detailed rulings

### OIDC authentication (OSS) vs SAML / SCIM (Enterprise)

**Decided — #714.** Generic OIDC via `allauth.socialaccount.providers.openid_connect` is OSS. It is an extension of the Google/GitHub/GitLab OAuth stack already in the codebase; the library (`django-allauth`) is already a dependency, so no new package is required. Keeping OIDC in OSS was confirmed as the right boundary before 1.0 — removing it post-1.0 would be a breaking API change.

SAML and ADFS require a separate library (e.g. `python3-saml` or `djangosaml2`) and serve organizations with centralized IdP-managed identity. SCIM 2.0 directory sync and JIT provisioning are the additional enterprise identity differentiators — they handle automatic account lifecycle management at scale, which invite-link-based onboarding covers sufficiently for small teams in OSS.

| Method | Classification | Status | Library |
|---|---|---|---|
| Google OAuth | OSS | Shipped | `allauth` (already present) |
| GitHub OAuth | OSS | Shipped | `allauth` (already present) |
| GitLab OAuth | OSS | Shipped | `allauth` (already present) |
| Generic OIDC | OSS | Shipped | `allauth` (already present) |
| SAML 2.0 / ADFS | Enterprise | Planned | separate library required |
| SCIM directory sync / JIT | Enterprise | Planned | separate library required |

> **OIDC note.** The configuration plumbing (env vars, provider registration, settings guard) is implemented and unit-tested. End-to-end login flow is validated in CI against Keycloak. Other providers (Okta, Authentik, Dex) have not been tested end-to-end — report findings on [issue #349](https://gitlab.com/visiban/visiban/-/issues/349). The boundary ruling is final; see [Authentication docs](../administration/authentication.md) for details.

**Issues:** #349 (OIDC implementation), #714 (boundary decision), enterprise #4 (SAML), enterprise — (SCIM)

---

### Audit log (split)

The audit log is split across OSS and enterprise by scope:

**OSS — card-level activity**

`CardMovement` and `CardActivity` record what happened to individual cards. This is a core collaborative feature that teams rely on daily. It exists in the OSS codebase and will stay there.

**OSS — feature-scoped security logs**

Two further OSS tables each record a *fixed, enumerable* set of privileged actions, narrow to a single feature rather than a general-purpose audit product:

- **`AdminActionLog`** (#1126) records instance-wide admin control-plane actions — maintenance mode enabled/disabled, the maintenance notice changed, registration mode changed, uploads enabled/disabled, and email settings changes. Read-only via `GET /api/v1/admin/action-log/`, restricted to site admins (`_ADMIN_PERMISSIONS`); there is no write or delete endpoint. There is deliberately no retention pruner — the table grows by a handful of rows a month — and no configurable retention, arbitrary per-object diffing, or SIEM export. See the "Scope — deliberately narrow" section of the model docstring (`backend/accounts/models.py`).
- **`BoardExportLog`** (#842) records successful board exports for a single board — actor, role held at export time, export format, row count, and timestamp. Read-only via `GET /api/v1/boards/{id}/export-history/`, restricted to board admins (and site admins). `AdminActionLog` explicitly reuses this table's shape, lifted to instance scope (see its docstring).

Both exist to answer "who did this privileged thing, and when?" for a specific, bounded action — not to serve as a general compliance audit trail. Neither table takes configuration, diffs arbitrary objects, or exports anywhere; that is what keeps them in OSS rather than the enterprise product below.

**Enterprise — system-wide compliance audit log**

A compliance audit log records board lifecycle events (created, deleted, archived), membership changes, and admin actions **beyond the closed set `AdminActionLog` already covers in OSS** — configurable per the operator's compliance policy rather than a fixed enum. It may export to a SIEM and enforce configurable retention policies. This serves security and compliance buyers, not small teams.

> **Reconciling with `AdminActionLog` / `BoardExportLog` (#1248).** "Admin actions" in the paragraph above describes the enterprise product's *configurable, system-wide* scope, not a rule that any record of an admin action belongs in enterprise. The two OSS tables above are deliberately narrow — a closed set of control-plane toggles, and board exports, respectively — with no retention configuration and no SIEM export; that narrowness, not the mere existence of an admin-action record, is what keeps them in OSS. If either table ever grows configurable retention, arbitrary diffing, or SIEM export, revisit this ruling — until then they are the OSS side of the split this section describes, not candidates for it.

**OSS extension points required** (before the enterprise audit log can be built):

```python
# boards/signals.py — OSS fires these; enterprise subscribes
post_board_created    # sender=Board, kwargs: board, actor
post_board_deleted    # sender=Board, kwargs: board_id, name, actor
post_member_added     # sender=BoardMembership, kwargs: board, user, role, actor
post_member_removed   # sender=BoardMembership, kwargs: board, user, actor
```

A `VISIBAN_AUDIT_BACKEND` setting (defaulting to `NullAuditBackend`) must be defined in OSS settings so enterprise can register its audit recorder without modifying OSS files.

**Issue:** OSS extension points tracked in #350 (transferred to enterprise repo; OSS signal work tracked separately).

---

### WIP enforcement (OSS)

WIP limits (`wip_limit` field on Column) exist in OSS. The enforcement mode — soft (advisory toast) vs hard (blocked move) — is a board-level setting that belongs in OSS. A small team using WIP limits cannot manage capacity effectively with soft-only enforcement.

The board setting `enforce_wip_hard` (boolean, default `false`) toggles between modes. No enterprise extension point is needed.

**Issue:** #344. Note: enterprise repo issue #9 was closed as a duplicate; work belongs here.

---

### Movement history: view (OSS) vs export (Enterprise)

The board-level movement history view — filterable by swimlane, column, date range, and assignee — is OSS. Without it, teams cannot query their own audit trail.

Structured delivery report export (CSV/PDF, formatted for client or QBR presentation) is enterprise. The OSS view must expose a `movement_history_export` signal/hook so enterprise can attach export formatters without modifying OSS view code.

**Issue:** #342

---

### Per-swimlane analytics: basic (OSS) vs advanced (Enterprise)

Basic per-swimlane analytics — cards in flight, average cycle time, cards moved to Done in the last 30 days — is OSS. Teams managing work per client/swimlane need row-level visibility.

Advanced analytics (velocity trends over time, bottleneck detection, historical period comparisons, exportable reports) are enterprise.

The OSS analytics page must expose an `ANALYTICS_EXTENSIONS` registration point so enterprise can add panels without modifying OSS view files.

**Issue:** #341

---

### Outgoing webhooks (OSS) vs webhook operations (Enterprise)

Basic outgoing webhooks are OSS: per-board subscriptions, HMAC-signed, delivered in order from the [board change feed](../api/events.md) by a scheduled command, with best-effort retry. This reverses the original Enterprise ruling. On 2026-04-15 enterprise #39 was closed in favor of an OSS implementation (#740, consolidated into #863 on 2026-09-14). Webhooks are the minimum integration surface a team tool is evaluated on, and self-hosted alternatives commonly ship them free.

The operations layer is Enterprise: guaranteed delivery on a durable queue, a delivery log with replay, account-wide subscriptions, and a delivery audit trail. These make webhooks supportable at hosted or large-operator scale. A small team works without them, and consumers that need exact delivery can poll the change feed directly.

**OSS extension points:**

- **The change feed** (#1114, shipped in 1.2) is the delivery source. It is durable, ordered, and replayable by cursor, and it covers every board event type. The Enterprise dispatcher reads it exactly as the OSS one does.
- **`BOARD_EVENT_HOOKS`** (`boards/hooks.py`, planned in #863) is a list-append hook called on commit from `record_board_event()` with `(board_id, event_type, event_id)`. It is a nudge only ("check the feed now"), so a missed call self-heals from the cursor.

The earlier design, `post_card_created/moved/closed/updated` signals plus a `VISIBAN_WEBHOOK_BACKEND` setting, is **superseded and will not be built**. The change feed covers far more than four card events. For in-process card lifecycle reactions (such as automation), use `CARD_MUTATION_HOOKS`.

**Issue:** OSS webhooks in #863. Enterprise operations layer in enterprise #44. Slack/Teams channel apps are separate — see [Transactional email notifications vs channel integrations](#transactional-email-notifications-oss-vs-channel-integrations-enterprise).

---

### PATs (OSS) vs service account tokens (Enterprise)

OSS Personal Access Tokens are user-tied and limited to 10 per user. Since 1.2 they also carry [scopes](../features/personal-access-tokens.md#scopes) (`read`, `write`, `admin`, `mcp:read`, `mcp:write`), so a token can be issued with less authority than its owner. They are sufficient for small teams doing CI/CD automation and for granting an AI agent least-privilege access.

Scoped tokens moved into OSS with #1110 and are no longer an enterprise differentiator. The project's own test decides it: the MCP server is OSS, agent credentials are issued against OSS PATs, and least privilege for a credential a user is *told* to hand to an agent is necessary rather than premium. Withholding it would have meant shipping an OSS feature that can only be used unsafely.

Enterprise service account tokens remain distinct on the axis that actually separates them: they are **not tied to a real user account**, so they survive offboarding, do not inherit a person's board memberships, and are intended for strict security environments where personal-credential use in automation is prohibited. Enterprise may also add **per-board** scoping; OSS scopes constrain the kind of operation, not the set of boards.

**Boundary documentation:** see [Personal Access Tokens](../features/personal-access-tokens.md) for OSS PAT scope. The service-account distinction must be documented in the enterprise repo before enterprise #17 is implemented.

---

### Transactional email notifications (OSS) vs channel integrations (Enterprise)

SMTP delivery of in-app notification events (card assigned, @mention, due date, card moved) is OSS. Teams with members who are not watching the board all day need email delivery to collaborate effectively.

Slack/Teams channel delivery and other third-party integrations are enterprise.

**OSS extension point:** `post_notification_created` (`boards/signals.py`), shipped in 1.2 — enterprise subscribes additional delivery backends (Slack, Teams, richer email templates) without modifying OSS files. Every notification creation path in OSS routes through `boards.services.notifications.create_notifications`, which is what makes the seam complete: three of the six creation sites use `bulk_create`, which sends no `post_save`, so a per-model signal would have silently skipped them. A test in `boards/tests/test_extensibility.py` fails if a new creation site bypasses the funnel.

**Issue:** OSS transactional email tracked in #356. Enterprise channel delivery in enterprise #34.

---

### Data retention (split)

Manual card archiving is OSS (existing feature). Automated retention policies (auto-archive or delete cards older than an admin-configured threshold) are enterprise compliance tooling.

**Issue:** enterprise #19.

---

### Issue Board Lens (OSS)

The [Issue Board Lens](../features/issue-board-lens.md) — a read-only kanban view of a public GitHub or GitLab repository's issues, pivoted onto columns and swimlanes — is OSS. Per this doc's guiding principle, a small team needs visibility into the external work (issues, PRs) it tracks outside Visiban to work together effectively; that is a core day-to-day workflow concern, not an advanced add-on. The feature is flag-gated (`GIT_LENS_ENABLED`, off by default) and strictly read-only — no sync, no webhooks, no write-back to the provider — which keeps it a bounded visibility feature rather than an integration platform.

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
| Enterprise WebSocket routing extension point (`enterprise.routing.enterprise_websocket_urlpatterns`) | All enterprise WebSocket URL registrations | ✅ Implemented — `visiban/asgi.py`, mirrors the HTTP URL extension point above; silently skipped (`ImportError`) when the enterprise package is not installed (#1009) |
| `post_board_created/deleted/member_added/removed` signals | Enterprise audit log (enterprise #28) | Not yet implemented |
| `VISIBAN_AUDIT_BACKEND` setting | Enterprise audit log | Not yet implemented |
| `post_card_created/moved/closed/updated` signals (superseded) | — | Superseded, will not be built: card lifecycle is covered by `CARD_MUTATION_HOOKS` (below) and every board event by the change feed (#1114) |
| `VISIBAN_WEBHOOK_BACKEND` setting (superseded) | — | Superseded, will not be built: webhooks are OSS (#863); the Enterprise operations layer (enterprise #44) consumes the change feed and `BOARD_EVENT_HOOKS` |
| `CARD_MUTATION_HOOKS` list (`boards/hooks.py`) | Enterprise automation (enterprise #69) and any in-process reaction to card create/update/move/delete/archive/restore | ✅ Implemented — `boards/hooks.py`, fired on commit from `boards/services/cards.py` (handler exceptions are logged and swallowed; handlers cannot veto or roll back the write); pinned by `boards/tests/test_card_mutation_hooks.py` |
| Board change feed (`GET /api/v1/boards/{id}/events/`) | OSS webhooks (#863), Enterprise webhook operations (enterprise #44), any out-of-process consumer | ✅ Implemented — #1114, contract in [`docs/api/events.md`](../api/events.md) |
| `BOARD_EVENT_HOOKS` list (`boards/hooks.py`) | Enterprise webhook operations (enterprise #44) — wake signal for a queue-backed dispatcher | Not yet implemented — planned in #863 |
| `VISIBAN_AUTOMATION_BACKEND` setting | Enterprise automation (enterprise #69) | Not yet implemented |
| `MOVEMENT_EXPORT_BACKENDS` list (`boards/hooks.py`) | Enterprise delivery report export (#342 enterprise) | ✅ Implemented — `boards/hooks.py` |
| `ANALYTICS_EXTENSIONS` list (`boards/hooks.py`) | Enterprise advanced analytics (#341 enterprise) | ✅ Implemented — `boards/hooks.py` |
| `TEMPLATE_PROVIDERS` list (`boards/hooks.py`) | External board-template registration by installed packages (#1115; tracked further in #504) | ✅ Implemented — `boards/hooks.py` + `boards/template_sync.py`, synced via `post_migrate` in `BoardsConfig.ready()` |
| `CUSTOM_FIELD_VALIDATORS` list (`boards/hooks.py`) | Enterprise per-type custom field validators, **card** values (#371) | ✅ Implemented — `boards/hooks.py`, applied at the serializer boundary |
| `SWIMLANE_CUSTOM_FIELD_VALIDATORS` list (`boards/hooks.py`) | Enterprise per-type custom field validators, **swimlane row** values (#1140) | ✅ Implemented — `boards/hooks.py`, applied at the serializer boundary. A separate list from the card one, not a widening of it: a validator registered against the card signature may read card-only attributes, so feeding it a swimlane definition could raise. A validator that is generic across both levels registers in both lists. |
| `custom_field_value_changed` signal (`boards/signals.py`) | Enterprise custom field change audit trail, **card** values (#371) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/custom_fields.py` |
| `swimlane_custom_field_value_changed` signal (`boards/signals.py`) | Enterprise custom field change audit trail, **swimlane row** values (#1140) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/custom_fields.py`. Separate from the card signal for the same reason as the validator list above — reusing it would mean sending `card=None` to receivers that guarantee a card. |
| `post_notification_created` signal (`boards/signals.py`) | Enterprise channel delivery (enterprise #34) | ✅ Implemented — `boards/signals.py`, sent from `boards/services/notifications.py` (#356). **Opposite dispatch convention to the two custom-field signals above:** sent *after* the enclosing transaction commits (via `transaction.on_commit`) and with `send_robust`, so a receiver that raises is logged and dropped and cannot roll back the notification it is reporting or fail the request. When no transaction is open — both notification management commands, and the description-mention path — `on_commit` runs the callback immediately and synchronously, so a receiver doing network I/O owns its own timeout. Kwargs: `notification`, `recipient`, `actor`, `context` (a per-`action_type` dict carrying detail that is not reachable from the row, such as the comment body or the from/to column names). |
| `BaseSnapshotStorage` / `SNAPSHOT_STORAGE_BACKEND` | Enterprise S3 snapshots (enterprise #37) | Not yet implemented |
| `post_reminder_due` signal | Enterprise reminder delivery (enterprise #35) | Not yet implemented |
