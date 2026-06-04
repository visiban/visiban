import { useEffect, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

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
//    trigger and stays within the card drawer's overflow-hidden bounds.
// 2. An "All" toggle sits at the top of the panel for one-click select/clear.
// 3. A "Reset" control returns the filter to `defaultSelected` (e.g. Column moves).
export default function ActivityFilterDropdown({
  label,
  options,
  selected,
  onChange,
  defaultSelected,
}: ActivityFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const allCheckboxRef = useRef<HTMLInputElement>(null);

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      const first = menuRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      setTimeout(() => first?.focus(), 0);
    }
  }, [open]);

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
        onClick={() => setOpen((o) => !o)}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus-visible:ring-2 focus-visible:ring-primary-emphasis focus-visible:ring-offset-1 focus-visible:ring-offset-sunken ${
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

      {open && (
        <div
          ref={menuRef}
          className="absolute top-full mt-1 right-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[200px]"
          role="menu"
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
        </div>
      )}
    </div>
  );
}
