import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getBoardFull, updateBoard as apiUpdateBoard, reorderColumns as apiReorderColumns, reorderSwimlanes as apiReorderSwimlanes, deleteSwimlane as apiDeleteSwimlane, deleteColumn as apiDeleteColumn } from "../api/boards";
import { moveCard as apiMoveCard } from "../api/cards";
import type { BoardFull, BoardMembership, Card, Column, Swimlane, Label } from "../types";

export function useBoard() {
  const { id } = useParams<{ id: string }>();
  const boardId = Number(id);
  const navigate = useNavigate();
  const [board, setBoard] = useState<BoardFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getBoardFull(boardId)
      .then(setBoard)
      .catch((err) => {
        if (err?.response?.status === 404 || err?.response?.status === 403) {
          // Board doesn't exist or user lost access — go back to dashboard.
          navigate("/", { replace: true });
        } else {
          setError("Failed to load board");
        }
      })
      .finally(() => setLoading(false));
  }, [boardId, navigate]);

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
    setBoard((b) => {
      if (!b) return b;
      const exists = b.cards.some((c) => c.id === card.id);
      return exists
        ? { ...b, cards: b.cards.map((c) => (c.id === card.id ? card : c)) }
        : { ...b, cards: [...b.cards, card] };
    });
  }, []);

  const removeCard = useCallback((cardId: number) => {
    setBoard((b) => b ? { ...b, cards: b.cards.filter((c) => c.id !== cardId) } : b);
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
    } : b);
    await apiDeleteColumn(boardId, columnId);
  }, [boardId]);

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
    setBoard((b) => b ? { ...b, cards: b.cards.map((c) => c.id === card.id ? card : c) } : b);
  }, []);

  const updateColumn = useCallback((column: Column) => {
    setBoard((b) => b ? { ...b, columns: b.columns.map((c) => c.id === column.id ? column : c) } : b);
  }, []);

  const addLabel = useCallback((label: Label) => {
    setBoard((b) => b ? { ...b, labels: [...b.labels, label] } : b);
  }, []);

  const updateLabel = useCallback((label: Label) => {
    setBoard((b) => b ? { ...b, labels: b.labels.map((l) => l.id === label.id ? label : l) } : b);
  }, []);

  const removeLabel = useCallback((labelId: number) => {
    setBoard((b) => b ? { ...b, labels: b.labels.filter((l) => l.id !== labelId) } : b);
  }, []);

  const addMember = useCallback((membership: BoardMembership) => {
    setBoard((b) => {
      if (!b) return b;
      const exists = b.members.some((m) => m.user.id === membership.user.id);
      return exists
        ? { ...b, members: b.members.map((m) => m.user.id === membership.user.id ? membership : m) }
        : { ...b, members: [...b.members, membership] };
    });
  }, []);

  const updateMember = useCallback((membership: BoardMembership) => {
    setBoard((b) => b ? { ...b, members: b.members.map((m) => m.user.id === membership.user.id ? membership : m) } : b);
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


  const reorderSwimlanes = useCallback(async (orderedIds: number[]) => {
    if (!board) return;
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
  }, [board, boardId, load]);

  const updateSwimlane = useCallback((swimlane: Swimlane) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.map((s) => s.id === swimlane.id ? swimlane : s) } : b);
  }, []);

  const removeSwimlane = useCallback(async (swimlaneId: number) => {
    setBoard((b) => b ? { ...b, swimlanes: b.swimlanes.filter((s) => s.id !== swimlaneId), cards: b.cards.filter((c) => c.swimlane !== swimlaneId) } : b);
    await apiDeleteSwimlane(boardId, swimlaneId);
  }, [boardId]);

  const updateBoardSettings = useCallback(async (patch: Record<string, unknown>) => {
    if (!board) return;
    setBoard((b) => b ? { ...b, ...patch } : b);
    try {
      await apiUpdateBoard(boardId, patch as Parameters<typeof apiUpdateBoard>[1]);
    } catch {
      // Reload fresh state on failure
      load();
    }
  }, [board, boardId, load]);

  return { board, loading, error, reload: load, moveCard, addCard, removeCard, addColumn, removeColumn, addSwimlane, updateCard, updateColumn, addLabel, updateLabel, removeLabel, addMember, updateMember, removeMember, applyColumnOrder, applySwimlaneOrder, reorderColumns, reorderSwimlanes, updateSwimlane, removeSwimlane, updateBoardSettings };
}
