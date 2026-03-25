import { useState } from "react";
import { changePassword } from "../../api/auth";
import { useEscapeStack } from "../../hooks/useEscapeStack";
import type { User } from "../../types";

interface Props {
  user: User;
  onChanged: (updatedUser: User) => void;
}

export default function ForceChangePasswordModal({ user, onChanged }: Props) {
  // Consume Escape at modal priority so it doesn't fall through to page navigation.
  // This modal cannot be dismissed — the user must set a new password.
  useEscapeStack(() => { /* intentionally blocked */ }, 40);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (next !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (next.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }

    setSaving(true);
    try {
      await changePassword(current, next);
      onChanged({ ...user, must_change_password: false });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail ?? "Failed to change password.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-xl p-8 w-full max-w-md shadow-xl" role="dialog" aria-labelledby="force-pw-title">
        <h2 id="force-pw-title" className="text-white text-xl font-bold mb-1">Change your password</h2>
        <p className="text-slate-400 text-sm mb-6">
          Your account was set up with a temporary password. You must set a new password before continuing.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-slate-400 text-xs mb-1">Temporary password</label>
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-blue-500"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="block text-slate-400 text-xs mb-1">New password <span className="text-slate-500">(min 12 characters)</span></label>
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-slate-400 text-xs mb-1">Confirm new password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium transition mt-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {saving ? "Saving…" : "Set new password"}
          </button>
        </form>
      </div>
    </div>
  );
}
