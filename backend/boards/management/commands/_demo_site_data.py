"""Static content for the hosted demo site boards (#1034, #1363).

Used only by ``seed_demo_data --demo-site``. Lives beside the command (the
leading underscore keeps Django from registering it as a command of its own)
so the ~60 hand-written cards do not bloat the generator module.

Everything here is deterministic — no ``random`` — so the hourly reset
produces the same boards every time, and it never touches the ``random``
stream the default seed depends on (the committed ``sample-boards`` snapshot
must stay byte-identical).

Card tuple layout:
    (title, description, column_index, swimlane_index, priority, assignee,
     label_names, comments, last_moved_days_ago, due_offset_days)
where ``assignee`` is a key of DEMO_SITE_USERS or None, and ``comments`` is a
list of (author_key, body). A body may contain the literal ``{visitor}``,
replaced with the published visitor's username at seed time (it is an
@mention that backs a seeded "mentioned you" notification).

Temporal realism (#1363). ``last_moved_days_ago`` is how many days before
today's midnight (UTC) the card's most recent movement happened; it alone
decides the staleness tint (boards use a 7-day threshold with the default
50% warning, so 0-2 reads fresh, 4-6 aging and 8+ stale; 3 and 7 are avoided
because the hourly reset lands anywhere in the day and they would straddle a
boundary). ``due_offset_days`` is the due date relative to today, or None for
no due date. Both are written out per card instead of derived from the card's
index: a formula is what made 18 of 20 cards stale before #1363. Stale and
overdue are reserved for in-flight work; Done-column cards have no due date
and moved in the last two days.

Each board dict also carries the showcase extras (#1363), all keyed by card
title (titles are unique per board) or swimlane name:
    card_fields          [(name, field_type, choices, show_on_card, help_text)]
    card_field_values    {card_title: {field_name: value}}
    swimlane_fields      [(name, field_type, choices, show_on_row, is_admin_only, help_text)]
    swimlane_field_values {lane_name: {field_name: value}}
    checklists           {card_title: [(text, is_checked), ...]}
    relations            [(from_title, "blocks" | "relates_to", to_title)]
    external_refs        {card_title: (provider, ref, url)}
"""

