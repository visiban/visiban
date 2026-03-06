import { useState } from "react";
import { updateColumn } from "../../api/boards";
import type { Column } from "../../types";

interface Props {
  boardId: number;
  column: Column;
  cardCount: number;
  onUpdated: (column: Column) => void;
  onDeleted: (columnId: number) => void;
  onClose: () => void;
}

const COLORS = ["#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

export default function EditColumnModal({ boardId, column, cardCount, onUpdated, onDeleted, onClose }: Props) {
  const [name, setName] = useState(column.name);
  const [color, setColor] = useState(column.color);
  const [wipLimit, setWipLimit] = useState(column.wip_limit?.toString() ?? "");
  const [weightLimit, setWeightLimit] = useState(column.weight_limit?.toString() ?? "");
  const [allowCardCreation, setAllowCardCreation] = useState(column.allow_card_creation);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updated = await updateColumn(boardId, column.id, {
        name: name.trim(),
        color,
        wip_limit: wipLimit ? parseInt(wipLimit) : null,
        weight_limit: weightLimit ? parseInt(weightLimit) : null,
        allow_card_creation: allowCardCreation,
      });
      onUpdated(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Column</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 mb-1 block">WIP limit</label>
              <input
                value={wipLimit}
                onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="None"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Weight limit</label>
              <input
                value={weightLimit}
                onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="None"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 mb-1 block">Color</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition ${color === c ? "border-gray-900 scale-110" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowCardCreation}
              onChange={(e) => setAllowCardCreation(e.target.checked)}
              className="w-4 h-4 rounded accent-blue-600"
            />
            <span className="text-sm text-gray-700">Allow card creation</span>
          </label>
        </div>

        <div className="flex items-center mt-5">
          {cardCount > 0 ? (
            <span className="text-sm text-gray-400" title={`Move or delete the ${cardCount} card${cardCount === 1 ? "" : "s"} in this column first`}>
              Cannot delete — {cardCount} card{cardCount === 1 ? "" : "s"} remaining
            </span>
          ) : (
            <button
              onClick={() => {
                if (confirm(`Delete column "${column.name}"?`)) {
                  onDeleted(column.id);
                }
              }}
              className="text-sm text-red-500 hover:text-red-700 transition"
            >
              Delete column
            </button>
          )}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
