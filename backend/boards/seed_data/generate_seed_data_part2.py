"""
Templates 6-10 for generate_seed_data.py.

Loaded via importlib from generate_seed_data.py — do not run directly.
"""

from datetime import datetime, timedelta, timezone

from generate_seed_data import _auto_cards

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

_DELIVERY_COLUMNS = [
    {"name": "Planning",          "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Kickoff",           "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Execution",         "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Milestone Review",  "position": 3, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Wrap-up",           "position": 4, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Retro",             "position": 5, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_DELIVERY_SWIMLANES = [
    {"name": "Mobile App Relaunch",          "position": 0,  "color": "#EC4899", "contact_email": "pm-mobile@example.com",       "notes": "Full redesign + new feature set. Q2 launch target. Sponsor: VP Product."},
    {"name": "Data Platform Migration",      "position": 1,  "color": "#3B82F6", "contact_email": "pm-data@example.com",         "notes": "Migrate from Redshift to Snowflake. 3 TB data. Zero-downtime required."},
    {"name": "Security Compliance Audit",    "position": 2,  "color": "#EF4444", "contact_email": "ciso@example.com",            "notes": "SOC 2 Type II audit. Auditor engaged. Evidence collection deadline: end of Q2."},
    {"name": "Customer Portal v2",           "position": 3,  "color": "#10B981", "contact_email": "pm-portal@example.com",       "notes": "Self-service portal for invoices, usage, support. Design approved, dev in progress."},
    {"name": "GDPR Deletion Pipeline",       "position": 4,  "color": "#8B5CF6", "contact_email": "privacy@example.com",         "notes": "Automate right-to-erasure requests. Legal deadline: 90 days from receipt."},
    {"name": "Infrastructure Modernization", "position": 5,  "color": "#F59E0B", "contact_email": "pm-infra@example.com",        "notes": "Multi-cloud migration from on-prem. Target: fully cloud-native by end of Q3. Sponsor: CTO."},
    {"name": "Brand Redesign",               "position": 6,  "color": "#F97316", "contact_email": "pm-brand@example.com",        "notes": "Full brand refresh — logo, typography, color palette, marketing site. Agency: Mosaic Creative."},
    {"name": "Vendor Management System",     "position": 7,  "color": "#14B8A6", "contact_email": "pm-procurement@example.com",  "notes": "Centralize vendor onboarding, contracts, and spend tracking. 40+ active vendors."},
    {"name": "Employee Onboarding Platform", "position": 8,  "color": "#6366F1", "contact_email": "pm-hr@example.com",           "notes": "Automated onboarding for new hires — IT setup, HR paperwork, team intros. 15+ new hires/quarter."},
    {"name": "API Gateway Overhaul",         "position": 9,  "color": "#0EA5E9", "contact_email": "pm-platform@example.com",     "notes": "Replace legacy API gateway with Kong. Rate limiting, auth, and observability. 14 upstream services."},
]

_DELIVERY_LABELS = [
    {"name": "On Track",    "color": "#10B981"},
    {"name": "At Risk",     "color": "#F59E0B"},
    {"name": "Blocked",     "color": "#EF4444"},
    {"name": "Milestone",   "color": "#3B82F6"},
    {"name": "Dependency",  "color": "#8B5CF6"},
]

_DELIVERY_TITLES = [
    # Mobile App Relaunch
    "Define MVP scope and success metrics",
    "Kickoff stakeholder alignment meeting",
    "UX research synthesis — navigation patterns",
    "Beta release to 500 internal testers",
    "App store submission and release notes",
    "Performance profiling — cold start under 2s",
    "Accessibility audit — WCAG 2.1 AA compliance",
    "Push notification integration with Firebase",
    "Offline mode — sync queue architecture",
    "Analytics SDK integration — Mixpanel events",
    "Deep linking implementation for marketing URLs",
    "Crash reporting setup — Sentry for mobile",
    # Data Platform Migration
    "Schema mapping: Redshift to Snowflake",
    "ELT pipeline cutover — dbt models",
    "Historical data validation — row counts and checksums",
    "Decommission Redshift cluster",
    "Snowflake role-based access control setup",
    "Cost monitoring dashboard for Snowflake credits",
    "Data quality framework — Great Expectations suite",
    "Reverse ETL pipeline for Salesforce sync",
    "Migration runbook and rollback procedure",
    "Stakeholder training sessions — Snowflake UI",
    "Snowflake Streams for real-time CDC",
    "Archive cold data to S3 Glacier",
    # Security Compliance Audit
    "Access control evidence collection",
    "Penetration test — external perimeter",
    "Incident response plan — tabletop exercise",
    "Vendor risk assessments — top 10 vendors",
    "SOC 2 evidence package assembly",
    "Security awareness training — all hands",
    "Encryption at rest audit — all data stores",
    "Network segmentation review with diagrams",
    "Business continuity plan — annual update",
    "Third-party code audit — open-source components",
    "Multi-factor authentication enrollment push",
    "Vulnerability scanning — OWASP ZAP automated run",
    # Customer Portal v2
    "Invoice download and history UI",
    "Usage dashboard — seats and API calls",
    "Support ticket submission flow",
    "SSO deep-link for portal (SAML assertions)",
    "Knowledge base search integration",
    "Account settings and billing management",
    "Role-based portal access — admin vs viewer",
    "Notification preferences center",
    "API key management self-service",
    "Customer feedback widget embedded in portal",
    "Data export — CSV and JSON download",
    "White-label portal theming for enterprise",
    # GDPR Deletion Pipeline
    "Deletion request intake API",
    "Cross-service deletion orchestrator",
    "Deletion audit report — per-request evidence",
    "Suppression list for marketing after deletion",
    "Automated identity verification step",
    "Analytics service — S3 event log purge job",
    "Billing service — invoice data anonymization",
    "Email service — unsubscribe and purge flow",
    "Auth service — account deactivation handler",
    "90-day SLA timer and escalation alerts",
    "DPA-facing deletion status dashboard",
    "Deletion dry-run mode for testing",
    # Infrastructure Modernization
    "Cloud readiness assessment — all services",
    "Terraform state migration to Terraform Cloud",
    "Containerize legacy monolith services",
    "Database migration — on-prem PostgreSQL to RDS",
    "VPN to cloud interconnect setup",
    "CI/CD pipeline migration to GitHub Actions",
    "Secret management — migrate to Vault",
    "Load balancer migration — ALB configuration",
    "DNS cutover plan — zero-downtime",
    "Cost estimation and budget approval",
    "Legacy service decommission plan",
    "Cloud security posture review — CIS benchmarks",
    # Brand Redesign
    "Brand audit — competitive positioning analysis",
    "Logo design exploration — 3 concept directions",
    "Typography system — font selection and scale",
    "Color palette definition — primary and extended",
    "Brand guidelines document — v1 draft",
    "Marketing site redesign — homepage wireframes",
    "Email template refresh — match new brand",
    "Social media kit — templates and guidelines",
    "Internal brand launch — all-hands presentation",
    "Swag and merchandise design — new logo",
    "Slide deck template — new brand",
    "Brand voice and tone guidelines document",
    # Vendor Management System
    "Vendor onboarding workflow design",
    "Contract repository — schema and migration",
    "Spend tracking dashboard — by vendor and category",
    "Vendor risk scoring model",
    "Automated renewal reminders — 60-day notice",
    "Procurement approval workflow — multi-tier",
    "Vendor performance review template",
    "Integration with accounting system — AP sync",
    "Vendor portal — self-service document upload",
    "Compliance certificate tracking — SOC 2, ISO",
    "Budget vs actuals report — quarterly",
    "Historical spend data import — 3 years",
    # Employee Onboarding Platform
    "Onboarding checklist builder — role-based templates",
    "IT provisioning automation — laptop and accounts",
    "HR paperwork — e-signature integration",
    "Team introduction scheduling — calendar sync",
    "First-week schedule generator",
    "Buddy program matching algorithm",
    "Onboarding feedback survey — Day 30 and Day 90",
    "Equipment inventory tracking integration",
    "Benefits enrollment walkthrough flow",
    "Org chart integration — reporting lines",
    "New hire welcome kit — swag order automation",
    "Manager onboarding dashboard — progress view",
    # API Gateway Overhaul
    "Kong gateway evaluation — proof of concept",
    "Authentication plugin configuration — JWT and OAuth",
    "Rate limiting strategy — per-user and per-endpoint",
    "API versioning scheme — URL path vs header",
    "Request logging and distributed tracing setup",
    "Circuit breaker configuration for upstream services",
    "API documentation portal — Swagger/OpenAPI",
    "Load testing — 10k RPS sustained throughput",
    "Canary deployment strategy for gateway rollout",
    "Legacy gateway traffic drain plan",
    "Developer portal — API key self-service",
    "Monitoring and alerting — latency SLOs",
]

PROJECT_DELIVERY = {
    "slug": "project_delivery",
    "name": "Template: Project Delivery",
    "description": "Track cross-functional projects from planning through retrospective. Each swimlane is a project; each card is a deliverable or milestone.",
    "columns": _DELIVERY_COLUMNS,
    "swimlanes": _DELIVERY_SWIMLANES,
    "labels": _DELIVERY_LABELS,
    "extra_cards": _auto_cards(_DELIVERY_TITLES, _DELIVERY_COLUMNS, _DELIVERY_SWIMLANES, _DELIVERY_LABELS, "delivery"),
}


# ═════════════════════════════════════════════════════════════════════════════
# 7. Content Production
# ═════════════════════════════════════════════════════════════════════════════

_CONTENT_COLUMNS = [
    {"name": "Idea",             "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Assigned",         "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Draft",            "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Internal Review",  "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Edits",            "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Final Approval",   "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
    {"name": "Scheduled",        "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
    {"name": "Published",        "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_CONTENT_SWIMLANES = [
    {"name": "Blog & SEO",               "position": 0, "color": "#3B82F6", "contact_email": "blog@example.com",           "notes": "Long-form SEO content. Target: 2 posts/week. Primary traffic driver. Owner: content team."},
    {"name": "Social Media",             "position": 1, "color": "#8B5CF6", "contact_email": "social@example.com",         "notes": "Twitter/X, LinkedIn, short-form video (TikTok, Reels). 2-3 posts/day across channels."},
    {"name": "Video Production",         "position": 2, "color": "#EC4899", "contact_email": "video@example.com",          "notes": "Product demos, thought leadership webinars, YouTube tutorials. Studio booking required."},
    {"name": "Email Campaigns",          "position": 3, "color": "#F59E0B", "contact_email": "email@example.com",          "notes": "Weekly newsletter, drip sequences, product announcements. Audience: 28,000 subscribers."},
    {"name": "Product Documentation",    "position": 4, "color": "#10B981", "contact_email": "docs@example.com",           "notes": "User guides, API docs, release notes. Must be versioned. Published to docs.visiban.com."},
    {"name": "Case Studies",             "position": 5, "color": "#14B8A6", "contact_email": "stories@example.com",        "notes": "Customer stories. Requires customer approval. 4-6 week production time per study."},
    {"name": "Webinars & Events",        "position": 6, "color": "#F97316", "contact_email": "events@example.com",         "notes": "Live webinars, conference talks, virtual workshops. Lead capture forms required."},
    {"name": "Press & PR",               "position": 7, "color": "#EF4444", "contact_email": "press@example.com",          "notes": "Press releases, media pitches, analyst briefings. All external comms require CEO approval."},
    {"name": "Partner Content",          "position": 8, "color": "#6366F1", "contact_email": "partners@example.com",       "notes": "Co-branded content with integration partners. Joint approval workflow required."},
    {"name": "Internal Communications",  "position": 9, "color": "#0EA5E9", "contact_email": "internal@example.com",       "notes": "All-hands decks, internal newsletters, culture posts. Published to company wiki."},
]

_CONTENT_LABELS = [
    {"name": "SEO",              "color": "#3B82F6"},
    {"name": "Thought Leadership", "color": "#8B5CF6"},
    {"name": "Product",          "color": "#10B981"},
    {"name": "Customer",         "color": "#F59E0B"},
    {"name": "Event",            "color": "#EC4899"},
]

_CONTENT_TITLES = [
    # Blog & SEO
    "How we cut API latency by 80% — technical deep dive",
    "Kanban vs Scrum: which fits your team? — SEO pillar",
    "5 ways to use swimlanes beyond customers — use case post",
    "Building a remote-first team process — thought leadership",
    "The complete guide to WIP limits — SEO cornerstone",
    "Why cycle time matters more than velocity",
    "Card movement audit trails — a compliance use case",
    "Self-hosted vs cloud Kanban — comparison guide",
    "How TechNova reduced cycle time by 34%",
    "Integrating Kanban with your CI/CD pipeline",
    "The product manager's guide to board analytics",
    "10 Kanban anti-patterns and how to fix them",
    # Social Media
    "LinkedIn carousel — 10 Kanban metrics that matter",
    "Twitter/X thread — launch of Space+drag pan feature",
    "Short-form video — Visiban in 60 seconds for TikTok/Reels",
    "LinkedIn thought leadership — CEO post series (3 posts)",
    "Instagram Reel — customer testimonial clip from TechNova",
    "Twitter/X thread — 5 hidden keyboard shortcuts",
    "LinkedIn post — case study highlight: BlueSky Health",
    "Social poll — what is your biggest Kanban challenge?",
    "Behind-the-scenes — a day in the life of our engineering team",
    "LinkedIn carousel — remote team collaboration tips",
    "Twitter/X launch day coverage — Groups feature",
    "Short-form video — swimlane collapse demo for TikTok",
    # Video Production
    "Product demo: board pan + keyboard shortcuts",
    "Tutorial series: Visiban for beginners — Episode 3",
    "Visiban vs competitors — YouTube comparison video",
    "Customer interview video — TechNova CTO",
    "Product demo: analytics dashboard walkthrough",
    "Tutorial: setting up your first board in 5 minutes",
    "Webinar recording edit — Running CS teams with Kanban",
    "Explainer video — what is card movement tracking?",
    "Product demo: bulk card operations feature",
    "YouTube Shorts — drag and drop in action",
    "Tutorial: advanced filtering and search",
    "Product demo: real-time collaboration features",
    # Email Campaigns
    "April newsletter — product updates + case study feature",
    "Onboarding drip — Day 7: advanced swimlane tips",
    "Re-engagement campaign — users inactive > 30 days",
    "Product launch email — Groups feature announcement",
    "Onboarding drip — Day 1: welcome and board setup",
    "Onboarding drip — Day 14: invite your team",
    "Win-back campaign — expired trial users",
    "Monthly product digest — March highlights",
    "Enterprise feature announcement — SSO and audit logs",
    "Customer milestone email — 1000th card moved",
    "NPS survey email — quarterly feedback request",
    "Seasonal promotion — annual plan discount",
    # Product Documentation
    "API reference — card movement endpoint updates",
    "User guide — board analytics dashboard",
    "Release notes — v1.4.0 changelog",
    "Migration guide — upgrading from v1.3 to v1.4",
    "Admin guide — SSO configuration with Okta",
    "Developer guide — webhook setup and payloads",
    "User guide — keyboard shortcuts reference",
    "Admin guide — role-based access control setup",
    "Troubleshooting — common board loading issues",
    "API reference — bulk operations endpoint",
    "User guide — swimlane management best practices",
    "Getting started — self-hosted deployment guide",
    # Case Studies
    "TechNova Inc — from Jira to Visiban in 30 days",
    "BlueSky Health — HIPAA-compliant project management",
    "Mosaic Creative — 30-person agency using swimlanes per client",
    "FinEdge Ltd — compliance-tracking board for fintech",
    "Redwood Therapeutics — lab management with Kanban",
    "Apex Manufacturing — factory floor visual management",
    "Harbour Digital — startup scaling with Visiban",
    "Nordic Finance Group — SOC 2 evidence tracking",
    "Southern Cross Media — content calendar at scale",
    "Atlas Retail Group — 200-store operations board",
    "Pinnacle Health — clinical ops workflow management",
    "Forge Analytics — engineering team velocity tracking",
    # Webinars & Events
    "Webinar: Running customer success teams with Kanban",
    "Conference talk submission — KanbanConf 2026",
    "Virtual workshop — advanced board configuration",
    "Webinar: migrating from Jira to Visiban",
    "Launch event — Groups feature live demo",
    "Partner webinar — Visiban + Slack integration deep dive",
    "Office hours — live Q&A with the product team",
    "Workshop: building a metrics-driven Kanban practice",
    "Webinar replay edit — self-hosted deployment guide",
    "Conference talk submission — DevOpsDays EU",
    "Customer roundtable — quarterly product feedback",
    "Virtual workshop — swimlane strategies for agencies",
    # Press & PR
    "Press release — Series A funding announcement",
    "Analyst briefing — Gartner PPM Magic Quadrant",
    "Media pitch — open-source Kanban story for TechCrunch",
    "Press release — 10,000 customer milestone",
    "Industry award submission — SaaS Innovation Awards",
    "Podcast guest pitch — CEO on open-core business model",
    "Media kit refresh — new brand assets and boilerplate",
    "Press release — HIPAA compliance certification",
    "Analyst briefing — Forrester Wave preparation",
    "Media pitch — remote work tools roundup for Wired",
    "Crisis communications plan — annual update",
    "Press release — strategic partnership announcement",
    # Partner Content
    "Co-branded guide — Visiban + Slack for async teams",
    "Partner blog post — Zapier integration launch",
    "Joint webinar — Visiban + GitHub for developer workflows",
    "Integration spotlight — Visiban + Jira migration tool",
    "Co-branded case study — TechNova uses Visiban + Datadog",
    "Partner newsletter feature — Slack App Directory listing",
    "Integration tutorial — connecting Visiban to PagerDuty",
    "Co-branded infographic — state of Kanban 2026",
    "Partner blog post — Visiban + Linear for dual-track teams",
    "Joint press release — strategic alliance with Atlassian",
    "Integration guide — Visiban webhooks + Zapier recipes",
    "Co-branded video — Visiban + Figma for design handoff",
    # Internal Communications
    "All-hands deck — Q1 2026 company update",
    "Internal newsletter — March engineering highlights",
    "Culture post — new team member introductions",
    "All-hands deck — product roadmap preview Q2 2026",
    "Internal wiki — updated engineering onboarding guide",
    "Town hall summary — CEO Q&A recap",
    "Culture post — remote work anniversary celebration",
    "Internal newsletter — customer success stories roundup",
    "Policy update — revised PTO and parental leave",
    "All-hands deck — annual planning kickoff",
    "Internal wiki — incident response runbook update",
    "Culture post — hackathon results and demos",
]

CONTENT_PRODUCTION = {
    "slug": "content_production",
    "name": "Template: Content Production",
    "description": "Manage content from idea through publication. Each swimlane is a content channel; each card is a piece of content.",
    "columns": _CONTENT_COLUMNS,
    "swimlanes": _CONTENT_SWIMLANES,
    "labels": _CONTENT_LABELS,
    "extra_cards": _auto_cards(_CONTENT_TITLES, _CONTENT_COLUMNS, _CONTENT_SWIMLANES, _CONTENT_LABELS, "content"),
}


# ═════════════════════════════════════════════════════════════════════════════
# 8. Hiring & Recruiting
# ═════════════════════════════════════════════════════════════════════════════

_HIRING_COLUMNS = [
    {"name": "Applied",           "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Phone Screen",      "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Technical Screen",  "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "Interview",         "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Reference Check",   "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Offer Extended",    "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
    {"name": "Hired",             "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Rejected",          "position": 7, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_HIRING_SWIMLANES = [
    {"name": "Engineering",       "position": 0, "color": "#3B82F6", "contact_email": "hiring-eng@example.com",      "notes": "Backend, frontend, and infrastructure roles. Python/Django and React/TypeScript. Remote-friendly."},
    {"name": "Product",           "position": 1, "color": "#8B5CF6", "contact_email": "hiring-product@example.com",  "notes": "Product managers and product analysts. B2B SaaS experience preferred. Reports to CPO."},
    {"name": "Design",            "position": 2, "color": "#EC4899", "contact_email": "hiring-design@example.com",   "notes": "Product designers and UX researchers. Figma expertise required. Systems design thinking valued."},
    {"name": "Sales",             "position": 3, "color": "#10B981", "contact_email": "hiring-sales@example.com",    "notes": "Account executives and SDRs. B2B SaaS with PLG experience. OTE $120-180k."},
    {"name": "Marketing",         "position": 4, "color": "#F59E0B", "contact_email": "hiring-mktg@example.com",     "notes": "Content, growth, and demand gen roles. PLG experience required. Reports to Head of Marketing."},
    {"name": "Customer Success",  "position": 5, "color": "#14B8A6", "contact_email": "hiring-cs@example.com",       "notes": "CSMs and CS Ops. SaaS experience required. Owns onboarding, retention, and expansion."},
    {"name": "Operations",        "position": 6, "color": "#F97316", "contact_email": "hiring-ops@example.com",      "notes": "DevOps, IT, and business operations. Kubernetes and Terraform experience for DevOps roles."},
    {"name": "Finance",           "position": 7, "color": "#6366F1", "contact_email": "hiring-finance@example.com",  "notes": "Accounting, FP&A, and revenue ops. SaaS metrics experience preferred. CPA for accounting roles."},
    {"name": "Legal",             "position": 8, "color": "#0EA5E9", "contact_email": "hiring-legal@example.com",    "notes": "Corporate counsel and compliance. SaaS contracts, IP, and data privacy experience required."},
    {"name": "Executive",         "position": 9, "color": "#EF4444", "contact_email": "hiring-exec@example.com",     "notes": "VP and C-level searches. Board-approved headcount only. Executive recruiter engaged."},
]

_HIRING_LABELS = [
    {"name": "Strong Yes",   "color": "#10B981"},
    {"name": "Yes",          "color": "#3B82F6"},
    {"name": "Maybe",        "color": "#F59E0B"},
    {"name": "No",           "color": "#EF4444"},
    {"name": "Referral",     "color": "#8B5CF6"},
]

_HIRING_TITLES = [
    # Engineering
    "Phone screen — Senior Backend Engineer (Alex M.)",
    "Panel interview — Senior Backend Engineer (Jamie L.)",
    "Take-home review — Backend Engineer (Sam K.)",
    "Reference check — Staff Engineer (Morgan T.)",
    "Resume review — Junior Frontend Engineer (River M.)",
    "Technical screen — Senior Frontend Engineer (Blake R.)",
    "Offer negotiation — DevOps Engineer (Parker S.)",
    "Phone screen — Site Reliability Engineer (Quinn A.)",
    "Panel interview — Engineering Manager (Sage V.)",
    "Technical screen — Data Engineer (Casey N.)",
    "Resume review — Machine Learning Engineer (Taylor F.)",
    "Debrief — Senior Backend Engineer (Reese W.)",
    # Product
    "Phone screen — Product Manager (Jordan F.)",
    "Panel interview — Senior PM (Avery C.)",
    "Case study — Associate PM (Riley N.)",
    "Reference check — Product Lead (Drew P.)",
    "Resume review — Product Analyst (Finley A.)",
    "Phone screen — Technical PM (Charlie H.)",
    "Panel interview — Director of Product (Skyler R.)",
    "Case study — Growth PM (Rowan K.)",
    "Offer negotiation — Senior PM (Blake W.)",
    "Technical screen — Platform PM (Morgan D.)",
    "Resume review — Product Operations Manager (Quinn T.)",
    "Debrief — Senior PM (Jamie S.)",
    # Design
    "Portfolio review — Senior Product Designer (Taylor O.)",
    "Design exercise — UX Researcher (Casey B.)",
    "Phone screen — Design Systems Lead (Drew V.)",
    "Panel interview — Senior UX Designer (Alex F.)",
    "Reference check — Head of Design (Riley K.)",
    "Resume review — Visual Designer (Jordan N.)",
    "Design exercise — Interaction Designer (Avery M.)",
    "Phone screen — Brand Designer (Sage L.)",
    "Portfolio review — Junior Product Designer (Parker C.)",
    "Panel interview — UX Writer (Finley G.)",
    "Offer negotiation — Senior Product Designer (Rowan B.)",
    "Debrief — Design Manager (Charlie P.)",
    # Sales
    "Phone screen — Account Executive, Enterprise (Morgan R.)",
    "Role play — Account Executive, Mid-Market (Quinn L.)",
    "Panel interview — Sales Development Rep (Taylor J.)",
    "Reference check — Senior AE (Blake F.)",
    "Resume review — Solutions Consultant (Casey W.)",
    "Phone screen — Sales Engineer (Jamie V.)",
    "Offer extended — Account Executive, SMB (River K.)",
    "Panel interview — Regional Sales Director (Avery H.)",
    "Role play — SDR Team Lead (Skyler N.)",
    "Phone screen — Channel Sales Manager (Reese D.)",
    "Resume review — Revenue Operations Analyst (Alex T.)",
    "Debrief — VP Sales (Drew G.)",
    # Marketing
    "Phone screen — Content Marketing Manager (Sage B.)",
    "Portfolio review — Growth Marketing Lead (Finley W.)",
    "Panel interview — Head of Marketing (Jordan V.)",
    "Writing sample review — SEO Specialist (Parker L.)",
    "Resume review — Demand Gen Manager (Riley T.)",
    "Phone screen — Product Marketing Manager (Charlie F.)",
    "Panel interview — Brand Marketing Lead (Quinn D.)",
    "Reference check — Marketing Operations (Rowan S.)",
    "Portfolio review — Social Media Manager (Casey K.)",
    "Offer negotiation — Content Strategist (Morgan H.)",
    "Resume review — Event Marketing Coordinator (Taylor M.)",
    "Debrief — Marketing Analytics Lead (Blake N.)",
    # Customer Success
    "Phone screen — CSM (Jordan P.)",
    "Scenario interview — Senior CSM (Avery R.)",
    "Panel interview — CS Operations Manager (Quinn W.)",
    "Reference check — Enterprise CSM (Riley J.)",
    "Resume review — Onboarding Specialist (Reese H.)",
    "Phone screen — Technical Account Manager (Morgan G.)",
    "Scenario interview — Renewals Manager (Sage C.)",
    "Panel interview — CS Team Lead (Blake D.)",
    "Offer extended — CSM (Parker T.)",
    "Resume review — Implementation Consultant (Skyler K.)",
    "Phone screen — Customer Advocacy Manager (Taylor B.)",
    "Debrief — VP Customer Success (Finley L.)",
    # Operations
    "Technical screen — DevOps Engineer (Blake T.)",
    "Phone screen — IT Administrator (Parker N.)",
    "Panel interview — SRE Lead (Rowan M.)",
    "Resume review — Business Operations Analyst (Casey V.)",
    "Technical screen — Platform Engineer (Quinn S.)",
    "Reference check — DevOps Engineer (River F.)",
    "Phone screen — Office Manager (Jordan K.)",
    "Panel interview — Head of IT (Sage D.)",
    "Technical screen — Security Engineer (Alex B.)",
    "Resume review — Procurement Specialist (Drew H.)",
    "Offer negotiation — SRE (Morgan F.)",
    "Debrief — Infrastructure Manager (Reese C.)",
    # Finance
    "Phone screen — Staff Accountant (Jamie R.)",
    "Panel interview — FP&A Analyst (Taylor C.)",
    "Reference check — Controller (Riley D.)",
    "Resume review — Revenue Accountant (Avery W.)",
    "Phone screen — Payroll Specialist (Quinn H.)",
    "Panel interview — Senior FP&A Analyst (Sage T.)",
    "Technical screen — Revenue Operations Manager (Finley B.)",
    "Resume review — Accounts Payable Coordinator (Parker G.)",
    "Offer extended — Staff Accountant (Casey R.)",
    "Phone screen — Tax Analyst (Blake K.)",
    "Panel interview — VP Finance (Drew L.)",
    "Debrief — Financial Controller (Rowan V.)",
    # Legal
    "Phone screen — Corporate Counsel (Morgan W.)",
    "Panel interview — Privacy Counsel (Jordan B.)",
    "Reference check — Senior Corporate Counsel (Riley S.)",
    "Resume review — Contracts Paralegal (Skyler G.)",
    "Phone screen — Compliance Analyst (Quinn F.)",
    "Panel interview — IP Counsel (Sage H.)",
    "Case study — Employment Counsel (Taylor D.)",
    "Resume review — Legal Operations Manager (Avery K.)",
    "Offer negotiation — Privacy Counsel (Casey M.)",
    "Phone screen — Regulatory Affairs Analyst (Blake P.)",
    "Panel interview — General Counsel (Alex C.)",
    "Debrief — Senior Corporate Counsel (Finley R.)",
    # Executive
    "Executive recruiter engagement — VP Engineering",
    "First round — VP Engineering (candidate: Chris T.)",
    "Board presentation — VP Engineering (Chris T.)",
    "Reference check — VP Engineering (Chris T.)",
    "Executive recruiter engagement — CFO",
    "First round — CFO (candidate: Dana M.)",
    "Board presentation — CFO (Dana M.)",
    "Offer negotiation — VP Engineering (Chris T.)",
    "Executive recruiter engagement — VP Marketing",
    "First round — VP Marketing (candidate: Pat R.)",
    "Panel interview — Chief of Staff (Leslie K.)",
    "Debrief — CFO search (Dana M.)",
]

HIRING_RECRUITING = {
    "slug": "hiring_recruiting",
    "name": "Template: Hiring & Recruiting",
    "description": "Track candidates from application through offer. Each swimlane is a department; each card is a candidate or hiring action.",
    "columns": _HIRING_COLUMNS,
    "swimlanes": _HIRING_SWIMLANES,
    "labels": _HIRING_LABELS,
    "extra_cards": _auto_cards(_HIRING_TITLES, _HIRING_COLUMNS, _HIRING_SWIMLANES, _HIRING_LABELS, "hiring"),
}


# ═════════════════════════════════════════════════════════════════════════════
# 9. Infrastructure & DevOps
# ═════════════════════════════════════════════════════════════════════════════

_INFRA_COLUMNS = [
    {"name": "Reported",      "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Triaged",       "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Assigned",      "position": 2, "color": "#8B5CF6", "wip_limit": None, "allow_card_creation": False},
    {"name": "In Progress",   "position": 3, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Testing",       "position": 4, "color": "#F97316", "wip_limit": None, "allow_card_creation": False},
    {"name": "Change Window", "position": 5, "color": "#EC4899", "wip_limit": None, "allow_card_creation": False},
    {"name": "Deployed",      "position": 6, "color": "#10B981", "wip_limit": None, "allow_card_creation": False},
    {"name": "Verified",      "position": 7, "color": "#14B8A6", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_INFRA_SWIMLANES = [
    {"name": "Production Kubernetes",  "position": 0, "color": "#EC4899", "contact_email": "oncall-k8s@example.com",       "notes": "EKS 1.29. 3 node groups, 12 nodes. HPA on API and worker deployments. Primary production cluster."},
    {"name": "CI/CD Pipeline",         "position": 1, "color": "#8B5CF6", "contact_email": "oncall-ci@example.com",        "notes": "GitLab CI on Kubernetes runners. Kaniko for image builds. p95 pipeline: 8 min. Zero DinD."},
    {"name": "Database Cluster",       "position": 2, "color": "#F59E0B", "contact_email": "oncall-db@example.com",        "notes": "RDS PostgreSQL 16. Primary + 2 replicas. Nightly backups to S3. Point-in-time recovery enabled."},
    {"name": "CDN & Edge",             "position": 3, "color": "#3B82F6", "contact_email": "oncall-cdn@example.com",       "notes": "CloudFront distribution. Edge caching for static assets and API responses. WAF rules enabled."},
    {"name": "Monitoring Stack",       "position": 4, "color": "#10B981", "contact_email": "oncall-monitoring@example.com", "notes": "Prometheus + Grafana + Alertmanager + PagerDuty. Jaeger for distributed tracing."},
    {"name": "Security Infrastructure","position": 5, "color": "#EF4444", "contact_email": "oncall-security@example.com",  "notes": "Vault for secrets, Falco for runtime security, Trivy for image scanning. SOC 2 controls."},
    {"name": "Staging Environment",    "position": 6, "color": "#14B8A6", "contact_email": "oncall-staging@example.com",   "notes": "Mirror of production at 1/4 scale. Auto-deployed on merge to main. Seed data refreshed nightly."},
    {"name": "Data Pipeline",          "position": 7, "color": "#6366F1", "contact_email": "oncall-data@example.com",      "notes": "Airflow on EKS. 42 DAGs. Snowflake as warehouse. dbt for transformations. 500k events/hour peak."},
    {"name": "DNS & Networking",       "position": 8, "color": "#0EA5E9", "contact_email": "oncall-network@example.com",   "notes": "Route 53 for DNS. VPC peering across 3 accounts. Transit Gateway for on-prem connectivity."},
    {"name": "Disaster Recovery",      "position": 9, "color": "#F97316", "contact_email": "oncall-dr@example.com",        "notes": "Cross-region DR in eu-west-1. RPO: 1 hour. RTO: 4 hours. Quarterly failover drills required."},
]

_INFRA_LABELS = [
    {"name": "Incident",    "color": "#EF4444"},
    {"name": "Change",      "color": "#3B82F6"},
    {"name": "Improve",     "color": "#10B981"},
    {"name": "Security",    "color": "#8B5CF6"},
    {"name": "Capacity",    "color": "#F59E0B"},
]

_INFRA_TITLES = [
    # Production Kubernetes
    "OOMKilled worker pods — analytics aggregation memory leak",
    "EKS 1.28 to 1.29 cluster upgrade",
    "Pod topology spread constraints — better AZ distribution",
    "Cluster autoscaler tuning — reduce scale-down aggression",
    "Upgrade Kubernetes to 1.30 — deprecation review",
    "Node group instance type migration — Graviton3",
    "Pod security standards enforcement — restricted profile",
    "Horizontal pod autoscaler tuning — API deployment",
    "Ingress controller upgrade — NGINX to 1.10",
    "CoreDNS memory spike investigation",
    "Service mesh evaluation — Istio vs Linkerd",
    "Namespace resource quotas — enforce per-team limits",
    # CI/CD Pipeline
    "Pipeline flakiness — Docker layer cache misses",
    "Add SAST scanning job (Semgrep) to MR pipelines",
    "Reduce test suite runtime — parallelize Vitest workers",
    "Dependency scanning job — automate CVE alerting",
    "Build caching strategy overhaul — Kaniko layers",
    "Pipeline status Slack notifications — per-team channels",
    "Artifact retention policy — reduce S3 storage costs",
    "MR pipeline timeout — increase from 30 to 45 minutes",
    "Runner fleet scaling — add 4 spot instances",
    "Container image size reduction — multi-stage builds",
    "Pipeline analytics dashboard — build time trends",
    "Secret scanning — prevent credential leaks in commits",
    # Database Cluster
    "Replica lag spike — 45s during analytics export job",
    "Index bloat cleanup — card_movements table",
    "Upgrade PostgreSQL 16.1 to 16.4 (minor patch)",
    "Evaluate pg_partman for card_movements partitioning",
    "Connection pooler upgrade — PgBouncer 1.22",
    "Slow query audit — queries over 500ms",
    "Automated vacuum tuning — large tables",
    "Read replica auto-scaling based on connection count",
    "Point-in-time recovery drill — Q2 exercise",
    "pg_stat_statements analysis — top 20 queries",
    "Database parameter group review — shared_buffers tuning",
    "Rotate TLS certificates — production database",
    # CDN & Edge
    "CloudFront cache invalidation automation for deploys",
    "WAF rule update — block SQL injection patterns",
    "Edge function for A/B testing header injection",
    "Custom error page — branded 502 and 503 pages",
    "Origin failover configuration — multi-region",
    "Cache-Control header audit — static assets",
    "Brotli compression enablement — reduce payload sizes",
    "Real user monitoring (RUM) integration at edge",
    "Geographic restriction policy for sanctioned regions",
    "SSL/TLS certificate auto-renewal validation",
    "CDN access logging — ship to S3 for analysis",
    "Edge function — bot detection and rate limiting",
    # Monitoring Stack
    "Prometheus cardinality explosion — label cleanup",
    "Grafana dashboard standardization — golden signals",
    "PagerDuty escalation policy review — update on-call rotation",
    "Jaeger trace sampling rate adjustment",
    "Alert fatigue audit — suppress low-signal alerts",
    "SLO dashboard — error budget burn rate",
    "Log aggregation — Loki deployment and configuration",
    "Synthetic monitoring — uptime checks for critical endpoints",
    "Custom Prometheus exporter for board creation metrics",
    "Alertmanager routing rules — per-team notification channels",
    "Grafana Terraform provider — dashboards as code",
    "Distributed tracing — add span for WebSocket connections",
    # Security Infrastructure
    "Vault secret rotation — database credentials",
    "Falco runtime detection rules — update for EKS 1.29",
    "Trivy image scanning — add to nightly job",
    "Network policy enforcement — deny-all default",
    "IAM role audit — remove stale service accounts",
    "OIDC federation for CI/CD — eliminate long-lived keys",
    "Security group audit — close unused ports",
    "Encryption key rotation — KMS annual rotation",
    "Container runtime security — Seccomp profile enforcement",
    "SSH bastion host hardening — jump server audit",
    "Audit log shipping to SIEM — CloudTrail to Splunk",
    "Dependency vulnerability triage — critical CVEs",
    # Staging Environment
    "Staging seed data refresh — automate nightly reset",
    "Staging SSL certificate expired — auto-renewal fix",
    "Scale staging to 1/2 production for load testing",
    "Staging database anonymization — PII masking script",
    "Feature flag service deployment — staging environment",
    "Staging environment access control — RBAC review",
    "Staging to production drift detection — Terraform plan",
    "Automated smoke tests — post-deploy verification",
    "Staging cost optimization — schedule shutdown overnight",
    "Mirror production traffic to staging — shadow mode",
    "Staging monitoring — separate Grafana workspace",
    "Staging DNS — wildcard certificate setup",
    # Data Pipeline
    "Airflow DAG failure — Snowflake ingestion timeout",
    "dbt model performance — optimize card_movements mart",
    "Data freshness SLO — alert on stale tables",
    "Airflow 2.8 upgrade — new scheduler architecture",
    "S3 event notification — trigger pipeline on upload",
    "Data quality checks — Great Expectations integration",
    "Backfill pipeline — historical card movement data",
    "Pipeline observability — Airflow metrics to Prometheus",
    "Cost allocation tags — Snowflake credit tracking per team",
    "Reverse ETL — Salesforce account sync pipeline",
    "Data retention policy — archive tables older than 2 years",
    "Pipeline idempotency audit — prevent duplicate processing",
    # DNS & Networking
    "Route 53 health check — failover to secondary region",
    "VPC peering — new analytics account connection",
    "Transit Gateway route table cleanup — stale entries",
    "DNS TTL audit — reduce for critical services",
    "Private hosted zone — internal service discovery",
    "Network ACL review — remove permissive rules",
    "IPv6 enablement — dual-stack VPC configuration",
    "Direct Connect monitoring — latency and packet loss",
    "DNS record audit — remove orphaned entries",
    "Subnet CIDR planning — allocate for new services",
    "Network flow logs — enable and ship to S3",
    "Internal DNS resolution — CoreDNS caching optimization",
    # Disaster Recovery
    "Cross-region failover drill — Q2 exercise",
    "RDS cross-region replica promotion test",
    "S3 cross-region replication lag monitoring",
    "DR runbook update — new services added since Q1",
    "Backup verification — restore to isolated environment",
    "RPO validation — measure actual replication lag",
    "DR environment cost audit — optimize standby resources",
    "Automated failover trigger — Route 53 health checks",
    "Communication plan update — incident notification tree",
    "DR documentation — architecture diagrams refresh",
    "Chaos engineering — random pod termination drill",
    "Business impact analysis — updated service criticality tiers",
]

INFRA_DEVOPS = {
    "slug": "infra_devops",
    "name": "Template: Infrastructure & DevOps",
    "description": "Track infrastructure incidents, changes, and improvements. Each swimlane is a system; each card is a work item.",
    "columns": _INFRA_COLUMNS,
    "swimlanes": _INFRA_SWIMLANES,
    "labels": _INFRA_LABELS,
    "extra_cards": _auto_cards(_INFRA_TITLES, _INFRA_COLUMNS, _INFRA_SWIMLANES, _INFRA_LABELS, "infra"),
}


# ═════════════════════════════════════════════════════════════════════════════
# 10. Legal & Compliance
# ═════════════════════════════════════════════════════════════════════════════

_LEGAL_COLUMNS = [
    {"name": "Submitted",           "position": 0, "color": "#6B7280", "wip_limit": None, "allow_card_creation": True},
    {"name": "Under Review",        "position": 1, "color": "#3B82F6", "wip_limit": None, "allow_card_creation": True},
    {"name": "Needs Clarification", "position": 2, "color": "#F59E0B", "wip_limit": None, "allow_card_creation": False},
    {"name": "Approved",            "position": 3, "color": "#10B981", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Denied",              "position": 4, "color": "#EF4444", "wip_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Closed",              "position": 5, "color": "#9CA3AF", "wip_limit": None, "allow_card_creation": False, "is_done": True},
]

_LEGAL_SWIMLANES = [
    {"name": "Contracts & Procurement",  "position": 0, "color": "#3B82F6", "contact_email": "legal-contracts@example.com",   "notes": "Vendor MSAs, order forms, procurement agreements. Average turnaround: 5 business days."},
    {"name": "Employment Law",           "position": 1, "color": "#F59E0B", "contact_email": "legal-employment@example.com",  "notes": "Employment agreements, terminations, equity plans, HR policy reviews. Sensitive — restricted access."},
    {"name": "Intellectual Property",    "position": 2, "color": "#8B5CF6", "contact_email": "legal-ip@example.com",          "notes": "Trademarks, patents, open-source license compliance, IP assignments. Annual IP audit required."},
    {"name": "Data Privacy (GDPR)",      "position": 3, "color": "#EC4899", "contact_email": "legal-privacy@example.com",     "notes": "DPAs, GDPR compliance, data subject requests, privacy impact assessments. DPO oversight."},
    {"name": "Regulatory Compliance",    "position": 4, "color": "#EF4444", "contact_email": "legal-compliance@example.com",  "notes": "SOC 2, HIPAA, PCI-DSS, industry-specific regulations. Audit deadlines are hard stops."},
    {"name": "Corporate Governance",     "position": 5, "color": "#10B981", "contact_email": "legal-corporate@example.com",   "notes": "Board resolutions, shareholder agreements, corporate filings. Quarterly board meeting prep."},
    {"name": "Litigation Management",    "position": 6, "color": "#F97316", "contact_email": "legal-litigation@example.com",  "notes": "Active disputes, demand letters, settlement negotiations. Outside counsel: Morrison & Associates."},
    {"name": "Insurance & Risk",         "position": 7, "color": "#14B8A6", "contact_email": "legal-insurance@example.com",   "notes": "D&O, E&O, cyber liability, general liability. Annual renewal cycle: November."},
    {"name": "Real Estate & Leases",     "position": 8, "color": "#6366F1", "contact_email": "legal-realestate@example.com",  "notes": "Office leases, co-working agreements, lease renewals. SF office lease expires Dec 2027."},
    {"name": "Tax & Finance",            "position": 9, "color": "#0EA5E9", "contact_email": "legal-tax@example.com",         "notes": "Tax filings, transfer pricing, R&D tax credits, sales tax nexus. External advisor: Deloitte."},
]

_LEGAL_LABELS = [
    {"name": "Contract",   "color": "#3B82F6"},
    {"name": "Policy",     "color": "#8B5CF6"},
    {"name": "Compliance", "color": "#F97316"},
    {"name": "Urgent",     "color": "#EF4444"},
    {"name": "OSS",        "color": "#10B981"},
]

_LEGAL_TITLES = [
    # Contracts & Procurement
    "Review vendor NDA — CloudPeak Inc",
    "Snowflake DPA — data processing agreement",
    "AWS Enterprise Discount Program — annual renewal",
    "Stripe payment processing agreement renewal",
    "New SaaS vendor contract — project management tool",
    "Zapier developer partner agreement review",
    "Accounting software DPA — new bookkeeping vendor",
    "Cloud hosting MSA — GCP commitment terms",
    "Office supplies procurement — annual contract renewal",
    "IT hardware vendor agreement — laptop fleet refresh",
    "Consulting services MSA — design agency retainer",
    "Software license audit — annual true-up review",
    # Employment Law
    "Independent contractor agreement — new design consultant",
    "Remote work policy update — international contractors",
    "Equity plan amendment — RSU vesting cliff change",
    "Parental leave policy — align to UK statutory minimum",
    "Non-compete clause review — departing VP Engineering",
    "Severance agreement — terminated employee",
    "Employee handbook annual update — Q2 2026",
    "Contractor classification audit — IRS 20-factor test",
    "Workplace harassment policy — annual training compliance",
    "Immigration sponsorship — H-1B petition for engineer",
    "Equity refresh grant — board approval package",
    "Return-to-office policy — hybrid work agreement template",
    # Intellectual Property
    "Apache 2.0 compatibility review — new OSS dependencies",
    "BUSL license review — HashiCorp Terraform",
    "Trademark application — Visiban wordmark in EU",
    "Patent prior art search — board analytics algorithm",
    "IP assignment agreement — new hire onboarding",
    "Open-source contribution policy update",
    "Copyright takedown response — DMCA notice received",
    "Trade secret audit — classify internal documentation",
    "Domain name portfolio review — renewal decisions",
    "Logo trademark opposition — similar mark in Class 9",
    "OSS license compliance scan — quarterly CI report",
    "Invention disclosure review — card AI features",
    # Data Privacy (GDPR)
    "GDPR data mapping audit — Q2",
    "Data subject access request — user 4821",
    "Privacy impact assessment — analytics dashboard feature",
    "Cookie consent mechanism audit — ePrivacy compliance",
    "Standard contractual clauses update — Schrems II",
    "GDPR Article 30 records of processing update",
    "Data breach notification procedure — annual drill",
    "Privacy policy update — AI feature disclosures",
    "Third-party data sharing agreement — analytics partner",
    "Children's data assessment — COPPA compliance check",
    "Cross-border data transfer review — new APAC region",
    "Data retention policy review — align to legal minimums",
    # Regulatory Compliance
    "SOC 2 Type II audit — evidence package assembly",
    "HIPAA BAA — BlueSky Health business associate agreement",
    "PCI-DSS self-assessment questionnaire — annual filing",
    "SOC 2 bridge letter for enterprise prospect",
    "CCPA consumer request process audit",
    "ISO 27001 gap analysis — certification roadmap",
    "FedRAMP authorization — preliminary assessment",
    "Accessibility compliance — VPAT documentation update",
    "Export control screening — new customer onboarding",
    "Anti-money laundering review — payment flow assessment",
    "DORA compliance assessment — EU digital resilience",
    "Industry-specific compliance — healthcare customer review",
    # Corporate Governance
    "Board meeting preparation — Q2 2026 materials",
    "Shareholder agreement amendment — new investor round",
    "Corporate annual report filing — state of Delaware",
    "Board resolution — approve Series B term sheet",
    "Subsidiary formation — EU operating entity",
    "Capitalization table update — post-funding round",
    "Insider trading policy — quarterly blackout reminder",
    "Board observer rights agreement — investor request",
    "Corporate bylaws amendment — committee structure",
    "Annual meeting minutes — shareholder vote documentation",
    "Stock option pool expansion — board approval",
    "Related party transaction disclosure — annual review",
    # Litigation Management
    "Demand letter response — former contractor IP claim",
    "Settlement negotiation — customer data dispute",
    "Patent infringement claim — defensive analysis",
    "Employment discrimination complaint — EEOC response",
    "Breach of contract claim — vendor non-performance",
    "Class action assessment — consumer data privacy suit",
    "Arbitration preparation — licensing fee dispute",
    "Litigation hold notice — preserve relevant documents",
    "Expert witness engagement — damages calculation",
    "Court filing deadline — motion to dismiss brief",
    "Mediation scheduling — customer contract dispute",
    "Insurance claim submission — D&O coverage trigger",
    # Insurance & Risk
    "Cyber liability policy renewal — annual review",
    "D&O insurance — coverage increase for Series B",
    "E&O policy review — professional services coverage",
    "General liability certificate — landlord requirement",
    "Workers compensation audit — annual premium review",
    "Risk assessment matrix — quarterly update",
    "Business interruption coverage — pandemic clause review",
    "Umbrella policy renewal — excess liability limits",
    "Vendor insurance certificate verification — top 10",
    "Cyber insurance claim — credential stuffing incident",
    "Key person insurance evaluation — CEO and CTO",
    "Travel insurance policy — international employee coverage",
    # Real Estate & Leases
    "SF office lease renewal — December 2027 expiry planning",
    "Co-working space agreement — NYC satellite office",
    "Lease amendment — SF office expansion (floor 3)",
    "Sublease review — vacating unused office space",
    "Office build-out approval — landlord consent request",
    "Property tax assessment appeal — SF office",
    "Maintenance responsibility matrix — landlord vs tenant",
    "Parking agreement amendment — additional spaces",
    "Security deposit return — closed Portland office",
    "ADA compliance audit — office accessibility review",
    "Lease abstract preparation — portfolio summary",
    "Remote office stipend policy — home office reimbursement",
    # Tax & Finance
    "R&D tax credit filing — federal and California",
    "Sales tax nexus analysis — new state registrations",
    "Transfer pricing documentation — intercompany transactions",
    "Quarterly estimated tax payment — Q2 2026",
    "Tax provision review — ASC 740 compliance",
    "State income tax filing — multi-state apportionment",
    "International tax structure — EU subsidiary setup",
    "Audit defense preparation — IRS notice received",
    "Revenue recognition review — ASC 606 compliance",
    "Tax impact analysis — equity compensation plans",
    "Property tax filing — business personal property",
    "Withholding tax review — international contractor payments",
]

LEGAL_COMPLIANCE = {
    "slug": "legal_compliance",
    "name": "Template: Legal & Compliance",
    "description": "Track contracts, policy requests, and compliance reviews. Each swimlane is a practice area; each card is a request or obligation.",
    "columns": _LEGAL_COLUMNS,
    "swimlanes": _LEGAL_SWIMLANES,
    "labels": _LEGAL_LABELS,
    "extra_cards": _auto_cards(_LEGAL_TITLES, _LEGAL_COLUMNS, _LEGAL_SWIMLANES, _LEGAL_LABELS, "legal"),
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
