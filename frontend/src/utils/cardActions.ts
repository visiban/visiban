/**
 * Card-scoped actions shared by the card context menu and the ⌘K palette
 * (#2059, 1.3 UI spec Part 9 § 2).
 *
 * Both surfaces offer the same verbs on the same "target set" of cards and
 * must agree on which are available and why not, so the availability rules
 * live here once. They mirror the role gating the bulk toolbar and the card
 * detail sheet already apply (`BulkActionToolbar`, `CardDetail`); the server
 * stays the authority, and a refused write still reports through the bulk
 * partial-failure wording (`failureReason`).
 */
import { archiveCard, moveCard, updateCard } from "../api/cards";
import type { BoardFull, Card, Column, Priority } from "../types";
import { userDisplayName } from "../types";
import { PRIORITY_COLORS } from "../constants/colors";
import { demoReason, DEMO_CARD_FOOTER_NOTE } from "../constants/demoCopy";
import { blockedElapsedMs, formatBlockedDuration, isManuallyBlocked } from "./blockedState";
import { failureReason } from "./moveFailure";
import { isAssignableMember } from "./assignableMembers";

/** Every card action. `open` and `delete` are menu-only; the palette offers the rest. */
export type CardActionId =
  | "open"
  | "copy-link"
  | "move"
  | "assign"
  | "priority"
  | "block"
  | "unblock"
  | "archive"
  | "delete";

/** `visiban:card-action` detail (the palette → BoardView contract, § Command palette ownership). */
export interface CardActionDetail {
  cardIds: number[];
  action: CardActionId;
  /** Move: the column id. Assign: the user id, or `null` to unassign. Priority: the priority. */
  value?: number | string | null;
}

export const CARD_ACTION_EVENT = "visiban:card-action";
/**
 * Synchronous request/response over a window event: the palette asks the
 * board which cards it would act on and what it may do to them, without
 * reaching into BoardView state. The listener fills `detail.response`.
 */
export const CARD_TARGET_QUERY_EVENT = "visiban:card-target-query";

/** Where the target came from, in resolution order (open sheet > focus > selection). */
export type CardTargetSource = "open" | "focused" | "selection" | "result";

export interface CardActionEntry {
  id: CardActionId;
  label: string;
  enabled: boolean;
  /** Second-line reason when disabled. Never hidden instead (§ Card context menu). */
  reason?: string;
}

export interface CardTargetInfo {
  cardIds: number[];
  source: CardTargetSource;
  /** One-line description of the target for the palette header. */
  summary: string;
  actions: CardActionEntry[];
}

export interface CardTargetQueryDetail {
  /** Explicit cards (a palette search result drilled into); omitted → resolve the default target. */
  cardIds?: number[];
  /** Card that held keyboard focus when the palette opened, captured before it took focus. */
  focusedCardId?: number | null;
  response?: CardTargetInfo | null;
}

/**
 * Target resolution, in spec order. Hover is never a target: it is invisible
 * to keyboard users, and ⌘K moves the pointer's meaning.
 */
export function resolveCardTarget({
  openCardId, focusedCardId, selectedIds,
}: {
  openCardId: number | null | undefined;
  focusedCardId: number | null | undefined;
  selectedIds: Iterable<number>;
}): { cardIds: number[]; source: CardTargetSource } | null {
  if (openCardId != null) return { cardIds: [openCardId], source: "open" };
  if (focusedCardId != null) return { cardIds: [focusedCardId], source: "focused" };
  const selected = [...selectedIds];
  if (selected.length > 0) return { cardIds: selected, source: "selection" };
  return null;
}

/**
 * The context-menu target set: a card inside the selection acts on the whole
 * selection; a card outside it acts on that one card and leaves the
 * selection unchanged.
 */
export function contextMenuTargetIds(cardId: number, selectedIds: Set<number>): number[] {
  return selectedIds.has(cardId) ? [...selectedIds] : [cardId];
}

/**
 * The card whose face itself has keyboard focus, for the palette's "focused"
 * target. Focus on a control inside the face (the selection checkbox, a
 * quick-edit chip, the ⋯ button) does not count: toggling a card's checkbox
 * leaves focus there, and treating that as "focused" would make ⌘K act on one
 * card instead of the selection, or on a card the user just deselected.
 */
