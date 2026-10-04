"""
Sales Overlay sample board for generate_seed_data.py.

Loaded via importlib from generate_seed_data.py — do not run directly.

A fuller version of the hosted demo's "Sales Territory (Overlay)" board
(``management/commands/_demo_site_data.py``, #1412): one row per account
under an enterprise overlay coverage model. Every account has a primary
account team (AD, AE, SA, services lead) and, on top of it, an overlay pod
(overlay AE + overlay SA) that brings specialist products into the deal.

Where the demo board has six accounts and 22 cards, this one has ten
accounts and every 1.2 board feature in use: every custom field type on
cards, fifteen swimlane fields (the per-board maximum, eight of them
pinned to the row header, one admin-only), WIP and weight limits (Commercial
deliberately one card over, as on every sample), CRM links, archived wins and a full audit trail on every card.

The org shape is deliberate and mirrors the demo's (#1412 fix): each AD owns
several AEs and no AE sits under two ADs; an SA covers two or three AEs;
overlay pods are fixed OAE+OSA pairs that cut across AD lines. Two accounts
carry the coverage story the board exists to answer — Bluefin Insurance has
an overlay SA working without an overlay AE (Partial), and Keystone
Logistics has no overlay pod at all (Gap); their cards hold the board's
stale and at-risk work.

All names, companies and links are fictional.
"""

from datetime import datetime, timedelta, timezone

ANCHOR = datetime(2026, 3, 15, 12, 0, 0, tzinfo=timezone.utc)


def _date(days_from_anchor):
    return (ANCHOR + timedelta(days=days_from_anchor)).strftime("%Y-%m-%d")


COLUMNS = [
    {"name": "Identify",   "position": 0, "color": "#6B7280", "wip_limit": None, "weight_limit": None, "allow_card_creation": True},
    {"name": "Discover",   "position": 1, "color": "#64748B", "wip_limit": None, "weight_limit": None, "allow_card_creation": False},
    {"name": "Qualify",    "position": 2, "color": "#3B82F6", "wip_limit": None, "weight_limit": None, "allow_card_creation": False},
    {"name": "Shape",      "position": 3, "color": "#F59E0B", "wip_limit": None, "weight_limit": None, "allow_card_creation": False},
    {"name": "Validate",   "position": 4, "color": "#8B5CF6", "wip_limit": 8,    "weight_limit": None, "allow_card_creation": False},
    {"name": "Commercial", "position": 5, "color": "#EC4899", "wip_limit": 3,    "weight_limit": 40,   "allow_card_creation": False},
    {"name": "Commit",     "position": 6, "color": "#14B8A6", "wip_limit": None, "weight_limit": None, "allow_card_creation": False},
    {"name": "Won",        "position": 7, "color": "#10B981", "wip_limit": None, "weight_limit": None, "allow_card_creation": False, "is_done": True},
    {"name": "Lost",       "position": 8, "color": "#EF4444", "wip_limit": None, "weight_limit": None, "allow_card_creation": False, "is_done": True},
]

