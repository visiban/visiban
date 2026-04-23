import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface OverflowItem {
  /** Stable identity (used for key + for test hooks). */
  id: string;
  /** Visible label. */
  label: string;
  /** Optional inline SVG or icon node (decorative — wrapped in aria-hidden). */
  icon?: ReactNode;
  /** Optional keyboard shortcut hint rendered right-aligned in a <kbd>. */
  shortcut?: string;
  /** Click handler; menu closes automatically after. */
  onSelect: () => void;
  /** Disables the item; always pair with disabledReason for accessibility. */
  disabled?: boolean;
  /** Tooltip + aria-label text explaining why the item is disabled. */
  disabledReason?: string;
  /** Render an engraved separator before this item. */
  separatorBefore?: boolean;
}

interface OverflowMenuProps {
  items: OverflowItem[];
  /** Show the first-encounter dot on the kebab. */
  showDot: boolean;
  /** Fires on intentional click of the kebab — never on external open. */
  onDismissDot: () => void;
  /** Optional controlled open state (for the `.` keyboard shortcut). */
  externalOpen?: boolean;
  onExternalOpenChange?: (open: boolean) => void;
}

/**
 * Row 2 board toolbar overflow kebab (`⋮`) with an items-driven menu.
 *
 * When items is empty the kebab is not rendered — the menu has nothing to
 * offer and the `.` shortcut is a no-op (the BoardView caller gates the
 * shortcut handler on items.length > 0).
 *
 * Items pass through in order. Each item may request an engraved separator
 * before it via `separatorBefore: true`. Disabled items must supply a
 * `disabledReason` string — the dropdown spec requires an explanation for any
 * greyed-out control.
 */
export default function OverflowMenu({
  items,
  showDot,
  onDismissDot,
  externalOpen,
  onExternalOpenChange,
}: OverflowMenuProps) {
  const isControlled = externalOpen !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? externalOpen : internalOpen;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const menuId = `${id}-menu`;

  const setOpen = (v: boolean) => {
    if (isControlled) onExternalOpenChange?.(v);
    else setInternalOpen(v);
  };

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // setOpen is stable via isControlled branching; intentionally not in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus the first enabled item when opened via keyboard (either `.` external
  // open or chevron keyboard activation). Defer a tick so the menu DOM exists.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const firstEnabled = itemRefs.current.findIndex(
        (el, i) => el !== null && !items[i]?.disabled,
      );
      if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, items]);

  const handleTriggerClick = () => {
    const next = !open;
    // Dismiss the first-encounter dot only on intentional kebab click, never
    // on the `.` shortcut path (that path never calls this handler).
    if (showDot) onDismissDot();
    setOpen(next);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      if (showDot) onDismissDot();
      setOpen(true);
    }
  };

  const focusItem = (i: number) => {
    const el = itemRefs.current[i];
    if (el) el.focus();
  };

  const findNextEnabled = (from: number, direction: 1 | -1): number => {
    const n = items.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + step * direction + n) % n;
      if (!items[i]?.disabled) return i;
    }
    return from;
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusItem(findNextEnabled(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusItem(findNextEnabled(i, -1));
    } else if (e.key === "Home") {
      e.preventDefault();
      const first = items.findIndex((it) => !it.disabled);
      if (first >= 0) focusItem(first);
    } else if (e.key === "End") {
      e.preventDefault();
      for (let i2 = items.length - 1; i2 >= 0; i2--) {
        if (!items[i2].disabled) {
          focusItem(i2);
          return;
        }
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  if (items.length === 0) return null;

  return (
    <div ref={wrapperRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="More board actions"
        className={`relative p-1.5 rounded transition shrink-0 focus:outline-none focus:ring-2 focus:ring-primary-emphasis ${
          open
            ? "text-info bg-info/10"
            : "text-fg-tertiary hover:text-fg hover:bg-surface-hover"
        }`}
      >
        <svg
          className="w-4 h-4"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="12" cy="19" r="1.75" />
        </svg>
        {showDot && (
          <span
            className="absolute top-0 right-0 w-2 h-2 bg-primary-emphasis rounded-full pointer-events-none"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          role="menu"
          id={menuId}
          aria-label="More board actions"
          className="absolute top-full right-0 mt-1 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[240px] max-h-[70vh] overflow-y-auto"
        >
          {items.map((item, i) => (
            <div key={item.id}>
              {item.separatorBefore && (
                <div role="separator" className="mx-4 my-1">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                title={item.disabled ? item.disabledReason : undefined}
                aria-label={
                  item.disabled && item.disabledReason
                    ? `${item.label} — ${item.disabledReason}`
                    : undefined
                }
                onClick={() => {
                  if (item.disabled) return;
                  item.onSelect();
                  setOpen(false);
                }}
                onKeyDown={(e) => handleItemKeyDown(e, i)}
                className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover focus:bg-surface-hover focus:outline-none transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {item.icon !== undefined && (
                  <span
                    className="w-4 text-center flex-shrink-0 text-fg-muted"
                    aria-hidden="true"
                  >
                    {item.icon}
                  </span>
                )}
                <span className="flex-1 text-left truncate">{item.label}</span>
                {item.shortcut && (
                  <kbd
                    className="bg-surface-hover text-fg-muted text-xs font-mono px-1.5 py-0.5 rounded border border-line-strong flex-shrink-0"
                    aria-hidden="true"
                  >
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
