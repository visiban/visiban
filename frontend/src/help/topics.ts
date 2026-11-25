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
