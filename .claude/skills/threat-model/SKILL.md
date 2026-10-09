---
name: threat-model
description: Architecture-stage STRIDE threat model, run BEFORE `architect` on a feature that adds an auth path, changes an authorization boundary, adds external data ingress (import, attachment, webhook, MCP), adds or changes an OSS-to-enterprise extension point, or adds an anonymous/public read surface. Reasons about data flow and trust boundaries before code exists; distinct from `security-review` (code-level audit of a diff) and `rbac-check` (per-action role enforcement). Its output is handed to `architect`.
argument-hint: "<feature description or ADR/issue reference>"
model: opus
---

# Threat Model (STRIDE, architecture stage)

You are producing a STRIDE threat model for a new or changed Visiban feature **before code is written**. The goal is to catch design-level flaws, which are cheap to fix on paper and expensive to fix after the API contract has shipped (Visiban 1.0+ is a public API and WebSocket contract; see root `CLAUDE.md` § Backward compatibility).

Examples of design-level flaws this skill exists to catch: a token minted into a URL, a broadcast payload carrying a field the REST serializer hides for some roles, an extension-point input trusted because "enterprise is ours".

This skill is a **read-only analysis**. It writes no code and no files. Return the document to the caller.

## When to run

Run it when the feature does any of:

- Adds an authentication path (login, social/OIDC callback, invite or registration token, personal access token, WebSocket ticket)
- Changes an authorization boundary (new role, new resource scope, cross-board or cross-group visibility)
- Adds external data ingress (import, file upload or attachment, inbound webhook, MCP tool, outbound fetch of third-party data)
- Adds or changes an OSS-to-enterprise extension point
- Adds an anonymous or public read surface

Skip it for internal refactors, pure bug fixes with an identified local root cause, UI-only changes that touch no data path, and dependency bumps.

Order of operations: `voc` (if user-visible) then **`threat-model`** then `architect`. Pass `architect` the document's **Top risks** and **Decisions for the architect** sections; it must not start implementation until every high-severity decision is answered or deferred with a justification.

## Step 0 — Ground the feature in the code

Before reasoning, read the real surfaces the feature touches. Do not model a boundary you have not located in the code. If a named file below no longer exists, say so in the output and find its replacement; a model built on a stale map is worse than none.

Also read `docs/development/security-invariants.md` (rules that must hold on more than one transport) and `docs/development/rbac-and-broadcast-gates.md`. For every invariant the feature touches, list every surface in that rule's table.

## STRIDE per asset

For each asset (user account, board, card, membership, share token, invite token, PAT, WebSocket ticket, provider OAuth token, imported file, etc.), answer:

| Threat | Question |
|---|---|
| **S**poofing | Who can impersonate this? What identity claim is required, and where is it verified (session, PAT, WS ticket, share token, OIDC id token)? |
| **T**ampering | Where is it mutated? What integrity checks exist? Can a privileged-but-not-owning actor, or a replayed request, change it? |
| **R**epudiation | Is the action recorded with actor, timestamp and before/after state (`BoardEvent`, `CardMovement`, activity)? Does a new write path skip the record? |
| **I**nformation disclosure | Through which paths can it be read: REST, WebSocket broadcast, change feed (`GET /boards/<id>/events/`), group channel, export, error message, log line, cache? Are field-level redactions identical across all of them? |
| **D**enial of service | What is the unbounded growth path (cache keys, uploads, import size, outbound fetches)? What throttle or budget applies, and is it keyed on something the caller can mint freely? |
| **E**levation of privilege | Can a viewer become a member, a member an admin, an anonymous caller a user, through a sequence of individually legal operations? |

## Trust boundaries (Visiban)

Mark each boundary the feature crosses. For each, name the authentication, validation and audit obligations.

1. **Internet to API.** Session cookie, PAT (`accounts/authentication.py`), DRF permission chain (`MustNotHavePendingPasswordChange` and `MustNotHavePendingUsernameChange` in `visiban/permissions.py`, `TokenHasScope` in `accounts/permissions.py`), social and OIDC callbacks (`accounts/adapter.py` `SocialRegistrationAdapter`; providers configured in `visiban/settings.py`), registration and invite tokens (`accounts/registration_tokens.py`, `accounts/invite_utils.py`, `boards/invites.py`). Public routes use `permission_classes = []` and `authentication_classes = []` (for example `ShareBoardView`), so they have no second line of defense: enumerate them in `backend/visiban/urls.py` and treat each as an anonymous surface.
2. **API to Channels / Valkey broadcast.** `broadcast_board_event()` and `record_board_event()` in `backend/boards/broadcast.py`, group fan-out in `backend/groups/broadcast.py`, subscriber filtering in `backend/boards/consumers.py` (`BoardConsumer.board_event`), handshake in `backend/accounts/ws_auth.py` (single-use ticket from `WSTicketView` in `accounts/views.py`). The publish side fans out **one unfiltered payload to every subscriber** and also persists it verbatim as a `BoardEvent` row served by the change feed. Any field that REST hides by role must be absent from the payload, or be stripped in BOTH the consumer and `BoardEventSerializer.to_representation`. Check serializers that resolve role from `context["request"]` (an admin-built payload carries admin-only fields to everyone).
3. **OSS to enterprise extension points.** Registries in `backend/boards/hooks.py` (`MOVEMENT_EXPORT_BACKENDS`, `ANALYTICS_EXTENSIONS`, `CARD_MUTATION_HOOKS`, `TEMPLATE_PROVIDERS`, `CUSTOM_FIELD_VALIDATORS`), URL patterns (`enterprise.urls.enterprise_urlpatterns` mounted last in `backend/visiban/urls.py`), settings include (`from enterprise.settings import *` at the end of `backend/visiban/settings.py`, which can replace `AUTHENTICATION_BACKENDS` and similar). Treat anything enterprise code passes into OSS as **untrusted** (validate types, sizes, ownership) and anything OSS passes out as a published contract that cannot shrink. The OSS core must stay fully functional with the extension absent.
4. **External ingress.** Board and Trello import (`backend/boards/views/import_export.py`, `backend/boards/services/trello_import.py`, CSV import), file attachments and media serving (`backend/boards/views/media.py`), MCP transport (`backend/mcp_server/auth.py` bearer middleware, `tools.py`, `throttling.py`), and outbound provider fetches (`backend/git_lens/providers.py`, the single `_provider_get` choke point). Today the OSS tree has no inbound webhook receiver; if the feature adds one, it is a new boundary and needs signature verification, replay protection, a size cap and an owner check.
5. **API to database.** Transactional integrity; consume-once tokens claimed atomically at the gate (see patterns below); object-level authorization on every fetch by primary key.
6. **Browser/SPA to shared links.** Anything that puts a credential in a URL (share links, invite links, email-confirmation links, WS tickets) inherits browser history, proxy and access-log, and `Referer` exposure.