# (name, color, contact_email, notes, row field values)
_ACCOUNTS = [
    ("Harborview Bank", "#14B8A6", "harborview-team@example.com",
     "Tier-one retail bank. Core modernization program funded through 2027.",
     {"AD": "Laura Bennett", "AE": "Ethan Ross", "SA": "Julia Park", "OAE": "Rachel Kim", "OSA": "Diego Alvarez",
      "SVC": "Sam Ortega", "Region": "AMER East", "Coverage": "Full", "Segment": "Financial services",
      "Install base ARR": "1850000", "Renewal date": _date(118),
      "Overlay products owned": '["Data Platform","Security"]', "Strategic account": "true",
      "Executive sponsor": "R. Castellanos, CIO"}),
    ("Granite Peak Energy", "#F97316", "granitepeak-team@example.com",
     "Regional utility. Grid modernization grant drives this year's spend.",
     {"AD": "Laura Bennett", "AE": "Ethan Ross", "SA": "Julia Park", "OAE": "Nathan Cole", "OSA": "Aisha Bello",
      "SVC": "Sam Ortega", "Region": "AMER East", "Coverage": "Full", "Segment": "Energy and utilities",
      "Install base ARR": "920000", "Renewal date": _date(64),
      "Overlay products owned": '["Observability"]', "Strategic account": "false",
      "Executive sponsor": "P. Lindgren, COO"}),
    ("Copperline Telecom", "#6366F1", "copperline-team@example.com",
     "Fiber and wireless carrier. Consolidating three network operations centers.",
     {"AD": "Laura Bennett", "AE": "Monica Reyes", "SA": "Julia Park", "OAE": "Rachel Kim", "OSA": "Diego Alvarez",
      "SVC": "Sam Ortega", "Region": "AMER East", "Coverage": "Full", "Segment": "Telecommunications",
      "Install base ARR": "1340000", "Renewal date": _date(201),
      "Overlay products owned": '["Observability","Integration"]', "Strategic account": "true",
      "Executive sponsor": "D. Mwangi, CTO"}),
    ("Orion State Transit Authority", "#0EA5E9", "orion-transit-team@example.com",
     "Public transit agency. Purchases run through a state cooperative contract.",
     {"AD": "Laura Bennett", "AE": "Monica Reyes", "SA": "Julia Park", "OAE": "Grace Okafor", "OSA": "Henrik Larsen",
      "SVC": "Sam Ortega", "Region": "AMER East", "Coverage": "Full", "Segment": "Public sector",
      "Install base ARR": "410000", "Renewal date": _date(35),
      "Overlay products owned": "", "Strategic account": "false",
      "Executive sponsor": "A. Brennan, Chief Digital Officer"}),
    ("Evergreen Health System", "#22C55E", "evergreen-team@example.com",
     "Twelve-hospital system. Clinical data teams are the main buyers.",
     {"AD": "Victor Shah", "AE": "Liam Foster", "SA": "Kenji Mori", "OAE": "Grace Okafor", "OSA": "Henrik Larsen",
      "SVC": "Dana Whitfield", "Region": "AMER West", "Coverage": "Full", "Segment": "Healthcare",
      "Install base ARR": "1120000", "Renewal date": _date(150),
      "Overlay products owned": '["Data Platform","AI Services"]', "Strategic account": "true",
      "Executive sponsor": "S. Whitaker, Chief Medical Information Officer"}),
    ("Altair Semiconductor", "#A855F7", "altair-team@example.com",
     "Fab and design house. Engineering-led buying; procurement is strict on security.",
     {"AD": "Victor Shah", "AE": "Liam Foster", "SA": "Kenji Mori", "OAE": "Nathan Cole", "OSA": "Aisha Bello",
      "SVC": "Dana Whitfield", "Region": "AMER West", "Coverage": "Full", "Segment": "Manufacturing",
      "Install base ARR": "760000", "Renewal date": _date(88),
      "Overlay products owned": '["Security"]', "Strategic account": "false",
      "Executive sponsor": "Y. Tanaka, VP Engineering"}),
    ("Bluefin Insurance", "#EC4899", "bluefin-team@example.com",
     "Property and casualty carrier. Overlay SA is covering without an overlay AE.",
     {"AD": "Victor Shah", "AE": "Hannah Wright", "SA": "Kenji Mori", "OAE": "Unassigned", "OSA": "Aisha Bello",
      "SVC": "Dana Whitfield", "Region": "AMER West", "Coverage": "Partial", "Segment": "Insurance",
      "Install base ARR": "690000", "Renewal date": _date(27),
      "Overlay products owned": '["AI Services"]', "Strategic account": "false",
      "Executive sponsor": "M. Okonkwo, Chief Underwriting Officer"}),
    ("Halcyon Pharma", "#84CC16", "halcyon-team@example.com",
     "Mid-size pharma. Inspection readiness is the board-level priority this year.",
     {"AD": "Mira Chen", "AE": "Oliver Grant", "SA": "Sofia Lind", "OAE": "Grace Okafor", "OSA": "Henrik Larsen",
      "SVC": "Ines Moreau", "Region": "EMEA", "Coverage": "Full", "Segment": "Life sciences",
      "Install base ARR": "1480000", "Renewal date": _date(176),
      "Overlay products owned": '["Data Platform","Security","AI Services"]', "Strategic account": "true",
      "Executive sponsor": "H. Lindqvist, Chief Scientific Officer"}),
    ("Keystone Logistics", "#78716C", "keystone-team@example.com",
     "Freight and warehousing. No overlay pod assigned since the last reorg.",
     {"AD": "Mira Chen", "AE": "Oliver Grant", "SA": "Sofia Lind", "OAE": "Unassigned", "OSA": "Unassigned",
      "SVC": "Ines Moreau", "Region": "EMEA", "Coverage": "Gap", "Segment": "Transportation",
      "Install base ARR": "530000", "Renewal date": _date(19),
      "Overlay products owned": "", "Strategic account": "false",
      "Executive sponsor": "T. Nakamura, VP Operations"}),
    ("Summit Retail Holdings", "#F43F5E", "summit-team@example.com",
     "Grocery and home-goods banners across five countries.",
     {"AD": "Mira Chen", "AE": "Chloe Dubois", "SA": "Sofia Lind", "OAE": "Rachel Kim", "OSA": "Diego Alvarez",
      "SVC": "Ines Moreau", "Region": "EMEA", "Coverage": "Full", "Segment": "Retail",
      "Install base ARR": "980000", "Renewal date": _date(240),
      "Overlay products owned": '["Integration"]', "Strategic account": "false",
      "Executive sponsor": "C. Moreau, Chief Operating Officer"}),
]

