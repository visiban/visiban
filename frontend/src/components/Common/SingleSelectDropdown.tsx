import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface SingleSelectDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string }[];
  selected: T | null;
  onChange: (selected: T | null) => void;
  /**
   * Optional element rendered before the trigger label (e.g. an icon).
   * Decorative — the component wraps it in aria-hidden.
   */
  triggerPrefix?: ReactNode;
}

export default function SingleSelectDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
  triggerPrefix,
}: SingleSelectDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const menuId = `${id}-menu`;

  useDropdownEscape(open, () => setOpen(false), triggerRef);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const displayLabel =
    selected === null
      ? label
      : options.find((o) => o.value === selected)?.label ?? label;

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    }
  };

  const handleItemKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowDown") {
      itemRefs.current[Math.min(i + 1, options.length - 1)]?.focus();
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      if (i === 0) triggerRef.current?.focus();
      else itemRefs.current[i - 1]?.focus();
      e.preventDefault();
    } else if (e.key === "Home") {
      itemRefs.current[0]?.focus();
      e.preventDefault();
    } else if (e.key === "End") {
      itemRefs.current[options.length - 1]?.focus();
      e.preventDefault();
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        id={`${id}-trigger`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          selected !== null
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
      >
        {triggerPrefix !== undefined && (
          <span aria-hidden="true" className="flex items-center">
            {triggerPrefix}
          </span>
        )}
        {displayLabel}
        <svg
          className="w-3 h-3 text-fg-muted"
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
          role="menu"
          id={menuId}
          aria-labelledby={`${id}-trigger`}
          className="absolute top-full mt-1 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[140px]"
        >
          {options.map((opt, i) => (
            <div key={opt.value}>
              {i > 0 && (
                <div role="separator" className="mx-4">
                  <div className="h-px bg-sunken" />
                  <div className="h-px bg-surface-active/50" />
                </div>
              )}
              <button
                ref={(el) => { itemRefs.current[i] = el; }}
                role="menuitem"
                onClick={() => {
                  onChange(selected === opt.value ? null : opt.value);
                  setOpen(false);
                }}
                onKeyDown={(e) => handleItemKeyDown(e, i)}
                className={`w-full text-left px-3 py-1.5 hover:bg-surface-hover text-sm transition ${
                  selected === opt.value ? "text-info" : "text-fg-secondary"
                }`}
              >
                {opt.label}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
