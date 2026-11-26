/**
 * Help-topic registry (#2589): the single source of docs topic keys.
 *
 * Surfaces reference a key (`<HelpLink topic="webhooks" />`), never a URL.
 * Plain data on purpose: #2591's anchor check parses this file and verifies
 * that `docs/<path>.md` exists and that each `anchor` is a heading slug in it.
 * #2590 adds the Concepts page anchors that later keys will point at.
 *
 * Rules: `path` is relative to the docs root and ends in `/` (mkdocs uses
 * directory URLs); `anchor` has no leading `#`; `summary` is one static line
 * (the link's tooltip, at most about 60 characters; no banners or tours, #2542). Never rename or
 * remove a key without grepping every surface.
 *
 * Area -> topic -> docs section (#2593). Surfaces: the heading that carries the link.
 *
 *   Analytics        analytics.definitions    features/analytics#flow-metric-definitions  (page title)
 *                    analytics.bottleneck     features/analytics#bottleneck               (Bottleneck panel)
 *                    analytics.cycle-time/.throughput/.cumulative-flow/.wip-age  features/analytics#flow-metrics (one per chart; analytics.flow-metrics kept)
 *                    analytics.how-work-flows features/analytics#how-work-flows           ("How work flows" panel heading)
 *                    analytics.blocked        features/analytics#why-cards-get-blocked   (Why cards get blocked)
 *                    analytics.attention      features/analytics#needs-attention          (Needs attention)
 *   Health status    health.status            features/health-status#the-four-states     (status popover)
 *                    health.review            features/health-status#ask-for-a-review-every-n-days (board and group review settings)
 *   Groups           groups.members/.invites/.defaults/.labels   features/groups#...      (Group settings sections)
 *   Board settings   board.display, wip-limit, board.stale, analytics.definitions, child-cards,
 *                    health.review, board.sharing, board.export, lens.configure, webhooks.setup,
 *                    column-policies, field-sets, custom-fields and swimlane-fields (tab text links), permissions (Role column)
 *   Integrations     tokens.personal, mcp (Access tokens), webhooks (service notice), webhooks.setup
 *   Issue Board Lens lens                     features/issue-board-lens#using-the-lens   (lens banner)
 *   Import           board.import, import.trello, import.samples
 *   Saved filters    saved-filters            features/saved-filters#saving-a-filter     (saved filters panel)
 *   Shortcuts        shortcuts                features/keyboard-shortcuts#keyboard-shortcuts (overlay)
 *   User menu        help/pageTopic.ts: board.overview, groups, admin.panel, else home
 *   Site admin       admin.general, admin.email, admin.users, admin.invites, admin.board-invites  administration/admin-panel#...  (section headings)
 *   Group overview   groups.members                              (Members card heading)
 *   Not in scope     the home page (#2474) and the app shell (#2473) are outside #2593's area list. SSO/OIDC has
 *                    no UI surface in the app (configured by env vars), so it has no link.
 */
export interface HelpTopic {
  /** Docs path relative to the docs root, ending in "/". Empty = docs home. */
  path: string;
  /** Heading slug on that page, without "#". */
  anchor?: string;
  /** What the linked section explains; used for the topic name in the link's accessible name. */
  summary: string;
  /** Visible words for the text variant; defaults to "Learn more". */
  linkText?: string;
  /** Short subject for the accessible name: "Learn more about {subject}, opens docs". */
  subject: string;
}