SWIMLANES = [
    {"name": name, "position": i, "color": color, "contact_email": email, "notes": notes,
     "custom_field_values": values}
    for i, (name, color, email, notes, values) in enumerate(_ACCOUNTS)
]
_COVERAGE = {name: values["Coverage"] for name, _, _, _, values in _ACCOUNTS}

LABELS = [
    {"name": "New Workload", "color": "#3B82F6"},
    {"name": "Expansion", "color": "#22C55E"},
    {"name": "Competitive Displacement", "color": "#EF4444"},
    {"name": "Cross-Sell", "color": "#8B5CF6"},
    {"name": "Strategic Initiative", "color": "#F59E0B"},
    {"name": "Renewal", "color": "#14B8A6"},
    {"name": "Coverage Gap", "color": "#DC2626"},
    {"name": "Exec Escalation", "color": "#F97316"},
]

_PRODUCTS = ["Data Platform", "Security", "AI Services", "Observability", "Integration"]
_COMPETITORS = ["Incumbent", "Hyperscaler native", "Regional reseller", "Build in-house", "None identified"]

# Card tuple:
#   (title, description, column, lane, priority, assignee, labels, due_offset,
#    weight, deal_value, overlay_products, champion, competitor, next_step,
#    checklist, comments)
# checklist entries starting with "+" are checked; comments are (author, body).
_CARDS = [
    # ── Harborview Bank (Full coverage) ─────────────────────────────────────
    ("Core ledger modernization", "Replace the batch ledger with an event-driven core ahead of the 2027 regulatory deadline.",
     "Validate", "Harborview Bank", "high", "demo1", ["Strategic Initiative"], 21, 8,
     "1250000", ["Data Platform", "Integration"], "Deputy CIO", "Incumbent", "Architecture sign-off with the platform board",
     ["+Discovery workshop", "+Reference architecture drafted", "Security review", "Executive readout"],
     [("demo2", "OSA walked their architects through the event-streaming design; no blockers on our side."),
      ("demo1", "Deputy CIO wants a reference call with another tier-one bank before the board meeting.")]),
    ("Real-time fraud scoring pilot", "Score card transactions inline against the new model; pilot on one product line.",
     "Shape", "Harborview Bank", "high", "demo3", ["New Workload", "Cross-Sell"], 30, 5,
     "380000", ["AI Services"], "Head of Fraud Analytics", "Build in-house", "Agree pilot success metrics",
     ["+Pilot scope agreed", "Sample data received", "Success metrics signed"],
     [("demo3", "Their data science team built a prototype in-house; overlay AE is positioning time-to-value.")]),
    ("Security analytics add-on", "Extend the security product to the bank's SOC.", "Commit", "Harborview Bank", "medium", "demo1",
     ["Cross-Sell"], 6, 3, "210000", ["Security"], "CISO", "Hyperscaler native", "Order form to procurement",
     ["+Technical win", "+Pricing approved", "Order form signed"], [("demo4", "Procurement has the order form; signature expected this week.")]),
    ("Branch analytics renewal", "Annual renewal of the branch analytics workspace.", "Won", "Harborview Bank", "low", "demo5",
     ["Renewal"], None, 2, "240000", ["Data Platform"], "VP Retail Banking", "None identified", "",
     ["+Usage review", "+Renewal paperwork", "+Signed"], [("demo5", "Signed at flat price with a two-year term.")]),
    ("Open banking API gateway", "Partner-facing API layer for the open banking mandate.", "Discover", "Harborview Bank", "medium", "demo2",
     ["New Workload"], 45, 3, "160000", ["Integration"], "", "Regional reseller", "Map the partner onboarding flow",
     [], [("demo2", "Early days. Their API team is still writing requirements.")]),

    # ── Granite Peak Energy (Full) ──────────────────────────────────────────
    ("Grid telemetry observability", "Unified monitoring for substation telemetry across two regions.", "Commercial", "Granite Peak Energy", "high", "demo4",
     ["Expansion"], 12, 6, "540000", ["Observability"], "VP Grid Operations", "Incumbent", "Redlines back from legal",
     ["+Technical win", "+Business case", "Legal review", "Final pricing"],
     [("demo4", "Overlay AE is coordinating the multi-region pricing with their infrastructure team."),
      ("demo1", "Legal returned redlines on data residency; counsel is turning them now.")]),
    ("Outage prediction model", "Forecast feeder outages from weather and load data.", "Qualify", "Granite Peak Energy", "medium", "demo2",
     ["New Workload", "Cross-Sell"], 40, 5, "290000", ["AI Services", "Data Platform"], "Director of Reliability", "Build in-house", "Data access request",
     ["Data inventory", "Pilot feeder selected"], []),
    ("Field crew mobile integration", "Push work orders from the asset system to crew tablets.", "Identify", "Granite Peak Energy", "low", None,
     ["New Workload"], None, 2, "90000", ["Integration"], "", "None identified", "Find a sponsor in field operations", [], []),
    ("SCADA support renewal", "Annual renewal for SCADA integration support.", "Won", "Granite Peak Energy", "low", "demo5",
     ["Renewal"], None, 1, "95000", [], "Plant operations lead", "None identified", "", [], []),
    ("Grant-funded data lake", "Data lake funded by the grid modernization grant.", "Lost", "Granite Peak Energy", "medium", "demo4",
     ["Strategic Initiative"], None, 5, "420000", ["Data Platform"], "VP Grid Operations", "Hyperscaler native", "",
     [], [("demo4", "Closed lost: the grant terms required their hyperscaler's native service.")]),

    # ── Copperline Telecom (Full) ───────────────────────────────────────────
    ("NOC consolidation observability", "Collapse three NOC toolchains into one observability platform.", "Validate", "Copperline Telecom", "urgent", "demo3",
     ["Strategic Initiative", "Competitive Displacement"], 9, 8, "960000", ["Observability", "Integration"], "SVP Network Operations", "Incumbent", "Proof of value readout",
     ["+Proof of value plan", "+Data sources connected", "Readout to SVP", "Commercial proposal"],
     [("demo3", "Proof of value is live on two of three NOCs. The third is blocked on a firewall change."),
      ("demo2", "Escalated the firewall change through their CTO's office."),
      ("demo3", "Firewall change landed; all three NOCs reporting.")]),
    ("5G core security assessment", "Security assessment of the new 5G core.", "Shape", "Copperline Telecom", "high", "demo1",
     ["Cross-Sell"], 25, 4, "310000", ["Security"], "CISO", "Regional reseller", "Scope workshop",
     ["Threat model template shared", "Scope workshop"], []),
    ("Billing integration refresh", "Replace point-to-point billing integrations.", "Commit", "Copperline Telecom", "medium", "demo5",
     ["Expansion"], 4, 3, "180000", ["Integration"], "Director of IT", "None identified", "Signature",
     ["+Technical win", "+Pricing", "Signature"], []),
    ("Network analytics renewal", "Renewal of the network analytics subscription.", "Won", "Copperline Telecom", "low", "demo2",
     ["Renewal"], None, 2, "260000", ["Observability"], "Director of IT", "None identified", "", [], []),
    ("Customer churn model", "Predict subscriber churn from usage and support data.", "Discover", "Copperline Telecom", "medium", "demo4",
     ["New Workload"], 50, 3, "150000", ["AI Services"], "", "Hyperscaler native", "Intro call with the marketing analytics team", [], []),

    # ── Orion State Transit Authority (Full) ────────────────────────────────
    ("Fare system data platform", "Consolidate fare, ridership and GTFS feeds.", "Qualify", "Orion State Transit Authority", "medium", "demo1",
     ["New Workload"], 35, 5, "340000", ["Data Platform"], "Chief Digital Officer", "Regional reseller", "Confirm cooperative contract vehicle",
     ["+Cooperative contract identified", "Budget confirmed"], [("demo1", "Purchase runs through the state cooperative; overlay AE is checking our listing.")]),
    ("Rider app incident monitoring", "Monitoring for the rider app after last winter's outage.", "Shape", "Orion State Transit Authority", "high", "demo3",
     ["Cross-Sell"], 18, 3, "120000", ["Observability"], "IT Operations Manager", "Incumbent", "Draft solution outline",
     [], []),
    ("Board presentation on modernization", "Present the modernization roadmap at the authority's public board meeting.", "Identify", "Orion State Transit Authority", "medium", "demo2",
     ["Strategic Initiative", "Exec Escalation"], 28, 2, "", [], "Chief Digital Officer", "None identified", "Prepare the deck",
     ["Draft deck", "Legal review of public materials"], []),
    ("Accessibility compliance integration", "Connect paratransit scheduling to the main dispatch system.", "Won", "Orion State Transit Authority", "low", "demo5",
     ["Expansion"], None, 2, "85000", ["Integration"], "Paratransit director", "None identified", "", [], []),

    # ── Evergreen Health System (Full) ──────────────────────────────────────
    ("Clinical data platform expansion", "Bring four more hospitals onto the clinical data platform.", "Commercial", "Evergreen Health System", "high", "demo2",
     ["Expansion"], 10, 7, "780000", ["Data Platform"], "CMIO", "Incumbent", "Final pricing with procurement",
     ["+Business case", "+Clinical sign-off", "Procurement review", "Signature"],
     [("demo2", "Procurement asked for a three-year ramp. Deal desk approved the structure."),
      ("demo4", "Services scoping done; Dana has the plan.")]),
    ("Sepsis early-warning model", "Deploy a sepsis risk model across ICUs.", "Validate", "Evergreen Health System", "urgent", "demo4",
     ["New Workload", "Strategic Initiative"], 14, 6, "460000", ["AI Services"], "Director of Critical Care", "Build in-house", "Clinical validation results",
     ["+IRB approval", "Retrospective validation", "Clinician review"],
     [("demo4", "Retrospective validation shows strong recall; clinicians want more on false positives.")]),
    ("HIPAA security review", "Third-party security review ahead of expansion.", "Commit", "Evergreen Health System", "medium", "demo1",
     ["Cross-Sell"], 3, 2, "95000", ["Security"], "CISO", "None identified", "Countersign",
     ["+Questionnaire", "+Pen test summary", "Countersign"], []),
    ("Imaging archive integration", "Connect the imaging archive to the data platform.", "Discover", "Evergreen Health System", "low", None,
     ["New Workload"], 60, 2, "110000", ["Integration"], "", "Regional reseller", "Find an imaging sponsor", [], []),
    ("Population health dashboards", "Dashboards for the population health team.", "Won", "Evergreen Health System", "medium", "demo3",
     ["Expansion"], None, 3, "175000", ["Data Platform"], "VP Population Health", "None identified", "", [], []),

    # ── Altair Semiconductor (Full) ─────────────────────────────────────────
    ("Fab yield analytics", "Correlate tool telemetry with yield across two fabs.", "Shape", "Altair Semiconductor", "high", "demo3",
     ["New Workload"], 22, 6, "520000", ["Data Platform", "AI Services"], "VP Engineering", "Build in-house", "Architecture workshop",
     ["+Data source inventory", "Workshop", "Pilot plan"],
     [("demo3", "OSA is running the architecture workshop next Tuesday.")]),
    ("Supply chain security assessment", "Assess software supply chain controls for export compliance.", "Validate", "Altair Semiconductor", "high", "demo1",
     ["Cross-Sell"], 16, 4, "230000", ["Security"], "Director of Security", "Hyperscaler native", "Security questionnaire",
     ["+Scope agreed", "Questionnaire", "Findings readout"], []),
    ("Design tool observability", "Monitor EDA license servers and compute farms.", "Qualify", "Altair Semiconductor", "medium", "demo5",
     ["Expansion"], 38, 3, "140000", ["Observability"], "EDA platform lead", "Incumbent", "Confirm budget owner", [], []),
    ("Edge analytics pilot", "Pilot lost to the incumbent after the security review.", "Lost", "Altair Semiconductor", "medium", "demo1",
     ["Competitive Displacement"], None, 3, "140000", ["AI Services"], "", "Incumbent", "",
     [], [("demo1", "Closed lost: the incumbent bundled analytics into their renewal at no extra cost.")]),

    # ── Bluefin Insurance (Partial: OSA without an OAE) ─────────────────────
    ("Claims automation proof of concept", "Automate first-notice-of-loss triage.", "Validate", "Bluefin Insurance", "high", "demo4",
     ["New Workload", "Coverage Gap"], -4, 5, "310000", ["AI Services"], "VP Claims", "Hyperscaler native", "POC readout (overdue)",
     ["+POC scope", "Sample claims data", "Readout"],
     [("demo4", "OSA is carrying this alone; nobody is running the commercial side of the overlay motion."),
      ("demo2", "Requesting an OAE from the overlay manager.")]),
    ("Underwriting workflow expansion", "Extend automated underwriting to two more policy lines.", "Commercial", "Bluefin Insurance", "urgent", "demo2",
     ["Expansion", "Exec Escalation"], -2, 6, "420000", ["AI Services", "Integration"], "Chief Underwriting Officer", "Incumbent", "Exec alignment call",
     ["+Technical win", "Pricing", "Exec alignment"],
     [("demo2", "Underwriting leadership wants a reference before expanding. Escalated to our VP.")]),
    ("Policy admin integration", "Connect the policy admin system to the claims platform.", "Qualify", "Bluefin Insurance", "medium", None,
     ["Coverage Gap"], 20, 3, "160000", ["Integration"], "", "Regional reseller", "Find an owner on our side", [], []),
    ("Claims platform renewal", "Annual renewal for claims platform support.", "Commit", "Bluefin Insurance", "high", "demo5",
     ["Renewal"], 2, 2, "85000", [], "Director of Claims IT", "None identified", "Renewal signature before the 27-day deadline",
     ["+Usage review", "Paperwork", "Signature"], []),

    # ── Halcyon Pharma (Full) ───────────────────────────────────────────────
    ("Pharmacovigilance data lake", "Consolidate adverse-event data into a governed lake before the inspection.", "Validate", "Halcyon Pharma", "urgent", "demo3",
     ["Strategic Initiative"], 8, 8, "640000", ["Data Platform", "Security"], "Head of Research IT", "Incumbent", "Validation protocol sign-off",
     ["+Data governance review", "+Validation protocol drafted", "QA sign-off", "Inspection dry run"],
     [("demo3", "Compliance flagged a data residency question; OSA is drafting the response."),
      ("demo1", "Residency response accepted. QA sign-off scheduled.")]),
    ("Lab notebook AI assistant", "Summarize and search electronic lab notebooks.", "Shape", "Halcyon Pharma", "medium", "demo1",
     ["New Workload"], 32, 4, "260000", ["AI Services"], "Director of R&D Informatics", "Build in-house", "Validation approach for GxP",
     [], []),
    ("Compliance reporting add-on", "Automated regulatory reporting module.", "Commit", "Halcyon Pharma", "medium", "demo5",
     ["Cross-Sell"], 5, 3, "120000", ["Security"], "Head of Quality", "None identified", "Signature", ["+Technical win", "Signature"], []),
    ("Research workspace renewal", "Annual renewal for research workspace licenses.", "Won", "Halcyon Pharma", "low", "demo2",
     ["Renewal"], None, 1, "75000", [], "Head of Research IT", "None identified", "", [], []),
    ("Clinical trial integration hub", "Integrate CRO data feeds.", "Won", "Halcyon Pharma", "medium", "demo4",
     ["Expansion"], None, 4, "330000", ["Integration"], "VP Clinical Operations", "Regional reseller", "",
     [], [("demo4", "Won against the reseller on implementation time.")]),

    # ── Keystone Logistics (Gap: no overlay pod) ────────────────────────────
    ("Warehouse automation competitive eval", "A competitor is proposing a rival platform for the new distribution center.", "Shape", "Keystone Logistics", "urgent", "demo1",
     ["Competitive Displacement", "Coverage Gap"], -6, 6, "380000", ["AI Services", "Integration"], "", "Hyperscaler native", "Get overlay coverage assigned",
     ["Competitive brief", "Overlay pod assigned"],
     [("demo1", "No overlay AE or SA on this account to position against the competitor."),
      ("demo3", "Flagged the gap to the overlay director. Still no owner.")]),
    ("Fleet telematics expansion", "Extend telematics to the refrigerated trailer fleet.", "Discover", "Keystone Logistics", "medium", None,
     ["Expansion", "Coverage Gap"], -10, 3, "210000", ["Data Platform"], "", "Incumbent", "Discovery call (rescheduled twice)", [], []),
    ("Cross-dock pilot proposal", "Pilot proposal for the cross-dock facility opening next quarter.", "Commercial", "Keystone Logistics", "high", "demo2",
     ["Competitive Displacement"], -1, 5, "175000", ["Integration"], "Director of Operations", "Regional reseller", "Pricing (owner needed)",
     ["+Proposal sent", "Pricing", "Pilot agreement"],
     [("demo2", "Champion is asking what the overlay engagement costs and nobody is driving it.")]),
    ("Cold chain telematics", "Telematics for the cold chain fleet.", "Lost", "Keystone Logistics", "low", "demo1",
     ["Competitive Displacement", "Coverage Gap"], None, 3, "110000", ["Data Platform"], "", "Regional reseller", "",
     [], [("demo1", "Closed lost to the reseller bundle. No overlay team was engaged on this one.")]),
    ("Contract renewal at risk", "Base platform renewal due in 19 days with no exec sponsor engaged.", "Commit", "Keystone Logistics", "urgent", "demo5",
     ["Renewal", "Exec Escalation"], 1, 4, "530000", [], "VP Operations", "Hyperscaler native", "Exec-to-exec call",
     ["Exec-to-exec call", "Renewal proposal", "Signature"], [("demo5", "Asked our CRO to call their VP Operations directly.")]),

    # ── Summit Retail Holdings (Full) ───────────────────────────────────────
    ("Store inventory integration", "Real-time inventory sync between stores and e-commerce.", "Validate", "Summit Retail Holdings", "high", "demo4",
     ["New Workload"], 15, 5, "450000", ["Integration"], "Head of Omnichannel", "Incumbent", "Load test results",
     ["+Integration design", "Load test", "Readout"], [("demo4", "Load test scheduled after the holiday freeze.")]),
    ("Demand forecasting model", "Store-level demand forecasting for perishables.", "Qualify", "Summit Retail Holdings", "medium", "demo3",
     ["Cross-Sell"], 42, 4, "290000", ["AI Services", "Data Platform"], "Director of Supply Chain", "Build in-house", "Data access",
     [], []),
    ("Payment security review", "PCI scope reduction review.", "Identify", "Summit Retail Holdings", "low", None,
     ["Cross-Sell"], None, 2, "", ["Security"], "", "None identified", "Find the PCI program owner", [], []),
    ("E-commerce observability", "Monitoring for the e-commerce checkout path.", "Won", "Summit Retail Holdings", "medium", "demo1",
     ["Expansion"], None, 3, "190000", ["Observability"], "VP E-commerce", "Incumbent", "",
     [], [("demo1", "Won after a peak-weekend proof of value.")]),
]


