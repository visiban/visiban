import { useState, useEffect, useCallback } from "react";
import { getBoardFull, reorderColumns as apiReorderColumns, updateSwimlane as apiUpdateSwimlane, deleteSwimlane as apiDeleteSwimlane, deleteColumn as apiDeleteColumn } from "../api/boards";
import { moveCard as apiMoveCard } from "../api/cards";
import type { BoardFull, Card, Column, Swimlane, Label } from "../types";

export function useBoard(boardId: number) {
  const [board, setBoard] = useState<BoardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getBoardFull(boardId)
      .then(setBoard)
      .catch(() => setError("Failed to load board"))
      .finally(() => setLoading(false));
  }, [boardId]);

  useEffect(() => { load(); }, [load]);

  const moveCard = useCallback(async (
    cardId: number,
    columnId: number,
    swimlaneId: number,
    position: number
  ) => {
    if (!board) return;

    // Optimistic update
    const prev = board.cards;
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
      const { card } = await apiMoveCard(boardId, cardId, { column_id: columnId, swimlane_id: swimlaneId, position });
      setBoard((b) => {
        if (!b) return b;
        return { ...b, cards: b.cards.map((c) => (c.id === cardId ? card : c)) };
      });
    } catch {
      // Rollback
      setBoard((b) => b ? { ...b, cards: prev } : b);
    }
  }, [board, boardId]);

  const addCard = useCallback((card: Card) => {
    setBoard((b) => b ? { ...b, cards: [...b.cards, card] } : b);
  }, []);

  const removeCard = useCallback((cardId: number) => {
    setBoard((b) => b ? { ...b, cards: b.cards.filter((c) => c.id !== cardId) } : b);
  }, []);

  const addColumn = useCallback((column: Column) => {
    setBoard((b) => b ? { ...b, columns: [...b.columns, column] } : b);
  }, []);

  const removeColumn = useCallback(async (columnId: number) => {
    setBoard((b) => b ? {
      ...b,
      columns: b.columns.filter((c) => c.id !== columnId),
      cards: b.cards.filter((c) => c.column !== columnId),
    } : b);
    await apiDeleteColumn(boardId, columnId);
  }, [boardId]);

  const addSwimlane = useCallback((swimlane: Swimlane) => {
    setBoard((b) => b ? { ...b, swimlanes: [...b.swimlanes, swimlane] } : b);
  }, []);

  const updateCard = useCallback((card: Card) => {
    setBoard((b) => b ? { ...b, cards: b.cards.map((c) => c.id === card.id ? card : c) } : b);
  }, []);

  const updateColumn = useCallback((column: Column) => {
    setBoard((b) => b ? { ...b, columns: b.columns.map((c) => c.id === column.id ? column : c) } : b);
  }, []);

  const addLabel = useCallback((label: Label) => {
    setBoard((b) => b ? { ...b, labels: [...b.labels, label] } : b);
  }, []);

  const reorderColumns = useCallback(async (orderedIds: number[]) => {
    if (!board) return;
    const prev = board.columns;
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
  }, [board, boardId]);

  const updateSwimlane = useCallback((swimlane: Swimlane) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.map((s) => s.id === swimlane.id ? swimlane : s) } : b);
  }, []);

  const removeSwimlane = useCallback(async (swimlaneId: number) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.filter((s) => s.id !== swimlaneId), cards: b.cards.filter((c) => c.swimlane !== swimlaneId) } : b);
    await apiDeleteSwimlane(boardId, swimlaneId);
  }, [boardId]);

  return { board, loading, error, reload: load, moveCard, addCard, removeCard, addColumn, removeColumn, addSwimlane, updateCard, updateColumn, addLabel, reorderColumns, updateSwimlane, removeSwimlane };
}