# key -> (username, first_name, last_name, is_admin). The "visitor" username is
# overridden by settings.DEMO_LOGIN_USERNAME at seed time so the published
# credentials always match the seeded account (#1179: the published account is
# the non-admin visitor, never the site admin).
#
# The visitor is never an assignee, comment author or history mover below — it
# is every visitor at once, so seeded content attributed to it would read as
# someone else's words or work. #1363 narrows that rule by exactly one thing:
# the visitor is the RECIPIENT of the seeded inbox (VISITOR_NOTIFICATIONS) and
# may be @mentioned in a comment someone else wrote, because an empty inbox
# hides a whole feature. Every seeded notification's actor is someone else (or
# nobody, for the system's stale / due-soon alerts), matching the product rule
# that nobody is notified about their own action.
DEMO_SITE_USERS = {
    "admin": ("admin", "Demo", "Admin", True),
    "visitor": ("visitor", "Demo", "Visitor", False),
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
             [("jordan", "Reproduced on iOS Safari. Storing the pre-auth route in sessionStorage.")], 1, 2),
            ("Add keyboard shortcut to create a card", "Press `c` on the board to open the quick-add input in the focused swimlane.", 2, 0, "medium", "jordan", ("Feature",),
             [("maya", "Looks great. Can we show the shortcut in the tooltip too?")], 0, 0),
            ("Dark mode contrast on disabled buttons", "Disabled primary buttons fall below 3:1 contrast in dark mode.", 0, 0, "low", None, ("Bug",), [], 9, None),
            ("Drag handles need larger touch targets", "Touch targets are 24px; aim for 44px per WCAG 2.5.5.", 0, 0, "medium", "maya", ("Tech debt",), [], 5, 10),
            ("Board-level search", "Search card titles and descriptions from the board header.", 1, 0, "high", "admin", ("Feature",),
             [("admin", "Backend endpoint is up; wiring the UI now."), ("jordan", "Remember to debounce the input."),
              ("jordan", "@{visitor} can you try the search box and tell me if the debounce feels right?")], 2, 0),
            ("Empty state copy for a fresh board", "Replace the blank board with a friendly first-card prompt.", 3, 0, "low", "maya", ("Feature",), [], 1, None),
            ("Paginate movement history", "The history endpoint returns everything; add cursor pagination.", 2, 1, "high", "jordan", ("Tech debt",),
             [("admin", "Please keep the response shape backward compatible."), ("jordan", "Parked until the flaky test is fixed; CI is red on this branch.")], 8, -2),
            ("Fix pagination cursors on Safari", "Cursor param is double-encoded when it contains a plus sign.", 3, 1, "medium", "jordan", ("Bug",), [], 2, None),
            ("Rate limit auth endpoints", "Throttle login and password-reset attempts per IP.", 1, 1, "urgent", "admin", ("Feature",), [], 4, -1),
            ("Document the card weight rollup", "Explain how weights roll up per swimlane in the API docs.", 0, 1, "low", None, ("Tech debt",), [], 12, None),
            ("Audit endpoints for IDOR", "Confirm every detail endpoint checks object-level access.", 2, 1, "urgent", "admin", ("Tech debt",),
             [("maya", "Found two candidates in the attachments routes; filed follow-ups.")], 1, 1),
            ("Add health check for the load balancer", "A cheap /healthz that checks the DB connection.", 3, 1, "medium", "jordan", ("Feature",), [], 0, None),
            ("Upgrade PostgreSQL 15 to 16", "Plan the maintenance window and test the restore path.", 0, 2, "medium", None, ("Tech debt",), [], 6, 14),
            ("Automated database backups to S3", "Nightly pg_dump with 14-day retention.", 1, 2, "high", "admin", ("Feature",),
             [("jordan", "Restore drill scheduled for Friday.")], 2, 5),
            ("Reduce frontend bundle below 200 KB gzipped", "Split the analytics charts into a lazy chunk.", 2, 2, "medium", "maya", ("Tech debt",), [], 5, 3),
            ("Set up preview environments for merge requests", "One ephemeral stack per MR, torn down on merge.", 0, 2, "low", None, ("Feature",), [], 0, None),
            ("Migrate CI images to kaniko", "Drop Docker-in-Docker from the build jobs.", 3, 2, "medium", "jordan", ("Tech debt",), [], 1, None),
            ("Investigate flaky concurrent-moves test", "Fails roughly one run in twenty; suspect a missing row lock.", 1, 2, "high", "jordan", ("Bug",),
             [("admin", "Bisected to the reorder helper. Adding select_for_update.")], 10, -4),
            ("Structured JSON logging", "Emit one JSON object per log line for the aggregator.", 3, 2, "low", "maya", ("Feature",), [], 2, None),
            ("Write the on-call runbook", "First-response steps for the top five alerts.", 0, 2, "medium", None, ("Tech debt",), [], 1, 7),
        ],
        "card_fields": [
            ("Story points", "number", [], True, "Relative effort, on a Fibonacci scale."),
            ("Target release", "dropdown", ["1.4", "1.5", "Later"], False, "The release this is planned to ship in."),
        ],
        "card_field_values": {
            "Fix login redirect loop on mobile": {"Story points": "3", "Target release": "1.4"},
            "Add keyboard shortcut to create a card": {"Story points": "2", "Target release": "1.4"},
            "Dark mode contrast on disabled buttons": {"Story points": "1", "Target release": "Later"},
            "Drag handles need larger touch targets": {"Story points": "3", "Target release": "1.5"},
            "Board-level search": {"Story points": "8", "Target release": "1.4"},
            "Empty state copy for a fresh board": {"Story points": "1", "Target release": "1.4"},
            "Paginate movement history": {"Story points": "5", "Target release": "1.4"},
            "Fix pagination cursors on Safari": {"Story points": "2", "Target release": "1.4"},
            "Rate limit auth endpoints": {"Story points": "5", "Target release": "1.4"},
            "Audit endpoints for IDOR": {"Story points": "8", "Target release": "1.4"},
            "Add health check for the load balancer": {"Story points": "2"},
            "Upgrade PostgreSQL 15 to 16": {"Story points": "8", "Target release": "1.5"},
            "Automated database backups to S3": {"Story points": "5", "Target release": "1.4"},
            "Reduce frontend bundle below 200 KB gzipped": {"Story points": "5", "Target release": "1.5"},
            "Migrate CI images to kaniko": {"Story points": "3"},
            "Investigate flaky concurrent-moves test": {"Story points": "3", "Target release": "1.4"},
            "Structured JSON logging": {"Story points": "3"},
            "Write the on-call runbook": {"Story points": "2", "Target release": "1.5"},
        },
        "swimlane_fields": [
            ("Service tier", "dropdown", ["Tier 1", "Tier 2", "Tier 3"], True, False, "How quickly an outage here must be answered."),
            ("Cost center", "text", [], True, True, ""),
        ],
        "swimlane_field_values": {
            "Web app": {"Service tier": "Tier 1", "Cost center": "ENG-110"},
            "API": {"Service tier": "Tier 1", "Cost center": "ENG-120"},
            "Infrastructure": {"Service tier": "Tier 2", "Cost center": "ENG-140"},
        },
        "checklists": {
            "Add keyboard shortcut to create a card": [
                ("Code review approved", True), ("Changelog entry", True),
                ("Docs updated", False), ("QA on Safari and Firefox", False),
            ],
            "Board-level search": [
                ("Search endpoint with pagination", True), ("Debounced search input", True),
                ("Highlight matches in card titles", False), ("Keyboard shortcut to focus search", False),
            ],
            "Paginate movement history": [
                ("Cursor pagination on the history endpoint", True),
                ("Backward-compatible response shape", True), ("Update the API docs", False),
            ],
            "Rate limit auth endpoints": [
                ("Throttle login per IP", True), ("Throttle password reset", False),
                ("Return a Retry-After header", False), ("Alert on sustained 429s", False),
            ],
            "Audit endpoints for IDOR": [
                ("Boards and cards", True), ("Attachments", True), ("Comments", False),
                ("Saved filters", False), ("Webhooks", False),
            ],
            "Automated database backups to S3": [
                ("Nightly pg_dump job", True), ("Upload to S3 with a 14-day lifecycle", True),
                ("Restore drill", False), ("Document restore steps in the runbook", False),
            ],
            "Investigate flaky concurrent-moves test": [
                ("Reproduce locally under load", True), ("Bisect to the offending commit", True),
                ("Add select_for_update to the reorder helper", False), ("Run the suite 100 times", False),
            ],
            "Migrate CI images to kaniko": [
                ("Swap the build jobs to kaniko", True), ("Remove the dind service", True),
                ("Release checklist signed off", True),
            ],
        },
        "relations": [
            ("Automated database backups to S3", "blocks", "Upgrade PostgreSQL 15 to 16"),
            ("Investigate flaky concurrent-moves test", "blocks", "Paginate movement history"),
            ("Fix pagination cursors on Safari", "relates_to", "Paginate movement history"),
            ("Write the on-call runbook", "relates_to", "Add health check for the load balancer"),
        ],
        # Deliberately fictional hosts (example.com subdomains) and demo paths.
        "external_refs": {
            "Add keyboard shortcut to create a card": (
                "gitlab", "demo/visiban-web!212", "https://gitlab.example.com/demo/visiban-web/-/merge_requests/212",
            ),
            "Paginate movement history": (
                "github", "demo-org/visiban-api#87", "https://github.example.com/demo-org/visiban-api/pull/87",
            ),
            "Audit endpoints for IDOR": (
                "gitlab", "demo/visiban-api!341", "https://gitlab.example.com/demo/visiban-api/-/merge_requests/341",
            ),
            "Fix pagination cursors on Safari": (
                "github", "demo-org/visiban-web#58", "https://github.example.com/demo-org/visiban-web/pull/58",
            ),
            "Reduce frontend bundle below 200 KB gzipped": (
                "gitlab", "demo/visiban-web!219", "https://gitlab.example.com/demo/visiban-web/-/merge_requests/219",
            ),
        },
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
             [("admin", "Great angle. Please add a chart of cycle time.")], 2, 3),
            ("Release notes: what shipped this quarter", "Friendly summary with screenshots of the top five changes.", 2, 0, "medium", "jordan", ("Blog",), [], 1, 0),
            ("Ten keyboard shortcuts every board power user knows", "Listicle with animated GIFs.", 3, 0, "medium", "maya", ("Blog", "Social"), [], 1, None),
            ("Case study: from spreadsheets to a shared board", "Interview with a design agency.", 0, 0, "high", None, ("Blog",), [], 5, 12),
            ("Getting started video script", "Two-minute walkthrough for the landing page.", 1, 0, "medium", "admin", (), [], 9, -3),
            ("Comparison page: Visiban vs. sticky notes", "Tongue-in-cheek but useful.", 0, 0, "low", None, ("Blog",), [], 13, None),
            ("Spring launch email sequence", "Three emails over two weeks.", 2, 1, "high", "maya", (),
             [("admin", "Subject lines look strong; tighten the second body."),
              ("maya", "@{visitor} could you read email two with fresh eyes before it goes out?")], 0, 1),
            ("Retargeting ads for trial abandoners", "Two creatives, capped at a small daily budget.", 1, 1, "medium", "jordan", ("Paid",), [], 4, 6),
            ("Product Hunt launch plan", "Assets, hunter outreach, and a launch-day checklist.", 1, 1, "urgent", "maya", ("Social",),
             [("jordan", "Hunter confirmed for Tuesday.")], 1, 0),
            ("Referral program landing page", "Copy and layout for the invite-a-teammate page.", 0, 1, "medium", None, (), [], 2, None),
            ("Newsletter template refresh", "Match the new brand colors.", 3, 1, "low", "jordan", (), [], 2, None),
            ("A/B test the homepage hero", "Test two headlines against sign-up rate.", 2, 1, "medium", "admin", ("Paid",), [], 8, -1),
            ("Social calendar for next month", "Twelve posts across two channels.", 3, 1, "medium", "maya", ("Social",), [], 0, None),
            ("Conference booth design", "Banner, table cloth, and a demo loop on a laptop.", 1, 2, "high", "jordan", (),
             [("maya", "Printer needs files by the 12th.")], 5, 4),
            ("Webinar: running a flow-based standup", "Slides and a live board demo.", 2, 2, "medium", "admin", (), [], 2, 8),
            ("Meetup sponsorship shortlist", "Five local meetups worth sponsoring.", 0, 2, "low", None, (), [], 6, None),
            ("Swag order: stickers and notebooks", "Quote from two vendors.", 3, 2, "low", "maya", (), [], 1, None),
            ("Post-event follow-up emails", "Segmented by booth conversation.", 0, 2, "medium", None, (), [], 0, 9),
            ("Customer advisory call agenda", "Questions on onboarding friction.", 1, 2, "medium", "jordan", (), [], 11, -2),
            ("Recap blog post: the community meetup", "Photos, quotes, and slides.", 3, 2, "low", "maya", ("Blog", "Social"), [], 2, None),
        ],
        "card_fields": [
            ("Budget (USD)", "number", [], True, "Planned spend for this piece of work."),
            ("Channel", "dropdown", ["Blog", "Email", "Social", "Paid ads", "Event"], True, "Where this reaches people."),
        ],
        "card_field_values": {
            "Why Kanban beats sprints for support teams": {"Channel": "Blog", "Budget (USD)": "300"},
            "Release notes: what shipped this quarter": {"Channel": "Blog"},
            "Ten keyboard shortcuts every board power user knows": {"Channel": "Social", "Budget (USD)": "150"},
            "Case study: from spreadsheets to a shared board": {"Channel": "Blog", "Budget (USD)": "800"},
            "Getting started video script": {"Channel": "Social", "Budget (USD)": "2500"},
            "Spring launch email sequence": {"Channel": "Email", "Budget (USD)": "400"},
            "Retargeting ads for trial abandoners": {"Channel": "Paid ads", "Budget (USD)": "1200"},
            "Product Hunt launch plan": {"Channel": "Social", "Budget (USD)": "500"},
            "Referral program landing page": {"Channel": "Email"},
            "Newsletter template refresh": {"Channel": "Email", "Budget (USD)": "200"},
            "A/B test the homepage hero": {"Channel": "Paid ads", "Budget (USD)": "900"},
            "Social calendar for next month": {"Channel": "Social"},
            "Conference booth design": {"Channel": "Event", "Budget (USD)": "4500"},
            "Webinar: running a flow-based standup": {"Channel": "Event", "Budget (USD)": "350"},
            "Meetup sponsorship shortlist": {"Channel": "Event", "Budget (USD)": "3000"},
            "Swag order: stickers and notebooks": {"Channel": "Event", "Budget (USD)": "1800"},
            "Post-event follow-up emails": {"Channel": "Email"},
            "Recap blog post: the community meetup": {"Channel": "Blog"},
        },
        "swimlane_fields": [
            ("Funnel stage", "dropdown", ["Awareness", "Conversion", "Retention"], True, False, "Which part of the funnel this lane feeds."),
            ("Budget owner", "text", [], True, True, ""),
        ],
        "swimlane_field_values": {
            "Content": {"Funnel stage": "Awareness", "Budget owner": "M. Torres"},
            "Campaigns": {"Funnel stage": "Conversion", "Budget owner": "D. Admin"},
            "Events": {"Funnel stage": "Retention", "Budget owner": "J. Lee"},
        },
        "checklists": {
            "Why Kanban beats sprints for support teams": [
                ("Outline", True), ("Customer quotes approved", True),
                ("Cycle-time chart", False), ("SEO title and meta description", False),
            ],
            "Spring launch email sequence": [
                ("Email 1: announcement", True), ("Email 2: feature deep-dive", False),
                ("Email 3: last call", False), ("Test send to the seed list", False),
            ],
            "Product Hunt launch plan": [
                ("Gallery images", True), ("Maker comment drafted", True), ("Hunter confirmed", True),
                ("Launch-day schedule shared", False), ("Reply rota for comments", False),
            ],
            "Conference booth design": [
                ("Banner artwork", True), ("Table cloth proof", False),
                ("Demo loop video", False), ("Send files to the printer", False),
            ],
            "Webinar: running a flow-based standup": [
                ("Slides outline", True), ("Demo board prepared", True),
                ("Registration page live", False), ("Dry run with a colleague", False),
            ],
            "Social calendar for next month": [
                ("Draft twelve posts", True), ("Pick images", True), ("Schedule in the tool", True),
            ],
        },
        "relations": [
            ("Getting started video script", "blocks", "Product Hunt launch plan"),
            ("Retargeting ads for trial abandoners", "relates_to", "A/B test the homepage hero"),
            ("Conference booth design", "relates_to", "Post-event follow-up emails"),
            ("Meetup sponsorship shortlist", "relates_to", "Recap blog post: the community meetup"),
        ],
        "external_refs": {},
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
             [("jordan", "Great systems-design round. Recommend moving to the panel.")], 1, 2),
            ("Tomas R. - Backend Engineer", "Go and Python; wants to move to a smaller team.", 1, 0, "medium", "jordan", (), [], 5, 4),
            ("Aiko N. - Frontend Engineer", "React and accessibility specialist.", 3, 0, "high", "admin", ("Strong fit",),
             [("admin", "Offer approved. Sending Monday.")], 1, None),
            ("Marcus D. - Full-stack Engineer", "Bootcamp graduate with a strong portfolio.", 0, 0, "low", None, (), [], 10, None),
            ("Elena V. - Site Reliability Engineer", "Kubernetes and observability background.", 1, 0, "medium", "jordan", ("Needs follow-up",), [], 9, -2),
            ("Sam K. - Staff Engineer", "Referred by an advisor; wants a remote role.", 2, 0, "high", "admin", ("Referral",),
             [("admin", "@{visitor} you sat in on the architecture round — can you add your notes before the debrief?")], 0, 0),
            ("Noah B. - QA Engineer", "Test automation with Playwright.", 0, 0, "low", None, (), [], 2, 6),
            ("Chloe W. - Engineering Manager", "Managed a team of nine at a Series B.", 1, 0, "medium", "admin", (), [], 4, 3),
            ("Lucia F. - Product Designer", "Portfolio shows strong design-system work.", 2, 1, "high", "maya", ("Strong fit",),
             [("maya", "Whiteboard exercise on Thursday.")], 2, 0),
            ("Ben H. - Product Designer", "Agency background; light on B2B.", 1, 1, "medium", "maya", (), [], 6, 5),
            ("Rahul M. - UX Researcher", "Ran a diary study for a workflow tool.", 0, 1, "medium", None, ("Needs follow-up",), [], 12, -1),
            ("Ines G. - Brand Designer", "Freelance; available in six weeks.", 3, 1, "low", "maya", (), [], 2, None),
            ("Owen P. - Illustrator", "Would help with docs and marketing art.", 0, 1, "low", None, (), [], 1, None),
            ("Dana C. - Sales Lead", "Sold to mid-size ops teams for five years.", 2, 2, "high", "admin", ("Strong fit",), [], 8, -3),
            ("Kofi A. - Customer Success Manager", "Onboarding specialist.", 1, 2, "medium", "admin", ("Referral",),
             [("jordan", "References were glowing.")], 0, 1),
            ("Hannah L. - Content Marketer", "Ex-developer, writes well about tooling.", 3, 2, "medium", "maya", ("Strong fit",), [], 0, None),
            ("Victor Z. - Growth Marketer", "Paid and lifecycle experience.", 0, 2, "low", None, (), [], 5, None),
            ("Mei T. - Solutions Engineer", "Pre-sales for developer tools.", 1, 2, "medium", "admin", ("Needs follow-up",), [], 2, 7),
            ("Leo J. - Community Manager", "Runs a 5k-member developer forum.", 2, 2, "medium", "maya", (), [], 1, 9),
            ("Sofia Q. - Partnerships Manager", "Integrations background.", 0, 2, "low", None, (), [], 0, None),
        ],
        "card_fields": [
            ("Source", "dropdown", ["Referral", "Inbound", "Outbound", "Agency"], True, "How the candidate reached us."),
            ("Interview score", "number", [], True, "Average panel score out of 5."),
            ("Offer stage", "dropdown", ["Drafting", "Approved", "Sent", "Accepted"], False, "Where the offer stands."),
        ],
        "card_field_values": {
            "Priya S. - Senior Backend Engineer": {"Source": "Referral", "Interview score": "4.5"},
            "Tomas R. - Backend Engineer": {"Source": "Inbound"},
            "Aiko N. - Frontend Engineer": {"Source": "Inbound", "Interview score": "4.7", "Offer stage": "Approved"},
            "Marcus D. - Full-stack Engineer": {"Source": "Inbound"},
            "Elena V. - Site Reliability Engineer": {"Source": "Outbound"},
            "Sam K. - Staff Engineer": {"Source": "Referral", "Interview score": "4.0"},
            "Noah B. - QA Engineer": {"Source": "Agency"},
            "Chloe W. - Engineering Manager": {"Source": "Outbound"},
            "Lucia F. - Product Designer": {"Source": "Inbound", "Interview score": "4.2"},
            "Ben H. - Product Designer": {"Source": "Agency"},
            "Ines G. - Brand Designer": {"Source": "Outbound", "Interview score": "3.9", "Offer stage": "Sent"},
            "Dana C. - Sales Lead": {"Source": "Outbound", "Interview score": "4.4"},
            "Kofi A. - Customer Success Manager": {"Source": "Referral"},
            "Hannah L. - Content Marketer": {"Source": "Inbound", "Interview score": "4.6", "Offer stage": "Accepted"},
            "Mei T. - Solutions Engineer": {"Source": "Inbound"},
            "Leo J. - Community Manager": {"Source": "Referral", "Interview score": "3.8"},
        },
        "swimlane_fields": [
            ("Hiring manager", "text", [], True, False, "Who signs off on candidates in this lane."),
            ("Headcount", "dropdown", ["Approved", "Pending budget"], True, False, ""),
            ("Salary band", "text", [], True, True, "Visible to board admins only."),
        ],
        "swimlane_field_values": {
            "Engineering": {"Hiring manager": "Jordan Lee", "Headcount": "Approved", "Salary band": "L4-L6"},
            "Design": {"Hiring manager": "Maya Torres", "Headcount": "Approved", "Salary band": "L3-L5"},
            "Go-to-market": {"Hiring manager": "Demo Admin", "Headcount": "Pending budget", "Salary band": "L4-L5 plus commission"},
        },
        "checklists": {
            "Priya S. - Senior Backend Engineer": [
                ("Recruiter screen", True), ("Technical phone screen", True), ("Systems design", True),
                ("Team panel", False), ("Reference checks", False),
            ],
            "Sam K. - Staff Engineer": [
                ("Recruiter screen", True), ("Architecture deep-dive", True),
                ("Leadership interview", False), ("Debrief", False),
            ],
            "Lucia F. - Product Designer": [
                ("Portfolio review", True), ("Whiteboard exercise", False), ("Panel with PM and engineering", False),
            ],
            "Dana C. - Sales Lead": [
                ("Recruiter screen", True), ("Sales manager interview", True),
                ("Mock discovery call", False), ("Executive chat", False),
            ],
            "Elena V. - Site Reliability Engineer": [
                ("Schedule the screening call", False), ("Send the take-home exercise", False),
            ],
            "Aiko N. - Frontend Engineer": [
                ("Offer letter drafted", True), ("Compensation approved", True),
                ("Offer sent", False), ("Start date confirmed", False),
            ],
        },
        "relations": [
            ("Dana C. - Sales Lead", "blocks", "Mei T. - Solutions Engineer"),
            ("Lucia F. - Product Designer", "relates_to", "Ben H. - Product Designer"),
            ("Priya S. - Senior Backend Engineer", "relates_to", "Tomas R. - Backend Engineer"),
        ],
        "external_refs": {},
    },
]

