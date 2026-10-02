"""Static content for the hosted demo site boards (#1034, #1363, #1389, #1412).

Used only by ``seed_demo_data --demo-site``. Lives beside the command (the
leading underscore keeps Django from registering it as a command of its own)
so the ~100 hand-written cards do not bloat the generator module.

Seven boards, each a different workflow with a different swimlane entity
(#1389, #1412): Software Team (service area), Property Management (property),
Construction (project), Sales Territory (account), Sales Territory (Overlay)
(account — a second, richer account-coverage shape, deliberately overlapping
Sales Territory per #1412), Content Moderation (content queue) and Logistics
Exceptions (shipment). The point of the roster is that a visitor recognizes
one domain within a click and sees the swimlane as a real entity with its own
fields, not as a Trello-style grouping.

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
    card_fields          [(name, field_type, choices, show_on_card, help_text[, display])]
    card_field_values    {card_title: {field_name: value}}
    swimlane_fields      [(name, field_type, choices, show_on_row, is_admin_only, help_text[, display])]
    swimlane_field_values {lane_name: {field_name: value}}
    checklists           {card_title: [(text, is_checked), ...]}
    relations            [(from_title, "blocks" | "relates_to", to_title)]
    external_refs        {card_title: (provider, ref, url)}

``display`` is an optional dict of the #1391 display-only definition columns
(``number_prefix``, ``number_suffix``, ``number_decimals``, ``choice_colors``).
A field value is the string the API would store, except that a
``multi_select`` value may be written as a list and a ``date`` value as
``days_from_today(n)``; the seeder runs every value through the same
normalizer the API uses, so a value the API would refuse fails the seed.
"""


def days_from_today(days):
    """A date field value ``days`` after the day of the reset.

    Resolved at seed time, like ``due_offset_days``, so a date never drifts
    into the past between resets. A marker tuple rather than a computed date
    keeps this module free of clock reads.
    """
    return ("days_from_today", days)

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