def _card(row):
    (title, desc, column, lane, priority, assignee, labels, due_offset, weight, deal_value,
     products, champion, competitor, next_step, checklist, comments) = row
    is_done = column in ("Won", "Lost")
    values = {
        "Overlay products": _encode(products),
        "Primary competitor": competitor,
        "Champion": champion,
        "Next step": next_step,
        "Overlay engaged": "true" if products and _COVERAGE[lane] != "Gap" else "false",
    }
    if deal_value:
        values["Deal value"] = deal_value
    return {
        "title": title,
        "description": desc,
        "priority": priority,
        "column": column,
        "swimlane": lane,
        "due_date": None if is_done or due_offset is None else _date(due_offset),
        "weight": weight,
        "labels": list(labels),
        "assignee": assignee,
        "checklist": [
            {"text": item.lstrip("+").strip(), "is_checked": item.startswith("+")}
            for item in checklist
        ],
        "comments": [{"body": body, "author": author} for author, body in comments],
        "custom_field_values": {k: v for k, v in values.items() if v},
    }


def _encode(products):
    ordered = [p for p in _PRODUCTS if p in products]
    return '["' + '","'.join(ordered) + '"]' if ordered else ""


def _field(name, field_type, gen, choices=(), show=False, help_text="", **display):
    return {"name": name, "field_type": field_type, "choices": list(choices), "show_on_card": show,
            "help_text": help_text, "display": display, "gen": gen}


