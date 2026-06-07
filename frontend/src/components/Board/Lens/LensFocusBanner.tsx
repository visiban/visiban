interface Props {
  /** The focused swimlane's display label. */
  label: string;
  onExit: () => void;
}

/**
 * Mode-indicator banner shown while the lens is focused on a single swimlane.
 * Sits outside the grid scroll container (stacked below the provenance banner)
 * so it never scrolls away — same placement rule as the Mode Indicator Banner
 * and the provenance banner. `bg-primary/15` per the mode-banner spec.
 */
export default function LensFocusBanner({ label, onExit }: Props) {
  return (
    <div
      role="status"
      aria-atomic="true"
      className="bg-primary/15 border-b border-primary-emphasis/40 px-4 py-2 flex items-center gap-3 text-sm text-info transition-opacity duration-150"
    >
      <svg
        className="w-4 h-4 shrink-0"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="3" />
        <line x1="8" y1="1" x2="8" y2="4" />
        <line x1="8" y1="12" x2="8" y2="15" />
        <line x1="1" y1="8" x2="4" y2="8" />
        <line x1="12" y1="8" x2="15" y2="8" />
      </svg>
      <span className="shrink-0">Focused on:</span>
      <span className="font-medium text-info truncate max-w-[24rem]" title={label}>
        {label}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        onClick={onExit}
        className="text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded text-xs shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis"
      >
        Exit focus
      </button>
    </div>
  );
}
