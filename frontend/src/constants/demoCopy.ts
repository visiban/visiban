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