export function focusedCardFaceId(el: Element | null | undefined): number | null {
  if (!el?.matches?.("[data-card-id]")) return null;
  return cardIdFromElement(el);
}

/** The id of the card a DOM node belongs to, from the card face's `data-card-id`. */
export function cardIdFromElement(el: Element | null | undefined): number | null {
  const face = el?.closest?.("[data-card-id]");
  const raw = face?.getAttribute("data-card-id");
  const id = raw ? Number(raw) : NaN;
  return Number.isFinite(id) ? id : null;
}

export interface CardActionContext {
  role: BoardFull["current_user_role"];
  currentUserId: number | null;
  isModerator: boolean;
  demoMode: boolean;
  /** Maintenance mode is on and this user is not exempt (BoardView's `blockedByMaintenance`). */
  maintenanceBlocked: boolean;
}

export const SELECT_ONE_REASON = "Select one card";
export const MAINTENANCE_REASON = "Maintenance mode is active — changes can't be saved right now";
export const OWNER_ONLY_REASON = "Only the card's creator or a board admin";
export const DEMO_BLOCK_REASON = demoReason("cards can't be blocked here");
export const MOVE_ASSIGNED_REASON = "Assigned to someone else: only its creator, its assignee or a board admin";

const VERB: Record<CardActionId, string> = {
  open: "open", "copy-link": "copy links to", move: "move", assign: "assign",
  priority: "change the priority of", block: "block", unblock: "unblock", archive: "archive", delete: "delete",
};

function roleReason(role: CardActionContext["role"], action: CardActionId): string {
  const who = role === "collaborator" ? "Collaborators" : "Viewers";
  return `${who} can't ${VERB[action]} cards`;
}

/** Actions whose refusal depends on who created or holds the card. */
export type OwnershipAction = "move" | "assign" | "priority" | "archive" | "delete";

/**
 * Why the server refuses each ownership-gated action, as a number-neutral
 * clause that completes `… could not be {verb} — {reason}.` after both
 * "1 of 1 card" and "2 of 5 cards" (§ Bulk operations rule 2: no plural
 * pronouns). One table for the bulk toolbar and the context-menu / palette
 * executors, so the two surfaces word a refusal identically (#2173).
 *
 * Assign's clause is "you can only assign cards you created": the server lets
 * a card's creator assign their own card (`_require_own_content`), so the old
 * "assigning needs a moderator or admin" was inaccurate.
 */
export const REFUSAL_CLAUSE: Record<OwnershipAction, string> = {
  move: "a card assigned to someone else can only be moved by its creator, its assignee or a board admin",
  assign: "you can only assign cards you created",
  priority: "you can only edit cards you created",
  archive: "you can only archive cards you created",
  delete: "you can only delete cards you created",
};

/**
 * Whether the client already knows the server will refuse `action` on this one
 * card for ownership, and why (a `REFUSAL_CLAUSE`); `undefined` when it may go.
 * The per-card form of the ownership rules in `cardActionEntries`, and just as
 * lenient: an unknown creator, assignee or current user is left to the server.
 * Role, maintenance and demo gates are not here; they apply to the whole set
 * and stay in `cardActionEntries`.
 */
export function cardRefusal(card: Card, action: OwnershipAction, ctx: CardActionContext): string | undefined {
  const isAdmin = ctx.role === "admin" || ctx.role === "site_admin";
  const canModifyOthers = isAdmin || ctx.isModerator;
  // Same demo carve-out as CardDetail: the published visitor may reassign
  // cards others created (archive and delete are withheld in the demo).
  const widen = action === "delete" ? canModifyOthers : canModifyOthers || (ctx.demoMode && ctx.role === "member");
  if (widen) return undefined;
  const uid = ctx.currentUserId;
  if (uid == null || card.created_by == null || card.created_by.id === uid) return undefined;
  if (action === "move") {
    // The server refuses a move only for a card assigned to someone else that
    // the user did not create (backend move_card).
    return card.assignee == null || card.assignee.id === uid ? undefined : REFUSAL_CLAUSE.move;
  }
  return REFUSAL_CLAUSE[action];
}

