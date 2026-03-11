import { useEffect, useState } from "react";
import { updateCurrentUser } from "../../api/auth";
import type { User } from "../../types";

interface Props {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
}

export default function ProfileModal({ user, onClose, onUpdated }: Props) {
  const [form, setForm] = useState({
    display_name: user.display_name ?? "",
    first_name: user.first_name ?? "",
    last_name: user.last_name ?? "",
    email: user.email ?? "",
    username: user.username ?? "",
  });
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateCurrentUser(form);
      onUpdated(updated);
      setSaved(true);
    } catch {
      setError("Failed to save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm text-slate-200 outline-none focus:border-blue-400";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-slate-800 rounded-xl shadow-xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-white">Your profile</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition text-xl leading-none">&times;</button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm text-slate-400">
            Display name
            <input
              value={form.display_name}
              onChange={set("display_name")}
              placeholder="How you appear on the board"
              className={inputCls}
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-col gap-1 flex-1 text-sm text-slate-400">
              First name
              <input value={form.first_name} onChange={set("first_name")} className={inputCls} />
            </label>
            <label className="flex flex-col gap-1 flex-1 text-sm text-slate-400">
              Last name
              <input value={form.last_name} onChange={set("last_name")} className={inputCls} />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm text-slate-400">
            Username
            <input value={form.username} onChange={set("username")} required className={inputCls} />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-400">
            Email address
            <input type="email" value={form.email} onChange={set("email")} required className={inputCls} />
          </label>

          {error && <p className="text-sm text-red-400">{error}</p>}
          {saved && <p className="text-sm text-green-400">Changes saved.</p>}

          <div className="flex justify-end gap-2 mt-1">
            <button
              type="button"
              onClick={onClose}
              className="text-sm text-slate-400 hover:text-white px-4 py-1.5 rounded transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
