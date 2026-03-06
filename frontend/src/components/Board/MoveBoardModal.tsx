import { useEffect, useState } from "react";
import { listGroups } from "../../api/groups";
import { moveBoardToGroup } from "../../api/boards";
import type { Board, Group } from "../../types";

interface Props {
  board: Board;
  onMoved: (updated: Board) => void;
  onClose: () => void;
}

export default function MoveBoardModal({ board, onMoved, onClose }: Props) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listGroups().then(setGroups).finally(() => setLoading(false));
  }, []);

  const handleMove = async (groupId: number | null) => {
    if (groupId === board.group) { onClose(); return; }
    setSaving(true);
    try {
      const updated = await moveBoardToGroup(board.id, groupId);
      onMoved(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Move board</h2>
        <p className="text-sm text-gray-500 mb-4">
          Moving <span className="font-medium text-gray-700">"{board.name}"</span> to:
        </p>

        {loading ? (
          <p className="text-sm text-gray-400 py-4 text-center">Loading groups…</p>
        ) : (
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto -mx-2 px-2">
            {/* Personal (no group) */}
            <button
              onClick={() => handleMove(null)}
              disabled={saving}
              className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition ${
                board.group === null
                  ? "bg-blue-50 text-blue-700 font-medium"
                  : "hover:bg-gray-50 text-gray-700"
              }`}
            >
              <span className="text-lg">🏠</span>
              <span className="text-sm">Personal (no group)</span>
              {board.group === null && <span className="ml-auto text-xs text-blue-500">current</span>}
            </button>

            {groups.length > 0 && <div className="my-1 h-px bg-gray-100" />}

            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => handleMove(g.id)}
                disabled={saving}
                className={`flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition ${
                  board.group === g.id
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "hover:bg-gray-50 text-gray-700"
                }`}
              >
                <span className="text-lg">👥</span>
                <span className="text-sm flex-1 truncate">{g.name}</span>
                {board.group === g.id && <span className="ml-auto text-xs text-blue-500 shrink-0">current</span>}
              </button>
            ))}

            {groups.length === 0 && (
              <p className="text-sm text-gray-400 px-3 py-2">No groups available.</p>
            )}
          </div>
        )}

        <div className="flex justify-end mt-5">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
