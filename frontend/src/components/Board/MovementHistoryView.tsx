import { useEffect, useState } from "react";
import { getBoardMovements } from "../../api/boards";
import type { BoardFull, CardMovement } from "../../types";

interface Props {
  board: BoardFull;
}

/**
 * Board-level movement history view — shows a chronological feed of all card
 * movements across the board, newest first.  Accessible via the "History" tab.
 */
export default function MovementHistoryView({ board }: Props) {
  const [movements, setMovements] = useState<CardMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(false);
    getBoardMovements(board.id)
      .then((data) => setMovements(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [board.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <span
          className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"
          aria-label="Loading"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <p className="text-sm text-slate-400">Failed to load movement history.</p>
      </div>
    );
  }

  if (movements.length === 0) {
    return (
      <div className="flex items-center justify-center flex-1 py-16">
        <p className="text-sm text-slate-400">No card movements recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">
        Board movement history
      </h2>
      <ol className="space-y-1">
        {movements.map((m) => (
          <li
            key={m.id}
            className="flex items-start gap-3 py-2 border-b border-slate-800 text-sm"
          >
            <span className="text-slate-500 shrink-0 tabular-nums text-xs pt-0.5">
              {new Date(m.moved_at).toLocaleString()}
            </span>
            <span className="text-slate-300 min-w-0">
              {m.moved_by ? (
                <span className="font-medium text-slate-200">{m.moved_by.display_name}</span>
              ) : (
                <span className="text-slate-500">Unknown user</span>
              )}{" "}
              moved a card
              {m.from_column_name && (
                <>
                  {" "}from{" "}
                  <span className="text-slate-400">{m.from_column_name}</span>
                </>
              )}{" "}
              to{" "}
              <span className="text-slate-200">{m.to_column_name ?? "—"}</span>
              {m.to_swimlane_name && m.to_swimlane_name !== m.from_swimlane_name && (
                <>
                  {" "}· lane{" "}
                  <span className="text-slate-200">{m.to_swimlane_name}</span>
                </>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
