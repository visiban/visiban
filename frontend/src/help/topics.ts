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
