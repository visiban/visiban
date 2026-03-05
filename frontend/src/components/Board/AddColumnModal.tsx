import { useState } from "react";
import { createColumn } from "../../api/boards";
import type { Column } from "../../types";

interface Props {
  boardId: number;
  onAdded: (column: Column) => void;
  onClose: () => void;
}

const COLORS = ["#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

export default function AddColumnModal({ boardId, onAdded, onClose }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [wipLimit, setWipLimit] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const column = await createColumn(boardId, {
        name: name.trim(),
        color,
        wip_limit: wipLimit ? parseInt(wipLimit) : undefined,
      });
      onAdded(column);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Add Column</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-gray-500 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              placeholder="e.g. In Progress"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 mb-1 block">WIP limit (optional)</label>
            <input
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value.replace(/\D/, ""))}
              placeholder="e.g. 5"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
            />
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
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {saving ? "Adding…" : "Add Column"}
          </button>
        </div>
      </div>
    </div>
  );
}
