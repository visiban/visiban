# Open-Core Boundary

This document records the OSS vs enterprise classification for every feature area where the boundary has been formally decided. It is the canonical reference — when a feature appears here, the ruling supersedes any informal discussion in issue comments.

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
| System-wide compliance audit log | Enterprise | Compliance tooling; card-level history in OSS is sufficient for small teams | #350→enterprise |
| Hard WIP enforcement | OSS | Core Kanban mechanism; soft-only enforcement does not work | #344 |
| Outgoing webhooks | Enterprise | Integration with external services; small teams can work inside Visiban without them | #345→enterprise |
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
| Auto PR-to-card link via webhooks | Enterprise | Depends on enterprise webhook feature | #352 Phase 2 |
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
| Board template visual editor | Enterprise | Basic template creation via API/admin is sufficient for OSS | enterprise #3 |
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
| Generic OIDC | OSS | Tech Preview (see [#349](https://gitlab.com/visiban/visiban/-/issues/349)) | `allauth` (already present) |
| SAML 2.0 / ADFS | Enterprise | Planned | separate library required |
| SCIM directory sync / JIT | Enterprise | Planned | separate library required |

> **OIDC tech preview note.** The configuration plumbing (env vars, provider registration, settings guard) is implemented and unit-tested. End-to-end login flow against a real identity provider has not been validated. The boundary ruling is final; see [Authentication docs](../administration/authentication.md) for the current production-readiness status.

**Issues:** #349 (OIDC implementation), #714 (boundary decision), enterprise #4 (SAML), enterprise — (SCIM)

---

### Audit log (split)

The audit log is split across OSS and enterprise by scope:

**OSS — card-level activity**

`CardMovement` and `CardActivity` record what happened to individual cards. This is a core collaborative feature that teams rely on daily. It exists in the OSS codebase and will stay there.

**Enterprise — system-wide compliance audit log**

A compliance audit log records board lifecycle events (created, deleted, archived), membership changes, and admin actions. It may export to a SIEM and enforce configurable retention policies. This serves security and compliance buyers, not small teams.

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

### Outgoing webhooks (Enterprise)

Outgoing webhooks are classified enterprise. A small team can track work end-to-end inside Visiban without pushing events to external systems.

**OSS extension point required:** The OSS core must fire card-level signals so enterprise can subscribe the webhook dispatcher without wrapping individual view methods:

```python
# boards/signals.py — required before enterprise webhook feature (#39) can be built
post_card_created    # sender=Card, kwargs: card, actor
post_card_moved      # sender=Card, kwargs: card, from_column, to_column, actor
post_card_closed     # sender=Card, kwargs: card, actor
post_card_updated    # sender=Card, kwargs: card, changed_fields, actor
```

A `VISIBAN_WEBHOOK_BACKEND` registration pattern must also be defined in OSS settings.

**Issue:** enterprise #39 (transferred from OSS #345).

---

### PATs (OSS) vs service account tokens (Enterprise)

OSS Personal Access Tokens are user-tied, carry the user's full access rights, and are limited to 10 per user. They are sufficient for small teams doing CI/CD automation.

Enterprise service account tokens are not tied to a real user account. They support board-scoped permissions (read-only vs read-write) and are intended for strict security environments where personal-credential use in automation is prohibited.

**Boundary documentation:** see [Personal Access Tokens](../features/personal-access-tokens.md) for OSS PAT scope. The service-account distinction must be documented in the enterprise repo before enterprise #17 is implemented.

---

### Transactional email notifications (OSS) vs channel integrations (Enterprise)

SMTP delivery of in-app notification events (card assigned, @mention, due date, card moved) is OSS. Teams with members who are not watching the board all day need email delivery to collaborate effectively.

Slack/Teams channel delivery and other third-party integrations are enterprise.

**OSS extension point required:** The OSS notification system must fire a `post_notification_created` signal so enterprise can subscribe additional delivery backends (Slack, Teams, email templates) without modifying OSS files.

**Issue:** OSS transactional email tracked in #356. Enterprise channel delivery in enterprise #34.

---

### Data retention (split)

Manual card archiving is OSS (existing feature). Automated retention policies (auto-archive or delete cards older than an admin-configured threshold) are enterprise compliance tooling.

**Issue:** enterprise #19.

---

## OSS extension points — implementation status

| Extension point | Required by | Status |
|---|---|---|
| Enterprise URL extension point (`enterprise.urls.enterprise_urlpatterns`) | All enterprise URL registrations | ✅ Implemented — `visiban/urls.py` (#715) |
| Enterprise settings include (`enterprise.settings.*`) | All enterprise settings overrides | ✅ Implemented — `visiban/settings.py` (#716) |
| `post_board_created/deleted/member_added/removed` signals | Enterprise audit log (enterprise #28) | Not yet implemented |
| `VISIBAN_AUDIT_BACKEND` setting | Enterprise audit log | Not yet implemented |
| `post_card_created/moved/closed/updated` signals | Enterprise webhooks (enterprise #39), automation (enterprise #8) | Not yet implemented |
| `VISIBAN_WEBHOOK_BACKEND` setting | Enterprise webhooks | Not yet implemented |
| `VISIBAN_AUTOMATION_BACKEND` setting | Enterprise automation (enterprise #8) | Not yet implemented |
| `movement_history_export` hook | Enterprise delivery report export (#342 enterprise) | Not yet implemented |
| `ANALYTICS_EXTENSIONS` registration | Enterprise advanced analytics (#341 enterprise) | Not yet implemented |
| `post_notification_created` signal | Enterprise channel delivery (enterprise #34) | Not yet implemented |
| `BaseSnapshotStorage` / `SNAPSHOT_STORAGE_BACKEND` | Enterprise S3 snapshots (enterprise #37) | Not yet implemented |
| `post_reminder_due` signal | Enterprise reminder delivery (enterprise #35) | Not yet implemented |