#: The published visitor's seeded inbox (#1363). Deterministic, newest-first
#: ordering comes from timestamps the seeder derives from the board data, so a
#: notification always agrees with what the card itself shows:
#:   mentioned      actor = author of the card's comment containing "@{visitor}",
#:                  at that comment's time
#:   comment_added  actor = author of the card's most recent comment, at its time
#:   card_moved     actor = whoever made the card's last move, at that move's time
#:   assigned       actor = the key given below, at the card's last-move time
#:   stale/due_soon no actor (system alerts, as notify_stale_cards and
#:                  notify_due_soon create them), at today's midnight
#: The visitor can open these but cannot mark them read: the demo fence (#1179)
#: refuses notifications/mark-read, so the unread ones stay unread until the
#: next reset. Every row is seeded unread: the notification list endpoint and
#: the navbar inbox show unread notifications only, so a row seeded as read
#: would never be seen at all.
#:
#: (board_name, card_title, action_type, assigned_by_key)
VISITOR_NOTIFICATIONS = [
    ("Software Team", "Board-level search", "mentioned", None),
    ("Software Team", "Write the on-call runbook", "assigned", "maya"),
    ("Software Team", "Audit endpoints for IDOR", "card_moved", None),
    ("Software Team", "Investigate flaky concurrent-moves test", "stale", None),
    ("Software Team", "Add keyboard shortcut to create a card", "due_soon", None),
    ("Marketing Campaigns", "Spring launch email sequence", "mentioned", None),
    ("Marketing Campaigns", "Product Hunt launch plan", "due_soon", None),
    ("Marketing Campaigns", "Referral program landing page", "assigned", "admin"),
    ("Hiring Pipeline", "Sam K. - Staff Engineer", "mentioned", None),
    ("Hiring Pipeline", "Dana C. - Sales Lead", "stale", None),
    ("Hiring Pipeline", "Priya S. - Senior Backend Engineer", "card_moved", None),
    ("Hiring Pipeline", "Lucia F. - Product Designer", "comment_added", None),
]
