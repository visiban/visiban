import { useState } from "react";
import { createSwimlane } from "../../api/boards";
import type { Swimlane } from "../../types";
import { PALETTE_COLORS } from "../../constants/colors";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Add Swimlane</h2>

        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              placeholder="Swimlane name"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Contact email</label>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@example.com"
              type="email"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Color</label>
            <div className="flex gap-2 flex-wrap">
              {PALETTE_COLORS.map((c) => (
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
            {saving ? "Adding…" : "Add Swimlane"}
          </button>
        </div>
      </div>
    </div>
  );
}
