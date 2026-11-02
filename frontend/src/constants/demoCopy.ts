/**
 * Refusal copy for the hosted demo (#1179).
 *
 * Every refusal uses ONE fixed lead clause — "This is a shared demo — " —
 * followed by a per-surface clause. The lead is never reworded per surface,
 * so a visitor learns to read it as "the demo, not you" (same convention as
 * maintenance mode's fixed title). See "Hosted demo surfaces" in
 * frontend/CLAUDE.md before adding a surface.
 */
export const DEMO_LEAD = "This is a shared demo — ";

export const demoReason = (surfaceClause: string): string => `${DEMO_LEAD}${surfaceClause}.`;

export const DEMO_COMMENT_REASON = demoReason("comments aren't saved here");
export const DEMO_UPLOAD_REASON = demoReason("file uploads are off here");
export const DEMO_NEW_BOARD_REASON = demoReason("boards can't be created here");
export const DEMO_IMPORT_REASON = demoReason("boards can't be imported here");
export const DEMO_NEW_GROUP_REASON = demoReason("groups can't be created here");
export const DEMO_SETTINGS_REASON = demoReason("settings can't be changed here");

// #1193 — several refused writes still fell through to the fallback toast
// with no up-front affordance. Same fixed-lead convention as above.
export const DEMO_DELETE_COMMENT_REASON = demoReason("comments can't be deleted here");
export const DEMO_DELETE_ATTACHMENT_REASON = demoReason("attachments can't be deleted here");
export const DEMO_ADD_RELATION_REASON = demoReason("card relations can't be added here");
export const DEMO_STAR_REASON = demoReason("boards can't be starred here");
export const DEMO_MARK_READ_REASON = demoReason("notifications can't be marked read here");
// #1133 — the board and group health status trigger.
export const DEMO_HEALTH_STATUS_REASON = demoReason("health status can't be changed here");

// #1914 — the card detail sheet's shared-demo notes (design frame 7): one at
// the top of the body, and one in the PR/MR section, which is read-only here.
export const DEMO_CARD_DETAIL_NOTE = demoReason("edits to this card are visible to every visitor");
export const DEMO_EXTERNAL_REF_REASON = demoReason("pull or merge request links can't be changed here");
// The footer line that replaces Archive and Delete in the demo's card sheet.
export const DEMO_CARD_FOOTER_NOTE = demoReason("cards can't be archived or deleted here");