/** Splits a target set into the cards worth sending and those known to be refused. */
export function partitionRefused(
  cards: Card[], action: OwnershipAction, ctx: CardActionContext | undefined,
): { sendable: Card[]; refused: number; clause: string | undefined } {
  if (!ctx) return { sendable: cards, refused: 0, clause: undefined };
  const sendable = cards.filter((c) => cardRefusal(c, action, ctx) === undefined);
  return { sendable, refused: cards.length - sendable.length, clause: sendable.length < cards.length ? REFUSAL_CLAUSE[action] : undefined };
}

/**
 * Availability of every action for a target set, in menu order. Labels are
 * state-aware (`Block card…` / `Unblock card`). Ownership-gated actions are
 * disabled only when the client knows every card's creator and none is the
 * user's; otherwise they stay enabled and a refusal is reported by the bulk
 * partial-failure message, as the toolbar does.
 */
export function cardActionEntries(cards: Card[], ctx: CardActionContext): CardActionEntry[] {
  const single = cards.length === 1 ? cards[0] : null;
  const isAdmin = ctx.role === "admin" || ctx.role === "site_admin";
  const writer = isAdmin || ctx.role === "member";
  const canModifyOthers = isAdmin || ctx.isModerator;
  // Disabled only when the client knows EVERY card is refused; one card that
  // may go keeps the action enabled and the rest report as partial failure.
  const everyRefused = (action: OwnershipAction): string | undefined =>
    cards.every((c) => cardRefusal(c, action, ctx) !== undefined)
      ? (action === "move" ? MOVE_ASSIGNED_REASON : OWNER_ONLY_REASON)
      : undefined;

  const writeGate = (action: CardActionId): string | undefined => {
    if (ctx.maintenanceBlocked) return MAINTENANCE_REASON;
    if (!writer) return roleReason(ctx.role, action);
    return undefined;
  };
  const entry = (id: CardActionId, label: string, reason?: string): CardActionEntry =>
    ({ id, label, enabled: reason === undefined, ...(reason !== undefined ? { reason } : {}) });

  const blocked = single ? isManuallyBlocked(single) : false;
  const blockId: CardActionId = blocked ? "unblock" : "block";
  // Block / Unblock run through the card sheet's form, so they take
  // CardDetail's exact gate (`canBlock`): the user must be KNOWN to be the
  // creator, or a moderator / admin. The lenient "unknown creator stays
  // enabled" rule below suits writes the server reports back on; here an
  // enabled item would open a sheet with no form and no message.
  const ownsSingle = !!single && ctx.currentUserId != null && single.created_by?.id === ctx.currentUserId;
  const blockReason = !single
    ? SELECT_ONE_REASON
    : writeGate(blockId) ?? (ctx.demoMode ? DEMO_BLOCK_REASON : canModifyOthers || ownsSingle ? undefined : OWNER_ONLY_REASON);

  return [
    entry("open", "Open card", single ? undefined : SELECT_ONE_REASON),
    entry("copy-link", "Copy link to card", single ? undefined : SELECT_ONE_REASON),
    // The server refuses a move only for a card assigned to someone else that
    // the user did not create (backend move_card); disabled only when every
    // target card is known to be such a card.
    entry("move", "Move to…", writeGate("move") ?? everyRefused("move")),
    entry("assign", "Assign to…", writeGate("assign") ?? everyRefused("assign")),
    // Any PATCH takes the server's own-content gate ("You can only edit cards
    // you created"), so Priority follows Assign's ownership rule.
    entry("priority", "Set priority", writeGate("priority") ?? everyRefused("priority")),
    entry(blockId, blocked ? "Unblock card" : "Block card…", blockReason),
    // The demo's card sheet withholds Archive and Delete (#1914 frame 7); the
    // menu follows the sheet, which is the per-card surface it stands in for.
    entry("archive", "Archive card", writeGate("archive") ?? (ctx.demoMode ? DEMO_CARD_FOOTER_NOTE : everyRefused("archive"))),
    entry("delete", "Delete card…", writeGate("delete") ?? (ctx.demoMode ? DEMO_CARD_FOOTER_NOTE : everyRefused("delete"))),
  ];
}

