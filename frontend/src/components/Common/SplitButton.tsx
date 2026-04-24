import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SplitButtonProps {
  /** Label on the primary action segment (static — do not flip per state). */
  primaryLabel: string;
  /** Fires when the primary segment is clicked. */
  onPrimary: () => void;
  /** Accessible label for the primary segment. Defaults to primaryLabel. */
  primaryAriaLabel?: string;
  /** Accessible label for the chevron segment. Defaults to "{primaryLabel} menu". */
  menuAriaLabel?: string;
  /** Optional title attribute for the primary segment only. */
  primaryTitle?: string;
  /** Optional `aria-keyshortcuts` announcement for the primary segment. */
  primaryAriaKeyshortcuts?: string;
  /** Menu content — rendered inside the panel when open. Receives close(). */
  renderMenu: (args: { close: () => void }) => ReactNode;
  /** Optional per-half disable. */
  primaryDisabled?: boolean;
  menuDisabled?: boolean;
  /** Forwarded to the primary segment for onboarding tour targeting. */
  tourStep?: string;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
}

/**
 * Segmented button with a primary action on the left and a chevron menu
 * trigger on the right. Each half is an independent `<button>` with its own
 * focus ring and tab stop — the WAI-ARIA split-button pattern.
 *
 * The menu panel is portaled to document.body to escape the toolbar's
 * `overflow-x-auto` region (CSS spec: `overflow-x: auto` with the default
 * `overflow-y: visible` promotes the y-axis to `auto` too, clipping any
 * descendant dropdown). Position is captured at click time via
 * `getBoundingClientRect` and used for `position: fixed` rendering.
 */
export default function SplitButton({
  primaryLabel,
  onPrimary,
  primaryAriaLabel,
  menuAriaLabel,
  primaryTitle,
  primaryAriaKeyshortcuts,
  renderMenu,
  primaryDisabled = false,
  menuDisabled = false,
  tourStep,
  className = "",
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  // Menu anchor captured at click time — right-edge aligned to the chevron so
  // the menu doesn't drift off-screen at narrow widths. Stored as state (not
  // ref) so position survives a re-render without re-measuring.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const menuId = `${id}-menu`;

  const close = () => {
    setOpen(false);
    setAnchor(null);
  };
  useDropdownEscape(open, close, chevronRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (chevronRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const openMenu = () => {
    const rect = chevronRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(true);
  };

  const toggleMenu = () => {
    if (open) close();
    else openMenu();
  };

  const handleChevronKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openMenu();
    } else if (open && e.key === "ArrowDown") {
      e.preventDefault();
    }
  };

  const panel = open && anchor ? (
    <div
      ref={panelRef}
      role="menu"
      id={menuId}
      aria-label={menuAriaLabel ?? `${primaryLabel} menu`}
      style={{ position: "fixed", top: anchor.top, right: anchor.right }}
      className="z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[200px]"
    >
      {renderMenu({ close })}
    </div>
  ) : null;

  return (
    <div className={`inline-flex items-stretch shrink-0 rounded ${className}`}>
      <button
        type="button"
        onClick={() => {
          if (open) close();
          onPrimary();
        }}
        disabled={primaryDisabled}
        aria-label={primaryAriaLabel ?? primaryLabel}
        aria-keyshortcuts={primaryAriaKeyshortcuts}
        title={primaryTitle}
        data-tour-step={tourStep}
        className="text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded-l transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {primaryLabel}
      </button>
      <button
        ref={chevronRef}
        type="button"
        onClick={toggleMenu}
        onMouseDown={(e) => { if (open) e.stopPropagation(); }}
        onKeyDown={handleChevronKeyDown}
        disabled={menuDisabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={menuAriaLabel ?? `${primaryLabel} menu`}
        className={`px-1.5 py-1 rounded-r border-l border-line-strong transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed ${
          open
            ? "text-info bg-info/10"
            : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
        }`}
      >
        <svg
          className="w-3 h-3"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </button>
      {panel && createPortal(panel, document.body)}
    </div>
  );
}
