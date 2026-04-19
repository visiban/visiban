import { useState } from "react";
import { createColumn } from "../../api/boards";
import type { Column } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ModalWrapper from "../shared/ModalWrapper";

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
    <ModalWrapper open={true} onClose={onClose} title="Add Column" maxWidth="max-w-sm">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder="e.g. In Progress"
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-fg-tertiary mb-1 block">WIP limit (optional)</label>
            <input
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 5"
              className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </div>
          <div>
            <label className="text-xs text-fg-tertiary mb-1 block">Weight limit (optional)</label>
            <input
              value={weightLimit}
              onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="e.g. 20"
              className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
          <div className="flex gap-2">
            {COLUMN_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-7 h-7 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${color === c ? "border-white scale-110" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="text-sm bg-primary text-on-primary px-4 py-1.5 rounded hover:bg-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {saving ? "Adding…" : "Add Column"}
        </button>
      </div>
    </ModalWrapper>
  );
}