## Visiban-specific patterns to check on every run

- **Broadcast field leak.** For every field the feature adds to a payload that is broadcast, compare against what REST returns to each role. The existing precedent is `is_moderator` and `is_site_admin` on `member.*` frames, stripped in `BoardConsumer.board_event` and again in `BoardEventSerializer.to_representation`. A new role-gated field needs the same two gates, plus the group channel if the payload also goes through `broadcast_group_event`. Role-gated fields are the highest-risk class: check whether the payload's serializer context resolves the role of the actor who triggered the event rather than the role of each subscriber.
- **Credentials in URLs.** If the feature mints a token that travels in a URL, specify entropy, expiry, rotation, revocation, who may read it back (REST, broadcast, feed, logs), and any per-token throttle.
- **Consume-once tokens.** Invite, registration and ticket redemption must be claimed atomically at the point of validation (`select_for_update()` or a conditional `UPDATE ... WHERE used_at IS NULL` checked by row count), not validated at one step and redeemed at another. See root `CLAUDE.md` § Secure code. Require a concurrent-redemption test.
- **Anonymous read surfaces.** For each public route: what is the credential, how is it revoked, which serializer bounds the payload (for example `PublicBoardSerializer`), what is deliberately excluded (PII, members, comments, history, attachments), what throttle applies (`ShareLinkThrottle`, `ShareLinkTokenThrottle`), and whether the response is cacheable by a shared proxy. The Issue Board Lens (`backend/git_lens/`) is authenticated today; a planned shareable lens would become a new anonymous surface and must go through this section.
- **Shared caches across principals.** Any cache keyed without the viewer (the GitLab lens board cache in `git_lens/views.py` `_board_cache_key`) must contain only data that every viewer may see. Keys that include user-controlled free text need an unambiguous preimage and a full digest.
- **Outbound fetch (SSRF).** Any server-side request built from user-controlled input must validate the input to a strict grammar and pin the host (see `LensConnectionSerializer.validate_repo_slug` and the fixed `GITLAB_BASE`/`api.github.com` hosts). Per-user OAuth tokens may be sent only to the pinned host and must never be logged.
- **Demo-instance fencing.** If the feature adds a write path, check it against `DEMO_ALLOWED_WRITES` in `backend/visiban/demo.py` and `DemoModeMiddleware` in `backend/visiban/middleware.py`; the fence is deny-by-default and a published demo login must not be able to own anything through the new path. Also check outbound fetches and email sends for abuse amplification on a public demo.
- **Extension-point inputs.** Enterprise callbacks receive and return data across the OSS boundary; validate their return values before they reach serializers, the database or the channel layer.
- **Account-state parity.** REST and WebSocket must apply the same pending-password-change, pending-username-change and revoked-credential rules (`accounts/ws_auth.py`; `docs/development/security-invariants.md`).

## Output

Return one document with these sections:

1. **Asset inventory.** Each asset with a sensitivity class (public, internal, confidential, restricted).
2. **Trust boundary diagram.** ASCII or Mermaid, every crossing labeled with its credential and validator.
3. **STRIDE matrix.** One row per asset and threat. Each cell is a mitigation with a file reference, `GAP: <what is missing>`, or `accepted-risk: <reason>`.
4. **Top risks.** Up to five, ranked by likelihood times impact, each with a severity (high, medium, low), concrete evidence (`path:line`), and a proposed mitigation.
5. **Decisions for the architect.** Open questions whose answers change the design (for example "may a viewer read the share URL?", "is the demo allowed to call this endpoint?").
6. **Surfaces checked.** Which security-invariant rows and which of the patterns above were walked, and which were not applicable. An empty "found nothing" is a valid result only if this list shows what was examined.

Rules for the output: cite real files and lines only; mark anything you could not verify as unverified rather than inferring it; no severity inflation; and if a finding describes an exploitable flaw in code that already shipped, do not put it in a public artifact (commit message, changelog, docs, public issue). Report it to the maintainer for confidential handling.

## Relationship to other gates

- `security-review` audits the diff once code exists; this skill runs earlier and finds flaws no diff review would, because the flaw is in the design.
- `rbac-check` verifies role enforcement per action; this skill asks whether the role model itself covers the new surface.
- `architect` consumes this output; the threat model never replaces it.
- A model of a feature that has already shipped (a retroactive pass) is useful but follows the same output format and the same confidentiality rule above.