/** Menu groups (one divider between groups), by action id. */
export const CARD_MENU_GROUPS: CardActionId[][] = [
  ["open", "copy-link"],
  ["move", "assign", "priority"],
  ["block", "unblock"],
  ["archive", "delete"],
];

/**
 * Palette commands: no Open (the card result itself opens), and no Delete — a
 * destructive command reachable by typing should not be one keystroke from
 * Enter. Palette labels name the card ("Move card to…") because they sit
 * among board-level commands.
 */
export const PALETTE_CARD_ACTIONS: CardActionId[] = ["block", "unblock", "move", "assign", "priority", "copy-link", "archive"];

export const PALETTE_LABEL: Partial<Record<CardActionId, string>> = {
  move: "Move card to…",
  assign: "Assign card to…",
  priority: "Set priority…",
};

/** Every palette card-command label, for the no-target hint ("block" names a command). */
export const PALETTE_COMMAND_LABELS = [
  "Block card…", "Unblock card", "Move card to…", "Assign card to…", "Set priority…", "Copy link to card", "Archive card",
];

/** The palette's command list for a target, state-aware block first. */
export function paletteCardActions(info: CardTargetInfo): CardActionEntry[] {
  const byId = new Map(info.actions.map((a) => [a.id, a]));
  return PALETTE_CARD_ACTIONS
    .map((id) => byId.get(id))
    .filter((a): a is CardActionEntry => !!a)
    .map((a) => ({ ...a, label: PALETTE_LABEL[a.id] ?? a.label }));
}

/** Header line for a target: "Fix payout rounding · Blocked 3d" or "3 selected cards". */
export function cardTargetSummary(cards: Card[], source: CardTargetSource): string {
  if (cards.length === 1) {
    const card = cards[0];
    return card.blocked_at != null
      ? `${card.title} · Blocked ${formatBlockedDuration(blockedElapsedMs(card.blocked_at), 1)}`
      : card.title;
  }
  return source === "selection" ? `${cards.length} selected cards` : `${cards.length} cards`;
}

/** Deep link to a card: the board URL with `?card=`, which BoardView opens on load. */
export function cardLink(boardId: number, cardId: number, origin: string = window.location.origin): string {
  return `${origin}/boards/${boardId}?card=${cardId}`;
}

export const PRIORITY_CHOICES: Priority[] = ["low", "medium", "high", "urgent"];

/**
 * One option in a Move / Assign / Priority choice list (#2103). The card
 * context menu, the ⌘K palette and the bulk toolbar all render these, so the
 * three surfaces cannot disagree on which columns, members or priorities are
 * offered or in what order.
 */
export interface CardChoice {
  key: string;
  label: string;
  /** Move: column id. Assign: user id, or `null` for Unassign. Priority: the priority. */
  value: number | string | null;
  /** Color dot (column color, priority color). */
  dot?: string;
  /** Muted italic row (Unassign). */
  italic?: boolean;
}

export function moveChoices(columns: Column[]): CardChoice[] {
  return columns.map((c) => ({ key: `col-${c.id}`, label: c.name, value: c.id, dot: c.color }));
}

/** Unassign, then every member who can hold a card (viewers cannot). */
export function assignChoices(members: BoardFull["members"]): CardChoice[] {
  return [
    { key: "unassign", label: "Unassign", value: null, italic: true },
    // Members the server accepts as an assignee: not viewers, not an unrecognized stored role (#1905).
    ...members.filter(isAssignableMember).map((m) => ({ key: `user-${m.user.id}`, label: userDisplayName(m.user), value: m.user.id })),
  ];
}

export function priorityChoices(): CardChoice[] {
  return PRIORITY_CHOICES.map((p) => ({ key: `prio-${p}`, label: p.charAt(0).toUpperCase() + p.slice(1), value: p, dot: PRIORITY_COLORS[p] }));
}

const plural = (n: number) => `card${n !== 1 ? "s" : ""}`;

/** Outcome of a write over a target set, in the bulk partial-failure wording (§ Bulk operations). */
export interface CardActionResult<T> {
  done: T[];
  failed: number;
  /** `{failed} of {total} cards could not be {verb} — {reason}.`, or null on full success. */
  failureMessage: string | null;
}

