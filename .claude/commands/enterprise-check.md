# Enterprise Boundary Check

You are evaluating whether a feature belongs in the OSS repo (`visiban/visiban`) or the enterprise repo (`visiban/visiban-enterprise`). This is a judgment call with real dual-licensing implications — getting it wrong means either giving away enterprise value or locking out users who need the feature to do basic work.

## The guiding principle

**"Can a small team use Visiban end-to-end without this feature?"**

- If **no** → OSS core. Flag it and suggest moving it there.
- If **yes** → enterprise candidate.

A "small team" means: creating boards, managing cards across swimlanes, collaborating with colleagues, and tracking progress through stages. If the feature is necessary for that workflow, it belongs in OSS.

## What to do

Given the feature described in `$ARGUMENTS`:

### 1. Classify the feature

Apply the guiding principle and check against known category examples:

**OSS core (belongs in `visiban/visiban`):**
- Board, column, swimlane, card management
- Drag-and-drop, card movement, position management
- Labels, priorities, due dates, assignees, checklists
- Comments and card activity history
- Real-time updates (WebSocket)
- Basic analytics visible to all members
- OAuth login (Google, GitHub, GitLab)
- RBAC (admin/member/viewer roles on boards)
- Groups and subgroups with inherited RBAC
- Notifications
- Import/export of board data
- Public API for automation

**Enterprise (`visiban/visiban-enterprise` only):**
- SSO / SAML
- Audit logs
- Advanced analytics (velocity, dwell time, bottleneck reports beyond basic)
- Automation rules (trigger-based card movement, notifications)
- Integrations with external services (Slack, Jira, webhooks)
- Multi-tenancy / white-labeling
- Compliance tooling
- Advanced permission models (field-level, time-based)

### 2. Check for grey areas

If the feature has both an OSS and enterprise tier (e.g. basic analytics in OSS, advanced in enterprise):
- Define the OSS boundary explicitly — what is included, what is not
- Ensure the OSS implementation is genuinely useful on its own, not artificially crippled
- Document the distinction in the feature's docs page

### 3. Check for extension points

If the feature is enterprise but requires OSS hooks:
- The OSS repo should expose clean extension points (settings includes, URL patterns, signal hooks)
- The enterprise repo plugs in without modifying OSS files
- Identify what extension points are needed and whether they already exist

### 4. Output

State clearly:
- **OSS** / **Enterprise** / **Split** (OSS base + enterprise extension)
- One-paragraph rationale applying the guiding principle
- If enterprise: what OSS extension points are needed
- If grey area: where the OSS/enterprise boundary sits and why
- If the classification conflicts with the current plan: flag it explicitly and recommend reconsideration

## Rules — non-negotiable

- Never add enterprise code to the OSS repo — enterprise features live exclusively in `visiban/visiban-enterprise`
- Never artificially move an essential feature to enterprise — if a small team needs it to work, it belongs in OSS
- If in doubt, default to OSS and document the reasoning
