import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useBoard } from "../hooks/useBoard";
import type { MoveBlockedError, MoveOutcome } from "../hooks/useBoard";
import type { CardChildrenRollup, BoardFull, BoardMembership, Card, CardParent, CardSiblingPosition, Column, Swimlane, Label, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from "../types";
import type { CardPlannedFields } from "../utils/plannedFields";

export interface BoardContextType {
  board: BoardFull | null;
  loading: boolean;
  error: string | null;
  /** Board is deleted or inaccessible (404/403, #2041). */
  unavailable?: boolean;
  reload: () => void;
  silentReload: () => void;
  /**
   * When the latest `/full/` response was applied (Date.now()), or null before
   * the first. BoardView reads it on the socket's first open to decide whether
   * the load-to-connect gap was long enough to need a resync (#1968). Optional
   * so test fixtures need not provide it; BoardView treats a missing value as
   * unknown and resyncs.
   */
  getLastFullFetchAt?: () => number | null;
  /** `gatesPassed` (#1102): the target sub-column of a gated stage; omitted = server default. */
  moveCard: (cardId: number, columnId: number, swimlaneId: number, position: number, gatesPassed?: number) => Promise<MoveOutcome>;
  forceMoveCard: (reason?: string) => Promise<MoveOutcome | void>;
  forceMoveCardTo: (cardId: number, columnId: number, swimlaneId: number, position: number, gatesPassed?: number, reason?: string) => Promise<MoveOutcome>;
  /** The card of the refused move `forceMoveCard` would replay (#1923). */
  pendingMoveCardId?: number | null;
  moveError: MoveBlockedError | null;
  clearMoveError: () => void;
  addCard: (card: Card) => void;
  removeCard: (cardId: number) => void;
  archiveCard: (cardId: number) => void;
  archiveCardByUid: (cardUid: string) => void;
  unarchiveCard: (card: Card) => void;
  addColumn: (column: Column) => void;
  removeColumn: (columnId: number) => Promise<void>;
  addSwimlane: (swimlane: Swimlane) => void;
  /**
   * `siblingPositions`: card.moved's `sibling_positions` (#1890), applied with
   * the card. `eventId`: that frame's `event_id`, which orders frames that set
   * one card's position at the same version.
   */
  updateCard: (card: Card, siblingPositions?: readonly CardSiblingPosition[], eventId?: number) => void;
  updateColumn: (column: Column) => void;
  addLabel: (label: Label) => void;
  updateLabel: (label: Label) => void;
  removeLabel: (labelUid: string) => void;
  applyCustomFieldDefinitions: (definitions: CustomFieldDefinition[] | ((prev: CustomFieldDefinition[]) => CustomFieldDefinition[])) => void;
  applySwimlaneFieldDefinitions: (definitions: SwimlaneCustomFieldDefinition[] | ((prev: SwimlaneCustomFieldDefinition[]) => SwimlaneCustomFieldDefinition[])) => void;
  addMember: (membership: BoardMembership) => void;
  updateMember: (membership: BoardMembership) => void;
  removeMember: (userId: number) => void;
  applyColumnOrder: (columns: Column[]) => void;
  applySwimlaneOrder: (swimlanes: Swimlane[]) => void;
  reorderColumns: (orderedIds: number[]) => Promise<void>;
  reorderSwimlanes: (orderedIds: number[]) => Promise<void>;
  updateSwimlane: (swimlane: Swimlane | ((board: BoardFull) => Swimlane)) => void;
  removeSwimlane: (swimlaneId: number) => Promise<void>;
  /** Resolves with the error on failure, null on success (#1104). */
  updateBoardSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  evictColumn: (columnUid: string) => void;
  evictSwimlane: (swimlaneUid: string) => void;
  evictCardByUid: (cardUid: string) => void;
  mergeBoardState: (patch: Partial<BoardFull>) => void;
  /** Set only `parent` (and, when given, the planned fields, #2371) on the given cards: the `card.parent_changed` re-read (#1104). */
  applyCardParents: (parents: ReadonlyMap<number, CardParent | null>, planned?: ReadonlyMap<number, CardPlannedFields>) => void;
  /** Set only `children_rollup` on the given cards: the `card.children_changed` re-read (#2210). */
  /** `null` drops a card's rollup (#2446: a leftover parent lost its last child). */
  applyCardChildrenRollups: (rollups: ReadonlyMap<number, CardChildrenRollup | null>) => void;
}

const BoardContext = createContext<BoardContextType | null>(null);

export function BoardProvider({ children }: { children: ReactNode }) {
  const value = useBoard();
  return <BoardContext.Provider value={value}>{children}</BoardContext.Provider>;
}

/**
 * Consume the board context provided by BoardProvider. Throws if used
 * outside a provider — this is intentional because every consumer must
 * be rendered within a board route that wraps with BoardProvider.
 *
 * The eslint-disable below is intentional: co-locating useBoardContext with
 * BoardProvider keeps the context contract (interface + provider + hook) in
 * one file and avoids a circular import chain. React Fast Refresh still works
 * correctly because BoardProvider is a component and useBoardContext is a
 * hook — Vite treats the file as HMR-safe.
 */
// eslint-disable-next-line react-refresh/only-export-components -- co-located intentionally, see docstring above
export function useBoardContext(): BoardContextType {
  const ctx = useContext(BoardContext);
  if (!ctx) {
    throw new Error("useBoardContext must be used within a <BoardProvider>");
  }
  return ctx;
}

// Non-throwing variant for shell-level consumers (e.g. GlobalCommandPalette)
// that mount above the board route and need to behave differently off-board.
// Returns null when no provider is present rather than raising.
// eslint-disable-next-line react-refresh/only-export-components -- same co-location rationale as useBoardContext above
export function useOptionalBoardContext(): BoardContextType | null {
  return useContext(BoardContext);
}
