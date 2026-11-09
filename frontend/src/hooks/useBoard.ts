import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { getBoardFull, patchBoard as apiPatchBoard, reorderColumns as apiReorderColumns, reorderSwimlanes as apiReorderSwimlanes, deleteSwimlane as apiDeleteSwimlane, deleteColumn as apiDeleteColumn } from "../api/boards";
import { moveCard as apiMoveCard, getArchivedCards } from "../api/cards";
import { failureReason } from "../utils/moveFailure";
import { placementVerdict, pruneLaneLimitColumn, trippedLimitSentence } from "../utils/placementLimits";
import { dropUnknownLabels } from "../utils/cardLabels";
import { isStaleCard } from "../utils/cardVersion";
import { swimlaneForRole } from "../utils/swimlaneMerge";
import type { BoardFull, BoardMembership, Card, CardSiblingPosition, EffectiveBoardMember, Column, Swimlane, Label, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from "../types";

/** Result of useBoard.moveCard: it never rejects, so callers must check `ok`. */
export type MoveOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * `also` (#1150) is client-side: sentences naming the other limits the move
 * tripped, computed from board state when the refusal arrives, because the
 * server's body names only the strictest one.
 */
export type MoveBlockedError =
  | { code: "wip_limit_exceeded"; column_name: string; current_count: number; wip_limit: number; also?: string[] }
  | { code: "wip_hard_blocked"; column_name: string; current_count: number; wip_limit: number; also?: string[] }
  | { code: "weight_limit_exceeded"; column_name: string; current_weight: number; weight_limit: number; card_weight: number; also?: string[] }
  // Swimlane (row) limits (#1150): the column bodies plus `swimlane_name`;
  // the counters are the swimlane's.
  | { code: "swimlane_wip_limit_exceeded"; column_name: string; swimlane_name: string; current_count: number; wip_limit: number; also?: string[] }
  | { code: "swimlane_wip_hard_blocked"; column_name: string; swimlane_name: string; current_count: number; wip_limit: number; also?: string[] }
  | { code: "swimlane_weight_limit_exceeded"; column_name: string; swimlane_name: string; current_weight: number; weight_limit: number; card_weight: number; also?: string[] }
  | { code: "version_conflict"; detail: string; current_version: number }
  | { code: "permission_denied"; detail: string }
  | { code: "maintenance_mode"; detail: string }
  // Any other failure (network, 5xx, 404, unrecognized 409/503): without this the
  // card snaps back with no explanation (#1761).
  | { code: "move_failed"; detail: string };

// Codes the toast has copy for; anything else (a throttle or validation code)
// would render as "undefined weight ... NaN", so it falls to the generic toast.
const KNOWN_MOVE_ERROR_CODES = new Set<string>([
  "wip_limit_exceeded", "wip_hard_blocked", "weight_limit_exceeded",
  "swimlane_wip_limit_exceeded", "swimlane_wip_hard_blocked", "swimlane_weight_limit_exceeded",
  "version_conflict", "permission_denied", "maintenance_mode", "move_failed",
]);

// Limit refusals a board admin can override with force (#1150 adds the
// swimlane pair); the hard codes have no retry path.
const SOFT_LIMIT_CODES = new Set<string>([
  "wip_limit_exceeded", "weight_limit_exceeded",
  "swimlane_wip_limit_exceeded", "swimlane_weight_limit_exceeded",
]);
const HARD_LIMIT_CODES = new Set<string>(["wip_hard_blocked", "swimlane_wip_hard_blocked"]);

/** The scope and kind a limit refusal's `code` reports, to drop it from `also`. */
function reportedLimit(code: string): { scope: "column" | "swimlane"; kind: "wip" | "weight" } {
  return {
    scope: code.startsWith("swimlane_") ? "swimlane" : "column",
    kind: code.includes("weight") ? "weight" : "wip",
  };
}

/**
 * Sentences for every limit the move tripped besides the one the server
 * reported (#1150). Computed from the board as the request found it, with the
 * moved card at its pre-move cell, so a column and a swimlane that both trip
 * are both named. Empty when only one did, or when nothing can be predicted.
 */
function otherTrippedLimits(
  board: BoardFull, before: Card | undefined, columnId: number, swimlaneId: number, code: string,
): string[] {
  const column = board.columns.find((c) => c.id === columnId);
  const lane = board.swimlanes.find((s) => s.id === swimlaneId);
  if (!before || !column || !lane) return [];
  const reported = reportedLimit(code);
  return placementVerdict({ flags: board, columns: board.columns, cards: board.cards, card: before, column, lane })
    .filter((t) => !(t.scope === reported.scope && t.kind === reported.kind))
    .map(trippedLimitSentence);
}

/** Generic toast for a failed move that no specific code covered (#1761). The
 * title is "Move failed", so the body is just the capitalized cause. */
function genericMoveFailure(err: unknown): MoveBlockedError {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  const reason = status === 404
    ? "the card or board no longer exists, so the board was refreshed"
    : failureReason(err);
  return { code: "move_failed", detail: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` };
}

export interface PendingMove {
  cardId: number;
  columnId: number;
  swimlaneId: number;
  position: number;
}

/**
 * Replace a member row with an incoming `member.*` frame, keeping the
 * previously known `is_site_admin` when the frame omits it (#1290). The field
 * is sent only to admin subscribers and the socket resolves the subscriber's
 * role at connect time, so a frame can lack it even though the row had it.
 * A membership change never changes the member's instance-level flag, so the
 * known value stays correct.
 */
function mergeMemberRow(prev: EffectiveBoardMember, incoming: BoardMembership): EffectiveBoardMember {
  let merged: EffectiveBoardMember = incoming;
  if (!("is_site_admin" in incoming) && prev.is_site_admin !== undefined) {
    merged = { ...merged, is_site_admin: prev.is_site_admin };
  }
  // Same for the all-content signal (#1301): a membership frame never carries
  // it, and dropping it would bring the role picker back on a reopened panel.
  if (prev.has_all_content_access !== undefined) {
    merged = { ...merged, has_all_content_access: prev.has_all_content_access };
  }
  return merged;
}

/**
 * Replace the card with `incoming.id` by `prepare(incoming)`, unless `incoming`
 * is an older version than the stored copy (#1969). An HTTP response and a
 * socket frame for the same card travel on different transports, so the older
 * of the two can land last; it must not put the older card back on screen.
 * Returns the same array when nothing is replaced, so callers can keep the
 * board's identity. Every single-card replacement in this hook (socket frames
 * and HTTP card responses) goes through here; see isStaleCard for why an equal
 * version still replaces. The full-board fetches in `load` / `silentReload`
 * apply the same rule, but only to cards written while they were in flight;
 * see mergeFullSnapshot (#2038).
 */
function replaceCardUnlessStale(cards: Card[], incoming: Card, prepare: (c: Card) => Card = (c) => c): Card[] {
  const i = cards.findIndex((c) => c.id === incoming.id);
  if (i === -1 || isStaleCard(incoming, cards[i])) return cards;
  const next = cards.slice();
  next[i] = prepare(incoming);
  return next;
}

/**
 * Apply the positions a `card.moved` frame carries for the siblings the move
 * renumbered (#1890). Before 1.3 the frame carried only the moved card, so
 * every other client kept the old positions of the cards around it until it
 * reloaded. The client cannot renumber the cell itself: it does not know the
 * server's tie-break, and a reorder within one cell leaves a gap. So it
 * applies the server's numbers.
 *
 * Only `position` changes; nothing else about the sibling is in the pair.
 * A pair is skipped when the stored copy is newer (`isStaleCard`): a position
 * shift does not bump `version`, so a pair carries the sibling's version as
 * of the move, and a stored copy with a higher one has since been moved or
 * edited and already holds the server's later state. Ids not on the board
 * (an archived card, one this client never loaded) are skipped too. Returns
 * the same array when nothing changes, and untouched cards keep their
 * identity so memoized card faces do not re-render.
 */
function applySiblingPositions(cards: Card[], pairs: readonly CardSiblingPosition[]): Card[] {
  const byId = new Map<number, CardSiblingPosition>();
  for (const pair of pairs) {
    if (typeof pair?.id === "number" && typeof pair.position === "number") byId.set(pair.id, pair);
  }
  let next: Card[] | null = null;
  for (let i = 0; i < cards.length; i++) {
    const pair = byId.get(cards[i].id);
    if (!pair || pair.position === cards[i].position || isStaleCard(pair, cards[i])) continue;
    next ??= cards.slice();
    next[i] = { ...cards[i], position: pair.position };
  }
  return next ?? cards;
}

/**
 * A pure write to the parts of the board that are not cards (#2130): columns,
 * swimlanes, labels (and their copies on cards), members, custom field
 * definitions and board-level fields. It must not mutate its argument, and
 * applying it to a board that already reflects it must change nothing, so that
 * replaying it over a `/full/` snapshot is safe (see mergeFullSnapshot). It
 * names what it changes by id: a write that would replace a whole list is
 * expressed with listChange instead, so it cannot erase an item the snapshot
 * holds and the screen never had.
 */
type BoardWrite = (board: BoardFull) => BoardFull;

/**
 * The writes this client applied while one `/full/` fetch was in flight
 * (#2038, #2130). One set exists per fetch, created when the fetch starts and
 * closed when its response arrives, so it holds only what happened after the
 * start.
 */
interface FetchTouches {
  /**
   * Ids of cards a frame or an HTTP response wrote onto the board. A copy the
   * #1969 guard dropped as older than the one on screen is not a write.
   */
  written: Set<number>;
  /** Ids of cards whose position a `card.moved` sibling pair set (#1890). */
  siblingPositions: Set<number>;
  /**
   * Uids of cards that left the board; `true` when they left by archiving.
   * Also holds the cards a column or swimlane delete took with it (#2130).
   */
  removed: Map<string, boolean>;
  /** Every non-card write, in the order it was applied (#2130). */
  replay: BoardWrite[];
  /** Whether the archived-card count was re-read meanwhile; see refreshArchivedCount. */
  recountArchived: boolean;
}

/**
 * Apply a `/full/` response over the board on screen (#2038).
 *
 * The server serializes the snapshot at some point while the request is in
 * flight. A frame that arrives during the fetch may have been committed after
 * that point, so applying the snapshot wholesale would undo it until the next
 * event for that card: an edit reverts, a card created meanwhile vanishes, a
 * deleted or archived one comes back.
 *
 * Design choice: the snapshot stays authoritative, except for the cards that
 * this client wrote while the fetch was in flight. A blanket merge by version
 * (keep the newer card for every id) was rejected for three reasons:
 * - A reload exists to recover from drift: a frame lost while the socket was
 *   down or before it joined the board group (#1463, #1968), or a counter
 *   change that never sent a frame. For a card nothing touched during the
 *   fetch, the snapshot is the best state the client can get, whatever its
 *   version, so it replaces the local copy. That includes a lower version,
 *   which is how a deliberate server-side correction (a database restore, a
 *   demo reset) reaches the screen.
 * - Versions cannot answer "is this card still on the board". A card missing
 *   from the snapshot was either removed before it was read or created after;
 *   only the knowledge that a frame created it during the fetch tells the two
 *   apart. Removals are the same in reverse.
 * - The local copy of an untouched card carries no information the snapshot
 *   lacks, so there is nothing for a merge to protect.
 *
 * For a written card, the newer copy wins by `version`, with the #1969 rule:
 * only a strictly lower snapshot version loses, and an equal version still
 * replaces, because comments, attachments, checklists, relations and
 * archive/unarchive change a card without bumping `version`. A card whose
 * position a sibling pair set during the fetch keeps that position when the
 * versions are equal: a position shift does not bump the sibling's version, so
 * the version cannot tell an older snapshot from a newer one, and the pair is
 * at least as new as the snapshot read (a later move in that cell sends a
 * later frame, ordered by event_id in updateCard). Keeping the local copy is
 * safe whenever a frame for a later change is still on its way: it lands on
 * top, as it would without the reload.
 *
 * Presence: a card written during the fetch and missing from the snapshot is
 * kept (it was created or restored after the read; a later delete or archive
 * sends its own frame). A card that left the board during the fetch is dropped
 * from the snapshot. One archived meanwhile also raises the snapshot's
 * `archived_card_count`, which was read while the card was still on the board;
 * without that, the count would drop below the truth, the unsafe direction
 * (#1289). A card restored meanwhile and kept is not subtracted: over-counting
 * is the safe direction, and the next full read corrects it.
 *
 * A different board (the hook is reused across /boards/:id), no previous
 * board, or no writes during the fetch: the snapshot is returned unchanged.
 * An equal-version change the snapshot predates (a comment, attachment,
 * checklist or relation) still reverts until the next event for that card;
 * telling those apart needs an event cursor on `/full/` (#2089).
 *
 * The rest of the board (#2130) is handled differently: every non-card write
 * applied during the fetch is replayed, in order, over the snapshot. This is
 * the rule docs/api/websockets.md gives API clients (apply the frames that
 * arrived meanwhile on top of the snapshot, idempotently). Replay rather than
 * a per-id comparison like the cards above, because:
 * - Columns, swimlanes, labels, members, custom field definitions and board
 *   fields carry no `version`, so there is nothing to tell an older copy from
 *   a newer one. Replaying a write the snapshot already contains is harmless
 *   (each BoardWrite is idempotent), and a later change the snapshot holds
 *   sends a later frame, which lands after the replayed one. Each write names
 *   only the items it changed (whole lists go through listChange), so an item
 *   the snapshot holds and the screen missed survives the replay.
 * - The writes cascade. A column or swimlane delete also removes its cards
 *   (the server sends only `column.deleted` / `swimlane.deleted`, nothing per
 *   card) and prunes swimlane limits; a label rename or delete rewrites the
 *   copies on every card. Replaying the write repeats the cascade over the
 *   snapshot's cards, including cards this client never had. A deleted column
 *   or swimlane brought back by the snapshot would otherwise stay until the
 *   next full read, since no later event removes it again.
 * - A column or swimlane created meanwhile is put back, so a card created in
 *   it during the fetch (kept above) is not left without its column.
 * - A swimlane.updated write in resolver form (mergeSwimlaneFromBroadcast) is
 *   re-resolved against the snapshot's copy of the swimlane, not the copy
 *   that was on screen.
 * - Every swimlane copy a write carries (a create, either form of an update)
 *   is shaped to the snapshot's `current_user_role` (swimlaneForRole, #2147),
 *   so an HTTP response made under another role is stored as the snapshot's
 *   own swimlanes are.
 *
 * Replay runs after the cards are merged. A card write and a non-card write
 * never undo each other in practice: a card written into a column deleted
 * later in the fetch had already left the board (and is in `removed`), and
 * updateCard drops labels the board no longer has (#1888). A card the screen
 * held in a deleted column but nothing wrote during the fetch is decided by
 * the replayed cascade alone, so a snapshot that has it in another column (a
 * move this tab missed) keeps it there.
 */
function mergeFullSnapshot(prev: BoardFull | null, snapshot: BoardFull, touches: FetchTouches): BoardFull {
  if (!prev || prev.id !== snapshot.id) return snapshot;
  const withCards = mergeSnapshotCards(prev, snapshot, touches);
  return touches.replay.reduce((board, write) => write(board), withCards);
}

/** The card half of mergeFullSnapshot (#2038). */
function mergeSnapshotCards(prev: BoardFull, snapshot: BoardFull, touches: FetchTouches): BoardFull {
  if (touches.written.size === 0 && touches.siblingPositions.size === 0 && touches.removed.size === 0) return snapshot;
  const local = new Map(prev.cards.map((c) => [c.id, c]));
  const inSnapshot = new Set<number>();
  const cards: Card[] = [];
  let changed = false;
  let archivedMeanwhile = 0;
  for (const card of snapshot.cards) {
    inSnapshot.add(card.id);
    const mine = local.get(card.id);
    if (!mine) {
      // Gone from the screen. Dropped only when it left during the fetch;
      // otherwise this is the drift a reload recovers (a card the client
      // never received).
      const archived = touches.removed.get(card.uid);
      if (archived === undefined) {
        cards.push(card);
      } else {
        changed = true;
        if (archived) archivedMeanwhile += 1;
      }
      continue;
    }
    if (touches.written.has(card.id) && isStaleCard(card, mine)) {
      cards.push(mine);
      changed = true;
    } else if (
      touches.siblingPositions.has(card.id) && card.version === mine.version && card.position !== mine.position
    ) {
      cards.push({ ...card, position: mine.position });
      changed = true;
    } else {
      cards.push(card);
    }
  }
  for (const mine of prev.cards) {
    if (!inSnapshot.has(mine.id) && touches.written.has(mine.id)) {
      cards.push(mine);
      changed = true;
    }
  }
  if (!changed) return snapshot;
  const archivedCount = typeof snapshot.archived_card_count === "number"
    ? snapshot.archived_card_count + archivedMeanwhile
    : snapshot.archived_card_count;
  return { ...snapshot, cards, archived_card_count: archivedCount };
}

/**
 * The board without column `columnId`, the cards in it (the server cascades
 * them and sends only `column.deleted`) and its id in swimlane limits. Shared
 * by the local delete and the `column.deleted` frame, and replayed over a
 * `/full/` snapshot that predates the delete (#2130).
 */
function withoutColumn(b: BoardFull, columnId: number): BoardFull {
  return {
    ...b,
    columns: b.columns.filter((c) => c.id !== columnId),
    cards: b.cards.filter((c) => c.column !== columnId),
    swimlanes: pruneLaneLimitColumn(b.swimlanes, columnId),
  };
}

/** The swimlane counterpart of withoutColumn (#2130). */
function withoutSwimlane(b: BoardFull, swimlaneId: number): BoardFull {
  return {
    ...b,
    swimlanes: b.swimlanes.filter((s) => s.id !== swimlaneId),
    cards: b.cards.filter((c) => c.swimlane !== swimlaneId),
  };
}

/**
 * `items` in `orderedIds` order. An item the list does not name is kept, after
 * the named ones: live, the ids come from the same state and name them all,
 * but replayed over a `/full/` snapshot (#2130) the snapshot can hold a column
 * this client never received, and a reorder must not delete it.
 */
function orderByIds<T extends { id: number }>(items: T[], orderedIds: number[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const named = new Set(orderedIds);
  const ordered = orderedIds.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  return [...ordered, ...items.filter((item) => !named.has(item.id))];
}

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A whole-list write (a reorder frame or response, or the settings Fields tab
 * committing its own list) expressed as what it changed relative to `before`,
 * the list it replaced on screen (#2130). Applied to `current`:
 * - an item `next` dropped is removed;
 * - an item `next` added is inserted (or replaces an echo already there);
 * - an item `next` changed gets only the fields that changed, over the copy in
 *   `current`, and is skipped when `current` no longer has it (deleted);
 * - the order follows `next`; an item `current` has that `next` does not name
 *   (one the screen never had) is kept, placed by its `position`.
 * Applied to `before` it gives `next`, so the live result is unchanged. Replayed
 * over a `/full/` snapshot it does not erase what the snapshot holds and this
 * tab missed, which a plain replace would: the Fields tab's list stops syncing
 * while a row is being edited, and an HTTP response is not ordered against the
 * frames that land around it.
 */
function listChange<T extends { id: number; position: number }>(before: T[], next: T[]): (current: T[]) => T[] {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const nextIds = new Set(next.map((item) => item.id));
  const removed = new Set(before.filter((item) => !nextIds.has(item.id)).map((item) => item.id));
  return (current) => {
    const currentById = new Map(current.map((item) => [item.id, item]));
    const ordered: T[] = [];
    for (const item of next) {
      const old = beforeById.get(item.id);
      const mine = currentById.get(item.id);
      if (!old) {
        ordered.push(item); // added by this write
      } else if (mine === undefined) {
        continue; // changed here, but gone from `current`: do not bring it back
      } else if (mine === old) {
        ordered.push(item); // untouched since: the live case
      } else {
        const changed = (Object.keys(item) as (keyof T)[]).filter((k) => !sameValue(old[k], item[k]));
        ordered.push(changed.length === 0 ? mine : { ...mine, ...Object.fromEntries(changed.map((k) => [k, item[k]])) });
      }
    }
    for (const extra of current) {
      if (nextIds.has(extra.id) || removed.has(extra.id)) continue;
      const at = ordered.findIndex((item) => item.position > extra.position);
      if (at === -1) ordered.push(extra);
      else ordered.splice(at, 0, extra);
    }
    return ordered;
  };
}

/** Insert `item`, or replace the entry with its id: idempotent, so safe to replay (#2130). */
function upsertById<T extends { id: number }>(items: T[], item: T): T[] {
  return items.some((x) => x.id === item.id)
    ? items.map((x) => (x.id === item.id ? item : x))
    : [...items, item];
}

/**
 * Undo an optimistic move that failed (#1969). Only the moved card is touched:
 * restoring the whole pre-request list would also undo every frame that landed
 * while the request was in flight (other cards' edits, a card created, deleted
 * or archived meanwhile). Only its location is put back, and only while the
 * stored copy is still the optimistic one: a newer version that arrived since
 * already carries the server's real location, so it is kept. A card that left
 * the board meanwhile stays gone.
 */
function rollbackMovedCard(cards: Card[], before: Card | undefined): Card[] {
  if (!before) return cards;
  const i = cards.findIndex((c) => c.id === before.id);
  if (i === -1 || isStaleCard(before, cards[i])) return cards;
  const next = cards.slice();
  next[i] = {
    ...cards[i],
    column: before.column,
    swimlane: before.swimlane,
    position: before.position,
    column_entered_at: before.column_entered_at,
  };
  return next;
}

/**
 * A card's optimistic copy at its new location. Moving to another column starts a new
 * visit, so the dwell overlay (#459) drops the card's old time now rather than when the
 * response lands. The server's value replaces this one on the response. A swimlane-only
 * move or a reorder is not a new visit and leaves it alone.
 */
function placeCardOptimistically(
  card: Card,
  columns: Column[],
  { columnId, swimlaneId, position }: Pick<PendingMove, "columnId" | "swimlaneId" | "position">,
  now: string,
): Card {
  const placed = { ...card, column: columnId, swimlane: swimlaneId, position };
  if (columnId === card.column) return placed;
  const isDone = columns.find((c) => c.id === columnId)?.is_done ?? false;
  return { ...placed, column_entered_at: isDone ? null : now };
}

export function useBoard() {
  const { id } = useParams<{ id: string }>();
  const boardId = Number(id);
  const [board, setBoard] = useState<BoardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True once the board came back 404/403 (deleted or access lost, #2041). The
  // page swaps in an "isn't available" state; the hook never redirects.
  const [unavailable, setUnavailable] = useState(false);
  const [moveError, setMoveError] = useState<MoveBlockedError | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  // Ref mirrors the latest board state so callbacks can read it without
  // capturing `board` in their dependency arrays. This stabilizes the
  // identity of moveCard / forceMoveCard / reorderColumns / reorderSwimlanes
  // across renders, preventing unnecessary re-renders of memoized children.
  const boardRef = useRef(board);
  boardRef.current = board;

  const pendingMoveRef = useRef(pendingMove);
  pendingMoveRef.current = pendingMove;

  // Request-sequence guard (#1463): overlapping fetches (visibility + reconnect
  // resync, or a manual reload) can resolve out of order, so only the most
  // recently *started* request may write to state. A ref keeps load /
  // silentReload identities stable.
  const fetchSeqRef = useRef(0);
  // True while a (loading-skeleton) `load` has been superseded or is in flight
  // and no later fetch has produced board state yet. Lets a failed silent
  // resync that superseded a `load` fall back to it instead of leaving the
  // caller's rollback un-applied.
  const loadPendingRef = useRef(false);

  // Bumped by every other writer of archived_card_count: local archive and
  // unarchive, and full reloads (which re-seed it from /full/). A page-0
  // refresh whose response lands after one of those was computed before it,
  // so applying it would overwrite the fresher count with a lower one - the
  // unsafe under-count direction #1289 guards against. Discard such responses.
  const archivedCountGen = useRef(0);

  // Per card, the highest `card.moved` event_id (the frame's change-feed id,
  // #1114) whose data set that card's position (#1890). A position shift does
  // not bump `version`, so two moves of different cards in one cell send the
  // same siblings at the same version, and only the event_id orders them: the
  // later move locks the cell's card rows before it inserts its feed row, so
  // ids follow commit order for any two moves that touch the same card. Kept
  // per card, not per board, because moves in unrelated cells are not ordered
  // against each other. Kept across `/full/` responses on purpose: a frame
  // applied while the fetch was in flight can be newer than a frame for the
  // same card that is delivered after the response lands, and clearing here
  // would let that late frame move the card back. event_id is the global feed
  // PK and card ids are unique across boards, so an entry is never wrong for a
  // later board; the map is bounded by the cards moved in this session.
  const positionEventIds = useRef(new Map<number, number>());

  // When the latest `/full/` response was applied (Date.now()), or null before
  // the first one. BoardView compares it with the socket's first open (#1968):
  // the socket joins the board's broadcast group only after `/full/` returned,
  // so a frame committed in between is never delivered and the snapshot does
  // not contain it either. A ref (not state) because only that open reads it.
  const lastFullAtRef = useRef<number | null>(null);
  const getLastFullFetchAt = useCallback(() => lastFullAtRef.current, []);

  // The writes applied while the latest `/full/` fetch is in flight, or null
  // when none is (#2038, #2130); see mergeFullSnapshot. Each writer reads the
  // ref when it is called and records into that set from inside its setBoard
  // updater, where it knows whether the card is on the board. Reading it at
  // call time matters: React may run an updater queued before the response
  // arrived only after the response's own updater was queued, but always
  // before it, so the write still lands in the set the response merges with.
  // A writer called after the response captures null (or a newer fetch's set)
  // and its updater runs after the merge, on top of it.
  const fetchTouchesRef = useRef<FetchTouches | null>(null);
  const startFetchTouches = useCallback((): FetchTouches => {
    const touches: FetchTouches = { written: new Set(), siblingPositions: new Set(), removed: new Map(), replay: [], recountArchived: false };
    fetchTouchesRef.current = touches;
    return touches;
  }, []);

  // Applies a non-card write to the board and records it for the in-flight
  // fetch, if any, so the response replays it over its snapshot (#2130; see
  // mergeFullSnapshot). The set is read at call time, as for the card writers.
  //
  // `derive` builds the write from the board it is first applied to, the live
  // one, for a write defined by what it changed there (listChange). The replay
  // entry applies whatever the live updater derived; that updater runs before
  // the response's merge (see fetchTouchesRef), and deriving twice (React
  // StrictMode) yields equivalent writes.
  //
  // A card that a write removed (a column or swimlane delete) and that was
  // itself written during this fetch is also recorded as removed: its copy on
  // screen is the server's latest, so it really was in the deleted column, but
  // the snapshot may hold it in its previous column, out of reach of the
  // replayed cascade. Any other card is left to the cascade: its copy on
  // screen may be stale (the reload may be recovering a missed move), and the
  // replayed delete removes exactly the snapshot cards that are in the column.
  //
  // Returns a retraction for an optimistic write that later failed without a
  // reload: a write the server refused is not one the snapshot predates.
  const writeBoardFrom = useCallback((derive: (live: BoardFull) => BoardWrite): (() => void) => {
    const touches = fetchTouchesRef.current;
    let derived: BoardWrite | null = null;
    const entry: BoardWrite = (b) => (derived ? derived(b) : b);
    touches?.replay.push(entry);
    setBoard((b) => {
      if (!b) return b;
      derived = derive(b);
      const next = derived(b);
      if (touches && next.cards.length < b.cards.length) {
        const kept = new Set(next.cards.map((c) => c.id));
        for (const c of b.cards) {
          if (!kept.has(c.id) && touches.written.has(c.id)) touches.removed.set(c.uid, false);
        }
      }
      return next;
    });
    return () => {
      if (!touches) return;
      const i = touches.replay.lastIndexOf(entry);
      if (i !== -1) touches.replay.splice(i, 1);
    };
  }, []);
  const writeBoard = useCallback((write: BoardWrite) => writeBoardFrom(() => write), [writeBoardFrom]);
  // Applies a /full/ response that won the sequence guard. Closing the set
  // first stops later writers from recording into it. Like the close on a
  // failed fetch, this is hygiene rather than correctness: a later writer's
  // updater runs after the merge, and the next fetch opens a fresh set, so a
  // write into a closed set is never read. It only stops a set that is no
  // longer needed from collecting ids.
  const applyFullSnapshot = useCallback((snapshot: BoardFull, touches: FetchTouches) => {
    if (fetchTouchesRef.current === touches) fetchTouchesRef.current = null;
    setBoard((prev) => mergeFullSnapshot(prev, snapshot, touches));
  }, []);

  // Deleting a column or swimlane cascades to its archived cards, which the
  // client never holds (they are paged in only by ArchivedCardsPanel) and the
  // *.deleted event does not say how many there were (#1637). Guessing would
  // either under-count, which lets the Danger Zone skip typed confirmation, or
  // keep the stale overstated count. Ask the server for the authoritative
  // count instead. That is one page-0 request, which serializes up to 50 full
  // cards just to read `count` (the API has no count-only form), so it is only
  // made when the board had archived cards at all (`known`, when given, is
  // the count to judge that by instead of the one on screen).
  //
  // A request made while a `/full/` fetch is in flight is flagged on it
  // (#2130): its answer is discarded when the fetch lands first (the
  // archivedCountGen guard), or overwritten by the snapshot's count, read
  // before the delete, when it lands first. Either way the count would stay
  // too high, so the fetch asks again once its snapshot is applied.
  const refreshArchivedCount = useCallback((known?: number | null) => {
    const touches = fetchTouchesRef.current;
    if (touches) touches.recountArchived = true;
    const count = known === undefined ? boardRef.current?.archived_card_count : known;
    if (!count) return;
    const gen = archivedCountGen.current;
    getArchivedCards(boardId, 0)
      .then((page) => {
        if (gen !== archivedCountGen.current) return;
        // b.id guard: BoardProvider stays mounted across /boards/:id changes,
        // so a late response for board A must never land on board B.
        setBoard((b) => b && b.id === boardId ? { ...b, archived_card_count: page.count } : b);
      })
      .catch(() => {
        // Keep the previous count: it can only overstate, the safe direction.
      });
  }, [boardId]);

  const load = useCallback(() => {
    setLoading(true);
    const seq = ++fetchSeqRef.current;
    const touches = startFetchTouches();
    loadPendingRef.current = true;
    archivedCountGen.current += 1;
    getBoardFull(boardId)
      .then((b) => {
        if (seq !== fetchSeqRef.current) return;
        loadPendingRef.current = false;
        archivedCountGen.current += 1;
        lastFullAtRef.current = Date.now();
        setUnavailable(false);
        applyFullSnapshot(b, touches);
        if (touches.recountArchived) refreshArchivedCount(b.archived_card_count);
      })
      .catch((err) => {
        // A superseded failure must not surface: the newer request owns state.
        if (seq !== fetchSeqRef.current) return;
        if (fetchTouchesRef.current === touches) fetchTouchesRef.current = null;
        loadPendingRef.current = false;
        if (err?.response?.status === 404 || err?.response?.status === 403) {
          // Board doesn't exist or user lost access. The API answers both the
          // same way, so the page shows one "isn't available" state (#2041).
          setUnavailable(true);
        } else {
          setError("Failed to load board");
        }
      })
      // Only the latest request clears `loading`; a superseded load is skipped,
      // and its superseder (load or silentReload) clears it when it settles, so
      // loading can never stay stuck true.
      .finally(() => { if (seq === fetchSeqRef.current) setLoading(false); });
  }, [boardId, startFetchTouches, applyFullSnapshot, refreshArchivedCount]);

  // `load` changes only with boardId. /boards/:id reuses this instance across
  // boards, so a previous board's unavailable/error state must not carry over
  // into the next board's load (#2041).
  useEffect(() => {
    setUnavailable(false);
    setError(null);
    load();
  }, [load]);

  // Silent reload — re-fetches the full board without flashing the loading
  // skeleton.  Used by tab-focus reconciliation so the resync is invisible
  // to the user unless the board no longer exists or access was revoked.
  // Like `load`, it keeps the card writes that landed while it was in flight
  // (#2038, mergeFullSnapshot).
  const silentReload = useCallback(() => {
    const seq = ++fetchSeqRef.current;
    const touches = startFetchTouches();
    archivedCountGen.current += 1;
    getBoardFull(boardId)
      .then((b) => {
        if (seq !== fetchSeqRef.current) return;
        loadPendingRef.current = false;
        archivedCountGen.current += 1;
        lastFullAtRef.current = Date.now();
        setUnavailable(false);
        applyFullSnapshot(b, touches);
        if (touches.recountArchived) refreshArchivedCount(b.archived_card_count);
      })
      .catch((err) => {
        if (seq !== fetchSeqRef.current) return;
        if (fetchTouchesRef.current === touches) fetchTouchesRef.current = null;
        if (err?.response?.status === 404 || err?.response?.status === 403) {
          // Lost mid-session: same state as the initial load (#2041).
          setUnavailable(true);
        } else if (loadPendingRef.current) {
          // This resync superseded a `load` that never delivered state; retry
          // it rather than silently dropping the caller's refresh/rollback.
          load();
        }
        // Otherwise swallow silently — a background resync failure is not
        // worth surfacing to the user; the WS connection will recover it.
      })
      .finally(() => { if (seq === fetchSeqRef.current) setLoading(false); });
  }, [boardId, load, startFetchTouches, applyFullSnapshot, refreshArchivedCount]);

  const clearMoveError = useCallback(() => {
    setMoveError(null);
    setPendingMove(null);
  }, []);

  const moveCard = useCallback(async (
    cardId: number,
    columnId: number,
    swimlaneId: number,
    position: number
  ): Promise<MoveOutcome> => {
    if (!boardRef.current) return { ok: false, error: new Error("board not loaded") };

    // Optimistic update — capture the card's pre-move copy for rollback via
    // the ref so this callback does not depend on the `board` state value.
    const before = boardRef.current.cards.find((c) => c.id === cardId);
    const movedAt = new Date().toISOString();
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        cards: b.cards.map((c) =>
          c.id === cardId
            ? placeCardOptimistically(c, b.columns, { columnId, swimlaneId, position }, movedAt)
            : c
        ),
      };
    });

    // Send the card's version for optimistic concurrency control — the server
    // rejects the move if another user has modified the card since we last
    // fetched it.
    const cardVersion = boardRef.current.cards.find((c) => c.id === cardId)?.version;

    try {
      const { card } = await apiMoveCard(boardId, cardId, { column_id: columnId, swimlane_id: swimlaneId, position, version: cardVersion });
      // A socket frame for a later change (a remote edit, or another move) can
      // arrive before this response; keep that newer copy (#1969).
      const touches = fetchTouchesRef.current;
      setBoard((b) => {
        if (!b) return b;
        const cards = replaceCardUnlessStale(b.cards, card);
        if (cards === b.cards) return b;
        // Recorded only when applied: a copy #1969 dropped as stale must not
        // protect the card from the snapshot (#2038).
        touches?.written.add(card.id);
        return { ...b, cards };
      });
      // A stale "Move failed" / limit toast must not outlive a later success (#1761).
      clearMoveError();
      return { ok: true };
    } catch (err: unknown) {
      // Roll back the optimistic update, leaving frames that landed meanwhile.
      setBoard((b) => {
        if (!b) return b;
        const cards = rollbackMovedCard(b.cards, before);
        return cards === b.cards ? b : { ...b, cards };
      });
      // On 409, surface a structured error for the UI to display.
      let surfaced = false;
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      if (axiosErr?.response?.status === 403) {
        const data = axiosErr.response.data as { code?: string; detail?: string };
        surfaced = true; setMoveError({ code: "permission_denied", detail: data?.detail ?? "You do not have permission to move this card." });
      } else if (axiosErr?.response?.status === 404) {
        // The card or board is gone, or access to the board was lost: a
        // caller with no access gets 404, not 403. Reload so the board either
        // refreshes or, when it is no longer reachable, shows the unavailable page -
        // rather than the card silently snapping back.
        load();
      } else if (axiosErr?.response?.status === 503) {
        // The instance went read-only mid-drag (#783). Without this branch the
        // card silently snaps back with no explanation at all — the optimistic
        // update makes the move look like it succeeded right up until it
        // vanishes.
        const data = axiosErr.response.data as { code?: string; detail?: string };
        if (data?.code === "maintenance_mode") {
          surfaced = true; setMoveError({ code: "maintenance_mode", detail: data.detail ?? "Maintenance mode is active." });
        }
      } else if (axiosErr?.response?.status === 409) {
        const data = axiosErr.response.data as MoveBlockedError;
        if (data?.code === "version_conflict") {
          // Another user modified this card — reload the board to get fresh state.
          surfaced = true; setMoveError(data);
          load();
        } else if (data?.code && (SOFT_LIMIT_CODES.has(data.code) || HARD_LIMIT_CODES.has(data.code))) {
          const board = boardRef.current;
          const also = board ? otherTrippedLimits(board, before, columnId, swimlaneId, data.code) : [];
          surfaced = true; setMoveError(also.length > 0 ? { ...data, also } as MoveBlockedError : data);
          // Hard-blocked moves have no retry path — never set pendingMove.
          if (SOFT_LIMIT_CODES.has(data.code)) setPendingMove({ cardId, columnId, swimlaneId, position });
        }
      }
      // Every failure gets a visible message; the branches above only cover the
      // limit/permission/maintenance/conflict codes (#1761).
      if (!surfaced) {
        setMoveError(genericMoveFailure(err));
      }
      // Surface the failure to the caller (#1761). Drag-and-drop ignores it;
      // CardDetail uses it to roll back its local copy and name the cause.
      return { ok: false, error: err };
    }
  }, [boardId, load, clearMoveError]);

  // Admin-only: move a card with force=true, bypassing a soft WIP/weight limit.
  // Shared by the toast's override (forceMoveCard, which replays pendingMove)
  // and CardDetail's Move popover (forceMoveCardTo, which passes its own
  // target): the panel's backdrop and focus trap make the toast unreachable
  // while the panel is open, so the popover offers the override itself (#1772).
  // Like moveCard it never rejects; failures are reported in the result.
  const runForcedMove = useCallback(async (move: PendingMove): Promise<MoveOutcome> => {
    if (!boardRef.current) return { ok: false, error: new Error("board not loaded") };
    const { cardId, columnId, swimlaneId, position } = move;
    clearMoveError();

    const before = boardRef.current.cards.find((c) => c.id === cardId);
    const movedAt = new Date().toISOString();
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        cards: b.cards.map((c) =>
          c.id === cardId
            ? placeCardOptimistically(c, b.columns, { columnId, swimlaneId, position }, movedAt)
            : c
        ),
      };
    });

    try {
      const { card } = await apiMoveCard(boardId, cardId, { column_id: columnId, swimlane_id: swimlaneId, position }, true);
      // A socket frame for a later change (a remote edit, or another move) can
      // arrive before this response; keep that newer copy (#1969).
      const touches = fetchTouchesRef.current;
      setBoard((b) => {
        if (!b) return b;
        const cards = replaceCardUnlessStale(b.cards, card);
        if (cards === b.cards) return b;
        // Recorded only when applied: a copy #1969 dropped as stale must not
        // protect the card from the snapshot (#2038).
        touches?.written.add(card.id);
        return { ...b, cards };
      });
      return { ok: true };
    } catch (err: unknown) {
      setBoard((b) => {
        if (!b) return b;
        const cards = rollbackMovedCard(b.cards, before);
        return cards === b.cards ? b : { ...b, cards };
      });
      // Surface any structured error so the user knows the override failed
      // (e.g. a server error or unexpected 409) rather than silently reverting.
      // This generic pass-through already covers the maintenance_mode 503
      // (#783) — its body carries the same {code, detail} shape — so no
      // dedicated branch is added here. Reachable only in the narrow case where
      // maintenance mode is switched on between a blocked move and the
      // operator's override of it.
      const axiosErr = err as { response?: { status?: number; data?: unknown } };
      if (axiosErr?.response?.data) {
        const data = axiosErr.response.data as MoveBlockedError;
        if (data?.code && KNOWN_MOVE_ERROR_CODES.has(data.code)) {
          setMoveError(data);
          return { ok: false, error: err };
        }
      }
      // No structured body (network error, bare 5xx): still say so (#1761).
      setMoveError(genericMoveFailure(err));
      return { ok: false, error: err };
    }
  }, [boardId, clearMoveError]);

  // Retry the last blocked move (the toast's "Move anyway"). Takes no
  // arguments: App passes it straight to the toast's onClick.
  const forceMoveCard = useCallback(async () => {
    if (pendingMoveRef.current) await runForcedMove(pendingMoveRef.current);
  }, [runForcedMove]);

  // Force a move to an explicit target, independent of pendingMove (#1772).
  const forceMoveCardTo = useCallback(
    (cardId: number, columnId: number, swimlaneId: number, position: number): Promise<MoveOutcome> =>
      runForcedMove({ cardId, columnId, swimlaneId, position }),
    [runForcedMove],
  );

  // Every card writer below records into the in-flight fetch's set, read at
  // call time (#2038; see fetchTouchesRef).
  const addCard = useCallback((card: Card) => {
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      if (!b.cards.some((c) => c.id === card.id)) {
        touches?.written.add(card.id);
        return { ...b, cards: [...b.cards, card] };
      }
      // Already present (the create response and the card.created echo both
      // land here): an older copy must not replace a newer one (#1969), nor
      // count as a write for an in-flight fetch.
      const cards = replaceCardUnlessStale(b.cards, card);
      if (cards === b.cards) return b;
      touches?.written.add(card.id);
      return { ...b, cards };
    });
  }, []);

  const removeCard = useCallback((cardId: number) => {
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      const gone = b.cards.find((c) => c.id === cardId);
      if (gone) touches?.removed.set(gone.uid, false);
      return { ...b, cards: b.cards.filter((c) => c.id !== cardId) };
    });
  }, []);

  // Archive / unarchive keep BoardFull.archived_card_count current in-session,
  // because the settings modal's Danger Zone gates typed-name confirmation on
  // it (#1289) and /full/ only reports it at load time. Each updater only moves
  // the count when the card actually leaves or enters `cards`, so the local
  // handler and the echoed card.archived / card.unarchived socket event for
  // the same action never double-count, whichever lands first.
  //
  // `uid` is the frame's card_uid when the caller has one. A card.archived
  // frame for a card not on screen is still recorded for an in-flight fetch
  // (#2038): the snapshot may hold the card from before the archive, and must
  // not bring it back.
  const archiveCardWhere = useCallback((match: (c: Card) => boolean, uid?: string) => {
    archivedCountGen.current += 1;
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      if (uid !== undefined) touches?.removed.set(uid, true);
      const gone = b.cards.filter(match);
      if (gone.length === 0) return b;
      for (const c of gone) touches?.removed.set(c.uid, true);
      return {
        ...b,
        cards: b.cards.filter((c) => !match(c)),
        archived_card_count: (b.archived_card_count ?? 0) + 1,
      };
    });
  }, []);
  const archiveCard = useCallback((cardId: number) => archiveCardWhere((c) => c.id === cardId), [archiveCardWhere]);
  const archiveCardByUid = useCallback((cardUid: string) => archiveCardWhere((c) => c.uid === cardUid, cardUid), [archiveCardWhere]);

  const unarchiveCard = useCallback((card: Card) => {
    archivedCountGen.current += 1;
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      if (b.cards.some((c) => c.id === card.id)) {
        // A stale copy is dropped and, like everywhere, not recorded (#2038).
        const cards = replaceCardUnlessStale(b.cards, card);
        if (cards === b.cards) return b;
        touches?.written.add(card.id);
        return { ...b, cards };
      }
      touches?.written.add(card.id);
      return {
        ...b,
        cards: [...b.cards, card],
        archived_card_count: Math.max(0, (b.archived_card_count ?? 0) - 1),
      };
    });
  }, []);

  // Every non-card writer below goes through writeBoard (or writeBoardFrom),
  // so a `/full/` response replays it over its snapshot (#2130). Each write is
  // idempotent, since the snapshot may already contain it, and names what it
  // changes by id.
  const addColumn = useCallback((column: Column) => {
    writeBoard((b) => ({ ...b, columns: upsertById(b.columns, column) }));
  }, [writeBoard]);

  const removeColumn = useCallback(async (columnId: number) => {
    // Recorded although optimistic: a failure reloads, and that reload
    // supersedes any fetch this was recorded for, so the write is never
    // replayed over a snapshot when the server refused it.
    writeBoard((b) => withoutColumn(b, columnId));
    try {
      await apiDeleteColumn(boardId, columnId);
    } catch {
      // Re-fetch on failure so the column and its cards reappear.
      load();
      return;
    }
    // Do not rely on the socket echo to correct the archived count (#1637).
    refreshArchivedCount();
  }, [boardId, load, refreshArchivedCount, writeBoard]);

  const addSwimlane = useCallback((swimlane: Swimlane) => {
    // Shaped to the role of the board it is applied to, live or replayed over
    // a `/full/` snapshot (swimlaneForRole, #2147).
    writeBoard((b) => ({ ...b, swimlanes: upsertById(b.swimlanes, swimlaneForRole(swimlane, b)) }));
  }, [writeBoard]);

  const updateCard = useCallback((card: Card, siblingPositions?: readonly CardSiblingPosition[], eventId?: number) => {
    // Fed by card.updated and card.moved frames and by every HTTP card response
    // (CardDetail, CardItem, the bulk toolbar), which are not ordered against
    // each other: an older version must not replace a newer one (#1969).
    // dropUnknownLabels: a response/echo that lands after label.deleted must not
    // put the deleted label back on the card (#1888).
    //
    // `siblingPositions` is card.moved's `sibling_positions` (#1890), applied
    // in the same update so the cell never renders half-renumbered. A frame
    // from an older server has none, and only the card is applied, as before.
    // The pairs of a frame whose moved card is stale are dropped with it: a
    // later change to that card has already landed, and if it was another move
    // in the same cell, its frame already applied newer positions for the same
    // siblings at the same (unbumped) version, which these would undo.
    //
    // `eventId` is a card.moved frame's event_id. Versions cannot order two
    // frames that set one card's position at the same version (two moves of
    // different cards in its cell), so positionEventIds does: a pair, or the
    // moved card's own position, is not applied over a position a frame with a
    // higher event_id already set. Without an event_id (an older server, or an
    // HTTP response) nothing is compared or recorded: the pre-#1890 behavior.
    //
    // The updater reads and writes positionEventIds. It stays idempotent (it
    // only raises entries to the frame's own id, and compares with a strict
    // >), so React running it twice gives the same result.
    //
    // For an in-flight `/full/` fetch (#2038) it records the card when it is on
    // the board, and each sibling whose position this frame set.
    const ordered = typeof eventId === "number" && Number.isFinite(eventId);
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      const seen = positionEventIds.current;
      const newerThanFrame = (id: number) => ordered && (seen.get(id) ?? -Infinity) > eventId;
      const record = (id: number) => {
        if (ordered && !newerThanFrame(id)) seen.set(id, eventId);
      };
      const stored = b.cards.find((c) => c.id === card.id);
      const cardStale = isStaleCard(card, stored);
      const keepPosition = stored !== undefined && newerThanFrame(card.id);
      let cards = replaceCardUnlessStale(b.cards, card, (c) => {
        const prepared = dropUnknownLabels(c, b.labels);
        return keepPosition && stored ? { ...prepared, position: stored.position } : prepared;
      });
      if (!cardStale) record(card.id);
      // Only a copy that was applied counts as a write: a frame #1969 dropped
      // as stale must not protect a pre-fetch copy from the snapshot (#2038).
      if (stored && !cardStale) touches?.written.add(card.id);
      if (Array.isArray(siblingPositions) && siblingPositions.length > 0 && !cardStale) {
        const fresh = siblingPositions.filter((p) => typeof p?.id === "number" && !newerThanFrame(p.id));
        const before = cards;
        cards = applySiblingPositions(cards, fresh);
        for (const p of fresh) record(p.id);
        if (touches && cards !== before) {
          for (let i = 0; i < cards.length; i++) {
            if (cards[i] !== before[i]) touches.siblingPositions.add(cards[i].id);
          }
        }
      }
      return cards === b.cards ? b : { ...b, cards };
    });
  }, []);

  // A column.updated for a column the board does not hold (deleted, or never
  // received) changes nothing, here and when replayed.
  const updateColumn = useCallback((column: Column) => {
    writeBoard((b) => ({ ...b, columns: b.columns.map((c) => c.id === column.id ? column : c) }));
  }, [writeBoard]);

  // An upsert, not an append: replayed over a snapshot that already lists the
  // label (#2130), an append would show it twice.
  const addLabel = useCallback((label: Label) => {
    writeBoard((b) => ({ ...b, labels: upsertById(b.labels, label) }));
  }, [writeBoard]);

  const updateLabel = useCallback((label: Label) => {
    // The server broadcasts only the label on `label.updated`, so the copies
    // embedded in cards[*].labels would keep the old name/color (#1888).
    // Untouched cards keep their identity. Replayed over a `/full/` snapshot
    // (#2130), this also renames the copies on the snapshot's cards.
    writeBoard((b) => ({
      ...b,
      labels: b.labels.map((l) => l.id === label.id ? label : l),
      cards: b.cards.map((c) => c.labels.some((l) => l.id === label.id)
        ? { ...c, labels: c.labels.map((l) => l.id === label.id ? label : l) }
        : c),
    }));
  }, [writeBoard]);

  const removeLabel = useCallback((labelUid: string) => {
    // The server drops the card<->label M2M rows silently and broadcasts only
    // `label.deleted` (no per-card `card.updated`), so strip the label from
    // every local card too (#1888); CardItem renders card.labels unfiltered.
    // Cards not holding the label keep their identity so memo'd CardItems
    // do not re-render. Replayed over a `/full/` snapshot (#2130), this also
    // strips it from the snapshot's cards.
    writeBoard((b) => ({
      ...b,
      labels: b.labels.filter((l) => l.uid !== labelUid),
      cards: b.cards.map((c) => c.labels.some((l) => l.uid === labelUid)
        ? { ...c, labels: c.labels.filter((l) => l.uid !== labelUid) }
        : c),
    }));
  }, [writeBoard]);

  // Custom fields (#371) — one wholesale-replace setter rather than granular
  // add/update/remove mutators like labels above. Callers pass either the full
  // resulting array (the Fields tab's local mutations, `custom_field.reordered`)
  // or an updater `(prev) => next` (the `custom_field.created/updated/deleted`
  // WS events in BoardView, #1970). The updater runs inside `setBoard`, so it
  // sees the latest state even when frames arrive before a re-render.
  const applyCustomFieldDefinitions = useCallback((definitions: CustomFieldDefinition[] | ((prev: CustomFieldDefinition[]) => CustomFieldDefinition[])) => {
    // Updater form (#1970): socket frames can land before React re-renders, so
    // a caller building the next array from render-captured state would
    // overwrite a previous frame's change. Replayed over a `/full/` snapshot
    // (#2130), the updater runs against the snapshot's list, so BoardView's
    // `custom_field.created` updater is an upsert. A whole list (the Fields
    // tab, `custom_field.reordered`) is replayed as what it changed
    // (listChange), so it cannot erase a definition the snapshot holds.
    if (typeof definitions === 'function') {
      writeBoard((b) => ({ ...b, custom_field_definitions: definitions(b.custom_field_definitions) }));
      return;
    }
    writeBoardFrom((live) => {
      const change = listChange(live.custom_field_definitions, definitions);
      return (b) => ({ ...b, custom_field_definitions: change(b.custom_field_definitions) });
    });
  }, [writeBoard, writeBoardFrom]);

  // Row field schema (#1140) — exactly parallel to the card version above,
  // and separate because the two are independent per-board schemas.
  const applySwimlaneFieldDefinitions = useCallback((definitions: SwimlaneCustomFieldDefinition[] | ((prev: SwimlaneCustomFieldDefinition[]) => SwimlaneCustomFieldDefinition[])) => {
    if (typeof definitions === 'function') {
      writeBoard((b) => ({ ...b, swimlane_custom_field_definitions: definitions(b.swimlane_custom_field_definitions) }));
      return;
    }
    writeBoardFrom((live) => {
      const change = listChange(live.swimlane_custom_field_definitions, definitions);
      return (b) => ({ ...b, swimlane_custom_field_definitions: change(b.swimlane_custom_field_definitions) });
    });
  }, [writeBoard, writeBoardFrom]);

  // Member rows merge with mergeMemberRow, so a frame replayed over a `/full/`
  // snapshot (#2130) keeps the snapshot's is_site_admin and all-content flags.
  const addMember = useCallback((membership: BoardMembership) => {
    writeBoard((b) => {
      const exists = b.members.some((m) => m.user.id === membership.user.id);
      return exists
        ? { ...b, members: b.members.map((m) => m.user.id === membership.user.id ? mergeMemberRow(m, membership) : m) }
        : { ...b, members: [...b.members, membership] };
    });
  }, [writeBoard]);

  const updateMember = useCallback((membership: BoardMembership) => {
    writeBoard((b) => ({ ...b, members: b.members.map((m) => m.user.id === membership.user.id ? mergeMemberRow(m, membership) : m) }));
  }, [writeBoard]);

  const removeMember = useCallback((userId: number) => {
    // Removing a membership does not remove an all-content user's access
    // (#1301): keep them listed with no membership row. A later re-read lists
    // them again only for a reader who sees the all-content roster, or when
    // they are also inherited from the board's group or the owner.
    writeBoard((b) => ({
      ...b,
      members: b.members.flatMap((m): EffectiveBoardMember[] => {
        if (m.user.id !== userId) return [m];
        return m.has_all_content_access
          ? [{ ...m, id: null, role: "site_admin", has_all_content_access: true }]
          : [];
      }),
    }));
  }, [writeBoard]);

  // A whole column or swimlane list: a column.reordered / swimlane.reordered
  // frame, or a reorder response. Replayed as what it changed (listChange,
  // #2130), so it cannot erase a column or swimlane the snapshot holds.
  const writeColumnList = useCallback((columns: Column[]) => {
    writeBoardFrom((live) => {
      const change = listChange(live.columns, columns);
      return (b) => ({ ...b, columns: change(b.columns) });
    });
  }, [writeBoardFrom]);
  const writeSwimlaneList = useCallback((swimlanes: Swimlane[]) => {
    writeBoardFrom((live) => {
      const change = listChange(live.swimlanes, swimlanes);
      return (b) => ({ ...b, swimlanes: change(b.swimlanes) });
    });
  }, [writeBoardFrom]);

  const applyColumnOrder = useCallback((columns: Column[]) => {
    writeColumnList(columns);
  }, [writeColumnList]);

  const applySwimlaneOrder = useCallback((swimlanes: Swimlane[]) => {
    writeSwimlaneList(swimlanes);
  }, [writeSwimlaneList]);

  const reorderColumns = useCallback(async (orderedIds: number[]) => {
    if (!boardRef.current) return;
    const prev = boardRef.current.columns;
    const retract = writeBoard((b) => ({ ...b, columns: orderByIds(b.columns, orderedIds) }));
    try {
      // An HTTP response is not ordered against frames: applied as what it
      // changed (listChange), it cannot drop a column created meanwhile.
      writeColumnList(await apiReorderColumns(boardId, orderedIds));
    } catch {
      // This failure rolls back without a reload, so the optimistic order
      // must not be replayed over an in-flight fetch's snapshot (#2130),
      // which holds the order the server kept.
      retract();
      setBoard((b) => b ? { ...b, columns: prev } : b);
    }
  }, [boardId, writeBoard, writeColumnList]);


  const reorderSwimlanes = useCallback(async (orderedIds: number[]) => {
    if (!boardRef.current) return;
    // Recorded although optimistic: a failure reloads (below), superseding
    // any fetch this was recorded for (#2130).
    writeBoard((b) => ({ ...b, swimlanes: orderByIds(b.swimlanes, orderedIds) }));
    try {
      writeSwimlaneList(await apiReorderSwimlanes(boardId, orderedIds));
    } catch {
      // Re-fetch on failure rather than rolling back to a stale snapshot.
      // A stale snapshot (captured before addSwimlane ran) would drop any
      // swimlane added in the same batch, even though it was persisted.
      load();
    }
  }, [boardId, load, writeBoard, writeSwimlaneList]);

  /**
   * Replace one swimlane wholesale. Callers handling a `swimlane.updated`
   * *broadcast* must pass a payload already merged through
   * `mergeSwimlaneFromBroadcast` — the broadcast is built from the public
   * serializer and would otherwise blank an admin's contact_email, notes, and
   * admin-only field values (#1140).
   */
  const updateSwimlane = useCallback((swimlane: Swimlane | ((board: BoardFull) => Swimlane)) => {
    // Resolver form (#1970): the socket handler derives the merged swimlane
    // from the latest board state, not a render-captured copy. Replayed over a
    // `/full/` snapshot (#2130), it resolves against the snapshot's copy.
    // Both forms are then shaped to the role of the board they are applied to
    // (swimlaneForRole, #2147): the object form is an HTTP response shaped by
    // the role the request was made under, which a replayed snapshot's role
    // need not match.
    writeBoard((b) => {
      const next = swimlaneForRole(typeof swimlane === 'function' ? swimlane(b) : swimlane, b);
      return { ...b, swimlanes: b.swimlanes.map((s) => s.id === next.id ? next : s) };
    });
  }, [writeBoard]);

  const removeSwimlane = useCallback(async (swimlaneId: number) => {
    // Recorded although optimistic: a failure reloads, superseding any fetch
    // this was recorded for (#2130), as in removeColumn.
    writeBoard((b) => withoutSwimlane(b, swimlaneId));
    try {
      await apiDeleteSwimlane(boardId, swimlaneId);
    } catch {
      load();
      return;
    }
    refreshArchivedCount();
  }, [boardId, load, refreshArchivedCount, writeBoard]);

  // Pure state-only helpers for WebSocket receive path — these update local
  // state without firing API calls, preventing redundant round-trips when
  // another client's mutation is broadcast to all connected clients.
  //
  // The frame names the column by uid. Replayed over a `/full/` snapshot
  // (#2130), the uid is looked up in the snapshot, so a column this client
  // never received is still removed, with its cards.
  const evictColumn = useCallback((columnUid: string) => {
    writeBoard((b) => {
      const col = b.columns.find((c) => c.uid === columnUid);
      return col ? withoutColumn(b, col.id) : b;
    });
    refreshArchivedCount();
  }, [refreshArchivedCount, writeBoard]);

  const evictSwimlane = useCallback((swimlaneUid: string) => {
    writeBoard((b) => {
      const sl = b.swimlanes.find((s) => s.uid === swimlaneUid);
      return sl ? withoutSwimlane(b, sl.id) : b;
    });
    refreshArchivedCount();
  }, [refreshArchivedCount, writeBoard]);

  // card.deleted. Recorded for an in-flight fetch even when the card is not on
  // screen, so a snapshot read before the delete cannot bring it back (#2038).
  const evictCardByUid = useCallback((cardUid: string) => {
    const touches = fetchTouchesRef.current;
    setBoard((b) => {
      if (!b) return b;
      touches?.removed.set(cardUid, false);
      return { ...b, cards: b.cards.filter((c) => c.uid !== cardUid) };
    });
  }, []);

  const mergeBoardState = useCallback((patch: Partial<BoardFull>) => {
    // archived_card_count is deliberately NOT merged (#1289). board.updated
    // payloads are full BoardSerializer snapshots taken at emit time, so one
    // that lands after a local archive would overwrite the incremented count
    // with the older, lower value — and the later card.archived echo cannot
    // re-add it because the card has already left `cards`. A low count lets
    // the Danger Zone skip typed confirmation. Taking max(local, payload)
    // instead would go wrong the other way after an unarchive (a stale
    // snapshot would re-raise the count). The archive/unarchive handlers and
    // refreshArchivedCount (guarded by archivedCountGen against being overtaken
    // by them or by a reload) are therefore the only in-session writers; a full
    // reload re-seeds it.
    //
    // Fed by board.updated, share_link.updated, board.star_changed, the
    // viewer's own role change and HTTP responses (health status, the Sharing
    // tab), all replayed over an in-flight `/full/` snapshot (#2130).
    //
    // A role change also reshapes the swimlanes already held (swimlaneForRole,
    // #2147), so they match the new role without waiting for the reload
    // BoardView starts on a self role change, including when that reload fails.
    const { archived_card_count: _ignored, ...rest } = patch;
    writeBoard((b) => {
      const next = { ...b, ...rest };
      if (!('current_user_role' in rest)) return next;
      return { ...next, swimlanes: next.swimlanes.map((s) => swimlaneForRole(s, next)) };
    });
  }, [writeBoard]);

  const updateBoardSettings = useCallback(async (patch: Record<string, unknown>) => {
    if (!boardRef.current) return;
    // Recorded although optimistic: a failure reloads, superseding any fetch
    // this was recorded for (#2130).
    writeBoard((b) => ({ ...b, ...patch }));
    try {
      await apiPatchBoard(boardId, patch);
    } catch {
      // Reload fresh state on failure
      load();
    }
  }, [boardId, load, writeBoard]);

  return { board, loading, error, unavailable, reload: load, silentReload, getLastFullFetchAt, moveCard, forceMoveCard, forceMoveCardTo, moveError, clearMoveError, addCard, removeCard, archiveCard, archiveCardByUid, unarchiveCard, addColumn, removeColumn, addSwimlane, updateCard, updateColumn, addLabel, updateLabel, removeLabel, applyCustomFieldDefinitions, applySwimlaneFieldDefinitions, addMember, updateMember, removeMember, applyColumnOrder, applySwimlaneOrder, reorderColumns, reorderSwimlanes, updateSwimlane, removeSwimlane, updateBoardSettings, evictColumn, evictSwimlane, evictCardByUid, mergeBoardState };
}
