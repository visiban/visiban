import { useState } from "react";
import { updateColumn } from "../../api/boards";
import type { Column } from "../../types";
import { COLUMN_COLORS } from "../../constants/colors";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  boardId: number;
  column: Column;
  cardCount: number;
  onUpdated: (column: Column) => void;
  onRequestDelete: (column: Column) => void;
  onClose: () => void;
}

export default function EditColumnModal({ boardId, column, cardCount, onUpdated, onRequestDelete, onClose }: Props) {
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
    <ModalWrapper open={true} onClose={onClose} title="Edit Column" maxWidth="max-w-sm" labelId="edit-column-title">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-fg-tertiary mb-1 block">WIP limit</label>
            <input
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="None"
              className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            />
          </div>
          <div>
            <label className="text-xs text-fg-tertiary mb-1 block">Weight limit</label>
            <input
              value={weightLimit}
              onChange={(e) => setWeightLimit(e.target.value.replace(/\D/g, ""))}
              placeholder="None"
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

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allowCardCreation}
            onChange={(e) => setAllowCardCreation(e.target.checked)}
            className="w-4 h-4 rounded accent-blue-600"
          />
          <span className="text-sm text-fg-secondary">Allow card creation</span>
        </label>

        <div className="border-t border-line mt-3 pt-3">
          <p className="text-xs font-medium text-fg-tertiary uppercase tracking-wide mb-2">Analytics behavior</p>
          <label className="flex flex-col gap-0.5 cursor-pointer select-none">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={isDone}
                onChange={(e) => setIsDone(e.target.checked)}
                className="w-4 h-4 rounded accent-blue-600"
              />
              <span className="text-sm text-fg-secondary">Count as completed (for cycle-time metrics)</span>
            </div>
            <p className="text-xs text-fg-muted mt-0.5 ml-6">
              Cards moved into this column are counted as completed in analytics.
            </p>
          </label>
        </div>
      </div>

      <div className="border-t border-line mt-5 pt-5">
        {/* Reserved status row — always rendered to prevent layout shift */}
        <p className="text-xs h-4 text-fg-tertiary mt-2">
          {cardCount > 0 ? `Cannot delete — ${cardCount} card${cardCount === 1 ? '' : 's'} in this column` : ''}
        </p>
        <button
          type="button"
          onClick={() => { onClose(); onRequestDelete(column); }}
          disabled={cardCount > 0}
          className="w-full px-3 py-1.5 text-sm bg-danger-bg hover:bg-danger-bg-hover text-on-danger rounded focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed mt-2"
        >
          Delete column
        </button>
      </div>

      <div className="flex gap-2 mt-4 justify-end">
        <button onClick={onClose} className="text-sm text-fg-tertiary hover:text-fg px-3 py-1.5 transition">Cancel</button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || saving}
          className="text-sm bg-primary text-on-primary px-4 py-1.5 rounded hover:bg-primary-hover disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalWrapper>
  );
}
