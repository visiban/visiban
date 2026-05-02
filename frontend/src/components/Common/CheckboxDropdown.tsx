import { useEffect, useId, useRef, useState } from "react";
import { useDropdownEscape } from "../../hooks/useDropdownEscape";

export interface CheckboxDropdownProps<T extends string | number> {
  label: string;
  options: { value: T; label: string; color?: string }[];
  selected: T[];
  onChange: (selected: T[]) => void;
}

export default function CheckboxDropdown<T extends string | number>({
  label,
  options,
  selected,
  onChange,
}: CheckboxDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (open) {
      const first = menuRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      setTimeout(() => first?.focus(), 0);
    }
  }, [open]);

  const toggle = (value: T) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  const displayLabel =
    selected.length === 0
      ? label
      : selected.length === options.length
      ? `${label}: All`
      : `${label}: ${selected
          .map((v) => options.find((o) => o.value === v)?.label ?? v)
          .join(", ")}`;

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        className={`bg-surface border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus:outline-none focus:ring-2 focus:ring-primary-emphasis focus:ring-offset-1 focus:ring-offset-sunken ${
          selected.length > 0
            ? "border-info text-info"
            : "border-line-strong text-fg-secondary hover:border-line-emphasis"
        }`}
      >
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
          ref={menuRef}
          role="group"
          id={menuId}
          aria-label={label}
          className="absolute top-full mt-1 left-0 z-50 bg-surface border border-line-strong rounded-lg shadow-lg py-1 min-w-[140px]"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-fg-muted italic">
              No options available
            </p>
          ) : (
            options.map((opt, i) => (
              <div key={opt.value}>
                {i > 0 && (
                  <div role="separator" className="mx-4">
                    <div className="h-px bg-sunken" />
                    <div className="h-px bg-surface-active/50" />
                  </div>
                )}
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-hover cursor-pointer text-sm text-fg-secondary">
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggle(opt.value)}
                    className="rounded accent-blue-600"
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
            ))
          )}
        </div>
      )}
    </div>
  );
}
