import { useState } from "react";
import { changePassword } from "../../api/auth";
import type { User } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  user: User;
  onChanged: (updatedUser: User) => void;
}

export default function ForceChangePasswordModal({ user, onChanged }: Props) {
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
    <ModalWrapper
      open={true}
      onClose={() => { /* intentionally blocked — user must set a new password */ }}
      title="Change your password"
      maxWidth="max-w-md"
      dismissable={false}
      labelId="force-pw-title"
    >
      <p className="text-slate-400 text-sm mb-6">
        Your account was set up with a temporary password. You must set a new password before continuing.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="fcp-current" className="block text-slate-400 text-xs mb-1">Temporary password</label>
          <input
            id="fcp-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            required
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="fcp-next" className="block text-slate-400 text-xs mb-1">New password <span className="text-slate-500">(min 12 characters)</span></label>
          <input
            id="fcp-next"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            required
          />
        </div>
        <div>
          <label htmlFor="fcp-confirm" className="block text-slate-400 text-xs mb-1">Confirm new password</label>
          <input
            id="fcp-confirm"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-slate-500"
            required
          />
        </div>

        <p className="text-xs h-4">
          {error && <span className="text-red-400">{error}</span>}
        </p>

        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded px-4 py-2 text-sm font-medium transition mt-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {saving ? "Saving…" : "Set new password"}
        </button>
      </form>
    </ModalWrapper>
  );
}
