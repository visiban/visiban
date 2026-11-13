import type { BoardUser } from "../../types";
import Avatar from "../Common/Avatar";

export interface FilterChipProps {
  label: string;
  colorDot?: string;
  avatarUser?: BoardUser;
  onDismiss: () => void;
  /**
   * #2205 — a small leading tag naming the filter family (e.g. "Lanes").
   * A tagged chip is named `{tag}: {label}, remove`; untagged chips keep
   * their existing `Remove {label} filter` name.
   */
  tag?: string;
  /** #2205 — marks a lane chip so dismissal can move focus to its neighbor. */
  dataLaneChip?: boolean;
}

export default function FilterChip({ label, colorDot, avatarUser, onDismiss, tag, dataLaneChip }: FilterChipProps) {
  const name = tag ? `${tag}: ${label}, remove` : `Remove ${label} filter`;
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
      aria-label={name}
      title={label}
      className="inline-flex items-center gap-1 bg-primary-emphasis/20 text-info border border-primary-emphasis/40 rounded-full px-2 py-0.5 text-xs font-medium max-w-[180px] focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-surface"
      onKeyDown={handleKeyDown}
      data-lane-chip={dataLaneChip ? "" : undefined}
    >
      {tag && (
        <span className="px-1.5 rounded-full bg-surface-hover text-fg-secondary text-xs shrink-0">{tag}</span>
      )}
      {colorDot && (
        <span className="color-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colorDot }} />
      )}
      {avatarUser && (
        <Avatar user={avatarUser} size="xs" />
      )}
      <span className="truncate min-w-0">{label}</span>
      <button type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label={name}
        tabIndex={-1}
        className="ml-0.5 text-info/70 hover:text-info transition shrink-0 leading-none focus:outline-none"
      >
        ×
      </button>
    </span>
  );
}
