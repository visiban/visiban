import { useState } from "react";
import { createSwimlane } from "../../api/boards";
import type { Swimlane } from "../../types";
import { PALETTE_COLORS } from "../../constants/colors";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  boardId: number;
  onAdded: (swimlane: Swimlane) => void;
  onClose: () => void;
}

export default function AddSwimlaneModal({ boardId, onAdded, onClose }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [color, setColor] = useState(PALETTE_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const swimlane = await createSwimlane(boardId, { name: name.trim(), contact_email: email.trim(), color });
      onAdded(swimlane);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalWrapper open={true} onClose={onClose} title="Add Swimlane" maxWidth="max-w-sm">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Name *</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            placeholder="Swimlane name"
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-fg-muted"
          />
        </div>
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Contact email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@example.com"
            type="email"
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-fg-muted"
          />
        </div>
        <div>
          <label className="text-xs text-fg-tertiary mb-1 block">Color</label>
          <div className="flex gap-2 flex-wrap">
            {PALETTE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                className={`w-7 h-7 rounded-full border-2 transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${color === c ? "border-white scale-110" : "border-transparent"}`}
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
          className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {saving ? "Adding…" : "Add Swimlane"}
        </button>
      </div>
    </ModalWrapper>
  );
}
