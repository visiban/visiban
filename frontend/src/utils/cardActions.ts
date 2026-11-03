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
import { demoReason, DEMO_CARD_FOOTER_NOTE } from "../constants/demoCopy";
import { blockedElapsedMs, formatBlockedDuration, isManuallyBlocked } from "./blockedState";
import { failureReason } from "./moveFailure";

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

const VERB: Record<CardActionId, string> = {
  open: "open", "copy-link": "copy links to", move: "move", assign: "assign",
  priority: "change the priority of", block: "block", unblock: "unblock", archive: "archive", delete: "delete",
};

function roleReason(role: CardActionContext["role"], action: CardActionId): string {
  const who = role === "collaborator" ? "Collaborators" : "Viewers";
  return `${who} can't ${VERB[action]} cards`;
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
  // Same demo carve-out as CardDetail: the published visitor may reassign
  // cards others created (archive is withheld in the demo, see below).
  const canModifyOthersInDemo = canModifyOthers || (ctx.demoMode && ctx.role === "member");
  const ownsAny = (widen: boolean) =>
    widen || cards.some((c) => c.created_by == null || ctx.currentUserId == null || c.created_by.id === ctx.currentUserId);

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
    entry("move", "Move to…", writeGate("move")),
    entry("assign", "Assign to…", writeGate("assign") ?? (ownsAny(canModifyOthersInDemo) ? undefined : OWNER_ONLY_REASON)),
    entry("priority", "Set priority", writeGate("priority")),
    entry(blockId, blocked ? "Unblock card" : "Block card…", blockReason),
    // The demo's card sheet withholds Archive and Delete (#1914 frame 7); the
    // menu follows the sheet, which is the per-card surface it stands in for.
    entry("archive", "Archive card", writeGate("archive") ?? (ctx.demoMode ? DEMO_CARD_FOOTER_NOTE : ownsAny(canModifyOthersInDemo) ? undefined : OWNER_ONLY_REASON)),
    entry("delete", "Delete card…", writeGate("delete") ?? (ctx.demoMode ? DEMO_CARD_FOOTER_NOTE : ownsAny(canModifyOthers) ? undefined : OWNER_ONLY_REASON)),
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
 * Moves serially, like the toolbar: concurrent position-reorder transactions
 * on one column deadlock. Each card keeps its swimlane and lands last.
 */
export async function moveCardsToColumn(boardId: number, cards: Card[], column: Column): Promise<CardActionResult<Card>> {
  const done: Card[] = [];
  const reasons = new Set<string>();
  for (const card of cards) {
    try {
      const result = await moveCard(boardId, card.id, { column_id: column.id, swimlane_id: card.swimlane, position: 9999 });
      done.push(result.card);
    } catch (err) {
      reasons.add(failureReason(err));
    }
  }
  return summarize(done, cards.length, "moved", reasons);
}

async function settleEach<T>(cards: Card[], run: (card: Card) => Promise<T>, verb: string, forbidden?: string): Promise<CardActionResult<T>> {
  const results = await Promise.allSettled(cards.map(run));
  const done = results.filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === "fulfilled").map((r) => r.value as T);
  const reasons = new Set(
    results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => failureReason(r.reason, forbidden)),
  );
  return summarize(done, cards.length, verb, reasons);
}

export function assignCards(boardId: number, cards: Card[], userId: number | null): Promise<CardActionResult<Card>> {
  return settleEach(cards, (card) => updateCard(boardId, card.id, { assignee_id: userId }), userId === null ? "unassigned" : "assigned");
}

export function setCardsPriority(boardId: number, cards: Card[], priority: Priority): Promise<CardActionResult<Card>> {
  return settleEach(cards, (card) => updateCard(boardId, card.id, { priority }), "updated");
}

export function archiveCards(boardId: number, cards: Card[]): Promise<CardActionResult<number>> {
  return settleEach(cards, (card) => archiveCard(boardId, card.id).then(() => card.id), "archived", "you can only archive cards you created");
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
