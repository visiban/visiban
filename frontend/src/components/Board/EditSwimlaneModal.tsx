import { useState } from "react";
import { updateSwimlane, deleteSwimlane } from "../../api/boards";
import type { Swimlane } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  boardId: number;
  swimlane: Swimlane;
  cardCount: number;
  onUpdated: (swimlane: Swimlane) => void;
  onDeleted: (swimlaneId: number) => void;
  onClose: () => void;
}

export default function EditSwimlaneModal({ boardId, swimlane, cardCount, onUpdated, onDeleted, onClose }: Props) {
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

  // Dynamic title based on delete-confirmation state
  const title = confirmDelete
    ? (cardCount > 0 ? "Cannot delete swimlane" : "Delete swimlane?")
    : "Edit Swimlane";

  return (
    <ModalWrapper open={true} onClose={onClose} title={title} maxWidth="max-w-sm" labelId="edit-swimlane-title">
      {confirmDelete ? (
        cardCount > 0 ? (
          <>
            <p className="text-sm text-fg-tertiary mb-5">
              <span className="font-medium text-fg">{swimlane.name}</span> has {cardCount} card{cardCount !== 1 ? "s" : ""}. Move or delete all cards before removing this swimlane.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm bg-surface-hover text-fg rounded hover:bg-surface-active transition">
                OK
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-fg-tertiary mb-5">
              Delete <span className="font-medium text-fg">{swimlane.name}</span>? This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg transition">
                Cancel
              </button>
              <button onClick={handleDelete} className="px-4 py-2 text-sm bg-red-600 text-white rounded hover:bg-red-700 transition focus:outline-none focus:ring-2 focus:ring-blue-500">
                Delete
              </button>
            </div>
          </>
        )
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
                className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-fg-muted"
              />
            </div>

            <div>
              <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
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
              className="text-sm text-danger hover:text-danger transition"
            >
              Delete swimlane
            </button>
            <div className="flex gap-2">
              <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition">Cancel</button>
              <button
                onClick={handleSave}
                disabled={!name.trim() || saving}
                className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </ModalWrapper>
  );
}
