import type { BoardUser } from "../../types";
import Avatar from "../Common/Avatar";

export interface FilterChipProps {
  label: string;
  colorDot?: string;
  avatarUser?: BoardUser;
  onDismiss: () => void;
}

export default function FilterChip({ label, colorDot, avatarUser, onDismiss }: FilterChipProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDismiss();
    }
  };

  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Remove ${label} filter`}
      title={label}
      className="inline-flex items-center gap-1 bg-info/20 text-info border border-blue-500/40 rounded-full px-2 py-0.5 text-xs font-medium max-w-[180px] focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      onKeyDown={handleKeyDown}
    >
      {colorDot && (
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorDot }} />
      )}
      {avatarUser && (
        <Avatar user={avatarUser} size="xs" className="w-3.5 h-3.5 text-[8px]" />
      )}
      <span className="truncate">{label}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label={`Remove ${label} filter`}
        tabIndex={-1}
        className="ml-0.5 text-info/70 hover:text-info transition shrink-0 leading-none focus:outline-none"
      >
        ×
      </button>
    </span>
  );
}
