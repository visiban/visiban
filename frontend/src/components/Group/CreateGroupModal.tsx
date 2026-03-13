import { useState } from "react";
import { createGroup } from "../../api/groups";
import type { Group } from "../../types";

interface Props {
  parentGroup?: Group;
  onCreated: (group: Group) => void;
  onClose: () => void;
}

export default function CreateGroupModal({ parentGroup, onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const group = await createGroup({ name: name.trim(), parent: parentGroup?.id ?? null });
      onCreated(group);
      onClose();
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string; name?: string[] } } })?.response?.data;
      setError(detail?.detail ?? detail?.name?.[0] ?? "Failed to create group.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-slate-800 rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <h2 className="text-lg font-semibold text-white mb-4">
          {parentGroup ? `New subgroup of "${parentGroup.name}"` : "New Group"}
        </h2>
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Name *</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
              placeholder="e.g. Engineering"
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-400"
            />
          </div>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-sm text-slate-400 hover:text-white px-3 py-1.5 transition">Cancel</button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
