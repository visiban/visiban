import { useState } from "react";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import { updateSwimlane, deleteSwimlane } from "../../api/boards";
import type { Swimlane } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";

interface Props {
  boardId: number;
  swimlane: Swimlane;
  cardCount: number;
  onUpdated: (swimlane: Swimlane) => void;
  onDeleted: (swimlaneId: number) => void;
  onClose: () => void;
}

export default function EditSwimlaneModal({ boardId, swimlane, cardCount, onUpdated, onDeleted, onClose }: Props) {
  useEscapeStack(onClose, 40);
  const [name, setName] = useState(swimlane.name);
  const [color, setColor] = useState(swimlane.color);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updated = await updateSwimlane(boardId, swimlane.id, { name: name.trim(), color });
      onUpdated(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    await deleteSwimlane(boardId, swimlane.id);
    onDeleted(swimlane.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div role="dialog" aria-modal="true" aria-labelledby="edit-swimlane-title" className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        {confirmDelete ? (
          cardCount > 0 ? (
            <>
              <h2 className="text-base font-semibold text-white mb-2">Cannot delete swimlane</h2>
              <p className="text-sm text-slate-400 mb-5">
                <span className="font-medium text-slate-200">{swimlane.name}</span> has {cardCount} card{cardCount !== 1 ? "s" : ""}. Move or delete all cards before removing this swimlane.
              </p>
              <div className="flex justify-end">
                <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm bg-slate-700 text-slate-200 rounded-lg hover:bg-slate-600 transition">
                  OK
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-white mb-2">Delete swimlane?</h2>
              <p className="text-sm text-slate-400 mb-5">
                Delete <span className="font-medium text-slate-200">{swimlane.name}</span>? This cannot be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition">
                  Cancel
                </button>
                <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition">
                  Delete
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <h2 id="edit-swimlane-title" className="text-lg font-semibold text-white mb-4">Edit Swimlane</h2>

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

            <div className="flex justify-between items-center mt-5">
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-sm text-red-400 hover:text-red-300 transition"
              >
                Delete swimlane
              </button>
              <div className="flex gap-2">
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
          </>
        )}
      </div>
    </div>
  );
}
