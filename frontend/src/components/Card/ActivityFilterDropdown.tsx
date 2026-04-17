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
}

// Specialized dropdown for the card-detail Activity tab filter.
// Differs from the shared CheckboxDropdown in one way: the panel is right-aligned
// (right-0) rather than left-aligned so the menu grows leftward from the trigger
// and stays within the card drawer's overflow-hidden bounds instead of clipping
// off the right edge.
export default function ActivityFilterDropdown({
  label,
  options,
  selected,
  onChange,
}: ActivityFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const toggle = (value: string) => {
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
        className={`bg-slate-800 border rounded px-2 py-1 text-sm outline-none flex items-center gap-1 transition focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-900 ${
          selected.length > 0
            ? "border-blue-400 text-blue-400"
            : "border-slate-600 text-slate-300 hover:border-slate-400"
        }`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="truncate max-w-[10rem]">{displayLabel}</span>
        <svg
          className="w-3 h-3 text-slate-500 shrink-0"
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
          className="absolute top-full mt-1 right-0 z-50 bg-slate-800 border border-slate-600 rounded-lg shadow-lg py-1 min-w-[200px]"
          role="menu"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-sm text-slate-500 italic">
              No options available
            </p>
          ) : (
            options.map((opt, i) => (
              <div key={opt.value}>
                {i > 0 && (
                  <div role="separator" className="mx-4">
                    <div className="h-px bg-slate-900" />
                    <div className="h-px bg-slate-600/50" />
                  </div>
                )}
                <label className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-700 cursor-pointer text-sm text-slate-300 whitespace-nowrap">
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
