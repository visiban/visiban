import { useState } from "react";
import { updateCustomer, deleteCustomer } from "../../api/boards";
import type { Customer } from "../../types";

interface Props {
  boardId: number;
  customer: Customer;
  cardCount: number;
  onUpdated: (customer: Customer) => void;
  onDeleted: (customerId: number) => void;
  onClose: () => void;
}

const COLORS = ["#6B7280", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6"];

export default function EditSwimlaneModal({ boardId, customer, cardCount, onUpdated, onDeleted, onClose }: Props) {
  const [name, setName] = useState(customer.name);
  const [color, setColor] = useState(customer.color);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const updated = await updateCustomer(boardId, customer.id, { name: name.trim(), color });
      onUpdated(updated);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    await deleteCustomer(boardId, customer.id);
    onDeleted(customer.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        {confirmDelete ? (
          cardCount > 0 ? (
            <>
              <h2 className="text-base font-semibold text-gray-800 mb-2">Cannot delete swimlane</h2>
              <p className="text-sm text-gray-600 mb-5">
                <span className="font-medium">{customer.name}</span> has {cardCount} card{cardCount !== 1 ? "s" : ""}. Move or delete all cards before removing this swimlane.
              </p>
              <div className="flex justify-end">
                <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition">
                  OK
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-base font-semibold text-gray-800 mb-2">Delete swimlane?</h2>
              <p className="text-sm text-gray-600 mb-5">
                Delete <span className="font-medium">{customer.name}</span>? This cannot be undone.
              </p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setConfirmDelete(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 transition">
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
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Edit Swimlane</h2>

            <div className="flex flex-col gap-3">
              <div>
                <label className="text-xs text-gray-500 mb-1 block">Name *</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") onClose(); }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-400"
                />
              </div>

              <div>
                <label className="text-xs text-gray-500 mb-1 block">Color</label>
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setColor(c)}
                      className={`w-7 h-7 rounded-full border-2 transition ${color === c ? "border-gray-900 scale-110" : "border-transparent"}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-between items-center mt-5">
              <button
                onClick={() => setConfirmDelete(true)}
                className="text-sm text-red-500 hover:text-red-700 transition"
              >
                Delete swimlane
              </button>
              <div className="flex gap-2">
                <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-1.5">Cancel</button>
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