#: Showcase boards earlier releases seeded and #1389 retired. ``--wipe``
#: deletes these too, so a database seeded before #1389 and reseeded without
#: ``--reset-database`` does not keep them around forever.
RETIRED_BOARD_NAMES = ("Marketing Campaigns", "Hiring Pipeline")

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
    # ── Swimlane-as-entity boards (#1389) ─────────────────────────────────────
    # Each board below makes the swimlane a real-world entity (a property, a
    # project, an account, a content queue, a shipment) with three pinned row
    # fields everyone can see, plus one admin-only row field so both
    # visibility modes stay on show. Every URL points at an example.com
    # subdomain (RFC 2606): the links are decorative, never an integration.
    {
        "name": "Property Management",
        "description": "Maintenance requests across a small rental portfolio. Which properties have unresolved work?",
        "columns": [
            ("Reported", "#6B7280", False),
            ("Scheduled", "#3B82F6", False),
            ("In Progress", "#F59E0B", False),
            ("Resolved", "#10B981", True),
        ],
        "swimlanes": [
            ("Maple Court Apartments", "#22C55E"),
            ("Harbor View Lofts", "#3B82F6"),
            ("Cedar Ridge Townhomes", "#F97316"),
        ],
        # Labels are board-wide, so they carry the small fixed set (issue
        # type); the unit is a card field instead, or a label per unit would
        # multiply by the number of properties.
        "labels": [
            ("Plumbing", "#3B82F6"), ("Electrical", "#F59E0B"), ("HVAC", "#14B8A6"),
            ("Pest", "#84CC16"), ("Appliance", "#8B5CF6"), ("Turnover", "#EC4899"),
        ],
        "cards": [
            ("Kitchen sink leaking under cabinet", "Resident reports a slow drip and a swollen cabinet floor.", 2, 0, "high", "maya", ("Plumbing",),
             [("jordan", "Plumber found a cracked P-trap; the replacement part arrives tomorrow.")], 1, 1),
            ("No heat in bedroom radiator", "Bedroom radiator stays cold; the rest of the unit is fine.", 1, 0, "urgent", "jordan", ("HVAC",),
             [("maya", "Resident has space heaters for now. @{visitor} can you confirm the HVAC tech's arrival window?")], 0, 0),
            ("Mice reported in basement storage", "Droppings found near the storage cages.", 0, 0, "medium", None, ("Pest",), [], 9, -3),
            ("Turnover: repaint and deep clean", "Move-out was last week; new lease starts on the first.", 2, 0, "medium", "maya", ("Turnover",), [], 5, 4),
            ("Replace hallway light fixtures", "Third-floor hallway fixtures flicker.", 3, 0, "low", "jordan", ("Electrical",), [], 1, None),
            ("Dishwasher not draining", "Standing water after every cycle.", 0, 1, "medium", None, ("Appliance", "Plumbing"), [], 2, 6),
            ("Tripping breaker in unit kitchen", "Kitchen circuit trips when the microwave and kettle run together.", 1, 1, "high", "admin", ("Electrical",),
             [("admin", "Electrician booked for Thursday morning.")], 4, 2),
            ("Rooftop condenser making grinding noise", "Noise started after the last cold snap.", 2, 1, "high", "jordan", ("HVAC",),
             [("jordan", "Fan bearing is going. Waiting on a quote for a replacement motor.")], 10, -2),
            ("Turnover: replace carpet with vinyl plank", "Carpet is past its useful life.", 1, 1, "medium", "maya", ("Turnover",), [], 0, 9),
            ("Refrigerator ice maker leaking", "Water pooling under the refrigerator.", 3, 1, "low", "admin", ("Appliance",), [], 2, None),
            ("Annual smoke detector battery sweep", "Every unit and common area, logged per unit.", 0, 1, "low", None, ("Electrical",), [], 1, 14),
            ("Water heater pilot keeps going out", "Second call this month for the same heater.", 2, 2, "urgent", "admin", ("Plumbing",),
             [("maya", "Ask the vendor about replacing the thermocouple instead of relighting again.")], 1, 0),
            ("Ants along the patio doors", "Trail of ants along the sliding door track.", 1, 2, "low", "maya", ("Pest",), [], 6, 3),
            ("Turnover: unit 11 make-ready", "Paint, clean, rekey, and photos for the listing.", 0, 2, "high", None, ("Turnover",), [], 8, -1),
            ("Garbage disposal jammed", "Resident reports a humming disposal that will not spin.", 3, 2, "low", "jordan", ("Appliance",), [], 0, None),
            ("Bathroom exhaust fan not working", "Fan is silent; mirror fogs for an hour after a shower.", 0, 2, "medium", None, ("Electrical",), [], 2, None),
        ],
        "card_fields": [
            ("Unit", "text", [], True, "Unit number or area at the property."),
            ("Vendor", "text", [], False, "Contractor booked for the work."),
            ("Cost estimate", "number", [], True, "Estimated cost of the repair.",
             {"number_prefix": "$", "number_decimals": 0}),
        ],
        "card_field_values": {
            "Kitchen sink leaking under cabinet": {"Unit": "4B", "Vendor": "Clearflow Plumbing", "Cost estimate": "240"},
            "No heat in bedroom radiator": {"Unit": "2A", "Vendor": "Summit Heating and Air", "Cost estimate": "380"},
            "Mice reported in basement storage": {"Unit": "Basement", "Cost estimate": "150"},
            "Turnover: repaint and deep clean": {"Unit": "1C", "Vendor": "Brightline Painting", "Cost estimate": "1850"},
            "Replace hallway light fixtures": {"Unit": "Common area", "Cost estimate": "320"},
            "Dishwasher not draining": {"Unit": "3D"},
            "Tripping breaker in unit kitchen": {"Unit": "3D", "Vendor": "Voltline Electric", "Cost estimate": "275"},
            "Rooftop condenser making grinding noise": {"Unit": "Roof", "Vendor": "Summit Heating and Air", "Cost estimate": "1200"},
            "Turnover: replace carpet with vinyl plank": {"Unit": "5A", "Vendor": "Floorcraft Interiors", "Cost estimate": "2600"},
            "Refrigerator ice maker leaking": {"Unit": "2C", "Cost estimate": "90"},
            "Annual smoke detector battery sweep": {"Unit": "All units"},
            "Water heater pilot keeps going out": {"Unit": "14", "Vendor": "Clearflow Plumbing", "Cost estimate": "410"},
            "Ants along the patio doors": {"Unit": "9", "Vendor": "Greenleaf Pest Control", "Cost estimate": "125"},
            "Turnover: unit 11 make-ready": {"Unit": "11", "Cost estimate": "1400"},
            "Garbage disposal jammed": {"Unit": "6"},
            "Bathroom exhaust fan not working": {"Unit": "12"},
        },
        "swimlane_fields": [
            ("Property manager", "text", [], True, False, "Who owns resident communication for this property."),
            ("Region", "dropdown", ["North", "Central", "South"], True, False, "",
             {"choice_colors": {"North": "blue", "Central": "violet", "South": "amber"}}),
            ("Unit count", "number", [], True, False, "Rentable units at this property.", {"number_decimals": 0}),
            ("Owner entity", "text", [], False, True, "Visible to board admins only."),
        ],
        "swimlane_field_values": {
            "Maple Court Apartments": {
                "Property manager": "Rosa Delgado", "Region": "North", "Unit count": "24",
                "Owner entity": "Maple Court Holdings LLC",
            },
            "Harbor View Lofts": {
                "Property manager": "Ethan Park", "Region": "Central", "Unit count": "48",
                "Owner entity": "Harbor View Partners LP",
            },
            "Cedar Ridge Townhomes": {
                "Property manager": "Nadia Okafor", "Region": "South", "Unit count": "16",
                "Owner entity": "Cedar Ridge Residential LLC",
            },
        },
        "checklists": {
            "Kitchen sink leaking under cabinet": [
                ("Photograph the damage", True), ("Replace the P-trap", False), ("Check the cabinet floor for mold", False),
            ],
            "No heat in bedroom radiator": [
                ("Drop off space heaters", True), ("Bleed the radiators", True),
                ("HVAC tech diagnosis", False), ("Follow-up call with the resident", False),
            ],
            "Turnover: repaint and deep clean": [
                ("Patch and paint walls", True), ("Deep clean kitchen and bath", False),
                ("Replace smoke detector batteries", False), ("Final walkthrough", False),
            ],
            "Turnover: replace carpet with vinyl plank": [
                ("Measure the unit", True), ("Order flooring", False), ("Schedule the install", False),
            ],
            "Rooftop condenser making grinding noise": [
                ("Vendor diagnosis", True), ("Quote approved", False), ("Replace the fan motor", False),
            ],
            "Replace hallway light fixtures": [
                ("Buy fixtures", True), ("Install", True), ("Test the emergency lighting", True),
            ],
        },
        "relations": [
            ("Tripping breaker in unit kitchen", "blocks", "Dishwasher not draining"),
            ("Mice reported in basement storage", "relates_to", "Ants along the patio doors"),
            ("Annual smoke detector battery sweep", "relates_to", "Replace hallway light fixtures"),
        ],
        "external_refs": {},
    },
    {
        "name": "Construction",
        "description": "Open issues across three active job sites. What is going to delay the project?",
        "columns": [
            ("Not Started", "#6B7280", False),
            ("Waiting", "#8B5CF6", False),
            ("In Progress", "#F59E0B", False),
            ("Complete", "#10B981", True),
        ],
        "swimlanes": [
            ("Riverside Library Renovation", "#3B82F6"),
            ("Oakmont Medical Office", "#22C55E"),
            ("Elm Street Mixed-Use", "#F97316"),
        ],
        "labels": [
            ("Permit", "#3B82F6"), ("Inspection", "#8B5CF6"), ("Change order", "#F59E0B"),
            ("Weather risk", "#14B8A6"), ("Safety", "#EF4444"),
        ],
        "cards": [
            ("Fire marshal final inspection", "Needed before the certificate of occupancy.", 1, 0, "urgent", "admin", ("Inspection",),
             [("admin", "The marshal's office has no slots until next month; we are on the cancellation list.")], 9, -2),
            ("Install reading room light fixtures", "Pendants arrived; lift is booked.", 2, 0, "medium", "jordan", (), [], 1, 4),
            ("Replace ceiling tiles after roof leak", "Stained tiles in the children's section.", 3, 0, "low", "maya", ("Change order",), [], 0, None),
            ("Elevator code compliance upgrade", "Controller swap plus a witnessed load test.", 1, 0, "high", "admin", ("Permit", "Inspection"),
             [("jordan", "The state inspector wants the updated load test report before scheduling.")], 2, 1),
            ("Paint and signage punch list", "Walkthrough items from the architect.", 0, 0, "low", None, (), [], 2, 12),
            ("Structural steel delivery delayed", "The mill pushed the ship date by a week.", 1, 1, "urgent", "jordan", ("Weather risk",),
             [("jordan", "Re-sequencing the crane schedule around the new delivery date.")], 4, 0),
            ("Framing inspection, level 2", "Book once the shear walls are nailed off.", 0, 1, "high", "admin", ("Inspection",), [], 1, 2),
            ("Change order: add exam room sink", "Owner request after the layout review.", 2, 1, "medium", "maya", ("Change order",),
             [("admin", "Owner signed the change order; the plumber is estimating the rough-in.")], 0, 6),
            ("Window submittal review", "Architect has not returned the storefront submittal.", 1, 1, "medium", None, (), [], 10, -4),
            ("Temporary power to level 3", "Panel and temporary lighting for the upper floor.", 3, 1, "low", "jordan", ("Safety",), [], 1, None),
            ("Rain plan for open roof deck", "Tarps and pumps on standby until the roof is dried in.", 2, 1, "high", "maya", ("Weather risk", "Safety"), [], 9, 1),
            ("Permit amendment for revised footings", "Footings were redesigned after the soils report.", 1, 2, "urgent", "admin", ("Permit",),
             [("maya", "The city wants stamped calculations for the revised footing. The engineer is on it.")], 8, -1),
            ("Soil compaction testing", "Testing lab on site for the building pad.", 2, 2, "high", "jordan", ("Inspection",), [], 1, 0),
            ("Dewatering pump rental", "Two pumps for the excavation.", 3, 2, "medium", "maya", (), [], 2, None),
            ("Utility locate before excavation", "Mark-out request for the north property line.", 0, 2, "high", None, ("Safety",), [], 0, 5),
            ("Concrete pour schedule", "Pour sequence for footings and stem walls.", 0, 2, "medium", "jordan", ("Weather risk",), [], 6, 9),
        ],
        "card_fields": [
            ("Subcontractor", "text", [], True, "Trade partner responsible for this work."),
            ("Permit #", "text", [], False, "Municipal permit or ticket number."),
            ("Permit portal", "url", [], True, "Link to the permit record (fictional)."),
        ],
        "card_field_values": {
            "Fire marshal final inspection": {
                "Subcontractor": "Ironclad Fire Protection", "Permit #": "BP-2026-04417",
                "Permit portal": "https://permits.example.com/records/BP-2026-04417",
            },
            "Install reading room light fixtures": {"Subcontractor": "Brightwire Electrical"},
            "Replace ceiling tiles after roof leak": {"Subcontractor": "Northside Interiors"},
            "Elevator code compliance upgrade": {
                "Subcontractor": "Vertex Elevator Co.", "Permit #": "EL-2026-0193",
                "Permit portal": "https://permits.example.com/records/EL-2026-0193",
            },
            "Paint and signage punch list": {"Subcontractor": "Northside Interiors"},
            "Structural steel delivery delayed": {"Subcontractor": "Keystone Steel Erectors"},
            "Framing inspection, level 2": {
                "Subcontractor": "Timberline Framing", "Permit #": "BP-2026-03881",
                "Permit portal": "https://permits.example.com/records/BP-2026-03881",
            },
            "Change order: add exam room sink": {"Subcontractor": "Clearwater Mechanical"},
            "Window submittal review": {"Subcontractor": "Glassline Storefronts"},
            "Rain plan for open roof deck": {"Subcontractor": "Summit Roofing"},
            "Permit amendment for revised footings": {
                "Permit #": "BP-2026-05102",
                "Permit portal": "https://permits.example.com/records/BP-2026-05102",
            },
            "Soil compaction testing": {"Subcontractor": "Groundwork Testing Labs"},
            "Utility locate before excavation": {"Subcontractor": "Groundwork Excavation", "Permit #": "UL-2026-7720"},
            "Concrete pour schedule": {"Subcontractor": "Bedrock Concrete"},
        },
        "swimlane_fields": [
            ("Project manager", "text", [], True, False, "Who runs the job site day to day."),
            ("Region", "dropdown", ["North", "Central", "South"], True, False, "",
             {"choice_colors": {"North": "blue", "Central": "violet", "South": "amber"}}),
            ("Phase", "dropdown", ["Preconstruction", "Foundation", "Framing", "MEP rough-in", "Finishes"], True, False,
             "Where the project is in the build.",
             {"choice_colors": {
                 "Preconstruction": "slate", "Foundation": "amber", "Framing": "blue",
                 "MEP rough-in": "violet", "Finishes": "green",
             }}),
            ("Owner's representative", "text", [], False, True, "Visible to board admins only."),
        ],
        "swimlane_field_values": {
            "Riverside Library Renovation": {
                "Project manager": "Grace Whitfield", "Region": "North", "Phase": "Finishes",
                "Owner's representative": "L. Moreno, county facilities",
            },
            "Oakmont Medical Office": {
                "Project manager": "Daniel Osei", "Region": "Central", "Phase": "Framing",
                "Owner's representative": "P. Sandoval, Oakmont Health Partners",
            },
            "Elm Street Mixed-Use": {
                "Project manager": "Hannah Kowalski", "Region": "South", "Phase": "Foundation",
                "Owner's representative": "R. Iverson, Elm Street Development",
            },
        },
        "checklists": {
            "Fire marshal final inspection": [
                ("Fire alarm acceptance test", True), ("Sprinkler certification uploaded", True),
                ("Exit signage verified", False), ("Marshal walkthrough", False),
            ],
            "Elevator code compliance upgrade": [
                ("Controller replaced", True), ("Load test", True),
                ("Report sent to the inspector", False), ("State inspection", False),
            ],
            "Structural steel delivery delayed": [
                ("Confirm the new ship date", True), ("Re-sequence the crane", False),
                ("Tell the owner about the schedule impact", False),
            ],
            "Change order: add exam room sink": [
                ("Owner signature", True), ("Plumbing estimate", False), ("Update the drawings", False),
            ],
            "Permit amendment for revised footings": [
                ("Stamped calculations from the engineer", False), ("Submit the amendment", False),
                ("Address plan review comments", False),
            ],
            "Temporary power to level 3": [
                ("Panel set", True), ("Inspection", True), ("Energized", True),
            ],
        },
        "relations": [
            ("Permit amendment for revised footings", "blocks", "Concrete pour schedule"),
            ("Soil compaction testing", "blocks", "Concrete pour schedule"),
            ("Structural steel delivery delayed", "blocks", "Framing inspection, level 2"),
            ("Rain plan for open roof deck", "relates_to", "Structural steel delivery delayed"),
        ],
        "external_refs": {},
    },
    {
        "name": "Sales Territory",
        "description": "Account work across one territory, one row per account. Which accounts are not getting attention?",
        "columns": [
            ("Up Next", "#6B7280", False),
            ("In Progress", "#3B82F6", False),
            ("Waiting on Customer", "#F59E0B", False),
            ("Done", "#10B981", True),
        ],
        "swimlanes": [
            ("Brightwater Health", "#14B8A6"),
            ("Kestrel Aerospace", "#6366F1"),
            ("Lumen Retail Group", "#EC4899"),
            ("Pinecrest Manufacturing", "#F97316"),
        ],
        "labels": [("New logo", "#22C55E"), ("Expansion", "#3B82F6"), ("Renewal", "#8B5CF6"), ("At risk", "#EF4444")],
        # Pinecrest is the deliberately neglected account: its row carries the
        # board's stale work, so the aging tint answers the board's question.
        "cards": [
            ("Radiology department pilot", "Pilot with the imaging team ahead of a wider rollout.", 1, 0, "high", "maya", ("New logo",),
             [("jordan", "Security questionnaire sent; 14 questions left on data residency.")], 1, 2),
            ("Pilot success criteria sign-off", "Agree on what a successful pilot looks like.", 2, 0, "medium", "jordan", (),
             [("maya", "Waiting on their clinical operations lead to sign off.")], 4, 3),
            ("Executive business review deck", "Outcomes from the first quarter, for their CIO.", 0, 0, "medium", None, (), [], 2, 8),
            ("Mutual close plan", "Shared timeline agreed with the champion.", 3, 0, "low", "maya", ("New logo",), [], 1, None),
            ("Engineering org expansion", "Three more engineering teams want in.", 1, 1, "urgent", "admin", ("Expansion",),
             [("admin", "Our champion is building the business case for the three new teams.")], 0, 0),
            ("Procurement redlines on the MSA", "Their legal team returned the master agreement.", 2, 1, "high", "admin", (),
             [("jordan", "Legal returned redlines on the liability clause."),
              ("maya", "Our counsel is reviewing; expect a turn by Friday.")], 2, 1),
            ("Technical deep-dive with the avionics team", "Architecture review with their platform leads.", 0, 1, "medium", "jordan", (), [], 1, 6),
            ("Kestrel onboarding kickoff", "Kickoff for the first expansion team.", 3, 1, "low", "jordan", ("Expansion",), [], 0, None),
            ("Renewal: store operations workspace", "Annual renewal for the store operations team.", 1, 2, "high", "maya", ("Renewal",), [], 5, 10),
            ("Usage review ahead of renewal", "Adoption by region, to frame the renewal conversation.", 0, 2, "medium", None, ("Renewal",), [], 2, 5),
            ("Reference call for a prospect", "Their operations director agreed to a reference call.", 3, 2, "low", "maya", (), [], 2, None),
            ("EMEA data processing addendum", "Their privacy office needs the addendum countersigned.", 2, 2, "high", "admin", (),
             [("admin", "Sent the addendum to their privacy office.")], 6, 1),
            ("Follow up after the plant tour", "Send notes and next steps from the site visit.", 0, 3, "high", None, ("At risk",), [], 12, -5),
            ("Proposal for the APAC plants", "Rollout proposal for four plants in the region.", 1, 3, "high", "jordan", ("Expansion", "At risk"),
             [("jordan", "Our champion went quiet after the plant tour.")], 9, -2),
            ("Quarterly check-in with the operations lead", "Standing check-in, missed last quarter.", 2, 3, "medium", None, ("At risk",), [], 8, None),
            ("Find a new champion at Pinecrest", "Our champion moved roles; map the new org.", 0, 3, "urgent", "maya", ("At risk",), [], 1, 1),
        ],
        "card_fields": [
            ("Deal value", "number", [], True, "Expected contract value of the opportunity.",
             {"number_prefix": "$", "number_decimals": 0}),
            ("CRM record", "url", [], True, "Link to the opportunity in the CRM (fictional)."),
            ("Stage", "dropdown", ["Discovery", "Evaluation", "Proposal", "Negotiation", "Closed won"], False,
             "Where the opportunity stands.",
             {"choice_colors": {
                 "Discovery": "slate", "Evaluation": "blue", "Proposal": "violet",
                 "Negotiation": "amber", "Closed won": "green",
             }}),
        ],
        "card_field_values": {
            "Radiology department pilot": {
                "Deal value": "84000", "CRM record": "https://crm.example.com/opportunities/OPP-1001", "Stage": "Evaluation",
            },
            "Pilot success criteria sign-off": {
                "CRM record": "https://crm.example.com/opportunities/OPP-1001", "Stage": "Evaluation",
            },
            "Mutual close plan": {"Deal value": "84000", "Stage": "Negotiation"},
            "Engineering org expansion": {
                "Deal value": "215000", "CRM record": "https://crm.example.com/opportunities/OPP-1002", "Stage": "Proposal",
            },
            "Procurement redlines on the MSA": {
                "Deal value": "215000", "CRM record": "https://crm.example.com/opportunities/OPP-1002", "Stage": "Negotiation",
            },
            "Kestrel onboarding kickoff": {
                "Deal value": "60000", "CRM record": "https://crm.example.com/opportunities/OPP-0987", "Stage": "Closed won",
            },
            "Renewal: store operations workspace": {
                "Deal value": "96000", "CRM record": "https://crm.example.com/opportunities/OPP-1003", "Stage": "Negotiation",
            },
            "Usage review ahead of renewal": {
                "CRM record": "https://crm.example.com/opportunities/OPP-1003", "Stage": "Discovery",
            },
            "EMEA data processing addendum": {
                "CRM record": "https://crm.example.com/opportunities/OPP-1003", "Stage": "Negotiation",
            },
            "Follow up after the plant tour": {"Stage": "Discovery"},
            "Proposal for the APAC plants": {
                "Deal value": "140000", "CRM record": "https://crm.example.com/opportunities/OPP-1004", "Stage": "Proposal",
            },
            "Find a new champion at Pinecrest": {"Stage": "Discovery"},
        },
        "swimlane_fields": [
            ("AE", "text", [], True, False, "Account executive who owns the relationship."),
            ("SA", "text", [], True, False, "Solutions architect on the account."),
            ("Region", "dropdown", ["AMER East", "AMER West", "EMEA", "APAC"], True, False, "",
             {"choice_colors": {"AMER East": "blue", "AMER West": "teal", "EMEA": "violet", "APAC": "amber"}}),
            ("Executive sponsor", "text", [], False, True, "Visible to board admins only."),
        ],
        # Fictional names, distinct per account.
        "swimlane_field_values": {
            "Brightwater Health": {
                "AE": "Olivia Grant", "SA": "Ravi Menon", "Region": "AMER East",
                "Executive sponsor": "K. Alvarez, CIO",
            },
            "Kestrel Aerospace": {
                "AE": "Tom Becker", "SA": "Leila Haddad", "Region": "AMER West",
                "Executive sponsor": "S. Novak, VP Engineering",
            },
            "Lumen Retail Group": {
                "AE": "Sophie Laurent", "SA": "Kenji Watanabe", "Region": "EMEA",
                "Executive sponsor": "M. Dubois, COO",
            },
            "Pinecrest Manufacturing": {
                "AE": "Daniel Cho", "SA": "Amara Nwosu", "Region": "APAC",
                "Executive sponsor": "J. Tan, Head of Operations",
            },
        },
        "checklists": {
            "Radiology department pilot": [
                ("Security questionnaire", True), ("Pilot environment ready", True),
                ("Success criteria agreed", False), ("Executive readout", False),
            ],
            "Engineering org expansion": [
                ("Business case draft", True), ("Champion review", False), ("Finance approval", False),
            ],
            "Procurement redlines on the MSA": [
                ("Redlines received", True), ("Counsel review", False), ("Final signature", False),
            ],
            "Renewal: store operations workspace": [
                ("Usage summary", True), ("Renewal paperwork sent", False), ("Signed order form", False),
            ],
            "Kestrel onboarding kickoff": [
                ("Kickoff call", True), ("Admin training", True), ("Success plan shared", True),
            ],
        },
        "relations": [
            ("Pilot success criteria sign-off", "blocks", "Radiology department pilot"),
            ("Procurement redlines on the MSA", "blocks", "Engineering org expansion"),
            ("Find a new champion at Pinecrest", "blocks", "Proposal for the APAC plants"),
            ("Usage review ahead of renewal", "relates_to", "Renewal: store operations workspace"),
        ],
        "external_refs": {},
    },
    # ── #1412: a second account-coverage board, deliberately overlapping ──────
    # Sales Territory above. Where Sales Territory shows the simplest coverage
    # shape (one AE, one SA), this board shows a layered enterprise overlay
    # model: a primary AE plus overlay specialists (OAE, OSA) on top, with an
    # admin-only Account Director, people shared across multiple accounts, and
    # one account left with a visible coverage gap.
    {
        "name": "Sales Territory (Overlay)",
        "description": "Account coverage under an enterprise overlay model — AE plus overlay AE/SA specialists. Which accounts have a coverage gap?",
        "columns": [
            ("Identify", "#6B7280", False),
            ("Discover", "#64748B", False),
            ("Qualify", "#3B82F6", False),
            ("Shape", "#F59E0B", False),
            ("Validate", "#8B5CF6", False),
            ("Commercial", "#EC4899", False),
            ("Commit", "#14B8A6", False),
            ("Won", "#10B981", True),
            ("Lost", "#EF4444", True),
        ],
        "swimlanes": [
            ("Meridian Financial Group", "#14B8A6"),
            ("Cascade Energy Partners", "#F97316"),
            ("Nimbus Cloud Systems", "#6366F1"),
            ("Solaris Biotech", "#22C55E"),
            ("Vantage Insurance Group", "#EC4899"),
            ("Ironwood Logistics", "#78716C"),
        ],
        "labels": [
            ("New Workload", "#3B82F6"), ("Expansion", "#22C55E"), ("Competitive Displacement", "#EF4444"),
            ("Cross-Sell", "#8B5CF6"), ("Strategic Initiative", "#F59E0B"), ("Renewal", "#14B8A6"),
        ],
        # Ironwood is the deliberately under-covered account (no OAE, and its
        # cards carry the board's stale/overdue work) — the same device as
        # Sales Territory's Pinecrest Manufacturing.
        "cards": [
            ("Core banking platform migration", "Modernizing the core ledger and payments engine ahead of a regulatory deadline.", 4, 0, "high", "maya", ("Strategic Initiative",),
             [("jordan", "OSA walked the architecture team through the integration plan; no open blockers on our side.")], 1, 3),
            ("Fraud detection module pilot", "Pilot scoring engine against a sample of flagged transactions.", 2, 0, "medium", "jordan", ("New Workload",),
             [("admin", "Risk team wants two more weeks of sample data before they'll sign off on the pilot.")], 4, 7),
            ("Mutual close plan sign-off", "Shared timeline with the CTO office ahead of signature.", 6, 0, "low", "maya", (), [], 1, None),
            ("Grid analytics expansion", "Expanding the analytics platform to two additional regional substations.", 3, 1, "high", "admin", ("Expansion",),
             [("admin", "OAE is coordinating the multi-region rollout plan with their infrastructure team.")], 0, 5),
            ("Field service mobile rollout", "Mobile app rollout for the field technician workforce.", 0, 1, "medium", None, ("New Workload",), [], 2, 0),
            ("Renewal: SCADA integration support", "Annual renewal for the SCADA integration support contract.", 7, 1, "low", "jordan", ("Renewal",), [], 0, None),
            ("Kubernetes cost optimization", "Rightsizing clusters after the Q3 usage review flagged overprovisioning.", 5, 2, "urgent", "admin", ("Cross-Sell",),
             [("admin", "Cost baseline is in; drafting the rightsizing recommendations with the OSA now.")], 5, 1),
            ("Multi-region DR architecture review", "Disaster recovery architecture review ahead of a board-level resilience audit.", 3, 2, "high", "jordan", ("Strategic Initiative",),
             [("jordan", "Our OSA is leading a technical workshop next week. @{visitor} want to sit in and see how we structure overlay technical reviews?")], 1, 10),
            ("Developer platform access expansion", "Expanding platform access to two engineering teams onboarding next quarter.", 1, 2, "low", None, ("Expansion",), [], 2, None),
            ("Lab data pipeline modernization", "Replacing a batch ETL pipeline with a streaming architecture for research data.", 4, 3, "high", "maya", ("Strategic Initiative",),
             [("maya", "Compliance flagged a data residency question; OSA is drafting the response.")], 2, 4),
            ("Compliance reporting add-on", "Add-on module for automated regulatory reporting.", 6, 3, "medium", "admin", ("Cross-Sell",), [], 6, None),
            ("Renewal: research workspace licenses", "Annual renewal for the research workspace licenses.", 7, 3, "low", "maya", ("Renewal",), [], 2, None),
            ("Claims automation proof of concept", "Proof of concept for automating first-notice-of-loss triage.", 2, 4, "medium", "jordan", ("New Workload",), [], 1, None),
            ("Underwriting workflow expansion", "Expanding automated underwriting to two additional policy lines.", 4, 4, "high", "admin", ("Expansion",),
             [("admin", "Underwriting leadership wants a reference call before expanding further.")], 9, -1),
            ("Fleet telematics expansion", "Extending telematics coverage to the refrigerated trailer fleet.", 0, 5, "medium", None, ("Expansion",), [], 10, -3),
            ("Warehouse automation competitive eval", "A competitor is proposing a rival automation platform for the new distribution center.", 3, 5, "urgent", "maya", ("Competitive Displacement",),
             [("maya", "No overlay AE assigned to help position against the competitor's pitch — flagging for coverage.")], 8, -2),
            ("Proposal for cross-dock pilot", "Pilot proposal for the new cross-dock facility opening next quarter.", 5, 5, "high", "jordan", ("Competitive Displacement",),
             [("jordan", "Still waiting on an OAE to be assigned here — the champion is asking what the overlay engagement costs and nobody is driving it.")], 1, 1),
            ("Grid edge sensor discovery", "Discovery calls with the field engineering group on edge sensor telemetry.", 1, 1, "medium", "jordan", ("New Workload",), [], 6, 12),
            ("Pharmacovigilance data lake", "Consolidating adverse-event data into a governed lake ahead of an inspection.", 4, 3, "high", "maya", ("Strategic Initiative",), [], 5, 6),
            ("Renewal: claims platform support", "Annual renewal for the claims platform support contract.", 7, 4, "low", "admin", ("Renewal",), [], 1, None),
            ("Edge analytics pilot", "Pilot lost to the incumbent vendor after the security review.",
             8, 2, "medium", "jordan", ("Competitive Displacement",),
             [("jordan", "Closed lost: the incumbent bundled analytics into their renewal at no extra cost.")], 2, None),
            ("Cold chain telematics", "Telematics for the cold chain fleet; lost to a regional reseller's bundled offer.",
             8, 5, "low", "maya", ("Competitive Displacement",),
             [("maya", "Closed lost to the reseller bundle. No overlay AE was engaged on this one.")], 1, None),
        ],
        "card_fields": [
            ("Deal value", "number", [], True, "Expected contract value of the opportunity.",
             {"number_prefix": "$", "number_decimals": 0}),
            ("Champion", "text", [], True, "Internal champion driving the opportunity."),
            ("Services", "text", [], False, "Services resource(s) engaged on this specific opportunity."),
        ],
        "card_field_values": {
            "Core banking platform migration": {"Deal value": "725000", "Champion": "CTO office sponsor", "Services": "Mike Brown"},
            "Fraud detection module pilot": {"Deal value": "180000", "Champion": "Head of Risk"},
            "Mutual close plan sign-off": {"Deal value": "725000", "Champion": "CTO office sponsor"},
            "Grid analytics expansion": {"Deal value": "410000", "Champion": "VP Grid Operations", "Services": "Jane Davis"},
            "Field service mobile rollout": {"Deal value": "150000"},
            "Renewal: SCADA integration support": {"Deal value": "95000", "Champion": "Plant operations lead"},
            "Kubernetes cost optimization": {"Deal value": "260000", "Champion": "VP Platform Engineering", "Services": "Mike Brown"},
            "Multi-region DR architecture review": {"Champion": "VP Platform Engineering"},
            "Developer platform access expansion": {"Deal value": "90000"},
            "Lab data pipeline modernization": {"Deal value": "540000", "Champion": "Head of Research IT", "Services": "Jane Davis"},
            "Compliance reporting add-on": {"Deal value": "120000"},
            "Renewal: research workspace licenses": {"Deal value": "75000", "Champion": "Head of Research IT"},
            "Claims automation proof of concept": {"Deal value": "95000"},
            "Underwriting workflow expansion": {"Deal value": "310000", "Champion": "VP Underwriting"},
            "Warehouse automation competitive eval": {"Deal value": "220000"},
            "Grid edge sensor discovery": {"Deal value": "130000"},
            "Pharmacovigilance data lake": {"Deal value": "385000", "Champion": "Head of Research IT"},
            "Renewal: claims platform support": {"Deal value": "85000"},
            "Edge analytics pilot": {"Deal value": "140000"},
            "Cold chain telematics": {"Deal value": "110000"},
            "Proposal for cross-dock pilot": {"Deal value": "175000"},
        },
        "swimlane_fields": [
            ("AD", "text", [], True, False, "Account director who owns the overall strategic relationship."),
            ("AE", "text", [], True, False, "Account executive who owns the commercial relationship."),
            ("SA", "text", [], True, False, "Solutions architect aligned to the account team; one SA covers two AEs."),
            ("OAE", "text", [], True, False, "Overlay account executive driving the overlay sales motion across accounts."),
            ("SVC", "text", [], True, False, "Services lead aligned to the account director, shared across that AD's accounts."),
            ("OSA", "text", [], True, False, "Overlay solutions architect providing technical coverage across accounts."),
            ("Executive sponsor", "text", [], False, True, "Visible to board admins only."),
        ],
        # Fictional names, reflecting a real reporting shape (#1412 fix):
        # each AD owns several AEs — never the reverse, so no AE name repeats
        # under two different ADs — and the overlay org is a separate set of
        # fixed OAE+OSA pods (an OAE always pairs with the same OSA) that cut
        # across AD/AE account lines, since overlay coverage doesn't follow
        # account-team boundaries. Ironwood's OAE is the one deliberate
        # coverage gap — an explicit "Unassigned" value rather than an
        # omitted key, so every lane still carries a value for every field
        # (see test_each_board_has_public_and_admin_only_swimlane_fields_on_every_lane);
        # its OSA (Lisa Wang) is covering solo, with no OAE pod partner, which
        # is itself part of the gap story.
        "swimlane_field_values": {
            "Meridian Financial Group": {"AD": "Diane Foster", "AE": "Sarah Chen", "OAE": "Bob Jones", "OSA": "Carlos Ruiz", "Executive sponsor": "R. Castillo, CFO", "SVC": "Mike Brown", "SA": "Wei Zhang"},
            "Cascade Energy Partners": {"AD": "Marcus Webb", "AE": "Tom Wilson", "OAE": "Bob Jones", "OSA": "Carlos Ruiz", "Executive sponsor": "L. Brandt, COO", "SVC": "Jane Davis", "SA": "Olivia Grant"},
            "Nimbus Cloud Systems": {"AD": "Marcus Webb", "AE": "James Brown", "OAE": "Elena Rossi", "OSA": "Priya Shah", "Executive sponsor": "A. Idowu, CTO", "SVC": "Jane Davis", "SA": "Olivia Grant"},
            "Solaris Biotech": {"AD": "Renee Okafor", "AE": "Grace Liu", "OAE": "Elena Rossi", "OSA": "Priya Shah", "Executive sponsor": "H. Lindqvist, Chief Scientific Officer", "SVC": "Nadia Haddad", "SA": "Ravi Menon"},
            "Vantage Insurance Group": {"AD": "Renee Okafor", "AE": "Derek Hall", "OAE": "Bob Jones", "OSA": "Carlos Ruiz", "Executive sponsor": "M. Delacroix, Chief Underwriting Officer", "SVC": "Nadia Haddad", "SA": "Ravi Menon"},
            "Ironwood Logistics": {"AD": "Diane Foster", "AE": "Amy Patel", "OAE": "Unassigned", "OSA": "Lisa Wang", "Executive sponsor": "T. Nakamura, VP Operations", "SVC": "Mike Brown", "SA": "Wei Zhang"},
        },
        "checklists": {
            "Core banking platform migration": [
                ("Discovery workshop completed", True), ("Security review scheduled", False), ("Reference architecture drafted", False),
            ],
            "Grid analytics expansion": [
                ("Data source inventory", True), ("Pilot environment provisioned", True), ("Success metrics agreed", False),
            ],
            "Kubernetes cost optimization": [
                ("Cost baseline captured", True), ("Rightsizing recommendations delivered", False),
            ],
            "Lab data pipeline modernization": [
                ("Data governance review", True), ("Pipeline architecture proposal", False), ("Sign-off from compliance", False),
            ],
            "Claims automation proof of concept": [
                ("POC scope agreed", True), ("Sample claims data received", False),
            ],
        },
        "relations": [
            ("Multi-region DR architecture review", "blocks", "Kubernetes cost optimization"),
            ("Fraud detection module pilot", "relates_to", "Core banking platform migration"),
            ("Compliance reporting add-on", "relates_to", "Lab data pipeline modernization"),
            ("Underwriting workflow expansion", "relates_to", "Claims automation proof of concept"),
        ],
        "external_refs": {},
    },
    {
        "name": "Content Moderation",
        "description": "User reports by content queue. What has waited longest for review?",
        "columns": [
            ("New Reports", "#6B7280", False),
            ("In Review", "#3B82F6", False),
            ("Escalated", "#EF4444", False),
            ("Actioned", "#10B981", True),
        ],
        "swimlanes": [("Comments", "#3B82F6"), ("Marketplace listings", "#22C55E"), ("Live streams", "#8B5CF6")],
        "labels": [("Appeal", "#8B5CF6"), ("Repeat account", "#F59E0B"), ("Legal hold", "#EF4444"), ("Coordinated", "#EC4899")],
        "cards": [
            ("Reply thread flooded with link spam", "Dozens of near-identical replies linking off-site.", 0, 0, "medium", None, ("Coordinated",), [], 9, -1),
            ("Harassment reports on a pinned comment", "Several reports against replies to a creator's pinned comment.", 1, 0, "high", "maya", (),
             [("maya", "Pattern matches last week's pile-on. @{visitor} can you check the card history and confirm when this was first reported?")], 1, 0),
            ("Impersonation of a support account", "Account copying the official support handle and avatar.", 2, 0, "urgent", "admin", ("Repeat account",),
             [("admin", "Escalated to the identity team; third report this month.")], 2, 1),
            ("Off-topic posts in a help thread", "Unrelated promotions in a help thread.", 3, 0, "low", "jordan", (), [], 1, None),
            ("Misleading health claim in a comment", "Comment presents an unproven remedy as a cure.", 0, 0, "medium", None, (), [], 5, 2),
            ("Counterfeit sneaker listings", "Same photos reused across listings from new accounts.", 1, 1, "high", "jordan", ("Repeat account",),
             [("jordan", "The seller relisted under a new handle; linking the accounts.")], 4, 1),
            ("Listing photo shows a weapon", "Reported listing in the collectibles category.", 2, 1, "urgent", "admin", ("Legal hold",), [], 8, -2),
            ("Too-good-to-be-true electronics deals", "Listings far below market value that ask buyers to pay off-platform.", 0, 1, "medium", None, ("Coordinated",), [], 2, 4),
            ("Appeal: removed vintage poster listing", "Seller says the artwork is historical, not graphic.", 1, 1, "low", "maya", ("Appeal",), [], 6, 5),
            ("Duplicate listings from one seller", "The same item listed eleven times.", 3, 1, "low", "jordan", (), [], 0, None),
            ("Seller using a brand's logo as avatar", "Avatar suggests an official store.", 0, 1, "medium", None, (), [], 1, 6),
            ("Stream showing a dangerous stunt", "Stream promoted a stunt that viewers could copy.", 2, 2, "urgent", "admin", ("Legal hold",),
             [("maya", "The stream has ended; the recording is preserved for review.")], 1, 0),
            ("Hateful messages in live chat", "Chat overlay repeated a slur during a stream.", 1, 2, "urgent", "jordan", (), [], 10, -3),
            ("Viewer-bot inflation on a channel", "Viewer count jumps with no chat activity.", 0, 2, "medium", None, ("Coordinated",), [], 0, 3),
            ("Appeal: stream ended for background music", "Streamer disputes the automated takedown.", 3, 2, "low", "maya", ("Appeal",), [], 2, None),
            ("Fake giveaway in a stream title", "Title promises a prize for following a link.", 1, 2, "high", "maya", (), [], 2, 2),
        ],
        "card_fields": [
            ("Report reason", "multi_select",
             ["Spam", "Harassment", "Hate speech", "Misinformation", "Impersonation", "Graphic content", "Scam"], True,
             "Every reason reporters selected.",
             {"choice_colors": {
                 "Spam": "slate", "Harassment": "red", "Hate speech": "red", "Misinformation": "amber",
                 "Impersonation": "violet", "Graphic content": "pink", "Scam": "teal",
             }}),
            ("Reporter count", "number", [], True, "Distinct accounts that reported this item.", {"number_decimals": 0}),
        ],
        "card_field_values": {
            "Reply thread flooded with link spam": {"Report reason": ["Spam", "Scam"], "Reporter count": "37"},
            "Harassment reports on a pinned comment": {"Report reason": ["Harassment"], "Reporter count": "12"},
            "Impersonation of a support account": {"Report reason": ["Impersonation", "Scam"], "Reporter count": "8"},
            "Off-topic posts in a help thread": {"Report reason": ["Spam"], "Reporter count": "3"},
            "Misleading health claim in a comment": {"Report reason": ["Misinformation"], "Reporter count": "6"},
            "Counterfeit sneaker listings": {"Report reason": ["Scam"], "Reporter count": "21"},
            "Listing photo shows a weapon": {"Report reason": ["Graphic content"], "Reporter count": "5"},
            "Too-good-to-be-true electronics deals": {"Report reason": ["Spam", "Scam"], "Reporter count": "14"},
            "Appeal: removed vintage poster listing": {"Report reason": ["Graphic content"], "Reporter count": "2"},
            "Duplicate listings from one seller": {"Report reason": ["Spam"], "Reporter count": "4"},
            "Seller using a brand's logo as avatar": {"Report reason": ["Impersonation"], "Reporter count": "3"},
            "Stream showing a dangerous stunt": {"Report reason": ["Graphic content"], "Reporter count": "46"},
            "Hateful messages in live chat": {"Report reason": ["Harassment", "Hate speech"], "Reporter count": "29"},
            "Viewer-bot inflation on a channel": {"Report reason": ["Spam"], "Reporter count": "9"},
            "Appeal: stream ended for background music": {"Reporter count": "1"},
            "Fake giveaway in a stream title": {"Report reason": ["Impersonation", "Scam"], "Reporter count": "18"},
        },
        "swimlane_fields": [
            ("Moderator lead", "text", [], True, False, "Who owns the queue this shift."),
            ("Region", "dropdown", ["Americas", "EMEA", "APAC"], True, False, "",
             {"choice_colors": {"Americas": "blue", "EMEA": "violet", "APAC": "amber"}}),
            ("Policy tier", "dropdown", ["Tier 1: safety", "Tier 2: integrity", "Tier 3: quality"], True, False,
             "How severe the policies enforced in this queue are.",
             {"choice_colors": {"Tier 1: safety": "red", "Tier 2: integrity": "amber", "Tier 3: quality": "blue"}}),
            ("Escalation contact", "text", [], False, True, "Visible to board admins only."),
        ],
        "swimlane_field_values": {
            "Comments": {
                "Moderator lead": "Bianca Ferreira", "Region": "Americas", "Policy tier": "Tier 3: quality",
                "Escalation contact": "Trust and safety on-call, rota A",
            },
            "Marketplace listings": {
                "Moderator lead": "Jonas Lindqvist", "Region": "EMEA", "Policy tier": "Tier 2: integrity",
                "Escalation contact": "Marketplace integrity on-call",
            },
            "Live streams": {
                "Moderator lead": "Mei Lin Zhou", "Region": "APAC", "Policy tier": "Tier 1: safety",
                "Escalation contact": "Trust and safety on-call, rota B",
            },
        },
        "checklists": {
            "Harassment reports on a pinned comment": [
                ("Review the reported replies", True), ("Check for coordinated accounts", False), ("Notify the creator", False),
            ],
            "Impersonation of a support account": [
                ("Verify the official account", True), ("Suspend the impersonator", False), ("Post a support notice", False),
            ],
            "Counterfeit sneaker listings": [
                ("Remove the active listings", True), ("Link related accounts", True), ("Notify the brand's rights contact", False),
            ],
            "Stream showing a dangerous stunt": [
                ("End the stream", True), ("Preserve the recording", True),
                ("Policy decision", False), ("Notify the streamer", False),
            ],
            "Duplicate listings from one seller": [
                ("Merge the duplicates", True), ("Warn the seller", True),
            ],
        },
        "relations": [
            ("Counterfeit sneaker listings", "blocks", "Too-good-to-be-true electronics deals"),
            ("Impersonation of a support account", "relates_to", "Seller using a brand's logo as avatar"),
            ("Hateful messages in live chat", "relates_to", "Harassment reports on a pinned comment"),
            ("Viewer-bot inflation on a channel", "relates_to", "Fake giveaway in a stream title"),
        ],
        "external_refs": {},
    },
    {
        "name": "Logistics Exceptions",
        "description": "Shipments that went off plan, one row per shipment. Which shipments need intervention?",
        "columns": [
            ("New Exception", "#6B7280", False),
            ("Investigating", "#3B82F6", False),
            ("Awaiting Carrier", "#F59E0B", False),
            ("Resolved", "#10B981", True),
        ],
        "swimlanes": [
            ("SHP-24817", "#3B82F6"),
            ("SHP-25102", "#22C55E"),
            ("SHP-25390", "#14B8A6"),
            ("SHP-25544", "#F97316"),
        ],
        "labels": [
            ("Expedite", "#EF4444"), ("Temperature-controlled", "#14B8A6"),
            ("Hazmat", "#F59E0B"), ("Claim filed", "#8B5CF6"),
        ],
        "cards": [
            ("Container held for customs inspection", "Selected for inspection at the port of entry.", 2, 0, "urgent", "admin", (),
             [("admin", "The broker resubmitted the commercial invoice; waiting on the customs release.")], 9, -2),
            ("Missing commercial invoice copy", "Customs needs a signed copy from the shipper.", 1, 0, "high", "maya", (), [], 1, 0),
            ("Vessel rolled to the next sailing", "Carrier rolled the container one week.", 3, 0, "medium", "jordan", (), [], 1, None),
            ("Notify the customer of the revised ETA", "Send the new arrival window and the reason.", 0, 0, "medium", None, ("Expedite",), [], 0, 1),
            ("Pallet damaged at cross-dock", "Forklift damage reported at the transfer point.", 1, 1, "high", "jordan", ("Claim filed",),
             [("jordan", "Photos uploaded to the carrier portal; the claim number is pending."),
              ("maya", "The customer asked for a replacement shipment instead of a credit.")], 2, 2),
            ("Missed pickup at the Dallas warehouse", "Driver did not arrive in the pickup window.", 2, 1, "medium", None, (), [], 5, 1),
            ("Replacement order for the damaged pallet", "Pick, pack and ship a replacement pallet.", 0, 1, "high", "maya", ("Expedite",), [], 1, 4),
            ("Carrier claim paperwork", "Bill of lading and inspection report attached.", 3, 1, "low", "jordan", ("Claim filed",), [], 2, None),
            ("Temperature excursion during transfer", "Logger shows readings above range during the hub transfer.", 1, 2, "urgent", "admin", ("Temperature-controlled",),
             [("admin", "The logger shows 40 minutes above 8 °C. The quality team is reviewing.")], 0, 0),
            ("Quality hold on received vials", "Receiving placed the delivered lot on hold.", 0, 2, "high", None, ("Temperature-controlled",), [], 4, 5),
            ("Dry ice replenishment at the transit hub", "Top up dry ice before the next leg.", 3, 2, "medium", "jordan", ("Temperature-controlled", "Hazmat"), [], 0, None),
            ("Flight offloaded for weight", "Freight bumped to the next departure.", 2, 2, "high", "maya", (), [], 1, 3),
            ("Wrong dock door on the delivery address", "Delivery went to the retail entrance, not receiving.", 1, 3, "medium", None, (), [], 8, -1),
            ("Consignee closed on arrival", "Store receiving was closed for inventory.", 2, 3, "medium", "jordan", (), [], 10, -3),
            ("Driver hours limit reached", "Driver hit the hours limit two stops short.", 0, 3, "low", None, (), [], 6, 2),
            ("Reschedule the delivery appointment", "Book a new appointment with store receiving.", 0, 3, "high", "maya", ("Expedite",), [], 2, 1),
        ],
        "card_fields": [
            ("Exception type", "dropdown",
             ["Delay", "Damage", "Customs hold", "Address issue", "Temperature excursion", "Missed pickup"], True,
             "What went off plan.",
             {"choice_colors": {
                 "Delay": "amber", "Damage": "red", "Customs hold": "violet", "Address issue": "blue",
                 "Temperature excursion": "teal", "Missed pickup": "slate",
             }}),
            ("ETA", "date", [], False, "Current estimated arrival."),
            ("Tracking link", "url", [], True, "Carrier tracking page (fictional)."),
        ],
        # ETAs are days from the day of the reset (see days_from_today), so
        # they never drift into the past between resets.
        "card_field_values": {
            "Container held for customs inspection": {
                "Exception type": "Customs hold", "ETA": days_from_today(6),
                "Tracking link": "https://tracking.example.com/shipments/SHP-24817",
            },
            "Missing commercial invoice copy": {"Exception type": "Customs hold"},
            "Vessel rolled to the next sailing": {
                "Exception type": "Delay", "ETA": days_from_today(6),
                "Tracking link": "https://tracking.example.com/shipments/SHP-24817",
            },
            "Notify the customer of the revised ETA": {"Exception type": "Delay", "ETA": days_from_today(6)},
            "Pallet damaged at cross-dock": {
                "Exception type": "Damage", "Tracking link": "https://tracking.example.com/shipments/SHP-25102",
            },
            "Missed pickup at the Dallas warehouse": {"Exception type": "Missed pickup", "ETA": days_from_today(3)},
            "Replacement order for the damaged pallet": {"Exception type": "Damage"},
            "Carrier claim paperwork": {"Exception type": "Damage"},
            "Temperature excursion during transfer": {
                "Exception type": "Temperature excursion", "ETA": days_from_today(2),
                "Tracking link": "https://tracking.example.com/shipments/SHP-25390",
            },
            "Quality hold on received vials": {"Exception type": "Temperature excursion"},
            "Dry ice replenishment at the transit hub": {"Exception type": "Delay"},
            "Flight offloaded for weight": {
                "Exception type": "Delay", "ETA": days_from_today(2),
                "Tracking link": "https://tracking.example.com/shipments/SHP-25390",
            },
            "Wrong dock door on the delivery address": {"Exception type": "Address issue", "ETA": days_from_today(1)},
            "Consignee closed on arrival": {
                "Exception type": "Address issue", "Tracking link": "https://tracking.example.com/shipments/SHP-25544",
            },
            "Driver hours limit reached": {"Exception type": "Delay", "ETA": days_from_today(1)},
            "Reschedule the delivery appointment": {"Exception type": "Address issue", "ETA": days_from_today(1)},
        },
        "swimlane_fields": [
            ("Carrier", "text", [], True, False, "Carrier currently holding the freight."),
            ("Lane", "text", [], True, False, "Origin to destination."),
            ("Customer", "text", [], True, False, "Who the shipment is for."),
            ("Customer contact", "text", [], False, True, "Visible to board admins only."),
        ],
        "swimlane_field_values": {
            "SHP-24817": {
                "Carrier": "Bluefin Ocean Lines", "Lane": "Rotterdam to Chicago", "Customer": "Harbor Goods Co.",
                "Customer contact": "ops@harborgoods.example.com",
            },
            "SHP-25102": {
                "Carrier": "Cedar Line Freight", "Lane": "Dallas to Denver", "Customer": "Alpine Outfitters",
                "Customer contact": "receiving@alpineoutfitters.example.com",
            },
            "SHP-25390": {
                "Carrier": "Skyward Air Cargo", "Lane": "Singapore to Los Angeles", "Customer": "Meridian Medical Supply",
                "Customer contact": "quality@meridianmedical.example.com",
            },
            "SHP-25544": {
                "Carrier": "Ridgeway Trucking", "Lane": "Atlanta to Charlotte", "Customer": "Fernway Grocers",
                "Customer contact": "dock@fernwaygrocers.example.com",
            },
        },
        "checklists": {
            "Container held for customs inspection": [
                ("Commercial invoice resubmitted", True), ("Broker confirms the filing", True),
                ("Customs release", False), ("Book drayage", False),
            ],
            "Pallet damaged at cross-dock": [
                ("Photos of the damage", True), ("Carrier claim opened", False), ("Customer notified", True),
            ],
            "Temperature excursion during transfer": [
                ("Download the logger data", True), ("Quality review", False), ("Customer disposition", False),
            ],
            "Reschedule the delivery appointment": [
                ("Call the consignee", True), ("Confirm the dock door", False),
            ],
            "Dry ice replenishment at the transit hub": [
                ("Hub confirms dry ice stock", True), ("Repack", True), ("Update the hazmat paperwork", True),
            ],
        },
        "relations": [
            ("Missing commercial invoice copy", "blocks", "Container held for customs inspection"),
            ("Pallet damaged at cross-dock", "relates_to", "Replacement order for the damaged pallet"),
            ("Temperature excursion during transfer", "relates_to", "Quality hold on received vials"),
            ("Wrong dock door on the delivery address", "relates_to", "Reschedule the delivery appointment"),
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
    ("Property Management", "No heat in bedroom radiator", "mentioned", None),
    ("Property Management", "Mice reported in basement storage", "stale", None),
    ("Construction", "Structural steel delivery delayed", "due_soon", None),
    ("Construction", "Change order: add exam room sink", "card_moved", None),
    ("Sales Territory", "Procurement redlines on the MSA", "comment_added", None),
    ("Sales Territory", "Renewal: store operations workspace", "assigned", "admin"),
    ("Sales Territory (Overlay)", "Proposal for cross-dock pilot", "comment_added", None),
    ("Sales Territory (Overlay)", "Warehouse automation competitive eval", "stale", None),
    ("Content Moderation", "Harassment reports on a pinned comment", "mentioned", None),
    ("Content Moderation", "Listing photo shows a weapon", "stale", None),
    ("Logistics Exceptions", "Temperature excursion during transfer", "due_soon", None),
    ("Logistics Exceptions", "Pallet damaged at cross-dock", "comment_added", None),
]