function summarize<T>(done: T[], total: number, verb: string, reasons: Set<string>): CardActionResult<T> {
  const failed = total - done.length;
  return {
    done,
    failed,
    failureMessage: failed > 0
      ? `${failed} of ${total} ${plural(total)} could not be ${verb} — ${reasons.size === 1 ? [...reasons][0] : "for more than one reason"}.`
      : null,
  };
}

/**
 * The executors below take the user's `CardActionContext` so a mixed set skips
 * the cards the client already knows the server refuses (`cardRefusal`): they
 * are not sent, count as failed, and carry the ownership reason. Delete does
 * the same through `CardDeleteConfirm`, which takes the same context and
 * `partitionRefused`. Without a context nothing is
 * skipped and the server decides. The server stays the enforcement point.
 */

/**
 * Moves serially, like the toolbar: concurrent position-reorder transactions
 * on one column deadlock. Each card keeps its swimlane and lands last.
 */
export async function moveCardsToColumn(boardId: number, cards: Card[], column: Column, ctx?: CardActionContext): Promise<CardActionResult<Card>> {
  const { sendable, clause } = partitionRefused(cards, "move", ctx);
  const done: Card[] = [];
  const reasons = new Set<string>(clause ? [clause] : []);
  for (const card of sendable) {
    try {
      const result = await moveCard(boardId, card.id, { column_id: column.id, swimlane_id: card.swimlane, position: 9999 });
      done.push(result.card);
    } catch (err) {
      reasons.add(failureReason(err, REFUSAL_CLAUSE.move));
    }
  }
  return summarize(done, cards.length, "moved", reasons);
}

async function settleEach<T>(
  cards: Card[], run: (card: Card) => Promise<T>, verb: string, action: OwnershipAction, ctx: CardActionContext | undefined,
): Promise<CardActionResult<T>> {
  const { sendable, clause } = partitionRefused(cards, action, ctx);
  const results = await Promise.allSettled(sendable.map(run));
  const done = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled").map((r) => r.value as T);
  const reasons = new Set(
    results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => failureReason(r.reason, REFUSAL_CLAUSE[action])),
  );
  if (clause) reasons.add(clause);
  return summarize(done, cards.length, verb, reasons);
}

export function assignCards(boardId: number, cards: Card[], userId: number | null, ctx?: CardActionContext): Promise<CardActionResult<Card>> {
  return settleEach(cards, (card) => updateCard(boardId, card.id, { assignee_id: userId }), userId === null ? "unassigned" : "assigned", "assign", ctx);
}

export function setCardsPriority(boardId: number, cards: Card[], priority: Priority, ctx?: CardActionContext): Promise<CardActionResult<Card>> {
  return settleEach(cards, (card) => updateCard(boardId, card.id, { priority }), "updated", "priority", ctx);
}

export function archiveCards(boardId: number, cards: Card[], ctx?: CardActionContext): Promise<CardActionResult<number>> {
  return settleEach(cards, (card) => archiveCard(boardId, card.id).then(() => card.id), "archived", "archive", ctx);
}

/**
 * The slot message for a refused click when the client knows every card is
 * refused: the same rule-2 wording a server refusal would produce.
 */
export function allRefusedMessage(cards: Card[], action: OwnershipAction, verb: string): string {
  return `${cards.length} of ${cards.length} ${plural(cards.length)} could not be ${verb} — ${REFUSAL_CLAUSE[action]}.`;
}

/** Success line for the board's polite status region. */
export function successMessage(action: CardActionId, cards: Card[], extra?: string): string {
  const what = cards.length === 1 ? `“${cards[0].title}”` : `${cards.length} cards`;
  switch (action) {
    case "move": return `Moved ${what} to ${extra}.`;
    case "assign": return extra ? `Assigned ${what} to ${extra}.` : `Unassigned ${what}.`;
    case "priority": return `Set ${what} to ${extra} priority.`;
    case "archive": return `Archived ${what}.`;
    case "copy-link": return "Link copied to the clipboard.";
    case "delete": return `Deleted ${what}.`;
    default: return "";
  }
}
