import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getBoardFull, patchBoard as apiPatchBoard, reorderColumns as apiReorderColumns, reorderSwimlanes as apiReorderSwimlanes, deleteSwimlane as apiDeleteSwimlane, deleteColumn as apiDeleteColumn } from "../api/boards";
import { moveCard as apiMoveCard, getArchivedCards } from "../api/cards";
import { failureReason } from "../utils/moveFailure";
import { placementVerdict, pruneLaneLimitColumn, trippedLimitSentence } from "../utils/placementLimits";
import { dropUnknownLabels } from "../utils/cardLabels";
import { isStaleCard } from "../utils/cardVersion";
import type { BoardFull, BoardMembership, Card, EffectiveBoardMember, Column, Swimlane, Label, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from "../types";

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
  if ("is_site_admin" in incoming || prev.is_site_admin === undefined) return incoming;
  return { ...incoming, is_site_admin: prev.is_site_admin };
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
 * still replace every card with whatever the server returned (#2038).
 */
function replaceCardUnlessStale(cards: Card[], incoming: Card, prepare: (c: Card) => Card = (c) => c): Card[] {
  const i = cards.findIndex((c) => c.id === incoming.id);
  if (i === -1 || isStaleCard(incoming, cards[i])) return cards;
  const next = cards.slice();
  next[i] = prepare(incoming);
  return next;
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
  next[i] = { ...cards[i], column: before.column, swimlane: before.swimlane, position: before.position };
  return next;
}

export function useBoard() {
  const { id } = useParams<{ id: string }>();
  const boardId = Number(id);
  const navigate = useNavigate();
  const [board, setBoard] = useState<BoardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const load = useCallback(() => {
    setLoading(true);
    const seq = ++fetchSeqRef.current;
    loadPendingRef.current = true;
    getBoardFull(boardId)
      .then((b) => {
        if (seq !== fetchSeqRef.current) return;
        loadPendingRef.current = false;
        setBoard(b);
      })
      .catch((err) => {
        // A superseded failure must not surface: the newer request owns state.
        if (seq !== fetchSeqRef.current) return;
        loadPendingRef.current = false;
        if (err?.response?.status === 404 || err?.response?.status === 403) {
          // Board doesn't exist or user lost access — go back to dashboard.
          // Fire-and-forget: the declarative router resolves navigate()
          // synchronously, and any failure is handled by its own error boundary.
          void navigate("/", { replace: true });
        } else {
          setError("Failed to load board");
        }
      })
      // Only the latest request clears `loading`; a superseded load is skipped,
      // and its superseder (load or silentReload) clears it when it settles, so
      // loading can never stay stuck true.
      .finally(() => { if (seq === fetchSeqRef.current) setLoading(false); });
  }, [boardId, navigate]);

  useEffect(() => { load(); }, [load]);

  // Silent reload — re-fetches the full board without flashing the loading
  // skeleton.  Used by tab-focus reconciliation so the resync is invisible
  // to the user unless the board no longer exists or access was revoked.
  const silentReload = useCallback(() => {
    const seq = ++fetchSeqRef.current;
    getBoardFull(boardId)
      .then((b) => {
        if (seq !== fetchSeqRef.current) return;
        loadPendingRef.current = false;
        setBoard(b);
      })
      .catch((err) => {
        if (seq !== fetchSeqRef.current) return;
        if (err?.response?.status === 404 || err?.response?.status === 403) {
          // See the `load` catch above re: fire-and-forget navigate().
          void navigate("/", { replace: true });
        } else if (loadPendingRef.current) {
          // This resync superseded a `load` that never delivered state; retry
          // it rather than silently dropping the caller's refresh/rollback.
          load();
        }
        // Otherwise swallow silently — a background resync failure is not
        // worth surfacing to the user; the WS connection will recover it.
      })
      .finally(() => { if (seq === fetchSeqRef.current) setLoading(false); });
  }, [boardId, navigate, load]);

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
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        cards: b.cards.map((c) =>
          c.id === cardId
            ? { ...c, column: columnId, swimlane: swimlaneId, position }
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
      setBoard((b) => {
        if (!b) return b;
        const cards = replaceCardUnlessStale(b.cards, card);
        return cards === b.cards ? b : { ...b, cards };
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
        // refreshes or, when it is no longer reachable, navigates away —
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
    setBoard((b) => {
      if (!b) return b;
      return {
        ...b,
        cards: b.cards.map((c) =>
          c.id === cardId
            ? { ...c, column: columnId, swimlane: swimlaneId, position }
            : c
        ),
      };
    });

    try {
      const { card } = await apiMoveCard(boardId, cardId, { column_id: columnId, swimlane_id: swimlaneId, position }, true);
      // A socket frame for a later change (a remote edit, or another move) can
      // arrive before this response; keep that newer copy (#1969).
      setBoard((b) => {
        if (!b) return b;
        const cards = replaceCardUnlessStale(b.cards, card);
        return cards === b.cards ? b : { ...b, cards };
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

  const addCard = useCallback((card: Card) => {
    setBoard((b) => {
      if (!b) return b;
      if (!b.cards.some((c) => c.id === card.id)) return { ...b, cards: [...b.cards, card] };
      // Already present (the create response and the card.created echo both
      // land here): an older copy must not replace a newer one (#1969).
      const cards = replaceCardUnlessStale(b.cards, card);
      return cards === b.cards ? b : { ...b, cards };
    });
  }, []);

  const removeCard = useCallback((cardId: number) => {
    setBoard((b) => b ? { ...b, cards: b.cards.filter((c) => c.id !== cardId) } : b);
  }, []);

  // Archive / unarchive keep BoardFull.archived_card_count current in-session,
  // because the settings modal's Danger Zone gates typed-name confirmation on
  // it (#1289) and /full/ only reports it at load time. Each updater only moves
  // the count when the card actually leaves or enters `cards`, so the local
  // handler and the echoed card.archived / card.unarchived socket event for
  // the same action never double-count, whichever lands first.
  const archiveCardWhere = useCallback((match: (c: Card) => boolean) => {
    setBoard((b) => {
      if (!b || !b.cards.some(match)) return b;
      return {
        ...b,
        cards: b.cards.filter((c) => !match(c)),
        archived_card_count: (b.archived_card_count ?? 0) + 1,
      };
    });
  }, []);
  const archiveCard = useCallback((cardId: number) => archiveCardWhere((c) => c.id === cardId), [archiveCardWhere]);
  const archiveCardByUid = useCallback((cardUid: string) => archiveCardWhere((c) => c.uid === cardUid), [archiveCardWhere]);

  const unarchiveCard = useCallback((card: Card) => {
    setBoard((b) => {
      if (!b) return b;
      if (b.cards.some((c) => c.id === card.id)) {
        const cards = replaceCardUnlessStale(b.cards, card);
        return cards === b.cards ? b : { ...b, cards };
      }
      return {
        ...b,
        cards: [...b.cards, card],
        archived_card_count: Math.max(0, (b.archived_card_count ?? 0) - 1),
      };
    });
  }, []);

  const addColumn = useCallback((column: Column) => {
    setBoard((b) => {
      if (!b) return b;
      const exists = b.columns.some((c) => c.id === column.id);
      return exists
        ? { ...b, columns: b.columns.map((c) => (c.id === column.id ? column : c)) }
        : { ...b, columns: [...b.columns, column] };
    });
  }, []);

  const removeColumn = useCallback(async (columnId: number) => {
    setBoard((b) => b ? {
      ...b,
      columns: b.columns.filter((c) => c.id !== columnId),
      cards: b.cards.filter((c) => c.column !== columnId),
      swimlanes: pruneLaneLimitColumn(b.swimlanes, columnId),
    } : b);
    try {
      await apiDeleteColumn(boardId, columnId);
    } catch {
      // Re-fetch on failure so the column and its cards reappear.
      load();
    }
  }, [boardId, load]);

  const addSwimlane = useCallback((swimlane: Swimlane) => {
    setBoard((b) => {
      if (!b) return b;
      const exists = b.swimlanes.some((s) => s.id === swimlane.id);
      return exists
        ? { ...b, swimlanes: b.swimlanes.map((s) => (s.id === swimlane.id ? swimlane : s)) }
        : { ...b, swimlanes: [...b.swimlanes, swimlane] };
    });
  }, []);

  const updateCard = useCallback((card: Card) => {
    // Fed by card.updated and card.moved frames and by every HTTP card response
    // (CardDetail, CardItem, the bulk toolbar), which are not ordered against
    // each other: an older version must not replace a newer one (#1969).
    // dropUnknownLabels: a response/echo that lands after label.deleted must not
    // put the deleted label back on the card (#1888).
    setBoard((b) => {
      if (!b) return b;
      const cards = replaceCardUnlessStale(b.cards, card, (c) => dropUnknownLabels(c, b.labels));
      return cards === b.cards ? b : { ...b, cards };
    });
  }, []);

  const updateColumn = useCallback((column: Column) => {
    setBoard((b) => b ? { ...b, columns: b.columns.map((c) => c.id === column.id ? column : c) } : b);
  }, []);

  const addLabel = useCallback((label: Label) => {
    setBoard((b) => b ? { ...b, labels: [...b.labels, label] } : b);
  }, []);

  const updateLabel = useCallback((label: Label) => {
    // The server broadcasts only the label on `label.updated`, so the copies
    // embedded in cards[*].labels would keep the old name/color (#1888).
    // Untouched cards keep their identity.
    setBoard((b) => b ? {
      ...b,
      labels: b.labels.map((l) => l.id === label.id ? label : l),
      cards: b.cards.map((c) => c.labels.some((l) => l.id === label.id)
        ? { ...c, labels: c.labels.map((l) => l.id === label.id ? label : l) }
        : c),
    } : b);
  }, []);

  const removeLabel = useCallback((labelUid: string) => {
    // The server drops the card<->label M2M rows silently and broadcasts only
    // `label.deleted` (no per-card `card.updated`), so strip the label from
    // every local card too (#1888); CardItem renders card.labels unfiltered.
    // Cards not holding the label keep their identity so memo'd CardItems
    // do not re-render.
    setBoard((b) => b ? {
      ...b,
      labels: b.labels.filter((l) => l.uid !== labelUid),
      cards: b.cards.map((c) => c.labels.some((l) => l.uid === labelUid)
        ? { ...c, labels: c.labels.filter((l) => l.uid !== labelUid) }
        : c),
    } : b);
  }, []);

  // Custom fields (#371) — one wholesale-replace setter rather than granular
  // add/update/remove mutators like labels above. Every caller (the Fields
  // tab's local mutations, and each `custom_field.*` WS event handled in
  // BoardView) already computes the full resulting array before calling
  // this, so there's no delta-application logic to duplicate per call site.
  const applyCustomFieldDefinitions = useCallback((definitions: CustomFieldDefinition[]) => {
    setBoard((b) => b ? { ...b, custom_field_definitions: definitions } : b);
  }, []);

  // Row field schema (#1140) — exactly parallel to the card version above,
  // and separate because the two are independent per-board schemas.
  const applySwimlaneFieldDefinitions = useCallback((definitions: SwimlaneCustomFieldDefinition[]) => {
    setBoard((b) => b ? { ...b, swimlane_custom_field_definitions: definitions } : b);
  }, []);

  const addMember = useCallback((membership: BoardMembership) => {
    setBoard((b) => {
      if (!b) return b;
      const exists = b.members.some((m) => m.user.id === membership.user.id);
      return exists
        ? { ...b, members: b.members.map((m) => m.user.id === membership.user.id ? mergeMemberRow(m, membership) : m) }
        : { ...b, members: [...b.members, membership] };
    });
  }, []);

  const updateMember = useCallback((membership: BoardMembership) => {
    setBoard((b) => b ? { ...b, members: b.members.map((m) => m.user.id === membership.user.id ? mergeMemberRow(m, membership) : m) } : b);
  }, []);

  const removeMember = useCallback((userId: number) => {
    setBoard((b) => b ? { ...b, members: b.members.filter((m) => m.user.id !== userId) } : b);
  }, []);

  const applyColumnOrder = useCallback((columns: Column[]) => {
    setBoard((b) => b ? { ...b, columns } : b);
  }, []);

  const applySwimlaneOrder = useCallback((swimlanes: Swimlane[]) => {
    setBoard((b) => b ? { ...b, swimlanes } : b);
  }, []);

  const reorderColumns = useCallback(async (orderedIds: number[]) => {
    if (!boardRef.current) return;
    const prev = boardRef.current.columns;
    setBoard((b) => {
      if (!b) return b;
      const map = new Map(b.columns.map((c) => [c.id, c]));
      return { ...b, columns: orderedIds.map((id) => map.get(id)!).filter(Boolean) };
    });
    try {
      const updated = await apiReorderColumns(boardId, orderedIds);
      setBoard((b) => b ? { ...b, columns: updated } : b);
    } catch {
      setBoard((b) => b ? { ...b, columns: prev } : b);
    }
  }, [boardId]);


  const reorderSwimlanes = useCallback(async (orderedIds: number[]) => {
    if (!boardRef.current) return;
    setBoard((b) => {
      if (!b) return b;
      const map = new Map(b.swimlanes.map((s) => [s.id, s]));
      return { ...b, swimlanes: orderedIds.map((id) => map.get(id)!).filter(Boolean) };
    });
    try {
      const updated = await apiReorderSwimlanes(boardId, orderedIds);
      setBoard((b) => b ? { ...b, swimlanes: updated } : b);
    } catch {
      // Re-fetch on failure rather than rolling back to a stale snapshot.
      // A stale snapshot (captured before addSwimlane ran) would drop any
      // swimlane added in the same batch, even though it was persisted.
      load();
    }
  }, [boardId, load]);

  /**
   * Replace one swimlane wholesale. Callers handling a `swimlane.updated`
   * *broadcast* must pass a payload already merged through
   * `mergeSwimlaneFromBroadcast` — the broadcast is built from the public
   * serializer and would otherwise blank an admin's contact_email, notes, and
   * admin-only field values (#1140).
   */
  const updateSwimlane = useCallback((swimlane: Swimlane) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.map((s) => s.id === swimlane.id ? swimlane : s) } : b);
  }, []);

  const removeSwimlane = useCallback(async (swimlaneId: number) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.filter((s) => s.id !== swimlaneId), cards: b.cards.filter((c) => c.swimlane !== swimlaneId) } : b);
    try {
      await apiDeleteSwimlane(boardId, swimlaneId);
    } catch {
      load();
    }
  }, [boardId, load]);

  // Pure state-only helpers for WebSocket receive path — these update local
  // state without firing API calls, preventing redundant round-trips when
  // another client's mutation is broadcast to all connected clients.
  // Deleting a column or swimlane cascades to its archived cards, which the
  // client never holds (they are paged in only by ArchivedCardsPanel) and the
  // *.deleted event does not say how many there were (#1637). Guessing would
  // either under-count, which lets the Danger Zone skip typed confirmation, or
  // keep the stale overstated count. Ask the server for the authoritative
  // count instead; it is one cheap page-0 request and only needed when the
  // board had archived cards at all.
  const refreshArchivedCount = useCallback(() => {
    if (!(boardRef.current?.archived_card_count)) return;
    getArchivedCards(boardId, 0)
      .then((page) => {
        setBoard((b) => b ? { ...b, archived_card_count: page.count } : b);
      })
      .catch(() => {
        // Keep the previous count: it can only overstate, the safe direction.
      });
  }, [boardId]);

  const evictColumn = useCallback((columnUid: string) => {
    setBoard((b) => {
      if (!b) return b;
      const col = b.columns.find((c) => c.uid === columnUid);
      return {
        ...b,
        columns: b.columns.filter((c) => c.uid !== columnUid),
        cards: col ? b.cards.filter((c) => c.column !== col.id) : b.cards,
        swimlanes: col ? pruneLaneLimitColumn(b.swimlanes, col.id) : b.swimlanes,
      };
    });
    refreshArchivedCount();
  }, [refreshArchivedCount]);

  const evictSwimlane = useCallback((swimlaneUid: string) => {
    setBoard((b) => {
      if (!b) return b;
      const sl = b.swimlanes.find((s) => s.uid === swimlaneUid);
      return {
        ...b,
        swimlanes: b.swimlanes.filter((s) => s.uid !== swimlaneUid),
        cards: sl ? b.cards.filter((c) => c.swimlane !== sl.id) : b.cards,
      };
    });
    refreshArchivedCount();
  }, [refreshArchivedCount]);

  const evictCardByUid = useCallback((cardUid: string) => {
    setBoard((b) => b ? { ...b, cards: b.cards.filter((c) => c.uid !== cardUid) } : b);
  }, []);

  const mergeBoardState = useCallback((patch: Partial<BoardFull>) => {
    // archived_card_count is deliberately NOT merged (#1289). board.updated
    // payloads are full BoardSerializer snapshots taken at emit time, so one
    // that lands after a local archive would overwrite the incremented count
    // with the older, lower value — and the later card.archived echo cannot
    // re-add it because the card has already left `cards`. A low count lets
    // the Danger Zone skip typed confirmation. Taking max(local, payload)
    // instead would go wrong the other way after an unarchive (a stale
    // snapshot would re-raise the count). The archive/unarchive handlers are
    // therefore the sole in-session authority; a full reload re-seeds it.
    const { archived_card_count: _ignored, ...rest } = patch;
    setBoard((b) => b ? { ...b, ...rest } : b);
  }, []);

  const updateBoardSettings = useCallback(async (patch: Record<string, unknown>) => {
    if (!boardRef.current) return;
    setBoard((b) => b ? { ...b, ...patch } : b);
    try {
      await apiPatchBoard(boardId, patch);
    } catch {
      // Reload fresh state on failure
      load();
    }
  }, [boardId, load]);

  return { board, loading, error, reload: load, silentReload, moveCard, forceMoveCard, forceMoveCardTo, moveError, clearMoveError, addCard, removeCard, archiveCard, archiveCardByUid, unarchiveCard, addColumn, removeColumn, addSwimlane, updateCard, updateColumn, addLabel, updateLabel, removeLabel, applyCustomFieldDefinitions, applySwimlaneFieldDefinitions, addMember, updateMember, removeMember, applyColumnOrder, applySwimlaneOrder, reorderColumns, reorderSwimlanes, updateSwimlane, removeSwimlane, updateBoardSettings, evictColumn, evictSwimlane, evictCardByUid, mergeBoardState };
}
