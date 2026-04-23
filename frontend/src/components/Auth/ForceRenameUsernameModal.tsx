import { useState, useMemo } from "react";
import { chooseUsername } from "../../api/auth";
import type { User } from "../../types";
import ModalWrapper from "../shared/ModalWrapper";

interface Props {
  user: User;
  onChanged: (updatedUser: User) => void;
}

export default function ForceRenameUsernameModal({ user, onChanged }: Props) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Derive suggestion chips from email and display name.
  const suggestions = useMemo(() => {
    const chips: string[] = [];
    if (user.email) {
      const local = user.email.split("@")[0].replace(/[^\w.@+-]/g, "");
      if (local) chips.push(local);
    }
    if (user.display_name) {
      const slug = user.display_name.toLowerCase().replace(/\s+/g, "_").replace(/[^\w.@+-]/g, "");
      if (slug && !chips.includes(slug)) chips.push(slug);
    }
    return chips;
  }, [user.email, user.display_name]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmed = username.trim();
    if (!trimmed) {
      setError("Username is required.");
      return;
    }
    if (trimmed.length > 150) {
      setError("Username must be 150 characters or fewer.");
      return;
    }
    if (!/^[\w.@+-]+$/.test(trimmed)) {
      setError("Username may only contain letters, digits, and @/./+/-/_ characters.");
      return;
    }

    setSaving(true);
    try {
      const updated = await chooseUsername(trimmed);
      onChanged({ ...user, ...updated, must_change_username: false });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setError(detail ?? "Failed to set username.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalWrapper
      open={true}
      onClose={() => { /* intentionally blocked — user must choose a username */ }}
      title="Choose a username"
      maxWidth="max-w-md"
      dismissable={false}
      labelId="force-rename-username-title"
    >
      <p className="text-fg-tertiary text-sm mb-4">
        Your username was auto-generated and now conflicts with another account.
        Please choose a new one.
      </p>

      <div className="text-xs text-fg-muted mb-4">
        Previous username: <span className="font-mono text-fg-tertiary">{user.username}</span>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label className="block text-fg-tertiary text-xs mb-1">New username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-surface border border-line rounded px-3 py-1.5 text-sm text-fg-secondary focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent placeholder-fg-muted"
            placeholder="Pick a username"
            required
            autoFocus
          />
        </div>

        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setUsername(s)}
                className="text-xs bg-surface-hover hover:bg-surface-active text-fg-secondary rounded px-2 py-1 transition"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <p className="text-xs h-4">
          {error && <span className="text-danger">{error}</span>}
        </p>

        <button
          type="submit"
          disabled={saving}
          className="bg-button-primary hover:bg-button-primary-hover disabled:opacity-40 text-on-primary rounded px-4 py-2 text-sm font-medium transition mt-2 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
        >
          {saving ? "Saving\u2026" : "Set username"}
        </button>
      </form>
    </ModalWrapper>
  );
}