export const HELP_TOPICS = {
  home: {
    path: "",
    subject: "Visiban",
    summary: "The Visiban documentation home page.",
  },
  "analytics.bottleneck": {
    path: "features/analytics/",
    anchor: "bottleneck",
    subject: "bottleneck detection",
    summary: "How Analytics picks the bottleneck column.",
  },
  "analytics.definitions": {
    path: "features/analytics/",
    anchor: "flow-metric-definitions",
    subject: "flow metric definitions",
    summary: "What lead time, cycle time, dwell, age and throughput mean.",
  },
  "analytics.cycle-time": {
    path: "features/analytics/",
    anchor: "flow-metrics",
    subject: "the cycle time chart",
    summary: "How to read the cycle time scatter.",
  },
  "analytics.throughput": {
    path: "features/analytics/",
    anchor: "flow-metrics",
    subject: "the throughput chart",
    summary: "How to read the throughput chart.",
  },
  "analytics.cumulative-flow": {
    path: "features/analytics/",
    anchor: "flow-metrics",
    subject: "the cumulative flow chart",
    summary: "How to read the cumulative flow chart.",
  },
  "analytics.wip-age": {
    path: "features/analytics/",
    anchor: "flow-metrics",
    subject: "the WIP age chart",
    summary: "How to read the WIP age chart.",
  },
  "analytics.flow-metrics": {
    path: "features/analytics/",
    anchor: "flow-metrics",
    subject: "the flow metric charts",
    summary: "How to read cycle time, throughput, cumulative flow and WIP age.",
  },
  "analytics.how-work-flows": {
    path: "features/analytics/",
    anchor: "how-work-flows",
    subject: "how work flows and where the time goes",
    summary: "How the flow row and the time-per-column bar are drawn.",
  },
  "analytics.blocked": {
    path: "features/analytics/",
    anchor: "why-cards-get-blocked",
    subject: "block reasons",
    summary: "How block reasons are ranked by time blocked.",
  },
  "analytics.attention": {
    path: "features/analytics/",
    anchor: "needs-attention",
    subject: "needs attention",
    summary: "Which cards the Needs attention list picks, and why.",
  },
  "health.status": {
    path: "features/health-status/",
    anchor: "the-four-states",
    subject: "health status",
    summary: "What the four health states mean and who can set one.",
  },
  "health.review": {
    path: "features/health-status/",
    anchor: "ask-for-a-review-every-n-days",
    subject: "health review reminders",
    summary: "How a review every N days works.",
  },
  "health.auto": {
    path: "features/health-status/",
    anchor: "auto-health",
    subject: "automatic health status",
    summary: "How health status can be calculated from the board.",
  },
  groups: {
    path: "features/groups/",
    anchor: "structure",
    subject: "groups",
    summary: "How groups, subgroups and boards fit together.",
  },
  "groups.boards": {
    path: "features/groups/",
    anchor: "boards-inside-groups",
    subject: "boards inside a group",
    summary: "How a board in a group inherits access from it.",
  },
  "groups.subgroups": {
    path: "features/groups/",
    anchor: "subgroups",
    subject: "subgroups",
    summary: "How subgroups nest and inherit.",
  },
  "groups.members": {
    path: "features/groups/",
    anchor: "membership",
    subject: "group members and roles",
    summary: "Who can be a group member and what each role can do.",
  },
  "groups.roles": {
    path: "features/groups/",
    anchor: "board-roles-vs-group-roles",
    subject: "group roles compared with board roles",
    summary: "How a group role and a board role combine.",
  },
  "groups.settings": {
    path: "features/groups/",
    anchor: "the-group-page-and-group-settings",
    subject: "group settings",
    summary: "What the group page and Group settings hold.",
  },
  "groups.invites": {
    path: "features/groups/",
    anchor: "invite-links",
    subject: "group invite links",
    summary: "How invite links add people to a group.",
  },
  "groups.defaults": {
    path: "features/groups/",
    anchor: "group-board-defaults",
    subject: "group board defaults",
    summary: "Which defaults a new board in the group starts with.",
  },
  "groups.labels": {
    path: "features/groups/",
    anchor: "group-shared-labels",
    subject: "group shared labels",
    summary: "How shared labels are copied to new boards.",
  },
  permissions: {
    path: "features/permissions/",
    anchor: "the-four-board-roles",
    subject: "board roles",
    summary: "What each board role can do.",
  },
  "board.settings": {
    path: "features/board/",
    anchor: "board-settings",
    subject: "board settings",
    summary: "What each Board settings section controls.",
  },
  "board.display": {
    path: "features/board/",
    anchor: "card-density",
    subject: "card density and display",
    summary: "How card density and board presets change the board.",
  },
  "board.overview": {
    path: "features/board/",
    anchor: "board-cards",
    subject: "working the board",
    summary: "The grid, cards and settings of a board.",
  },
  "admin.general": {
    path: "administration/admin-panel/",
    anchor: "general-and-email-sections",
    subject: "the General and Email settings",
    summary: "What the General and Email switches control.",
  },
  "admin.users": {
    path: "administration/admin-panel/",
    anchor: "users-section",
    subject: "managing users",
    summary: "What each user action in Site admin does.",
  },
  "admin.invites": {
    path: "administration/admin-panel/",
    anchor: "invite-links-section",
    subject: "invite links",
    summary: "How to create, send and revoke invite links.",
  },
  "admin.email": {
    path: "administration/admin-panel/",
    anchor: "email-section",
    subject: "email settings",
    summary: "Where password resets and invites are sent from.",
  },
  "admin.board-invites": {
    path: "administration/admin-panel/",
    anchor: "board-invites-section",
    subject: "board invites",
    summary: "How to review and revoke every board's invites.",
  },
  "admin.panel": {
    path: "administration/admin-panel/",
    anchor: "general-and-email-sections",
    subject: "the admin panel",
    summary: "What each Site admin section controls.",
  },
  "board.sharing": {
    path: "features/board/",
    anchor: "board-sharing",
    subject: "public sharing",
    summary: "How a public share link works and ends.",
  },
  "board.export": {
    path: "features/board/",
    anchor: "export-import",
    subject: "export and import",
    summary: "What an export holds and who can run one.",
  },
  "board.import": {
    path: "features/board/",
    anchor: "import",
    subject: "importing a board",
    summary: "How a JSON or CSV import creates a board.",
  },
  "import.trello": {
    path: "features/trello-import/",
    anchor: "start-the-import",
    subject: "importing from Trello",
    summary: "How to export from Trello and import the file.",
  },
  "import.samples": {
    path: "features/",
    anchor: "start-from-a-sample",
    subject: "sample boards",
    summary: "What the ready-made sample boards include.",
  },
  "board.stale": {
    path: "features/card-history/",
    anchor: "stale-card-detection",
    subject: "stale card detection",
    summary: "How a card becomes stale and how it is tinted.",
  },
  lens: {
    path: "features/issue-board-lens/",
    anchor: "using-the-lens",
    subject: "the Issue Board Lens",
    summary: "How the lens shows GitHub or GitLab issues as a board.",
  },
  "lens.configure": {
    path: "features/issue-board-lens/",
    anchor: "configuring-the-lens-on-a-board",
    subject: "setting up the Issue Board Lens",
    summary: "How to connect a board to a repository.",
  },
  "saved-filters": {
    path: "features/saved-filters/",
    anchor: "saving-a-filter",
    subject: "saved filters",
    summary: "How to save, load and share a filter.",
  },
  shortcuts: {
    path: "features/keyboard-shortcuts/",
    anchor: "keyboard-shortcuts",
    subject: "keyboard shortcuts",
    summary: "Every keyboard shortcut and when it works.",
  },
  "tokens.personal": {
    path: "features/personal-access-tokens/",
    anchor: "create-a-token",
    subject: "personal access tokens",
    summary: "How to create, scope and revoke a token.",
  },
  mcp: {
    path: "features/mcp-server/",
    anchor: "what-is-the-visiban-mcp-server",
    subject: "the MCP server",
    summary: "How an AI agent connects to your boards.",
  },
  "webhooks.setup": {
    path: "features/webhooks/",
    anchor: "set-up-a-webhook-board-admins",
    subject: "setting up a webhook",
    summary: "How a board admin adds and tests a webhook.",
  },
  "stage.sub-columns": {
    path: "features/board/",
    anchor: "sub-columns-and-tracks",
    subject: "sub-columns",
    summary: "How a stage's sub-columns work.",
  },
  "stage.tracks": {
    path: "features/board/",
    anchor: "sub-columns-and-tracks",
    subject: "tracks",
    summary: "How a stage's tracks work.",
  },
  checklist: {
    path: "features/board/",
    anchor: "checklist",
    subject: "the checklist",
    summary: "How a card's checklist works.",
  },
  "child-cards": {
    path: "features/board/",
    anchor: "child-cards",
    subject: "child cards",
    summary: "How child cards and the default child board work.",
  },
  "planned-children": {
    path: "features/board/",
    anchor: "planned-child",
    subject: "planned children",
    linkText: "About planned children",
    summary: "How a planned child waits until it is needed.",
  },
  "tracks.where": {
    path: "features/concepts/",
    anchor: "concept-track",
    subject: "where a track is set",
    linkText: "Where tracks are set",
    summary: "What a track is and where it is set.",
  },
  "column-policies": {
    path: "features/column-policies/",
    anchor: "column-policies",
    subject: "entry criteria",
    summary: "How column policies and entry criteria work.",
  },
  "wip-limit": {
    path: "features/board/",
    anchor: "hard-wip-enforcement",
    subject: "WIP limits",
    summary: "How WIP limits and hard WIP enforcement work.",
  },
  "custom-fields": {
    path: "features/custom-fields/",
    anchor: "managing-card-fields-board-settings-card-fields",
    subject: "card fields",
    summary: "How to add, pin and limit custom card fields.",
  },
  "swimlane-fields": {
    path: "features/custom-fields/",
    anchor: "managing-swimlane-fields-board-settings-swimlane-fields",
    subject: "swimlane fields",
    summary: "How to add swimlane fields and place them on the lane band.",
  },
  "field-sets": {
    path: "features/custom-fields/",
    anchor: "field-sets",
    subject: "field sets",
    summary: "How field sets group and show custom fields.",
  },
  "work-breakdown": {
    path: "features/breaking-work-down/",
    anchor: "which-tool",
    subject: "choosing between a checklist, a track and a child card",
    linkText: "Which tool?",
    summary: "Breaking work down: which tool to use.",
  },
  webhooks: {
    path: "features/webhooks/",
    subject: "webhooks",
    summary: "How webhooks work and how to set them up.",
  },
  "webhooks.verify": {
    path: "api/webhooks/",
    anchor: "verifying-signatures",
    subject: "verifying webhook signatures",
    summary: "How to verify a webhook signature.",
  },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicKey = keyof typeof HELP_TOPICS;
