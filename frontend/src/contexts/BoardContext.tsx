import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useBoard } from "../hooks/useBoard";
import type { MoveBlockedError, MoveOutcome } from "../hooks/useBoard";
import type { BoardFull, BoardMembership, Card, CardSiblingPosition, Column, Swimlane, Label, CustomFieldDefinition, SwimlaneCustomFieldDefinition } from "../types";

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
  moveCard: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome>;
  forceMoveCard: () => Promise<void>;
  forceMoveCardTo: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<MoveOutcome>;
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
  updateBoardSettings: (patch: Record<string, unknown>) => Promise<void>;
  evictColumn: (columnUid: string) => void;
  evictSwimlane: (swimlaneUid: string) => void;
  evictCardByUid: (cardUid: string) => void;
  mergeBoardState: (patch: Partial<BoardFull>) => void;
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
