import { useState, useEffect, useCallback } from "react";
import { getBoardFull, reorderColumns as apiReorderColumns, updateCustomer as apiUpdateCustomer, deleteCustomer as apiDeleteCustomer } from "../api/boards";
import { moveCard as apiMoveCard } from "../api/cards";
import type { BoardFull, Card, Column, Customer, Label } from "../types";

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
    customerId: number,
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
            ? { ...c, column: columnId, customer: customerId, position }
            : c
        ),
      };
    });

    try {
      const { card } = await apiMoveCard(boardId, cardId, { column_id: columnId, customer_id: customerId, position });
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

  const addCustomer = useCallback((customer: Customer) => {
    setBoard((b) => b ? { ...b, customers: [...b.customers, customer] } : b);
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

  const updateCustomer = useCallback((customer: Customer) => {
    setBoard((b) => b ? { ...b, customers: b.customers.map((c) => c.id === customer.id ? customer : c) } : b);
  }, []);

  const removeCustomer = useCallback(async (customerId: number) => {
    setBoard((b) => b ? { ...b, customers: b.customers.filter((c) => c.id !== customerId), cards: b.cards.filter((c) => c.customer !== customerId) } : b);
    await apiDeleteCustomer(boardId, customerId);
  }, [boardId]);

  return { board, loading, error, reload: load, moveCard, addCard, removeCard, addColumn, addCustomer, updateCard, updateColumn, addLabel, reorderColumns, updateCustomer, removeCustomer };
}
