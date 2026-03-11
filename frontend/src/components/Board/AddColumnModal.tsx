import { useState } from "react";
import { createColumn } from "../../api/boards";
import type { Column } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";

interface Props {
  boardId: number;
  onAdded: (column: Column) => void;
  onClose: () => void;
}

export default function AddColumnModal({ boardId, onAdded, onClose }: Props) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLUMN_COLORS[0]);
  const [wipLimit, setWipLimit] = useState("");
  const [weightLimit, setWeightLimit] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const column = await createColumn(boardId, {
        name: name.trim(),
        color,
        wip_limit: wipLimit ? parseInt(wipLimit) : undefined,
        weight_limit: weightLimit ? parseInt(weightLimit) : undefined,
      });
      onAdded(column);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Add Column</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              placeholder="e.g. In Progress"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">WIP limit (optional)</label>
              <input
                value={wipLimit}
                onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 5"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Weight limit (optional)</label>
              <input
                value={weightLimit}
                onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="e.g. 20"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Color</label>
            <div className="flex gap-2">
              {COLUMN_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  className={`w-7 h-7 rounded-full border-2 transition ${color === c ? "border-white scale-110" : "border-transparent"}`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition">Cancel</button>
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
