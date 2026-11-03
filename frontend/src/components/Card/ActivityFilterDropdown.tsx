import { useCallback, useEffect, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";
import AnchoredMenuPanel from "../Common/AnchoredMenuPanel";
import { captureMenuAnchor, type MenuAnchor } from "../../utils/menuAnchor";

export interface ActivityFilterOption {
  value: string;
  label: string;
  color?: string;
}

export interface ActivityFilterDropdownProps {
  label: string;
  options: ActivityFilterOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Values that represent the default selection. Enables the Reset control. */
  defaultSelected?: string[];
}

// Specialized dropdown for the card-detail Activity tab filter.
// Differs from the shared CheckboxDropdown in three ways:
// 1. The panel is right-aligned (right-0) so the menu grows leftward from the
//    trigger. The panel is `fixed` (#1482) and stays in the card sheet's DOM
//    (not a body portal) so the sheet's focus trap and click-outside
//    dismissal still treat it as part of the sheet.
// 2. An "All" toggle sits at the top of the panel for one-click select/clear.
// 3. A "Reset" control returns the filter to `defaultSelected` (e.g. Column moves).
export default function ActivityFilterDropdown({
  label,
  options,
  selected,
  onChange,
  defaultSelected,
}: ActivityFilterDropdownProps) {
  const [open, setOpenState] = useState(false);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const allCheckboxRef = useRef<HTMLInputElement>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) setAnchor(null);
  }, []);

  // Lives only inside the card detail panel, whose own close handler is at 30:
  // the default 25 would let one Escape close the whole panel (frontend/CLAUDE.md
  // § Escape priority inside the card detail panel). Priority 59, #1482.
  useDropdownEscape(open, () => setOpen(false), triggerRef, 59);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, setOpen]);

  // Runs once the panel is placed and visible (browsers ignore focus() on a hidden element).
  const focusFirst = useCallback(() => {
    menuRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
  }, []);
  const dismiss = useCallback(() => setOpen(false), [setOpen]);

  // Reflect partial selection visually on the "All" checkbox: unchecked when
  // selected=[], indeterminate when 0 < selected < options, checked when all.
  const allChecked = selected.length === options.length && options.length > 0;
  const someChecked = selected.length > 0 && selected.length < options.length;
  useEffect(() => {
    // Depend on `open` too — the ref only attaches after the menu renders,
    // so the indeterminate state must be set each time the menu opens.
    if (allCheckboxRef.current) {
      allCheckboxRef.current.indeterminate = someChecked;
    }
  }, [someChecked, selected.length, open]);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  const toggleAll = () => {
    onChange(allChecked ? [] : options.map((o) => o.value));
  };

  const handleReset = () => {
    onChange(defaultSelected ?? []);
  };

  const displayLabel =
    selected.length === 0
      ? label
      : selected.length === options.length
      ? `${label}: All`
      : `${label}: ${selected
          .map((v) => options.find((o) => o.value === v)?.label ?? v)
          .join(", ")}`;

  // Reset is only meaningful when `defaultSelected` is provided and differs
  // from the current selection (same values, order-insensitive).
  const defaultsMatch =
    defaultSelected !== undefined &&
    selected.length === defaultSelected.length &&
    selected.every((v) => defaultSelected.includes(v));
  const canReset = defaultSelected !== undefined && !defaultsMatch;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => {
          if (!open) setAnchor(captureMenuAnchor(triggerRef.current));
          setOpen(!open);
        }}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          selected.length > 0
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="truncate max-w-[10rem]">{displayLabel}</span>
        <svg
          className="w-3 h-3 text-fg-muted shrink-0"
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && anchor && (
        <AnchoredMenuPanel
          anchor={anchor}
          panelRef={menuRef}
          onDismiss={dismiss}
          onPlaced={focusFirst}
          align="right"
          mode="inline"
          minWidth={200}
          deps={[options.length]}
          role="group"
          aria-label={label}
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-muted italic">
              No options available
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-sm text-fg font-medium whitespace-nowrap">
                <input
                  ref={allCheckboxRef}
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  className="rounded accent-primary"
                  aria-label="Select all event types"
                />
                All
              </label>
              <div role="separator" className="mx-4">
                <div className="h-px bg-sunken" />
                <div className="h-px bg-surface-active/50" />
              </div>

              {options.map((opt, i) => (
                <div key={opt.value}>
                  {i > 0 && (
                    <div role="separator" className="mx-4">
                      <div className="h-px bg-sunken" />
                      <div className="h-px bg-surface-active/50" />
                    </div>
                  )}
                  <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-sm text-fg-secondary whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={selected.includes(opt.value)}
                      onChange={() => toggle(opt.value)}
                      className="rounded accent-primary"
                    />
                    {opt.color && (
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: opt.color }}
                      />
                    )}
                    {opt.label}
                  </label>
                </div>
              ))}

              {defaultSelected !== undefined && (
                <>
                  <div role="separator" className="mx-4">
                    <div className="h-px bg-sunken" />
                    <div className="h-px bg-surface-active/50" />
                  </div>
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={!canReset}
                    className="w-full text-left px-3 py-1.5 text-sm transition hover:bg-surface-hover text-fg-secondary disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-inset"
                  >
                    Reset to default
                  </button>
                </>
              )}
            </>
          )}
        </AnchoredMenuPanel>
      )}
    </div>
  );
}
