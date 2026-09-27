"""Static content for the hosted demo site boards (#1034).

Used only by ``seed_demo_data --demo-site``. Lives beside the command (the
leading underscore keeps Django from registering it as a command of its own)
so the ~60 hand-written cards do not bloat the generator module.

Everything here is deterministic — no ``random`` — so the nightly reset
produces the same boards every night, and it never touches the ``random``
stream the default seed depends on (the committed ``sample-boards`` snapshot
must stay byte-identical).

Card tuple layout:
    (title, description, column_index, swimlane_index, priority, assignee,
     label_names, comments)
where ``assignee`` is a key of DEMO_SITE_USERS or None, and ``comments`` is a
list of (author_key, body).
"""

# key -> (username, first_name, last_name, is_admin). Admin's username is
# overridden by settings.DEMO_LOGIN_USERNAME at seed time so the published
# credentials always match the seeded account.
DEMO_SITE_USERS = {
    "admin": ("admin", "Demo", "Admin", True),
    "maya": ("maya", "Maya", "Torres", False),
    "jordan": ("jordan", "Jordan", "Lee", False),
}

BOARDS = [
    {
        "name": "Software Team",
        "description": "A product engineering board: bugs, features, and tech debt flowing to release.",
        "columns": [
            ("Backlog", "#6B7280", False),
            ("In Progress", "#F59E0B", False),
            ("Review", "#8B5CF6", False),
            ("Done", "#10B981", True),
        ],
        "swimlanes": [("Web app", "#3B82F6"), ("API", "#22C55E"), ("Infrastructure", "#F97316")],
        "labels": [("Bug", "#EF4444"), ("Feature", "#3B82F6"), ("Tech debt", "#F59E0B")],
        "cards": [
            ("Fix login redirect loop on mobile", "Users who open a deep link while signed out land on the dashboard after login instead of the link.", 1, 0, "high", "maya", ("Bug",),
             [("jordan", "Reproduced on iOS Safari. Storing the pre-auth route in sessionStorage.")]),
            ("Add keyboard shortcut to create a card", "Press `c` on the board to open the quick-add input in the focused swimlane.", 2, 0, "medium", "jordan", ("Feature",),
             [("maya", "Looks great. Can we show the shortcut in the tooltip too?")]),
            ("Dark mode contrast on disabled buttons", "Disabled primary buttons fall below 3:1 contrast in dark mode.", 0, 0, "low", None, ("Bug",), []),
            ("Drag handles need larger touch targets", "Touch targets are 24px; aim for 44px per WCAG 2.5.5.", 0, 0, "medium", "maya", ("Tech debt",), []),
            ("Board-level search", "Search card titles and descriptions from the board header.", 1, 0, "high", "admin", ("Feature",),
             [("admin", "Backend endpoint is up; wiring the UI now."), ("jordan", "Remember to debounce the input.")]),
            ("Empty state copy for a fresh board", "Replace the blank board with a friendly first-card prompt.", 3, 0, "low", "maya", ("Feature",), []),
            ("Paginate movement history", "The history endpoint returns everything; add cursor pagination.", 2, 1, "high", "jordan", ("Tech debt",),
             [("admin", "Please keep the response shape backward compatible.")]),
            ("Fix pagination cursors on Safari", "Cursor param is double-encoded when it contains a plus sign.", 3, 1, "medium", "jordan", ("Bug",), []),
            ("Rate limit auth endpoints", "Throttle login and password-reset attempts per IP.", 1, 1, "urgent", "admin", ("Feature",), []),
            ("Document the card weight rollup", "Explain how weights roll up per swimlane in the API docs.", 0, 1, "low", None, ("Tech debt",), []),
            ("Audit endpoints for IDOR", "Confirm every detail endpoint checks object-level access.", 2, 1, "urgent", "admin", ("Tech debt",),
             [("maya", "Found two candidates in the attachments routes; filed follow-ups.")]),
            ("Add health check for the load balancer", "A cheap /healthz that checks the DB connection.", 3, 1, "medium", "jordan", ("Feature",), []),
            ("Upgrade PostgreSQL 15 to 16", "Plan the maintenance window and test the restore path.", 0, 2, "medium", None, ("Tech debt",), []),
            ("Automated database backups to S3", "Nightly pg_dump with 14-day retention.", 1, 2, "high", "admin", ("Feature",),
             [("jordan", "Restore drill scheduled for Friday.")]),
            ("Reduce frontend bundle below 200 KB gzipped", "Split the analytics charts into a lazy chunk.", 2, 2, "medium", "maya", ("Tech debt",), []),
            ("Set up preview environments for merge requests", "One ephemeral stack per MR, torn down on merge.", 0, 2, "low", None, ("Feature",), []),
            ("Migrate CI images to kaniko", "Drop Docker-in-Docker from the build jobs.", 3, 2, "medium", "jordan", ("Tech debt",), []),
            ("Investigate flaky concurrent-moves test", "Fails roughly one run in twenty; suspect a missing row lock.", 1, 2, "high", "jordan", ("Bug",),
             [("admin", "Bisected to the reorder helper. Adding select_for_update.")]),
            ("Structured JSON logging", "Emit one JSON object per log line for the aggregator.", 3, 2, "low", "maya", ("Feature",), []),
            ("Write the on-call runbook", "First-response steps for the top five alerts.", 0, 2, "medium", None, ("Tech debt",), []),
        ],
    },
    {
        "name": "Marketing Campaigns",
        "description": "Content, campaigns, and events from idea to published.",
        "columns": [
            ("Ideas", "#6B7280", False),
            ("Drafting", "#F59E0B", False),
            ("Review", "#8B5CF6", False),
            ("Published", "#10B981", True),
        ],
        "swimlanes": [("Content", "#EC4899"), ("Campaigns", "#6366F1"), ("Events", "#14B8A6")],
        "labels": [("Blog", "#3B82F6"), ("Social", "#EC4899"), ("Paid", "#F59E0B")],
        "cards": [
            ("Why Kanban beats sprints for support teams", "Long-form post with two customer examples.", 1, 0, "high", "maya", ("Blog",),
             [("admin", "Great angle. Please add a chart of cycle time.")]),
            ("Release notes: what shipped this quarter", "Friendly summary with screenshots of the top five changes.", 2, 0, "medium", "jordan", ("Blog",), []),
            ("Ten keyboard shortcuts every board power user knows", "Listicle with animated GIFs.", 3, 0, "medium", "maya", ("Blog", "Social"), []),
            ("Case study: from spreadsheets to a shared board", "Interview with a design agency.", 0, 0, "high", None, ("Blog",), []),
            ("Getting started video script", "Two-minute walkthrough for the landing page.", 1, 0, "medium", "admin", (), []),
            ("Comparison page: Visiban vs. sticky notes", "Tongue-in-cheek but useful.", 0, 0, "low", None, ("Blog",), []),
            ("Spring launch email sequence", "Three emails over two weeks.", 2, 1, "high", "maya", (), [("admin", "Subject lines look strong; tighten the second body.")]),
            ("Retargeting ads for trial abandoners", "Two creatives, capped at a small daily budget.", 1, 1, "medium", "jordan", ("Paid",), []),
            ("Product Hunt launch plan", "Assets, hunter outreach, and a launch-day checklist.", 1, 1, "urgent", "maya", ("Social",),
             [("jordan", "Hunter confirmed for Tuesday.")]),
            ("Referral program landing page", "Copy and layout for the invite-a-teammate page.", 0, 1, "medium", None, (), []),
            ("Newsletter template refresh", "Match the new brand colors.", 3, 1, "low", "jordan", (), []),
            ("A/B test the homepage hero", "Test two headlines against sign-up rate.", 2, 1, "medium", "admin", ("Paid",), []),
            ("Social calendar for next month", "Twelve posts across two channels.", 3, 1, "medium", "maya", ("Social",), []),
            ("Conference booth design", "Banner, table cloth, and a demo loop on a laptop.", 1, 2, "high", "jordan", (),
             [("maya", "Printer needs files by the 12th.")]),
            ("Webinar: running a flow-based standup", "Slides and a live board demo.", 2, 2, "medium", "admin", (), []),
            ("Meetup sponsorship shortlist", "Five local meetups worth sponsoring.", 0, 2, "low", None, (), []),
            ("Swag order: stickers and notebooks", "Quote from two vendors.", 3, 2, "low", "maya", (), []),
            ("Post-event follow-up emails", "Segmented by booth conversation.", 0, 2, "medium", None, (), []),
            ("Customer advisory call agenda", "Questions on onboarding friction.", 1, 2, "medium", "jordan", (), []),
            ("Recap blog post: the community meetup", "Photos, quotes, and slides.", 3, 2, "low", "maya", ("Blog", "Social"), []),
        ],
    },
    {
        "name": "Hiring Pipeline",
        "description": "Candidates moving from applied to offer across open roles.",
        "columns": [
            ("Applied", "#6B7280", False),
            ("Screening", "#3B82F6", False),
            ("Interview", "#8B5CF6", False),
            ("Offer", "#10B981", True),
        ],
        "swimlanes": [("Engineering", "#3B82F6"), ("Design", "#EC4899"), ("Go-to-market", "#F97316")],
        "labels": [("Strong fit", "#10B981"), ("Needs follow-up", "#F59E0B"), ("Referral", "#6366F1")],
        "cards": [
            ("Priya S. - Senior Backend Engineer", "Six years of Django and Postgres; open source maintainer.", 2, 0, "high", "jordan", ("Strong fit", "Referral"),
             [("jordan", "Great systems-design round. Recommend moving to the panel.")]),
            ("Tomas R. - Backend Engineer", "Go and Python; wants to move to a smaller team.", 1, 0, "medium", "jordan", (), []),
            ("Aiko N. - Frontend Engineer", "React and accessibility specialist.", 3, 0, "high", "admin", ("Strong fit",),
             [("admin", "Offer approved. Sending Monday.")]),
            ("Marcus D. - Full-stack Engineer", "Bootcamp graduate with a strong portfolio.", 0, 0, "low", None, (), []),
            ("Elena V. - Site Reliability Engineer", "Kubernetes and observability background.", 1, 0, "medium", "jordan", ("Needs follow-up",), []),
            ("Sam K. - Staff Engineer", "Referred by an advisor; wants a remote role.", 2, 0, "high", "admin", ("Referral",), []),
            ("Noah B. - QA Engineer", "Test automation with Playwright.", 0, 0, "low", None, (), []),
            ("Chloe W. - Engineering Manager", "Managed a team of nine at a Series B.", 1, 0, "medium", "admin", (), []),
            ("Lucia F. - Product Designer", "Portfolio shows strong design-system work.", 2, 1, "high", "maya", ("Strong fit",),
             [("maya", "Whiteboard exercise on Thursday.")]),
            ("Ben H. - Product Designer", "Agency background; light on B2B.", 1, 1, "medium", "maya", (), []),
            ("Rahul M. - UX Researcher", "Ran a diary study for a workflow tool.", 0, 1, "medium", None, ("Needs follow-up",), []),
            ("Ines G. - Brand Designer", "Freelance; available in six weeks.", 3, 1, "low", "maya", (), []),
            ("Owen P. - Illustrator", "Would help with docs and marketing art.", 0, 1, "low", None, (), []),
            ("Dana C. - Sales Lead", "Sold to mid-size ops teams for five years.", 2, 2, "high", "admin", ("Strong fit",), []),
            ("Kofi A. - Customer Success Manager", "Onboarding specialist.", 1, 2, "medium", "admin", ("Referral",),
             [("jordan", "References were glowing.")]),
            ("Hannah L. - Content Marketer", "Ex-developer, writes well about tooling.", 3, 2, "medium", "maya", ("Strong fit",), []),
            ("Victor Z. - Growth Marketer", "Paid and lifecycle experience.", 0, 2, "low", None, (), []),
            ("Mei T. - Solutions Engineer", "Pre-sales for developer tools.", 1, 2, "medium", "admin", ("Needs follow-up",), []),
            ("Leo J. - Community Manager", "Runs a 5k-member developer forum.", 2, 2, "medium", "maya", (), []),
            ("Sofia Q. - Partnerships Manager", "Integrations background.", 0, 2, "low", None, (), []),
        ],
    },
]
