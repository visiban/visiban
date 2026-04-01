import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useBoard } from "../hooks/useBoard";
import type { MoveBlockedError } from "../hooks/useBoard";
import type { BoardFull, BoardMembership, Card, Column, Swimlane, Label } from "../types";

export interface BoardContextType {
  board: BoardFull | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  silentReload: () => void;
  moveCard: (cardId: number, columnId: number, swimlaneId: number, position: number) => Promise<void>;
  forceMoveCard: () => Promise<void>;
  moveError: MoveBlockedError | null;
  clearMoveError: () => void;
  addCard: (card: Card) => void;
  removeCard: (cardId: number) => void;
  addColumn: (column: Column) => void;
  removeColumn: (columnId: number) => Promise<void>;
  addSwimlane: (swimlane: Swimlane) => void;
  updateCard: (card: Card) => void;
  updateColumn: (column: Column) => void;
  addLabel: (label: Label) => void;
  updateLabel: (label: Label) => void;
  removeLabel: (labelUid: string) => void;
  addMember: (membership: BoardMembership) => void;
  updateMember: (membership: BoardMembership) => void;
  removeMember: (userId: number) => void;
  applyColumnOrder: (columns: Column[]) => void;
  applySwimlaneOrder: (swimlanes: Swimlane[]) => void;
  reorderColumns: (orderedIds: number[]) => Promise<void>;
  reorderSwimlanes: (orderedIds: number[]) => Promise<void>;
  updateSwimlane: (swimlane: Swimlane) => void;
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
// eslint-disable-next-line react-refresh/only-export-components
export function useBoardContext(): BoardContextType {
  const ctx = useContext(BoardContext);
  if (!ctx) {
    throw new Error("useBoardContext must be used within a <BoardProvider>");
  }
  return ctx;
}
