"""
Templates 6-10 for generate_seed_data.py.

Loaded via importlib from generate_seed_data.py — do not run directly.
"""

from datetime import datetime, timedelta, timezone

ANCHOR = datetime(2026, 3, 15, 12, 0, 0, tzinfo=timezone.utc)


def _date(days_from_anchor: int) -> str:
    return (ANCHOR + timedelta(days=days_from_anchor)).strftime("%Y-%m-%d")


def _c(title, col, lane, pri, due_offset, weight, labels, checklist, comments=None, desc=""):
    return {
        "title": title,
        "description": desc,
        "priority": pri,
        "column": col,
        "swimlane": lane,
        "due_date": _date(due_offset) if due_offset is not None else None,
        "weight": weight,
        "labels": list(labels),
        "checklist": list(checklist),
        "comments": list(comments or []),
    }


def _chk(*items):
    out = []
    for item in items:
        if item.startswith("+"):
            out.append({"text": item[1:].strip(), "is_checked": True})
        else:
            out.append({"text": item.strip(), "is_checked": False})
    return out


def _cmt(body, author="demo1"):
    return {"body": body, "author": author}


# ═════════════════════════════════════════════════════════════════════════════
# 6. Project Delivery
# ═════════════════════════════════════════════════════════════════════════════
PROJECT_DELIVERY = {
    "slug": "project_delivery",
    "name": "Template: Project Delivery",
    "description": "Track cross-functional projects from planning through retrospective. Each swimlane is a project; each card is a deliverable or milestone.",
    "columns": [
        {"name": "Planning",          "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Kickoff",           "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Execution",         "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Milestone Review",  "position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Wrap-up",           "position": 4, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Retro",             "position": 5, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Mobile App Relaunch",          "position": 0, "color": "#EC4899", "contact_email": "pm-mobile@example.com",   "notes": "Full redesign + new feature set. Q2 launch target. Sponsor: VP Product."},
        {"name": "Data Platform Migration",      "position": 1, "color": "#3B82F6", "contact_email": "pm-data@example.com",     "notes": "Migrate from Redshift to Snowflake. 3 TB data. Zero-downtime required."},
        {"name": "Security Compliance Audit",    "position": 2, "color": "#EF4444", "contact_email": "ciso@example.com",        "notes": "SOC 2 Type II audit. Auditor engaged. Evidence collection deadline: end of Q2."},
        {"name": "Customer Portal v2",           "position": 3, "color": "#10B981", "contact_email": "pm-portal@example.com",   "notes": "Self-service portal for invoices, usage, support. Design approved, dev in progress."},
        {"name": "GDPR Deletion Pipeline",       "position": 4, "color": "#8B5CF6", "contact_email": "privacy@example.com",     "notes": "Automate right-to-erasure requests. Legal deadline: 90 days from receipt."},
    ],
    "labels": [
        {"name": "On Track",    "color": "#10B981"},
        {"name": "At Risk",     "color": "#F59E0B"},
        {"name": "Blocked",     "color": "#EF4444"},
        {"name": "Milestone",   "color": "#3B82F6"},
        {"name": "Dependency",  "color": "#8B5CF6"},
    ],
    "extra_cards": [
        # Mobile App Relaunch
        _c("Define MVP feature set and success metrics", "Retro", "Mobile App Relaunch", "high", -20, 5, ["Milestone"],
           _chk("+Stakeholder alignment workshop", "+Feature list reviewed with eng", "+Metrics defined (DAU, retention)", "+OKRs signed off"),
           [_cmt("MVP scope locked to 8 core features. Stretch goal of offline mode deferred to v2.1.", "demo1"),
            _cmt("OKR: 20% increase in DAU within 60 days of launch. Agreed.", "demo3")],
           desc="Define the minimum viable feature set for the mobile app relaunch and the success metrics that will determine if the relaunch is successful. Requires cross-functional alignment."),
        _c("UX research synthesis — navigation patterns", "Retro", "Mobile App Relaunch", "high", -10, 4, ["Milestone"],
           _chk("+6 user interviews completed", "+Affinity mapping done", "+3 navigation concepts prototyped", "+Winning pattern selected"),
           [_cmt("Bottom tab navigation won across all user segments. Hamburger menu eliminated entirely.", "demo2")],
           desc="Synthesize findings from 6 user interviews into actionable navigation design decisions. Three prototypes tested; bottom tab navigation selected."),
        _c("Beta release to 500 internal testers", "Milestone Review", "Mobile App Relaunch", "high", 5, 6, ["Milestone"],
           _chk("+TestFlight and Play Console beta tracks configured", "+500 testers invited", "Crash rate < 0.5% gate passed", "Feedback survey distributed"),
           [_cmt("Crash rate is 0.9% right now — one known issue with deep links. Fix in review.", "demo4")],
           desc="Internal beta release to 500 employees and trusted users. Gate criteria: crash rate below 0.5%, P1 bugs zero. Feedback survey required before moving to public beta."),
        _c("App store submission and release notes", "Execution", "Mobile App Relaunch", "medium", 18, 3, ["Milestone"],
           _chk("Write App Store and Play Store release notes", "Prepare app store screenshots", "Submit for review", "Plan launch announcement"),
           desc="Prepare and submit app store listings including screenshots, release notes, and promotional text. Coordinate with marketing for launch announcement timing."),

        # Data Platform Migration
        _c("Schema mapping: Redshift → Snowflake", "Retro", "Data Platform Migration", "high", -30, 6, ["Milestone"],
           _chk("+Inventoried 142 tables", "+Mapped all data types", "+Identified 11 incompatible columns", "+Migration scripts written"),
           [_cmt("11 columns needed type conversion — mostly Redshift SUPER to Snowflake VARIANT. Scripts tested on staging.", "demo2"),
            _cmt("Staging migration completed in 4h 22m. Production estimate: 6-8h with parallel loads.", "demo1")],
           desc="Full schema mapping from Redshift to Snowflake for all 142 tables. 11 type incompatibilities resolved. Migration scripts validated on staging."),
        _c("ELT pipeline cutover — dbt models", "Execution", "Data Platform Migration", "high", 8, 7, ["Dependency"],
           _chk("+Redshift dbt models ported to Snowflake SQL dialect", "+All 67 models tested", "Cutover dry run on staging", "Production cutover scheduled"),
           [_cmt("3 models needed CTEs rewritten due to Redshift-specific windowing syntax. All passing now.", "demo3")],
           desc="Port all 67 dbt models from Redshift SQL dialect to Snowflake. Models must produce identical output — validated by row count and checksum comparison on staging data."),
        _c("Historical data validation — row counts and checksums", "Milestone Review", "Data Platform Migration", "medium", 12, 5, ["Milestone"],
           _chk("+Row count comparison automated", "+Checksum spot-check on 15 tables", "Sign-off from data team lead", "Business user UAT"),
           [_cmt("Row counts match to 4 decimal places. Two tables have rounding differences in float columns — acceptable per data team.", "demo1")],
           desc="Validate migrated data quality by comparing row counts and checksums between Redshift and Snowflake. Business user UAT required before decommissioning Redshift."),
        _c("Decommission Redshift cluster", "Planning", "Data Platform Migration", "medium", 35, 3, ["Dependency"],
           _chk("Confirm zero active queries for 30 days", "Archive final snapshots to S3", "Submit cloud cost savings report", "Remove IAM roles and network rules"),
           desc="Decommission the Redshift cluster after a 30-day quiet period post-migration. Final snapshots archived to S3. Estimated $8,400/month cost saving."),

        # Security Compliance Audit
        _c("Access control evidence collection", "Execution", "Security Compliance Audit", "high", 7, 5, ["Milestone"],
           _chk("+Exported IAM role assignments", "+MFA enrollment report (98.6%)", "Privilege access review signed off", "Auditor evidence package submitted"),
           [_cmt("Two service accounts missing MFA — they're API-only but auditor wants documented exception.", "demo4"),
            _cmt("Exception documentation drafted. Waiting for CISO sign-off.", "demo2")],
           desc="Collect and package access control evidence for SOC 2 auditor: IAM role exports, MFA enrollment report, privileged access review. Two service account exceptions require CISO sign-off."),
        _c("Penetration test — external perimeter", "Milestone Review", "Security Compliance Audit", "high", 10, 6, ["Milestone"],
           _chk("+Scope signed: 4 public endpoints + admin portal", "+Pentest firm engaged (CrowdStrike)", "+Testing window complete", "Findings report reviewed"),
           [_cmt("3 medium findings, 0 critical, 0 high. All 3 mediums have mitigations in progress.", "demo1")],
           desc="External penetration test of the 4 public API endpoints and admin portal. Performed by CrowdStrike. 3 medium findings identified; all have active mitigation work."),
        _c("Incident response plan — tabletop exercise", "Retro", "Security Compliance Audit", "medium", -5, 4, ["Milestone"],
           _chk("+IR plan written and reviewed", "+Tabletop scenario: ransomware on CI/CD", "+Tabletop scenario: data breach", "+Debrief completed, gaps documented"),
           [_cmt("Key gap: we had no clear owner for external communications during an incident. Now assigned to VP Marketing with CISO backup.", "demo3")],
           desc="Tabletop exercise to validate the incident response plan with two scenarios: ransomware on CI/CD infrastructure and a customer data breach. Debrief identified communication ownership gap."),
        _c("Vendor risk assessments — top 10 vendors", "Kickoff", "Security Compliance Audit", "medium", 20, 3, ["Dependency"],
           _chk("Identify top 10 vendors by data access", "Send vendor questionnaires", "Review responses and score risk", "Escalate high-risk vendors to CISO"),
           desc="SOC 2 requires evidence of vendor risk management. Assess top 10 vendors by data access level using a standardized questionnaire. High-risk vendors reviewed with CISO."),

        # Customer Portal v2
        _c("Invoice download and history UI", "Execution", "Customer Portal v2", "high", 9, 5, ["Milestone"],
           _chk("+API endpoint for invoice list complete", "+PDF generation service integrated", "Frontend invoice history component done", "Accessibility audit passed"),
           [_cmt("PDF service is Puppeteer-based — rendering at ~1.2s per invoice. Acceptable for now but will optimize post-launch.", "demo2")],
           desc="Invoice download feature for the customer portal. Customers can view and download all invoices as PDFs. PDF generation via Puppeteer with caching layer."),
        _c("Usage dashboard — seats and API calls", "Milestone Review", "Customer Portal v2", "medium", 14, 4, ["Milestone"],
           _chk("+Data model for usage snapshots finalized", "+API aggregation queries optimized", "+Charts built (Recharts)", "User acceptance testing with 3 pilot customers"),
           [_cmt("Two pilot customers tested yesterday. Both loved the seat utilization chart. API usage chart needs a time range selector — adding it now.", "demo4")],
           desc="Usage dashboard showing seat utilization and API call volume over time. Built with Recharts. Pilot testing with 3 customers before GA."),
        _c("Support ticket submission flow", "Kickoff", "Customer Portal v2", "medium", 25, 3, ["Dependency"],
           _chk("Design form (category, severity, description, attachments)", "Wire to Zendesk API", "Confirm acknowledgment email flow", "Test with support team"),
           desc="Self-service support ticket submission in the portal, wired to Zendesk. Customers can submit tickets without emailing support@. Requires Zendesk API token configuration."),
        _c("SSO deep-link for portal (SAML assertions)", "Planning", "Customer Portal v2", "medium", 40, 4, ["Dependency"],
           _chk("Define SAML assertion attributes needed", "Implement SP-initiated SSO for portal", "Test with Okta and AzureAD", "Document customer setup steps"),
           desc="Enterprise customers need SSO deep-link support so employees land directly in the portal after authenticating via their IdP. SP-initiated SSO with Okta and AzureAD support."),

        # GDPR Deletion Pipeline
        _c("Deletion request intake API", "Retro", "GDPR Deletion Pipeline", "high", -15, 5, ["Milestone"],
           _chk("+API endpoint designed and reviewed", "+Identity verification step added", "+Request stored in deletion_requests table", "+Privacy team signed off"),
           [_cmt("Added identity verification step — caller must prove ownership of the email before deletion proceeds.", "demo1"),
            _cmt("Privacy team approved the flow. DSAR intake now fully automated.", "demo3")],
           desc="API endpoint to receive right-to-erasure requests, verify the requester's identity, and store the request in the deletion_requests queue for async processing."),
        _c("Cross-service deletion orchestrator", "Execution", "GDPR Deletion Pipeline", "high", 6, 7, ["Milestone"],
           _chk("+Deletion tasks fanned out to 6 services (auth, boards, analytics, billing, email, logs)", "+Completion callbacks implemented", "90-day SLA timer validated", "Audit log of each deletion step"),
           [_cmt("The analytics service deletion is the slowest — S3 event logs need a backfill job to locate user events by user_id.", "demo2")],
           desc="Orchestrator service fans deletion requests out to 6 downstream services (auth, boards, analytics, billing, email, logs) and aggregates completion callbacks. 90-day SLA enforced."),
        _c("Deletion audit report — per-request evidence", "Milestone Review", "GDPR Deletion Pipeline", "medium", 12, 4, ["Milestone"],
           _chk("+Audit log schema finalized", "+Report generation endpoint built", "DPA review of report format", "Test with sample deletion request"),
           [_cmt("DPA wants a timestamp for each downstream service's confirmation, not just a final completion timestamp. Updating schema.", "demo4")],
           desc="Generate a per-request audit report showing exactly which data was deleted from which service and when. Required evidence for GDPR compliance and DPA audits."),
        _c("Suppression list for marketing after deletion", "Planning", "GDPR Deletion Pipeline", "medium", 30, 3, ["Dependency"],
           _chk("Define suppression list schema in email service", "Wire deletion pipeline to add email to suppression list", "Verify re-subscribe is blocked", "Test with Mailchimp and SendGrid"),
           desc="After a deletion request completes, the user's email must be added to the marketing suppression list to prevent future re-contact, even if re-imported from a third-party list."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# 7. Content Production
# ═════════════════════════════════════════════════════════════════════════════
CONTENT_PRODUCTION = {
    "slug": "content_production",
    "name": "Template: Content Production",
    "description": "Manage content from idea through publication. Each swimlane is a content type; each card is a piece of content.",
    "columns": [
        {"name": "Idea",             "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Assigned",         "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Draft",            "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Internal Review",  "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Edits",            "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Final Approval",   "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
        {"name": "Scheduled",        "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Published",        "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Blog Posts",             "position": 0, "color": "#3B82F6", "contact_email": "blog@example.com",       "notes": "Long-form SEO content. Target: 2 posts/week. Owner: content team."},
        {"name": "Case Studies",           "position": 1, "color": "#10B981", "contact_email": "stories@example.com",    "notes": "Customer stories. Requires customer approval. 4-6 week production time."},
        {"name": "Video & Webinars",       "position": 2, "color": "#EC4899", "contact_email": "video@example.com",      "notes": "Product demos, thought leadership webinars, YouTube tutorials."},
        {"name": "Email & Newsletter",     "position": 3, "color": "#F59E0B", "contact_email": "email@example.com",      "notes": "Weekly newsletter, drip sequences, product announcements. Audience: 28,000."},
        {"name": "Social & Short-form",    "position": 4, "color": "#8B5CF6", "contact_email": "social@example.com",     "notes": "Twitter/X, LinkedIn, short-form video (TikTok, Reels). 2-3 posts/day."},
    ],
    "labels": [
        {"name": "SEO",         "color": "#3B82F6"},
        {"name": "Thought Leadership", "color": "#8B5CF6"},
        {"name": "Product",     "color": "#10B981"},
        {"name": "Customer",    "color": "#F59E0B"},
        {"name": "Event",       "color": "#EC4899"},
    ],
    "extra_cards": [
        # Blog Posts
        _c("\"How we cut API latency by 80%\" — technical deep dive", "Published", "Blog Posts", "high", -12, 4, ["SEO", "Thought Leadership"],
           _chk("+Outline approved", "+Draft complete (2,400 words)", "+Edited — 1 round", "+SEO review: 3 target keywords", "+Published to blog"),
           [_cmt("This post hit 4,200 views in 48 hours — best performing technical post this quarter.", "demo1"),
            _cmt("HN front page for 6 hours. Linking it to the docs and changelog.", "demo3")],
           desc="Technical deep dive on the N+1 query fix and cursor-based pagination improvements. Target keywords: API performance, Django query optimization. 2,400 words."),
        _c("\"Kanban vs Scrum: which fits your team?\" — SEO pillar", "Edits", "Blog Posts", "medium", 4, 5, ["SEO"],
           _chk("+Keyword research: 12,000 monthly searches", "+Outline approved", "+Draft complete (3,100 words)", "Second edit pass", "SEO check — add FAQ section"),
           [_cmt("Good draft but needs a clearer CTA at the end. Added comments in the doc.", "demo2")],
           desc="SEO pillar post targeting 'kanban vs scrum' keyword cluster (12k monthly searches). Long-form comparison targeting teams evaluating project management methods."),
        _c("\"5 ways to use swimlanes beyond customers\" — use case post", "Draft", "Blog Posts", "medium", 10, 3, ["SEO", "Product"],
           _chk("+Topic approved", "+Outline done", "First draft in progress — 60% done", "Internal review"),
           desc="Use case post showing creative applications of swimlanes: projects, time periods, risk tiers, teams, and kanban stages within stages. Targets existing users and trial signups."),
        _c("\"Building a remote-first team process\" — thought leadership", "Idea", "Blog Posts", "low", 30, 2, ["Thought Leadership"],
           _chk("Validate angle with marketing lead", "Research — 3 data sources", "Outline"),
           desc="Thought leadership post on remote team processes, featuring Visiban as the backbone tool. Needs an authentic angle — brief founder for quotes."),

        # Case Studies
        _c("TechNova Inc — from Jira to Visiban in 30 days", "Published", "Case Studies", "high", -18, 5, ["Customer"],
           _chk("+Customer interview completed", "+Draft approved by TechNova marketing", "+Design and layout done", "+Published to /customers page", "+Shared in newsletter"),
           [_cmt("TechNova saw 34% reduction in cycle time after switching. Lead gen form on the page converting at 8.2%.", "demo4"),
            _cmt("Best performing case study ever. Requesting follow-up video version.", "demo1")],
           desc="TechNova case study covering their migration from Jira, onboarding process, and outcomes (34% cycle time reduction). Customer approved all quotes and statistics."),
        _c("BlueSky Health — HIPAA-compliant project management", "Final Approval", "Case Studies", "high", 2, 6, ["Customer"],
           _chk("+Interview transcript approved", "+Draft written", "+Customer legal review — 2 rounds", "Final sign-off from BlueSky CMO", "Schedule publication"),
           [_cmt("Legal review flagged one statistic — changed 'cut costs 40%' to 'reduced project overhead'. Now awaiting CMO sign-off.", "demo2")],
           desc="BlueSky Health case study focused on HIPAA-compliant use and healthcare project coordination. Required two rounds of legal review. Pending CMO sign-off before publication."),
        _c("Mosaic Creative — 30-person agency using swimlanes per client", "Internal Review", "Case Studies", "medium", 8, 4, ["Customer"],
           _chk("+Initial draft complete", "Marketing team review", "Share draft with Mosaic for fact-check", "Final approval"),
           [_cmt("Mosaic's story is genuinely compelling — 30 clients each as a swimlane, real-time visibility for their whole team.", "demo3")],
           desc="Mosaic Creative case study on using swimlanes to manage 30 simultaneous client campaigns. Unique use case that will resonate with agency prospects."),
        _c("FinEdge Ltd — compliance-tracking board for fintech", "Assigned", "Case Studies", "medium", 20, 3, ["Customer"],
           _chk("Schedule kick-off call with FinEdge contact", "Prepare interview guide (10 questions)", "Submit for customer approval workflow"),
           desc="FinEdge case study on using Visiban to track compliance tasks and regulatory filings. Will highlight the checklist and due date features. Interview not yet scheduled."),

        # Video & Webinars
        _c("Product demo: new board pan + keyboard shortcuts", "Published", "Video & Webinars", "medium", -8, 3, ["Product"],
           _chk("+Script written", "+Screen recording done (4 min)", "+Edited and captioned", "+Published to YouTube + embedded in docs"),
           [_cmt("3,400 views in the first week. Adding it to the onboarding email sequence.", "demo1")],
           desc="Short product demo video covering the Space+drag pan feature and keyboard shortcut improvements. 4 minutes. Published to YouTube and embedded in the changelog."),
        _c("Webinar: \"Running customer success teams with Kanban\"", "Scheduled", "Video & Webinars", "high", 7, 5, ["Thought Leadership", "Event"],
           _chk("+Speaker confirmed: Kelly + guest from TechNova", "+Registration page live — 340 signups", "+Slide deck complete", "Run dry-run the day before", "Post recording within 24h"),
           [_cmt("340 registrations already and we haven't sent the second reminder yet. Expecting 500+ by the date.", "demo4")],
           desc="Live webinar featuring a Visiban customer discussing how they run their CS team with Kanban. 340 registrations so far. Recording will be gated behind email signup."),
        _c("Tutorial series: \"Visiban for beginners\" — Episode 3", "Edits", "Video & Webinars", "medium", 5, 4, ["Product"],
           _chk("+Raw recording done (18 min)", "+Episode 1 and 2 published", "Edit pass — trim to 12 min", "Add lower thirds and chapters"),
           [_cmt("Episode 1 and 2 are averaging 1,800 views each. Episode 3 covers card detail, comments, and checklists.", "demo2")],
           desc="Episode 3 of the beginner tutorial series. Covers card detail view, comments, checklists, and due dates. Target length: 12 minutes post-editing."),
        _c("\"Visiban vs competitors\" — YouTube comparison video", "Idea", "Video & Webinars", "low", 45, 3, ["SEO"],
           _chk("Decide on comparison framing (fair, feature-by-feature)", "Legal review of competitor names in video"),
           desc="YouTube comparison video targeting 'visiban vs [competitor]' search queries. Needs a fair, factual framing. Legal must review before production starts."),

        # Email & Newsletter
        _c("April newsletter — product updates + case study feature", "Draft", "Email & Newsletter", "medium", 3, 3, ["Product"],
           _chk("+Content plan approved", "+TechNova case study teaser written", "Product update section drafted", "Subject line A/B test variants"),
           desc="April newsletter for 28,000 subscribers. Features the TechNova case study, Space+drag pan feature update, and a teaser for the upcoming webinar."),
        _c("Onboarding drip — Day 7: advanced swimlane tips", "Published", "Email & Newsletter", "medium", -22, 4, ["Product"],
           _chk("+Copy written and reviewed", "+Personalization tokens tested", "+Sent to 12,400 Day-7 users", "+Open rate: 38.2%, CTR: 6.1%"),
           [_cmt("38.2% open rate — highest in the drip sequence. The swimlane tips resonated. Repurposing as a blog post.", "demo3")],
           desc="Day 7 onboarding email teaching advanced swimlane usage. Open rate 38.2%, CTR 6.1% — best in the sequence. Tips being repurposed as a blog post."),
        _c("Re-engagement campaign — users inactive > 30 days", "Internal Review", "Email & Newsletter", "high", 5, 5, ["Product"],
           _chk("+Audience segment defined (4,200 users)", "+3-email sequence drafted", "A/B test: value prop vs social proof angle", "Legal review — unsubscribe compliance"),
           [_cmt("Segment is 4,200 users. Testing 'here's what you're missing' vs 'TechNova uses Visiban for this' angles.", "demo1")],
           desc="Re-engagement email sequence for 4,200 users inactive for 30+ days. Three-email sequence. A/B testing value proposition framing versus social proof framing."),
        _c("Product launch email — Groups feature announcement", "Assigned", "Email & Newsletter", "high", 12, 4, ["Product"],
           _chk("Coordinate launch timing with product team", "Draft announcement email", "Write follow-up for non-openers", "Schedule send for launch day"),
           desc="Announcement email for the Groups feature launch. Coordinate timing with product team to send on the same day as the blog post and social push."),

        # Social & Short-form
        _c("LinkedIn carousel — \"10 Kanban metrics that matter\"", "Published", "Social & Short-form", "medium", -6, 3, ["Thought Leadership"],
           _chk("+10 slides designed", "+Copy reviewed", "+Posted to LinkedIn company page", "+Shared by 3 team members"),
           [_cmt("Carousel hit 8,400 impressions. Highest organic reach this month. Repurposing as a blog post outline.", "demo2")],
           desc="10-slide LinkedIn carousel on Kanban metrics: cycle time, throughput, WIP age, lead time, blocked rate, flow efficiency, MTTR, escaped defects, velocity, predictability."),
        _c("Twitter/X thread — launch of Space+drag pan feature", "Scheduled", "Social & Short-form", "medium", 1, 2, ["Product"],
           _chk("+8-tweet thread written", "+GIF recorded (Space+drag demo)", "Scheduled in Buffer for 9am ET launch day"),
           [_cmt("Thread links to the changelog and the YouTube demo. Scheduling for same hour as blog post publish.", "demo4")],
           desc="Twitter/X thread announcing the Space+drag pan feature. 8 tweets with a GIF demo. Coordinated with blog post and YouTube demo publication."),
        _c("Short-form video — \"Visiban in 60 seconds\" for TikTok/Reels", "Edits", "Social & Short-form", "medium", 4, 3, ["Product"],
           _chk("+Storyboard approved (6 scenes)", "+Screen capture recorded", "Voice-over recorded", "Edit + captions + subtitles"),
           [_cmt("Quick 60-second hook-style video showing drag-and-drop, swimlane collapse, and card filter. Good for top-of-funnel.", "demo1")],
           desc="60-second product showcase video for TikTok and Instagram Reels format. Hook-style opening, showing drag-and-drop, swimlane collapse, and card filter in rapid cuts."),
        _c("LinkedIn thought leadership — CEO post series (3 posts)", "Draft", "Social & Short-form", "medium", 8, 4, ["Thought Leadership"],
           _chk("+Topics approved by CEO: async work, kanban adoption, team visibility", "Draft post 1: async work culture", "Draft post 2: why kanban beats standups", "Draft post 3: the visibility problem"),
           desc="Ghost-writing 3 LinkedIn posts for the CEO on async work culture, kanban adoption, and team visibility. Posts go out weekly, starting next Monday."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# 8. Hiring & Recruiting
# ═════════════════════════════════════════════════════════════════════════════
HIRING_RECRUITING = {
    "slug": "hiring_recruiting",
    "name": "Template: Hiring & Recruiting",
    "description": "Track candidates from application through offer. Each swimlane is an open role; each card is a candidate.",
    "columns": [
        {"name": "Applied",           "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Phone Screen",      "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Technical Screen",  "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "Interview",         "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Reference Check",   "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Offer Extended",    "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
        {"name": "Hired",             "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Rejected",          "position": 7, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Senior Backend Engineer",       "position": 0, "color": "#3B82F6", "contact_email": "hiring-eng@example.com",     "notes": "5+ yrs Python/Django. Remote-friendly. Comp: $160-190k. Backfill for Jordan who leaves end of April."},
        {"name": "Product Designer (Senior)",     "position": 1, "color": "#EC4899", "contact_email": "hiring-design@example.com",  "notes": "Strong systems thinking. Figma expert. Comp: $140-170k. New headcount approved Q1."},
        {"name": "Customer Success Manager",      "position": 2, "color": "#10B981", "contact_email": "hiring-cs@example.com",      "notes": "3+ yrs SaaS CS. Owns onboarding + retention. Comp: $90-110k + commission. Priority hire."},
        {"name": "DevOps Engineer",               "position": 3, "color": "#F59E0B", "contact_email": "hiring-devops@example.com",  "notes": "Kubernetes, Terraform, GitLab CI. Comp: $140-165k. Start date target: Q2."},
        {"name": "Head of Marketing",             "position": 4, "color": "#8B5CF6", "contact_email": "hiring-mktg@example.com",    "notes": "PLG experience required. B2B SaaS background. Comp: $160-190k + equity. Reports to CEO."},
    ],
    "labels": [
        {"name": "Strong Yes",   "color": "#10B981"},
        {"name": "Yes",          "color": "#3B82F6"},
        {"name": "Maybe",        "color": "#F59E0B"},
        {"name": "No",           "color": "#EF4444"},
        {"name": "Referral",     "color": "#8B5CF6"},
    ],
    "extra_cards": [
        # Senior Backend Engineer
        _c("Alex M. — 6 yrs Django, contributed to DRF", "Hired", "Senior Backend Engineer", "high", -8, 5, ["Strong Yes", "Referral"],
           _chk("+Resume reviewed", "+Phone screen: strong Django fundamentals", "+Take-home: excellent (score 9/10)", "+Panel interview: team loved the systems design answer", "+References: glowing from 2 refs", "+Offer accepted: $178k + equity"),
           [_cmt("Alex's DRF contribution is exactly the level we need. Panel was unanimous. Offer accepted.", "demo1"),
            _cmt("Start date confirmed: April 14. IT onboarding ticket filed.", "demo3")],
           desc="Alex M. — 6 years Django/DRF, open-source contributor to DRF. Referral from Jordan. Panel interview unanimous. Hired at $178k. Start date April 14."),
        _c("Sam K. — 4 yrs Python, Celery expert", "Rejected", "Senior Backend Engineer", "medium", -15, 3, ["No"],
           _chk("+Phone screen: passed", "+Take-home submitted", "+Take-home: concerning patterns (no tests, mutable defaults)", "+Passed on — feedback sent"),
           [_cmt("Take-home had no tests and used mutable default arguments in 3 places. Can't move forward at the senior level.", "demo2")],
           desc="Sam K. — 4 years Python, strong Celery background. Take-home submission lacked tests and had multiple anti-patterns. Feedback provided; passed on."),
        _c("Morgan T. — Staff engineer, Django + Rust background", "Reference Check", "Senior Backend Engineer", "high", 3, 6, ["Strong Yes"],
           _chk("+Resume screened", "+Phone screen: excellent", "+Technical screen: passed (top 10% score)", "+Panel interview: exceptional systems design", "Reference 1 confirmed", "Reference 2 pending"),
           [_cmt("Morgan's systems design discussion was the best we've seen this cycle. Two references in progress.", "demo4"),
            _cmt("Reference 1 returned: 'best engineer I've ever managed'. Waiting for reference 2.", "demo1")],
           desc="Morgan T. — staff-level engineer with Django and Rust background. Top 10% technical screen score. Panel interview exceptional. Two references in progress."),
        _c("Jamie L. — 5 yrs Django, current Jira refugee", "Interview", "Senior Backend Engineer", "medium", 5, 4, ["Yes"],
           _chk("+Phone screen passed", "+Technical screen passed", "Panel interview scheduled for Thursday", "Debrief and decision"),
           [_cmt("Jamie mentioned they're leaving because Jira's complexity is blocking their team. Good culture fit signal.", "demo2")],
           desc="Jamie L. — 5 years Django, currently at a company drowning in Jira complexity. Technical screen passed. Panel interview Thursday. Potential culture fit."),

        # Product Designer (Senior)
        _c("Riley N. — systems design lead at B2B SaaS", "Hired", "Product Designer (Senior)", "high", -5, 5, ["Strong Yes"],
           _chk("+Portfolio reviewed: excellent component library", "+Phone screen: articulate, good product sense", "+Design exercise: rated best this cycle", "+Panel: CEO loved the roadmap thinking", "+Offer accepted: $162k + equity"),
           [_cmt("Riley's design exercise showed exactly the level of systems thinking we need. Hired.", "demo3"),
            _cmt("Start date: April 7. Figma workspace access will be set up on day one.", "demo1")],
           desc="Riley N. — senior product designer with B2B SaaS background, strong component library and systems thinking. Hired at $162k. Start date April 7."),
        _c("Drew P. — strong visual design, weak systems", "Rejected", "Product Designer (Senior)", "medium", -20, 3, ["No"],
           _chk("+Portfolio reviewed", "+Phone screen passed", "+Design exercise submitted — visual quality high but lacks component thinking", "+Passed on"),
           [_cmt("Drew's visual work is beautiful but the exercise missed the systems layer entirely — no component inventory, no reuse. Not the right fit for a design system role.", "demo2")],
           desc="Drew P. — strong visual designer but the design exercise lacked systems and component thinking. Not a fit for the design system scope of this role."),
        _c("Taylor O. — design systems specialist, open-source tokens contributor", "Offer Extended", "Product Designer (Senior)", "high", 1, 5, ["Strong Yes", "Referral"],
           _chk("+Portfolio reviewed", "+Phone screen: excellent", "+Design exercise: 10/10, built a full token system", "+Panel: unanimous strong yes", "+References: both excellent", "Offer sent: $168k — awaiting response"),
           [_cmt("Taylor literally built a token system as their exercise response. Offer went out this morning.", "demo4")],
           desc="Taylor O. — design systems specialist, contributor to open design token standards. Built a complete token system as their exercise response. Offer extended at $168k."),
        _c("Casey B. — 4 yrs UX, no B2B SaaS experience", "Phone Screen", "Product Designer (Senior)", "low", 12, 2, ["Maybe"],
           _chk("+Resume reviewed — portfolio looks promising", "Phone screen scheduled for next week"),
           desc="Casey B. — 4 years UX experience primarily in consumer apps. Interesting portfolio but no B2B SaaS background. Phone screen to assess product sense and adaptability."),

        # Customer Success Manager
        _c("Jordan F. — 5 yrs CS at SaaS, churn reduction specialist", "Reference Check", "Customer Success Manager", "high", 2, 5, ["Strong Yes"],
           _chk("+Phone screen: excellent — immediate rapport", "+CS scenario interview: strong churn playbook", "+Panel: CS lead and AE both positive", "Reference 1 complete: outstanding", "Reference 2 pending"),
           [_cmt("Jordan reduced churn from 8% to 3% at previous company using a health-score model. Exactly what we need.", "demo1"),
            _cmt("Reference 1 back: 'best CSM I've managed in 10 years.' Waiting on reference 2.", "demo3")],
           desc="Jordan F. — 5 years CS, specialist in churn reduction. Reduced churn 8% → 3% at previous company using health-score model. References in progress."),
        _c("Avery C. — CS at PLG startup, strong onboarding focus", "Interview", "Customer Success Manager", "high", 4, 4, ["Yes"],
           _chk("+Phone screen passed", "+CS scenario interview passed", "Panel interview tomorrow — CS lead + head of product", "Debrief and decision"),
           [_cmt("Avery built the onboarding program from scratch at a 50-person PLG startup. Strong self-starter energy.", "demo2")],
           desc="Avery C. — CS at a PLG startup, built onboarding from scratch. Panel interview tomorrow. Self-starter background is a strong fit for a small team."),
        _c("Quinn W. — enterprise CS, high-touch accounts only", "Rejected", "Customer Success Manager", "medium", -10, 3, ["No"],
           _chk("+Phone screen passed", "+Scenario interview — struggled with tech-touch and low-touch motions", "+Passed on — not a fit for PLG"),
           [_cmt("Quinn's background is purely high-touch enterprise. We need someone comfortable with the full spectrum from self-serve to enterprise.", "demo4")],
           desc="Quinn W. — strong enterprise CS background but no experience with tech-touch or self-serve motions. Not a fit for our PLG model."),
        _c("Reese H. — CS ops background, Gainsight admin", "Phone Screen", "Customer Success Manager", "medium", 8, 3, ["Maybe"],
           _chk("+Resume reviewed", "Phone screen today at 2pm"),
           desc="Reese H. — CS operations background, Gainsight admin. Applying for the CSM role but background is more ops than client-facing. Phone screen to assess commercial instincts."),

        # DevOps Engineer
        _c("Blake T. — Kubernetes certified, GitLab CI expert", "Offer Extended", "DevOps Engineer", "high", 2, 5, ["Strong Yes"],
           _chk("+Technical screen: passed with top score", "+Systems design: excellent — designed multi-region HA deployment", "+References: both outstanding", "Offer sent: $158k — response expected by Friday"),
           [_cmt("Blake designed the multi-region HA setup on a whiteboard in real time. We've never seen anyone do that in a 45-minute interview.", "demo1")],
           desc="Blake T. — Kubernetes certified, GitLab CI expert. Designed multi-region HA deployment live in the interview. Outstanding references. Offer extended at $158k."),
        _c("Parker S. — 4 yrs Terraform, SRE background", "Technical Screen", "DevOps Engineer", "medium", 5, 4, ["Yes"],
           _chk("+Phone screen passed", "Technical screen scheduled for Wednesday — Terraform IaC exercise + Kubernetes scenario"),
           [_cmt("Parker's SRE background at a high-traffic e-commerce platform is relevant. Terraform skills look strong on paper.", "demo3")],
           desc="Parker S. — 4 years Terraform, SRE background at high-traffic e-commerce company. Technical screen this Wednesday."),
        _c("Rowan K. — DevOps at agency, lots of breadth, limited depth", "Rejected", "DevOps Engineer", "medium", -12, 2, ["No"],
           _chk("+Phone screen: enthusiastic but shallow Kubernetes knowledge", "+Passed on — not ready for lead role"),
           [_cmt("Good energy but Kubernetes knowledge was textbook-level — couldn't explain pod disruption budgets or affinity rules.", "demo2")],
           desc="Rowan K. — agency DevOps background, broad exposure but shallow on Kubernetes specifics. Not ready for the lead DevOps role we need."),
        _c("River M. — inbound application, AWS-heavy, learning GCP/Kubernetes", "Applied", "DevOps Engineer", "low", 20, 2, ["Maybe"],
           _chk("Resume review pending"),
           desc="River M. — strong AWS background, currently transitioning to Kubernetes/GCP. Resume received this week. May be a fit with ramp time."),

        # Head of Marketing
        _c("Sage D. — VP Marketing at B2B SaaS, PLG specialist", "Interview", "Head of Marketing", "high", 6, 6, ["Strong Yes"],
           _chk("+Portfolio reviewed — strong PLG track record", "+Phone screen: strategic, data-driven", "+Marketing strategy presentation done — CEO and CPO both impressed", "Panel interview next week — full exec team"),
           [_cmt("Sage's presentation covered a 12-month PLG growth plan with specific channel bets. CEO is very excited.", "demo4"),
            _cmt("This is the strongest candidate we've seen for the Head of Marketing role in two years of searching.", "demo1")],
           desc="Sage D. — VP Marketing at B2B SaaS, strong PLG track record. Delivered a 12-month growth plan in the strategy presentation. Full exec panel next week."),
        _c("Charlie H. — growth marketing lead, no leadership experience", "Rejected", "Head of Marketing", "medium", -18, 3, ["No"],
           _chk("+Phone screen: strong on channels, weak on strategy", "+Presentation: tactical, not strategic", "+Passed on — not ready for Head-of level"),
           [_cmt("Charlie knows channels well but couldn't articulate a positioning strategy. This role needs a strategic leader, not a practitioner.", "demo2")],
           desc="Charlie H. — growth marketing lead with strong channel execution but no strategic framing or leadership experience. Not ready for a Head of Marketing role."),
        _c("Finley A. — CMO at startup (exited), now consulting", "Reference Check", "Head of Marketing", "high", 4, 5, ["Yes"],
           _chk("+Phone screen: excellent — deep PLG and community experience", "+Strategy presentation: strong, community-led growth angle", "+Panel interview: positive, some hesitancy on stage of company", "Reference 1 pending", "Reference 2 pending"),
           [_cmt("Finley's community-led growth thesis is differentiated and compelling. Only question is whether they want to be in execution mode again after consulting.", "demo3")],
           desc="Finley A. — former CMO, now consulting. Strong PLG and community-led growth background. Panel interview positive; some uncertainty about commitment level post-consulting."),
        _c("Skyler R. — product marketing background, no demand gen", "Phone Screen", "Head of Marketing", "medium", 10, 3, ["Maybe"],
           _chk("+Resume reviewed — PMM experience at two SaaS companies", "Phone screen scheduled for Tuesday"),
           desc="Skyler R. — strong product marketing background at two SaaS companies, but no demand gen or brand experience. Phone screen to assess breadth."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# 9. Infrastructure & DevOps
# ═════════════════════════════════════════════════════════════════════════════
INFRA_DEVOPS = {
    "slug": "infra_devops",
    "name": "Template: Infrastructure & DevOps",
    "description": "Track infrastructure incidents, changes, and improvements. Each swimlane is a system; each card is a work item.",
    "columns": [
        {"name": "Reported",      "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Triaged",       "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Assigned",      "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
        {"name": "In Progress",   "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Testing",       "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
        {"name": "Change Window", "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
        {"name": "Deployed",      "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Verified",      "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "API Gateway",             "position": 0, "color": "#3B82F6", "contact_email": "oncall-api@example.com",     "notes": "Kong gateway in front of all public endpoints. SLO: 99.9% uptime, p95 < 200ms."},
        {"name": "PostgreSQL Cluster",      "position": 1, "color": "#F59E0B", "contact_email": "oncall-db@example.com",      "notes": "Primary + 2 replicas. RDS PostgreSQL 16. Nightly backups to S3. Point-in-time recovery enabled."},
        {"name": "CI/CD Pipeline",          "position": 2, "color": "#8B5CF6", "contact_email": "oncall-ci@example.com",      "notes": "GitLab CI on Kubernetes runners. Kaniko for image builds. p95 pipeline: 8 min."},
        {"name": "Object Storage (S3)",     "position": 3, "color": "#10B981", "contact_email": "oncall-storage@example.com", "notes": "AWS S3: attachments, backups, analytics exports. Versioning enabled. Cross-region replication to eu-west-1."},
        {"name": "Kubernetes Cluster",      "position": 4, "color": "#EC4899", "contact_email": "oncall-k8s@example.com",     "notes": "EKS 1.29. 3 node groups. HPA on API and worker deployments. Node count: 12."},
    ],
    "labels": [
        {"name": "Incident",    "color": "#EF4444"},
        {"name": "Change",      "color": "#3B82F6"},
        {"name": "Improve",     "color": "#10B981"},
        {"name": "Security",    "color": "#8B5CF6"},
        {"name": "Capacity",    "color": "#F59E0B"},
    ],
    "extra_cards": [
        # API Gateway
        _c("Kong rate-limit plugin — false positives on mobile clients", "Verified", "API Gateway", "high", -15, 5, ["Incident"],
           _chk("+Confirmed: mobile clients sharing IP via NAT hit global rate limit", "+Config change: switch to user-id header as rate key", "+Deployed to staging, no regressions", "+Production deployment complete", "+Monitoring 24h — zero further false positives"),
           [_cmt("Root cause: office NAT gateway sends all mobile client traffic from a single IP. Switched to X-User-ID header as the rate limit key.", "demo1"),
            _cmt("24h post-fix: zero 429s from legitimate users. Incident closed.", "demo3")],
           desc="Kong rate-limit plugin was triggering false 429s on mobile clients sharing a NAT IP. Fix: switched rate-limit key from IP to X-User-ID header. Deployed and verified."),
        _c("Upgrade Kong from 3.3 to 3.6 — CVE-2024-2087 patch", "Deployed", "API Gateway", "high", -2, 5, ["Security", "Change"],
           _chk("+CVE assessed: denial-of-service in JWT plugin", "+Upgrade tested on staging — all 14 plugin configs validated", "+Change window approved: Sunday 02:00 UTC", "+Upgrade complete in 12 minutes"),
           [_cmt("Kong 3.6 upgrade completed in the change window. JWT plugin CVE patched. Monitoring for regressions.", "demo2")],
           desc="Kong upgrade from 3.3 to 3.6 to patch CVE-2024-2087 (DoS via JWT plugin). Completed in Sunday change window in 12 minutes. Monitoring post-deploy."),
        _c("Add distributed tracing headers (W3C traceparent) to gateway", "Testing", "API Gateway", "medium", 8, 4, ["Improve"],
           _chk("+W3C traceparent header propagation implemented in Kong plugin", "+Tested with Jaeger — traces showing end-to-end", "Load test — confirm no latency regression at P99", "Deploy to production"),
           [_cmt("Traces are flowing end-to-end in Jaeger. API → Django → Celery all connected. Load test next to confirm < 1ms overhead.", "demo4")],
           desc="Add W3C traceparent distributed tracing headers to the API gateway. Enables end-to-end request tracing from Kong through Django and Celery. Load test pending."),
        _c("Gateway connection pool exhaustion alert — thresholds too low", "In Progress", "API Gateway", "medium", 4, 3, ["Improve"],
           _chk("+Analyzed connection pool metrics over 30 days", "+New thresholds: warn at 70%, critical at 90%", "Update Alertmanager rules", "Test alert firing in staging"),
           desc="Current connection pool alerts fire at 50% utilization, causing alert fatigue. Updating thresholds to 70% warn and 90% critical based on 30-day usage analysis."),

        # PostgreSQL Cluster
        _c("Replica lag spike — 45s lag during analytics export job", "Verified", "PostgreSQL Cluster", "high", -18, 6, ["Incident"],
           _chk("+Confirmed: analytics export running full-table scan during business hours", "+Fix: export job re-routed to dedicated replica", "+Replica lag: back to < 1s", "+Monitoring 7 days — no recurrence"),
           [_cmt("The analytics export was doing a full sequential scan of card_movements (14M rows) on the primary, starving replication. Moved to a dedicated read replica.", "demo1"),
            _cmt("7-day monitoring complete. Replica lag stays under 200ms even during export jobs.", "demo3")],
           desc="Replica lag spike to 45s during analytics export job due to full-table scan on primary. Fix: export job routed to dedicated replica. Lag back to sub-second."),
        _c("Index bloat cleanup — card_movements table", "Deployed", "PostgreSQL Cluster", "medium", -5, 4, ["Improve"],
           _chk("+REINDEX CONCURRENTLY run during low-traffic window", "+Index size reduced from 4.2 GB to 1.1 GB", "+Query performance on movement history: -60% runtime", "+Bloat monitoring dashboard updated"),
           [_cmt("card_movements had 3 dead indexes from schema iterations. REINDEX CONCURRENTLY ran in 18 min. Index size down 74%.", "demo2")],
           desc="Cleaned up index bloat on card_movements table. Removed 3 dead indexes, ran REINDEX CONCURRENTLY. Index size reduced from 4.2 GB to 1.1 GB. Query runtime -60%."),
        _c("Upgrade PostgreSQL 16.1 → 16.4 (minor patch)", "Change Window", "PostgreSQL Cluster", "medium", 2, 4, ["Change"],
           _chk("+Patch notes reviewed — no breaking changes", "+Staging upgrade complete", "+Failover test passed: < 15s RTO", "Production upgrade Sunday 03:00 UTC"),
           [_cmt("Minor upgrade for 3 bug fixes (one affecting COPY with binary encoding). Staging upgrade clean. Production Sunday 03:00 UTC.", "demo4")],
           desc="PostgreSQL minor upgrade 16.1 → 16.4. Three bug fixes including COPY binary encoding issue. Staging complete, failover test passed. Production Sunday 03:00 UTC."),
        _c("Evaluate pg_partman for card_movements partitioning", "Triaged", "PostgreSQL Cluster", "medium", 25, 5, ["Capacity"],
           _chk("Benchmark partition key options (board_id vs created_at)", "Test pg_partman on a clone of card_movements", "Estimate query plan changes"),
           desc="card_movements is growing at ~500k rows/week and will hit 30M rows in 6 months. Evaluating pg_partman range partitioning by created_at to keep table sizes manageable."),

        # CI/CD Pipeline
        _c("Pipeline flakiness — Docker layer cache misses on main branch", "Verified", "CI/CD Pipeline", "high", -12, 5, ["Incident"],
           _chk("+Root cause: Kaniko cache TTL set to 24h, cache evicted during peak hours", "+Fix: increase TTL to 7 days, dedicate cache storage node", "+Pipeline p95 time: 8 min → 5 min 40s", "+Flaky test rate: 0%"),
           [_cmt("Kaniko's cache TTL was expiring during business hours causing full rebuilds. 7-day TTL + dedicated storage node resolved it.", "demo1"),
            _cmt("p95 build time down from 8 min to 5:40. Cache hit rate is now 94%.", "demo3")],
           desc="Pipeline flakiness caused by Kaniko layer cache eviction during peak hours (24h TTL too short). Fixed by increasing TTL to 7 days and adding dedicated cache storage."),
        _c("Add SAST scanning job (Semgrep) to merge request pipelines", "Deployed", "CI/CD Pipeline", "medium", -8, 4, ["Security", "Change"],
           _chk("+Semgrep rules selected: OWASP, Django security, secrets detection", "+False positive baseline established", "+Job added to MR pipelines — blocking on critical findings", "+Documentation updated"),
           [_cmt("First scan found 2 real issues and 12 false positives. False positives added to .semgrepignore. Now running clean.", "demo2")],
           desc="Semgrep SAST scanning added to MR pipelines. Blocks on critical findings. Two real issues found on first run (now fixed). 12 false positives suppressed."),
        _c("Reduce test suite runtime — parallelize Vitest workers", "Testing", "CI/CD Pipeline", "medium", 5, 4, ["Improve"],
           _chk("+Profiled test suite — 4 slow suites identified", "+Vitest worker count increased from 2 to 6", "+Frontend test time: 4m20s → 1m45s", "Run final timing validation on CI"),
           [_cmt("4 tests were running sequentially instead of in parallel. Worker count increase from 2 to 6 cut frontend test time by 60%.", "demo4")],
           desc="Frontend test suite was running 4 large suites sequentially. Increased Vitest workers from 2 to 6 and fixed sequential execution. Runtime reduced from 4:20 to 1:45."),
        _c("Dependency scanning job — automate CVE alerting", "Assigned", "CI/CD Pipeline", "medium", 10, 3, ["Security"],
           _chk("Select tool: Trivy vs Grype", "Configure job to scan Docker images on merge to main", "Wire alerts to #security Slack channel", "Document suppression process for false positives"),
           desc="Add automated dependency scanning to CI pipeline. Scan built Docker images for CVEs on every merge to main. Alert #security Slack channel on new high/critical findings."),

        # Object Storage (S3)
        _c("S3 presigned URL expiry too short — file upload failures on slow connections", "Verified", "Object Storage (S3)", "high", -20, 4, ["Incident"],
           _chk("+Confirmed: 15-min expiry insufficient for large file uploads on mobile", "+Fix: presigned URL expiry extended to 2 hours", "+Tested with 50 MB file on throttled connection", "+Production deployed — no further upload failures"),
           [_cmt("15-minute presigned URL was fine for desktop but mobile users on 3G took longer to upload. Extended to 2 hours.", "demo1"),
            _cmt("Zero upload timeout failures since the fix. 7-day monitoring complete.", "demo2")],
           desc="Large file uploads failing on slow mobile connections because presigned URLs expired (15-min TTL) before upload completed. Extended TTL to 2 hours. Resolved."),
        _c("Lifecycle policy — expire temporary upload staging prefix", "Deployed", "Object Storage (S3)", "medium", -6, 3, ["Improve"],
           _chk("+Temporary upload prefix identified: uploads/tmp/*", "+Lifecycle rule: delete after 24 hours", "+Applied and tested", "+Cost reduction: ~$40/month"),
           [_cmt("tmp/ prefix was accumulating failed partial uploads indefinitely. 24-hour expiry lifecycle rule added. Saves ~$40/month.", "demo3")],
           desc="S3 tmp/ prefix was accumulating failed partial uploads indefinitely. Added 24-hour lifecycle expiry rule. Cost reduction ~$40/month."),
        _c("Enable S3 Object Lock for backup buckets (WORM compliance)", "In Progress", "Object Storage (S3)", "medium", 8, 5, ["Security", "Change"],
           _chk("+Legal confirmed: 7-year retention required for billing records", "+Backup bucket policy reviewed", "Enable Object Lock in compliance mode", "Test that delete attempts are correctly blocked"),
           [_cmt("Object Lock requires the bucket to be created fresh — can't enable it on an existing bucket. Creating a new bucket and migrating backups.", "demo4")],
           desc="Enable S3 Object Lock (WORM) on the backup bucket to satisfy 7-year retention compliance requirement for billing records. Requires bucket recreation and backup migration."),
        _c("S3 cross-region replication lag monitoring", "Triaged", "Object Storage (S3)", "medium", 15, 3, ["Improve"],
           _chk("Define replication lag SLO (target: < 15 min)", "Set up CloudWatch replication metrics dashboard", "Alert on lag > 30 min"),
           desc="Cross-region replication from us-east-1 to eu-west-1 has no lag monitoring. Need CloudWatch metrics and an alert if replication falls more than 30 minutes behind."),

        # Kubernetes Cluster
        _c("OOMKilled worker pods — analytics aggregation job memory leak", "Verified", "Kubernetes Cluster", "high", -10, 6, ["Incident"],
           _chk("+Root cause: Python object cache in worker not cleared between tasks", "+Fix: call cache.clear() in Celery post-task signal", "+Memory stable for 72h", "+Memory limit increased as a safety buffer (1 GB → 1.5 GB)"),
           [_cmt("Python's in-process cache was growing unbounded between Celery tasks. Post-task signal to call cache.clear() fixed it.", "demo1"),
            _cmt("Worker pods stable for 72h. Peak memory usage is now 890 MB (was hitting 1 GB OOM). Incident closed.", "demo3")],
           desc="Worker pods OOMKilled due to unbounded in-process cache growth between Celery tasks. Fixed by clearing cache in post-task signal. Memory limit also increased to 1.5 GB."),
        _c("EKS 1.28 → 1.29 cluster upgrade", "Deployed", "Kubernetes Cluster", "high", -3, 7, ["Change"],
           _chk("+AWS upgrade checklist completed", "+API deprecations reviewed — 0 breaking changes", "+Node group upgrade: rolling, no pod disruption", "+Cluster upgraded in 38 minutes", "+All system pods healthy"),
           [_cmt("EKS 1.29 upgrade completed without any pod disruption. All 3 node groups rolled successfully. Took 38 min.", "demo2"),
            _cmt("Monitoring 24h post-upgrade. All green. Autoscaler and CoreDNS both running the latest compatible versions.", "demo4")],
           desc="EKS cluster upgrade from 1.28 to 1.29. Zero API deprecation breaking changes. Rolling node group upgrade with no pod disruption. Completed in 38 minutes."),
        _c("Pod topology spread constraints — better AZ distribution", "Testing", "Kubernetes Cluster", "medium", 6, 4, ["Improve"],
           _chk("+Analyzed pod distribution: 70% of API pods in us-east-1a", "+TopologySpreadConstraints config written", "Apply to API and worker deployments on staging", "Verify even spread before promoting"),
           [_cmt("70% of API pods were in us-east-1a due to node group placement groups. TopologySpreadConstraints will enforce maxSkew=1 across zones.", "demo1")],
           desc="API pods are disproportionately placed in us-east-1a (70%) due to node group preferences. Adding TopologySpreadConstraints to enforce even distribution across AZs."),
        _c("Cluster autoscaler tuning — reduce scale-down aggression", "Assigned", "Kubernetes Cluster", "medium", 9, 4, ["Capacity"],
           _chk("+Analyzed scale-down events over 14 days", "+New config: scale-down-delay-after-add=5m, scale-down-unneeded-time=10m", "Apply to cluster autoscaler deployment", "Monitor for over/under-scaling"),
           desc="Cluster autoscaler is scaling down too aggressively after traffic spikes, causing pod rescheduling latency. Increasing scale-down delay and unneeded-time thresholds."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# 10. Legal & Compliance
# ═════════════════════════════════════════════════════════════════════════════
LEGAL_COMPLIANCE = {
    "slug": "legal_compliance",
    "name": "Template: Legal & Compliance",
    "description": "Track contracts, policy requests, and compliance reviews. Each swimlane is a department; each card is a request or obligation.",
    "columns": [
        {"name": "Submitted",           "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
        {"name": "Under Review",        "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
        {"name": "Needs Clarification", "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
        {"name": "Approved",            "position": 3, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
        {"name": "Denied",              "position": 4, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False},
        {"name": "Archived",            "position": 5, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False},
    ],
    "swimlanes": [
        {"name": "Engineering",                       "position": 0, "color": "#3B82F6", "contact_email": "legal-eng@example.com",    "notes": "Open-source license reviews, vendor DPAs, API partner agreements."},
        {"name": "Finance",                           "position": 1, "color": "#10B981", "contact_email": "legal-fin@example.com",    "notes": "Vendor contracts, payment processor agreements, financial compliance filings."},
        {"name": "HR & People",                       "position": 2, "color": "#F59E0B", "contact_email": "legal-hr@example.com",     "notes": "Employment agreements, contractor agreements, equity plan reviews, HR policy updates."},
        {"name": "Sales & Customer Contracts",        "position": 3, "color": "#EC4899", "contact_email": "legal-sales@example.com",  "notes": "Customer MSAs, DPAs, BAAs, SLAs, order forms. Average turn time: 5 business days."},
        {"name": "Product & Engineering Policy",      "position": 4, "color": "#8B5CF6", "contact_email": "legal-product@example.com","notes": "Privacy policy, ToS, cookie policy, AI policy, acceptable use policy."},
    ],
    "labels": [
        {"name": "Contract",   "color": "#3B82F6"},
        {"name": "Policy",     "color": "#8B5CF6"},
        {"name": "Compliance", "color": "#F97316"},
        {"name": "Urgent",     "color": "#EF4444"},
        {"name": "OSS",        "color": "#10B981"},
    ],
    "extra_cards": [
        # Engineering
        _c("Apache 2.0 compatibility review — new OSS dependencies", "Approved", "Engineering", "medium", -10, 3, ["OSS"],
           _chk("+Inventoried 6 new packages added this quarter", "+All 6 confirmed Apache 2.0 or MIT compatible", "+Legal sign-off documented in dep-licenses.md"),
           [_cmt("All 6 new packages confirmed Apache 2.0 or MIT. No GPL or AGPL licenses. Sign-off complete.", "demo2")],
           desc="Quarterly OSS license review for 6 new packages added to the dependency tree. All confirmed Apache 2.0 or MIT compatible. No action required."),
        _c("DPA with Snowflake — data processing agreement", "Archived", "Engineering", "high", -25, 4, ["Contract", "Compliance"],
           _chk("+DPA request submitted to Snowflake", "+Snowflake standard DPA reviewed — acceptable", "+DPA countersigned by CEO", "+Filed in contract management system"),
           [_cmt("Snowflake's standard DPA covers GDPR SCCs and CCPA. No custom terms needed. Signed and filed.", "demo1")],
           desc="Data Processing Agreement with Snowflake for the data platform migration. Snowflake's standard DPA reviewed and accepted. Signed by CEO and filed."),
        _c("BUSL license review — HashiCorp Terraform", "Under Review", "Engineering", "medium", 5, 4, ["OSS", "Compliance"],
           _chk("+Terraform license change from MPL-2.0 to BUSL 1.1 flagged by CI", "+Internal use analysis in progress", "Legal opinion on internal use exemption", "Decision: continue, migrate to OpenTofu, or seek commercial license"),
           [_cmt("BUSL restricts competitive use but internal non-competitive use appears to be allowed. Waiting on legal's written opinion before deciding.", "demo3")],
           desc="HashiCorp's Terraform moved from MPL-2.0 to BUSL 1.1. Need legal opinion on whether our internal non-competitive use is permitted before deciding on OpenTofu migration."),
        _c("Webhook partner API agreement — Zapier integration", "Submitted", "Engineering", "medium", 12, 3, ["Contract"],
           _chk("Share Zapier's developer agreement with legal", "Review rate limit and SLA clauses", "Submit redline if needed"),
           desc="Zapier integration requires agreeing to Zapier's developer partner agreement. Legal review of rate limit clauses and SLA obligations before sign-off."),

        # Finance
        _c("Stripe payment processing agreement renewal", "Approved", "Finance", "high", -8, 4, ["Contract"],
           _chk("+Renewal notice received 60 days in advance", "+Pricing reviewed — 0.3% rate reduction negotiated", "+Terms reviewed — no material changes", "+Signed and filed"),
           [_cmt("Negotiated a 0.3% processing rate reduction in exchange for 2-year commitment. Annual saving: ~$14,000.", "demo4"),
            _cmt("Signed and filed. Rate change effective May 1.", "demo1")],
           desc="Stripe payment processing agreement renewal. Negotiated 0.3% rate reduction for 2-year commitment. ~$14,000 annual saving. Signed and filed."),
        _c("AWS Enterprise Discount Program — annual review", "Under Review", "Finance", "high", 8, 5, ["Contract"],
           _chk("+Usage data pulled: $420k/year AWS spend", "+EDP proposal from AWS: 15% discount on 3-year commit", "Finance model: break-even at $380k/year spend", "Legal review of commitment terms"),
           [_cmt("AWS is offering 15% discount on a $1.26M 3-year commit. Break-even analysis shows we need to stay at $380k+/year. Finance modeling the downside scenarios.", "demo2")],
           desc="Annual AWS EDP review. AWS proposing 15% discount on 3-year commitment ($1.26M). Finance break-even analysis underway. Legal reviewing commitment and termination clauses."),
        _c("Accounting software DPA — new bookkeeping vendor", "Needs Clarification", "Finance", "medium", 4, 3, ["Contract", "Compliance"],
           _chk("+DPA submitted by vendor", "+Concerns: subprocessor list incomplete", "Request updated subprocessor list from vendor", "Re-review once subprocessor list received"),
           [_cmt("Vendor's DPA doesn't list all subprocessors — just says 'and other processors'. Not GDPR compliant. Sent back for a complete list.", "demo3")],
           desc="New bookkeeping vendor's DPA is incomplete — subprocessor list not fully disclosed. Sent back for a complete list before legal sign-off."),
        _c("SOC 2 bridge letter for enterprise prospect", "Submitted", "Finance", "medium", 3, 2, ["Compliance"],
           _chk("Draft bridge letter covering period since last audit", "CFO sign-off", "Send to prospect"),
           desc="Enterprise prospect (Apex Retail) is requesting a SOC 2 bridge letter covering the period since our last Type II audit. CFO sign-off required."),

        # HR & People
        _c("Independent contractor agreement — new design consultant", "Approved", "HR & People", "medium", -5, 3, ["Contract"],
           _chk("+IC agreement template used", "+IP assignment clause confirmed", "+Right-to-work verification complete", "+Signed by both parties"),
           [_cmt("Standard IC agreement with IP assignment clause. Design consultant starts Monday.", "demo1")],
           desc="Contractor agreement for the new design consultant (Riley N. backfill during search). Standard IC template with IP assignment. Signed."),
        _c("Remote work policy update — international contractors", "Approved", "HR & People", "medium", -12, 4, ["Policy"],
           _chk("+Legal reviewed: 6 countries now covered (US, CA, UK, DE, AU, SG)", "+Tax/PE risk section updated", "+Approved by CEO and CPO", "+Published to employee handbook"),
           [_cmt("Updated policy covers permanent establishment risk for contractors in 6 countries. Germany and Singapore had new clauses added based on recent tax guidance.", "demo2")],
           desc="Remote work policy updated to cover permanent establishment risk in 6 countries. New guidance for Germany and Singapore. Published to employee handbook."),
        _c("Equity plan amendment — RSU vesting cliff change", "Needs Clarification", "HR & People", "high", 3, 5, ["Contract", "Compliance"],
           _chk("+Plan amendment drafted: 1-year cliff → 6-month cliff for tenured employees", "+External counsel review requested", "External counsel: requires shareholder vote for class adjustment", "Determine path forward with CEO and board"),
           [_cmt("External counsel flagged that changing the cliff for tenured RSU holders is a class adjustment requiring shareholder approval under our articles. Need to discuss with the board.", "demo4")],
           desc="Proposed RSU vesting cliff change from 12 months to 6 months for employees with 2+ years tenure. External counsel flagged this requires shareholder vote. Needs board discussion."),
        _c("Parental leave policy — align to UK statutory minimum", "Under Review", "HR & People", "medium", 7, 3, ["Policy", "Compliance"],
           _chk("+UK Shared Parental Leave regulations reviewed", "+Gap analysis: current policy is below statutory minimum for SPL", "Draft updated policy", "Present to CEO and CPO for approval"),
           desc="Current parental leave policy falls below UK Shared Parental Leave statutory minimum for 3 employees. Policy update required for compliance before next payroll cycle."),

        # Sales & Customer Contracts
        _c("TechNova MSA — 500-seat enterprise agreement", "Approved", "Sales & Customer Contracts", "high", -5, 6, ["Contract"],
           _chk("+MSA redline: 3 rounds", "+SLA: 99.9% uptime, 4h response for P1", "+GDPR DPA attached and signed", "+BAA not required (no PHI)", "+Executed: TechNova VP Legal + CEO"),
           [_cmt("3 rounds of redlines on the limitation of liability cap. Settled at 12 months of fees. TechNova signed last Friday.", "demo1"),
            _cmt("$320k ARR closed. Largest deal in company history.", "demo3")],
           desc="TechNova 500-seat enterprise MSA executed after 3 rounds of redlines. Liability cap: 12 months of fees. GDPR DPA attached. $320k ARR. Largest deal in company history."),
        _c("BlueSky Health BAA — HIPAA business associate agreement", "Under Review", "Sales & Customer Contracts", "high", 6, 5, ["Contract", "Compliance"],
           _chk("+BlueSky's standard BAA received and reviewed", "+Legal: BAA is acceptable with 2 modifications to breach notification timeline", "+Sent redline to BlueSky", "BlueSky legal response pending"),
           [_cmt("BlueSky's BAA requires 10-business-day breach notification. We need to shorten to 5 days to align with our incident response plan.", "demo2")],
           desc="HIPAA BAA with BlueSky Health for healthcare project management use case. Two modifications needed: breach notification timeline (10 days → 5 days). Redline sent, awaiting response."),
        _c("Mosaic Creative NDA — mutual non-disclosure", "Archived", "Sales & Customer Contracts", "low", -18, 2, ["Contract"],
           _chk("+Standard mutual NDA template used", "+Executed by both parties", "+Filed in contract management"),
           [_cmt("Routine mutual NDA before sharing pricing and roadmap. Signed and filed.", "demo4")],
           desc="Standard mutual NDA with Mosaic Creative executed prior to sharing commercial pricing and product roadmap. Filed."),
        _c("FinEdge order form amendment — add 20 seats mid-term", "Needs Clarification", "Sales & Customer Contracts", "medium", 2, 3, ["Contract"],
           _chk("+Amendment request received from AE", "+Question: prorated vs full-term pricing for mid-term add?", "Confirm pricing model with Sales Ops", "Issue amendment once pricing confirmed"),
           [_cmt("Sales Ops needs to confirm whether mid-term seat adds are prorated to renewal date or billed at full term. Waiting on their answer.", "demo1")],
           desc="FinEdge wants to add 20 seats mid-term. Legal is waiting on Sales Ops to confirm pricing model (prorated vs. full-term) before issuing the amendment."),

        # Product & Engineering Policy
        _c("Privacy policy update — AI feature disclosures", "Approved", "Product & Engineering Policy", "high", -7, 5, ["Policy", "Compliance"],
           _chk("+New AI features identified: card summarization, smart search", "+GDPR Art. 22 automated decision-making assessment: not applicable", "+Privacy policy updated: AI data processing section added", "+Updated policy published and versioned"),
           [_cmt("Added section explaining what data is used for AI features, that it isn't used to train third-party models, and user opt-out. Published to /privacy.", "demo2"),
            _cmt("DPA team reviewed and confirmed GDPR Art. 22 doesn't apply as there's no solely automated decision-making with legal effect.", "demo3")],
           desc="Privacy policy updated to disclose AI feature data processing (card summarization, smart search). Confirmed GDPR Art. 22 doesn't apply. Published to /privacy."),
        _c("AI acceptable use policy — new document", "Under Review", "Product & Engineering Policy", "high", 4, 5, ["Policy"],
           _chk("+First draft complete — covers prohibited use cases, rate limits, output ownership", "+Internal review: legal, product, engineering", "External counsel review", "Publish to /legal/ai-use-policy"),
           [_cmt("Prohibited use cases include: generating spam, impersonating people, automated GDPR deletion evasion. Internal review comments in the doc.", "demo4")],
           desc="New AI Acceptable Use Policy covering prohibited use cases, rate limits, and output ownership. First draft complete, in internal review. External counsel review next."),
        _c("Cookie policy refresh — align with ePrivacy Directive", "Needs Clarification", "Product & Engineering Policy", "medium", 5, 4, ["Policy", "Compliance"],
           _chk("+Cookie audit: 14 cookies identified (4 strictly necessary, 10 analytics/marketing)", "+Question: is the existing consent banner GDPR-compliant for EU users?", "Commission consent banner vendor review", "Update cookie policy and banner"),
           [_cmt("The current 'continued browsing = consent' banner is NOT valid under ePrivacy. Need an explicit opt-in for analytics cookies for EU users.", "demo1")],
           desc="Cookie policy refresh required. Current 'continued browsing = consent' model is invalid under ePrivacy Directive for EU users. Need explicit opt-in banner for analytics cookies."),
        _c("Terms of Service v2 — API access and rate limits section", "Submitted", "Product & Engineering Policy", "medium", 10, 3, ["Policy"],
           _chk("Draft new API access section: rate limits, commercial use, prohibited automation", "Review with product team", "External counsel review"),
           desc="ToS v2 needs a new section covering API access terms: rate limits, commercial use rights, and prohibited automation patterns (scraping, bot accounts). Draft needed."),
    ],
}


# ═════════════════════════════════════════════════════════════════════════════
# Export
# ═════════════════════════════════════════════════════════════════════════════
TEMPLATES_PART2 = [
    PROJECT_DELIVERY,
    CONTENT_PRODUCTION,
    HIRING_RECRUITING,
    INFRA_DEVOPS,
    LEGAL_COMPLIANCE,
]
