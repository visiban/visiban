import { useEffect, useState } from "react";
import { getCardMovements } from "../../api/cards";
import type { CardMovement } from "../../types";

interface Props {
  boardId: number;
  cardId: number;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export default function CardMovementTimeline({ boardId, cardId }: Props) {
  const [movements, setMovements] = useState<CardMovement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCardMovements(boardId, cardId)
      .then(setMovements)
      .finally(() => setLoading(false));
  }, [boardId, cardId]);

  if (loading) return <p className="text-sm text-gray-400">Loading history…</p>;
  if (movements.length === 0) return <p className="text-sm text-gray-400">No movements yet.</p>;

  return (
    <ol className="relative border-l border-gray-200 ml-2">
      {movements.map((m, i) => {
        const nextMovement = movements[i + 1];
        const duration = nextMovement
          ? formatDuration(new Date(m.moved_at).getTime() - new Date(nextMovement.moved_at).getTime())
          : null;

        return (
          <li key={m.id} className="mb-6 ml-4">
            <span className="absolute -left-1.5 w-3 h-3 rounded-full bg-blue-500 border-2 border-white" />
            <time className="text-xs text-gray-400">
              {new Date(m.moved_at).toLocaleString()}
            </time>
            <div className="text-sm text-gray-700 mt-0.5">
              {m.from_column_name && m.to_column_name && m.from_column_name !== m.to_column_name && (
                <span>
                  <span className="font-medium">{m.from_column_name}</span>
                  {" → "}
                  <span className="font-medium">{m.to_column_name}</span>
                </span>
              )}
              {m.from_customer_name && m.to_customer_name && m.from_customer_name !== m.to_customer_name && (
                <span className="ml-1 text-gray-500">
                  ({m.from_customer_name} → {m.to_customer_name})
                </span>
              )}
            </div>
            {m.moved_by && (
              <p className="text-xs text-gray-400">by {m.moved_by.first_name || m.moved_by.username}</p>
            )}
            {duration && (
              <p className="text-xs text-blue-500 mt-0.5">Spent {duration} here</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
