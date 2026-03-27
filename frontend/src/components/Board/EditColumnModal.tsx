import { useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { updateColumn } from "../../api/boards";
import type { Column } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";

interface Props {
  boardId: number;
  column: Column;
  cardCount: number;
  onUpdated: (column: Column) => void;
  onRequestDelete: (column: Column) => void;
  onClose: () => void;
}

export default function EditColumnModal({ boardId, column, cardCount, onUpdated, onRequestDelete, onClose }: Props) {
  useEscapeStack(onClose, 40);
  const [name, setName] = useState(column.name);
  const [color, setColor] = useState(column.color);
  const [wipLimit, setWipLimit] = useState(column.wip_limit?.toString() ?? "");
  const [weightLimit, setWeightLimit] = useState(column.weight_limit?.toString() ?? "");
  const [allowCardCreation, setAllowCardCreation] = useState(column.allow_card_creation);
  const [isDone, setIsDone] = useState(column.is_done);
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
        is_done: isDone,
      });
      onUpdated(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div role="dialog" aria-modal="true" aria-labelledby="edit-column-title" className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 id="edit-column-title" className="text-lg font-semibold text-white mb-4">Edit Column</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">WIP limit</label>
              <input
                value={wipLimit}
                onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="None"
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Weight limit</label>
              <input
                value={weightLimit}
                onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
                placeholder="None"
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
                  className={`w-7 h-7 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${color === c ? "border-white scale-110" : "border-transparent"}`}
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
            <span className="text-sm text-slate-300">Allow card creation</span>
          </label>

          <div className="border-t border-slate-700 mt-3 pt-3">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Analytics behavior</p>
            <label className="flex flex-col gap-0.5 cursor-pointer select-none">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={isDone}
                  onChange={(e) => setIsDone(e.target.checked)}
                  className="w-4 h-4 rounded accent-blue-600"
                />
                <span className="text-sm text-slate-300">Count as completed (for cycle-time metrics)</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5 ml-6">
                Cards moved into this column are counted as completed in analytics.
              </p>
            </label>
          </div>
        </div>

        <div className="border-t border-slate-700 mt-5 pt-5">
          {/* Reserved status row — always rendered to prevent layout shift */}
          <p className="text-xs h-4 text-slate-400 mt-2">
            {cardCount > 0 ? `Cannot delete — ${cardCount} card${cardCount === 1 ? '' : 's'} in this column` : ''}
          </p>
          <button
            type="button"
            onClick={() => { onClose(); onRequestDelete(column); }}
            disabled={cardCount > 0}
            className="w-full px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 text-white rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed mt-2"
          >
            Delete column
          </button>
        </div>

        <div className="flex gap-2 mt-4 justify-end">
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition">Cancel</button>
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
  );
}
