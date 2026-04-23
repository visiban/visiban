import { useEffect, useId, useRef, useState } from "react";
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
 * focus ring and tab stop — the WAI-ARIA split-button pattern. The caller
 * owns the menu items via renderMenu; SplitButton owns the panel chrome,
 * positioning, outside-click dismissal, Escape handling, and open state.
 */
export default function SplitButton({
  primaryLabel,
  onPrimary,
  primaryAriaLabel,
  menuAriaLabel,
  primaryTitle,
  renderMenu,
  primaryDisabled = false,
  menuDisabled = false,
  tourStep,
  className = "",
}: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const menuId = `${id}-menu`;

  const close = () => setOpen(false);
  useDropdownEscape(open, close, chevronRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleChevronKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
    } else if (e.key === "ArrowDown") {
      // Delegated to the menu's roving-focus handler on its first item via
      // autoFocus — no-op here but keep preventDefault so the page doesn't scroll.
      e.preventDefault();
    }
  };

  return (
    <div
      ref={wrapperRef}
      className={`relative inline-flex items-stretch shrink-0 rounded ${className}`}
    >
      <button
        type="button"
        onClick={() => {
          if (open) setOpen(false);
          onPrimary();
        }}
        disabled={primaryDisabled}
        aria-label={primaryAriaLabel ?? primaryLabel}
        title={primaryTitle}
        data-tour-step={tourStep}
        className="text-xs font-medium text-fg-secondary hover:text-fg hover:bg-surface-hover px-2 py-1 rounded-l transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {primaryLabel}
      </button>
      <button
        ref={chevronRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
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
      {open && (
        <div
          role="menu"
          id={menuId}
          aria-label={menuAriaLabel ?? `${primaryLabel} menu`}
          className="absolute top-full right-0 mt-1 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[200px]"
        >
          {renderMenu({ close })}
        </div>
      )}
    </div>
  );
}
