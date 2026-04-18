import { useState } from "react";
import { updateCurrentUser } from "../../api/auth";
import type { User } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

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

  const inputCls = "w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-fg-muted";

  return (
    <ModalWrapper open={true} onClose={onClose} title="Your profile" maxWidth="max-w-md">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
          Display name
          <input
            value={form.display_name}
            onChange={set("display_name")}
            placeholder="How you appear on the board"
            className={inputCls}
          />
        </label>

        <div className="flex gap-3">
          <label className="flex flex-col gap-1 flex-1 text-sm text-fg-tertiary">
            First name
            <input value={form.first_name} onChange={set("first_name")} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 flex-1 text-sm text-fg-tertiary">
            Last name
            <input value={form.last_name} onChange={set("last_name")} className={inputCls} />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
          Username
          <input value={form.username} onChange={set("username")} required className={inputCls} />
        </label>

        <label className="flex flex-col gap-1 text-sm text-fg-tertiary">
          Email address
          <input type="email" value={form.email} onChange={set("email")} required className={inputCls} />
        </label>

        <p className="text-xs h-4">
          {error && <span className="text-danger">{error}</span>}
          {saved && <span className="text-success">Changes saved.</span>}
        </p>

        <div className="flex justify-end gap-2 mt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-tertiary hover:text-white px-4 py-1.5 rounded transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-40 transition focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </ModalWrapper>
  );
}