def _lane_field(name, field_type, choices=(), show=False, admin_only=False, help_text="", **display):
    # Every row value is hand-written on SWIMLANES above.
    return {"name": name, "field_type": field_type, "choices": list(choices), "show_on_row": show,
            "is_admin_only": admin_only, "help_text": help_text, "display": display,
            "gen": lambda lc: None}


_STAGE_PROB = {"Identify": 5, "Discover": 10, "Qualify": 20, "Shape": 35, "Validate": 50,
               "Commercial": 70, "Commit": 90, "Won": 100, "Lost": 0}
_STAGE_FORECAST = {"Identify": "Pipeline", "Discover": "Pipeline", "Qualify": "Pipeline",
                   "Shape": "Best case", "Validate": "Best case", "Commercial": "Commit",
                   "Commit": "Commit", "Won": "Closed won", "Lost": "Closed lost"}

FEATURES = {
    "card_fields": [
        _field("Deal value", "number", lambda c: None, show=True,
               help_text="Expected contract value of the opportunity.", number_prefix="$", number_decimals=0),
        _field("Forecast", "dropdown", lambda c: _STAGE_FORECAST[c["card"]["column"]],
               choices=["Pipeline", "Best case", "Commit", "Closed won", "Closed lost"], show=True,
               help_text="Forecast category the account team is calling.",
               choice_colors={"Pipeline": "slate", "Best case": "blue", "Commit": "amber",
                              "Closed won": "green", "Closed lost": "red"}),
        _field("Win probability", "number", lambda c: str(_STAGE_PROB[c["card"]["column"]]),
               help_text="Stage-weighted likelihood of closing.", number_suffix="%", number_decimals=0),
        _field("Expected close", "date",
               lambda c: None if c["is_done"] else _date(30 + c["seq"] % 90),
               help_text="When the account team expects signature."),
        _field("Overlay products", "multi_select", lambda c: None, choices=_PRODUCTS,
               help_text="Specialist products the overlay pod is bringing into the deal.",
               choice_colors={"Data Platform": "blue", "Security": "red", "AI Services": "violet",
                              "Observability": "teal", "Integration": "amber"}),
        _field("Overlay engaged", "checkbox", lambda c: None,
               help_text="An overlay AE or SA is actively working the opportunity."),
        _field("Champion", "text", lambda c: None, help_text="Internal champion driving the opportunity."),
        _field("Primary competitor", "dropdown", lambda c: None, choices=_COMPETITORS,
               help_text="Main alternative the customer is weighing.",
               choice_colors={"Incumbent": "red", "Hyperscaler native": "amber", "Regional reseller": "violet",
                              "Build in-house": "slate", "None identified": "green"}),
        _field("Next step", "text", lambda c: None, help_text="The single next action that moves the deal."),
        _field("Services", "text",
               lambda c: {"Laura Bennett": "Sam Ortega", "Victor Shah": "Dana Whitfield", "Mira Chen": "Ines Moreau"}
               [_AD_BY_LANE[c["card"]["swimlane"]]] if c["progress"] >= 0.5 else None,
               help_text="Services lead engaged on this opportunity."),
        _field("CRM opportunity", "url", lambda c: f"https://crm.example.com/opportunities/OPP-{c['seq'] + 4000}",
               help_text="Opportunity record in the CRM (fictional)."),
    ],
    "swimlane_fields": [
        _lane_field("AD", "text", show=True, help_text="Account director who owns the strategic relationship."),
        _lane_field("AE", "text", show=True, help_text="Account executive who owns the commercial relationship."),
        _lane_field("SA", "text", show=True, help_text="Solutions architect aligned to the account team."),
        _lane_field("OAE", "text", show=True, help_text="Overlay account executive running the overlay sales motion."),
        _lane_field("OSA", "text", show=True, help_text="Overlay solutions architect providing specialist technical coverage."),
        _lane_field("SVC", "text", show=True, help_text="Services lead aligned to the account director."),
        _lane_field("Region", "dropdown", ["AMER East", "AMER West", "EMEA"], show=True,
                    help_text="Sales region.", choice_colors={"AMER East": "blue", "AMER West": "teal", "EMEA": "violet"}),
        _lane_field("Coverage", "dropdown", ["Full", "Partial", "Gap"], show=True,
                    help_text="Whether the overlay pod is fully staffed on the account.",
                    choice_colors={"Full": "green", "Partial": "amber", "Gap": "red"}),
        _lane_field("Segment", "dropdown", ["Financial services", "Energy and utilities", "Telecommunications",
                                            "Public sector", "Healthcare", "Manufacturing", "Insurance",
                                            "Life sciences", "Transportation", "Retail"],
                    help_text="Industry segment."),
        _lane_field("Install base ARR", "number", help_text="Recurring revenue already under contract.",
                    number_prefix="$", number_decimals=0),
        _lane_field("Renewal date", "date", help_text="Next base platform renewal."),
        _lane_field("Overlay products owned", "multi_select", _PRODUCTS,
                    help_text="Overlay products the account already runs."),
        _lane_field("Account plan", "url", help_text="Account plan document."),
        _lane_field("Strategic account", "checkbox", help_text="Named in the company's strategic account program."),
        _lane_field("Executive sponsor", "text", admin_only=True, help_text="Visible to board admins only."),
    ],
}

_AD_BY_LANE = {name: values["AD"] for name, _, _, _, values in _ACCOUNTS}
for _lane in SWIMLANES:
    _lane["custom_field_values"]["Account plan"] = (
        "https://docs.example.com/account-plans/" + _lane["name"].lower().replace(" ", "-")
    )
    # Drop empty values the way the exporter does (a value of "" is "unset").
    _lane["custom_field_values"] = {k: v for k, v in _lane["custom_field_values"].items() if v}

SALES_OVERLAY = {
    "slug": "sales_overlay",
    "name": "Template: Sales Overlay",
    "description": (
        "Account coverage under an enterprise overlay model: each row is an account with its primary "
        "team (AD, AE, SA, services) and an overlay pod (overlay AE + overlay SA). Which accounts have a "
        "coverage gap, and which deals does it put at risk?"
    ),
    "columns": COLUMNS,
    "swimlanes": SWIMLANES,
    "labels": LABELS,
    "extra_cards": [_card(row) for row in _CARDS],
}
