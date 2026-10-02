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
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const column = await createColumn(boardId, {
        name: name.trim(),
        color,
        wip_limit: wipLimit ? parseInt(wipLimit) : undefined,
        weight_limit: weightLimit ? parseInt(weightLimit) : undefined,
      });
      onAdded(column);
      onClose();
    } catch {
      setError("Failed to add column. Please try again.");
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
            onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }} // handleSave manages its own saving/error state and never rejects
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
                aria-label={`Select color ${c}`}
                aria-pressed={color === c}
                className={`w-7 h-7 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${color === c ? "border-white scale-110" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <p className="text-xs h-4 flex-1"><span className="text-danger">{error}</span></p>
        <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 rounded transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="text-sm bg-button-primary text-on-primary px-4 py-1.5 rounded hover:bg-button-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis font-medium"
        >
          {saving ? "Adding…" : "Add Column"}
        </button>
      </div>
    </ModalWrapper>
  );
}
