"""Gallery metadata for the sample boards (#1452).

One entry per template in ``generate_seed_data.ALL_TEMPLATES``. The generator
joins this with facts it derives from each generated board (active card count,
which features the board actually carries) to write ``manifest.json``. Keep
only what cannot be derived here: the clean display title, a one-line summary,
the swimlane theme, the display order, and the docs highlights.

``slug`` is a persisted contract (it is the manifest ``id`` and the file
name): never rename one.
"""

GALLERY = [
    {
        "slug": "sales_overlay",
        "title": "Sales Overlay",
        "summary": "See which accounts have coverage gaps under an enterprise overlay sales model.",
        "swimlane_theme": "account",
        "order": 1,
        "highlights": (
            "Enterprise overlay coverage: AD, AE, SA, overlay AE/SA pods and services lead per account. "
            "Uses every custom field type and all 15 swimlane fields. One account is partly covered "
            "and one has no overlay coverage"
        ),
    },
    {
        "slug": "simple_kanban",
        "title": "Simple Kanban",
        "summary": "A general-purpose team board with story points and merge request links.",
        "swimlane_theme": "team",
        "order": 2,
        "highlights": "Story points, sprint, GitLab merge request links",
    },
    {
        "slug": "sales_pipeline",
        "title": "Sales Pipeline",
        "summary": "Track deals from first prospect to closed, by region.",
        "swimlane_theme": "region",
        "order": 3,
        "highlights": "Deal value, forecast category, win probability, competitors",
    },
    {
        "slug": "product_roadmap",
        "title": "Product Roadmap",
        "summary": "Move features from idea to launch, by product area.",
        "swimlane_theme": "product area",
        "order": 4,
        "highlights": "RICE score, target quarter, platforms, GitHub issue links",
    },
    {
        "slug": "customer_support",
        "title": "Customer Support",
        "summary": "Triage and resolve support tickets by customer account.",
        "swimlane_theme": "customer account",
        "order": 5,
        "highlights": "Severity, SLA due, affected components, support plan per account",
    },
    {
        "slug": "customer_success",
        "title": "Customer Success",
        "summary": "Watch account health, adoption and renewals by segment.",
        "swimlane_theme": "segment",
        "order": 6,
        "highlights": "Health score, ARR at stake, risk driver, products adopted",
    },
    {
        "slug": "project_delivery",
        "title": "Project Delivery",
        "summary": "Follow cross-functional projects from planning to retrospective.",
        "swimlane_theme": "project",
        "order": 7,
        "highlights": "RAG status, percent complete, budget, sponsor per project",
    },
    {
        "slug": "content_production",
        "title": "Content Production",
        "summary": "Take content from pitch to published, by channel.",
        "swimlane_theme": "channel",
        "order": 8,
        "highlights": "Content type, publish date, word count, channels",
    },
    {
        "slug": "hiring_recruiting",
        "title": "Hiring & Recruiting",
        "summary": "Move candidates from sourcing to offer, by department.",
        "swimlane_theme": "department",
        "order": 9,
        "highlights": "Level, source, interview loop, admin-only comp budget",
    },
    {
        "slug": "infra_devops",
        "title": "Infrastructure & DevOps",
        "summary": "Track infrastructure and operations work by system.",
        "swimlane_theme": "system",
        "order": 10,
        "highlights": "Severity, environments, SLO and tier per system, merge request links",
    },
    {
        "slug": "legal_compliance",
        "title": "Legal & Compliance",
        "summary": "Manage legal documents and compliance deadlines by practice area.",
        "swimlane_theme": "practice area",
        "order": 11,
        "highlights": "Risk, deadline, jurisdictions, admin-only privilege note",
    },
]
