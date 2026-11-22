import ActiveUnderline from "../Common/ActiveUnderline";

/**
 * The "Dock to edge" / "Open next to card" toggle (#1915), shared by the card
 * detail sheet and the card peek (#2507). Both read and write the same
 * persisted preference (`useCardSheetDockedPref`), so docking one docks the
 * other. The pressed state is not tint alone: ActiveUnderline (#2188) plus the
 * icon swap and border reinforce it.
 */
export default function CardSheetDockToggle({ docked, onToggle }: { docked: boolean; onToggle: (next: boolean) => void }) {
  const label = docked ? "Open next to card" : "Dock to edge";
  return (
    <button
      type="button"
      onClick={() => onToggle(!docked)}
      aria-pressed={docked}
      aria-label={label}
      title={label}
      data-testid="card-sheet-dock-toggle"
      className={`relative w-7 h-7 flex items-center justify-center rounded border transition shrink-0 hover:text-fg hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
        docked ? "bg-surface-hover border-line-strong text-fg" : "border-transparent text-fg-tertiary"
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        {docked ? (
          <>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M9.5 2.75v10.5" />
            <path d="M9.5 8H4.5M6.5 6l-2 2 2 2" />
          </>
        ) : (
          <>
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
            <path d="M10 2.75v10.5" />
            <path d="M10 8h2.5M11.25 6.75L12.5 8l-1.25 1.25" />
          </>
        )}
      </svg>
      <ActiveUnderline active={docked} />
    </button>
  );
}
