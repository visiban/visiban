import { useState, useEffect, useCallback } from "react";
import { getBoardFull } from "../api/boards";
import { moveCard as apiMoveCard } from "../api/cards";
import type { BoardFull, Card, Column, Customer } from "../types";

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

  return { board, loading, error, reload: load, moveCard, addCard, removeCard, addColumn, addCustomer };
}
