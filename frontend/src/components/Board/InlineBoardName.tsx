import { useState } from "react";

interface Props {
  name: string;
  canEdit: boolean;
  onSave: (name: string) => Promise<void>;
}

export default function InlineBoardName({ name, canEdit, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) {
    return <span className="text-fg text-sm font-medium">{name}</span>;
  }

  const start = () => {
    setValue(name);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError("Board name cannot be empty.");
      return;
    }
    if (trimmed === name) {
      setEditing(false);
      return;
    }
    setEditing(false);
    setError(null);
    try {
      await onSave(trimmed);
    } catch {
      setError("Failed to rename board. Please try again.");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  };

  return (
    <span className="relative group/rename inline-flex items-center gap-1">
      {editing ? (
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={save}
          aria-label="Board name"
          className="text-fg text-sm font-medium bg-transparent border border-primary-emphasis rounded px-1 min-w-[8rem] focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:border-transparent"
        />
      ) : (
        <>
          <span
            onClick={start}
            title={name}
            className="text-fg text-sm font-medium cursor-text border border-transparent hover:border-line-emphasis rounded px-1 -mx-1 transition-colors max-w-[12rem] truncate"
          >
            {name}
          </span>
          <button
            onClick={start}
            className="opacity-0 group-hover/rename:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-primary-emphasis rounded text-fg-muted hover:text-fg-secondary transition-opacity text-xs"
            title="Rename board"
            aria-label="Rename board"
          >
            ✎
          </button>
        </>
      )}
      <span className="absolute left-0 top-full mt-0.5 text-xs h-4 pointer-events-none whitespace-nowrap">
        {error && <span className="text-danger">{error}</span>}
      </span>
    </span>
  );
}
